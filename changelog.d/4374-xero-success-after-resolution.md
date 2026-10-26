- **Officers are told when Xero records a document after they resolved its
  operation by hand (#4374).** Two attempts at the same Xero call can share one
  operation. If one failed, an officer marked the operation resolved in Xero and
  made the document by hand, and the other attempt's call then succeeded, Xero
  could end up holding the document twice and nobody was told.

  The late success is still recorded, with its Xero links, and the operation
  stays marked resolved. The finance contacts now get one **Xero Sync Error**
  email per operation saying so, naming what the app recorded in Xero. If the
  same document was also made by hand, void the duplicate in Xero.
