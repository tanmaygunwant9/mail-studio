import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { GoogleAccount } from './lib/google.js';
import { Campaign, prepare, readCSV } from './lib/campaign.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const remote = !['127.0.0.1', 'localhost', '::1'].includes(HOST);
const ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;
const ADMIN = process.env.ADMIN_PASSWORD || '';
if (remote && (!ADMIN || !ORIGIN.startsWith('https://'))) throw new Error('Remote hosting requires ADMIN_PASSWORD and an HTTPS PUBLIC_ORIGIN.');
const secure = ORIGIN.startsWith('https:');
const allowedHosts = new Set([new URL(ORIGIN).host, ...(!remote ? [`127.0.0.1:${PORT}`, `localhost:${PORT}`] : [])]);
const sessions = new Map();
const attempts = new Map();
let campaign;
let connectingGoogle = false;
const google = new GoogleAccount({ clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET, origin: ORIGIN });
const send = item => google.send(item);
function session(req) {
  const id = /(?:^|;\s*)mail_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
  const entry = sessions.get(id);
  if (!entry || entry.expires < Date.now()) { sessions.delete(id); return null; }
  return entry;
}
function issue(res) {
  const id = randomBytes(32).toString('hex');
  const entry = { csrf: randomBytes(32).toString('hex'), expires: Date.now() + 12 * 3600000 };
  sessions.set(id, entry);
  res.setHeader('Set-Cookie', `mail_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
}
function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON request required.');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error('Request too large. PDF limit is 10 MB.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/icon.svg', ['icon.svg', 'image/svg+xml']]]);
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (!allowedHosts.has(req.headers.host)) return json(res, 403, { error: 'Unrecognized host.' });
  const url = new URL(req.url, ORIGIN);
  try {
    if (req.method === 'GET' && files.has(url.pathname)) {
      if (url.pathname === '/' && !ADMIN && !session(req)) issue(res);
      const [file, type] = files.get(url.pathname);
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      return res.end(fs.readFileSync(path.join(ROOT, 'public', file)));
    }
    if (req.method === 'POST' && req.headers.origin !== `${secure ? 'https' : 'http'}://${req.headers.host}`) return json(res, 403, { error: 'Request origin rejected.' });
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const input = await body(req);
      const key = req.socket.remoteAddress;
      const entry = attempts.get(key) || { count: 0, until: Date.now() + 60000 };
      if (Date.now() > entry.until) { entry.count = 0; entry.until = Date.now() + 60000; }
      entry.count++; attempts.set(key, entry);
      if (entry.count > 10) return json(res, 429, { error: 'Too many attempts. Wait a minute.' });
      const hash = value => createHash('sha256').update(value).digest();
      if (!ADMIN || !timingSafeEqual(hash(String(input.password || '')), hash(ADMIN))) return json(res, 401, { error: 'Incorrect app access password.' });
      issue(res); return json(res, 200, { ok: true });
    }
    const auth = session(req);
    if (!auth) return json(res, 401, { error: ADMIN ? 'Sign in with your app access password.' : 'Reload this page to reconnect.' });
    if (req.method === 'GET' && url.pathname === '/auth/google/callback') {
      if (connectingGoogle) return json(res, 409, { error: 'A Google connection is already in progress.' });
      connectingGoogle = true;
      try {
        if (campaign.busy || campaign.state.status === 'running') throw new Error('Pause the queue before connecting an account.');
        await google.complete(auth, url.searchParams, campaign.state.locked ? campaign.state.draft.sender : '');
        if (!campaign.state.locked) campaign.saveDraft({ ...campaign.state.draft, sender: google.view().email });
        auth.googleNotice = 'Google account connected. You can start sending.';
      } catch (error) { auth.googleNotice = error.message || 'Google connection failed. Try again.'; }
      finally { connectingGoogle = false; }
      res.writeHead(303, { Location: '/' }); return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const state = campaign.view();
      // Attachment bytes are fetched once with the draft, not every polling tick.
      const draft = state.draft;
      delete state.draft;
      return json(res, 200, { ...state, ...(url.searchParams.has('draft') ? { draft } : {}), csrf: auth.csrf, localServer: !remote, google: google.view(), googleNotice: auth.googleNotice || null });
    }
    if (req.method !== 'POST' || req.headers['x-csrf-token'] !== auth.csrf) return json(res, 403, { error: 'Request rejected. Reload the page.' });
    const input = await body(req);
    if (connectingGoogle) throw new Error('Google connection is in progress. Try again in a moment.');
    switch (url.pathname) {
      case '/api/csv': return json(res, 200, { rows: readCSV(String(input.csv || '')) });
      case '/api/preview': {
        const { draft, messages } = prepare(input.draft);
        return json(res, 200, { sender: draft.sender, attachment: draft.attachment?.name || null, messages });
      }
      case '/api/draft': campaign.saveDraft({ ...input.draft, ...(google.view().email ? { sender: google.view().email } : {}) }); break;
      case '/api/google/connect':
        if (campaign.busy || campaign.state.status === 'running') throw new Error('Pause the queue before connecting an account.');
        return json(res, 200, { url: google.begin(auth) });
      case '/api/google/disconnect':
        if (campaign.busy || campaign.state.status === 'running') throw new Error('Pause the queue before disconnecting.');
        delete auth.google; delete auth.googleNotice; google.disconnect(); break;
      case '/api/start': google.require(campaign.state.draft.sender); campaign.start(); break;
      case '/api/pause': campaign.pause(); break;
      case '/api/new': campaign.newCampaign(); break;
      case '/api/resolve': campaign.resolve(input.delivered); break;
      case '/api/shutdown':
        if (remote) return json(res, 403, { error: 'Manage a hosted server through your hosting provider.' });
        json(res, 200, { ok: true }); setTimeout(shutdown, 100); return;
      default: return json(res, 404, { error: 'Not found.' });
    }
    json(res, 200, { ok: true });
  } catch (error) { json(res, 400, { error: error.message || 'Request failed.' }); }
});
server.requestTimeout = 30000;
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Mail Studio is already running, or port 3000 is in use.' : 'Could not start Mail Studio.'); process.exit(1); });
let timer;
server.listen(PORT, HOST, () => {
  // Only create the queue after the listening port is acquired.
  campaign = new Campaign({ file: path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'campaign.json'), send });
  timer = setInterval(() => campaign.tick().catch(() => { campaign.pause(); console.error('Queue paused because progress could not be saved.'); }), 1000);
  console.log(`Mail Studio is ready: ${ORIGIN}`);
});
function shutdown() {
  clearInterval(timer);
  campaign?.pause();
  server.close();
  const wait = setInterval(() => { if (!campaign?.busy) { clearInterval(wait); process.exit(0); } }, 100);
  setTimeout(() => process.exit(1), 65000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
