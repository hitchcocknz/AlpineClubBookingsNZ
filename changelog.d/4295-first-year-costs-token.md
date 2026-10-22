- **A club's Join page can now show what it costs to join as one figure per kind
  of member (#4295).** Until now the page could only show the joining fee and
  the annual subscription in two separate blocks, and the visitor had to add
  them up. A new `{{first-year-costs}}` block shows the total directly: the
  joining fee plus the first year's subscription, for each publicly listed
  membership type and age group, for example "Adult $390, Youth $155, Family
  $500".

  The totals are worked out from the same fee schedules the invoicing uses, so
  they change by themselves on the day a new schedule takes effect, with nothing
  to edit. A family is shown as its joining fee plus its flat family
  subscription, so the family rule is whatever the club has set in the Fees
  screen and the page cannot disagree with the invoice. A group with no annual
  fee set is left out rather than shown at its joining fee alone, which would
  look like the whole cost. A subscription that is reduced for people joining
  part-way through the season is shown as "from".

  The block only appears when both the Joining fees and Annual membership fees
  visibility switches in Page Content are on. Nothing changes for a club that
  does not use the block, and nothing about invoicing or fees changes.
