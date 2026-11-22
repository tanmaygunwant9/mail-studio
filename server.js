import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { firebaseConfig, verifyFirebaseUser } from './lib/firebase.js';
import { GoogleAccount } from './lib/google.js';
import { Campaign, prepare, readCSV } from './lib/campaign.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const remote = !['127.0.0.1', 'localhost', '::1'].includes(HOST);
const ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;
const ADMIN = process.env.ADMIN_PASSWORD || '';
const firebaseEnabled = process.env.MAIL_STUDIO_LOCAL_OWNER !== '1';
if (remote && (!firebaseEnabled || !ORIGIN.startsWith('https://'))) {
  throw new Error('Remote hosting requires Firebase sign-in and an HTTPS PUBLIC_ORIGIN.');
}
const secure = ORIGIN.startsWith('https:');
const allowedHosts = new Set([new URL(ORIGIN).host, ...(!remote ? [`127.0.0.1:${PORT}`, `localhost:${PORT}`] : [])]);
const sessions = new Map();
const attempts = new Map();
const workspaces = new Map();
const dataDir = process.env.DATA_DIR || path.join(ROOT, 'data');
const storageErrors = new Set(['EROFS', 'EACCES', 'EPERM', 'ENOSPC', 'ENOTDIR', 'EEXIST', 'EISDIR']);
function workspace(identity) {
  const key = identity ? createHash('sha256').update(identity.uid).digest('hex') : 'local';
  if (!workspaces.has(key)) {
    const google = new GoogleAccount({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      origin: ORIGIN
    });
    const file = identity ? path.join(dataDir, 'users', key, 'campaign.json') : path.join(dataDir, 'campaign.json');
    const campaign = new Campaign({ file, send: item => google.send(item) });
    workspaces.set(key, { google, campaign, connectingGoogle: false });
  }
  return workspaces.get(key);
}
function sessionId(req) {
  return /(?:^|;\s*)mail_session=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
}
function session(req) {
  const id = sessionId(req);
  const entry = sessions.get(id);
  if (!entry || entry.expires < Date.now()) { sessions.delete(id); return null; }
  return entry;
}
function issue(res, identity = null) {
  const id = randomBytes(32).toString('hex');
  const entry = { identity, csrf: randomBytes(32).toString('hex'), expires: Date.now() + 12 * 3600000 };
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
const files = new Map([['/', ['index.html', 'text/html']], ['/privacy', ['privacy.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']], ['/icon.svg', ['icon.svg', 'image/svg+xml']]]);
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://www.gstatic.com https://apis.google.com; frame-src https://mail-studio-14fe0.firebaseapp.com https://accounts.google.com; style-src 'self'; img-src 'self' data:; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  if (!allowedHosts.has(req.headers.host)) return json(res, 403, { error: 'Unrecognized host.' });
  const url = new URL(req.url, ORIGIN);
  try {
    if (req.method === 'GET' && files.has(url.pathname)) {
      if (url.pathname === '/' && !firebaseEnabled && !ADMIN && !session(req)) issue(res);
      const [file, type] = files.get(url.pathname);
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      return res.end(fs.readFileSync(path.join(ROOT, 'public', file)));
    }
    if (req.method === 'POST' && req.headers.origin !== `${secure ? 'https' : 'http'}://${req.headers.host}`) return json(res, 403, { error: 'Request origin rejected.' });
    if (req.method === 'GET' && url.pathname === '/api/auth/config') {
      return json(res, 200, { firebase: firebaseEnabled ? firebaseConfig : null });
    }
    if (req.method === 'POST' && url.pathname === '/api/login') {
      const input = await body(req);
      const key = req.socket.remoteAddress;
      const entry = attempts.get(key) || { count: 0, until: Date.now() + 60000 };
      if (Date.now() > entry.until) { entry.count = 0; entry.until = Date.now() + 60000; }
      entry.count++; attempts.set(key, entry);
      if (entry.count > (firebaseEnabled ? 120 : 10)) return json(res, 429, { error: 'Too many attempts. Wait a minute.' });
      if (firebaseEnabled) {
        const identity = await verifyFirebaseUser(input.idToken);
        if (!identity) return json(res, 401, { error: 'Sign in with a verified Google account.' });
        sessions.delete(sessionId(req));
        issue(res, identity);
        return json(res, 200, { ok: true });
      }
      const hash = value => createHash('sha256').update(value).digest();
      if (!ADMIN || !timingSafeEqual(hash(String(input.password || '')), hash(ADMIN))) return json(res, 401, { error: 'Incorrect app access password.' });
      issue(res); return json(res, 200, { ok: true });
    }
    const auth = session(req);
    if (!auth) return json(res, 401, { error: firebaseEnabled ? 'Sign in with Google to open your workspace.' : ADMIN ? 'Sign in with your app access password.' : 'Reload this page to reconnect.' });
    const current = workspace(auth.identity);
    const { campaign, google } = current;
    if (req.method === 'GET' && url.pathname === '/auth/google/callback') {
      if (current.connectingGoogle) return json(res, 409, { error: 'A Google connection is already in progress.' });
      current.connectingGoogle = true;
      try {
        if (campaign.busy || campaign.state.status === 'running') throw new Error('Pause the queue before connecting an account.');
        await google.complete(auth, url.searchParams, campaign.state.locked ? campaign.state.draft.sender : '', auth.identity?.googleSubject);
        if (!campaign.state.locked) campaign.saveDraft({ ...campaign.state.draft, sender: google.view().email });
        auth.googleNotice = 'Google account connected. You can start sending.';
      } catch (error) { auth.googleNotice = error.message || 'Google connection failed. Try again.'; }
      finally { current.connectingGoogle = false; }
      res.writeHead(303, { Location: '/' }); return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const state = campaign.view();
      // Attachment bytes are fetched once with the draft, not every polling tick.
      const draft = state.draft;
      delete state.draft;
      return json(res, 200, { ...state, ...(url.searchParams.has('draft') ? { draft } : {}), csrf: auth.csrf, localServer: !firebaseEnabled && !remote, identity: auth.identity?.email || null, google: google.view(), googleNotice: auth.googleNotice || null });
    }
    if (req.method !== 'POST' || req.headers['x-csrf-token'] !== auth.csrf) return json(res, 403, { error: 'Request rejected. Reload the page.' });
    const input = await body(req);
    if (session(req) !== auth) return json(res, 401, { error: 'Sign in again.' });
    if (url.pathname === '/api/logout') {
      sessions.delete(sessionId(req));
      res.setHeader('Set-Cookie', `mail_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }
    if (current.connectingGoogle) throw new Error('Google connection is in progress. Try again in a moment.');
    switch (url.pathname) {
      case '/api/csv': return json(res, 200, { rows: readCSV(String(input.csv || '')) });
      case '/api/preview': {
        const { draft, messages } = prepare(auth.identity ? { ...input.draft, sender: google.view().email || auth.identity.email } : input.draft);
        return json(res, 200, { sender: draft.sender, attachment: draft.attachment?.name || null, messages });
      }
      case '/api/draft': campaign.saveDraft({ ...input.draft, ...((google.view().email || auth.identity) ? { sender: google.view().email || auth.identity.email } : {}) }); break;
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
        if (remote || firebaseEnabled) return json(res, 403, { error: 'Manage a hosted server through your hosting provider.' });
        json(res, 200, { ok: true }); setTimeout(shutdown, 100); return;
      default: return json(res, 404, { error: 'Not found.' });
    }
    json(res, 200, { ok: true });
  } catch (error) {
    if (storageErrors.has(error.code)) {
      console.error(`Workspace storage unavailable (${error.code}).`);
      return json(res, 503, { code: 'WORKSPACE_STORAGE_UNAVAILABLE', error: 'Workspace storage is unavailable. Drafts and sending require a server with writable, persistent storage.' });
    }
    json(res, 400, { error: error.message || 'Request failed.' });
  }
});
server.requestTimeout = 30000;
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Mail Studio is already running, or port 3000 is in use.' : 'Could not start Mail Studio.'); process.exit(1); });
let timer;
server.listen(PORT, HOST, () => {
  timer = setInterval(() => {
    for (const [id, entry] of sessions) if (entry.expires <= Date.now()) sessions.delete(id);
    for (const { campaign } of workspaces.values()) {
      campaign.tick().catch(() => { campaign.pause(); console.error('Queue paused because progress could not be saved.'); });
    }
    for (const [key, entry] of attempts) if (entry.until <= Date.now()) attempts.delete(key);
  }, 1000);
  console.log(`Mail Studio is ready: ${ORIGIN}`);
});
function shutdown() {
  clearInterval(timer);
  for (const { campaign } of workspaces.values()) if (campaign.busy || campaign.state.status === 'running') campaign.pause();
  server.close();
  const wait = setInterval(() => { if (![...workspaces.values()].some(({ campaign }) => campaign.busy)) { clearInterval(wait); process.exit(0); } }, 100);
  setTimeout(() => process.exit(1), 65000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
