- **A family whose subscription charge was closed as already paid, or voided
  in Xero, can now be billed again (#4110).** If a payment is reversed after a
  family's charge was closed as already paid, or Xero voided the family's
  invoice, the next billing preview now offers that family a new charge and
  confirming it works. Before, a closed family stayed listed as already billed
  even after a reversal, and confirming a voided family's re-bill failed the
  whole confirmation. Until a payment is reversed, a closed family still counts
  as billed, so a member who joins later is not invoiced for it. If only some
  members' payments were reversed, the preview shows a **Check before
  confirming** warning that confirming invoices the full family fee. The
  club's database gets one small change to allow this: a family can still have
  only one charge that is waiting to be invoiced or has been, per membership
  type and season.

  The Subscriptions page also offers **Close: already paid** only when every
  member on the charge has paid or is exempt (**Not required**). When only some have, the conflict message says
  to record the remaining payments and then close, or to reverse every payment
  and then Retry, because Retry alone would conflict again. If an invoice
  attempt was already in Xero at the moment a charge was closed, the charge now
  stays closed and names the invoice to void in Xero promptly, rather than
  reopening and emailing it; Xero Operations explains that operation the same
  way. A Retry that loses to a close says there is no work to do.
