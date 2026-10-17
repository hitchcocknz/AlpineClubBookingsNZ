// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canEdit: true as boolean | undefined,
  refresh: vi.fn(),
  toastSuccess: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: vi.fn() } }));
vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/hooks/use-admin-area-edit-access")),
  useAdminAreaEditAccess: () => mocks.canEdit,
}));

import { BankRefundVoidsPanel, type BankRefundVoidPanelRow } from "@/components/admin/bank-refund-voids-panel";
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action";
import { CONFIRM_REASON_COPY, RE_RECORD_REFUSAL_MESSAGES } from "@/lib/bank-refund-void-copy";
import { describeRefundMethod } from "@/lib/xero-refund-method";

/**
 * #4162 (owner decisions 16 and 17 Oct 2026): the Stuck States panel for
 * voided bank-transfer refund notes. The writers' rules are the server's
 * (`bank-refund-void-resolution.realdb.test.ts`); this pins what the treasurer
 * sees and sends.
 */

const BANK_NOTE_WORDING = describeRefundMethod("internet-banking");

function row(overrides: Partial<BankRefundVoidPanelRow> = {}): BankRefundVoidPanelRow {
  return {
    linkId: "link-1",
    bookingId: "b-1",
    bookingReference: "BK-0001",
    voidedCreditNoteId: "cn-1",
    voidedCreditNoteNumber: "CN-0042",
    amountCents: 20_000,
    voidedAt: "2026-06-20T00:00:00.000Z",
    liveNotes: [],
    flag: null,
    reRecordOf: null,
    reRecordRefusal: null,
    answerable: true,
    retryable: false,
    ...overrides,
  };
}

function respond(status: number, body: unknown) {
  mocks.fetch.mockResolvedValueOnce({ ok: status >= 200 && status < 300, status, json: async () => body });
}

function renderPanel(rows: BankRefundVoidPanelRow[] = [row()]) {
  return render(<BankRefundVoidsPanel rows={rows} bankNoteWording={BANK_NOTE_WORDING} />);
}

const reRecordButton = () => screen.getByRole("button", { name: "Record the refund for booking BK-0001 again" });
const confirmButton = () => screen.getByRole("button", { name: "Confirm the voided refund note for booking BK-0001" });
const reasonBox = () => screen.getByLabelText("Reason (required)") as HTMLTextAreaElement;

