// #4002 — stayWindow() never hands a spec a night a seeded booking already holds.
//
// WHY THIS EXISTS. stayWindow() used to reserve only the Monday-aligned fixtures'
// check-ins (IB, waitlist). Every other seeded booking window is offset by DAYS,
// so it slides one weekday per run date while a stayWindow Monday holds for a
// week. On two run dates in every seven, `rosterEdit` — a PAID booking with
// Alice on it — sat on stayWindow(15)'s nights, and
// e2e/guest-promo-code-chips.spec.ts stalled at the guests step on Alice's
// member-night conflict. It passed on 2026-10-08 and failed on 2026-10-09 with
// the same tree.
//
// The fixture dates are fixed when `prisma/e2e-fixtures.ts` is imported, from
// `E2E_FIXTURE_TODAY_NZ`, so each run date below re-imports both modules
// under a stubbed value.
//
// Lives under src/ because vitest.config.mts excludes `e2e/**` from collection.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as fixtures from "../../../prisma/e2e-fixtures";

// The highest stayWindow index any spec reaches (base 28, attempt 2, stride 16 —
// see e2e/locked-out-pickup-and-pay.spec.ts and RETRY_WINDOW_STRIDE).
const HIGHEST_INDEX_IN_USE = 60;
// A full year plus a week crosses weekday, month, DST and the
// winter/summer season edge for the higher indexes.
const RUN_DATES = 371;
const FIRST_RUN_DATE = "2026-07-01";

type Modules = {
  helpers: typeof import("../../../e2e/helpers/stay-dates");
  fixtures: typeof import("../../../prisma/e2e-fixtures");
};

