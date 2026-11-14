# Eventeaseplus: full website (frontend + API + database)

Node 20 + Express API on PostgreSQL that also serves the website (`public/`: `index.html`, `app.css`, `app.js`, no build step). One process, one URL. It implements every feature in the website demo: events and filters, seat holds, guest and customer checkout, QR tickets with signed codes, cancellation and refunds, transfer and resale, promo/referral/loyalty, smart queue, notifications, organiser dashboard with forecast, admin panel, fraud flags and gate scanning.

## Run locally

```bash
cp .env.example .env            # fill JWT_SECRET, QR_SECRET, DATABASE_URL
npm install
npm run migrate                 # creates the 12 tables (db/schema.sql)
npm run seed                    # optional demo data, password Passw0rd! (demo only)
# export the variables from .env (or use your shell/IDE), then:
npm start
# open http://localhost:3000   (set DEMO_LOGINS=true to see the seeded demo logins on the login page)
curl localhost:3000/health
```

## How the hard parts work

| Concern | Approach |
|---|---|
| No double-selling | Partial unique index `tickets(event_id, seat)` for valid/used tickets. Even if two checkouts race, the database rejects the second. |
| Seat holds | `seat_holds` rows with an expiry (default 8 minutes, admin-editable). No Redis needed. |
| Guests | Browser generates a random `X-Guest-Token` (16+ chars). Checkout needs name and email. After payment the API returns an `orderToken`; later, `POST /api/orders/lookup` with order number and email returns a fresh one. |
| QR codes | `EE.<ticketId>.<version>.<HMAC>`. Transfer and resale bump the version, so the old QR stops working. Forged scans create a fraud flag. |
| Smart queue | Admin turns on `highDemand` for an event. Buyers join `/queue`; each poll admits the next batch (20) for 10 minutes. Seats and holds require admission. |
| Payments | Simulated by default (send `paymentToken: "decline"` to test a failure). Set `STRIPE_SECRET_KEY=sk_test_...` and send a Stripe `pm_...` token for real test-mode charges. |
| Notifications | Always written to `notifications`. Email goes through SES when `SES_FROM` is set; SMS through SNS when `SMS_ENABLED=true`. WhatsApp is logged only until you connect a provider. |

## API summary

Public: `GET /api/events`, `GET /api/events/:id`, `GET /api/events/:id/seats`, `POST|GET /api/events/:id/queue(/join)`, `PUT /api/events/:id/holds` (body `{seats:[...]}`, replaces your whole hold set), `POST /api/checkout`, `POST /api/orders/lookup`, `POST /api/resale/:id/buy`.
Order access (login or `X-Order-Token`): `GET /api/orders/:id`, `POST /api/orders/:id/cancel`, `POST /api/tickets/:id/transfer`, `POST /api/tickets/:id/resale`, `DELETE /api/resale/:id`.
Customer: `GET /api/orders/mine`, `GET /api/me`, `GET /api/notifications`.
Organiser: `POST|GET /api/organiser/events`, `POST /api/gate/scan` (also admin).
Admin: `/api/admin/summary | organisers | events | fraud | settings | reminders`.
Demo logins after `npm run seed`: ava.tan@mail.sg (customer), raj@harbourlive.sg (organiser), mei@eventeaseplus.sg (admin).

## Free-tier AWS plan (Singapore, ap-southeast-1)

AWS changed its free tier for accounts created on or after 15 July 2025: you get a Free plan with credits (reported as up to $200, lasting up to 6 months), and EC2, RDS and API Gateway only count as "free tier eligible", meaning their usage is paid from those credits. About 30 services stay always free within monthly limits, for example Lambda (1M requests) and DynamoDB (25 GB). Older accounts still follow the 12-month model (750 hours of EC2 and RDS micro instances). Check your own Billing console, because that decides which applies to you.

Recommended set, chosen so this exact code runs unchanged:

