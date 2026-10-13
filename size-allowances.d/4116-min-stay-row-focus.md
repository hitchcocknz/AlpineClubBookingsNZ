# File-size allowances for #4116

file: src/components/admin/booking-policies/minimum-night-stay-section.tsx
lines: 858
reason: the row Activate/Deactivate and Delete handlers live here and must
  capture and close the focus return around their own refresh; the return
  itself lives in use-row-action-focus-return.ts, shared with booking periods,
  so what stays here is one call per open and close plus the trigger markers.
