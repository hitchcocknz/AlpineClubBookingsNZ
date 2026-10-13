# File-size allowances for #4102 (PR #4117)

The rule of what an approved refund request still owes after its inline card
refund lives in `inlineRefundAfterAttempt` (`refused-card-refund-retry.ts`) and
`queueUnmadeRefundRequestCardRefund` (`refund-request-card-refund.ts`), and the
screen's wording in `refund-request-card-refund-copy.ts`; the approve route did
not grow. What stays in the page is where it renders them.

file: src/app/(admin)/admin/refund-requests/page.tsx
lines: 924
reason: the approved appeal's Refunded figure and its "queued for retry" line
  sit in the card's existing outcome block, and the approval toast reads the
  route's answer where the toast is raised; the figures and the wording come
  from the shared copy module, so only the two render sites are here.
