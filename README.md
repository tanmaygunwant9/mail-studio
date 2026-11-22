# Mail Studio — web edition

A complete browser UI with a JavaScript/Node.js backend. No Python, frontend framework, or build step. Uses Google OAuth and the Gmail API to send email, Nodemailer to build messages, and `csv-parse` for CSV imports.

## Open it on Windows

1. Install Node.js **22 or newer** from https://nodejs.org if it is not already installed.
2. Extract the ZIP into a writable folder. Keep all files together.
3. Double-click **Start Mail Studio.vbs**. It starts the Node server invisibly and opens http://localhost:3000 in your default browser.
4. If dependencies are missing, double-click **Install dependencies.cmd** once, then use the launcher.

The delivered ZIP includes the two installed dependency packages. `npm ci` restores them from the lockfile if needed. The launcher expects port 3000. For another port or on macOS/Linux, run `npm ci` then `npm start` and open the URL printed by the server.

## Set up Google sign-in (once)

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create or select a project. Enable the **Gmail API** in APIs & Services → Library.
2. Configure the **Google Auth platform** consent screen (Branding, Audience, and Data Access). Add your email as a test user while the app is in Testing. Request `openid`, `email`, and `https://www.googleapis.com/auth/gmail.send`. This app sends mail; it does not request access to read your inbox.
3. Create an OAuth client of type **Web application**. Add this exact authorized redirect URI for the default local setup: `http://localhost:3000/auth/google/callback`.
4. Copy `.env.example` to `.env`. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from that client. Keep the secret private; never put it in frontend JavaScript or commit `.env`.
5. Restart Mail Studio and open **http://localhost:3000** (use this same hostname, rather than 127.0.0.1). Click **Sign in with Google**, choose your account, and allow sending email. Your From address fills automatically.

If you change the port or use a hosted domain, set `PUBLIC_ORIGIN` to that exact origin and register `<PUBLIC_ORIGIN>/auth/google/callback` instead. Start the connection from that same origin so the browser session matches on return. Google sign-in does not send anything until you click **Start sending**.

For a personal project in Testing, only configured test users can connect and refresh tokens generally expire after seven days with Gmail permissions. Reconnect when needed. Public distribution may require Google's OAuth verification for the sensitive `gmail.send` scope. Workspace administrators may also restrict access.

Google setup cannot be completed with source code alone: the OAuth client credentials must come from your Google Cloud project. Normal Google sign-in identifies an account; the additional Gmail permission authorizes sending.

References: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

## Use the website

- Write a subject and plain-text message.
- Paste email addresses or import a CSV with an `email` column. Both lists are combined; duplicates are removed case-insensitively.
- CSV columns can personalize subject/body using `{{name}}` or `{{company}}`. Every recipient must have the fields used by the template. Pasted addresses only have `{{email}}`.
- Optionally attach a PDF up to 10 MB.
- Preview any recipient's personalized message.
- Click **Sign in with Google** in Sending account, allow sending permission, and click **Start sending**.
- One recipient is processed immediately, then one every ten minutes after the previous successful send. A recent send or resolved uncertain delivery can delay the first send.
- Pause waits for any email already in flight. Resume uses the connected Google account. If disconnected or expired, reconnect first.
- Save draft explicitly before closing if you edited it. Starting also saves your draft.
- Once started, a campaign's content is frozen. **New campaign** copies the content and resets recipients' progress intentionally. It does not bypass the ten-minute spacing.

Keep the Node server running and your computer awake. The browser tab may be closed after starting. Closing the browser does **not** stop the queue. Restarting the server pauses the queue; reconnect with Google and resume from the website.

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

`data/campaign.json` stores the draft, recipient list, PDF and sending progress. Treat this folder as private and back it up if needed. Google access and refresh tokens are kept only in server memory; they are never saved in this file, browser storage, or logs. Tokens refresh automatically while the server runs. Restarting the server forgets the connection. Disconnect clears the local connection; to revoke the Google grant too, remove Mail Studio in your Google Account third-party connections. Pause the queue before disconnecting or reconnecting. A started campaign must resume with its original sending account; create a new campaign to switch accounts.

If a connection ends after delivery may have started, the queue stops with an **uncertain delivery** panel. Check Gmail Sent or provider logs. Choose whether it was sent before resuming. The Gmail API cannot guarantee exactly-once delivery after an interrupted request, and server acceptance does not guarantee inbox placement. Authentication failures pause safely without marking a recipient as sent.

## Host on your own server

This is a real server app, not a static-only website. It needs a long-running Node process and outbound HTTPS access to Google OAuth and Gmail APIs on port 443. It does not run on static hosting or ephemeral serverless request functions.

1. Deploy this folder on a Node-capable server; run `npm ci`.
2. Copy `.env.example` to `.env` and set `HOST=0.0.0.0`, `PUBLIC_ORIGIN=https://your-domain`, a strong `ADMIN_PASSWORD`, and a persistent `DATA_DIR`.
3. Put an HTTPS reverse proxy in front of Node, preserve the original `Host`, and proxy to its port. Use exactly the configured domain.
4. Run **one process/replica** with a process manager and persistent disk. Multiple processes must not share the queue file.
5. Open the website and sign in with the app access password. Then connect the sending account with Google. The access password protects the shared workspace; Google authorizes email sending.

Remote startup is rejected without an access password and HTTPS origin. Local mode binds to loopback only. The backend checks Host, request Origin and a CSRF token; sessions use HttpOnly/SameSite=Lax cookies so Google can return to the callback. OAuth uses a short-lived, single-use state bound to that session and PKCE. Do not bypass these checks or expose the default local configuration through a public tunnel.

This is a personal, single-owner tool, not a multi-user email service. It uses one connected Google sending account for the shared queue. Google sign-in does not create separate user workspaces.

Sending reference: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
