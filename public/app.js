const $ = id => document.getElementById(id);
let csrf = '', state = null, dirty = false, rows = [], csvName = '', attachment = null, previews = [], previewSender = '', previewAttachment = null;
let online = false, working = false, toastTimer, loadingState = false;
const fields = ['sender', 'subject', 'message', 'recipients'];
function toast(text, error = false) { clearTimeout(toastTimer); $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false; toastTimer = setTimeout(() => $('toast').hidden = true, error ? 9000 : 4000); }
async function api(url, data) {
  const response = await fetch(url, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401 && !$('loginDialog').open) $('loginDialog').showModal(); throw new Error(result.error || 'Request failed.'); }
  return result;
}
function draft() { return Object.fromEntries([...fields.map(key => [key, $(key).value]), ['rows', rows], ['csvName', csvName], ['attachment', attachment]]); }
function loadDraft(value) { for (const key of fields) $(key).value = value[key]; rows = value.rows; csvName = value.csvName; attachment = value.attachment; dirty = false; updateEditor(); }
function recipientCount() { return new Set([...rows.map(r => r.email), ...$('recipients').value.split(/[\s,;]+/)].map(v => v.trim().toLowerCase()).filter(Boolean)).size; }
function updateEditor() {
  $('charCount').textContent = `${$('message').value.length.toLocaleString()} characters`;
  const count = recipientCount(); $('recipientCount').textContent = count; $('totalCount').textContent = state?.locked ? state.total : count;
  $('csvSummary').hidden = !rows.length; $('csvName').textContent = `${csvName || 'CSV'} · ${rows.length} rows`;
  $('pdfName').textContent = attachment?.name || 'Add a little more context'; $('pdfHint').textContent = attachment ? 'PDF attached to each email' : 'Attach a PDF · up to 10 MB · optional';
  $('removePdf').hidden = !attachment; $('pdfPick').textContent = attachment ? 'Change PDF' : 'Choose PDF';
  $('draftLabel').textContent = dirty ? 'Unsaved changes' : 'Draft saved';
}
function markDirty() { dirty = true; updateEditor(); }
function renderState() {
  if (!state) return;
  const active = ['running', 'sending', 'pausing'].includes(state.status);
  document.querySelectorAll('.draft-field').forEach(el => el.disabled = state.locked || working || !online);
  const google = state.google || {};
  $('connectGoogle').disabled = !online || active || working || !google.configured;
  $('connectGoogle').textContent = google.email ? 'Reconnect with Google' : 'Sign in with Google';
  $('disconnectGoogle').hidden = !google.email;
  $('disconnectGoogle').disabled = active || working;
  $('googleStatus').textContent = google.email ? `Connected as ${google.email}` : google.configured ? 'Sign in and allow email sending to connect.' : 'Google setup required: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env (see README.md), then restart.';
  if (!state.locked && google.email) $('sender').value = google.email;
  $('start').disabled = !online || working || !state.google?.email || active || !!state.pending || state.status === 'complete';
  $('start').textContent = state.locked ? (state.status === 'complete' ? 'Campaign complete' : 'Resume sending') : 'Start sending ▷';
  $('pause').hidden = !active; $('pause').disabled = working || state.status === 'pausing';
  $('saveDraft').disabled = !online || working || state.locked;
  $('newCampaign').disabled = !online || working || active || !!state.pending;
  $('preview').disabled = !online || working;
  $('stopServer').hidden = !state.localServer;
  $('stopServer').disabled = !online || working;
  $('statusBadge').textContent = state.status;
  const descriptions = { draft: 'Make something worth opening.', running: 'Your queue is moving at a thoughtful pace.', sending: 'Sending one personal email…', pausing: 'Finishing the current email, then pausing.', paused: 'Paused. Resume whenever you’re ready.', complete: 'All done. Every recipient has been processed.', uncertain: 'Check the last delivery before continuing.' };
  $('statusText').textContent = descriptions[state.status] || state.status;
  $('errorPanel').hidden = !state.error; $('errorPanel').textContent = state.error;
  $('uncertain').hidden = state.status !== 'uncertain';
  $('uncertainText').textContent = `The attempt to ${state.pending || ''} was interrupted. Check Gmail Sent or provider logs, then choose what happened. Nothing will retry automatically.`;
  $('activityCount').textContent = state.sent.length;
  $('sentCount').textContent = `${state.sent.length} accepted by Gmail`;
  $('progressFill').style.width = `${state.total ? state.sent.length / state.total * 100 : 0}%`;
  $('queueSummary').textContent = `${state.sent.length} of ${state.total} emails accepted by the mail server. Server acceptance does not guarantee inbox delivery.`;
  $('emptyActivity').hidden = state.sent.length > 0;
  const tbody = $('activityRows'); tbody.replaceChildren();
  for (const sent of [...state.sent].reverse()) {
    const row = document.createElement('tr');
    for (const value of [sent.email, 'Accepted by Gmail', new Date(sent.at).toLocaleString()]) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
    tbody.append(row);
  }
  updateEditor(); updateCountdown();
}
let timeOffset = 0, googleNotice = null;
function updateCountdown() {
  if (!state) return;
  if (state.status === 'running' && state.nextAt) {
    const seconds = Math.max(0, Math.ceil((state.nextAt - (Date.now() + timeOffset)) / 1000));
    $('scheduleTitle').textContent = `Next email in ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    $('scheduleNote').textContent = 'You can close this tab. Keep the server running.';
  } else {
    $('scheduleTitle').textContent = state.status === 'sending' ? 'Sending your email…' : state.status === 'complete' ? 'That’s a wrap.' : 'A thoughtful pace, automatically.';
    $('scheduleNote').textContent = state.locked ? 'Progress is saved. Each recipient is processed once.' : 'First email sends now, then one every 10 minutes.';
  }
}
async function refresh(full = false) {
  if (loadingState) return;
  loadingState = true;
  try {
    const next = await api(`/api/state${full ? '?draft=1' : ''}`);
    if (state && next.id !== state.id && !full) { loadingState = false; return refresh(true); }
    state = next; csrf = next.csrf; timeOffset = next.serverTime - Date.now(); online = true;
    $('connection').textContent = 'Server connected'; $('connection').classList.add('online');
    if (next.draft) loadDraft(next.draft);
    renderState();
    if (next.googleNotice && next.googleNotice !== googleNotice) { googleNotice = next.googleNotice; toast(next.googleNotice); }
  } catch { online = false; $('connection').textContent = 'Server disconnected'; $('connection').classList.remove('online'); renderState(); }
  finally { loadingState = false; }
}
async function action(work) {
  if (working) return;
  working = true; renderState();
  try { await work(); await refresh(); } catch (error) { toast(error.message, true); }
  finally { working = false; renderState(); }
}
async function saveDraft() { await api('/api/draft', { draft: draft() }); dirty = false; updateEditor(); }
for (const key of fields) $(key).addEventListener('input', markDirty);
$('saveDraft').onclick = () => action(async () => { await saveDraft(); toast('Draft saved.'); });
$('insertName').onclick = () => { const text = $('message'); text.setRangeText('{{name}}', text.selectionStart, text.selectionEnd, 'end'); markDirty(); text.focus(); };
$('connectGoogle').onclick = () => action(async () => {
  if (!state.locked) await saveDraft();
  const result = await api('/api/google/connect', {});
  window.location.assign(result.url);
});
$('disconnectGoogle').onclick = () => action(async () => { await api('/api/google/disconnect', {}); toast('Google account disconnected from Mail Studio.'); });
$('csvFile').onchange = event => action(async () => {
  const file = event.target.files[0]; if (!file) return;
  if (file.size > 2 * 1024 * 1024) throw new Error('CSV must be 2 MB or smaller.');
  const result = await api('/api/csv', { csv: await file.text() }); rows = result.rows; csvName = file.name; markDirty(); toast(`${rows.length} CSV recipients imported.`); event.target.value = '';
});
$('removeCsv').onclick = () => { rows = []; csvName = ''; $('csvFile').value = ''; markDirty(); };
$('pdfFile').onchange = event => action(async () => {
  const file = event.target.files[0]; if (!file) return;
  if (file.size > 10 * 1024 * 1024) throw new Error('PDF must be 10 MB or smaller.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('Choose a valid PDF file.');
  const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('Could not read the PDF.')); reader.readAsDataURL(file); });
  attachment = { name: file.name, base64 }; markDirty(); toast('PDF attached.'); event.target.value = '';
});
$('removePdf').onclick = () => { attachment = null; $('pdfFile').value = ''; markDirty(); };
$('start').onclick = () => action(async () => {
  if (!state.google?.email) throw new Error('Sign in with Google in Sending account first.');
  if (!state.locked) await saveDraft();
  await api('/api/start', {}); toast('Queue started. Your first email will send when due.');
});
$('pause').onclick = () => action(async () => { await api('/api/pause', {}); toast('Pause requested. Any email in progress will finish first.'); });
$('stopServer').onclick = () => { if (confirm('Stop the local server? The current email will finish, then the queue will pause. Double-click Start Mail Studio.vbs to open it again.')) action(async () => { await api('/api/shutdown', {}); toast('Server is stopping. Progress is saved.'); }); };
$('markSent').onclick = () => action(async () => { await api('/api/resolve', { delivered: true }); toast('Marked as sent. You can resume the queue.'); });
$('markNotSent').onclick = () => action(async () => { await api('/api/resolve', { delivered: false }); toast('Marked for retry. It will retry only when you resume.'); });
$('newCampaign').onclick = () => $('newDialog').showModal();
$('cancelNew').onclick = () => $('newDialog').close();
$('confirmNew').onclick = () => action(async () => { if (!state.locked) await saveDraft(); await api('/api/new', {}); $('newDialog').close(); await refresh(true); toast('Fresh campaign ready. Review before sending.'); });
function showPreview() { const message = previews[Number($('previewRecipient').value)]; if (!message) return; $('previewFrom').textContent = previewSender; $('previewTo').textContent = message.to; $('previewSubject').textContent = message.subject; $('previewBody').textContent = message.text; $('previewAttachment').hidden = !previewAttachment; $('previewAttachment').textContent = `PDF · ${previewAttachment}`; }
$('preview').onclick = () => action(async () => {
  const result = await api('/api/preview', { draft: draft() }); previews = result.messages; previewSender = result.sender; previewAttachment = result.attachment;
  $('previewRecipient').replaceChildren(...previews.map((message, index) => new Option(message.to, index))); showPreview(); $('previewDialog').showModal();
});
$('previewRecipient').onchange = showPreview;
$('closePreview').onclick = () => $('previewDialog').close();
function tab(activity) { $('composeView').hidden = activity; $('activityView').hidden = !activity; $('composeNav').classList.toggle('active', !activity); $('activityNav').classList.toggle('active', activity); $('breadcrumb').textContent = activity ? 'Sending activity' : 'Compose'; for (const id of ['composeNav', 'activityNav']) $(id).removeAttribute('aria-current'); $(activity ? 'activityNav' : 'composeNav').setAttribute('aria-current', 'page'); }
$('composeNav').onclick = () => tab(false); $('activityNav').onclick = () => tab(true);
$('loginDialog').addEventListener('cancel', e => e.preventDefault());
$('loginForm').onsubmit = async event => { event.preventDefault(); try { await api('/api/login', { password: $('loginPassword').value }); $('loginPassword').value = ''; $('loginDialog').close(); await refresh(true); } catch (error) { $('loginError').textContent = error.message; } };
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
await refresh(true); setInterval(() => { if (!$('loginDialog').open) refresh(); }, 2000); setInterval(updateCountdown, 1000);
