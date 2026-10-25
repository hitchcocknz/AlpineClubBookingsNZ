# File-size allowances for #4220 (early warning, lane a)

file: src/app/(admin)/admin/xero/_components/health-diagnostics-panel.tsx
lines: 740
reason: one more stat card in the health grid (the grid already holds eight of
  the same shape, each a HealthStatCard with its own badge). The card is the
  decided place for the early-warning count; moving only this one out of the
  grid would leave eight siblings inline and one elsewhere with no rule saying
  which to follow.
