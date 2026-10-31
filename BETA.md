# Event Gate — Beta version 1

The current app is labeled **Beta version 1**, with the release tag `beta-v1`. Earlier technical prerelease tags remain available in GitHub history.

This beta includes administrator-issued QR/JPG tickets, Staff/Performer/General Attendee ticket types, simultaneous online check-in, supervisor-approved re-entry, and five language choices.

## Hosting status

The hosted beta is available at **https://event-gate-beta-dev-apps4.vercel.app**. It runs in the Vercel project's Preview environment with a dedicated Turso Starter ($0/month) database. Sign in with the separately provisioned administrator account and the password you chose in Vercel's secure settings. Check-in staff use application accounts; they do not need Vercel accounts.

The GitHub prerelease contains the source; it is not an installable phone binary. Open the hosted HTTPS link in your phone's browser. GitHub Pages cannot run this application's backend.

The beta database must be separate from any production event data. Automatic email delivery is optional for the initial beta; JPG downloading and manual distribution work without an email provider.

Validation passed: ten core tests, the mobile browser workflow with a simulated camera, TypeScript/production compilation, and fifteen hosted functional checks including five simultaneous phone sessions. Temporary hosted validation accounts, tickets, and events were removed. Physical iPhone/Android camera testing and real email delivery still need operator validation.

## Try the beta

Once the hosted URL and your administrator account are provisioned:

1. Open the HTTPS app URL in Safari on iPhone or Chrome on Android and sign in. Select your preferred language.
2. Create a test event with a capacity of 120. Include the test date/time and venue.
3. Create one ticket in each category: Staff, Performer, and General Attendee. Download the JPGs and display them on another phone or a computer screen.
4. Add a Check-in staff account and a Supervisor account from Team. Use separate accounts to check the permissions.
5. Sign in to the check-in account on two phones, select the same test event, and allow camera access. Scan the same ticket on both phones. Only one scan should admit the attendee; the other should report a duplicate.
6. Request supervisor approval for the duplicate. In the supervisor account, open Re-entry, enter an optional reason, and approve. The staff account should show the decision, supervisor, and time. A later scan still requires a fresh approval.
7. Cancel another ticket as the administrator, then scan it. It should be rejected.
8. Switch between English, Japanese, Vietnamese, Simplified Chinese, and Traditional Chinese. Check the interface and export a JPG in your selected language.

The default capacity counts active tickets across all categories. The app does not track exits or live room occupancy. Test tickets behave like real bearer tickets: anyone holding a copy can present one, and repeated admission requires approval.

## Report a problem

Use the repository's Issues page. Include the beta version, phone model, browser, interface language, steps to reproduce, and expected/actual result. Redact attendee information, login credentials, and QR codes from screenshots.

## Run locally instead

See [README.md](README.md) for Node.js 24 installation commands, database setup, and initial administrator creation. Local development and automated tests were validated in the cloud workspace; that alone does not provide a public phone-accessible URL.
