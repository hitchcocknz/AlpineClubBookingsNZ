"use client";

import { useId, useRef, useState } from "react";
import Link from "next/link";
import { Landmark } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FocusedActionError } from "@/components/focused-action-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useClubFormat } from "@/components/club-format-provider";
import { useClubTime } from "@/components/club-time-provider";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  CONFIRM_BASIS_LABEL,
  RE_RECORD_REFUSAL_MESSAGES,
  type BankRefundVoidConfirmBasis,
  type ReRecordRefusal,
} from "@/lib/bank-refund-void-copy";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { formatCents } from "@/lib/utils";

/** One voided bank-transfer refund note, as `listBankRefundVoids` returns it. */
export interface BankRefundVoidPanelRow {
  linkId: string;
  bookingId: string;
  bookingReference: string;
  voidedCreditNoteNumber: string | null;
  voidedCreditNoteId: string;
  amountCents: number | null;
  voidedAt: string;
  liveNotes: Array<{ creditNoteId: string; creditNoteNumber: string | null; amountCents: number | null }>;
  flag: "note-failed" | "voided-again" | null;
  reRecordOf: string | null;
  reRecordRefusal: ReRecordRefusal | null;
  answerable: boolean;
}

type Mode = "re-record" | "confirm";

function noteName(row: Pick<BankRefundVoidPanelRow, "voidedCreditNoteNumber" | "voidedCreditNoteId">): string {
  return row.voidedCreditNoteNumber ?? row.voidedCreditNoteId;
}

/**
 * #4162 (owner decisions 16 and 17 Oct 2026, `INV-ADDPAY-042`): bank-transfer
 * refunds whose Xero credit note was voided, each with its two answers.
 *
 * On a bank transfer a voided note undoes the refund in the club's records, and
 * the app never raises it again by itself. Each row shows the voided note's
 * amount and the payment's live refund notes, so a note already replaced by
 * hand in Xero is seen (Q4). "Record again" raises one fresh note for exactly
 * the voided note's amount, shown read-only (Q1); the member is not told (Q3).
 * "Confirm" clears it, saying why: the refund was cancelled (the payment's
 * records take it back out, Q2) or the note was replaced by hand in Xero
 * (nothing moves). Both are gated `finance:edit`, the section's banner stating
 * the view-only reason once (`describeReason={false}`). A refusal shows in the
 * dialog (`FocusedActionError`); a 409 also refreshes the list, and if the
 * refresh drops the row the dialog closes and says why. After an answer, focus
 * moves to the list's status line.
 */
