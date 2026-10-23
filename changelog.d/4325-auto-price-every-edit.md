- **Every booking change is now priced automatically, and none is sent to an
  officer to work out (#4317).** Until now, a change to a booking whose records
  did not say clearly what each night was sold for — usually an older booking,
  or one created from a public request — was saved, but its money was held in
  **Refunds & Adjustments** for an officer to price by hand. The booking's total
  stayed frozen meanwhile, the member was told the club was checking, and any
  further price change to the booking was refused until the review was settled.

  Every change is now priced the moment it is saved, on every route: the
  booking edit, a date change, adding a guest, taking a guest off, a change
  during the stay, and the re-price when an invited guest accepts. Nights a
  guest keeps keep their price; nights given back are credited at what they
  were sold for; taking a guest off credits everything stored for that guest;
  nights added are charged at today's prices; and the club's normal change fee
  applies. Where the records do not say what each night sold for on its own, the
  guest's stored total is shared across their nights — nights with a recorded
  price keep it and the rest is split evenly — so the credits always add up to
  exactly what the guest was charged. The quote on **Edit Booking** is exactly
  what saving charges or credits, and the booking ledger and Xero lines follow
  the same figures.

  A guest whose stored total is below zero, which the system should never hold,
  has their nights counted at $0.00 and the booking is logged for the club to
  correct; the change still saves. An other-club member rate can now be set on
  any booking that could not be re-rated before.

  Reviews already open in **Refunds & Adjustments** stay there and are settled
  as before; while one is open, its booking still refuses a further price
  change. A later release settles the remaining reviews and retires those
  screens. This release must not be deployed until the night-price backfill has
  been run on production.
