# Validation record

Date: 18 November 2026 (Singapore).

- 36 local functional/regression checks passed; 0 failed. This includes the original 22 checks and 14 added checks for the priority fixes.
- Checked application/utility JavaScript syntax and deployment shell syntax.
- Verified both a fresh database migration and upgrading an existing synthetic database. Repeated migration runs preserved existing synthetic events and applied the security migration once.
- Local runtime: Node 20.19.5; temporary PostgreSQL 18.6 bound to 127.0.0.1. The Docker image is pinned to an official Node 24 image digest.
- Mail and payments used local stubs. Provider adapter tests verified stable request keys, hosted-checkout amount construction, and refund reference reuse without contacting Stripe.
- Frontend forms were checked using jsdom. A local browser preview also confirmed the persistent classroom demo notice, practice-booking copy, future-only catalogue and closed-booking screen for a past event. No claim is made of visual QA across all devices.
- No SQL injection work or penetration testing was performed. No live application/database, SES delivery, Stripe charge/refund, AWS setting, or deployment was changed.
- Docker/nginx builds and real SES/Stripe integrations were not run on this computer. Required staging/configuration steps are in DEPLOYMENT.md.

The added checks cover explicit hosted demo mode without Stripe, rejected Stripe credentials in demo mode, Secure/HttpOnly cookies and origin verification in hosted demo mode, disabled resale, past-event discovery and closed links, already-applied migration 001 upgrades, record preservation, migration idempotence, and five deployment control-flow cases using disposable command doubles. The original pending-payment event-change regression remains covered.

Deployment tests do not run Docker or sudo. They verify sequencing, both old/new container names, preflight failures before downtime, migration failures, rollback on startup failure, and avoiding an incompatible rollback image. The first explicit-demo transition still needs a reviewed recovery image or restoration plan on the real host.

The original ZIP remains unchanged. Infrastructure configuration, account credential changes, and deployment remain operator actions.
