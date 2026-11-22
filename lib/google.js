import { randomBytes, createHash } from 'node:crypto';
import nodemailer from 'nodemailer';

export const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const authError = message => Object.assign(new Error(message), { code: 'EAUTH' });
export class GoogleAccount {
  constructor({ clientId, clientSecret, origin, fetcher = fetch, now = Date.now }) {
    Object.assign(this, { clientId, clientSecret, origin, fetcher, now });
    this.account = null;
  }
  get configured() { return Boolean(this.clientId && this.clientSecret); }
  view() { return { configured: this.configured, email: this.account?.email || null }; }
  begin(session) {
    if (!this.configured) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then restart. See README.md for Google setup.');
    const state = randomBytes(32).toString('hex');
    const verifier = randomBytes(32).toString('base64url');
    session.google = { state, verifier, expires: this.now() + 10 * 60000 };
    const params = new URLSearchParams({ client_id: this.clientId, redirect_uri: `${this.origin}/auth/google/callback`, response_type: 'code', scope: `openid email ${SEND_SCOPE}`, access_type: 'offline', prompt: 'consent select_account', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }
  async token(params) {
    try {
      const response = await this.fetcher('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ ...params, client_id: this.clientId, client_secret: this.clientSecret }), signal: AbortSignal.timeout(30000) });
      const data = await response.json();
      if (!response.ok || !data.access_token) throw new Error();
      return data;
    } catch { throw authError('Google connection expired or could not be refreshed. Connect with Google again.'); }
  }
  async complete(session, params, expectedEmail = '', expectedSubject) {
    const pending = session.google;
    delete session.google;
    if (!pending || pending.expires < this.now() || params.get('state') !== pending.state) throw new Error('Google sign-in expired or was not started in this browser. Try again.');
    if (params.has('error') || !params.get('code')) throw new Error('Google connection cancelled. Allow email sending to connect.');
    const tokens = await this.token({ code: params.get('code'), code_verifier: pending.verifier, grant_type: 'authorization_code', redirect_uri: `${this.origin}/auth/google/callback` });
    if (!tokens.scope?.split(' ').includes(SEND_SCOPE)) throw new Error('Google email sending permission is required. Try connecting again.');
    const response = await this.fetcher('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(30000) });
    const profile = await response.json();
    if (!response.ok || !profile.email_verified || !profile.email) throw new Error('Could not verify your Google email address.');
    if (expectedSubject && profile.sub !== expectedSubject) throw new Error('Choose the same Google account you used to sign in to Mail Studio.');
    if (expectedEmail && profile.email.toLowerCase() !== expectedEmail.toLowerCase()) throw new Error('Reconnect the original sending account, or create a new campaign before changing accounts.');
    this.account = { email: profile.email, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expires: this.now() + Number(tokens.expires_in || 3600) * 1000 };
  }
  require(email) {
    if (!this.account) throw authError('Connect with Google before sending.');
    if (email.toLowerCase() !== this.account.email.toLowerCase()) throw authError('Reconnect the campaign’s sending account, or create a new campaign.');
    return this.account;
  }
  async send({ draft, message }) {
    const account = this.require(draft.sender);
    if (account.expires <= this.now() + 60000) {
      if (!account.refreshToken) throw authError('Connect with Google again to continue sending.');
      const token = await this.token({ grant_type: 'refresh_token', refresh_token: account.refreshToken });
      account.accessToken = token.access_token;
      account.expires = this.now() + Number(token.expires_in || 3600) * 1000;
    }
    // Nodemailer builds MIME (including the PDF) without making an SMTP connection.
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows', disableFileAccess: true, disableUrlAccess: true });
    const mail = await transport.sendMail({ from: account.email, to: message.to, subject: message.subject, text: message.text, attachments: draft.attachment ? [{ filename: draft.attachment.name, content: Buffer.from(draft.attachment.base64, 'base64'), contentType: 'application/pdf' }] : [] });
    const response = await this.fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: mail.message.toString('base64url') }), signal: AbortSignal.timeout(60000) });
    if (response.status === 401 || response.status === 403) throw authError('Google rejected sending permission. Reconnect your account and check Gmail API access.');
    // Never retry an ambiguous send automatically.
    if (!response.ok) throw new Error('Gmail did not confirm delivery.');
  }
  disconnect() { this.account = null; }
}
