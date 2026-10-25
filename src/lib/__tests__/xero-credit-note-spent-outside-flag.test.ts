import { describe, expect, it, vi } from "vitest";

// #4220 (lane a): the early warning is derived from stored evidence alone. The
// Xero client is mocked ONLY to prove nothing here ever reaches for it.
const xeroClient = vi.hoisted(() => ({ getAuthenticatedXeroClient: vi.fn(), callXeroApi: vi.fn() }));
vi.mock("@/lib/xero-api-client", () => xeroClient);
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/audit", () => ({ createAuditLog: vi.fn() }));

import { mirrorCreditNoteOutsideSpend, type CreditNoteMirrorEvidence } from "@/lib/xero-credit-note-mirror";
import {
  CREDIT_NOTE_SPEND_EVIDENCE_KEY,
  creditNoteSpendEvidenceMetadata,
  readStoredSpendEvidence,
  storedSpendEvidenceFrom,
} from "@/lib/xero-credit-note-spend-evidence";
import {
  findCreditNotesSpentOutsideApp,
  spendReadingIsJudgeable,
  type SpentOutsideAppDb,
} from "@/lib/xero-credit-note-spent-outside-flag";
import { sanitizeForJson } from "@/lib/xero-sync";

const NOW = new Date("2026-07-01T00:00:00.000Z");
const SETTLED = new Date("2026-06-30T23:00:00.000Z");

function evidence(overrides: Partial<CreditNoteMirrorEvidence> = {}): CreditNoteMirrorEvidence {
  return {
    creditNoteId: "note-1",
    status: "AUTHORISED",
    totalCents: 10_000,
    remainingCents: 0,
    allocations: [{ invoiceId: "inv-hand", cents: 10_000 }],
    payments: [],
    updatedAt: SETTLED,
    ...overrides,
  };
}

interface FakeWorld {
  evidence?: CreditNoteMirrorEvidence | "malformed" | null;
  lots?: Array<{ id: string; memberId: string; amountCents: number; xeroCreditNoteId: string }>;
  slices?: Array<{ memberCreditId: string; appliedToBookingId: string; amountCents: number }>;
  writtenDownCents?: number;
  balanceCents?: number;
  /** Invoices the app knows are a booking's own (so allocations to them are not outside spend). */
  knownInvoices?: string[];
}

function fakeDb(world: FakeWorld): SpentOutsideAppDb {
  const lots = world.lots ?? [{ id: "lot-1", memberId: "m1", amountCents: 10_000, xeroCreditNoteId: "note-1" }];
  const slices = world.slices ?? [{ memberCreditId: "lot-1", appliedToBookingId: "bk-1", amountCents: 10_000 }];
  const metadata =
    world.evidence === undefined
      ? { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: storedSpendEvidenceFrom(evidence(), NOW) }
      : world.evidence === null
        ? {}
        : world.evidence === "malformed"
          ? { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { totalCents: "ten" } }
          : { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: storedSpendEvidenceFrom(world.evidence, NOW) };
  return {
    memberCreditNoteAllocation: {
      findMany: async () => slices,
      groupBy: async () => {
        const byLot = new Map<string, number>();
        for (const s of slices) byLot.set(s.memberCreditId, (byLot.get(s.memberCreditId) ?? 0) + s.amountCents);
        return [...byLot].map(([memberCreditId, amountCents]) => ({ memberCreditId, _sum: { amountCents } }));
      },
    },
    memberCredit: {
      findMany: async () => lots,
      groupBy: async (args: { by: string[] }) =>
        args.by.includes("xeroCreditNoteId") && args.by.length === 1 && "_count" in (args as object)
          ? [...new Set(lots.map((l) => l.xeroCreditNoteId))].map((id) => ({
              xeroCreditNoteId: id,
              _count: { _all: lots.filter((l) => l.xeroCreditNoteId === id).length },
            }))
          : [{ xeroCreditNoteId: "note-1", _sum: { amountCents: -(world.writtenDownCents ?? 0) } }],
      aggregate: async () => ({ _sum: { amountCents: world.balanceCents ?? 0 } }),
    },
    xeroObjectLink: {
      findMany: async (args: { where: { xeroObjectType: string } }) =>
        args.where.xeroObjectType === "CREDIT_NOTE"
          ? [{ xeroObjectId: "note-1", metadata }]
          : (world.knownInvoices ?? []).map((id) => ({ xeroObjectId: id })),
    },
    payment: { findMany: async () => [] },
  } as unknown as SpentOutsideAppDb;
}

