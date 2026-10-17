"use client";

import { useId, useRef, useState, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FocusedActionError } from "@/components/focused-action-error";
import { Button } from "@/components/ui/button";
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
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useClubFormat } from "@/components/club-format-provider";
import { MANUAL_PAYMENT_NOTE_MAX } from "@/lib/manual-payment-note";
import { formatCents } from "@/lib/utils";

/**
 * #4210 round 3 (`INV-PAY-136`, UX 2): a row raised for an officer to check
 * after a "Paid another way" close, closed as checked - not owed when the
 * member is not owed it (`closeCardRefundCheckNotOwed`). Gated `finance:edit`
 * like the close beside it; the section banner states the view-only reason
 * (`describeReason={false}`). The dialog is the confirm step and a note saying
 * why is required. A refusal shows in the dialog; a 409 also refreshes the
 * list. After a close the parent's status line says what happened.
 */
export function CheckedNotOwedAction({
  canEdit,
  operationId,
  bookingReference,
  amountCents,
  onClosed,
  statusRef,
}: {
  canEdit: boolean | undefined;
  operationId: string;
  bookingReference: string;
  amountCents: number;
  /** Told after a close, with the sentence for the list's status line. */
  onClosed: (notice: string) => void;
  /** The list's status line, which takes focus after a close: the row and its button are gone. */
  statusRef: RefObject<HTMLElement | null>;
}) {
  const format = useClubFormat();
  const router = useRouter();
  const noteId = useId();
  const errorId = useId();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorAttention, setErrorAttention] = useState(0);
  const closedRef = useRef(false);
  const amount = formatCents(amountCents, format);

  function fail(message: string) {
    setError(message);
    setErrorAttention((count) => count + 1);
  }

  async function submit() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/payments/card-refunds/${operationId}/checked-not-owed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, confirmed: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        fail(typeof data.error === "string" ? data.error : "Could not close the card refund.");
        if (res.status === 409) router.refresh();
        return;
      }
      toast.success(`Closed. ${amount} is no longer owed, and your note is in the audit log.`);
      closedRef.current = true;
      setOpen(false);
      onClosed(`The card refund for booking ${bookingReference} was closed as checked - not owed.`);
      router.refresh();
    } catch {
      fail("Could not close the card refund.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <ViewOnlyActionButton
        canEdit={canEdit}
        describeReason={false}
        variant="outline"
        size="sm"
        aria-label={`Close the card refund for booking ${bookingReference} as checked - not owed`}
        onClick={() => {
          setNote("");
          setError("");
          closedRef.current = false;
          setOpen(true);
        }}
      >
        Checked - not owed
      </ViewOnlyActionButton>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent
          className="max-h-[90vh] overflow-y-auto"
          onCloseAutoFocus={(event) => {
            if (!closedRef.current) return;
            event.preventDefault();
            statusRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Close this card refund as checked - not owed?</DialogTitle>
            <DialogDescription>
              {amount} leaves Refunds owed and Net Collected, and nothing is paid or recorded in Xero. Only do this
              once you have checked the member is not owed it. If they are, pay them another way and close it as paid
              another way instead.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor={noteId}>Why is it not owed? (required)</Label>
            <Textarea
              id={noteId}
              value={note}
              required
              aria-required="true"
              maxLength={MANUAL_PAYMENT_NOTE_MAX}
              placeholder="For example: the close's bank transfer on 7 Oct covered it"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <FocusedActionError id={errorId} error={error} attentionKey={errorAttention} />
          <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
            {note.trim() === "" ? (
              <p className="text-xs text-muted-foreground sm:mr-auto">Say why the member is not owed it to close it.</p>
            ) : null}
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy || note.trim() === ""} onClick={() => void submit()}>
              {busy ? "Closing..." : "Close as not owed"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
