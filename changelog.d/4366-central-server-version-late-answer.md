- **A slow answer from an old Alpine Central Server connection can no longer
  overwrite the new one's version (#4366).** When you replaced the server's API
  key or address while a check was still in flight, the old connection's late
  answer could be recorded as the new server's version. That could wrongly
  allow or block the Other Lodges and club-post features until the next check.
  This could happen even if you changed the key and then changed it back.

  Each answer is now recorded only if the address and the saved key it was
  sent with are still the ones stored. Otherwise it is dropped, and the next
  check asks the current server. You do not need to do anything.
