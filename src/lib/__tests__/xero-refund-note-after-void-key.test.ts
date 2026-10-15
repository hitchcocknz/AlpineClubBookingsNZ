/**
 * `INV-ADDPAY-041` (#4091): what a refund note's key gains after a void
 * (`refundNoteKeyAfterVoidParts`), over a fake client - the figures a link
 * records, the create row's payload when the link records none, and failing
 * closed when neither does.
 */
import { describe, expect, it } from "vitest";
import { refundNoteKeyAfterVoidParts } from "@/lib/xero-refund-note-status";

type Link = { xeroObjectId: string; metadata: unknown };
type Create = { xeroObjectId: string; requestPayload: unknown };

function client(links: Link[], creates: Create[] = []) {
  return {
    xeroObjectLink: { findMany: async () => links },
    xeroSyncOperation: {
      findFirst: async ({ where }: { where: { xeroObjectId: string } }) =>
        creates.find((create) => create.xeroObjectId === where.xeroObjectId) ?? null,
      findMany: async () => [],
    },
  } as never;
}

describe("INV-ADDPAY-041: the after-void key parts", () => {
  it("adds nothing while no refund note on the payment is voided, even at a live note's base", async () => {
    const db = client([{ xeroObjectId: "cn_live", metadata: { amountCents: 5000, watermarkCents: 5000 } }]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { watermarkCents: 5000 }, db)).toEqual([]);
  });

  it("MUTATION (final lens F2): a voided link with no figures is matched by its create row's amount", async () => {
    // An inbound-written link: status only. Its create row recorded $50.
    const db = client(
      [{ xeroObjectId: "cn_voided", metadata: { status: "VOIDED", total: 50 } }],
      [{ xeroObjectId: "cn_voided", requestPayload: { allocation: { invoiceId: "inv_1", amount: 50 } } }],
    );
    expect(await refundNoteKeyAfterVoidParts("pay_1", { amountCents: 5000 }, db)).toEqual(["after-void", "cn_voided"]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { amountCents: 7000 }, db)).toEqual([]);
  });

  it("MUTATION (final lens F2): a voided link with no figures is matched by its queued create's watermark", async () => {
    const db = client(
      [{ xeroObjectId: "cn_voided", metadata: { status: "VOIDED" } }],
      [{ xeroObjectId: "cn_voided", requestPayload: { queueType: "REFUND_CREDIT_NOTE", refundAmountCents: 3000, watermarkCents: 8000 } }],
    );
    expect(await refundNoteKeyAfterVoidParts("pay_1", { watermarkCents: 8000 }, db)).toEqual(["after-void", "cn_voided"]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { watermarkCents: 5000 }, db)).toEqual([]);
  });

  it("MUTATION (final lens F2): a link whose figure nothing records fails closed - it is named whatever the base", async () => {
    const db = client([{ xeroObjectId: "cn_legacy", metadata: { status: "DELETED" } }]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { amountCents: 1234 }, db)).toEqual(["after-void", "cn_legacy"]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { watermarkCents: 99 }, db)).toEqual(["after-void", "cn_legacy"]);
  });

  it("names a live note at the key's base once a void exists, sorted with the voided ones", async () => {
    const db = client([
      { xeroObjectId: "cn_b", metadata: { amountCents: 3000, watermarkCents: 8000 } },
      { xeroObjectId: "cn_a", metadata: { amountCents: 5000, watermarkCents: 8000, status: "VOIDED" } },
      { xeroObjectId: "cn_c", metadata: { amountCents: 1000, watermarkCents: 9000 } },
    ]);
    expect(await refundNoteKeyAfterVoidParts("pay_1", { watermarkCents: 8000 }, db)).toEqual(["after-void", "cn_a", "cn_b"]);
  });
});
