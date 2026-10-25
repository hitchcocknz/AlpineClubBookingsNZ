# File-size allowances for #4378 (#4253 release 2)

Every new rule lives in its own module (`additional-ask-cause.ts`,
`credit-release-bank-transfer.ts`, the cadence in the chase module); the reminder
cron was kept under its budget by moving the finished-stay narrowing out. The
three files below grow by the registration of one optional email token and the
sender's choice between wordings.

file: src/lib/email-message-registry.ts
lines: 2390
reason: the new optional `bankTransferNote` token is an entry in the registry's
  optional-token list and its sample resolver; a token not in them is rejected by
  the registry's own census.

file: src/lib/email-message-token-contract.ts
lines: 726
reason: the token contract table is where optional tokens are declared; one entry
  for the same token.

file: src/lib/email/booking.ts
lines: 1836
reason: the payment-request sender picks the wording and the bank-transfer offer
  by the request's cause. A second sender would duplicate the 60-minute stamp and
  cooldown handling that the cron and the manual re-send rely on being in one place.