async function run(world: FakeWorld, bookingIds?: string[]) {
  return findCreditNotesSpentOutsideApp(fakeDb(world), { now: NOW, bookingIds });
}

describe("findCreditNotesSpentOutsideApp (#4220)", () => {
  it("flags a note Xero shows spent by hand while a booking still draws on it", async () => {
    const found = await run({});
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      creditNoteId: "note-1",
      lotId: "lot-1",
      outsideSpendCents: 10_000,
      writtenDownCents: 0,
      leftForAllocationCents: 10_000,
      bookingIds: ["bk-1"],
    });
    expect(xeroClient.getAuthenticatedXeroClient).not.toHaveBeenCalled();
    expect(xeroClient.callXeroApi).not.toHaveBeenCalled();
  });

  it("flags only the part of the lot that is drawn onto a booking when the free part is written down", async () => {
    const found = await run({
      slices: [{ memberCreditId: "lot-1", appliedToBookingId: "bk-1", amountCents: 4_000 }],
      writtenDownCents: 6_000,
      balanceCents: 0,
    });
    expect(found.map((f) => f.leftForAllocationCents)).toEqual([4_000]);
  });

  it("flags nothing once the ledger has absorbed the spend", async () => {
    expect(await run({ slices: [{ memberCreditId: "lot-1", appliedToBookingId: "bk-1", amountCents: 4_000 }], writtenDownCents: 10_000, balanceCents: 10_000 })).toEqual([]);
  });

  it("flags nothing for a healthy note, or one whose list is the app's own booking invoice", async () => {
    expect(await run({ evidence: evidence({ remainingCents: 10_000, allocations: [] }) })).toEqual([]);
    expect(await run({ knownInvoices: ["inv-hand"] })).toEqual([]);
  });

  it.each([
    ["has no stored reading", { evidence: null as null }],
    ["has a reading that is malformed", { evidence: "malformed" as const }],
    ["is voided in Xero", { evidence: evidence({ status: "VOIDED" }) }],
    ["is deleted in Xero", { evidence: evidence({ status: "DELETED" }) }],
    ["has a list that does not add up", { evidence: evidence({ remainingCents: 2_000 }) }],
    ["has no total to compare", { evidence: evidence({ totalCents: null }) }],
    ["was changed under two minutes ago", { evidence: evidence({ updatedAt: new Date(NOW.getTime() - 60_000) }) }],
    ["has no change time", { evidence: evidence({ updatedAt: null }) }],
    ["funds more than one lot", { lots: [
      { id: "lot-1", memberId: "m1", amountCents: 5_000, xeroCreditNoteId: "note-1" },
      { id: "lot-2", memberId: "m2", amountCents: 5_000, xeroCreditNoteId: "note-1" },
    ] }],
  ])("flags nothing when the note %s", async (_name, world) => {
    expect(await run(world as FakeWorld)).toEqual([]);
  });

  it("returns nothing when no booking draws on a lot", async () => {
    expect(await run({ slices: [] })).toEqual([]);
  });
});

