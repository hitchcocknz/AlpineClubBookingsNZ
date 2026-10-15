// Canonical Xero object-link cleanup: deactivates active canonical links whose
// local canonical field no longer points at them. Extracted verbatim from
// xero-hardening.ts (#1208 item 5). Import xero source modules directly, never
// the @/lib/xero facade (#1208).
//
// SOURCE-AWARE for payment refund credit notes (#2901): a `source: STRIPE`
// payment refunded in steps holds one active REFUND_CREDIT_NOTE link PER
// refund delta (INV-ADDPAY-020), so the scalar `Payment.xeroRefundCreditNoteId`
// is only "the latest note", never "the only note". Treating it as the sole
// canonical target made this cleanup deactivate live coverage, which the daily
// credit-reconciliation self-heal then rebuilt with ANOTHER provider document —
// an unbounded duplicate-note loop (a production payment accumulated 21
// alternating notes for one 100-cent refund). Stripe per-delta links are
// therefore exempt from single-canonical enforcement here, exactly as they are
// in `normalizePaymentRefundLinkWithClient` (xero-sync.ts) — EXCEPT the mirror
// of a note whose recorded Xero status is VOIDED/DELETED, which is stale by
// definition and is deactivated so the self-heal can reissue the uncovered
// delta. Non-Stripe payment sources contract to a single refund note and keep
// the enforcement, except a link stamped per-refund (#3880: a review's
// bank-transfer hand-back, `isPerDeltaRefundNoteLink`), which is never the
// field's note and is exempt by the same rule as a Stripe delta.
//
// #4161: every still-active mirror of a refund note Xero VOIDED/DELETED, on any
// payment source, is healed through the link write (`upsertXeroObjectLink`)
// rather than flipped here, so #4091's normaliser writes it inactive and
// #4046's post-write rule releases the payment's refund-note pointer. A
// bank-transfer payment's one canonical note voided before #4091 matched its
// pointer and was never seen as stale until then.
import { PaymentSource } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { asRecord } from "@/lib/xero-json";
import { upsertXeroObjectLink } from "@/lib/xero-sync";
import {
  isPerDeltaRefundNoteLink,
  isRefundCreditNoteLinkCancelledInXero,
} from "@/lib/xero-refund-note-status";
import type {
  CanonicalLinkExpectation,
  CanonicalLinkRecord,
  XeroCanonicalLinkCleanupResult,
} from "./xero-hardening-types";
import { buildCanonicalScopeKey } from "./xero-hardening-shared";

/**
 * The payment ids, among the given refund-note link owners, whose payment is
 * `source: STRIPE`. Queried from the LINKS' local ids rather than from the
 * canonical-field payment scan so a Stripe payment whose scalar pointer (and
 * even invoice pointer) is currently null still shields its per-delta links —
 * a null scalar previously produced "no expectation", which deactivated every
 * active note link for that payment. Shared by cleanup and the drift report.
 */
export async function findStripeSourcePaymentIds(
  paymentIds: string[]
): Promise<Set<string>> {
  if (paymentIds.length === 0) {
    return new Set();
  }
  const stripePayments = await prisma.payment.findMany({
    where: {
      id: { in: paymentIds },
      source: PaymentSource.STRIPE,
    },
    select: { id: true },
  });
  return new Set(stripePayments.map((payment) => payment.id));
}

/**
 * True when this active link is SHAPED like one of several per-refund credit
 * note links a payment may hold, which stay active beside their siblings: any
 * refund note on a `source: STRIPE` payment (INV-ADDPAY-020, #2901), or one
 * whose link metadata stamps it per-refund on any source (#3880,
 * `isPerDeltaRefundNoteLink`). ONE rule for the cleanup and every drift-report
 * classification. Shape only: callers that exempt these links must still
 * check the recorded Xero status, since a VOIDED/DELETED note's mirror is not
 * live coverage (`isRefundCreditNoteLinkCancelledInXero`). A REFUND_CREDIT_NOTE
 * link with the wrong xeroObjectType is malformed (the pipeline only writes
 * CREDIT_NOTE) and stays subject to cleanup. Pass `metadata: null` for a
 * canonical-field expectation, which is never itself a per-refund stamp.
 */
