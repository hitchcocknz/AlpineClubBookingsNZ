- **A booking edit's price breakdown now adds up to the price it quotes
  (#4197).** When a member or officer edits a booking, the line explaining a
  date or guest-stay change was worked out separately from the quoted total:
  it treated each guest's stay as one unbroken run of nights at today's rates.
  A guest with gaps in their nights, or nights already paid at an earlier
  price, could therefore be shown a different amount from the real change. The
  line, and each added guest's line, now come from the same pricing the total
  uses, guest by guest, so they always add up to it. A guest whose dates look
  the same but whose nights change, such as one whose gap is filled, now gets
  the line too. The amount charged is unchanged.
