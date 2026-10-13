- **A subscription charge stuck because its members had already paid can now
  be closed (#4098).** When a member is marked paid (usually for cash) after
  their annual charge was queued, the charge correctly raises no Xero invoice and
  shows a conflict on the Subscriptions page, but **Retry** could never clear it,
  so it stayed there for good.

  Admins with finance edit access now get **Close: already paid** on such a
  charge. It asks for a short reason, checks that every member the charge covers
  is still paid, and then marks the charge **Not required**: no invoice is
  raised for it, and the close is recorded in the audit log, under the payment
  category, with who did it and why. Closing twice does nothing more. If a payment was recorded by mistake,
  use **Mark as unpaid** and then **Retry** instead. The conflict message now
  names those two choices rather than an action that did not exist.
