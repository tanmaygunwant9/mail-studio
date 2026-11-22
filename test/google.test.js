import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleAccount, SEND_SCOPE } from '../lib/google.js';

const result = (data, status = 200) => new Response(JSON.stringify(data), { status });
function setup(fetcher) {
  return new GoogleAccount({ clientId: 'test-client', clientSecret: 'test-secret', origin: 'http://localhost:3000', fetcher });
}
const callback = state => new URLSearchParams({ state, code: 'code' });
test('OAuth uses minimal scopes, PKCE and expiring, single-use session state', async () => {
  let calls = 0;
  const google = setup(async () => { calls++; throw new Error(); });
  const session = {};
  const url = new URL(google.begin(session));
  assert.equal(url.searchParams.get('scope'), `openid email ${SEND_SCOPE}`);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/auth/google/callback');
  await assert.rejects(google.complete(session, callback('wrong')), /expired/);
  await assert.rejects(google.complete(session, callback(url.searchParams.get('state'))), /expired/);
  google.begin(session); session.google.expires = 0;
  await assert.rejects(google.complete(session, callback(session.google.state)), /expired/);
  google.begin(session);
  await assert.rejects(google.complete(session, new URLSearchParams({ state: session.google.state, error: 'access_denied' })), /cancelled/);
  assert.equal(calls, 0);
});
test('OAuth binds verified identity, requires send permission and preserves account on mismatch', async () => {
  let scope = SEND_SCOPE;
  const google = setup(async url => url.includes('/token') ? result({ access_token: 'access', refresh_token: 'refresh', scope }) : result({ email: 'owner@gmail.com', email_verified: true }));
  const session = {};
  google.begin(session); await google.complete(session, callback(session.google.state));
  assert.deepEqual(google.view(), { configured: true, email: 'owner@gmail.com' });
  assert.throws(() => google.require('other@gmail.com'), /campaign/);
  google.begin(session); await assert.rejects(google.complete(session, callback(session.google.state), 'other@gmail.com'), /original/);
  scope = 'openid email'; google.begin(session);
  await assert.rejects(google.complete(session, callback(session.google.state)), /permission/);
  assert.equal(google.view().email, 'owner@gmail.com');
  google.disconnect(); assert.equal(google.view().email, null);
  assert.throws(() => google.require('owner@gmail.com'), { code: 'EAUTH' });
});
test('Gmail sends MIME with PDF and refreshes access without exposing tokens in state', async () => {
  const requests = [];
  const google = setup(async (url, options) => {
    requests.push({ url, options });
    if (url.includes('/token')) return result({ access_token: 'new-access', expires_in: 3600 });
    return result({ id: 'gmail-message-id' });
  });
  google.account = { email: 'owner@gmail.com', accessToken: 'expired', refreshToken: 'secret-refresh', expires: 0 };
  await google.send({ draft: { sender: 'owner@gmail.com', attachment: { name: 'note.pdf', base64: Buffer.from('%PDF-test').toString('base64') } }, message: { to: 'person@example.com', subject: 'Hello', text: 'Personal message' } });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.body.get('grant_type'), 'refresh_token');
  assert.equal(requests[1].options.headers.Authorization, 'Bearer new-access');
  const mime = Buffer.from(JSON.parse(requests[1].options.body).raw, 'base64url').toString();
  for (const value of ['owner@gmail.com', 'person@example.com', 'Subject: Hello', 'Personal message', 'application/pdf', 'note.pdf']) assert.ok(mime.includes(value));
  assert.ok(!JSON.stringify(google.view()).includes('secret-refresh'));
});
test('refresh failures are retryable; ambiguous sends are never automatically retried', async () => {
  let calls = 0;
  const google = setup(async () => { calls++; throw new Error('network error with sensitive data'); });
  const item = { draft: { sender: 'owner@gmail.com' }, message: { to: 'person@example.com', subject: 'Hi', text: 'Hello' } };
  google.account = { email: item.draft.sender, refreshToken: 'refresh', expires: 0 };
  await assert.rejects(google.send(item), { code: 'EAUTH' });
  assert.equal(calls, 1);
  google.account.expires = Date.now() + 3600000;
  await assert.rejects(google.send(item), error => error.code !== 'EAUTH');
  assert.equal(calls, 2);
  google.fetcher = async () => result({}, 403);
  await assert.rejects(google.send(item), { code: 'EAUTH' });
});
