import type { Page, Response } from "@playwright/test";

const WIZARD_PROGRESS_PATH = "/api/admin/integrations/wizard-progress";

/**
 * Resolves with the response to the integration wizard's save of `stepId` as
 * its resume cursor (`POST /api/admin/integrations/wizard-progress`). Call it
 * BEFORE the click that moves the wizard onto `stepId`, and await it before the
 * page navigates away.
 *
 * A spec that leaves the page from a wizard step (the Xero Connect step's OAuth
 * round-trip) comes back to whatever step the server has stored, and the shell
 * saves that cursor fire-and-forget (#4014). Waiting here is the precondition a
 * real operator meets by taking more than a few milliseconds to press Connect;
 * without it the post-OAuth page can read the cursor before the save of the
 * step the spec left from has landed. The caller asserts the response is OK, so
 * a failed save fails loudly rather than as a later timeout.
 */
export function wizardCursorSave(
  page: Page,
  wizardId: string,
  stepId: string,
): Promise<Response> {
  return page.waitForResponse(
    (response) => {
      const request = response.request();
      if (request.method() !== "POST") return false;
      if (new URL(response.url()).pathname !== WIZARD_PROGRESS_PATH) return false;
      const body = request.postDataJSON() as {
        wizardId?: unknown;
        currentStepId?: unknown;
      } | null;
      return body?.wizardId === wizardId && body?.currentStepId === stepId;
    },
    { timeout: 15_000 },
  );
}
