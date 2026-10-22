/**
 * #4211 (`INV-PAY-043`): `Payment.settledByTransactionId` has ONE home for its
 * writes, `src/lib/payment-settler.ts`. The duplicate-capture guard never
 * refunds the row it names, so a third writer that set it on a path no PAID
 * claim runs (or forgot to clear it on a re-open) would protect the wrong
 * capture. Every other mention must be a read: a `select: { ...: true }`, a
 * property access, or a type.
 *
 * `pnpm run test:related` cannot select this file (it reads the tree from disk,
 * with no import edge to it); run it by name with `pnpm run test:named`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "src");
const HOME = "src/lib/payment-settler.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** A mention that writes: a property given anything but a select flag or a type, or the raw-SQL column name. */
const WRITE = /settledByTransactionId\s*:(?!\s*(?:true|false|string|boolean)\b)|"settledByTransactionId"/g;

describe("Payment.settledByTransactionId has one writer home (#4211, INV-PAY-043)", () => {
  const files = sourceFiles(SRC);

  it("writes it only in payment-settler.ts", () => {
    const offenders = files.flatMap((file) => {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (rel === HOME) return [];
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(WRITE)].map((match) => {
        const line = text.slice(0, match.index).split("\n").length;
        return `${rel}:${line}`;
      });
    });
    expect(
      offenders,
      "INV-PAY-043: write Payment.settledByTransactionId only through src/lib/payment-settler.ts (recordSettlingTransaction or CLEAR_SETTLING_TRANSACTION).",
    ).toEqual([]);
  });

  it("is non-vacuous: the home itself matches the write pattern", () => {
    const home = readFileSync(path.join(ROOT, HOME), "utf8");
    expect([...home.matchAll(WRITE)].length).toBeGreaterThanOrEqual(2);
    expect(files.length).toBeGreaterThan(500);
  });
});
