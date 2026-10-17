import { expect, test } from "@playwright/test";

import { formatBookingReference } from "../src/lib/booking-reference";
import { storageStatePath } from "./helpers/auth";
import { BANK_REFUND_VOID_BOOKING_IDS, E2E_ADMIN } from "./helpers/fixtures";

test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

/**
 * #4162 (owner decisions 16 and 17 Oct 2026): a voided bank-transfer refund
 * note is listed on Stuck States and answered there. Confirm with "Replaced by
 * hand in Xero" moves no money, so the journey is list -> confirm -> the row
 * leaves.
 *
 * An answer is final and the suite seeds once per run, so each attempt answers
 * its OWN seeded note (`testInfo.retry` picks it): a retry never meets the row
 * its earlier attempt cleared (docs/E2E_PLAYWRIGHT.md, flake invariant 1).
 */
test("a treasurer confirms a voided bank-transfer refund note replaced in Xero, and its row leaves the list", async ({
  page,
}, testInfo) => {
  const bookingId = BANK_REFUND_VOID_BOOKING_IDS[Math.min(testInfo.retry, BANK_REFUND_VOID_BOOKING_IDS.length - 1)]!;
  const reference = formatBookingReference(bookingId);

  await page.goto("/admin/stuck-states");
  const panel = page.locator("#bank-refund-voids");
  await expect(panel.getByRole("heading", { name: "Bank-transfer refunds with a voided credit note" })).toBeVisible();
  const row = panel.getByRole("listitem").filter({ hasText: `Booking ${reference}` });
  await expect(row).toHaveCount(1);
  const confirm = row.getByRole("button", { name: "Confirm the voided refund note" });
  await expect(confirm).toBeEnabled();

  await confirm.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Clear this voided refund note?" })).toBeVisible();
  await dialog.getByRole("radio", { name: /Replaced by hand in Xero/ }).check();
  await dialog.getByLabel("Reason (required)").fill("Replaced in Xero by hand during the E2E run");
  await dialog.getByRole("button", { name: "Confirm" }).click();

  await expect(panel.getByRole("status").filter({ hasText: `booking ${reference} was cleared` })).toBeVisible();
  await expect(row).toHaveCount(0);
});
