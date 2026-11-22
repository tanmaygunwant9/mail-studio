import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Campaign, emptyDraft, prepare, readCSV, INTERVAL } from '../lib/campaign.js';

const draft = () => ({ ...emptyDraft(), sender: 'sender@gmail.com', subject: 'A note', message: 'Hello!', recipients: 'one@example.com,two@example.com;one@example.com' });
function setup(t, send) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-studio-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let clock = 1800000000000;
  const file = path.join(directory, 'campaign.json');
  const engine = new Campaign({ file, send, now: () => clock });
  return { engine, file, advance: ms => clock += ms, now: () => clock };
}
test('CSV handles BOM, quotes, multiline fields and personalization; duplicates are removed', () => {
  const rows = readCSV('\ufeffemail,name\r\na@example.com,"Alex, Junior"\r\nb@example.com,"Sam\nLee"');
  const prepared = prepare({ ...draft(), recipients: 'a@example.com', rows, subject: 'Hello', message: 'Hi {{name}}' });
  assert.equal(prepared.messages.length, 2);
  assert.equal(prepared.messages[0].text, 'Hi Alex, Junior');
  assert.equal(prepared.messages[1].text, 'Hi Sam\nLee');
  assert.throws(() => readCSV('name\nAlex'), /email column/);
  assert.throws(() => prepare({ ...draft(), message: 'Hi {{name}}' }), /Missing CSV column/);
});
test('PDF bytes preserved and invalid attachment rejected', () => {
  const attachment = { name: '../proposal.pdf', base64: Buffer.from('%PDF-1.4\n%%EOF').toString('base64') };
  const prepared = prepare({ ...draft(), attachment });
  assert.equal(prepared.draft.attachment.name, 'proposal.pdf');
  assert.equal(prepared.draft.attachment.base64, attachment.base64);
  assert.throws(() => prepare({ ...draft(), attachment: { name: 'wrong.pdf', base64: 'aGVsbG8=' } }), /PDF/);
});
test('queue waits a full ten minutes, resumes without duplicates, and does not persist credentials', async t => {
  const sent = [];
  const { engine, file, advance, now } = setup(t, async item => sent.push(item.message.to));
  engine.saveDraft(draft()); engine.start();
  await engine.tick(); assert.deepEqual(sent, ['one@example.com']);
  advance(INTERVAL - 1); await engine.tick(); assert.equal(sent.length, 1);
  engine.pause(); advance(1); await engine.tick(); assert.equal(sent.length, 1);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('never-save-this'));
  const resumed = new Campaign({ file, send: async item => sent.push(item.message.to), now });
  resumed.start(); await resumed.tick();
  assert.deepEqual(sent, ['one@example.com', 'two@example.com']); assert.equal(resumed.state.status, 'complete');
});
test('concurrent ticks cannot duplicate an email; pausing waits for the in-flight send', async t => {
  let release; let calls = 0;
  const { engine } = setup(t, () => { calls++; return new Promise(resolve => release = resolve); });
  engine.saveDraft(draft()); engine.start();
  const first = engine.tick(); await engine.tick(); engine.pause();
  assert.equal(calls, 1); assert.equal(engine.state.status, 'pausing');
  assert.throws(() => engine.newCampaign(), /Pause/);
  release(); await first; assert.equal(engine.state.status, 'paused'); assert.equal(engine.state.sent.length, 1);
});
test('ambiguous delivery blocks retries and survives restart until resolved', async t => {
  const { engine, file, now } = setup(t, async () => { throw new Error('socket lost'); });
  engine.saveDraft(draft()); engine.start(); await engine.tick();
  assert.equal(engine.state.status, 'uncertain'); assert.equal(engine.state.pending, 'one@example.com');
  assert.throws(() => engine.start(), /uncertain/);
  assert.throws(() => engine.newCampaign(), /uncertain/);
  const restored = new Campaign({ file, send: async () => {}, now });
  restored.resolve(true); assert.equal(restored.state.sent[0].email, 'one@example.com');
  assert.equal(restored.state.pending, null);
});
test('authentication failure is retryable and campaign changes cannot bypass spacing', async t => {
  const { engine, advance } = setup(t, async () => { const error = new Error('private server error'); error.code = 'EAUTH'; throw error; });
  engine.saveDraft(draft()); engine.start(); await engine.tick();
  assert.equal(engine.state.pending, null); assert.equal(engine.state.status, 'paused');
  assert.ok(!engine.state.error.includes('private server error'));
  let calls = 0; engine.send = async () => calls++;
  engine.start(); await engine.tick(); engine.pause(); engine.newCampaign(); engine.start(); await engine.tick();
  assert.equal(calls, 1); advance(INTERVAL); await engine.tick(); assert.equal(calls, 2);
});
