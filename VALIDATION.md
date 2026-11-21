# Validation record

## Organiser approval update — 21 November 2026

- 43 automated checks passed; 0 failed: 30 account/booking workflow checks, 11 frontend checks and 2 payment adapter checks.
- Complete suite run on Node 24.22.3, matching the deployed container's Node major version, with a temporary PostgreSQL database bound to 127.0.0.1 and a simulated email sender.
- Added coverage for pending organiser registration/login, approval followed by email-code login, duplicate registrations, explicit customer applications with preserved history, revoked approval and sessions, disabled accounts, approval permissions, concurrent registration/login/application, email delivery failures and same-name applicant identification.
- Existing booking, payment, refund, recovery, queue, QR and migration regressions remain passing. The new operator approval command uses the same tested approval transition as the administrator page.
- No live accounts, live database, AWS settings, deployment, real email delivery or real payments were changed or exercised. Real SES delivery and deployment acceptance checks remain with the hosting administrator; see [Organiser registration and approval](ORGANISER-APPROVAL.md).
- No new dependency or database schema changes are required beyond the existing security migration. Deploy the backend and frontend together.

## Previous security release

Date: 16 November 2026 (Singapore).

- 22 local functional/regression checks passed; 0 failed.
- Checked JavaScript syntax in 10 application/utility files and deployment shell syntax.
- Verified both a fresh database migration and upgrading an existing synthetic database. Repeated migration runs preserved existing synthetic events and applied the security migration once.
- Local runtime: Node 20.19.5; temporary PostgreSQL 18.6 bound to 127.0.0.1. The Docker image is pinned to an official Node 24 image digest.
- Mail and payments used local stubs. Provider adapter tests verified stable request keys, hosted-checkout amount construction, and refund reference reuse without contacting Stripe.
- Frontend forms were checked using jsdom. No claim is made of visual browser QA across all devices.
- No SQL injection work or penetration testing was performed. No live application/database, SES delivery, Stripe charge/refund, AWS setting, or deployment was changed.
- Docker/nginx builds and real SES/Stripe integrations were not run on this computer. Required staging/configuration steps are in DEPLOYMENT.md.

The final regression also verifies that event cancellation/rejection and organiser start-time changes are blocked during pending payment, then become available after settlement.

The original ZIP remains unchanged. Infrastructure configuration, account credential changes, and deployment remain operator actions.
