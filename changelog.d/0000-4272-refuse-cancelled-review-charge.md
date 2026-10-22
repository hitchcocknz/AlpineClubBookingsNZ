- **A booking-change review can no longer ask a cancelled booking's member to
  pay (#4272).** When an officer settled a booking-change review as money owed
  to the club after the booking had been cancelled, and the booking still held
  money paid by card, the system created a card payment request the member
  could never pay: every place a member pays leaves cancelled bookings out.
  The task still read as completed, so the treasurer saw a charge that would
  never be collected.

  The officer now sees a clear refusal instead, and the task stays open:
  collect the amount another way, then dismiss the task with a note recording
  what was collected and how. Reviews on bookings that are not cancelled are
  unchanged.
