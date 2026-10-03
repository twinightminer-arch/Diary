// SPDX-License-Identifier: AGPL-3.0-only
import { call } from './api.ts';
import type { Entry, EntrySummary, MarkdownDocument } from './api.ts';
import { locale, t } from './copy.ts';
import { decryptContent, isEncrypted } from '../security/encryption.ts';
import { parseMarkdown } from '../storage/markdown.ts';
import { advanceCampusCase, applicationText, campusServices, createCampusCase, matchCampusService } from './campus.ts';
import type { CampusCase, CampusProfile, CampusService } from './campus.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const title = $<HTMLInputElement>('title'), editor = $<HTMLTextAreaElement>('editor');
let current: Entry | null = null, password: string | undefined, dirty = false, draft = false, busy = false;
let entries: (EntrySummary & { title: string; snippet: string })[] = [];
let toastTimer: ReturnType<typeof setTimeout>;
let unlocked = true;
let selected = new Set<string>();
let appMode: 'diary' | 'campus' = localStorage.getItem('diary.mode') === 'campus' ? 'campus' : 'diary';
let activeCaseId: string | null = null;
type Field = { name: string; label: string; type?: string; options?: [string, string][] };
function modal(heading: string, message = '', fields: Field[] = []): Promise<Record<string, string> | null> {
  const dialog = $<HTMLDialogElement>('modal');
  $('modalTitle').textContent = heading; $('modalMessage').textContent = message;
  $('modalFields').replaceChildren(); $('modalError').textContent = '';
  for (const field of fields) {
    const label = document.createElement('label'); label.textContent = field.label;
    const input = document.createElement(field.options ? 'select' : 'input') as HTMLInputElement | HTMLSelectElement;
    input.name = field.name;
    if (input instanceof HTMLInputElement) { input.type = field.type ?? 'password'; input.required = true; input.autocomplete = 'off'; }
    if (field.options) {
      for (const [value, text] of field.options) { const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option); }
      input.value = locale.locale;
    }
    label.append(input); $('modalFields').append(label);
  }
  dialog.showModal();
  return new Promise(resolve => {
    const finish = (result: Record<string, string> | null) => {
      dialog.close(); $('modalForm').onsubmit = null; $('modalCancel').onclick = null; dialog.oncancel = null; resolve(result);
    };
    $('modalCancel').onclick = () => finish(null);
    dialog.oncancel = event => { event.preventDefault(); finish(null); };
    $('modalForm').onsubmit = event => {
      event.preventDefault();
      const result = Object.fromEntries(new FormData($<HTMLFormElement>('modalForm')).entries()) as Record<string, string>;
      if (result.confirmation !== undefined && result.confirmation !== result.next) { $('modalError').textContent = t('passwordMismatch'); return; }
      if (result.next !== undefined && result.next.length < 8) { $('modalError').textContent = t('passwordShort'); return; }
      finish(result);
    };
    ($('modalFields').querySelector('input,select') as HTMLElement | null)?.focus();
  });
}
function toast(message: string) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function localizedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /passcode|damaged|OperationError/i.test(message) ? t('wrongPassword') : message;
}
function action(operation: () => Promise<unknown>) {
  return async () => {
    if (busy) return;
    busy = true;
    try { await operation(); } catch (error) { toast(localizedError(error)); }
    finally { busy = false; }
  };
}
function translate() {
  document.documentElement.lang = locale.locale;
  document.querySelectorAll<HTMLElement>('[data-i]').forEach(element => { element.textContent = t(element.dataset.i!); });
  document.querySelectorAll<HTMLInputElement>('[data-placeholder]').forEach(element => { element.placeholder = t(element.dataset.placeholder!); });
  $('breadcrumbDate').textContent = locale.date(Date.now(), { month: 'long', day: 'numeric', weekday: 'long' });
  renderList(); renderServices(campusServices); renderCaseList(); status();
}
function status() {
  $('saveState').textContent = t(dirty ? 'unsaved' : 'saved');
  $('wordCount').textContent = `${Array.from(editor.value).length.toLocaleString(locale.locale)} ${t('characters')}`;
  $('securityBadge').textContent = t(current?.encrypted ? 'protected' : 'plain');
  $('encrypt').hidden = !!current?.encrypted; $('lock').hidden = !current?.encrypted;
  $('changePassword').hidden = !current?.encrypted; $('decrypt').hidden = !current?.encrypted;
}
async function refresh() {
  const all = await call<EntrySummary[]>({ op: 'list' });
  entries = await Promise.all(all.map(async item => {
    if (item.encrypted) return { ...item, title: t('encryptedEntry'), snippet: '' };
    const content = await call<Entry>({ op: 'read', id: item.id });
    return { ...item, title: String(content.metadata.title || t('untitled')), snippet: content.body.slice(0, 500) };
  }));
  entries.reverse(); renderList();
}
function renderList() {
  const filter = $<HTMLInputElement>('search').value.trim().toLocaleLowerCase();
  const visible = entries.filter(entry => `${entry.id} ${entry.title} ${entry.snippet}`.toLocaleLowerCase().includes(filter));
  $('entryCount').textContent = String(entries.length); $('entries').replaceChildren();
  for (const entry of visible) {
    const button = document.createElement('button'); button.className = `entry-card${current?.id === entry.id ? ' selected' : ''}`;
    if (selected.has(entry.id)) button.classList.add('selected');
    const check = document.createElement('input'); check.type = 'checkbox'; check.className = 'entry-check';
    check.checked = selected.has(entry.id);
    check.onclick = event => { event.stopPropagation(); toggleSelect(entry.id, check.checked); };
    const heading = document.createElement('span'); heading.className = 'card-title'; heading.textContent = entry.encrypted ? `◇ ${t('encryptedEntry')}` : entry.title;
    const date = document.createElement('small'); date.textContent = entry.id.slice(0, 10);
    button.append(check, heading, date); button.onclick = action(() => selectEntry(entry)); $('entries').append(button);
  }
  if (!visible.length) { const empty = document.createElement('p'); empty.className = 'no-entries'; empty.textContent = t(filter ? 'noResults' : 'emptyList'); $('entries').append(empty); }
  $('batchBar').hidden = selected.size === 0;
  $('batchCount').textContent = String(selected.size);
}
function toggleSelect(id: string, on: boolean) {
  if (on) selected.add(id); else selected.delete(id);
  renderList();
}
async function mayDiscard() { return !dirty || !!await modal(t('discard')); }
function show(entry: Entry, isDraft = false) {
  current = entry; draft = isDraft; dirty = isDraft;
  title.value = String(entry.metadata.title || ''); editor.value = entry.body;
  $('empty').hidden = true; $('workspace').hidden = false; $('moreMenu').hidden = true;
  $('entryDate').textContent = entry.id.slice(0, 10); view(false); status(); renderList();
  document.body.classList.remove('sidebar-open');
}
async function selectEntry(entry: EntrySummary) {
  if (!unlocked) return;
  if (!await mayDiscard()) return;
  let passcode: string | undefined;
  if (entry.encrypted) {
    const response = await modal(t('unlock'), t('unlockHint'), [{ name: 'password', label: t('password') }]);
    if (!response) return; passcode = response.password;
  }
  const content = await call<Entry>({ op: 'read', id: entry.id, ...(passcode === undefined ? {} : { passcode }) });
  password = passcode; show(content);
}
function newId(): string {
  const date = new Date(), local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  return `${local}-${crypto.randomUUID().slice(0, 8)}`;
}
async function newEntry() {
  if (!unlocked) return;
  if (!await mayDiscard()) return;
  password = undefined;
  show({ id: newId(), encrypted: false, metadata: { created: new Date().toISOString() }, body: '' }, true);
  title.focus();
}
async function save(): Promise<void> {
  if (!current) return;
  const snapshot: MarkdownDocument = { metadata: { ...current.metadata, title: title.value.trim() || t('untitled'), updated: new Date().toISOString() }, body: editor.value };
  current = await call<Entry>({ op: draft ? 'create' : 'update', id: current.id, document: snapshot, ...(password === undefined ? {} : { passcode: password }) });
  draft = false;
  dirty = editor.value !== snapshot.body || (title.value.trim() || t('untitled')) !== snapshot.metadata.title;
  status(); await refresh();
}
function clear() {
  current = null; password = undefined; dirty = false; draft = false; title.value = ''; editor.value = '';
  $('preview').replaceChildren(); $('workspace').hidden = true; $('empty').hidden = false; renderList();
}
function inline(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const regex = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*|!\[([^\]]*)\]\(([^)]+)\))/g;
  let last = 0;
  for (const match of text.matchAll(regex)) {
    fragment.append(document.createTextNode(text.slice(last, match.index)));
    const element = document.createElement(match[2] ? 'strong' : match[3] ? 'code' : match[4] ? 'em' : 'img');
    if (element instanceof HTMLImageElement) { element.alt = match[5] || ''; element.src = match[6] || ''; }
    else element.textContent = match[2] || match[3] || match[4] || '';
    fragment.append(element); last = match.index! + match[0].length;
  }
  fragment.append(document.createTextNode(text.slice(last))); return fragment;
}
function renderMarkdown() {
  const root = $('preview'); root.replaceChildren(); let code: string[] | null = null;
  for (const line of editor.value.split(/\r?\n/)) {
    if (line.startsWith('```')) {
      if (code) { const pre = document.createElement('pre'); pre.textContent = code.join('\n'); root.append(pre); code = null; } else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    const image = /^!\[(.*)\]\((.*)\)$/.exec(line.trim());
    if (image) { const img = document.createElement('img'); img.alt = image[1] ?? ''; img.src = image[2] ?? ''; img.className = 'md-image'; root.append(img); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const tag = heading ? `h${heading[1]!.length}` : /^>\s?/.test(line) ? 'blockquote' : /^---+$/.test(line) ? 'hr' : 'p';
    const element = document.createElement(tag);
    const value = heading ? heading[2]! : line.replace(/^>\s?/, '').replace(/^[-*]\s+/, '• ');
    element.append(inline(value || '\u00a0')); root.append(element);
  }
  if (code) { const pre = document.createElement('pre'); pre.textContent = code.join('\n'); root.append(pre); }
}
function view(preview: boolean) {
  editor.hidden = preview; $('preview').hidden = !preview;
  $('editTab').classList.toggle('active', !preview); $('previewTab').classList.toggle('active', preview);
  if (preview) renderMarkdown();
}

// ---------- Lock screen & accounts ----------
function showLock(firstTime = false) {
  unlocked = false;
  $('lockScreen').hidden = false;
  $('lockHint').textContent = firstTime ? t('encryptHint') : t('unlockHint');
  $('lockSet').hidden = !firstTime;
  $('lockClear').hidden = firstTime;
  ($('lockPasscode') as HTMLInputElement).value = '';
  ($('lockPasscode') as HTMLInputElement).focus();
}
function hideLock() { unlocked = true; $('lockScreen').hidden = true; }
async function unlockWith(passcode: string): Promise<boolean> {
  const result = await call<{ ok: boolean }>({ op: 'account:verifyLocal', passcode });
  if (result.ok) { hideLock(); return true; }
  toast(t('wrongPassword')); return false;
}
$('lockSubmit').onclick = action(async () => {
  const passcode = ($('lockPasscode') as HTMLInputElement).value;
  if (!passcode) return;
  await unlockWith(passcode);
});
$('lockSet').onclick = action(async () => {
  const passcode = ($('lockPasscode') as HTMLInputElement).value;
  if (passcode.length < 4) { toast(t('passwordShort')); return; }
  await call({ op: 'account:setLocal', passcode });
  hideLock(); toast(t('done')); await refresh();
});
$('lockClear').onclick = action(async () => {
  if (!await modal(t('deleteEntry'), t('deleteHint'))) return;
  await call({ op: 'account:clearLocal' });
  toast(t('done'));
});
$('lockNow').onclick = () => showLock(false);
$('lockPasscode').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('lockSubmit').click(); } });

