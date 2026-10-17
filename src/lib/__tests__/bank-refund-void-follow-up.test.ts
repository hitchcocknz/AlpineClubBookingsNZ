/**
 * #4162 (`INV-ADDPAY-042`, `INV-LOCK-001`, `INV-LOCK-002`): the nightly
 * follow-up's order of work, on a recording fake client. The real-PostgreSQL
 * suite (`bank-refund-void-follow-up.realdb.test.ts`) proves the outcomes;
 * this pins the order a race test cannot reliably force: `lock(1)` first, then
 * the Payment row, both before the note is classified; the claim before any
 * money moves; and report-only opening no transaction at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const classify = vi.fn();
const unwind = vi.fn(async () => {
  calls.push("unwind");
});
const reconcile = vi.fn(async () => {
  calls.push("reconcile");
});
const writeLines = vi.fn(async () => {
  calls.push("reverse-line");
  return 1;
});
const audit = vi.fn(async () => {
  calls.push("audit");
});

vi.mock("@/lib/logger", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ createAuditLog: audit }));
vi.mock("@/lib/bank-refund-void-scan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bank-refund-void-scan")>()),
  classifyVoidedBankRefundNote: (...args: unknown[]) => {
    calls.push("classify");
    return classify(...args);
  },
  readVoidedBankRefundNoteLinkIds: vi.fn(async () => ["link-1"]),
}));
vi.mock("@/lib/booking-ledger-write", () => ({ buildBookingLedgerRows: (rows: unknown[]) => rows, writeBookingLedgerRows: writeLines }));
vi.mock("@/lib/payment-transactions", () => ({
  lockPaymentForRefundedTotal: async (_tx: unknown, paymentId: string) => {
    calls.push(`lock-payment:${paymentId}`);
  },
  unwindLocalRefundAllocation: unwind,
  reconcilePaymentAggregates: reconcile,
}));

const tx = {
  $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
    calls.push(strings.join("?").replace(/\s+/g, " ").trim());
    return 1;
  }),
  xeroObjectLink: {
    findUnique: vi.fn(async () => ({ localModel: "Payment", localId: "pay-1", metadata: { status: "VOIDED" } })),
    update: vi.fn(async () => {
      calls.push("marker");
    }),
  },
  manualRefundTask: {
    createMany: vi.fn(async () => {
      calls.push("claim");
      return { count: 1 };
    }),
    findUniqueOrThrow: vi.fn(async () => ({ id: "follow-up-1" })),
  },
  booking: { findUniqueOrThrow: vi.fn(async () => ({ memberId: "member-1" })) },
};
const transaction = vi.fn(async (run: (client: typeof tx) => unknown) => run(tx));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: (run: (client: typeof tx) => unknown) => transaction(run) } }));

const { followUpVoidedBankRefundNote, markUnmatchedBankRefundVoidAnswered, runBankRefundVoidFollowUp } = await import(
  "@/lib/bank-refund-void-follow-up"
);

const link = { id: "link-1", xeroObjectId: "cn-1", xeroObjectNumber: "CN-1", updatedAt: new Date("2026-06-30T00:00:00.000Z") };
const line = {
  id: "line-1", postingKey: "handback:task-1", reversesLineId: null, kind: "BANK_REFUND", sign: -1, quantity: 1, unitCents: 20_000,
  anchorKind: "REVIEW_TASK", anchorId: "task-1", settlementMethod: "INTERNET_BANKING", narration: "Refund handed back by an officer",
};

function classified(classification: unknown) {
  return { link, paymentId: "pay-1", bookingId: "booking-1", lodgeId: "lodge-1", figures: null, classification };
}

describe("followUpVoidedBankRefundNote (#4162)", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.clearAllMocks();
    delete process.env.XERO_ENABLE_BANK_REFUND_VOID_WRITES;
  });

  it("MUTATION (lock(1), the Payment row): takes lock(1) first, then the Payment row, before classifying; claims before any money moves", async () => {
    classify.mockResolvedValue(classified({ kind: "undo", amountCents: 20_000, taskId: "task-1", line }));

    expect(await followUpVoidedBankRefundNote("link-1")).toMatchObject({ outcome: "undone", followUpTaskId: "follow-up-1" });

    expect(calls).toEqual([
      "SELECT pg_advisory_xact_lock(1)",
      "lock-payment:pay-1",
      "classify",
      "claim",
      "unwind",
      "reverse-line",
      "reconcile",
      "audit",
    ]);
  });

  it("MUTATION (the unique claim): a lost claim moves no money", async () => {
    classify.mockResolvedValue(classified({ kind: "undo", amountCents: 20_000, taskId: "task-1", line }));
    tx.manualRefundTask.createMany.mockResolvedValueOnce({ count: 0 });

    expect(await followUpVoidedBankRefundNote("link-1")).toMatchObject({ outcome: "handled" });
    expect(unwind).not.toHaveBeenCalled();
    expect(writeLines).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("a spare note writes only its marker, its link row taken NOWAIT after the Payment row", async () => {
    classify.mockResolvedValue(classified({ kind: "spare", amountCents: 20_000, coverageCents: 20_000, requiredCents: 20_000 }));

    expect(await followUpVoidedBankRefundNote("link-1")).toMatchObject({ outcome: "spare" });
    expect(calls).toEqual([
      "SELECT pg_advisory_xact_lock(1)",
      "lock-payment:pay-1",
      "classify",
      'SELECT 1 FROM "XeroObjectLink" WHERE "id" = ? FOR UPDATE NOWAIT',
      "marker",
    ]);
    expect(unwind).not.toHaveBeenCalled();
  });

  it.each(["unmatched", "deferred", "awaiting-heal", "handled"])("a %s note moves nothing", async (kind) => {
    classify.mockResolvedValue(classified({ kind, reason: "no-line", amountCents: 1, blockingOperationId: "op", by: "follow-up", followUpTaskId: "t" }));
    await followUpVoidedBankRefundNote("link-1");
    expect(tx.manualRefundTask.createMany).not.toHaveBeenCalled();
    expect(unwind).not.toHaveBeenCalled();
    expect(tx.xeroObjectLink.update).not.toHaveBeenCalled();
  });

  it("MUTATION (report-only): the default run opens no transaction and writes nothing", async () => {
    classify.mockResolvedValue(classified({ kind: "undo", amountCents: 20_000, taskId: "task-1", line }));

    const result = await runBankRefundVoidFollowUp();

    expect(result).toMatchObject({ mode: "report-only", scanned: 1, counts: { undone: 1 } });
    expect(transaction).not.toHaveBeenCalled();
    expect(calls).toEqual(["classify"]);
  });

  it("writes only when XERO_ENABLE_BANK_REFUND_VOID_WRITES is exactly true", async () => {
    classify.mockResolvedValue(classified({ kind: "undo", amountCents: 20_000, taskId: "task-1", line }));
    process.env.XERO_ENABLE_BANK_REFUND_VOID_WRITES = "yes";
    expect((await runBankRefundVoidFollowUp()).mode).toBe("report-only");
    process.env.XERO_ENABLE_BANK_REFUND_VOID_WRITES = "true";
    expect((await runBankRefundVoidFollowUp()).mode).toBe("writes");
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("a person's answer takes lock(1), then the Payment row, then re-classifies, and refuses a note that no longer needs one", async () => {
    classify.mockResolvedValue(classified({ kind: "unmatched", reason: "no-line", amountCents: 20_000 }));
    await markUnmatchedBankRefundVoidAnswered({ linkId: "link-1", note: "Raised CN-9 by hand", actingMemberId: "officer-1" });
    expect(calls.slice(0, 3)).toEqual(["SELECT pg_advisory_xact_lock(1)", "lock-payment:pay-1", "classify"]);
    expect(tx.xeroObjectLink.update).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: { metadata: expect.objectContaining({ bankRefundVoid: expect.objectContaining({ outcome: "answered", memberId: "officer-1", note: "Raised CN-9 by hand" }) }) },
    });

    classify.mockResolvedValue(classified({ kind: "handled", by: "answered", followUpTaskId: null }));
    await expect(markUnmatchedBankRefundVoidAnswered({ linkId: "link-1", note: "again", actingMemberId: "officer-1" })).rejects.toMatchObject({ status: 409 });
  });
});
