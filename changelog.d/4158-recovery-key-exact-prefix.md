- **Key-prefix lookups now match their prefix literally (#4146).** Prisma's
  `startsWith` runs as SQL `LIKE`, where `_` matches any character, so a lookup
  whose prefix carried an id could read a row belonging to a different booking,
  payment or group settlement whose id differed only at that position. The
  duplicate-capture refund check, a group settlement's organiser hand-back
  tasks, the retirement of a payment's pending refund credit note, and the
  admin Xero force-sync's member and booking id lookup now escape the prefix
  through one helper (`exactPrefix`), and the duplicate-capture check is also
  scoped to its booking. A real-PostgreSQL test pins both the wildcard and the
  fix.
