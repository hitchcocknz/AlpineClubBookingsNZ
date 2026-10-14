- **A refund appeal can no longer be approved against money a card refund
  still owes (#4124).** When the card provider refused a card refund, or it
  failed after being accepted, the money stays owed and the app keeps retrying
  it. But it had dropped out of the payment's refunded total, so the most an
  appeal could refund rose by the same amount, and approving one could return
  that money twice. The appeal limit now subtracts card refunds still owed, as
  **Refunds owed** counts them: on the approval itself, on the member's
  request, on reopening a dismissed appeal, and on the figures the booking page
  and the refund-requests screen offer.
