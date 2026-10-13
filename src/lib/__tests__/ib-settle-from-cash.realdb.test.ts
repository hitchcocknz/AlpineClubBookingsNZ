/**
 * Real-PostgreSQL proof that a bank transfer settles at the cash its invoice
 * collected (#3979, `INV-PAY-124`), end to end through the REAL inbound settle
 * (`syncInternetBankingPaymentsForPaidInvoice`), the booking ledger's receipt
 * sync, the REAL cancel and the REAL inbound credit-note sync.
 *
 * The booking is written the way `booking-create.ts` writes an Internet
 * Banking booking: a PENDING payment and its PENDING PRIMARY row at the price
 * of the day. An edit before the invoice exists changes the booking's price
 * (and a recorded fee changes `Payment.changeFeeCents`) and nothing else, as
 * every edit door does; the invoice is then linked as the invoice job links it,
 * and Xero reports it paid. Those three writes are seeded here, in the shapes
 * their writers leave, because each has its own suite; what this file proves is
 * what the settle, the ledger, the cancel and the credit-note sync then do.
 *
 * The cases: the issue's worked example in both directions (a price cut and a
 * price rise before the invoice), the finished-stay fee, the late capacity
 * cancel's credit, the control (a rise AFTER the invoice stays on its own
 * supplementary invoice, so the primary keeps the first figure), and decision 2:
 * an invoice-correction credit note on a never-paid invoice is a price
 * correction, so the payment records the cash and nothing refunded, and a
 * recount from the ledger keeps it.
 *
 * Ordinary Vitest runs skip the whole file. It reuses the guarded, disposable
 * loopback PostgreSQL `concurrency-lock-races.realdb.test.ts` provisions
 * (#1881), which imports this file so CI reaches it; it cleans its own
 * uniquely-namespaced `race-3979-` fixtures.
 */
import type { PrismaClient } from "@prisma/client";
import type { CreditNote, Invoice } from "xero-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const MEMBER_ID = "race-3979-member";
// A lodge with no beds resolves to zero capacity (#1982): a booking holding
// its beds settles to PAID, and one that holds none takes the capacity cancel.
const LODGE_ID = "race-3979-lodge";
const BOOKING_ID = "race-3979-booking";
const PAYMENT_ID = "race-3979-payment";
const PRIMARY_ID = "race-3979-primary";
const GUEST_ID = "race-3979-guest";
const INVOICE_ID = "race-3979-invoice";
const MODIFICATION_ID = "race-3979-modification";
const NOTE_ID = "race-3979-note";
const CHECK_IN = new Date("2027-09-01T00:00:00.000Z");
const CHECK_OUT = new Date("2027-09-02T00:00:00.000Z");
// A stay already finished, for the #3955 finished-stay fee.
const PAST_CHECK_IN = new Date("2026-06-01T00:00:00.000Z");
const PAST_CHECK_OUT = new Date("2026-06-02T00:00:00.000Z");

/** Standalone fail-closed copy: importing this file must not register another suite. */
export function assertSafeIbSettleFromCashRaceDbUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("IB settle-from-cash proofs need a valid CONCURRENCY_RACE_DATABASE_URL.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isFinite(port) || port === 5432 || port < 55442) {
    throw new Error(
      `Refusing to run IB settle-from-cash proofs against port ${parsed.port || "(none)"}: use a throwaway PostgreSQL on 55442+ (never 5432).`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error("IB settle-from-cash proof DB must be loopback-only.");
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (!databaseName.includes("concurrency_race_1881")) {
    throw new Error("IB settle-from-cash proof DB name must contain 'concurrency_race_1881'.");
  }
}

// The admin alert, observed rather than mailed while this suite runs; every
// other suite the race harness imports beside it gets the real sender.
const adminAlert = vi.hoisted(() => ({ capturing: false, mock: null as unknown as import("vitest").Mock }));
vi.mock("@/lib/email", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/email");
  adminAlert.mock = vi.fn().mockResolvedValue(undefined);
  return {
    ...actual,
    sendAdminPaymentFailureAlert: ((...args: Parameters<typeof actual.sendAdminPaymentFailureAlert>) =>
      adminAlert.capturing
        ? adminAlert.mock(...args)
        : actual.sendAdminPaymentFailureAlert(...args)) as typeof actual.sendAdminPaymentFailureAlert,
  };
});

