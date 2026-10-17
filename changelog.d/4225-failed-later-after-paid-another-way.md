- **A card refund the treasurer already paid back another way is no longer sent
  again when Stripe fails it later (#4210).** When the app asked Stripe for a
  card refund and Stripe's answer was lost, the treasurer could close the refund
  as "Paid another way" and pay the member by bank transfer. If the refund then
  reached the app (listed under "Card refunds paid back twice") and Stripe later
  reported it failed, the app raised a new card refund for it and sent it
  automatically, paying the member a second time.

  Such a failed refund is now treated as already settled by the close: no new
  refund is raised or sent, it is not counted under Refunds owed, and it leaves
  the paid-back-twice list. The officers are emailed once, saying not to pay the
  member again unless they had already asked them to return the extra, and the
  audit log records it under Payment. The member's booking page keeps saying the
  amount was paid back another way. A failed refund the close did not settle is
  still asked for again automatically, as before.