// ---------- Settings panel ----------
async function loadConfig() {
  const cfg = await call<{
    activeProvider: string; providers: { id: string; baseUrl: string; model: string; hasKey: boolean }[];
    profile: { username: string; avatar: string | null; signature: string };
    media: { background: string | null; bgm: string | null };
    hasLocalAccount: boolean; oauthClients: Record<string, string>;
  }>({ op: 'config:get' });
  const sel = $<HTMLSelectElement>('cfgProvider'); sel.replaceChildren();
  for (const p of cfg.providers) { const opt = document.createElement('option'); opt.value = p.id; opt.textContent = `${p.id} · ${p.model || p.baseUrl}`; sel.append(opt); }
  sel.value = cfg.activeProvider;
  $<HTMLInputElement>('cfgBaseUrl').value = cfg.providers.find(p => p.id === cfg.activeProvider)?.baseUrl ?? '';
  $<HTMLInputElement>('cfgModel').value = cfg.providers.find(p => p.id === cfg.activeProvider)?.model ?? '';
  $<HTMLInputElement>('cfgApiKey').value = '';
  $<HTMLInputElement>('profileUsername').value = cfg.profile.username;
  $<HTMLInputElement>('profileSignature').value = cfg.profile.signature;
  $('accountState').textContent = cfg.hasLocalAccount ? t('localAccountOn') : t('localAccountOff');
  $('lockNow').hidden = !cfg.hasLocalAccount;
  $<HTMLInputElement>('googleClientId').value = cfg.oauthClients.google ?? '';
  $<HTMLInputElement>('microsoftClientId').value = cfg.oauthClients.microsoft ?? '';
  const student = campusProfile();
  $<HTMLInputElement>('studentName').value = student.name; $<HTMLInputElement>('studentId').value = student.studentId;
  $<HTMLInputElement>('studentSchool').value = student.school; $<HTMLInputElement>('studentCollege').value = student.college;
  $<HTMLInputElement>('studentMajor').value = student.major; $<HTMLInputElement>('studentGrade').value = student.grade;
  $<HTMLInputElement>('studentPhone').value = student.phone; $<HTMLInputElement>('studentEmail').value = student.email;
  if (cfg.profile.avatar) {
    const url = await call<string>({ op: 'media:data', id: cfg.profile.avatar });
    const img = $<HTMLImageElement>('profileAvatarPreview'); img.src = url; img.hidden = false;
  }
  await applyMedia(cfg.media);
  await renderGallery();
}
function applyMedia(media: { background: string | null; bgm: string | null }) {
  if (media.background) {
    call<string>({ op: 'media:data', id: media.background })
      .then(url => { document.body.style.setProperty('--diary-bg', `url(${JSON.stringify(url)})`); document.body.classList.add('has-bg'); })
      .catch(() => undefined);
  } else {
    document.body.style.removeProperty('--diary-bg'); document.body.classList.remove('has-bg');
  }
  const player = $<HTMLAudioElement>('bgmPlayer');
  if (media.bgm) {
    call<string>({ op: 'media:data', id: media.bgm })
      .then(url => { player.src = url; void player.play().catch(() => undefined); })
      .catch(() => undefined);
  } else { player.pause(); player.removeAttribute('src'); }
}
/** Renders the imported-media gallery: click a tile to insert it, × to delete it. */
async function renderGallery() {
  const list = await call<{ id: string; name: string; mime: string; size: number }[]>({ op: 'media:list' });
  const gallery = $('mediaGallery'); gallery.replaceChildren();
  for (const item of list) {
    const tile = document.createElement('button');
    tile.title = `${item.name} · ${Math.max(1, Math.round(item.size / 1024))} KB`;
    if (item.size <= 8 * 1024 * 1024 && (item.mime.startsWith('image') || item.mime.startsWith('video'))) {
      const url = await call<string>({ op: 'media:data', id: item.id });
      const thumb = item.mime.startsWith('video') ? document.createElement('video') : document.createElement('img');
      thumb.src = url;
      if (thumb instanceof HTMLVideoElement) { thumb.muted = true; thumb.preload = 'metadata'; }
      else thumb.alt = item.name;
      tile.append(thumb);
    } else {
      const fallback = document.createElement('span');
      fallback.className = 'media-fallback';
      fallback.textContent = item.mime.split('/').pop() || item.name;
      tile.append(fallback);
    }
    const caption = document.createElement('span'); caption.className = 'media-name'; caption.textContent = item.name;
    const remove = document.createElement('span'); remove.className = 'media-remove'; remove.textContent = '×'; remove.title = t('clearMedia');
    remove.onclick = (event: MouseEvent) => {
      event.stopPropagation();
      void action(async () => { await call({ op: 'media:remove', id: item.id }); await renderGallery(); })();
    };
    tile.onclick = action(async () => {
      const url = await call<string>({ op: 'media:data', id: item.id });
      insertText(`![${item.name}](${url})`); toast(t('done'));
    });
    tile.append(caption, remove); gallery.append(tile);
  }
}
function openSettings() { $('settingsPanel').hidden = false; }
$('settings').onclick = action(async () => { await loadConfig(); openSettings(); });
$('settingsClose').onclick = () => { $('settingsPanel').hidden = true; };
document.querySelectorAll<HTMLButtonElement>('.settings-tabs button').forEach(button => {
  button.onclick = () => {
    document.querySelectorAll('.settings-tabs button').forEach(b => b.classList.remove('active'));
    button.classList.add('active');
    const tab = button.dataset.tab!;
    document.querySelectorAll<HTMLElement>('[data-tabpanel]').forEach(p => { p.hidden = p.dataset.tabpanel !== tab; });
  };
});
$('cfgSave').onclick = action(async () => {
  const id = $<HTMLSelectElement>('cfgProvider').value;
  const key = $<HTMLInputElement>('cfgApiKey').value;
  const result = await call({ op: 'config:setProvider', id, baseUrl: $<HTMLInputElement>('cfgBaseUrl').value, model: $<HTMLInputElement>('cfgModel').value, ...(key ? { next: key } : {}) });
  await applyMedia((result as { media: { background: string | null; bgm: string | null } }).media);
  toast(t('done'));
});
$('cfgLocale').onchange = () => { locale.setLocale($<HTMLSelectElement>('cfgLocale').value); localStorage.setItem('diary.locale', locale.locale); translate(); };
$('accountSet').onclick = action(async () => { const r = await modal(t('setPasscode'), t('encryptHint'), [{ name: 'next', label: t('password') }, { name: 'confirmation', label: t('confirmPasscode') }]); if (r) { await call({ op: 'account:setLocal', passcode: r.next! }); await loadConfig(); toast(t('done')); } });
$('accountClear').onclick = action(async () => { if (!await modal(t('deleteEntry'), t('deleteHint'))) return; await call({ op: 'account:clearLocal' }); await loadConfig(); toast(t('done')); });

