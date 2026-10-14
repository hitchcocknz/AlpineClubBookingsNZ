- **The booking-ledger census now explains a refund appeal paid back after a
  cancellation (#4120).** An approved refund appeal gives the member back more
  than the cancellation kept, and no charge line on the ledger says so. So once
  any appeal was paid back, by card or by bank transfer, the census reported
  the cancelled booking as an unexplained difference. It now names it
  `REFUND_APPEAL_PAID`, sized from what each approved appeal has actually
  refunded: the same figure the refund-requests screen shows as "Refunded". An
  appeal not yet paid, dismissed or declined explains nothing, and nor does one
  paid for a different amount than the ledger shows, so those still read as
  differences. An appeal's own bank-transfer task is also no longer counted as
  the cancellation's own refund in flight or kept. The census reads only; no
  money, ledger line or Xero note changes.
