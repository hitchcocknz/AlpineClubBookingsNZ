- **Guided setup wizards reopen on the step you actually left from (#4014).**
  The Xero, Stripe, Google and Lobby Display setup wizards remember which step
  you were on, so a reload or a return from a provider's sign-in page picks up
  where you were. Moving through two steps quickly could save those positions
  out of order, so the Xero wizard could come back from connecting on the
  credentials step instead of the connection confirmation.

  The wizard now saves its position one step at a time, so the last step you
  reached is always the one it reopens on. Nothing about what each step checks
  has changed.
