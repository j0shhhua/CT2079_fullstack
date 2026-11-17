# Classroom demo hosting handoff

The code changes are ready for review. These steps are for the groupmate who manages the hosting account. They have not been applied to the live server.

## Before updating

1. Back up the database and confirm that it can be restored in a separate test environment. Keep the running release and a compatible recovery image. Use classroom/test data only; do not switch a database containing unresolved real payments into demo mode.
2. Review the branch against the current main version. Build it and run the normal checks in staging first. Review migration 002, especially if the renamed demo administrator was deliberately re-enabled previously.
3. Keep the existing environment file private. Preserve the current QR_SECRET so existing demo tickets remain verifiable. Do not replace its values with the blank example or commit the real file.

## Hosted demo settings

Use `.env.demo.example` as the reference. Keep:

```text
NODE_ENV=production
PAYMENT_MODE=demo
ALLOW_SIMULATED_PAYMENTS=true
APP_ORIGIN=https://d2kfaw7ytc9vwz.cloudfront.net
DB_SSL=true
DB_CA_FILE=/run/certs/database-ca.pem
SMS_ENABLED=false
ALLOW_DEMO_SEED=false
```

The server also needs its existing DATABASE_URL, distinct strong JWT_SECRET and QR_SECRET, a strong ORIGIN_VERIFY_SECRET, authorised SES_FROM, AWS_REGION and the trusted proxy setting. Keep the private file at permission 600. Remove STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in this demo environment: the application refuses them in demo mode. No bank/card details are needed for a practice booking.

Configure email delivery for staff verification and order recovery; codes are never printed as a fallback. Use authorised test recipients and keep SMS disabled. A template or successful startup check does not prove that email is delivered.

## Hosting and update

1. Follow the certificate, private-database and origin restrictions in DEPLOYMENT.md. Give CloudFront the private `X-Origin-Verify` header; never expose its value to the browser. Forward cookies and the required request headers. Disable caching for `/api/*` and `/config.js`.
2. Install/review the nginx example and its trusted CloudFront address list. It observes both old and new maintenance flags while the application name changes. Validate nginx before reloading it.
3. Set DB_CA_HOST_FILE to the trusted certificate bundle on the host. The script uses `eventease.env` or the previous `eventeaseplus.env`; EVENTEASE_ENV_FILE can explicitly select the private file. It does not copy or change credentials.
4. Run the reviewed deployment script with a release identifier. It first checks the new configuration with production settings, then enables maintenance, migrates, replaces either old container name and checks health. If a compatible rollback cannot run, it deliberately keeps maintenance enabled. Have the recovery plan ready, particularly for the first transition to explicit demo mode.
5. Invalidate the changed static files in CloudFront and confirm that the new configuration and notice are visible.

## Check after deployment

- `/health` returns `{"ok":true}`.
- `/config.js` includes `demoMode:true` and `resaleEnabled:false`, with demo methods only and no secrets. It uses `Cache-Control: no-store`.
- Every page shows the classroom demo notice. Booking says no money will be charged, and order pages explain that demo tickets are not valid for entry.
- Past events are absent from the upcoming list. Opening an old event link shows “Booking is closed”. Existing orders/history still open normally with authorised access.
- Use a disposable test account to confirm Secure/HttpOnly cookies, staff verification and recovery email delivery. Do not try the old public demo passwords.
- Confirm both resale listing and purchasing are unavailable. Complete a practice booking only with test data; confirm that no Stripe operation exists.
- Confirm the background worker, backups, logs and alerts are operating, and that migration 002 is recorded once.

The local suite uses a temporary database and mocked services. Passing it does not verify the installed certificates, CloudFront rules, real email delivery or live server settings. Real ticket sales would require a separate reviewed Stripe setup and seller-payout implementation before enabling resale.