beforeEach(() => {
  mocks.canEdit = true;
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("the voided bank-transfer refund panel", () => {
  it("shows each voided note's amount and the payment's live notes, so a note replaced in Xero is seen (Q4)", () => {
    renderPanel([row({ liveNotes: [{ creditNoteId: "cn-2", creditNoteNumber: "CN-0099", amountCents: 20_000 }] })]);

    expect(screen.getByText("Bank-transfer refunds with a voided credit note")).toBeInTheDocument();
    expect(screen.getByText(/\$200\.00 refund/)).toBeInTheDocument();
    expect(screen.getByText(/Xero voided credit note CN-0042/)).toBeInTheDocument();
    expect(screen.getByText("Live refund credit notes on this payment: CN-0099 ($200.00).")).toBeInTheDocument();
  });

  it("records again for the voided note's amount, read-only, with the reason and the figure it showed (Q1)", async () => {
    renderPanel();
    fireEvent.click(reRecordButton());
    expect(screen.getByText("Booking BK-0001: $200.00, from credit note CN-0042.")).toBeInTheDocument();
    // No amount box: the amount is the voided note's.
    expect(screen.queryByRole("textbox", { name: /amount/i })).not.toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "Record again" });
    expect(submit).toBeDisabled();

    fireEvent.change(reasonBox(), { target: { value: "Paid by bank on 2 June" } });
    respond(200, { success: true });
    fireEvent.click(screen.getByRole("button", { name: "Record again" }));

    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe("/api/admin/payments/bank-refund-voids/link-1/re-record");
    expect(JSON.parse(init.body)).toEqual({ expectedAmountCents: 20_000, note: "Paid by bank on 2 June", confirmed: true });
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("confirms only once a reason is chosen, and sends it (Q2, Q4)", async () => {
    renderPanel();
    fireEvent.click(confirmButton());
    fireEvent.change(reasonBox(), { target: { value: "Replaced by CN-0099" } });
    expect(screen.getByRole("button", { name: "Confirm" })).toBeDisabled();

    // Each reason says what it does (owner, 17 Oct 2026).
    expect(screen.getByText(CONFIRM_REASON_COPY.cancelled.help)).toBeInTheDocument();
    expect(screen.getByText(CONFIRM_REASON_COPY["replaced-in-xero"].help)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Replaced by hand in Xero/ }));
    respond(200, { success: true });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe("/api/admin/payments/bank-refund-voids/link-1/confirm-cancelled");
    expect(JSON.parse(init.body)).toEqual({
      reason: "replaced-in-xero",
      expectedAmountCents: 20_000,
      note: "Replaced by CN-0099",
      confirmed: true,
    });
  });

  it("shows a refusal in the dialog and refreshes the list on a 409", async () => {
    renderPanel();
    fireEvent.click(reRecordButton());
    fireEvent.change(reasonBox(), { target: { value: "x" } });
    respond(409, { error: "The voided note's amount changed since you opened it." });
    fireEvent.click(screen.getByRole("button", { name: "Record again" }));

    expect(await screen.findByText("The voided note's amount changed since you opened it.")).toBeInTheDocument();
    expect(mocks.refresh).toHaveBeenCalled();
  });

  it("refuses record-again where the list says why, and an unknown amount takes neither answer", () => {
    renderPanel([row({ reRecordRefusal: "note-in-flight" })]);
    expect(reRecordButton()).toBeDisabled();
    expect(confirmButton()).toBeEnabled();
    expect(screen.getByText(RE_RECORD_REFUSAL_MESSAGES["note-in-flight"])).toBeInTheDocument();
    cleanup();

    renderPanel([row({ amountCents: null, reRecordRefusal: "amount-unknown" })]);
    expect(screen.getByText(/amount unknown/)).toBeInTheDocument();
    expect(reRecordButton()).toBeDisabled();
    expect(confirmButton()).toBeDisabled();
  });

  it("flags a record-again whose note failed, with no answer offered, and a note voided again with the one it replaced", () => {
    renderPanel([
      row({ flag: "note-failed", answerable: false, retryable: true }),
      row({ linkId: "link-2", bookingReference: "BK-0002", flag: "voided-again", reRecordOf: "cn-original" }),
    ]);
    expect(screen.getByText(/Recorded again, but its fresh credit note did not reach Xero for the full amount/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record the refund for booking BK-0001 again" })).not.toBeInTheDocument();
    expect(screen.getByText("This note recorded cn-original again, and Xero voided it too.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record the refund for booking BK-0002 again" })).toBeEnabled();
  });

  it("retries a failed record-again's note with an optional note, under the retry route (owner, 17 Oct 2026)", async () => {
    renderPanel([row({ flag: "note-failed", answerable: false, retryable: true })]);
    fireEvent.click(screen.getByRole("button", { name: "Retry the credit note for booking BK-0001" }));
    expect(screen.getByText(/under the same key/)).toBeInTheDocument();
    respond(200, { success: true });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
    const [url, init] = mocks.fetch.mock.calls[0]!;
    expect(url).toBe("/api/admin/payments/bank-refund-voids/link-1/retry-re-record");
    expect(JSON.parse(init.body)).toEqual({ note: "", confirmed: true });
  });

  it("is view-only without finance:edit: the banner says why, and no answer can be given", () => {
    mocks.canEdit = false;
    renderPanel();
    expect(reRecordButton()).toBeDisabled();
    expect(confirmButton()).toBeDisabled();
    expect(screen.getByText(`${ADMIN_VIEW_ONLY_SECTION_HEADING}.`)).toBeInTheDocument();
  });
});
