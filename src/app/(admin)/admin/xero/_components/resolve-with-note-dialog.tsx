"use client"

import { useCallback, useRef, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { HAND_MADE_CREDIT_NOTE_NUMBER_MAX } from "@/lib/bank-refund-void-follow-up-copy"
import { resolveDialogDescription } from "./resolve-dialog-copy"

export interface ResolveWithNoteAnswer {
  creditNoteNumber: string
  reason: string
}

/** The reason's bounds, as the resolve route checks them. */
const REASON_MIN = 3
const REASON_MAX = 500

/**
 * #4421 (owner decision 26 Oct 2026, `INV-INT-025`): "Resolve by hand" on a
 * refund credit note the app never raised asks for the number of the credit
 * note the officer made in Xero, beside the reason. The route checks the note
 * in Xero and records it; this dialog only asks. Resolves to null when
 * cancelled.
 */
export function useResolveWithNoteDialog(): {
  askResolveWithNote: () => Promise<ResolveWithNoteAnswer | null>
  resolveWithNoteDialog: ReactNode
} {
  const [open, setOpen] = useState(false)
  const [creditNoteNumber, setCreditNoteNumber] = useState("")
  const [reason, setReason] = useState("")
  const settleRef = useRef<((answer: ResolveWithNoteAnswer | null) => void) | null>(null)

  const askResolveWithNote = useCallback(
    () =>
      new Promise<ResolveWithNoteAnswer | null>((resolve) => {
        settleRef.current?.(null)
        settleRef.current = resolve
        setCreditNoteNumber("")
        setReason("Made the credit note by hand in Xero")
        setOpen(true)
      }),
    [],
  )

  const number = creditNoteNumber.trim()
  const trimmedReason = reason.trim()
  const ready = number.length > 0 && trimmedReason.length >= REASON_MIN

  const settle = (confirmed: boolean) => {
    settleRef.current?.(confirmed && ready ? { creditNoteNumber: number, reason: trimmedReason } : null)
    settleRef.current = null
    setOpen(false)
  }

  const resolveWithNoteDialog = (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) settle(false) }}>
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Resolve this refund credit note?</DialogTitle>
          <DialogDescription>
            Give the number of the credit note you made for this refund in Xero. The app checks it in Xero
            (approved or paid, for this refund&apos;s amount and the member&apos;s contact) and records it, so the
            same note can&apos;t also be recorded against another refund. {resolveDialogDescription("CREDIT_NOTE")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="resolve-credit-note-number">Xero credit note number</Label>
            <Input
              id="resolve-credit-note-number"
              required
              placeholder="CN-0123"
              maxLength={HAND_MADE_CREDIT_NOTE_NUMBER_MAX}
              value={creditNoteNumber}
              onChange={(event) => setCreditNoteNumber(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="resolve-credit-note-reason">Reason</Label>
            <Input
              id="resolve-credit-note-reason"
              maxLength={REASON_MAX}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && ready) settle(true) }}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => settle(false)}>Cancel</Button>
          <Button type="button" disabled={!ready} onClick={() => settle(true)}>Resolve</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return { askResolveWithNote, resolveWithNoteDialog }
}
