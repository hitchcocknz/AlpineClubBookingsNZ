- **Test harness: one database-name guard for every real-database race suite
  (#4142).** One suite kept its own stricter copy of the guard and refused a
  throwaway database that every other suite accepts. Developer tooling only.
