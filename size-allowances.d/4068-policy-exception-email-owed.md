Policy-exception approval email now reads the amount owed through the one home
(`INV-PAY-119`) instead of the bare price (#4058).

file: src/lib/booking-exception-approval.ts
lines: 1255
reason: The change is a dozen lines inside `notifyApproved`, which belongs beside the approval flow that creates the booking it describes; splitting this 1,200-line module is its own refactor and unrelated to the bug.
