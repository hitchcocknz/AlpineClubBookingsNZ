// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { useResolveWithNoteDialog, type ResolveWithNoteAnswer } from "../resolve-with-note-dialog"

/**
 * #4421 (owner decision 26 Oct 2026): "Resolve by hand" on a refund credit
 * note asks for the Xero note's number. The field is required: Resolve stays
 * disabled until it is filled, and the answer carries the number and reason.
 */
function Harness() {
  const { askResolveWithNote, resolveWithNoteDialog } = useResolveWithNoteDialog()
  const [answer, setAnswer] = useState<ResolveWithNoteAnswer | null | "pending">("pending")
  return (
    <div>
      <button type="button" onClick={() => void askResolveWithNote().then(setAnswer)}>open</button>
      <output data-testid="answer">{answer === "pending" ? "pending" : JSON.stringify(answer)}</output>
      {resolveWithNoteDialog}
    </div>
  )
}

describe("the refund credit note's resolve dialog (#4421)", () => {
  it("requires the Xero credit note number before Resolve can be pressed, then answers with it and the reason", async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText("open"))

    const resolveButton = await screen.findByRole("button", { name: "Resolve" })
    expect(resolveButton).toHaveProperty("disabled", true)
    expect(screen.getByText(/Give the number of the credit note you made for this refund in Xero/)).toBeDefined()

    fireEvent.change(screen.getByLabelText("Xero credit note number"), { target: { value: "  CN-0789 " } })
    expect(resolveButton).toHaveProperty("disabled", false)
    fireEvent.click(resolveButton)

    await waitFor(() =>
      expect(screen.getByTestId("answer").textContent).toBe(JSON.stringify({ creditNoteNumber: "CN-0789", reason: "Made the credit note by hand in Xero" })),
    )
  })

  it("answers null when cancelled", async () => {
    render(<Harness />)
    fireEvent.click(screen.getByText("open"))
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.getByTestId("answer").textContent).toBe("null"))
  })
})
