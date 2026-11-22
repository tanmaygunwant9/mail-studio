import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { firebaseConfig } from '../lib/firebase.js';
import { emptyDraft } from '../lib/campaign.js';

test('Firebase sessions isolate persisted campaign drafts and require a verified Google identity', async t => {
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-studio-firebase-'));
  const preload = path.join(directory, 'mock-firebase.mjs');
  fs.writeFileSync(preload, `
    globalThis.fetch = async (url, options) => {
      if (url.hostname !== 'identitytoolkit.googleapis.com') throw new Error('Unexpected request');
      const claims = JSON.parse(Buffer.from(JSON.parse(options.body).idToken.split('.')[1], 'base64url'));
      return Response.json({ users: [{
        localId: claims.sub,
        email: claims.sub + '@gmail.com',
        emailVerified: true,
        providerUserInfo: [{ providerId: 'google.com', federatedId: 'google-' + claims.sub }]
      }] });
    };
  `);
  const proc = spawn(process.execPath, ['--import', pathToFileURL(preload).href, 'server.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: origin, DATA_DIR: directory, MAIL_STUDIO_LOCAL_OWNER: '0' },
    windowsHide: true
  });
  t.after(async () => {
    if (proc.exitCode === null) { proc.kill(); await once(proc, 'exit'); }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
    proc.stdout.on('data', data => {
      if (data.toString().includes('ready:')) { clearTimeout(timer); resolve(); }
    });
  });
  const getState = cookie => fetch(`${origin}/api/state?draft=1`, { headers: { Cookie: cookie } });
  const post = (route, data, headers = {}) => fetch(`${origin}/api/${route}`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data)
  });
  const project = firebaseConfig.projectId;
  const token = (sub, provider = 'google.com') => `header.${Buffer.from(JSON.stringify({
    aud: project, iss: `https://securetoken.google.com/${project}`, sub, firebase: { sign_in_provider: provider }
  })).toString('base64url')}.signature`;
  const privacy = await fetch(`${origin}/privacy`);
  assert.equal(privacy.status, 200);
  assert.match(await privacy.text(), /Limited Use/);
  assert.equal((await getState('')).status, 401);
  assert.equal((await post('login', { idToken: token('alice', 'password') })).status, 401);
  const login = async name => {
    const response = await post('login', { idToken: token(name) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    const state = await (await getState(cookie)).json();
    return { Cookie: cookie, 'X-CSRF-Token': state.csrf };
  };
  const alice = await login('alice');
  const bob = await login('bob');
  assert.equal((await post('draft', { draft: { ...emptyDraft(), sender: 'bob@gmail.com', subject: 'Alice private draft' } }, alice)).status, 200);
  const aliceState = await (await getState(alice.Cookie)).json();
  assert.equal(aliceState.draft.sender, 'alice@gmail.com');
  const bobState = await (await getState(bob.Cookie)).json();
  assert.equal(bobState.draft.subject, '');
  assert.notEqual(bobState.id, aliceState.id);
  assert.equal((await post('logout', {}, alice)).status, 200);
  assert.equal((await getState(alice.Cookie)).status, 401);
  const aliceAgain = await login('alice');
  assert.equal((await (await getState(aliceAgain.Cookie)).json()).draft.subject, 'Alice private draft');
});
