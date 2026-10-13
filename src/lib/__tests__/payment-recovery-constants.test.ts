import { describe, expect, it } from "vitest";

import {
  isPaymentRecoveryOperationInFlight,
  MAX_PAYMENT_RECOVERY_ATTEMPTS,
  PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE,
} from "@/lib/payment-recovery-constants";

/*
  #4036 review: the Prisma filter is the in-flight predicate's twin, not a
  second rule. This evaluates the filter the way Postgres would on each row
  shape and holds it to the predicate.
*/

type Row = { status: "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED"; attempts: number; nextRetryAt: Date | null };

function filterMatches(row: Row): boolean {
  return PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE.OR.some((arm) => {
    if (typeof arm.status === "object") return (arm.status.in as readonly string[]).includes(row.status);
    const failed = arm as { status: string; nextRetryAt: { not: null }; attempts: { lt: number } };
    return row.status === failed.status && row.nextRetryAt !== null && row.attempts < failed.attempts.lt;
  });
}

const RETRY = new Date("2026-07-01T00:05:00.000Z");
const ROWS: Row[] = [];
for (const status of ["PENDING", "PROCESSING", "SUCCEEDED", "FAILED"] as const) {
  for (const attempts of [0, MAX_PAYMENT_RECOVERY_ATTEMPTS - 1, MAX_PAYMENT_RECOVERY_ATTEMPTS]) {
    for (const nextRetryAt of [RETRY, null]) ROWS.push({ status, attempts, nextRetryAt });
  }
}

describe("PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE (#4036 review)", () => {
  it.each(ROWS.map((row) => [`${row.status} attempts=${row.attempts} retry=${row.nextRetryAt ? "set" : "none"}`, row] as const))(
    "agrees with isPaymentRecoveryOperationInFlight: %s",
    (_label, row) => {
      expect(filterMatches(row)).toBe(isPaymentRecoveryOperationInFlight(row));
    },
  );

  it("counts a FAILED row with a retry scheduled and attempts left as in flight", () => {
    expect(filterMatches({ status: "FAILED", attempts: 1, nextRetryAt: RETRY })).toBe(true);
  });
});