// The inbound credit-note sync reads the note from Xero: a fake at the client
// seam, switched on only by the cases that need it.
const fakeXero = vi.hoisted(() => ({ on: false, note: null as unknown }));
vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@/lib/xero-api-client");
  const client = {
    accountingApi: {
      getCreditNote: async () => ({ body: { creditNotes: [fakeXero.note] } }),
    },
  };
  return {
    ...actual,
    getAuthenticatedXeroClient: ((...args: Parameters<typeof actual.getAuthenticatedXeroClient>) =>
      fakeXero.on
        ? Promise.resolve({ xero: client, tenantId: "race-3979-tenant" })
        : actual.getAuthenticatedXeroClient(...args)) as typeof actual.getAuthenticatedXeroClient,
    callXeroApi: ((fn: () => unknown, options: Parameters<typeof actual.callXeroApi>[1]) =>
      fakeXero.on ? fn() : actual.callXeroApi(fn as never, options)) as typeof actual.callXeroApi,
  };
});

let prisma: PrismaClient;
let paidEffects: typeof import("@/lib/xero-inbound/invoice-paid-effects");
let creditNoteSync: typeof import("@/lib/xero-inbound/credit-note");
let paymentTransactions: typeof import("@/lib/payment-transactions");
let memberCredit: typeof import("@/lib/member-credit");

/** A PAID invoice carrying `cashCents` of bank cash, as a fresh getInvoice reads it. */
function paidInvoice(cashCents: number): Invoice {
  return {
    invoiceID: INVOICE_ID,
    invoiceNumber: "INV-3979",
    status: "PAID",
    amountPaid: cashCents / 100,
    payments: [{ paymentID: "race-3979-xpay", amount: cashCents / 100, status: "AUTHORISED" }],
  } as unknown as Invoice;
}

async function clean(): Promise<void> {
  await prisma.bookingLedgerLine.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingEvent.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.xeroObjectLink.deleteMany({
    where: { OR: [{ localId: { in: [PAYMENT_ID, BOOKING_ID, MODIFICATION_ID] } }, { xeroObjectId: { in: [INVOICE_ID, NOTE_ID] } }] },
  });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [PAYMENT_ID, BOOKING_ID, MODIFICATION_ID] } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [BOOKING_ID, PAYMENT_ID] } }, { targetId: BOOKING_ID }] } });
  await prisma.memberCredit.deleteMany({ where: { memberId: MEMBER_ID } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentRecoveryOperation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bedAllocation.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.paymentTransaction.deleteMany({ where: { paymentId: PAYMENT_ID } });
  await prisma.payment.deleteMany({ where: { id: PAYMENT_ID } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: BOOKING_ID } });
  await prisma.booking.deleteMany({ where: { id: BOOKING_ID } });
}

/**
 * An Internet Banking booking as `booking-create.ts` writes it, at `bookedCents`:
 * the payment and its PRIMARY row both PENDING at that figure. `holdsBeds`
 * is the held (CONFIRMED) shape, which settles to PAID; without it the late
 * payment meets a lodge with no room.
 */
async function bookAt(bookedCents: number, options: { holdsBeds?: boolean; finished?: boolean } = {}): Promise<void> {
  const holdsBeds = options.holdsBeds ?? true;
  const checkIn = options.finished ? PAST_CHECK_IN : CHECK_IN;
  const checkOut = options.finished ? PAST_CHECK_OUT : CHECK_OUT;
  await prisma.booking.create({
    data: {
      id: BOOKING_ID,
      memberId: MEMBER_ID,
      lodgeId: LODGE_ID,
      checkIn,
      checkOut,
      status: options.finished ? "COMPLETED" : holdsBeds ? "CONFIRMED" : "PAYMENT_PENDING",
      totalPriceCents: bookedCents,
      finalPriceCents: bookedCents,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: GUEST_ID,
      bookingId: BOOKING_ID,
      firstName: "Settle",
      lastName: "Proof",
      ageTier: "ADULT",
      isMember: true,
      stayStart: checkIn,
      stayEnd: checkOut,
      priceCents: bookedCents,
      nights: { create: [{ stayDate: checkIn, priceCents: bookedCents, priceSource: "SOLD" }] },
    },
  });
  await prisma.payment.create({
    data: {
      id: PAYMENT_ID,
      bookingId: BOOKING_ID,
      amountCents: bookedCents,
      source: "INTERNET_BANKING",
      status: "PENDING",
      reference: "BOOKING-RACE3979",
      internetBankingHoldSlots: holdsBeds && !options.finished,
      transactions: {
        create: {
          id: PRIMARY_ID,
          kind: "PRIMARY",
          source: "INTERNET_BANKING",
          amountCents: bookedCents,
          status: "PENDING",
          reference: "BOOKING-RACE3979",
          reason: "internet_banking_booking_payment",
        },
      },
    },
  });
}

