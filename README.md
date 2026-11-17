# Eventease: secured working copy

Prepared from repository commit `281b46dbf6fd1815611c1bfd2522899f3d8dfee5`. The original archive is unchanged. This release is prepared for review on a separate branch; live deployment requires the configuration in DEPLOYMENT.md.

## Scope

Application and deployment hardening only. No SQL injection work, attack payloads, penetration tests, live account changes, or live payment calls were performed. Existing query parameterisation is retained. The new database migration supports sessions, payment jobs, and reservation consistency.

## Implemented changes

- Opaque HttpOnly, SameSite=Strict sessions replace frontend bearer tokens. Password changes revoke all account sessions; logout revokes account/order sessions on that browser.
- Order recovery requires a single-use emailed code, with a ten-minute expiry and five-attempt limit. Knowing the order ID and buyer email no longer returns tickets. Codes are HMAC protected and excluded from notification logs.
- Staff password sign-in also requires an emailed code. Ticket-changing actions require verification within the preceding fifteen minutes.
- Simulated methods require explicit opt-in outside production. Real payment uses Stripe-hosted Checkout, with the amount derived from database prices. Raw card data is not collected by this application.
- Orders and reservations are saved before payment. Durable jobs use stable provider idempotency keys, verified provider responses, signed webhooks, and background reconciliation. Failed refunds stay pending and are retried.
- Seat holds, checkout quantity, promo usage, and queue capacity are protected by database locks and constraints. Gate admission conditionally checks the QR version to prevent stale admission after transfer/resale. Event cancellation and start-time changes are blocked while payments are pending.
- Referral discounts remain available. Rewards require a verified first account purchase of at least S$10 and settle after the event. Cancellation reverses legacy rewards and adjusts redeemed/earned points.
- Production resale purchases are blocked because the original app has no seller payout integration. Local/staging resale workflows remain available. Stripe Connect/payout implementation is separate work.
- Sensitive APIs use no-store responses, exact-origin/custom-header checks, persistent targeted rate limits, and bounded field validation. Default database TLS verifies certificates.
- QR dependencies are self-hosted; executable-script CSP permits only this origin. The dependency lockfile and container runtime digest are committed in this deliverable.
- The migration disables the four original documented fixture accounts while preserving their records/events/orders. Demo seeding requires explicit opt-in and an operator-provided password; it is forbidden in production.
- Container port 3000 binds to loopback; nginx/CloudFront configuration and trusted-proxy settings are explicit. Production also requires a secret origin header. Deployments/migrations are serialized, and rollback to the old insecure application is refused.

## Run locally

Use Node 24 (container runtime is pinned) and PostgreSQL 15 or later. The application tests were run with Node 20.19.5 and disposable PostgreSQL 18.6; the container was not built on this computer because Docker is unavailable.

1. Run `npm ci --ignore-scripts`.
2. Copy `.env.example` to `.env`. Set a local database URL, exact APP_ORIGIN, and distinct random JWT_SECRET and QR_SECRET of at least 32 characters. The legacy JWT_SECRET name now protects verification codes. Do not commit `.env`.
3. Run `node --env-file=.env db/migrate.js`.
4. Configure an authorised SES sender and AWS region to use email recovery/staff login. AWS credentials come from the usual SDK credential chain/instance role. Recovery fails closed without mail configuration. Codes are never printed as a fallback.
5. Optionally enable `ALLOW_SIMULATED_PAYMENTS=true` for a local demo. Leave it false to disable simulated methods. Add Stripe test credentials/webhook configuration to use hosted test Checkout.
6. Run `node --env-file=.env src/server.js` and open the APP_ORIGIN URL.

For optional fixtures, set ALLOW_DEMO_SEED=true and DEMO_SEED_PASSWORD to an operator-chosen password (12+ characters, at most 72 UTF-8 bytes), then run `node --env-file=.env db/seed.js`. This is never a production setup step. The organiser and administrator fixture accounts still require email verification.

## Tests

Run `npm test`. Tests create a temporary PostgreSQL database bound to 127.0.0.1, synthetic accounts/orders, an in-memory mail sink, and a stub payment provider; then stop/delete the temporary database. They never use DATABASE_URL, SES, Stripe, or the deployed application. Embedded PostgreSQL binaries may need local process/socket permission; autoRehydrateSymlinks reconstructs the package's own links when needed.

Tests cover migrations and upgrades, cookie sessions, staff verification, guest recovery, password revocation, booking and request replay, pending/failed payments, interrupted finalisation, retryable refunds, transfer/resale, queue/reservations, QR admission, limited promos, referral settlement, and the changed frontend forms. These are local functional/regression checks, not penetration tests. Real Stripe/SES integration and nginx/Docker deployment still need ordinary staging verification with authorised test accounts.

## Before any deployment

Read `DEPLOYMENT.md`. The release deliberately refuses unsafe production configuration. Infrastructure settings and real secret/account changes require the person who controls your AWS and payment accounts. Nothing in this directory has applied those settings.

## Source layout

- `src/server.js`: existing application routes and application factory.
- `src/browser-security.js`: sessions, recovery, staff verification, origin checks, targeted limits.
- `src/commerce.js`: reservation, payment/refund lifecycle and reconciliation.
- `src/payment-provider.js`: explicit payment modes and hosted Stripe Checkout.
- `src/db-config.js`: certificate-verified database configuration.
- `db/migrations/001_security.sql`: upgrade state and constraints.
- `scripts/bootstrap-admin.js`: operator-only administrator provisioning/re-enablement.
- `deploy/`: hardened deployment script and nginx example.

## Event photos
Each event shows a placeholder illustration chosen by its category and id (public/img/ph-<category>-<0-3>.svg). Replace these files, or add an image column and upload flow, when real photos are available.
