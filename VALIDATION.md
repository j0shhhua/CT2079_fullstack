# Validation record

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