/** An edit while no invoice exists: the price moves, the payment's figure does not. */
async function editPriceTo(priceCents: number): Promise<void> {
  await prisma.booking.update({ where: { id: BOOKING_ID }, data: { finalPriceCents: priceCents, totalPriceCents: priceCents } });
}

/** The invoice job's link: the invoice id on the payment and its PRIMARY row, and the active link. */
async function raiseInvoice(): Promise<void> {
  await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-3979" } });
  await prisma.paymentTransaction.update({ where: { id: PRIMARY_ID }, data: { xeroInvoiceId: INVOICE_ID, xeroInvoiceNumber: "INV-3979" } });
  await prisma.xeroObjectLink.create({
    data: { localModel: "Payment", localId: PAYMENT_ID, xeroObjectType: "INVOICE", xeroObjectId: INVOICE_ID, role: "PRIMARY_INVOICE", active: true },
  });
}

async function settle(cashCents: number) {
  return paidEffects.syncInternetBankingPaymentsForPaidInvoice(paidInvoice(cashCents), [PAYMENT_ID], CLUB_FORMAT_TEST);
}

async function figures() {
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: PAYMENT_ID },
    select: { amountCents: true, refundedAmountCents: true, status: true },
  });
  const primary = await prisma.paymentTransaction.findUniqueOrThrow({
    where: { id: PRIMARY_ID },
    select: { amountCents: true, status: true },
  });
  const receipts = await prisma.bookingLedgerLine.findMany({
    where: { bookingId: BOOKING_ID, kind: "BANK_RECEIPT" },
    select: { amountCents: true },
  });
  return { payment, primary, receipts: receipts.map((line) => line.amountCents) };
}

/**
 * The edit's invoice-correction note on the never-paid invoice (#3536,
 * `INV-PAY-116`), in the rows its builder leaves: the outbound operation that
 * recorded the wording, the note's link to the edit, and the allocation.
 */
async function queueModificationNote(noteCents: number, wording: Record<string, unknown>): Promise<void> {
  await prisma.bookingModification.create({
    data: {
      id: MODIFICATION_ID,
      bookingId: BOOKING_ID,
      memberId: MEMBER_ID,
      modificationType: "BATCH_MODIFY",
      previousData: {},
      newData: {},
      priceDiffCents: -noteCents,
      changeFeeCents: 0,
    },
  });
  await prisma.xeroSyncOperation.create({
    data: {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: "BookingModification",
      localId: MODIFICATION_ID,
      idempotencyKey: `race-3979-mod-credit-note-${noteCents}`,
      correlationKey: `race-3979-mod-credit-note-${noteCents}`,
      status: "SUCCEEDED",
      xeroObjectType: "CREDIT_NOTE",
      xeroObjectId: NOTE_ID,
      requestPayload: { invoiceId: INVOICE_ID, refundAmountCents: noteCents, ...wording },
    },
  });
  await prisma.xeroObjectLink.create({
    data: { localModel: "BookingModification", localId: MODIFICATION_ID, xeroObjectType: "CREDIT_NOTE", xeroObjectId: NOTE_ID, role: "MODIFICATION_CREDIT_NOTE", active: true },
  });
  fakeXero.note = {
    creditNoteID: NOTE_ID,
    creditNoteNumber: "CN-3979",
    status: "AUTHORISED",
    total: noteCents / 100,
    appliedAmount: noteCents / 100,
    remainingCredit: 0,
    allocations: [{ invoice: { invoiceID: INVOICE_ID }, amount: noteCents / 100 }],
  } satisfies CreditNote;
}

async function syncNote(): Promise<void> {
  fakeXero.on = true;
  try {
    await creditNoteSync.reconcileXeroCreditNote(NOTE_ID);
  } finally {
    fakeXero.on = false;
  }
}

async function cancellationCreditCents(): Promise<number> {
  const credits = await prisma.memberCredit.findMany({
    where: { memberId: MEMBER_ID, sourceBookingId: BOOKING_ID, type: "CANCELLATION_REFUND" },
    select: { amountCents: true },
  });
  return credits.reduce((sum, credit) => sum + credit.amountCents, 0);
}

