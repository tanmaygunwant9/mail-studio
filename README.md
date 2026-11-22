# Mail Studio — web edition

A complete browser UI with a JavaScript/Node.js backend. No Python, frontend framework, or build step. Uses Google OAuth and the Gmail API to send email, Nodemailer to build messages, and `csv-parse` for CSV imports.

## Open it on Windows

1. Install Node.js **22 or newer** from https://nodejs.org if it is not already installed.
2. Extract the ZIP into a writable folder. Keep all files together.
3. Double-click **Start Mail Studio.vbs**. It starts the Node server invisibly and opens http://localhost:3000 in your default browser.
4. If dependencies are missing, double-click **Install dependencies.cmd** once, then use the launcher.

The delivered ZIP includes the two installed dependency packages. `npm ci` restores them from the lockfile if needed. The launcher expects port 3000. For another port or on macOS/Linux, run `npm ci` then `npm start` and open the URL printed by the server.

## Set up Firebase sign-in

Mail Studio uses Firebase project `mail-studio-14fe0` for Google sign-in. In the [Firebase Authentication console](https://console.firebase.google.com/project/mail-studio-14fe0/authentication/providers), enable the **Google** sign-in provider and set a support email. In **Authentication → Settings → Authorized domains**, add `localhost` and the hostname of any deployment. Open Mail Studio on an authorized hostname.

Each Google user gets their own draft, recipients, attachments and queue. Signing out ends the browser session. An active queue continues on the server.

## Set up Gmail sending (once)

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select a project. Enable the **Gmail API** in APIs & Services → Library.
2. Configure the **Google Auth platform** consent screen (Branding, Audience, and Data Access). Add your email as a test user while the app is in Testing. Request `openid`, `email`, and `https://www.googleapis.com/auth/gmail.send`. This app sends mail; it does not request access to read your inbox.
3. Create an OAuth client of type **Web application**. Add this exact authorized redirect URI for the default local setup: `http://localhost:3000/auth/google/callback`.
4. Copy `.env.example` to `.env`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from that client. Keep the secret private; never put it in frontend JavaScript or commit `.env`.
5. Restart Mail Studio and open **http://localhost:3000** (use this same hostname, rather than 127.0.0.1). Click **Sign in with Google**, then click **Connect Gmail** in Sending account. Choose the same Google account and allow sending email. The From address fills automatically.

If you change the port or use a hosted domain, set `PUBLIC_ORIGIN` to that exact origin and register `<PUBLIC_ORIGIN>/auth/google/callback` instead. Start the connection from that same origin so the browser session matches on return. Google sign-in does not send anything until you click **Start sending**.

For a personal project in Testing, only configured test users can connect and refresh tokens generally expire after seven days with Gmail permissions. Reconnect when needed. For public use without a tester list, use an External production OAuth app and complete Google’s verification for the sensitive `gmail.send` scope. Firebase sign-in does not grant that scope. Workspace administrators may also restrict access.

Google setup cannot be completed with source code alone: the OAuth client credentials must come from your Google Cloud project. Normal Google sign-in identifies an account; the additional Gmail permission authorizes sending.

References: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

## Use the website

- Write a subject and plain-text message.
- Paste email addresses or import a CSV with an `email` column. Both lists are combined; duplicates are removed case-insensitively.
- CSV columns can personalize subject/body using `{{name}}` or `{{company}}`. Every recipient must have the fields used by the template. Pasted addresses only have `{{email}}`.
- Optionally attach a PDF up to 10 MB.
- Preview any recipient's personalized message.
- Sign in with Google, click **Connect Gmail** in Sending account, allow sending permission, and click **Start sending**.
- One recipient is processed immediately, then one every ten minutes after the previous successful send. A recent send or resolved uncertain delivery can delay the first send.
- Pause waits for any email already in flight. Resume uses the connected Google account. If disconnected or expired, reconnect first.
- Save draft explicitly before closing if you edited it. Starting also saves your draft.
- Once started, a campaign's content is frozen. **New campaign** copies the content and resets recipients' progress intentionally. It does not bypass the ten-minute spacing.

Keep the Node server running and your computer awake. The browser tab may be closed after starting. Closing the browser does **not** stop the queue. Restarting the server pauses the queue; sign in, reconnect Gmail and resume from the website.

Use **Stop server** in the top bar to shut down the local backend. It finishes any in-flight email before exiting. Double-click the launcher when you want to reopen it.

Stop the previous Python/CMD/desktop sender before using this edition. This app has separate progress: import only recipients who still need their email for a campaign already in progress.

## Change the UI or backend

| File | What to edit |
| --- | --- |
| `public/index.html` | Page structure, labels, fields, dialogs |
| `public/style.css` | Colors, spacing, responsive layout; start with the `:root` design tokens |
| `public/app.js` | Browser interactions, file selection, preview and status polling |
| `server.js` | HTTP routes, sessions, Google callback and server startup |
| `lib/google.js` | OAuth, token refresh, and Gmail API delivery |
| `lib/campaign.js` | CSV validation, personalization, durable queue and interval |
| `test/campaign.test.js` | Tests for timing, recovery and recipient handling |

Refresh the browser after editing frontend files. Restart Node after backend edits. Run `npm test` and `npm run check` to verify changes. No build command is needed.

## Data and recovery

`data/users/<workspace-id>/campaign.json` stores each Firebase user’s draft, recipient list, PDF and progress. To open the previous single-owner campaign in `data/campaign.json`, stop the server, set `MAIL_STUDIO_LOCAL_OWNER=1` in `.env`, and restart on localhost. Remove that setting to return to Firebase sign-in. Treat this folder as private and back it up if needed. Google access and refresh tokens are kept only in server memory; they are never saved in this file, browser storage, or logs. Tokens refresh automatically while the server runs. Restarting the server forgets the connection. Disconnect clears the local connection; to revoke the Google grant too, remove Mail Studio in your Google Account third-party connections. Pause the queue before disconnecting or reconnecting. A started campaign must resume with its original sending account; create a new campaign to switch accounts.

If a connection ends after delivery may have started, the queue stops with an **uncertain delivery** panel. Check Gmail Sent or provider logs. Choose whether it was sent before resuming. The Gmail API cannot guarantee exactly-once delivery after an interrupted request, and server acceptance does not guarantee inbox placement. Authentication failures pause safely without marking a recipient as sent.

## Host on your own server

This is a real server app, not a static-only website. It needs a long-running Node process and outbound HTTPS access to Firebase Authentication, Google OAuth and Gmail APIs on port 443. It does not run on static hosting or ephemeral serverless request functions.

1. Deploy this folder on a Node-capable server; run `npm ci`.
2. Copy `.env.example` to `.env` and set `HOST=0.0.0.0`, `PUBLIC_ORIGIN=https://your-domain`, and a persistent `DATA_DIR`.
3. Put an HTTPS reverse proxy in front of Node, preserve the original `Host`, and proxy to its port. Use exactly the configured domain.
4. Run **one process/replica** with a process manager and persistent disk. Multiple processes must not share the queue file.
5. Add the deployed hostname to Firebase’s authorized domains and register the production Gmail OAuth callback. Open the website, sign in with Google, and connect Gmail.

Remote startup requires Firebase sign-in and an HTTPS origin. Local mode binds to loopback only. The backend checks Host, request Origin and a CSRF token; sessions use HttpOnly/SameSite=Lax cookies so Google can return to the callback. OAuth uses a short-lived, single-use state bound to that session and PKCE. Do not bypass these checks or expose the default local configuration through a public tunnel.

Sending reference: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send


## Google verification for public Gmail sending

Google approves public access to the Gmail OAuth client. Firebase handles sign-in separately. Use a production Google Cloud project and an HTTPS deployment on a domain you control. Keep a separate Google Cloud project for testing.

1. Deploy Mail Studio. Use the public homepage as the OAuth app homepage and `/privacy` on the same host as the privacy policy URL. Verify domain ownership and make sure a reviewer can access both pages without signing in.
2. Create a **Web application** OAuth client in the production project and register the deployed URL ending in `/auth/google/callback`. Enable Gmail API, add the hostname to Firebase's authorized domains, and configure the production client ID and secret on the server.
3. In [Google Auth Platform](https://console.cloud.google.com/auth/overview), select that production project. Set the Audience to **External** and use **In production** for public access. Complete Branding with the app name, support address, verified domains and public links, then verify and publish the branding.
4. In Data Access, declare `openid`, `email`, and `https://www.googleapis.com/auth/gmail.send`. In Verification Center, submit the scope explanation and an unlisted demo video showing sign-in, the Gmail consent prompt with the production client ID visible, composing a message, and sending it to a test inbox you control.
5. After Google approves the requested scope, verify the full flow using a Google account outside the test user list. Google Workspace administrators can still restrict their users' access.

Suggested scope explanation for the submission:

> Mail Studio lets the signed-in user compose a message, choose recipients, optionally attach a PDF, and start a sending queue. The app uses Gmail's users.messages.send endpoint with gmail.send to deliver those user-authored messages from the user's connected Gmail account, including when the browser is closed. Basic Google sign-in scopes identify the user but cannot send mail. The app does not request inbox, contact, or mailbox management access.

See [Google's sensitive scope verification guide](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).
