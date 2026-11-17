-- Follow-up for installations that already applied the original 001 migration.
-- Only the administrator's seeded email changed during the Eventease rename.
-- Match its exact fixture identity, not any account with the same email local part.
-- Accounts provisioned after 001 and the four original fixtures are not changed here.
with retired as (
  update users u set disabled=true
  where lower(u.email)='mei@eventease.sg'
    and u.referral_code='REF-MEI'
    and u.role='admin'
    and u.created_at <= (select applied_at from schema_migrations where name='001_security.sql')
  returning u.id
), closed_challenges as (
  update recovery_challenges set consumed_at=now()
  where consumed_at is null and user_id in (select id from retired)
  returning id
)
delete from browser_sessions where user_id in (select id from retired);
