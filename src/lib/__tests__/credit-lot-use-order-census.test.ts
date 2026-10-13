/**
 * EVERY `MemberCredit` READ ORDERED BY `createdAt`, CLASSIFIED (#4013,
 * `INV-PAY-127`).
 *
 * `INV-PAY-127` says a member's credit lots are used in ONE order, oldest first
 * with the lower `id` first between two lots stamped with the same instant, and
 * that the order has one home: `CREDIT_LOT_USE_ORDER` in
 * `xero-applied-credit-plan.ts`. `createdAt` alone is not an order — two lots
 * written in one transaction, or under the frozen test clock, tie, and
 * PostgreSQL returns tied rows in whatever order its plan meets them. That is
 * how #4013's H1 case used a noteless lot first on one run and a noted one on
 * the next.
 *
 * So this reads every non-test source file and finds each Prisma read of
 * `memberCredit` that names an `orderBy`. A read whose order is
 * `CREDIT_LOT_USE_ORDER` must be a declared lot-use reader; any other order that
 * mentions `createdAt` must be declared as NOT a use order, with the reason. A
 * new read that orders lots by `createdAt` alone therefore fails here with its
 * file and function in the message, and so does a lot-use reader that stops
 * using the constant.
 *
 * `pnpm run test:related` CANNOT SELECT THIS FILE: it has no import edge to the
 * tree it scans. Run it by name with `pnpm run test:named`.
 *
 * ## What it cannot see
 *
 * A read through an aliased delegate (`const credits = tx.memberCredit;
 * credits.findMany(...)`), a query object built elsewhere and passed whole
 * (`findMany(query)`), and an `orderBy` imported from another module under a
 * name other than `CREDIT_LOT_USE_ORDER`. None exists today; the walk refuses a
 * `findMany(query)` or an unresolvable `orderBy` identifier rather than passing
 * it. Raw SQL is scanned separately, by text, below.
 *
 * **Re-measure by running this test. Add an entry only with its reason.**
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  relativeSource,
  sourceFiles,
} from "@/lib/__tests__/support/booking-guest-night-writer-scan";

const USE_ORDER = "CREDIT_LOT_USE_ORDER";
const ORDER_HOME = "src/lib/xero-applied-credit-plan.ts";
const READ_METHODS = new Set(["findMany", "findFirst", "findFirstOrThrow"]);

/** Reads that hand lots to the allocation planner, by `file > function`. */
const LOT_USE_READERS: Record<string, string> = {
  "src/lib/xero-applied-credit-allocation.ts > gatherAppliedCreditLots":
    "the allocation engine's lot loader: the planner takes lots in the order " +
    "given, so this order decides which note is allocated and what is minted.",
};

/** Reads that order credit rows by `createdAt` for something other than using them. */
const NOT_A_USE_ORDER: Record<string, string> = {
  "src/lib/member-credit.ts > getMemberCreditHistory":
    "the member's credit history, newest first, for display; nothing is " +
    "allocated or minted from it.",
  "src/lib/member-credit.ts > getAdminMemberCreditHistory":
    "the admin view of the same history, newest first, for display only.",
  "src/lib/edit-financial-review-account-credit.ts > creditSliceStillOwedAfterCancellation":
    "reads at most two cancellation-restore rows and refuses when there are " +
    "two, so which row comes first cannot change the answer.",
};

type Site = { key: string; order: "use" | "createdAt" | "other" | "unreadable" };

function enclosingFunctionName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      return current.name.getText();
    }
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent)) {
      return current.parent.name.getText();
    }
  }
  return "<module>";
}

/** The text an `orderBy` initializer stands for, following a same-file `const`. */
function orderText(initializer: ts.Expression, source: ts.SourceFile): string | null {
  if (!ts.isIdentifier(initializer)) return initializer.getText(source);
  if (initializer.text === USE_ORDER) return USE_ORDER;
  let resolved: string | null = null;
  const find = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === initializer.text && node.initializer) {
      resolved = node.initializer.getText(source);
    }
    ts.forEachChild(node, find);
  };
  find(source);
  return resolved;
}