// ---------- OAuth PKCE (Google / Microsoft) ----------
async function pkceChallenge(): Promise<{ verifier: string; challenge: string }> {
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const challenge = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}
const oauthState = new Map<string, { verifier: string; redirectUri: string }>();
async function startOAuth(provider: string, clientIdEl: string) {
  const clientId = $<HTMLInputElement>(clientIdEl).value.trim();
  if (!clientId) { toast(t('clientId')); return; }
  const { verifier, challenge } = await pkceChallenge();
  const redirectUri = 'http://localhost/diary-callback';
  const state = crypto.randomUUID();
  const result = await call<{ url: string }>({ op: 'account:oauthBegin', provider, clientId, redirectUri, state, codeChallenge: challenge });
  oauthState.set(provider, { verifier, redirectUri });
  await call({ op: 'openExternal', url: result.url });
  toast(t('oauthTip'));
}
async function finishOAuth(provider: string, codeEl: string) {
  const code = $<HTMLInputElement>(codeEl).value.trim();
  const state = oauthState.get(provider);
  if (!code || !state) { toast(t('oauthCode')); return; }
  await call({ op: 'account:oauthFinish', provider, code, codeVerifier: state.verifier, redirectUri: state.redirectUri });
  oauthState.delete(provider);
  toast(t('done'));
}
$('googleStart').onclick = action(() => startOAuth('google', 'googleClientId'));
$('googleFinish').onclick = action(() => finishOAuth('google', 'googleCode'));
$('microsoftStart').onclick = action(() => startOAuth('microsoft', 'microsoftClientId'));
$('microsoftFinish').onclick = action(() => finishOAuth('microsoft', 'microsoftCode'));

