# Organiser registration and approval

This update keeps organiser approval separate from customer login. The hosting administrator approves organiser accounts; the organiser then confirms access using a code sent to their registered email. This patch has not changed the AWS hosting settings or any live account.

## New organiser accounts

1. Open **Organise an event** and register with **Event organiser** selected.
2. The account is saved as an organiser awaiting approval. The website shows **Approval pending**. No login session or verification email is issued at this stage.
3. An authorised administrator approves that organiser account.
4. The organiser returns to **Log in** and enters their email and password.
5. A verification code is sent to that account's registered email address. The code expires after ten minutes, allows at most five attempts and can be used once.
6. A successful code check opens the organiser dashboard. Entering the password alone does not create an organiser login session.

Attempting to log in before approval returns to **Approval pending**. It does not sign the organiser in as a customer. An approved organiser whose approval is later removed cannot keep using organiser tools through an existing session.

## Existing customer accounts

An email address belongs to one account. Registering it again as an organiser does not change the existing customer account.

The account holder should log in, open **Profile and settings**, select **Request organiser access** and confirm their current password. This is an explicit change of account type. It preserves the account details and booking history, revokes all account sessions and outstanding verification codes, and signs the person out. Access remains pending until an administrator approves the organiser request.

After approval, the organiser uses the password and email-code login sequence above. Organiser accounts manage events; purchases use guest checkout.

## Approval by the hosting administrator

The preferred route is the website's administrator area: open **Admin → Organisers**, locate the correct registered email and select **Approve**.

An authorised hosting operator can also run:

```sh
node scripts/approve-organiser.js
```

Run it from the deployed project with its secure database environment and `ORGANISER_EMAIL` set to the organiser's registered email. Use the same database as the live application and the existing verified database TLS configuration. Keep database credentials in the operator's secure environment; do not paste them into commands, screenshots or the repository.

Both routes use `src/organiser-approval.js`. It refuses missing, disabled and customer accounts. A customer must submit the organiser request first. First approval invalidates earlier account sessions and verification codes before marking the organiser approved. Repeating approval for an already approved organiser is safe and does not interrupt their current session.

Approval does not send a reusable password or automatically log anyone in. The organiser must start a fresh login to receive their code.

## AWS email configuration

Application approval and Amazon SES identity verification are different. Verifying an email address in the AWS SES console does not approve an organiser account in Eventease.

The hosting administrator must configure `SES_FROM`, the correct `AWS_REGION`, an authorised SES sender and permission for the application to send email. If SES is still in its sandbox, recipient addresses must also be verified. Sending to arbitrary organiser addresses requires SES production access. See the AWS guidance on [verified identities](https://docs.aws.amazon.com/ses/latest/dg/verify-addresses-and-domains.html) and [requesting production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html).

Email delivery failures must be resolved in the hosting configuration. The application does not display or log verification codes as a fallback.

## Deployment and acceptance checks

Deploy the backend and frontend together using the existing deployment process. This change needs no additional database migration beyond the project's existing security schema. Ensure that schema is already installed. Invalidate the CloudFront cache for `/app.js` and `/index.html`, and `/` if the root document is cached separately, so browsers receive the updated screens.

Before the final demonstration, use staging, controlled email addresses and test accounts to confirm:

- A new organiser sees **Approval pending**, receives no login code before approval and has no customer or organiser session.
- Correct organiser credentials before approval show the pending page; an incorrect password still shows a normal login error.
- The administrator approves the intended organiser account. A customer, disabled account or missing account cannot be approved through the operator command.
- After approval, login sends a code to the registered organiser email. The dashboard stays unavailable until that code is verified.
- Expired, previously used or exhausted codes do not create a session. Removing approval prevents further organiser access.
- An existing customer can submit the explicit organiser request with their current password. Their history remains, previous sessions stop working and the account waits for approval.
- Ordinary customer login continues to work, and organiser accounts use guest checkout when buying tickets.

Local checks use a disposable database and an in-memory email sink. They do not prove delivery through the deployed SES account. Real SES delivery, the administrator's production approval and the final CloudFront deployment still require the hosting administrator's staging checks.