(RUN ? describe : describe.skip)("a bank transfer settles at the cash its invoice collected, against PostgreSQL (#3979)", () => {
  beforeAll(async () => {
    assertSafeIbSettleFromCashRaceDbUrl(RACE_DB_URL);
    process.env.DATABASE_URL = RACE_DB_URL;
    ({ prisma } = await import("@/lib/prisma"));
    paidEffects = await import("@/lib/xero-inbound/invoice-paid-effects");
    creditNoteSync = await import("@/lib/xero-inbound/credit-note");
    paymentTransactions = await import("@/lib/payment-transactions");
    memberCredit = await import("@/lib/member-credit");

    await clean();
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
    await prisma.member.create({
      data: { id: MEMBER_ID, email: `${MEMBER_ID}@example.invalid`, passwordHash: "not-a-real-password", firstName: "Settle", lastName: "Proof", ageTier: "ADULT" },
    });
    await prisma.lodge.create({ data: { id: LODGE_ID, name: "Race 3979 Lodge", slug: "race-3979" } });
    // Everything back, no fee: the cancel's credit IS its cap.
    await prisma.cancellationPolicy.create({ data: { lodgeId: LODGE_ID, daysBeforeStay: 0, refundPercentage: 100, fixedFeeCents: 0 } });
  }, 60_000); // cold imports of the reconcile's module graph, on a loaded machine

  beforeEach(async () => {
    await clean();
    adminAlert.capturing = true;
    adminAlert.mock?.mockClear();
    fakeXero.on = false;
  });

  afterAll(async () => {
    adminAlert.capturing = false;
    if (!prisma) return;
    await clean();
    await prisma.cancellationPolicy.deleteMany({ where: { lodgeId: LODGE_ID } });
    await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
    await prisma.member.deleteMany({ where: { id: MEMBER_ID } });
  });

  it("THE WORKED EXAMPLE: booked at $300, cut to $200 before its invoice, paid $200: the row, the payment and the bank receipt are $200, and the cancel's cap is $200", async () => {
    await bookAt(30_000);
    await editPriceTo(20_000);
    await raiseInvoice();

    await settle(20_000);

    expect(await figures()).toMatchObject({
      payment: { amountCents: 20_000, refundedAmountCents: 0, status: "SUCCEEDED" },
      primary: { amountCents: 20_000, status: "SUCCEEDED" },
      receipts: [20_000],
    });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).status).toBe("PAID");
    expect(adminAlert.mock).not.toHaveBeenCalled();

    // A replay of the same PAID invoice decides nothing again.
    await settle(20_000);
    expect((await figures()).receipts).toEqual([20_000]);

    const { cancelBooking } = await import("@/lib/booking-cancel");
    const result = await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
    expect(result.status).toBe(200);
    expect(await cancellationCreditCents()).toBe(20_000);
  }, 60_000);

  it("RAISED before its invoice: booked at $200, raised to $300, paid $300: everything is $300, and the cancel credits $300 back where the stale $200 used to cap it", async () => {
    await bookAt(20_000);
    await editPriceTo(30_000);
    await raiseInvoice();

    await settle(30_000);

    expect(await figures()).toMatchObject({
      payment: { amountCents: 30_000, status: "SUCCEEDED" },
      primary: { amountCents: 30_000, status: "SUCCEEDED" },
      receipts: [30_000],
    });

    const { cancelBooking } = await import("@/lib/booking-cancel");
    const result = await cancelBooking(BOOKING_ID, MEMBER_ID, "ADMIN", "127.0.0.1", CLUB_FORMAT_TEST, "card");
    expect(result.status).toBe(200);
    expect(await cancellationCreditCents()).toBe(30_000);
  }, 60_000);

  it("A FINISHED-STAY FEE recorded before the invoice: the invoice bills price and fee, and the settle records both", async () => {
    await bookAt(20_000, { finished: true });
    // #3955: the approved change on the finished stay records its fee on the payment.
    await prisma.payment.update({ where: { id: PAYMENT_ID }, data: { changeFeeCents: 2_500 } });
    await raiseInvoice();

    await settle(22_500);

    expect(await figures()).toMatchObject({
      payment: { amountCents: 22_500, status: "SUCCEEDED" },
      primary: { amountCents: 22_500, status: "SUCCEEDED" },
      receipts: [22_500],
    });
    // The cash is exactly what the booking owes (worth = price + fee).
    expect(adminAlert.mock).not.toHaveBeenCalled();
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).status).toBe("COMPLETED");
  }, 60_000);

  it("THE LATE CAPACITY CANCEL: raised to $300 before its invoice, paid $300 after the beds went: the member's credit is the $300 the invoice collected", async () => {
    await bookAt(20_000, { holdsBeds: false });
    await editPriceTo(30_000);
    await raiseInvoice();

    await settle(30_000);

    expect((await prisma.booking.findUniqueOrThrow({ where: { id: BOOKING_ID }, select: { status: true } })).status).toBe("CANCELLED");
    expect(await figures()).toMatchObject({
      payment: { amountCents: 30_000 },
      primary: { amountCents: 30_000, status: "SUCCEEDED" },
      receipts: [30_000],
    });
    expect(await memberCredit.getMemberCreditBalance(MEMBER_ID)).toBe(30_000);
    // The cancel arm's own alert, for the whole cash; never a "partial" one.
    expect(adminAlert.mock).toHaveBeenCalledTimes(1);
    expect(adminAlert.mock.mock.calls[0][0]).toMatchObject({ amountCents: 30_000 });
    expect(adminAlert.mock.mock.calls[0][0].errorMessage).not.toContain("mixed invoice");
  }, 60_000);

  it("CONTROL: a rise AFTER the invoice stays on its supplementary invoice, so the primary keeps $200 and nothing alerts", async () => {
    await bookAt(20_000);
    await raiseInvoice();
    await editPriceTo(30_000);
    // The edit's supplementary invoice for the $100 increase, as its writer links it.
    await prisma.bookingModification.create({
      data: { id: MODIFICATION_ID, bookingId: BOOKING_ID, memberId: MEMBER_ID, modificationType: "BATCH_MODIFY", previousData: {}, newData: {}, priceDiffCents: 10_000, changeFeeCents: 0 },
    });
    await prisma.xeroObjectLink.create({
      data: { localModel: "BookingModification", localId: MODIFICATION_ID, xeroObjectType: "INVOICE", xeroObjectId: "race-3979-supplementary", role: "SUPPLEMENTARY_INVOICE", active: true },
    });

    await settle(20_000);

    expect(await figures()).toMatchObject({
      payment: { amountCents: 20_000, status: "SUCCEEDED" },
      primary: { amountCents: 20_000, status: "SUCCEEDED" },
      receipts: [20_000],
    });
    expect(adminAlert.mock).not.toHaveBeenCalled();
    await prisma.xeroObjectLink.deleteMany({ where: { xeroObjectId: "race-3979-supplementary" } });
  }, 60_000);

  it("DECISION 2: invoice $300, an invoice-correction note of $100, paid $200: $200 paid and $0 refunded, and a recount keeps it", async () => {
    await bookAt(30_000);
    await raiseInvoice();
    await editPriceTo(20_000);
    await queueModificationNote(10_000, { noteWording: "invoice-correction" });

    // The note reaches the inbound sync before the bank transfer: a correction
    // folds nothing into the never-paid payment.
    await syncNote();
    expect((await figures()).payment).toMatchObject({ amountCents: 30_000, refundedAmountCents: 0, status: "PENDING" });

    await settle(20_000);
    expect(await figures()).toMatchObject({
      payment: { amountCents: 20_000, refundedAmountCents: 0, status: "SUCCEEDED" },
      primary: { amountCents: 20_000, status: "SUCCEEDED" },
      receipts: [20_000],
    });
    expect(adminAlert.mock).not.toHaveBeenCalled();

    // The same note read again AFTER the capture is still a correction.
    await syncNote();
    // And a recount from the ledger rows keeps it.
    await paymentTransactions.reconcilePaymentAggregates({ paymentId: PAYMENT_ID });
    expect(await figures()).toMatchObject({
      payment: { amountCents: 20_000, refundedAmountCents: 0, status: "SUCCEEDED" },
      primary: { amountCents: 20_000, status: "SUCCEEDED" },
      receipts: [20_000],
    });
  }, 60_000);

  it("A NOTE WORDED AS A REFUND still counts as refunded, so the settle keeps the stored figure and alerts rather than count the reduction twice", async () => {
    await bookAt(30_000);
    await raiseInvoice();
    await editPriceTo(20_000);
    // An older note raised before #3536's wording existed: a bank-transfer refund.
    await queueModificationNote(10_000, { refundMethod: "internet-banking" });

    await syncNote();
    expect((await figures()).payment).toMatchObject({ amountCents: 30_000, refundedAmountCents: 10_000 });

    await settle(20_000);
    expect(await figures()).toMatchObject({
      payment: { amountCents: 30_000, refundedAmountCents: 10_000 },
      primary: { amountCents: 30_000, status: "SUCCEEDED" },
    });
    expect(adminAlert.mock).toHaveBeenCalledTimes(1);
    expect(adminAlert.mock.mock.calls[0][0].errorMessage).toContain("kept the $300.00 it had recorded");
  }, 60_000);
});