function classify(call: ts.CallExpression, source: ts.SourceFile): Site["order"] | null {
  const [arg] = call.arguments;
  if (!arg) return null;
  if (!ts.isObjectLiteralExpression(arg)) return "unreadable";
  const orderBy = arg.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) && property.name.getText(source) === "orderBy",
  );
  if (!orderBy) return null;
  const text = orderText(orderBy.initializer, source);
  if (text === null) return "unreadable";
  if (text === USE_ORDER || /^\[\s*\.\.\.CREDIT_LOT_USE_ORDER\s*\]$/.test(text)) return "use";
  return /\bcreatedAt\b/.test(text) ? "createdAt" : "other";
}

function memberCreditReadsWithAnOrder(): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles()) {
    const code = readFileSync(file, "utf8");
    if (!code.includes("memberCredit")) continue;
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
    const walk = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        READ_METHODS.has(node.expression.name.text) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === "memberCredit"
      ) {
        const order = classify(node, source);
        if (order) sites.push({ key: `${relativeSource(file)} > ${enclosingFunctionName(node)}`, order });
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return sites.sort((a, b) => a.key.localeCompare(b.key));
}

describe("every credit-lot read ordered by createdAt is classified (#4013, INV-PAY-127)", () => {
  const sites = memberCreditReadsWithAnOrder();

  it("reaches the engine, so an empty or truncated walk fails rather than passes", () => {
    expect(sites.map((site) => site.key)).toEqual(expect.arrayContaining(Object.keys(LOT_USE_READERS)));
  });

  it("finds exactly the declared lot-use readers using CREDIT_LOT_USE_ORDER", () => {
    expect(
      sites.filter((site) => site.order === "use").map((site) => site.key),
      "INV-PAY-127: a read ordered by CREDIT_LOT_USE_ORDER hands lots to the planner. " +
        "Declare it in LOT_USE_READERS - and a declared reader that lost the constant fails here too.",
    ).toEqual(Object.keys(LOT_USE_READERS).sort());
  });

  it("finds no other createdAt order on memberCredit than the declared non-use reads", () => {
    expect(
      sites.filter((site) => site.order === "createdAt").map((site) => site.key),
      "INV-PAY-127: a memberCredit read orders by createdAt without CREDIT_LOT_USE_ORDER. " +
        "If it chooses which lots are used, order it by CREDIT_LOT_USE_ORDER (ties fall to the lower id); " +
        "if it does not, declare it in NOT_A_USE_ORDER with the reason.",
    ).toEqual(Object.keys(NOT_A_USE_ORDER).sort());
  });

  it("refuses a read it cannot classify rather than passing it", () => {
    expect(
      sites.filter((site) => site.order === "unreadable").map((site) => site.key),
      "INV-PAY-127: this memberCredit read passes its query, or its orderBy, from somewhere the census cannot read.",
    ).toEqual([]);
  });

  it("keeps a reason against every entry", () => {
    for (const [key, reason] of Object.entries({ ...LOT_USE_READERS, ...NOT_A_USE_ORDER })) {
      expect(reason.length, `${key} needs a stated reason`).toBeGreaterThan(40);
    }
  });

  it("keeps the order in one home, with the id tie-break", () => {
    const home = readFileSync(sourceFiles().find((file) => relativeSource(file) === ORDER_HOME)!, "utf8");
    expect(home).toMatch(/export const CREDIT_LOT_USE_ORDER = \[\s*\{ createdAt: "asc" \},\s*\{ id: "asc" \},\s*\]/);
  });

  it("finds no raw SQL that orders MemberCredit rows by createdAt", () => {
    const rawSqlOrder = /"MemberCredit"[^`]{0,800}ORDER\s+BY[^`;]*"createdAt"/i;
    const offenders = sourceFiles()
      .filter((file) => rawSqlOrder.test(readFileSync(file, "utf8")))
      .map(relativeSource);
    expect(offenders, "INV-PAY-127: raw SQL orders MemberCredit by createdAt; tie it by \"id\" and declare it here.").toEqual([]);
  });
});