export function BankRefundVoidsPanel({
  rows,
  bankNoteWording,
}: {
  rows: BankRefundVoidPanelRow[];
  /** The bank-transfer refund note's wording (`describeRefundMethod("internet-banking")`). */
  bankNoteWording: string;
}) {
  const canEdit = useAdminAreaEditAccess("finance");
  const format = useClubFormat();
  const clubTime = useClubTime();
  const router = useRouter();
  const noteId = useId();
  const errorId = useId();
  const submitHintId = useId();
  const basisName = useId();
  const [targetId, setTargetId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("re-record");
  const [seenAmountCents, setSeenAmountCents] = useState<number | null>(null);
  const [basis, setBasis] = useState<BankRefundVoidConfirmBasis | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorAttention, setErrorAttention] = useState(0);
  const [listNotice, setListNotice] = useState("");
  const listNoticeRef = useRef<HTMLParagraphElement>(null);
  // Once it has had a row, the card stays while the page is open, so focus has
  // somewhere to land after the last row is answered (as the card refund lists).
  const [shown, setShown] = useState(rows.length > 0);
  if (!shown && rows.length > 0) setShown(true);

  const target = targetId === null ? null : (rows.find((row) => row.linkId === targetId) ?? null);
  if (targetId !== null && (target === null || !target.answerable) && !busy) {
    setTargetId(null);
    setListNotice("That voided refund note is no longer waiting for an answer, so its dialog was closed. The list is up to date.");
  }

  const noteMissing = note.trim() === "";
  const amountMoved = target !== null && seenAmountCents !== null && target.amountCents !== seenAmountCents;
  const canSubmit =
    target !== null && target.amountCents !== null && !noteMissing && !busy && !amountMoved && (mode === "re-record" || basis !== null);
  const submitHint =
    target === null || busy
      ? null
      : amountMoved
        ? "The voided note's amount changed. Close this and check it again."
        : mode === "confirm" && basis === null
          ? "Choose why it is being cleared."
          : noteMissing
            ? "Give a reason to continue."
            : null;

  function open(row: BankRefundVoidPanelRow, nextMode: Mode) {
    setTargetId(row.linkId);
    setMode(nextMode);
    setSeenAmountCents(row.amountCents);
    setBasis(null);
    setNote("");
    setError("");
    setListNotice("");
  }

  function fail(message: string) {
    setError(message);
    setErrorAttention((count) => count + 1);
  }

  async function submit() {
    if (!target || target.amountCents === null) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/payments/bank-refund-voids/${encodeURIComponent(target.linkId)}/${mode === "re-record" ? "re-record" : "confirm-cancelled"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(mode === "confirm" ? { basis } : {}),
            expectedAmountCents: seenAmountCents ?? target.amountCents,
            note,
            confirmed: true,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(typeof data.error === "string" ? data.error : "Could not answer the voided refund note.");
        if (res.status === 409 || res.status === 404) router.refresh();
        return;
      }
      const amount = formatCents(target.amountCents, format);
      if (mode === "re-record") {
        toast.success(`Recorded again. A fresh ${bankNoteWording} credit note for ${amount} is on its way to Xero.`);
        setListNotice(`The refund for booking ${target.bookingReference} was recorded again.`);
      } else {
        toast.success(
          basis === "cancelled"
            ? `Confirmed cancelled. ${amount} was taken back out of the payment's records.`
            : "Confirmed replaced in Xero. Nothing was changed in the club's records.",
        );
        setListNotice(`The voided refund note for booking ${target.bookingReference} was cleared.`);
      }
      setTargetId(null);
      router.refresh();
    } catch {
      fail("Could not answer the voided refund note.");
    } finally {
      setBusy(false);
    }
  }

  if (!shown) return null;
  return (
    <Card id="bank-refund-voids">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Landmark className="h-5 w-5 text-muted-foreground" />
          Bank-transfer refunds with a voided credit note
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <AdminViewOnlySectionBanner canEdit={canEdit} />
          <p className="text-sm text-muted-foreground">
            Xero voided the credit note of each of these bank-transfer refunds, so the club&apos;s records no longer
            count the refund, and the app will not raise the note again by itself. If the member was paid back,
            record the refund again: one fresh credit note is raised for the voided note&apos;s amount. If the
            refund was cancelled, or you already replaced the note by hand in Xero, confirm it instead. The member
            is not told either way.
          </p>
          <p
            ref={listNoticeRef}
            role="status"
            tabIndex={-1}
            className="text-sm text-muted-foreground outline-none empty:hidden"
          >
            {listNotice}
          </p>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No voided bank-transfer refund notes are waiting.</p>
          ) : null}
          <ul className="space-y-2" aria-label="Bank-transfer refunds with a voided credit note">
            {rows.map((row) => (
              <li
                key={row.linkId}
                className="flex flex-wrap items-start justify-between gap-2 rounded-md border bg-muted p-2"
              >
                <div className="space-y-1">
                  <div className="text-sm font-medium">
                    <Link href={`/admin/bookings/${row.bookingId}`} className="underline">
                      Booking {row.bookingReference}
                    </Link>
                    {" - "}
                    {row.amountCents === null ? "amount unknown" : `${formatCents(row.amountCents, format)} refund`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Xero voided credit note {noteName(row)}; recorded {clubTime.instantDate(new Date(row.voidedAt))}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {row.liveNotes.length === 0
                      ? "No live refund credit notes on this payment."
                      : `Live refund credit notes on this payment: ${row.liveNotes
                          .map((live) =>
                            live.amountCents === null
                              ? (live.creditNoteNumber ?? live.creditNoteId)
                              : `${live.creditNoteNumber ?? live.creditNoteId} (${formatCents(live.amountCents, format)})`,
                          )
                          .join(", ")}.`}
                  </div>
                  {row.flag === "note-failed" ? (
                    <div className="text-xs font-medium text-warning-11">
                      Recorded again, but its fresh credit note did not reach Xero for the full amount.{" "}
                      <Link href="/admin/xero" className="underline">
                        Check it on the Xero screen
                      </Link>
                      .
                    </div>
                  ) : null}
                  {row.flag === "voided-again" ? (
                    <div className="text-xs font-medium text-warning-11">
                      This note recorded {row.reRecordOf} again, and Xero voided it too.
                    </div>
                  ) : null}
                  {row.answerable && row.reRecordRefusal ? (
                    <div className="text-xs text-muted-foreground">{RE_RECORD_REFUSAL_MESSAGES[row.reRecordRefusal]}</div>
                  ) : null}
                </div>
                {row.answerable ? (
                  <div className="flex flex-wrap gap-2">
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      variant="outline"
                      size="sm"
                      disabled={row.reRecordRefusal !== null}
                      aria-label={`Record the refund for booking ${row.bookingReference} again`}
                      onClick={() => open(row, "re-record")}
                    >
                      Record again
                    </ViewOnlyActionButton>
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      variant="outline"
                      size="sm"
                      disabled={row.amountCents === null}
                      aria-label={`Confirm the voided refund note for booking ${row.bookingReference}`}
                      onClick={() => open(row, "confirm")}
                    >
                      Confirm
                    </ViewOnlyActionButton>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>

          <Dialog open={target !== null} onOpenChange={(next) => !busy && !next && setTargetId(null)}>
            <DialogContent
              className="max-h-[90vh] overflow-y-auto"
              onCloseAutoFocus={(event) => {
                if (listNotice === "") return;
                event.preventDefault();
                listNoticeRef.current?.focus();
              }}
            >
              <DialogHeader>
                <DialogTitle>
                  {mode === "re-record" ? "Record this refund again?" : "Clear this voided refund note?"}
                </DialogTitle>
                <DialogDescription>
                  {mode === "re-record"
                    ? `The refund is counted on the payment again, and one fresh ${bankNoteWording} credit note is raised in Xero for the voided note's amount. Only do this if the member was paid back. The member is not told.`
                    : "Say why. If the refund was cancelled, it is taken back out of the payment's records. If you replaced the note by hand in Xero, nothing in the club's records changes. Nothing is sent to Xero, and the member is not told."}
                </DialogDescription>
              </DialogHeader>
              <p className="text-sm font-medium text-foreground">
                {target && target.amountCents !== null
                  ? `Booking ${target.bookingReference}: ${formatCents(target.amountCents, format)}, from credit note ${noteName(target)}.`
                  : null}
              </p>
              {mode === "confirm" ? (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Why is it being cleared?</legend>
                  {(["cancelled", "replaced-in-xero"] as const).map((choice) => (
                    <label key={choice} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name={basisName}
                        className="size-4"
                        checked={basis === choice}
                        onChange={() => setBasis(choice)}
                      />
                      <span>
                        {choice === "cancelled"
                          ? `${CONFIRM_BASIS_LABEL.cancelled} - the member was not paid`
                          : `${CONFIRM_BASIS_LABEL["replaced-in-xero"]} - the member was paid, and a note made in Xero records it`}
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <div className="space-y-1">
                <Label htmlFor={noteId}>Reason (required)</Label>
                <Textarea
                  id={noteId}
                  value={note}
                  required
                  aria-required="true"
                  maxLength={MANUAL_PAYMENT_NOTE_MAX}
                  placeholder={
                    mode === "re-record"
                      ? "For example: paid back by bank transfer on 2 Jun; the note was voided by mistake"
                      : "For example: replaced in Xero by CN-0123"
                  }
                  onChange={(event) => setNote(event.target.value)}
                />
              </div>
              <FocusedActionError id={errorId} error={error} attentionKey={errorAttention} />
              <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
                {submitHint ? (
                  <p id={submitHintId} className="text-xs text-muted-foreground sm:mr-auto">
                    {submitHint}
                  </p>
                ) : null}
                <Button variant="outline" disabled={busy} onClick={() => setTargetId(null)}>
                  Cancel
                </Button>
                <Button
                  disabled={!canSubmit}
                  aria-describedby={submitHint ? submitHintId : undefined}
                  onClick={() => void submit()}
                >
                  {busy ? "Saving..." : mode === "re-record" ? "Record again" : "Confirm"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardContent>
    </Card>
  );
}