async function importForRunDate(runDate: string): Promise<Modules> {
  vi.resetModules();
  vi.stubEnv("E2E_FIXTURE_TODAY_NZ", runDate);
  const [helpers, runFixtures] = await Promise.all([
    import("../../../e2e/helpers/stay-dates"),
    import("../../../prisma/e2e-fixtures"),
  ]);
  return { helpers, fixtures: runFixtures };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// Fail closed on any new seed Booking writer shape; explicit date properties
// and later override spreads would bypass the canonical reservation contract.
function seedDateWriteProblems(code: string): string[] {
  const source = ts.createSourceFile("seed.ts", code, ts.ScriptTarget.Latest, true);
  const problems: string[] = [];
  let canonicalImport = false;
  let writers = 0;
  const propertyName = (name: ts.PropertyName): string | undefined => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
    if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) {
      return name.expression.text;
    }
    return undefined;
  };
  const visit = (node: ts.Node) => {
    // Require a directly called, dotted prisma.booking delegate. Reject
    // extraction/other receivers instead of guessing where aliases flow.
    if ((ts.isPropertyAccessExpression(node) && node.name.text === "booking") ||
        (ts.isElementAccessExpression(node) &&
         ((ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "booking") ||
          node.expression.getText(source) === "prisma"))) {
      const method = node.parent;
      const call = method.parent;
      if (!ts.isPropertyAccessExpression(node) || node.expression.getText(source) !== "prisma" ||
          !ts.isPropertyAccessExpression(method) || method.expression !== node ||
          !ts.isCallExpression(call) || call.expression !== method) {
        problems.push("INV-SSOT-001: Booking delegates must use direct prisma.booking.method(...) calls");
      }
    }
    const bindingProperty = ts.isBindingElement(node)
      ? node.propertyName ?? (ts.isIdentifier(node.name) ? node.name : undefined) : undefined;
    if (ts.isBindingElement(node) &&
        ((bindingProperty && propertyName(bindingProperty) === "booking") ||
         (ts.isObjectBindingPattern(node.parent) && ts.isVariableDeclaration(node.parent.parent) &&
          node.parent.parent.initializer?.getText(source) === "prisma"))) {
      problems.push("INV-SSOT-001: Booking delegates must not be destructured");
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
        ["./e2e-fixtures", "../../prisma/e2e-fixtures"].includes(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      canonicalImport = !!bindings && ts.isNamedImports(bindings) && bindings.elements.some(
        (entry) => entry.name.text === "seededBookingDates" && !entry.propertyName,
      );
    }
    const namedBinding =
      ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) ||
      ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) ||
      ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isEnumDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) || ts.isNamespaceImport(node) || ts.isImportClause(node);
    const importedBinding = ts.isImportSpecifier(node) && node.name.text === "seededBookingDates";
    const canonicalBinding = importedBinding && !node.propertyName &&
      ts.isImportDeclaration(node.parent.parent.parent) &&
      ["./e2e-fixtures", "../../prisma/e2e-fixtures"].includes(
        (node.parent.parent.parent.moduleSpecifier as ts.StringLiteral).text,
      );
    if ((namedBinding && node.name?.getText(source) === "seededBookingDates") ||
        (importedBinding && !canonicalBinding)) {
      problems.push("INV-SSOT-001: seededBookingDates must come from the canonical import without local shadowing");
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(source) === "prisma.booking" &&
        !["findMany", "findFirst", "findUnique", "findUniqueOrThrow", "delete", "deleteMany", "count"].includes(node.expression.name.text)) {
      writers += 1;
      const argument = node.arguments[0];
      const data = argument && ts.isObjectLiteralExpression(argument)
        ? argument.properties.find((p) => p.name && propertyName(p.name) === "data") : undefined;
      const object = data && ts.isPropertyAssignment(data) ? data.initializer : undefined;
      const last = object && ts.isObjectLiteralExpression(object) ? object.properties.at(-1) : undefined;
      const guarded = last && ts.isSpreadAssignment(last) && ts.isCallExpression(last.expression) &&
        last.expression.expression.getText(source) === "seededBookingDates" && last.expression.arguments.length === 2;
      const explicitDates = object && ts.isObjectLiteralExpression(object) && object.properties.some(
        (property) => ["checkIn", "checkOut"].includes(property.name ? propertyName(property.name) ?? "" : ""),
      );
      // Cleanup/outbox offer metadata updates do not write booking dates. An
      // opaque spread or data variable is not proof and still fails closed.
      if (["update", "updateMany"].includes(node.expression.name.text) &&
          object && ts.isObjectLiteralExpression(object) && !explicitDates &&
          object.properties.every((property) =>
            (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
            propertyName(property.name) !== undefined)) {
        // Still visit nested expressions below: metadata is not a license to
        // hide another Booking writer inside an initializer.
      } else if (node.expression.name.text !== "create" || !guarded || explicitDates) {
        problems.push(`INV-SSOT-001: ${node.getText(source)} must end Booking data with ...seededBookingDates(checkIn, checkOut)`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!canonicalImport || writers === 0) problems.push("canonical seed date import and Booking writers required");
  return problems;
}

// Bind the sweep to executable imports, calls and the pair's consumed dates.
// Comments and quoted descriptions cannot stand in for the live selector.
function hostingDateBindings(code: string): { base: number | undefined; linked: boolean } {
  const source = ts.createSourceFile("hosting.ts", code, ts.ScriptTarget.Latest, true);
  const imported = new Set<string>();
  let base: number | undefined;
  let linked = false;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "./helpers/stay-dates") {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if (!binding.propertyName) imported.add(binding.name.text);
        }
      }
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === "stayWindowForAttempt" &&
        node.arguments[0] && ts.isNumericLiteral(node.arguments[0]) &&
        node.arguments[1]?.getText(source) === "test.info().retry") {
      base = Number(node.arguments[0].text);
    }
    if (ts.isCallExpression(node) && node.expression.getText(source) === "linkedMoveStayWindows" &&
        node.arguments.length === 1 && node.arguments[0]?.getText(source) === "WINDOW" &&
        ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      const pairName = node.parent.name.text;
      let callback: ts.Node = node.parent;
      while (!ts.isArrowFunction(callback) && !ts.isSourceFile(callback)) callback = callback.parent;
      if (ts.isArrowFunction(callback) && ts.isCallExpression(callback.parent) &&
          callback.parent.expression.getText(source) === "test" &&
          callback.parent.arguments[0] && ts.isStringLiteral(callback.parent.arguments[0]) &&
          callback.parent.arguments[0].text.includes("(#3232)") && ts.isBlock(callback.body)) {
        const declarations = callback.body.statements.flatMap((statement) =>
          ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [],
        );
        linked = ["start", "target"].every((name) => declarations.some((declaration) =>
          declaration.name.getText(source) === name &&
          declaration.initializer?.getText(source) === `${pairName}.${name}.checkIn`,
        ));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return {
    base: imported.has("stayWindowForAttempt") ? base : undefined,
    linked: imported.has("linkedMoveStayWindows") && linked,
  };
}

describe("#4002 stay windows are clear of every seeded booking night", () => {
  const hostingSource = fs.readFileSync(path.resolve(process.cwd(), "e2e/adult-member-hosting.spec.ts"), "utf8");
  const hostingBinding = hostingDateBindings(hostingSource);

  it("the hosting spec uses the reserved pair selector for its attempt window", () => {
    expect(hostingBinding.base).toBeDefined();
    expect(hostingBinding.linked).toBe(true);
  });

  it("hosting comments cannot supply the anchor or replace the consumed selector", () => {
    const staleSelector = hostingSource
      .replace("linkedMoveStayWindows, ", "")
      .replace("const pair = linkedMoveStayWindows(WINDOW);", `// Replaced linkedMoveStayWindows(WINDOW) here.
        const pair = { start: { checkIn: shiftDateOnly(WINDOW.checkIn, 3) },
          target: { checkIn: shiftDateOnly(WINDOW.checkIn, 10) } };`);
    expect(hostingDateBindings(staleSelector).linked).toBe(false);
    expect(hostingDateBindings(hostingSource.replace(
      "const pair = linkedMoveStayWindows(WINDOW);", `/* linkedMoveStayWindows(WINDOW) */
        const pair = { start: { checkIn: shiftDateOnly(WINDOW.checkIn, 3) },
          target: { checkIn: shiftDateOnly(WINDOW.checkIn, 10) } };`,
    )).linked).toBe(false);
    expect(hostingDateBindings(hostingSource.replace("linkedMoveStayWindows, ", "")).linked).toBe(false);
    const staleAnchor = hostingSource.replace(
      /const window = stayWindowForAttempt\(\d+, test.info\(\).retry\);/,
      "// const window = stayWindowForAttempt(9, test.info().retry);",
    );
    expect(hostingDateBindings(staleAnchor).base).toBeUndefined();
    expect(hostingDateBindings(hostingSource.replace(
      "const start = pair.start.checkIn;", "const start = shiftDateOnly(WINDOW.checkIn, 3);",
    )).linked).toBe(false);
    expect(hostingDateBindings(hostingSource.replace(
      "const target = pair.target.checkIn;", "const target = shiftDateOnly(WINDOW.checkIn, 10);",
    )).linked).toBe(false);
  });

  it("linked pairs skip the season boundary and fail beyond the seeded horizon", async () => {
    const { helpers, fixtures: run } = await importForRunDate(FIRST_RUN_DATE);
    const winter = run.SEEDED_SEASONS[0]!;
    let monday = winter.end;
    while (new Date(`${monday}T00:00:00Z`).getUTCDay() !== 1) {
      monday = run.shiftDateOnly(monday, -1);
    }
    const pair = helpers.linkedMoveStayWindows({ checkIn: monday });
    helpers.seasonForWindow(pair.start);
    helpers.seasonForWindow(pair.target);
    expect(pair.start.checkIn > winter.end).toBe(true);
    expect(() => helpers.linkedMoveStayWindows({ checkIn: run.shiftDateOnly(monday, 700) })).toThrow("No seeded-season linked-move pair");
    expect(() => helpers.linkedMoveStayWindows({ checkIn: run.shiftDateOnly(monday, 1) })).toThrow("Monday");
  });

  it("seed Booking writes finish with the canonical guarded dates", () => {
    for (const file of ["prisma/demo-seed.ts", "e2e/setup/seed-second-lodge.ts"]) {
      const code = fs.readFileSync(path.resolve(process.cwd(), file), "utf8");
      expect(seedDateWriteProblems(code), `INV-SSOT-001: ${file}`).toEqual([]);
    }
  });

  it("the source guard rejects inline, renamed and overwritten Booking dates", () => {
    const prefix = 'import { seededBookingDates } from "./e2e-fixtures";';
    const valid = `${prefix} prisma.booking.create({ data: {
      memberId: member.id, ...seededBookingDates(a.checkIn, a.checkOut)
    } });`;
    expect(seedDateWriteProblems(valid)).toEqual([]);
    for (const data of [
      "checkIn: relDateOnly(55), checkOut: relDateOnly(57)",
      "checkIn: renamedStay.checkIn, checkOut: renamedStay.checkOut",
      "...seededBookingDates(a.checkIn, a.checkOut), ...overrides",
      "...seededBookingDates(a.checkIn, a.checkOut), checkIn: relDateOnly(1)",
      "...someOtherHelper(a.checkIn, a.checkOut)",
    ]) {
      expect(seedDateWriteProblems(`${prefix} prisma.booking.create({ data: { ${data} } });`)).not.toEqual([]);
    }
    expect(seedDateWriteProblems(`${prefix} prisma.booking.update({ data: { checkIn: relDateOnly(1) } });`)).not.toEqual([]);
    expect(seedDateWriteProblems(valid.replace('./e2e-fixtures', './other-fixtures'))).not.toEqual([]);
  });

  it("seed writers cannot escape through delegate aliases, brackets or destructuring", () => {
    const valid = 'import { seededBookingDates } from "./e2e-fixtures"; ' +
      'prisma.booking.create({ data: { ...seededBookingDates(a.checkIn, a.checkOut) } });';
    for (const snippet of [
      "const bookings = prisma.booking; bookings.create({ data: { checkIn: relDateOnly(601) } });",
      'prisma["booking"].create({ data: { checkIn: relDateOnly(601) } });',
      'prisma.booking["create"]({ data: { checkIn: relDateOnly(601) } });',
      "const { booking: bookings } = prisma; bookings.create({ data: { checkIn: relDateOnly(601) } });",
      "const { create } = prisma.booking; create({ data: { checkIn: relDateOnly(601) } });",
      "tx.booking.create({ data: { checkIn: relDateOnly(601) } });",
      "prisma[model].create({ data: { checkIn: relDateOnly(601) } });",
    ]) {
      expect(seedDateWriteProblems(valid + snippet), snippet).not.toEqual([]);
    }
    expect(seedDateWriteProblems(valid + `
      prisma.booking.update({ data: { parentBookingId: (() => {
        const bookings = prisma.booking; return bookings.create({ data: {} });
      })() } });
    `)).not.toEqual([]);
  });

  it("metadata updates require known non-date keys and canonical helper bindings cannot be shadowed", () => {
    const valid = 'import { seededBookingDates } from "./e2e-fixtures"; ' +
      'prisma.booking.create({ data: { ...seededBookingDates(a.checkIn, a.checkOut) } });';
    expect(seedDateWriteProblems(valid + 'prisma.booking.update({ data: { ["parentBookingId"]: null } });')).toEqual([]);
    for (const key of ['["checkIn"]', "['checkOut']", "[dateKey]", "[`checkIn`]"]) {
      expect(seedDateWriteProblems(valid + `prisma.booking.update({ data: { ${key}: relDateOnly(601) } });`), key).not.toEqual([]);
    }
    for (const binding of [
      "seededBookingDates: (a: string, b: string) => unknown",
      "{ seededBookingDates }",
      "{ helper: seededBookingDates }",
      "...seededBookingDates: unknown[]",
    ]) {
      expect(seedDateWriteProblems(valid + `function seed(${binding}) {
        return prisma.booking.create({ data: { ...seededBookingDates(relDateOnly(601), relDateOnly(603)) } });
      }`), binding).not.toEqual([]);
    }
    expect(seedDateWriteProblems(valid + "try {} catch (seededBookingDates) {}" )).not.toEqual([]);
    expect(seedDateWriteProblems(valid + "const { helper: seededBookingDates } = otherHelpers;")).not.toEqual([]);
  });

  it("actual seed dates must match a complete canonical pair regardless of naming", () => {
    for (const window of fixtures.SEEDED_BOOKING_WINDOWS) {
      const dates = fixtures.seededBookingDates(window.checkIn, window.checkOut);
      expect(dates.checkIn.toISOString().slice(0, 10)).toBe(window.checkIn);
      expect(dates.checkOut.toISOString().slice(0, 10)).toBe(window.checkOut);
      expect(() => fixtures.seededBookingDates(window.checkIn, fixtures.shiftDateOnly(window.checkOut, 900))).toThrow("INV-SSOT-001");
    }
    expect(() => fixtures.seededBookingDates(fixtures.relDateOnly(601), fixtures.relDateOnly(603))).toThrow("SEEDED_BOOKING_WINDOWS");
    for (const window of Object.values(fixtures.DEMO_SECOND_LODGE_BOOKING_WINDOWS)) {
      expect(fixtures.SEEDED_BOOKING_WINDOWS).toContain(window);
    }
  });

  it(
    `every index up to ${HIGHEST_INDEX_IN_USE} is in season, distinct and ` +
      `clear of seeded nights on ${RUN_DATES} consecutive run dates`,
    async () => {
      const problems: string[] = [];
      for (let day = 0; day < RUN_DATES; day += 1) {
        const runDate = fixtures.shiftDateOnly(FIRST_RUN_DATE, day);
        const { helpers, fixtures: run } = await importForRunDate(runDate);
        expect(run.E2E_TODAY_NZ).toBe(runDate);

        const seededNights = new Set(
          run.SEEDED_BOOKING_WINDOWS.flatMap((window) => window.nights),
        );
        const linkedNights = new Set<string>();
        for (const retry of [0, 1, 2]) {
          const pair = helpers.linkedMoveStayWindows(helpers.stayWindowForAttempt(hostingBinding.base!, retry));
          for (const stay of [pair.start, pair.target]) {
            helpers.seasonForWindow(stay);
            expect(new Date(`${stay.checkIn}T00:00:00Z`).getUTCDay()).toBe(4);
            expect(stay.checkOut).toBe(run.shiftDateOnly(stay.checkIn, 2));
            for (const night of stay.nights) {
              if (seededNights.has(night) || linkedNights.has(night)) {
                problems.push(`${runDate} linked move retry ${retry} collides on ${night}`);
              }
              linkedNights.add(night);
            }
          }
          expect(pair.target.checkIn).toBe(run.shiftDateOnly(pair.start.checkIn, 7));
        }
        const checkIns = new Set<string>();
        for (let index = 0; index <= HIGHEST_INDEX_IN_USE; index += 1) {
          const window = helpers.stayWindow(index);
          helpers.seasonForWindow(window); // throws if out of season
          if (checkIns.has(window.checkIn)) {
            problems.push(`${runDate} stayWindow(${index}) repeats ${window.checkIn}`);
          }
          checkIns.add(window.checkIn);
          const held = window.nights.filter((night) => seededNights.has(night) || linkedNights.has(night));
          if (held.length > 0) {
            problems.push(
              `${runDate} stayWindow(${index}) holds seeded night(s) ${held.join(", ")}`,
            );
          }
        }
      }
      expect(problems).toEqual([]);
    },
    120_000,
  );

  it("the failing run date: stayWindow(15) no longer lands on rosterEdit", async () => {
    const { helpers, fixtures: run } = await importForRunDate("2026-10-09");
    expect(run.DEMO_BOOKING_WINDOWS.rosterEdit.nights).toEqual(["2027-03-08"]);
    const window = helpers.stayWindow(15);
    expect(window.nights).not.toContain("2027-03-08");
    expect(window.nights).not.toContain("2027-03-09"); // rosterTurnover
  });
});