// ---------- Profile avatar ----------
function pickFile(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}
async function fileToBase64(file: File): Promise<{ data: string; mime: string }> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { data: btoa(binary), mime: file.type || 'application/octet-stream' };
}
$('profileAvatar').onclick = action(async () => {
  const file = await pickFile('image/*,video/*'); if (!file) return;
  const { data, mime } = await fileToBase64(file);
  const info = await call<{ id: string }>({ op: 'media:import', name: file.name, mime, data });
  await call({ op: 'profile:set', avatar: info.id });
  const url = await call<string>({ op: 'media:data', id: info.id });
  const img = $<HTMLImageElement>('profileAvatarPreview'); img.src = url; img.hidden = false;
  const av = $<HTMLImageElement>('avatarImg'); av.src = url; av.hidden = false;
  toast(t('done'));
});
$('profileSave').onclick = action(async () => {
  await call({ op: 'profile:set', username: $<HTMLInputElement>('profileUsername').value, signature: $<HTMLInputElement>('profileSignature').value });
  toast(t('done'));
});

// ---------- Media: background & BGM ----------
async function importMediaAs(accept: string): Promise<string | null> {
  const file = await pickFile(accept); if (!file) return null;
  const { data, mime } = await fileToBase64(file);
  const info = await call<{ id: string }>({ op: 'media:import', name: file.name, mime, data });
  return info.id;
}
$('bgImport').onclick = action(async () => { const id = await importMediaAs('image/*'); if (id) { await call({ op: 'media:setBackground', background: id }); await loadConfig(); toast(t('done')); } });
$('bgClear').onclick = action(async () => { await call({ op: 'media:setBackground', background: null }); document.body.style.removeProperty('--diary-bg'); await loadConfig(); });
$('bgmImport').onclick = action(async () => { const id = await importMediaAs('audio/*,video/*'); if (id) { await call({ op: 'media:setBgm', bgm: id }); await loadConfig(); toast(t('done')); } });
$('bgmClear').onclick = action(async () => { await call({ op: 'media:setBgm', bgm: null }); $<HTMLAudioElement>('bgmPlayer').pause(); await loadConfig(); });

