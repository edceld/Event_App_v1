# Event Gate

A smartphone-friendly event ticket and check-in app for a small venue. The initial capacity is 120, configurable per event, with three ticket categories: **Staff**, **Performer**, and **General Attendee**. It supports English, Japanese, Vietnamese, Simplified Chinese, and Traditional Chinese. No payment processing is included: administrators confirm payment/eligibility separately before issuing tickets.

## Local development

Use Node.js 24 (see `.nvmrc`) and npm. Work in this existing checkout; a separate Git worktree is unnecessary.

```sh
npm ci
npm run db:init
npm run user:create -- "Your Name" your-email@example.com admin
npm run dev
```

The user creation command securely prompts for a password (at least 12 characters) on a terminal. There are no default credentials or public registration. For automation, inject `INITIAL_USER_PASSWORD` securely as an environment variable; do not put it in command history or source control. Creating the same email again fails instead of overwriting the account.

The default database is the ignored `.data/event-gate.db` file. Optional `.env.local`/`.env` configuration is loaded by Next.js and the initialization/user-creation scripts. Existing exported variables take priority. See `.env.example`; do not commit real credentials or attendee databases.

For a production-mode local run, use `npm run build` followed by `npm start`. A phone's camera needs **HTTPS** and camera permission. A loopback development session is sufficient for automated checks; hosting over HTTPS is required to test scanning on real phones.

## Event operation

1. Sign in as an administrator, create an event, and set its date/time, venue, and capacity. Date/time entry uses the device's local time zone and is stored as UTC. The capacity includes all three ticket categories and counts active tickets, not live occupancy.
2. Issue a named ticket after confirming payment or eligibility. Select Staff, Performer, or General Attendee; supply an email address if sending by email.
3. Download the QR ticket as a JPG for manual distribution, or use **Email ticket** after configuring the email provider. Re-download/re-send active tickets from the Tickets screen. Cancellation permanently blocks the QR, and frees one place for a replacement ticket.
4. Add individual team accounts from Team. Ticket category and app permissions are separate.
5. Each check-in phone signs in and selects the same event. Scan with the rear camera, or enter the QR's text as a fallback. First admission is recorded atomically. Wrong-event, malformed, and cancelled tickets are blocked. If the network request fails, do not admit the person until a successful response or supervisor decision; retrying an already-committed check-in will report a duplicate.
6. A duplicate scan does **not** admit the attendee. Staff request supervisor approval and wait on Re-entry. A supervisor or administrator signs in on their own device, reviews the request, and approves or declines. Staff see the result, approver, and decision time; updates refresh every five seconds, with a manual refresh button. Each later duplicate needs a new approval. Admission/re-entry records include the responsible account, time, and optional reason.

| Account role   | Issue/cancel tickets; events; team | Scan and admit first entry | Approve re-entry |
| -------------- | ---------------------------------- | -------------------------- | ---------------- |
| Administrator  | Yes                                | Yes                        | Yes              |
| Supervisor     | No                                 | Yes                        | Yes              |
| Check-in staff | No                                 | Yes                        | No               |

QR tickets are bearer credentials. Anyone with a copy can present one; the application prevents repeated admission but does not prove identity. Staff can compare the displayed name with identification when the event requires it. Database access must be restricted because administrators can re-export ticket QR credentials. The first-entry count is not an occupancy counter: the app does not track exits.

## Vercel deployment

This is a Next.js application, with Node.js API routes and libSQL storage. GitHub Pages alone cannot run its authenticated backend. Vercel's filesystem is ephemeral; **never use the local file database on Vercel**. The app explicitly refuses that configuration.