| Piece | Service | Cost note |
|---|---|---|
| API | One EC2 `t3.micro` running the Docker image | Free-tier eligible (credits or 750 h on older accounts) |
| Database | RDS PostgreSQL `db.t3.micro`, single-AZ, 20 GB, private subnet | Free-tier eligible; keep Multi-AZ off |
| Website | Served by the API itself (`public/`), so no separate hosting. Optional: S3 for the static files | CloudFront has an always-free allowance |
| HTTPS and one URL | CloudFront with the EC2 instance as its only origin | Free certificate via ACM; everything is same-origin so no CORS setup |
| Secrets | SSM Parameter Store, SecureString | Standard parameters are free; Secrets Manager is not |
| Logs and alarms | CloudWatch (basic) plus a billing budget alert | Within free allowances at demo traffic |
| Email | SES, verify one sender (sandbox) | Very low cost; confirm current free allowance |
| Reminders | A cron job on the server that calls `POST /api/admin/reminders` with `X-Cron-Secret` once a day | Free |

Avoid these because they are not free: NAT Gateway, ElastiCache (the code does not need Redis), Application Load Balancer (CloudFront replaces it), RDS Multi-AZ, SNS SMS, and a public IPv4 address you leave unattached.

Setup order:
1. Create an AWS Budget alert first (for example $5), then enable MFA on the root user.
2. VPC: use the default VPC. Security group `api-sg` allows 80/443 from CloudFront (or 3000 from anywhere while testing); `db-sg` allows 5432 only from `api-sg`.
3. RDS: PostgreSQL 16, `db.t3.micro`, single-AZ, not publicly accessible, automated backups on (7 days). Create database `eventeaseplus`.
4. EC2: Amazon Linux 2023, `t3.micro`, install Docker, build or pull the image, run with `--env-file`. Run `npm run migrate` once from the container (`docker run --env-file .env <image> node db/migrate.js`).
5. CloudFront: origin = the EC2 public DNS (HTTP on port 3000, or put nginx on 80 in front). Forward the `Authorization`, `X-Guest-Token`, `X-Order-Token` and `X-Cron-Secret` headers and disable caching for `/api/*` (you can cache `/app.js` and `/app.css`).
6. Set `DB_SSL=true`, leave `CORS_ORIGINS` blank and `DEMO_LOGINS=false`, and use strong random `JWT_SECRET`, `QR_SECRET`, `CRON_SECRET` (`openssl rand -hex 32`).
7. SES: verify a sender address, set `SES_FROM`, and give the EC2 instance role `ses:SendEmail`. Do not put AWS keys in `.env`.

When credits end or the Free plan expires, either upgrade to the Paid plan or shut RDS and EC2 down. Expect roughly the price of one micro instance plus one micro database per month afterwards.

## Known limits

- The website was tested in a browser against a stand-in API that follows the same request and response shapes (guest and customer checkout, filters, promo, queue, Find my order, mobile layout). The real Express + PostgreSQL server could not be run where this was built (no package installs), so run through each flow once on your machine before deploying.
- Organiser, admin and gate screens, transfer, resale and cancellation are wired to the API but were not browser-tested.

- Not load-tested; the Postgres-based holds suit demo traffic (hundreds of buyers), not a stadium on-sale.
- Charging happens inside the database transaction. If the process dies after a Stripe charge but before commit, refund manually.
- Resale pays the seller nothing automatically (simulated); real payouts need Stripe Connect or similar.
- WhatsApp needs a provider such as WhatsApp Business API or Twilio.
- Passwords and tokens follow sensible defaults, but get a security review (and a PDPA check) before real customers.

## Updates and the pipeline
`.github/workflows/deploy.yml` tests every push and pull request (throwaway PostgreSQL, migrate twice, seed, smoke test),
and on `main` packages the code to S3 and deploys it on the EC2 server through Systems Manager (`deploy/deploy.sh`):
build the image, apply `db/migrations/*.sql`, swap the container, check `/health`, roll back if unhealthy.
GitHub needs three repository variables: `AWS_ROLE_ARN`, `DEPLOY_BUCKET`, `INSTANCE_ID`. The full steps are in the AWS guide.

## Design
The look follows the supplied CT2079 frontend: warm paper background, ink text, coral accent, dark pill buttons, hero banner,
category chips, gradient event cards, booking stepper and a footer with text-size and contrast controls.
The app is still plain HTML, CSS and JavaScript served by the API, so there is no frontend build step.
