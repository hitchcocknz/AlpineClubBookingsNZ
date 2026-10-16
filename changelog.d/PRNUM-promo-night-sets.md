- **The promo code box prices the nights a guest actually stays (#4199).** When
  a booking uses the night-by-night grid, a guest can stay, say, the 10th and
  12th but not the 11th. The promo code box, on the booking editor and in the
  new-booking wizard, used to work out the discount as if that guest stayed all
  three nights, so it could show a bigger discount than the price summary
  beside it. It now uses the same nights as the price summary and the save.

  What a member is charged does not change: that always came from the price
  summary. When the grid is off and a guest has their own Date In and Date Out,
  the box still prices those dates as one continuous stay, as before.