1. Push the reviewed source to your GitHub repository and import it into Vercel as a Next.js project using Node.js 24. Set the project root to the repository root. Use `npm ci`, `npm run build`, and the standard Next.js output.
2. Create a persistent hosted libSQL/Turso database and configure `DATABASE_URL=libsql://<your-database-host>` and `DATABASE_AUTH_TOKEN` securely in Vercel. Use distinct databases for development/preview and production.
3. For first-run setup without a local terminal, set `INITIAL_USER_EMAIL`, `INITIAL_USER_PASSWORD` (12–128 characters), and optionally `INITIAL_USER_NAME` in Vercel for the target environment. The first API request initializes the schema and creates an administrator **only if there are no users**. Concurrent requests cannot create multiple initial administrators, and these variables never reset existing accounts. After first-run setup, the password variable can be removed; the stored password hash continues to work. Alternatively, with the **same target database variables** securely available in an administrative shell, run `npm run db:init` and `npm run user:create -- "Your Name" your-email@example.com admin`. These commands must target the remote database, not the default local file.
4. Deploy, sign in at the HTTPS deployment, and create your real event and team accounts. Validate camera permission and scanning on actual iPhone/Android devices and all intended phones before the event.
5. Configure database backups and restore testing through your database provider. Protect hosting/database/email account access; do not expose administrative tokens to browsers. Keep dependencies patched and use separate named staff accounts.

For automatic email, configure `RESEND_API_KEY` and `EMAIL_FROM` in the hosting environment. Verify the sender's domain with Resend. The server sends the generated JPG as an attachment to the ticket's stored recipient address; staff accounts cannot call the email endpoint. A provider acceptance response does not guarantee inbox delivery. A timeout can leave delivery uncertain: check provider logs before resending. Delivery attempts and provider acceptance IDs are retained in `email_deliveries`.

Cloud task networking may need the exact database hostname and `api.resend.com` added to the environment's allowed domains when validating those providers. Enter credentials in secure environment settings, never in chat. The hosted beta uses a dedicated Vercel project and Turso Starter database; see [BETA.md](BETA.md) for its URL and validation status. A real email sender has not yet been configured.

## Validation

```sh
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

The ten core tests exercise secure first-run administrator creation, five simultaneous scans of one QR, five different simultaneous admissions, wrong-event/invalid/cancelled tickets, role permissions, supervisor audit records and approval reuse, cancellation during approval, capacity enforcement, passwords, and language selection.

The browser test starts a production server on port 3100 against the isolated `.data/browser-test.db`, which it resets each run. It never uses the development or production database. It tests phone-size layouts, login, event/ticket creation, actual JPG generation and QR decoding, concurrent HTTP scans, supervisor approval across separate sessions, cancellation, cross-origin request rejection, and language switching. Its test-only accounts are confined to that fixture. Never deploy the test database or use its credentials operationally.

If the cloud environment disallows the default npm/browser cache directories, set `npm_config_cache=/workspace/.npm-cache` and `PLAYWRIGHT_BROWSERS_PATH=/workspace/.cache/ms-playwright`. Live camera hardware, remote database behavior, and real email delivery require deployment/device validation; the automated browser test does not establish those.

## Implementation

- `src/app/page.tsx`: responsive event, ticket, scan, approval, and team screens.
- `src/app/api/[...path]/route.ts`: authenticated APIs, server-side permissions, same-origin mutation checks, per-account login rate limiting, and email delivery.
- `src/lib/tickets.ts`: transactional capacity checks, admission, and supervisor re-entry approval.
- `src/lib/db.ts`: repeatable schema initialization; SQLite locally and remote libSQL in the cloud. Local writer-lock retries use fresh connections; transaction bodies and uncertain commits are never blindly replayed.
- `src/lib/i18n.ts` and `src/lib/jpg.ts`: five-language text and browser-generated QR JPGs.

Sessions use random, hashed tokens, HttpOnly/SameSite cookies, and 12-hour expiry. Passwords use salted scrypt hashes. QR credentials contain 256 bits of randomness; no attendee details are encoded in the QR. Ticket and audit data remain in the configured database. Administrator account recovery, password reset, bulk import, outbound email localization, and exit/occupancy tracking are outside this first version.