describe("the early warning and the inbound mirror judge a reading alike (#4220, #4270)", () => {
  // The mirror refuses before it opens a transaction for exactly these three
  // reasons; `spendReadingIsJudgeable` must say "not judgeable" for the same
  // evidence, and "judgeable" where the mirror goes on to its transaction.
  const cases: Array<[string, CreditNoteMirrorEvidence, boolean, string | null]> = [
    ["healthy and settled", evidence(), true, null],
    ["voided", evidence({ status: "VOIDED" }), false, "note-not-active"],
    ["paid", evidence({ status: "PAID", remainingCents: 0 }), true, null],
    ["unexplained", evidence({ remainingCents: 2_000 }), false, "unexplained-spend"],
    ["unsettled", evidence({ updatedAt: new Date(NOW.getTime() - 30_000) }), false, "unsettled"],
    ["no change time", evidence({ updatedAt: null }), false, "unsettled"],
  ];

  it.each(cases)("%s", async (_name, ev, judgeable, mirrorReason) => {
    const stored = readStoredSpendEvidence({ [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: storedSpendEvidenceFrom(ev, NOW) });
    expect(stored).not.toBeNull();
    expect(spendReadingIsJudgeable(stored!, NOW)).toBe(judgeable);

    const transaction = vi.fn().mockRejectedValue(new Error("reached the transaction"));
    const db = {
      memberCredit: { findMany: async () => [{ id: "lot-1", memberId: "m1" }] },
      xeroSyncCursor: { upsert: async () => ({}), deleteMany: async () => ({}), findUnique: async () => null },
      $transaction: transaction,
    } as never;
    if (mirrorReason) {
      expect(await mirrorCreditNoteOutsideSpend(ev, { db, now: NOW })).toMatchObject({ acted: false, reason: mirrorReason });
      expect(transaction).not.toHaveBeenCalled();
    } else {
      await expect(mirrorCreditNoteOutsideSpend(ev, { db, now: NOW })).rejects.toThrow("reached the transaction");
    }
  });
});

describe("the stored reading (#4220)", () => {
  it("survives the persisting redactor and reads back whole", () => {
    const stored = storedSpendEvidenceFrom(evidence({ payments: [{ paymentId: "pay-9", cents: 250 }] }), NOW);
    const roundTripped = JSON.parse(JSON.stringify(sanitizeForJson({ amountCents: 5, watermarkCents: 7, [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: stored })));
    expect(roundTripped).toMatchObject({ amountCents: 5, watermarkCents: 7 });
    const read = readStoredSpendEvidence(roundTripped);
    expect(read).toMatchObject({
      status: "AUTHORISED",
      totalCents: 10_000,
      remainingCents: 0,
      allocations: [{ invoiceId: "inv-hand", cents: 10_000 }],
      payments: [{ paymentId: "pay-9", cents: 250 }],
    });
    expect(read?.updatedAt).toEqual(SETTLED);
    expect(read?.observedAt).toEqual(NOW);
  });

  it.each([
    ["absent", {}],
    ["not an object", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: "x" }],
    ["fractional cents", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...storedSpendEvidenceFrom(evidence(), NOW), totalCents: 10.5 } }],
    ["negative cents", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...storedSpendEvidenceFrom(evidence(), NOW), remainingCents: -1 } }],
    ["a bad allocation", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...storedSpendEvidenceFrom(evidence(), NOW), allocations: [{ invoiceId: "", cents: 1 }] } }],
    ["a bad time", { [CREDIT_NOTE_SPEND_EVIDENCE_KEY]: { ...storedSpendEvidenceFrom(evidence(), NOW), observedAt: "nope" } }],
  ])("reads %s as no reading", (_name, metadata) => {
    expect(readStoredSpendEvidence(metadata)).toBeNull();
  });

  it("is kept at ingest only for a note that funds a credit lot", async () => {
    const note = { creditNoteID: "note-1", status: "AUTHORISED", total: 100, remainingCredit: 0, updatedDateUTC: SETTLED };
    const funded = { memberCredit: { findFirst: vi.fn().mockResolvedValue({ id: "lot-1" }) } };
    const unfunded = { memberCredit: { findFirst: vi.fn().mockResolvedValue(null) } };
    const kept = await creditNoteSpendEvidenceMetadata(note, funded as never, NOW);
    expect(Object.keys(kept)).toEqual([CREDIT_NOTE_SPEND_EVIDENCE_KEY]);
    expect(kept[CREDIT_NOTE_SPEND_EVIDENCE_KEY]).toMatchObject({ totalCents: 10_000, remainingCents: 0 });
    expect(await creditNoteSpendEvidenceMetadata(note, unfunded as never, NOW)).toEqual({});
    expect(await creditNoteSpendEvidenceMetadata({ ...note, creditNoteID: undefined }, funded as never)).toEqual({});
    expect(xeroClient.getAuthenticatedXeroClient).not.toHaveBeenCalled();
  });
});