export function isPerRefundCreditNoteLink(
  link: Pick<CanonicalLinkRecord, "localModel" | "localId" | "role" | "xeroObjectType"> & { metadata: unknown },
  stripePaymentIds: ReadonlySet<string>
): boolean {
  return (
    link.localModel === "Payment" &&
    link.role === "REFUND_CREDIT_NOTE" &&
    link.xeroObjectType === "CREDIT_NOTE" &&
    (stripePaymentIds.has(link.localId) || isPerDeltaRefundNoteLink(link.metadata))
  );
}

/**
 * #4161: a payment refund-note mirror whose recorded Xero status is
 * VOIDED/DELETED (`isRefundCreditNoteLinkCancelledInXero`), on any payment
 * source: a card delta, a per-refund note, or a bank-transfer payment's one
 * canonical note. Read over ACTIVE links, it is drift the nightly cleanup heals
 * and the drift report lists as stale. ONE rule for both. A wrong-typed
 * REFUND_CREDIT_NOTE link is malformed and left to the ordinary stale rules.
 */
export function isCancelledRefundCreditNoteMirror(
  link: Pick<CanonicalLinkRecord, "localModel" | "role" | "xeroObjectType"> & { metadata: unknown }
): boolean {
  return (
    link.localModel === "Payment" &&
    link.role === "REFUND_CREDIT_NOTE" &&
    link.xeroObjectType === "CREDIT_NOTE" &&
    isRefundCreditNoteLinkCancelledInXero(link.metadata)
  );
}

/**
 * #4161: heal one cancelled mirror through the link write, re-asserting only the
 * status already recorded (merged, so no other metadata key moves), so the one
 * rule in `normalizePaymentRefundLinkWithClient` writes it inactive and the
 * write releases a pointer that names it. Number and URL are passed back as
 * recorded because the write sets both. Local rows only, no provider call; the
 * write locks the link, then the payment, as every refund-note link write does.
 * Idempotent: a healed link is inactive, so the next scan never selects it.
 */
async function healCancelledRefundCreditNoteMirror(link: {
  localId: string;
  xeroObjectId: string;
  xeroObjectNumber: string | null;
  xeroObjectUrl: string | null;
  metadata: unknown;
}) {
  await upsertXeroObjectLink({
    localModel: "Payment",
    localId: link.localId,
    xeroObjectType: "CREDIT_NOTE",
    xeroObjectId: link.xeroObjectId,
    xeroObjectNumber: link.xeroObjectNumber,
    xeroObjectUrl: link.xeroObjectUrl,
    role: "REFUND_CREDIT_NOTE",
    metadata: { status: asRecord(link.metadata)?.status },
    mergeMetadata: true,
  });
}

function getCanonicalCleanupCategory(
  link: Pick<CanonicalLinkRecord, "localModel" | "role">
): keyof XeroCanonicalLinkCleanupResult["byCategory"] {
  if (link.localModel === "Member" && link.role === "CONTACT") {
    return "memberContacts";
  }
  if (link.localModel === "Payment" && link.role === "PRIMARY_INVOICE") {
    return "paymentInvoices";
  }
  if (link.localModel === "Payment" && link.role === "REFUND_CREDIT_NOTE") {
    return "paymentRefundCreditNotes";
  }
  if (link.localModel === "MemberSubscription" && link.role === "SUBSCRIPTION_INVOICE") {
    return "subscriptionInvoices";
  }
  return "otherCanonicalLinks";
}

