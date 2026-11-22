import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse } from 'csv-parse/sync';

export const INTERVAL = 10 * 60 * 1000;
export const emptyDraft = () => ({ sender: '', subject: '', message: '', recipients: '', rows: [], csvName: '', attachment: null });
export function email(value) {
  const address = String(value || '').trim();
  if (address.length > 254 || !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(address)) throw new Error(`Invalid email address: ${address}`);
  return address;
}
export function readCSV(text) {
  const rows = parse(text, { columns: headers => headers.map(h => h.trim().toLowerCase()), bom: true, skip_empty_lines: true, trim: true, max_record_size: 100000 });
  if (!rows.length || !Object.hasOwn(rows[0], 'email')) throw new Error('CSV must have an email column and at least one recipient.');
  if (rows.length > 5000) throw new Error('Import up to 5,000 recipients per campaign.');
  for (const row of rows) row.email = email(row.email);
  return rows;
}
export function personalize(text, row) {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => {
    if (!Object.hasOwn(row, key)) throw new Error(`Missing CSV column "${key}" for ${row.email}. Pasted addresses only have an email field.`);
    return String(row[key]);
  });
}
export function cleanDraft(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid draft.');
  const draft = emptyDraft();
  for (const key of ['sender', 'subject', 'message', 'recipients', 'csvName']) draft[key] = String(value[key] ?? draft[key]);
  if (draft.subject.length > 500 || /[\r\n]/.test(draft.subject)) throw new Error('Subject must be a single line, up to 500 characters.');
  if (draft.message.length > 100000 || draft.recipients.length > 500000) throw new Error('Draft is too large.');
  if (!Array.isArray(value.rows) || value.rows.length > 5000) throw new Error('Invalid CSV recipient list.');
  draft.rows = value.rows.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid CSV row.');
    const result = Object.create(null);
    for (const [key, item] of Object.entries(row)) {
      if (typeof item !== 'string' || item.length > 10000) throw new Error('Invalid CSV field.');
      result[key] = item;
    }
    return result;
  });
  if (value.attachment) {
    const { name, base64 } = value.attachment;
    if (typeof name !== 'string' || typeof base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Invalid attachment.');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > 10 * 1024 * 1024) throw new Error('PDF must be 10 MB or smaller.');
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Please attach a PDF file.');
    draft.attachment = { name: path.basename(name.replaceAll('\\', '/')).replace(/[\r\n]/g, '').slice(0, 150) || 'attachment.pdf', base64 };
  }
  return draft;
}
export function prepare(value) {
  const draft = cleanDraft(value);
  draft.sender = email(draft.sender);
  if (!draft.subject.trim() || !draft.message.trim()) throw new Error('Add a subject and message before starting.');
  const rows = [...draft.rows, ...draft.recipients.split(/[\s,;]+/).filter(Boolean).map(email => ({ email }))];
  const seen = new Set();
  const messages = [];
  for (const row of rows) {
    const to = email(row.email);
    const key = to.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const subject = personalize(draft.subject, row);
    if (/[\r\n]/.test(subject)) throw new Error('Personalized subjects cannot contain line breaks.');
    messages.push({ key, to, subject, text: personalize(draft.message, row) });
  }
  if (!messages.length) throw new Error('Add recipients or import a CSV first.');
  if (messages.length > 5000) throw new Error('Use up to 5,000 recipients per campaign.');
  return { draft, messages };
}

export class Campaign {
  constructor({ file, send, now = Date.now, interval = INTERVAL }) {
    this.file = file; this.send = send; this.now = now; this.interval = interval;
    this.busy = false;
    this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { id: randomUUID(), draft: emptyDraft(), sent: [], pending: null, lastSent: 0, locked: false, status: 'draft', error: '' };
    if (['running', 'sending', 'pausing'].includes(this.state.status)) this.state.status = 'paused';
    if (this.state.pending) this.state.status = 'uncertain';
    this.persist();
  }
  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
  view() {
    let messages = [];
    try { messages = prepare(this.state.draft).messages; } catch {}
    return { ...this.state, busy: this.busy, total: messages.length, interval: this.interval, nextAt: this.state.status === 'running' ? Math.max(this.now(), this.state.lastSent + this.interval) : null, serverTime: this.now() };
  }
  saveDraft(draft) {
    if (this.state.locked || this.busy) throw new Error('This campaign has started. Create a new campaign to edit its content.');
    this.state.draft = cleanDraft(draft); this.state.error = ''; this.persist();
  }
  start() {
    if (this.busy || this.state.status === 'running') throw new Error('The queue is already running.');
    if (this.state.pending) throw new Error('Resolve the uncertain delivery before resuming.');
    const { messages } = prepare(this.state.draft);
    if (messages.every(m => this.state.sent.some(s => s.email === m.key))) throw new Error('This campaign is complete. Start a new campaign to send again.');
    this.state.locked = true; this.state.status = 'running'; this.state.error = ''; this.persist();
  }
  pause() {
    this.state.status = this.busy ? 'pausing' : (this.state.pending ? 'uncertain' : 'paused');
    this.persist();
  }
  newCampaign() {
    if (this.busy || this.state.status === 'running') throw new Error('Pause the queue before creating a new campaign.');
    if (this.state.pending) throw new Error('Resolve uncertain delivery before creating a new campaign.');
    const { draft, lastSent } = this.state;
    this.state = { id: randomUUID(), draft, lastSent, sent: [], pending: null, locked: false, status: 'draft', error: '' };
    this.persist();
  }
  resolve(delivered) {
    if (this.busy || !this.state.pending) throw new Error('There is no uncertain delivery to resolve.');
    if (typeof delivered !== 'boolean') throw new Error('Choose whether the email was delivered.');
    if (delivered) this.state.sent.push({ email: this.state.pending, at: this.now() });
    this.state.pending = null; this.state.lastSent = this.now(); this.state.status = 'paused'; this.state.error = ''; this.persist();
  }
  async tick() {
    if (this.busy || this.state.status !== 'running' || this.now() < this.state.lastSent + this.interval) return;
    const { draft, messages } = prepare(this.state.draft);
    const msg = messages.find(m => !this.state.sent.some(s => s.email === m.key));
    if (!msg) { this.state.status = 'complete'; this.persist(); return; }
    this.busy = true;
    try {
      this.state.pending = msg.key; this.state.status = 'sending'; this.persist();
      await this.send({ draft, message: msg });
      this.state.sent.push({ email: msg.key, at: this.now() });
      this.state.pending = null; this.state.lastSent = this.now();
      this.state.status = this.state.sent.length === messages.length ? 'complete' : this.state.status === 'pausing' ? 'paused' : 'running';
      this.persist();
    } catch (error) {
      // Authentication or permission rejection is safe to resume; other failures can be ambiguous.
      if (error.code === 'EAUTH') {
        this.state.pending = null;
        this.state.status = 'paused';
        this.state.error = 'Google could not authorize sending. Reconnect the sending account and check Gmail API access.';
      } else {
        this.state.status = 'uncertain';
        this.state.error = 'Sending was interrupted. Check Gmail Sent or provider logs before choosing whether to retry.';
      }
      this.persist();
    } finally {
      this.busy = false;
    }
  }
}
