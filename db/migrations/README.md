Add new database changes as new numbered SQL files. Each filename runs once, in name
order, and is recorded in `schema_migrations`. Never edit a migration that has already
been applied: existing installations will skip it. Prefer additive changes and review
compatibility before allowing an older application release to start.

`001_security.sql` is restored to the original reviewed release. It disables the four
original documented fixture identities while preserving their events and orders.

`002_retire_renamed_fixture.sql` handles the administrator fixture renamed from
`mei@eventeaseplus.sg` to `mei@eventease.sg`. It matches the exact email, referral code
and administrator role, and only accounts created before migration 001 was applied.
It also revokes that account's sessions and pending verification challenges. Matching
arbitrary email domains or names could disable an unrelated account, so those are not
used as automatic cleanup rules.

The follow-up does not touch the original four identities again, preserving accounts
that an operator deliberately reviewed and re-enabled after migration 001. If the
renamed administrator fixture was deliberately reviewed and re-enabled before this
follow-up, review it with the hosting operator before upgrading. Existing records do
not contain a password-reset/review timestamp that can reliably distinguish that case.
Use `scripts/bootstrap-admin.js` after migration to provision a separate reviewed
administrator; do not restore the old shared fixture credentials.
