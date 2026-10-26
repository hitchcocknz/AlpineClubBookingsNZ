- **A club can now stop the booking system connecting to its database as the
  all-powerful administrator, so the system itself can no longer rewrite the
  booking ledger or the audit log (#4453).** Until now every part of the
  system signed in to the database with the same superuser account, the one
  that can do anything. A fault, or a stolen copy of the system's password,
  could therefore change or delete any record, including the money ledger
  behind every booking and the audit trail of who did what.

  An operator can now split that one account into separate roles. A
  migration role owns the database structure and applies upgrades. The
  application role can add and read ledger lines and audit entries, but can
  never change or delete them. A small audit-retention role does the nightly
  clean-up of old audit entries and nothing else. The administrator account is
  kept for people. A new command, `pnpm run db:provision-roles`, sets the roles
  up: it only shows what it would do unless it is run with `--apply`, and it
  checks its own work and undoes everything if the result is wrong.

  Nothing changes until a club opts in. The new settings (`APP_DB_USER`,
  `MIGRATION_DB_USER`, their passwords and `AUDIT_RETENTION_DATABASE_URL`) are
  empty by default, and with them empty the system connects exactly as before.
  Switching over and back is an ordinary blue/green deploy; `DEPLOYMENT.md`
  ("Least-privilege database roles") and `docs/UPGRADING.md` give the steps.
  Once a club switches, nightly backups keep working, but restoring a backup
  over the live database from the Backups admin page is refused: an operator
  restores with the database tools instead. This replaces the July 2026
  decision (#2240) to keep the single administrator account.
