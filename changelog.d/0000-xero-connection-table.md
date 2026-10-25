- **The Xero connection has its own table, with no secret in it (#3806).**
  Whether Xero is connected, to which organisation, and the lock that stops two
  servers refreshing the same Xero sign-in at once now live in a small table of
  their own. The Xero sign-in tokens stay in the encrypted credential store,
  which is now the only copy the app reads. The old token table is kept up to
  date for the previous release during an upgrade and is removed in a later
  release.

  Nothing changes for administrators. A Xero connection made before the Xero
  tokens moved into the credential store, and never used since, shows as
  "reconnect required" after this upgrade; reconnecting from Admin → Xero fixes
  it. The upgrade notes say how to check for that before deploying.
