import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { requireAdmin } from "@/lib/session-guards";
import {
  backfillHistoricalXeroObjectLinks,
  cleanupStaleCanonicalXeroObjectLinks,
} from "@/lib/xero-hardening";
import logger from "@/lib/logger";

export async function POST() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  // Audited in every case, once: a completed run (a partial heal failure
  // included, which the cleanup returns rather than throws) and one that
  // stopped on an error, whose earlier steps stay done (#4161).
  let auditDetails = "Xero link ledger maintenance failed before it finished; see the server log";
  try {
    const backfill = await backfillHistoricalXeroObjectLinks();
    const cleanup = await cleanupStaleCanonicalXeroObjectLinks();
    const healed = cleanup.healedCancelledRefundCreditNoteMirrors + cleanup.releasedInactiveRefundNotePointers;
    const failed = cleanup.failedRefundNoteHealLinkIds.length;
    const healSummary = `healed ${healed} refund-note mirror${healed === 1 ? "" : "s"} of VOIDED/DELETED Xero credit notes (${failed} failed, ${cleanup.deferredRefundNoteHealLinkIds.length} deferred)`;
    auditDetails = `Backfilled ${backfill.totals.createdLinks} canonical Xero links, deactivated ${cleanup.deactivatedLinks} stale canonical links and ${healSummary}`;

    // A completed run answers 200 so the panel shows the message, failures
    // included; `ok` says whether every heal landed.
    return NextResponse.json({
      ok: failed === 0,
      backfill,
      cleanup,
      message: `Backfilled ${backfill.totals.createdLinks} missing canonical Xero link${backfill.totals.createdLinks === 1 ? "" : "s"}, deactivated ${cleanup.deactivatedLinks} stale canonical link${cleanup.deactivatedLinks === 1 ? "" : "s"}, ${healSummary}, and preserved ${cleanup.preservedStripeRefundCreditNoteLinks} live per-refund note link${cleanup.preservedStripeRefundCreditNoteLinks === 1 ? "" : "s"} (#2901, #3880, #4161).`,
    });
  } catch (error) {
    logger.error({ err: error, adminMemberId: session.user.id }, "Failed to run Xero link ledger maintenance");
    return NextResponse.json(
      { error: "Failed to run Xero link ledger maintenance" },
      { status: 500 }
    );
  } finally {
    logAudit({
      action: "XERO_LINK_LEDGER_MAINTENANCE",
      category: "xero",
      memberId: session.user.id,
      details: auditDetails,
    });
  }
}