export async function cleanupStaleCanonicalXeroObjectLinks(): Promise<XeroCanonicalLinkCleanupResult> {
  const [members, payments, subscriptions, links] = await Promise.all([
    prisma.member.findMany({
      where: {
        xeroContactId: {
          not: null,
        },
      },
      select: {
        id: true,
        xeroContactId: true,
      },
    }),
    prisma.payment.findMany({
      where: {
        OR: [
          {
            xeroInvoiceId: {
              not: null,
            },
          },
          {
            xeroRefundCreditNoteId: {
              not: null,
            },
          },
        ],
      },
      select: {
        id: true,
        xeroInvoiceId: true,
        xeroRefundCreditNoteId: true,
      },
    }),
    prisma.memberSubscription.findMany({
      where: {
        xeroInvoiceId: {
          not: null,
        },
      },
      select: {
        id: true,
        xeroInvoiceId: true,
      },
    }),
    prisma.xeroObjectLink.findMany({
      where: {
        active: true,
        OR: [
          {
            localModel: "Member",
            role: "CONTACT",
          },
          {
            localModel: "Payment",
            role: {
              in: ["PRIMARY_INVOICE", "REFUND_CREDIT_NOTE"],
            },
          },
          {
            localModel: "MemberSubscription",
            role: "SUBSCRIPTION_INVOICE",
          },
        ],
      },
      select: {
        id: true,
        localModel: true,
        localId: true,
        xeroObjectType: true,
        xeroObjectId: true,
        // #4161: the heal re-writes the link through the funnel, which sets both.
        xeroObjectNumber: true,
        xeroObjectUrl: true,
        role: true,
        // #2901 fix round: the merged inbound status decides whether a Stripe
        // per-delta link still mirrors a LIVE note (see the filter below).
        metadata: true,
      },
    }),
  ]);

  const expectations: CanonicalLinkExpectation[] = [
    ...members.flatMap((member) =>
      member.xeroContactId
        ? [
            {
              localModel: "Member",
              localId: member.id,
              role: "CONTACT",
              xeroObjectType: "CONTACT",
              xeroObjectId: member.xeroContactId,
            },
          ]
        : []
    ),
    ...payments.flatMap((payment) =>
      [
        payment.xeroInvoiceId
          ? {
              localModel: "Payment",
              localId: payment.id,
              role: "PRIMARY_INVOICE",
              xeroObjectType: "INVOICE",
              xeroObjectId: payment.xeroInvoiceId,
            }
          : null,
        payment.xeroRefundCreditNoteId
          ? {
              localModel: "Payment",
              localId: payment.id,
              role: "REFUND_CREDIT_NOTE",
              xeroObjectType: "CREDIT_NOTE",
              xeroObjectId: payment.xeroRefundCreditNoteId,
            }
          : null,
      ].filter((value): value is CanonicalLinkExpectation => value !== null)
    ),
    ...subscriptions.flatMap((subscription) =>
      subscription.xeroInvoiceId
        ? [
            {
              localModel: "MemberSubscription",
              localId: subscription.id,
              role: "SUBSCRIPTION_INVOICE",
              xeroObjectType: "SUBSCRIPTION",
              xeroObjectId: subscription.xeroInvoiceId,
            },
          ]
        : []
    ),
  ];

  const expectationByScope = new Map(
    expectations.map((expectation) => [
      buildCanonicalScopeKey(expectation),
      expectation,
    ])
  );
  // #2901: resolve payment sources from the LINKS, not from the canonical-field
  // payment scan above, so per-delta links survive even when the payment's
  // scalar pointers are null and it therefore has no expectation row.
  const stripePaymentIds = await findStripeSourcePaymentIds(
    Array.from(
      new Set(
        links
          .filter(
            (link) =>
              link.localModel === "Payment" && link.role === "REFUND_CREDIT_NOTE"
          )
          .map((link) => link.localId)
      )
    )
  );
  // #4161, read-only first: the cancelled mirrors this run will heal, counted
  // before any write and reported in the result.
  const cancelledRefundCreditNoteMirrors = links.filter(isCancelledRefundCreditNoteMirror);
  let preservedStripeRefundCreditNoteLinks = 0;
  const staleLinks = links.filter((link) => {
    // #4161: a cancelled mirror is stale on every source, the pointer's own
    // note included; it is healed through the link write below.
    if (isCancelledRefundCreditNoteMirror(link)) {
      return true;
    }
    // Stripe payments legitimately hold one ACTIVE refund note per refund
    // delta (INV-ADDPAY-020); the scalar pointer is only the latest of them.
    // A per-refund-stamped note (#3880) is never the scalar's note on any
    // source. Single-canonical enforcement is retained ONLY for the rest
    // (#2901).
    if (isPerRefundCreditNoteLink(link, stripePaymentIds)) {
      // The exemption shields LIVE per-delta coverage only. A cancelled note
      // credits nothing (INV-ADDPAY-020); its mirror was returned as stale
      // above, which is what re-arms the credit-reconciliation self-heal to
      // reissue the uncovered delta (#2901 review).
      preservedStripeRefundCreditNoteLinks += 1;
      return false;
    }

    const expectation = expectationByScope.get(buildCanonicalScopeKey(link));
    if (!expectation) {
      return true;
    }

    return (
      expectation.xeroObjectType !== link.xeroObjectType ||
      expectation.xeroObjectId !== link.xeroObjectId
    );
  });
  const staleLinkIds = staleLinks.map((link) => link.id);
  const flippedLinkIds = staleLinks
    .filter((link) => !isCancelledRefundCreditNoteMirror(link))
    .map((link) => link.id);

  let deactivatedLinks = 0;
  if (flippedLinkIds.length > 0) {
    const updateResult = await prisma.xeroObjectLink.updateMany({
      where: {
        id: {
          in: flippedLinkIds,
        },
        active: true,
      },
      data: {
        active: false,
      },
    });
    deactivatedLinks = updateResult.count;
  }

  // #4161: one link write per cancelled mirror, each in its own transaction, so
  // one failure never holds back the rest. A failure fails the task (the cron
  // run records it) once every other mirror has been tried; the next run
  // retries only what is still active.
  const failedHealLinkIds: string[] = [];
  for (const link of cancelledRefundCreditNoteMirrors) {
    try {
      await healCancelledRefundCreditNoteMirror(link);
      deactivatedLinks += 1;
    } catch (error) {
      failedHealLinkIds.push(link.id);
      logger.error(
        { err: error, linkId: link.id, paymentId: link.localId, xeroObjectId: link.xeroObjectId },
        "Could not heal the active mirror of a VOIDED/DELETED Xero refund credit note (#4161)"
      );
    }
  }
  if (failedHealLinkIds.length > 0) {
    throw new Error(
      `Healed ${cancelledRefundCreditNoteMirrors.length - failedHealLinkIds.length} of ${cancelledRefundCreditNoteMirrors.length} active mirrors of VOIDED/DELETED Xero refund credit notes; ${failedHealLinkIds.length} failed (links ${failedHealLinkIds.join(", ")}) and stay for the next run (#4161).`
    );
  }

  const byCategory: XeroCanonicalLinkCleanupResult["byCategory"] = {
    memberContacts: 0,
    paymentInvoices: 0,
    paymentRefundCreditNotes: 0,
    subscriptionInvoices: 0,
    otherCanonicalLinks: 0,
  };

  for (const link of staleLinks) {
    byCategory[getCanonicalCleanupCategory(link)] += 1;
  }

  return {
    completedAt: new Date(),
    scannedActiveLinks: links.length,
    keptActiveLinks: links.length - deactivatedLinks,
    deactivatedLinks,
    preservedStripeRefundCreditNoteLinks,
    cancelledRefundCreditNoteMirrors: cancelledRefundCreditNoteMirrors.length,
    byCategory,
    deactivatedLinkIds: staleLinkIds,
  };
}
