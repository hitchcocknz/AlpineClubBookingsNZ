"use client";

import { useId, useState } from "react";
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
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { formatCents } from "@/lib/utils";

/** One voided note a person answers, as `listBankRefundVoidsForAPerson` returns it (serialised). */
export interface BankRefundVoidToAnswerRow {
  linkId: string;
  bookingId: string;
  bookingReference: string;
  creditNoteNumber: string | null;
  amountCents: number | null;
  voidedAt: string;
}

/**
 * #4162 (owner decision 17 Oct 2026, `INV-ADDPAY-042`): bank-transfer refunds
 * whose Xero credit note was voided, which the nightly follow-up could not
 * match to one refund (an older note covering several, or one whose amount
 * cannot be read). Nothing was moved for them. The panel asks the same
 * question the refund list asks, and the answer is recorded here and moves
 * nothing: a person checks whether the money went, makes the Xero side right
 * by hand, and says what they did. `finance:view` to see, `finance:edit` to
 * answer; the banner states the view-only reason once.
 */
export function BankRefundVoidsToAnswerPanel({ rows }: { rows: readonly BankRefundVoidToAnswerRow[] }) {
  const canEdit = useAdminAreaEditAccess("finance");
  const format = useClubFormat();
  const clubTime = useClubTime();
  const router = useRouter();
  const noteId = useId();
  const errorId = useId();
  const [targetId, setTargetId] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorAttention, setErrorAttention] = useState(0);
  const [listNotice, setListNotice] = useState("");

  const target = targetId === null ? null : (rows.find((row) => row.linkId === targetId) ?? null);
  if (targetId !== null && target === null && !busy) {
    setTargetId(null);
    setListNotice("That voided refund note no longer needs an answer, so its dialog was closed. The list is up to date.");
  }
  if (rows.length === 0 && listNotice === "") return null;

  const amountOf = (row: BankRefundVoidToAnswerRow) =>
    row.amountCents === null ? "an amount the app cannot read" : formatCents(row.amountCents, format);

  async function submit() {
    if (!target) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/payments/bank-refund-voids/${target.linkId}/answered`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, confirmed: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Could not record the answer.");
        setErrorAttention((count) => count + 1);
        if (res.status === 409) router.refresh();
        return;
      }
      toast.success("Answer recorded. Nothing in the club's records moved.");
      setListNotice(`The voided refund note on booking ${target.bookingReference} was answered.`);
      setTargetId(null);
      router.refresh();
    } catch {
      setError("Could not record the answer.");
      setErrorAttention((count) => count + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="bank-refund-voids">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Landmark className="h-5 w-5 text-muted-foreground" />
          Voided bank refund notes to answer
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <AdminViewOnlySectionBanner canEdit={canEdit} />
        <p className="text-sm text-muted-foreground">
          Xero voided the credit note that recorded each of these bank refunds, and the app could not tell which
          refund the note was for, so it changed nothing. Has the money gone to the member? If it has, make sure
          Xero records it (raise a credit note there by hand if none does). If it has not, ask a developer to take
          the refund out of the club&apos;s records. Then record what you did here.
        </p>
        <p role="status" className="text-sm text-muted-foreground empty:hidden">
          {listNotice}
        </p>
        <ul className="space-y-2" aria-label="Voided bank refund notes to answer">
          {rows.map((row) => (
            <li key={row.linkId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted p-2">
              <div>
                <div className="text-sm font-medium">
                  <Link href={`/admin/bookings/${row.bookingId}`} className="underline">
                    Booking {row.bookingReference}
                  </Link>
                  {" - "}
                  {amountOf(row)}
                </div>
                <div className="text-xs text-muted-foreground">
                  Credit note {row.creditNoteNumber ?? "(no number)"} voided {clubTime.instantDate(new Date(row.voidedAt))}
                </div>
              </div>
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                size="sm"
                aria-label={`Answer the voided refund note on booking ${row.bookingReference}`}
                onClick={() => {
                  setTargetId(row.linkId);
                  setNote("");
                  setError("");
                  setListNotice("");
                }}
              >
                Record the answer
              </ViewOnlyActionButton>
            </li>
          ))}
        </ul>

        <Dialog open={target !== null} onOpenChange={(next) => !busy && !next && setTargetId(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Has the {target ? amountOf(target) : "refund"} gone to the member?</DialogTitle>
              <DialogDescription>
                {target
                  ? `Booking ${target.bookingReference}: its Xero credit note ${target.creditNoteNumber ?? ""} was voided on ${clubTime.instantDate(new Date(target.voidedAt))}. Recording your answer moves nothing in the club's records and raises nothing in Xero.`
                  : null}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1">
              <Label htmlFor={noteId}>What did you find, and what did you do? (required)</Label>
              <Textarea
                id={noteId}
                value={note}
                required
                aria-required="true"
                maxLength={MANUAL_PAYMENT_NOTE_MAX}
                placeholder="For example: paid on 7 Oct, credit note CN-0456 raised in Xero by hand"
                onChange={(event) => setNote(event.target.value)}
              />
            </div>
            <FocusedActionError id={errorId} error={error} attentionKey={errorAttention} />
            <DialogFooter className="gap-2 sm:gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setTargetId(null)}>
                Cancel
              </Button>
              <Button disabled={busy || note.trim() === ""} onClick={() => void submit()}>
                {busy ? "Recording..." : "Record the answer"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