// ---------- AI assistant ----------
function togglePopover(popover: HTMLElement, button: HTMLElement) {
  const other = popover === $('aiPopover') ? $('webPopover') : $('aiPopover');
  other.hidden = true;
  popover.hidden = !popover.hidden;
  if (!popover.hidden) button.classList.add('active'); else button.classList.remove('active');
}
$('aiButton').onclick = () => togglePopover($('aiPopover'), $('aiButton'));
$('aiClose').onclick = () => { $('aiPopover').hidden = true; $('aiButton').classList.remove('active'); };
$('webButton').onclick = () => togglePopover($('webPopover'), $('webButton'));
$('webClose').onclick = () => { $('webPopover').hidden = true; $('webButton').classList.remove('active'); };
$('aiRun').onclick = action(async () => {
  const task = $<HTMLSelectElement>('aiTask').value;
  const prompt = $<HTMLTextAreaElement>('aiPrompt').value;
  $('aiResult').textContent = t('aiBusy'); $('aiInsert').hidden = true;
  try {
    if (task === 'illustrate') {
      const result = await call<{ id: string; mime: string; dataUrl: string }>({ op: 'agent:illustrate', prompt: prompt || editor.value.slice(0, 200) });
      const img = document.createElement('img'); img.src = result.dataUrl; img.className = 'ai-image'; $('aiResult').replaceChildren(img);
      (window as unknown as { __aiInsertImage?: string }).__aiInsertImage = `![插图](${result.dataUrl})`;
      $('aiInsert').hidden = false; $('aiInsert').onclick = () => { insertText((window as unknown as { __aiInsertImage?: string }).__aiInsertImage || ''); $('aiPopover').hidden = true; };
    } else {
      const messages: { role: 'user'; content: string }[] = prompt || editor.value ? [{ role: 'user', content: `${prompt}\n${editor.value}`.trim() }] : [];
      const text = await call<string>({ op: 'agent:compose', messages, task });
      $('aiResult').textContent = text;
      (window as unknown as { __aiInsertText?: string }).__aiInsertText = text;
      $('aiInsert').hidden = false; $('aiInsert').onclick = () => { insertText((window as unknown as { __aiInsertText?: string }).__aiInsertText || ''); $('aiPopover').hidden = true; };
    }
  } catch (error) { $('aiResult').textContent = localizedError(error); }
});
function insertText(text: string) {
  if (!editor.value) editor.value = text; else editor.value = `${editor.value}\n\n${text}`;
  dirty = true; status();
}
$('webDate').onclick = action(async () => {
  const info = await call<{ iso: string; label: string }>({ op: 'web:date' });
  $('webResult').textContent = `${info.label}（${info.iso}）`;
  insertText(`# ${info.iso} ${info.label}`);
});
$('webWeather').onclick = action(async () => {
  const lat = parseFloat($<HTMLInputElement>('webLat').value); const lon = parseFloat($<HTMLInputElement>('webLon').value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { toast(t('fetchLocation')); return; }
  const w = await call<{ tempC: number; description: string; humidity: number | null }>({ op: 'web:weather', lat, lon });
  $('webResult').textContent = `${t('fetchWeather')}：${w.description}，${w.tempC}°C`;
  insertText(`天气：${w.description}，${w.tempC}°C`);
});

// ---------- Campus affairs mode ----------
const emptyProfile = (): CampusProfile => ({ name: '', studentId: '', school: '', college: '', major: '', grade: '', phone: '', email: '' });
function campusProfile(): CampusProfile {
  try { return { ...emptyProfile(), ...JSON.parse(localStorage.getItem('diary.campus.profile') || '{}') as CampusProfile }; }
  catch { return emptyProfile(); }
}
function campusCases(): CampusCase[] {
  try { const value = JSON.parse(localStorage.getItem('diary.campus.cases') || '[]'); return Array.isArray(value) ? value as CampusCase[] : []; }
  catch { return []; }
}
function saveCampusCases(items: CampusCase[]) { localStorage.setItem('diary.campus.cases', JSON.stringify(items)); }
function textElement(tag: string, text: string, className = ''): HTMLElement {
  const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
}
function setMode(mode: 'diary' | 'campus') {
  appMode = mode; localStorage.setItem('diary.mode', mode);
  $('diaryMode').classList.toggle('active', mode === 'diary'); $('campusMode').classList.toggle('active', mode === 'campus');
  $('diarySidebar').hidden = mode !== 'diary'; $('campusSidebar').hidden = mode !== 'campus'; $('campusWorkspace').hidden = mode !== 'campus';
  if (mode === 'campus') { $('empty').hidden = true; $('workspace').hidden = true; $('breadcrumbDate').textContent = t('campusMode'); renderServices(campusServices); renderCaseList(); }
  else { $('campusWorkspace').hidden = true; $('breadcrumbDate').textContent = locale.date(Date.now(), { month: 'long', day: 'numeric', weekday: 'long' }); if (current) $('workspace').hidden = false; else $('empty').hidden = false; }
  document.body.classList.remove('sidebar-open');
}
function renderServices(services: CampusService[]) {
  const grid = $('serviceGrid'); if (!grid) return; grid.replaceChildren();
  for (const service of services) {
    const button = document.createElement('button'); button.className = 'service-card';
    button.append(textElement('span', service.icon, 'service-icon'), textElement('strong', service.title), textElement('p', service.description), textElement('small', `办理部门：${service.department}`));
    button.onclick = () => renderServiceForm(service); grid.append(button);
  }
  $('campusAdvice').textContent = services.length ? t('campusAdvice') : '暂未识别到匹配事项，请换一种说法或从下方分类选择。';
}
function formInput(labelText: string, value = ''): HTMLLabelElement {
  const label = document.createElement('label'); label.textContent = labelText;
  const input = document.createElement(labelText.includes('原因') || labelText.includes('描述') || labelText.includes('理由') ? 'textarea' : 'input') as HTMLInputElement | HTMLTextAreaElement;
  input.name = labelText; input.value = value; input.autocomplete = 'off'; label.append(input); return label;
}
function renderServiceForm(service: CampusService) {
  activeCaseId = null; const detail = $('caseDetail'); detail.replaceChildren(); detail.hidden = false;
  detail.append(textElement('h2', `${service.icon} ${service.title}`), textElement('p', `系统已判断办理部门：${service.department}`, 'case-meta'));
  const form = document.createElement('div'); form.className = 'case-form';
  for (const field of service.fields) form.append(formInput(field));
  detail.append(textElement('h3', '申请信息（身份字段将自动填写）'), form, textElement('h3', '预计材料清单'));
  const checklist = document.createElement('div'); checklist.className = 'check-list';
  for (const name of service.materials) checklist.append(textElement('div', `□ ${name}`, 'check-row'));
  detail.append(checklist, textElement('h3', '跨部门流程'));
  const route = document.createElement('div'); route.className = 'route-list';
  service.steps.forEach((step, index) => route.append(textElement('div', `${index + 1}. ${step}`, 'route-row'))); detail.append(route);
  const actions = document.createElement('div'); actions.className = 'case-actions'; const create = textElement('button', '生成申请表并开始追踪', 'primary') as HTMLButtonElement;
  create.onclick = () => {
    const values = Object.fromEntries([...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')].map(input => [input.name, input.value.trim()]));
    const item = createCampusCase(service, campusProfile(), values); const items = campusCases(); items.unshift(item); saveCampusCases(items); activeCaseId = item.id; renderCampusCase(item); renderCaseList(); toast('已生成申请表与办理清单');
  };
  actions.append(create); detail.append(actions); detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderCampusCase(item: CampusCase) {
  const detail = $('caseDetail'); detail.replaceChildren(); detail.hidden = false;
  detail.append(textElement('h2', item.title)); const meta = document.createElement('p'); meta.className = 'case-meta';
  meta.append(textElement('span', ({ draft: '待提交', submitted: '已提交', processing: '办理中', completed: '已完成' } as const)[item.status], 'status-pill'), document.createTextNode(`　流转：${item.department}`)); detail.append(meta);
  detail.append(textElement('h3', '自动填写的申请信息')); const form = document.createElement('div'); form.className = 'case-form';
  for (const [key, value] of Object.entries(item.fields)) form.append(formInput(key, value)); detail.append(form);
  detail.append(textElement('h3', '材料清单')); const checks = document.createElement('div'); checks.className = 'check-list';
  item.materials.forEach((material, index) => { const label = document.createElement('label'); label.className = 'check-row'; const input = document.createElement('input'); input.type = 'checkbox'; input.checked = material.checked; input.onchange = () => updateCampusCase(item.id, value => { value.materials[index]!.checked = input.checked; return value; }); label.append(input, document.createTextNode(material.name)); checks.append(label); }); detail.append(checks);
  detail.append(textElement('h3', '部门流转与结果追踪')); const route = document.createElement('div'); route.className = 'route-list';
  item.steps.forEach(step => { const row = document.createElement('div'); row.className = `route-row${step.done ? ' done' : ''}`; row.append(textElement('span', step.done ? '✓' : '', 'route-dot')); const words = document.createElement('div'); words.append(textElement('strong', step.label), textElement('small', step.department)); row.append(words); route.append(row); }); detail.append(route);
  const actions = document.createElement('div'); actions.className = 'case-actions';
  const save = textElement('button', '保存表单', 'text-button') as HTMLButtonElement; save.onclick = () => { const fields = Object.fromEntries([...form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')].map(input => [input.name, input.value])); updateCampusCase(item.id, value => ({ ...value, fields })); toast('申请表已保存'); };
  const copy = textElement('button', '复制申请表', 'text-button') as HTMLButtonElement; copy.onclick = action(async () => { await navigator.clipboard.writeText(applicationText(campusCases().find(value => value.id === item.id) || item)); toast('申请表已复制'); });
  const next = textElement('button', item.status === 'draft' ? '提交并开始办理' : item.status === 'completed' ? '已办结' : '推进下一环节', 'primary') as HTMLButtonElement; next.disabled = item.status === 'completed'; next.onclick = () => updateCampusCase(item.id, advanceCampusCase, true);
  actions.append(save, copy, next); detail.append(actions); detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function updateCampusCase(id: string, update: (item: CampusCase) => CampusCase, rerender = false) {
  const items = campusCases(); const index = items.findIndex(item => item.id === id); if (index < 0) return; items[index] = update(structuredClone(items[index]!)); saveCampusCases(items); renderCaseList(); if (rerender) renderCampusCase(items[index]!);
}
function renderCaseList() {
  const list = $('caseList'); if (!list) return; list.replaceChildren(); const query = $<HTMLInputElement>('campusSearch')?.value.trim().toLocaleLowerCase() || '';
  const items = campusCases().filter(item => `${item.title} ${item.department}`.toLocaleLowerCase().includes(query)); $('caseCount').textContent = String(campusCases().length);
  for (const item of items) { const button = document.createElement('button'); button.className = `case-card${activeCaseId === item.id ? ' active' : ''}`; button.append(textElement('strong', item.title), textElement('small', `${item.department} · ${{ draft: '待提交', submitted: '已提交', processing: '办理中', completed: '已完成' }[item.status]}`)); button.onclick = () => { activeCaseId = item.id; renderCampusCase(item); renderCaseList(); document.body.classList.remove('sidebar-open'); }; list.append(button); }
  if (!items.length) list.append(textElement('p', '暂无办事记录', 'no-entries'));
}
$('diaryMode').onclick = () => setMode('diary'); $('campusMode').onclick = () => setMode('campus');
$('campusNew').onclick = () => { activeCaseId = null; $('caseDetail').hidden = true; renderServices(campusServices); };
$('campusSearch').oninput = renderCaseList;
$('campusMatch').onclick = () => renderServices(matchCampusService($<HTMLInputElement>('campusQuestion').value));
$('campusQuestion').onkeydown = event => { if (event.key === 'Enter') $('campusMatch').click(); };
$('campusProfile').onclick = action(async () => { await loadConfig(); $('settingsPanel').hidden = false; (document.querySelector<HTMLButtonElement>('.settings-tabs button[data-tab="campus"]'))?.click(); });
$('studentSave').onclick = () => {
  const profile: CampusProfile = { name: $<HTMLInputElement>('studentName').value.trim(), studentId: $<HTMLInputElement>('studentId').value.trim(), school: $<HTMLInputElement>('studentSchool').value.trim(), college: $<HTMLInputElement>('studentCollege').value.trim(), major: $<HTMLInputElement>('studentMajor').value.trim(), grade: $<HTMLInputElement>('studentGrade').value.trim(), phone: $<HTMLInputElement>('studentPhone').value.trim(), email: $<HTMLInputElement>('studentEmail').value.trim() };
  localStorage.setItem('diary.campus.profile', JSON.stringify(profile)); toast('学生身份已保存到本机');
};

// ---------- Batch operations ----------
$('batchEncrypt').onclick = action(async () => {
  if (!selected.size) return;
  const r = await modal(t('encrypt'), t('encryptHint'), [{ name: 'next', label: t('password') }, { name: 'confirmation', label: t('confirmPasscode') }]);
  if (!r) return;
  await call({ op: 'batch:encrypt', ids: [...selected], passcode: r.next! });
  selected.clear(); await refresh(); toast(t('done'));
});
$('batchDecrypt').onclick = action(async () => {
  if (!selected.size) return;
  const r = await modal(t('unlock'), t('unlockHint'), [{ name: 'password', label: t('password') }]);
  if (!r) return;
  await call({ op: 'batch:decrypt', ids: [...selected], passcode: r.password! });
  selected.clear(); await refresh(); toast(t('done'));
});
$('batchChange').onclick = action(async () => {
  if (!selected.size) return;
  const r = await modal(t('changePasscode'), t('encryptHint'), [{ name: 'old', label: t('oldPassword') }, { name: 'next', label: t('newPassword') }, { name: 'confirmation', label: t('confirmPasscode') }]);
  if (!r) return;
  await call({ op: 'batch:changePasscode', ids: [...selected], passcode: r.old!, next: r.next!, confirmation: r.confirmation! });
  selected.clear(); await refresh(); toast(t('done'));
});
$('batchCancel').onclick = () => { selected.clear(); renderList(); };

// ---------- Existing entry actions ----------
$('newEntry').onclick = action(newEntry); $('firstEntry').onclick = action(newEntry);
$('save').onclick = action(save);
$('search').oninput = renderList;
title.oninput = editor.oninput = () => { dirty = true; status(); };
$('editTab').onclick = () => view(false); $('previewTab').onclick = () => view(true);
$('more').onclick = () => { $('moreMenu').hidden = !$('moreMenu').hidden; };
$('openSidebar').onclick = () => document.body.classList.add('sidebar-open');
$('closeSidebar').onclick = () => document.body.classList.remove('sidebar-open');
$('theme').onclick = () => { document.body.classList.toggle('dark'); localStorage.setItem('diary.dark', String(document.body.classList.contains('dark'))); };
$('encrypt').onclick = action(async () => {
  if (!current) return;
  const response = await modal(t('encrypt'), t('encryptHint'), [{ name: 'next', label: t('password') }, { name: 'confirmation', label: t('confirmPasscode') }]);
  if (!response) return;
  if (draft) {
    password = response.next; current.encrypted = true;
    try { await save(); } catch (error) { password = undefined; current.encrypted = false; throw error; }
  } else {
    await save();
    await call({ op: 'encrypt', id: current.id, passcode: response.next!, confirmation: response.confirmation! });
    password = response.next; current.encrypted = true; await refresh();
  }
  status(); toast(t('done'));
});
$('lock').onclick = action(async () => { if (dirty) await save(); clear(); });
$('decrypt').onclick = action(async () => {
  if (!current || !await modal(t('decrypt'), t('decryptHint'))) return;
  await save(); await call({ op: 'decrypt', id: current.id, passcode: password! });
  current.encrypted = false; password = undefined; $('moreMenu').hidden = true; status(); await refresh(); toast(t('done'));
});
$('changePassword').onclick = action(async () => {
  if (!current) return;
  const response = await modal(t('changePasscode'), t('encryptHint'), [{ name: 'old', label: t('oldPassword') }, { name: 'next', label: t('newPassword') }, { name: 'confirmation', label: t('confirmPasscode') }]);
  if (!response) return;
  await save(); await call({ op: 'changePasscode', id: current.id, passcode: response.old!, next: response.next!, confirmation: response.confirmation! });
  password = response.next; $('moreMenu').hidden = true; toast(t('done'));
});
$('delete').onclick = action(async () => {
  if (!current || !await modal(t('deleteEntry'), t('deleteHint'))) return;
  if (!draft) await call({ op: 'delete', id: current.id, ...(password === undefined ? {} : { passcode: password }) });
  clear(); await refresh();
});
$('export').onclick = action(async () => { if (!current) return; await save(); if (await call({ op: 'export', id: current.id })) toast(t('done')); });
$('import').onclick = action(async () => {
  if (!await mayDiscard()) return;
  const raw = await call<string | null>({ op: 'import' }); if (raw === null) return;
  let content = raw, passcode: string | undefined;
  if (isEncrypted(raw)) {
    const response = await modal(t('unlock'), t('importHint'), [{ name: 'password', label: t('password') }]);
    if (!response) return; passcode = response.password; content = await decryptContent(raw, passcode!);
  }
  const document = parseMarkdown(content);
  const entry = await call<Entry>({ op: 'create', id: newId(), document, ...(passcode === undefined ? {} : { passcode }) });
  password = passcode; show(entry); await refresh();
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void action(save)(); }
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => {
  if (document.hidden && current?.encrypted && !busy) void action(async () => { if (dirty) await save(); clear(); })();
});
window.addEventListener('diary-back', () => {
  if ($<HTMLDialogElement>('modal').open) { $('modalCancel').click(); return; }
  if (document.body.classList.contains('sidebar-open')) { document.body.classList.remove('sidebar-open'); return; }
  void action(async () => { if (await mayDiscard()) await call({ op: 'exit' }); })();
});
document.body.classList.toggle('dark', localStorage.getItem('diary.dark') === 'true');
translate();
setMode(appMode);
// Boot: load config (lock screen if a local account exists), then refresh.
void action(async () => {
  const cfg = await call<{ hasLocalAccount: boolean }>({ op: 'config:get' });
  if (cfg.hasLocalAccount) showLock(false); else unlocked = true;
  await refresh();
})();
