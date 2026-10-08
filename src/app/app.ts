// SPDX-License-Identifier: AGPL-3.0-only
import { call } from './api.ts';
import type { Entry, EntrySummary, MarkdownDocument } from './api.ts';
import { locale, t } from './copy.ts';
import { decryptContent, isEncrypted } from '../security/encryption.ts';
import { parseMarkdown } from '../storage/markdown.ts';
import { mountPortal, prefetchCompetitionSites, setPortalIdentity, setPortalNavigator, setPortalNetwork, setPortalPlugins } from './portal.ts';
import type { PortalViewName } from './portal.ts';
import { weatherMetrics, weatherToMarkdown } from './weather.ts';
import type { WeatherOk, WeatherReport } from './weather.ts';
import { createOnboarding } from './onboarding/view.ts';
import { installUiTranslations, refreshUiTranslations } from './ui-i18n.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const title = $<HTMLInputElement>('title'), editor = $<HTMLTextAreaElement>('editor');
let current: Entry | null = null, password: string | undefined, dirty = false, draft = false, busy = false, busySince = 0;
type SidebarEntry = EntrySummary & { title: string; snippet: string; hasRecovery?: boolean };
let entries: SidebarEntry[] = [];
let toastTimer: ReturnType<typeof setTimeout>;
let unlocked = true;
let selected = new Set<string>();
const onboarding = createOnboarding(viewName => activateView(viewName));
type Field = { name: string; label: string; type?: string; options?: [string, string][]; required?: boolean };
type ModalOptions = { extras?: { label: string; action: string }[] };
function modal(heading: string, message = '', fields: Field[] = [], options: ModalOptions = {}): Promise<Record<string, string> | null> {
  const dialog = $<HTMLDialogElement>('modal');
  $('modalTitle').textContent = heading; $('modalMessage').textContent = message;
  $('modalFields').replaceChildren(); $('modalError').textContent = '';
  for (const field of fields) {
    const label = document.createElement('label'); label.textContent = field.label;
    const input = document.createElement(field.options ? 'select' : 'input') as HTMLInputElement | HTMLSelectElement;
    input.name = field.name;
    if (input instanceof HTMLInputElement) { input.type = field.type ?? 'password'; input.required = field.required !== false; input.autocomplete = 'off'; }
    if (field.options) {
      for (const [value, text] of field.options) { const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option); }
      input.value = locale.locale;
    }
    label.append(input); $('modalFields').append(label);
  }
  let extras = $('modalExtras');
  if (!extras) { extras = document.createElement('span'); extras.id = 'modalExtras'; extras.className = 'modal-extras'; $('modalCancel').before(extras); }
  extras.replaceChildren();
  dialog.showModal();
  return new Promise(resolve => {
    const finish = (result: Record<string, string> | null) => {
      dialog.close(); $('modalForm').onsubmit = null; $('modalCancel').onclick = null; dialog.oncancel = null; extras.replaceChildren(); resolve(result);
    };
    for (const extra of options.extras ?? []) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = extra.label;
      button.onclick = () => finish({ __action: extra.action }); extras.append(button);
    }
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
    // Never swallow a click silently: an in-flight operation used to make every
    // later button appear dead, which is indistinguishable from a crash.
    if (busy) {
      // A wedged operation must not brick the UI. Past 30s we let the user try
      // again instead of answering every click with the same toast forever.
      if (Date.now() - busySince < 30_000) { toast('请稍等，上一个操作还在进行中…'); return; }
      busy = false;
    }
    busy = true; busySince = Date.now();
    try { await operation(); } catch (error) { toast(localizedError(error)); }
    finally { busy = false; }
  };
}
function translate() {
  document.documentElement.lang = locale.locale;
  document.querySelectorAll<HTMLElement>('[data-i]').forEach(element => { element.textContent = t(element.dataset.i!); });
  document.querySelectorAll<HTMLInputElement>('[data-placeholder]').forEach(element => { element.placeholder = t(element.dataset.placeholder!); });
  $('breadcrumbDate').textContent = locale.date(Date.now(), { month: 'long', day: 'numeric', weekday: 'long' });
  renderList(); status();
  refreshUiTranslations(locale.locale);
}
function status() {
  $('saveState').textContent = t(dirty ? 'unsaved' : 'saved');
  $('wordCount').textContent = `${Array.from(editor.value).length.toLocaleString(locale.locale)} ${t('characters')}`;
  $('securityBadge').textContent = t(current?.encrypted ? 'protected' : 'plain');
  $('encrypt').hidden = !!current?.encrypted; $('lock').hidden = !current?.encrypted;
  $('changePassword').hidden = !current?.encrypted; $('decrypt').hidden = !current?.encrypted;
}
async function refresh() {
  const all = await call<(EntrySummary & { title?: string; hasRecovery?: boolean })[]>({ op: 'list' });
  entries = await Promise.all(all.map(async item => {
    if (item.encrypted) return { ...item, title: item.title || t('encryptedEntry'), snippet: '' };
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
    const heading = document.createElement('span'); heading.className = 'card-title'; heading.textContent = `${entry.encrypted ? '🔒 ' : ''}${entry.title}`;
    const date = document.createElement('small'); date.textContent = entry.id.slice(0, 10);
    button.append(check, heading, date); button.onclick = action(() => selectEntry(entry));
    button.oncontextmenu = event => { event.preventDefault(); openEntryContextMenu(event, entry); };
    $('entries').append(button);
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
async function recoverAndOpen(entry: SidebarEntry): Promise<void> {
  const info = await call<{ questions: [string, string] } | null>({ op: 'entry:securityInfo', id: entry.id });
  if (!info) throw new Error('这篇日记没有设置密保问题');
  const response = await modal('忘记密码', '请回答创建密码时设置的两个密保问题。', [
    { name: 'answer', label: info.questions[0], type: 'text' }, { name: 'answer2', label: info.questions[1], type: 'text' },
  ]);
  if (!response) return;
  const recovered = await call<{ passcode: string }>({ op: 'entry:recover', id: entry.id, answer: response.answer!, answer2: response.answer2! });
  const content = await call<Entry>({ op: 'read', id: entry.id, passcode: recovered.passcode });
  password = recovered.passcode; show(content);
}
async function changeEntrySecurity(entry: SidebarEntry): Promise<void> {
  const response = await modal('修改密码', '修改密码需要输入原来的旧密码。', [
    { name: 'passcode', label: '旧密码' }, { name: 'next', label: '新密码' }, { name: 'confirmation', label: '确认新密码' },
  ]);
  if (!response) return;
  await call({ op: 'entry:changeSecurity', id: entry.id, passcode: response.passcode!, next: response.next!, confirmation: response.confirmation! });
  if (current?.id === entry.id) password = response.next;
  toast('密码已修改');
}
async function setEntrySecurity(entry: SidebarEntry): Promise<void> {
  const response = await modal('设置密码与密保', '密码至少 8 位；两个密保问题用于忘记密码时验证身份。', [
    { name: 'next', label: '密码' }, { name: 'confirmation', label: '确认密码' },
    { name: 'question', label: '密保问题 1', type: 'text' }, { name: 'answer', label: '密保答案 1', type: 'text' },
    { name: 'question2', label: '密保问题 2', type: 'text' }, { name: 'answer2', label: '密保答案 2', type: 'text' },
  ]);
  if (!response) return;
  await call({ op: 'entry:setSecurity', id: entry.id, title: entry.title, passcode: response.next!, confirmation: response.confirmation!,
    question: response.question!, answer: response.answer!, question2: response.question2!, answer2: response.answer2! });
  if (current?.id === entry.id) { password = response.next; current.encrypted = true; status(); }
  await refresh(); toast('密码与密保已设置');
}
function closeEntryContextMenu(): void { document.querySelector('.entry-context-menu')?.remove(); }
function openEntryContextMenu(event: MouseEvent, entry: SidebarEntry): void {
  closeEntryContextMenu();
  const menu = document.createElement('div'); menu.className = 'context-menu entry-context-menu';
  const add = (label: string, run: () => Promise<unknown>) => {
    const button = document.createElement('button'); button.textContent = label;
    button.onclick = action(async () => { closeEntryContextMenu(); await run(); }); menu.append(button);
  };
  add(entry.encrypted ? '修改密码' : '设置密码与密保', () => entry.encrypted ? changeEntrySecurity(entry) : setEntrySecurity(entry));
  add('打开日记文件储存文件夹', () => call({ op: 'entry:showInFolder', id: entry.id }));
  add('复制日记路径', async () => { await call({ op: 'entry:copyPath', id: entry.id }); toast('日记路径已复制'); });
  document.body.append(menu);
  menu.style.left = `${Math.min(event.clientX, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, innerHeight - menu.offsetHeight - 8)}px`;
  setTimeout(() => document.addEventListener('pointerdown', closeEntryContextMenu, { once: true }), 0);
}
async function selectEntry(entry: SidebarEntry) {
  if (!unlocked) return;
  if (!await mayDiscard()) return;
  let passcode: string | undefined;
  if (entry.encrypted) {
    const info = await call<{ questions: [string, string] } | null>({ op: 'entry:securityInfo', id: entry.id });
    const response = await modal(t('unlock'), t('unlockHint'), [{ name: 'password', label: t('password') }], { extras: [
      ...(info ? [{ label: '忘记密码', action: 'forgot' }] : []), { label: '修改密码', action: 'change' },
    ] });
    if (!response) return;
    if (response.__action === 'forgot') { await recoverAndOpen(entry); return; }
    if (response.__action === 'change') { await changeEntrySecurity(entry); return; }
    passcode = response.password;
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

// ---------- Lock screen & accounts (QQ-style) ----------
type AccountSummary = { id: string; username: string; displayName: string; avatar: string | null; googleEmail: string | null; autoLogin: boolean; hasRecovery: boolean };
type BackgroundState = {
  kind: 'image' | 'video' | 'wallpaper' | 'file' | null;
  media: string | null;
  file: string | null;
  wallpaper: { path: string; title: string; animated: boolean } | null;
  fit: 'cover' | 'contain' | 'fill' | 'tile' | 'center';
  dim: number; blur: number;
  /** 0 = 原画质（完全不透明）；100 = 完全透明。 */
  opacity: number;
  /** 100 = 素材本来的亮度。 */
  brightness: number;
};
/** One file inside <vault>/backgrounds or <vault>/music. */
type LibraryItem = { name: string; size: number; mime: string; modified: number };
/**
 * 壁纸可读性设置，照搬 DSH 壁纸插件那一套：一个总开关 + 三个可调项。
 * 关掉开关时不注入任何变量，界面原样回归。
 */
type ChromeState = {
  fontCustom: boolean;
  fontColor: string;
  fontSize: number;
  /** 空字符串 = 跟随主题。 */
  topbarColor: string;
};
/** 与宿主 BASE_FONT_SIZE 保持一致：字号以 15px 为基准按比例缩放。 */
const CHROME_BASE_FONT_SIZE = 15;
const CHROME_FALLBACK: ChromeState = { fontCustom: false, fontColor: '#20283a', fontSize: CHROME_BASE_FONT_SIZE, topbarColor: '' };
/** Used when a snapshot carries no background at all (the Android shell). */
const NO_BACKGROUND: BackgroundState = {
  kind: null, media: null, file: null, wallpaper: null,
  fit: 'fill', dim: 0, blur: 0, opacity: 0, brightness: 100,
};
type BuiltinPlugin = { id: string; name: string; description: string; version: string; kind: 'builtin'; enabled: boolean };
type PluginInfo = { file: string; id: string; label: string; baseUrl: string; model: string; custom: boolean; models: string[]; enabled: boolean };
type PluginList = { builtin: BuiltinPlugin[]; external: PluginInfo[]; errors: { file: string; message: string }[]; directory: string };
type ProviderInfo = {
  id: string; label?: string; baseUrl: string; model: string; models: string[];
  hasKey: boolean; needsKey?: boolean;
  /** True for a backend the user registered by hand. */
  custom?: boolean;
};
type Snapshot = {
  activeProvider: string; providers: ProviderInfo[];
  profile: { username: string; avatar: string | null; signature: string };
  media: { background: BackgroundState; bgm: string | null; chrome?: ChromeState };
  background: BackgroundState;
  permissions: { network: boolean; location: boolean };
  location: { mode: 'auto' | 'manual'; lat: number | null; lon: number | null; label: string };
  wallpaperDir: string | null;
  builtinPlugins: BuiltinPlugin[];
  users: AccountSummary[];
  currentUser: { id: string; username: string; displayName: string; avatar: string | null; googleEmail: string | null } | null;
  remember: boolean;
  google: { googleId: string; email: string; name: string; picture: string | null } | null;
  oauthClients: Record<string, string>;
  plugins: PluginInfo[];
  pluginErrors: { file: string; message: string }[];
  pluginDirectory: string;
};
let lastSnapshot: Snapshot | null = null;

/**
 * Paint an avatar slot. Every slot owns exactly two nodes — an <img> and an
 * initial-letter fallback — and they are mutually exclusive by contract. The
 * "two avatars on one page" defect came from both nodes being visible at once
 * (the container is a grid, so the initial was laid out *below* the picture and
 * spilled out of the 76px circle).
 */
function setAvatar(img: HTMLImageElement | null, fallback: HTMLElement | null, url: string | null, name: string): void {
  if (fallback) fallback.textContent = (name.trim()[0] || 'D').toLocaleUpperCase();
  if (!img) return;
  if (url) {
    img.src = url;
    img.hidden = false;
    if (fallback) fallback.hidden = true;
  } else {
    img.removeAttribute('src');
    img.hidden = true;
    if (fallback) fallback.hidden = false;
  }
}

/**
 * Avatars are stored either as a `data:` URL (Google login caches the picture
 * that way because the CSP forbids remote images) or as a media id (local
 * upload). Normalise both to something an <img> can actually load.
 */
async function resolveAvatar(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  if (value.startsWith('data:') || value.startsWith('blob:')) return value;
  return await call<string>({ op: 'media:data', id: value }).catch(() => '') || null;
}

/** Render the signed-in avatar + name into the lock card header. */
function paintIdentity(target: 'login' | 'setting', snapshot: Snapshot | null): void {
  const user = snapshot?.currentUser ?? null;
  const google = snapshot?.google ?? null;
  const name = user?.displayName || google?.name || '';
  const avatar = user?.avatar || google?.picture || null;
  if (target === 'setting') {
    $('accountState').textContent = user ? `当前账户：${user.displayName}（${user.username}）` : '未登录';
    const signedIn = Boolean(user);
    $('googleState').textContent = signedIn
      ? `已登录：${user!.displayName}${user!.googleEmail ? ` · ${user!.googleEmail}` : ''}`
      : '尚未使用 Google 登录';
    $('googleLogin').hidden = Boolean(google);
    $('googleLogout').hidden = !google;
    $('accountSet').hidden = !user;
    $('accountChangePwd').hidden = !user;
    $('accountRecovery').hidden = !user;
    return;
  }
  const nameEl = $('loginIdentityName'), avatarEl = $<HTMLImageElement>('loginIdentityAvatar');
  nameEl.textContent = name;
  // Remote http(s) pictures are unrenderable under the app CSP; treat them as
  // "no avatar" so the lock card falls back to the logo instead of a broken img.
  const usable = avatar && !/^https?:/i.test(avatar) ? avatar : null;
  setAvatar(avatarEl, null, usable, name);
}

/** QQ-style quick account picker: click a saved user to fill the username. */
function renderAccountChips(snapshot: Snapshot | null): void {
  const box = $('accountChips');
  const users = snapshot?.users ?? [];
  box.replaceChildren();
  if (!users.length) { box.hidden = true; return; }
  box.hidden = false;
  const currentId = snapshot?.currentUser?.id ?? null;
  for (const user of users) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'account-chip' + (user.id === currentId ? ' active' : '');
    chip.textContent = user.displayName && user.displayName !== user.username
      ? `${user.displayName} (@${user.username})` : `@${user.username}`;
    chip.onclick = () => {
      ($('authUsername') as HTMLInputElement).value = user.username;
      ($('authPasscode') as HTMLInputElement).focus();
    };
    box.append(chip);
  }
}

function showLock(firstTime = false) {
  unlocked = false;
  $('lockScreen').hidden = false;
  // Sign-in methods (Google + offline account) are always reachable, so a
  // returning user can still switch method or create another account.
  $('loginMethods').hidden = false;
  const hasUsers = (lastSnapshot?.users.length ?? 0) > 0;
  $('authPanel').hidden = !hasUsers || firstTime;
  $('loginDivider').hidden = !hasUsers || firstTime;
  $('lockHint').textContent = firstTime ? '选择登录方式，或创建一个仅保存在此设备上的账户' : '登录以继续你的私密日记';
  ($('authPasscode') as HTMLInputElement).value = '';
  renderAccountChips(lastSnapshot);
  paintIdentity('login', lastSnapshot);
  if (hasUsers && !firstTime) {
    const preferred = lastSnapshot?.currentUser?.username ?? lastSnapshot?.users[0]?.username ?? '';
    ($('authUsername') as HTMLInputElement).value = preferred;
    ($('authPasscode') as HTMLInputElement).focus();
  }
  void refreshSnapshot();
}
function hideLock() { unlocked = true; $('lockScreen').hidden = true; }

/** QQ-style profile card: avatar, nickname, @username and Google binding chip. */
function paintProfileCard(snapshot: Snapshot | null): void {
  const user = snapshot?.currentUser ?? null;
  const google = snapshot?.google ?? null;
  const name = user?.displayName || snapshot?.profile.username || '本地用户';
  $('profileCardName').textContent = name;
  $('profileCardUsername').textContent = user ? `@${user.username}` : (google ? `@${google.email.split('@')[0]}` : '@—');
  const chip = $('profileCardGoogle');
  const mail = $('profileCardMail');
  const email = user?.googleEmail || google?.email || '';
  chip.hidden = !email;
  if (email) { mail.hidden = false; mail.textContent = email; } else mail.hidden = true;
  // Visibility of the initial is owned by setAvatar(); only the letter is set here.
  $('profileAvatarInitial').textContent = (name.trim()[0] || 'D').toLocaleUpperCase();
}

async function refreshSnapshot(): Promise<Snapshot | null> {
  try { lastSnapshot = await call<Snapshot>({ op: 'account:list' }); paintIdentity('login', lastSnapshot); return lastSnapshot; }
  catch { return lastSnapshot; }
}

function startOnboardingAfterEntry(autoStart: boolean): void {
  onboarding.syncUser(lastSnapshot?.currentUser?.id ?? 'guest', autoStart);
}

/** Shared success path after Google sign-in or account creation. */
async function afterGoogle(info: { email?: string; name?: string; picture?: string | null }): Promise<void> {
  // The host already stored the Google identity and profile; just re-read state.
  await refreshSnapshot();
  const name = lastSnapshot?.currentUser?.displayName ?? info.name ?? info.email ?? '';
  hideLock(); await loadConfig(); await refresh();
  startOnboardingAfterEntry(true);
  toast(`已登录：${name}`);
}

// ---- sign in ----
$('authSubmit').onclick = action(async () => {
  const username = ($('authUsername') as HTMLInputElement).value.trim();
  const passcode = ($('authPasscode') as HTMLInputElement).value;
  const remember = ($('authRemember') as HTMLInputElement).checked;
  if (!username) { toast('请输入用户名'); return; }
  if (!passcode) { toast('请输入密码'); return; }
  // 密码校验要跑 PBKDF2，手机上不是瞬时的：给个进行中的状态，否则用户只会以为
  // 点不动了。（action() 的全局忙锁已经挡住了重复点击。）
  const button = $<HTMLButtonElement>('authSubmit');
  const label = button.textContent;
  button.disabled = true; button.textContent = '验证中…';
  try {
    await call({ op: 'account:signIn', username, passcode, remember });
    await refreshSnapshot();
    hideLock(); await loadConfig(); await refresh();
    startOnboardingAfterEntry(true);
    toast('登录成功');
  } finally {
    button.disabled = false; button.textContent = label;
  }
});
$('authPasscode').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('authSubmit').click(); } });

// ---- create offline account ----
$('offlineCreate').onclick = action(async () => {
  const r = await modal('创建本地离线账户', '设置一个专属用户名和密码。同一台设备上的每个用户互相独立，资料互不相见。', [
    { name: 'username', label: '用户名（2-20 位中英文/数字/下划线）', type: 'text' },
    { name: 'nickname', label: '昵称（可选）', type: 'text', required: false },
    { name: 'next', label: '密码（至少 8 位）' },
    { name: 'confirmation', label: '确认密码' },
  ]);
  if (!r) return;
  await call({
    op: 'account:create', username: r.username ?? '', displayName: r.nickname || r.username || '',
    passcode: r.next ?? '', confirmation: r.confirmation ?? '', remember: true,
  });
  await refreshSnapshot();
  hideLock(); await loadConfig(); await refresh();
  startOnboardingAfterEntry(true);
  toast(`本地账户「${r.nickname || r.username}」已创建`);
});

// ---- forgot password (security question) ----
$('authForgot').onclick = action(async () => {
  const users = lastSnapshot?.users ?? [];
  if (!users.length) { toast('没有可找回的账户'); return; }
  const options: [string, string][] = users.map(u => [u.id, `${u.displayName}（${u.username}）`]);
  const pick = await modal('找回密码', '选择要找回的账户，然后回答密保问题重置密码。', [
    { name: 'id', label: '账户', options },
    { name: 'answer', label: '密保答案' },
    { name: 'next', label: '新密码（至少 8 位）' },
    { name: 'confirmation', label: '确认新密码' },
  ]);
  if (!pick) return;
  const target = users.find(u => u.id === pick.id);
  if (!target?.hasRecovery) { toast('该账户未设置密保问题，无法找回'); return; }
  await call({ op: 'account:recover', id: pick.id ?? '', answer: pick.answer ?? '', next: pick.next ?? '', confirmation: pick.confirmation ?? '' });
  toast('密码已重置，请用新密码登录');
});

$('lockNow').onclick = () => showLock(false);
document.querySelectorAll<HTMLButtonElement>('[data-login-provider]').forEach(button => {
  button.onclick = action(async () => {
    const provider = button.dataset.loginProvider;
    if (provider === 'google') {
      // Keep the reason on the lock card, not in a toast that disappears.
      $('lockHint').textContent = '已打开浏览器，请在浏览器中完成 Google 授权…';
      try {
        await loginWithGoogle();
      } catch (error) {
        const message = localizedError(error);
        $('lockHint').textContent = `Google 登录失败：${message}`;
        throw error;
      }
    } else toast('该登录方式已移除，请使用 Google 或本地账户。');
  });
});

// ---------- AI 模型（侧边栏独立入口，三页：API / 自定义 / WorkBuddy 插件） ----------
/** Built-in OpenAI-compatible vendors. Matches DEFAULT_PROVIDERS on the host. */
const VENDOR_PRESETS: { id: string; label: string; baseUrl: string; model: string }[] = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'moonshot', label: 'Moonshot（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'siliconflow', label: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { id: 'local', label: '本机自建网关', baseUrl: 'http://127.0.0.1:3000/v1', model: 'deepseek-v4-flash' },
];

/** Page 1 — the built-in OpenAI-compatible vendors. */
function paintApiPage(cfg: Snapshot): void {
  const sel = $<HTMLSelectElement>('aiVendor');
  const active = cfg.providers.find(p => p.id === cfg.activeProvider);
  // A plugin or a custom backend may be the active one; the vendor picker then
  // simply shows the built-in table without claiming to be selected.
  sel.replaceChildren();
  for (const preset of VENDOR_PRESETS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    sel.append(option);
  }
  const current = cfg.providers.find(p => p.id === sel.value) ?? cfg.providers[0];
  const paint = () => {
    const entry = cfg.providers.find(p => p.id === sel.value);
    $<HTMLInputElement>('aiApiBase').value = entry?.baseUrl ?? '';
    $<HTMLInputElement>('aiApiModel').value = entry?.model ?? '';
    $<HTMLInputElement>('aiApiKey').value = '';
  };
  sel.value = VENDOR_PRESETS.some(p => p.id === cfg.activeProvider) ? cfg.activeProvider : VENDOR_PRESETS[0]!.id;
  sel.onchange = paint;
  paint();
  $('aiApiState').textContent = active
    ? `当前启用：${active.label ?? active.id} · ${active.model || '未指定模型'}${active.hasKey ? ' · 已保存密钥' : ' · 未填密钥'}`
    : '当前没有启用任何模型。';
}

/** Page 2 — backends the user registered by hand. */
function paintCustomPage(cfg: Snapshot): void {
  const host = $('aiCustomList');
  host.replaceChildren();
  const customs = cfg.providers.filter(p => p.custom);
  if (!customs.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '还没有自定义模型。在下面登记一个，它就会出现在 AI 问答与 AI 搜索的可用后端里。';
    host.append(empty);
  }
  for (const entry of customs) {
    const active = entry.id === cfg.activeProvider;
    host.append(pluginRow(
      entry.label ?? entry.id,
      `${entry.baseUrl || '未填地址'} · ${entry.model || '未指定模型'}　id: ${entry.id}`,
      active ? '使用中' : '已保存',
      active ? 'on' : 'off',
      {
        label: active ? '已启用' : '启用',
        run: () => { void (async () => {
          await call({ op: 'config:setProvider', id: entry.id, baseUrl: entry.baseUrl, model: entry.model });
          await loadConfig();
          await openAiModels();
          toast(`已启用「${entry.label ?? entry.id}」`);
        })(); },
      },
    ));
    // Deleting lives next to the entry it removes, not in a separate screen.
    const remove = document.createElement('button');
    remove.className = 'text-button danger-text';
    remove.textContent = '删除';
    remove.onclick = () => { void (async () => {
      await call({ op: 'provider:delete', id: entry.id });
      await loadConfig();
      await openAiModels();
      toast(`已删除「${entry.label ?? entry.id}」`);
    })(); };
    host.lastElementChild?.append(remove);
  }
  $('aiCustomHint').textContent = '名称只能用字母、数字、点、下划线和连字符，它会作为这个模型的唯一标识。';
}

/** Page 3 — the WorkBuddy plugin, which owns its own transport. */
function paintWorkbuddyPage(cfg: Snapshot): void {
  const host = $('aiWbPluginList');
  host.replaceChildren();
  const plugins = cfg.plugins;
  if (!plugins.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '没有发现 WorkBuddy 插件。把 workbuddy.mjs 放进插件目录并重启 Diary，它会出现在这里。';
    host.append(empty);
  }
  for (const plugin of plugins) {
    host.append(pluginRow(
      plugin.label,
      `${plugin.custom ? '自带传输层（无需 API Key）' : plugin.baseUrl || '未设置服务地址'}　id: ${plugin.id}`,
      plugin.enabled ? '已启用' : '已停用',
      plugin.enabled ? 'on' : 'off',
      {
        label: plugin.enabled ? '停用' : '启用',
        run: () => { void (async () => {
          await call({ op: 'plugin:toggle', pluginId: plugin.id, enabled: !plugin.enabled });
          await loadConfig();
          await openAiModels();
          toast(`${plugin.label}已${plugin.enabled ? '停用' : '启用'}`);
        })(); },
      },
    ));
  }
  for (const problem of cfg.pluginErrors) {
    host.append(pluginRow(problem.file.split(/[\\/]/).pop() ?? problem.file, problem.message, '加载失败', 'bad'));
  }
  // Models come from the plugin itself, prefixed `workbuddy/` so the same name
  // never means two different things on screen.
  const catalogue = plugins.flatMap(plugin => plugin.models ?? []);
  const sel = $<HTMLSelectElement>('aiWbModel');
  sel.replaceChildren();
  for (const model of [...new Set(catalogue)]) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    sel.append(option);
  }
  const wb = cfg.providers.find(p => p.id === 'workbuddy');
  if (wb?.model && !catalogue.includes(wb.model)) {
    const option = document.createElement('option');
    option.value = wb.model; option.textContent = wb.model; sel.append(option);
  }
  sel.value = wb?.model ?? catalogue[0] ?? '';
  sel.disabled = !catalogue.length;
  $('aiWbNote').textContent = catalogue.length
    ? '模型的写法统一为 workbuddy/<型号>；切换后点「保存并启用」。'
    : '插件没有提供模型列表，先启用上面的插件。';
  const active = cfg.providers.find(p => p.id === cfg.activeProvider);
  $('aiWbState').textContent = active?.id === 'workbuddy'
    ? `当前启用：${active.label ?? 'WorkBuddy'} · ${active.model || '未指定模型'}`
    : '当前启用的不是 WorkBuddy 插件，点「保存并启用」即可切换过来。';
}

/** Opens the standalone AI-model screen and paints the visible page. */
async function openAiModels(): Promise<void> {
  const cfg = await call<Snapshot>({ op: 'config:get' });
  lastSnapshot = cfg;
  paintApiPage(cfg);
  paintCustomPage(cfg);
  paintWorkbuddyPage(cfg);
  // The WorkBuddy plugin needs the desktop host, so hide its tab instead of
  // offering a switch that can never connect on a phone.
  if (window.NativeDiary) {
    const workbuddyTab = $('aiModelTabs').querySelector<HTMLElement>('[data-ai-tab="workbuddy"]');
    if (workbuddyTab) workbuddyTab.hidden = true;
    $('aiModelPanel').querySelector<HTMLElement>('[data-ai-panel="workbuddy"]')!.hidden = true;
    $('aiModelPanel').querySelector<HTMLElement>('[data-ai-panel="api"]')!.querySelector<HTMLElement>('.hint')!.textContent = '填写模型服务地址、模型名和 API 密钥。密钥保存在此设备的应用数据中。';
  }
  $('aiModelPanel').hidden = false;
}

async function loadConfig() {
  const cfg = await call<Snapshot>({ op: 'config:get' });
  lastSnapshot = cfg;
  $<HTMLInputElement>('profileUsername').value = cfg.profile.username;
  $<HTMLInputElement>('profileSignature').value = cfg.profile.signature;
  // The signed-in account is the source of truth for every avatar & name slot.
  const identity = cfg.currentUser;
  const displayName = identity?.displayName || cfg.profile.username.trim() || '本地用户';
  $('userName').textContent = displayName;
  paintIdentity('setting', cfg);
  paintProfileCard(cfg);
  $('lockNow').hidden = !identity;
  // The portal home screen greets whoever is signed in.
  setPortalIdentity(displayName || '同学');
  // Google avatars arrive as data URLs; locally uploaded ones are media ids.
  const avatarUrl = await resolveAvatar(cfg.currentUser?.avatar ?? cfg.profile.avatar);
  setAvatar($<HTMLImageElement>('avatarImg'), $('userAvatar'), avatarUrl, displayName);
  setAvatar($<HTMLImageElement>('profileAvatarPreview'), $('profileAvatarInitial'), avatarUrl, displayName);
  // Folder contents come from their own ops so the snapshot stays synchronous
  // and cheap; the two listings are independent and can run together.
  const [backgroundLibrary, musicLibrary] = await Promise.all([
    call<LibraryItem[]>({ op: 'background:list' }),
    call<LibraryItem[]>({ op: 'music:list' }),
  ]);
  // Android's snapshot has no background field; never dereference undefined.
  const background = cfg.background ?? NO_BACKGROUND;
  applyBackground(background);
  applyMusic(musicLibrary, cfg.media?.bgm ?? null);
  renderBackgroundPanel(background);
  const chrome = cfg.media?.chrome ?? CHROME_FALLBACK;
  applyChrome(chrome);
  renderChromePanel(chrome);
  renderBackgroundLibrary(backgroundLibrary, background);
  renderPermissionState(cfg);
  applyPluginVisibility(cfg);
  // 图库不是打开设置的前提：媒体一多，逐个建 <img>/<video> 会让 WebView 主线程
  // 忙上好几秒（手机上表现为「点设置就卡死」）。让它自己慢慢填，面板立刻可用。
  void renderGallery();
}

/**
 * Re-renders the screen the user is on. Needed after a settings change that
 * the current screen depends on — activateView() is a no-op when the view has
 * not changed, so switching the network on would otherwise leave a stale
 * "weather offline" card on the home screen.
 */
function repaintActiveView(): void { if (activeView) mountPortal(activeView); }

// Portal screens write into the vault too (weather import), so they ask the
// diary shell to re-read the entry list instead of duplicating its cache.
window.addEventListener('diary-entries-changed', () => { void refresh(); });

/** Off means off: a disabled built-in plugin leaves the shell, for real. */
function applyPluginVisibility(cfg: Snapshot): void {
  const disabled = cfg.builtinPlugins.filter(plugin => !plugin.enabled).map(plugin => plugin.id);
  setPortalPlugins(disabled);
  const off = (id: string) => disabled.includes(id);

  const showView = (view: string, visible: boolean) => {
    const button = document.querySelector<HTMLElement>(`#primaryNav [data-view="${view}"]`);
    if (button) button.hidden = !visible;
  };
  showView('chat', !off('ai-agent'));
  showView('search-view', !off('ai-agent'));
  showView('competition', !off('competition'));
  showView('guide', !off('campus'));

  // The wallpaper plugin owns the background tab and the background itself.
  const mediaTab = document.querySelector<HTMLElement>('.settings-tabs [data-tab="media"]');
  if (mediaTab) mediaTab.hidden = off('wallpaper');
  if (off('wallpaper')) {
    const mediaPanel = document.querySelector<HTMLElement>('[data-tabpanel="media"]');
    if (mediaPanel) mediaPanel.hidden = true;
    if (mediaTab?.classList.contains('active')) {
      $('settingsPanel').querySelectorAll<HTMLElement>('.settings-tabs button').forEach(button => { if (!button.hidden) button.click(); });
    }
    applyBackground(structuredClone(NO_BACKGROUND));
  }

  // Never strand the user on a screen whose entry point just vanished.
  const activeNav = document.querySelector<HTMLElement>('#primaryNav .nav-item.active');
  if (activeNav?.hidden) activateView('home');
}
// ---------- Background (the built-in wallpaper plugin) ----------
const VIDEO_FILE = /\.(mp4|webm|mov|mkv|avi)$/i;

/** Tokens let a path with spaces or CJK characters survive a URL untouched. */
function toToken(absolutePath: string): string {
  const bytes = new TextEncoder().encode(absolutePath);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
/** Imported media and wallpaper files are streamed, never inlined as base64. */
function schemeUrl(kind: 'media' | 'wallpaper' | 'bg' | 'music', token: string): string {
  return `diary-wallpaper://${kind}/${token}`;
}
/**
 * Stream URL for whatever the saved background points at. Three sources are
 * possible: a file in <vault>/backgrounds, a Wallpaper Engine project, or a
 * legacy <vault>/media id written by an older build.
 */
function backgroundUrl(bg: BackgroundState): string | null {
  if (bg.kind === 'file') return bg.file ? schemeUrl('bg', encodeURIComponent(bg.file)) : null;
  if (bg.kind === 'wallpaper') return bg.wallpaper?.path ? schemeUrl('wallpaper', toToken(bg.wallpaper.path)) : null;
  return bg.media ? schemeUrl('media', bg.media) : null;
}
/** The path or name behind the background, used to tell a still from a clip. */
function backgroundSourceName(bg: BackgroundState): string {
  if (bg.kind === 'file') return bg.file ?? '';
  if (bg.kind === 'wallpaper') return bg.wallpaper?.path ?? '';
  return bg.media ?? '';
}
/** Music is always addressed by file name inside <vault>/music. */
function musicUrl(name: string): string {
  return schemeUrl('music', encodeURIComponent(name));
}

let backgroundRun = 0;
/** 当前真正铺在屏幕上的素材，用来判断「只改了外观」还是「换了素材」。 */
let paintedSource: string | null = null;
let paintedIsVideo = false;
/** 用户的意图：壁纸应当处于播放状态。Diary 没有「暂停壁纸」按钮，故恒为 true。 */
let bgWantPlay = false;

/**
 * 动态壁纸的播放自愈，照搬 DSH 壁纸插件的做法。
 *
 * `<video>` 的 `play()` 最常见的失败**不是**浏览器拒绝，而是被紧随其后的换源 /
 * `load()` 打断（`AbortError`）——那一刻元素已经 `paused`，用户看到的就是冻在首帧
 * 的静止画面。旧代码把这次 rejection 直接 `.catch(() => {})` 吞掉且从不重试，
 * 于是「动态壁纸卡成静态」就再也醒不过来。
 *
 * 这里的策略是「幂等重试 + 不说谎」：意图为播放而元素确实停着，就再 `play()` 一次；
 * `AbortError` 属于瞬时失败，允许媒体就绪后反复补播；其余错误（`NotAllowedError` /
 * `NotSupportedError` …）才记为真拒绝，不再无限重试。
 */
function ensureBackgroundPlayback(): void {
  const video = $<HTMLVideoElement>('bgVideo');
  if (!bgWantPlay || video.hidden) return;
  if (!video.paused && !video.ended && !video.error) return;
  const refused = video.dataset.diaryPlayRefused ?? '';
  // AbortError 不算真拒绝：换源打断它只是一瞬间的事，补播即可自愈。
  if (refused && refused !== 'AbortError') return;
  const attempt = video.play();
  if (!attempt || typeof attempt.then !== 'function') return;
  attempt.then(
    () => { delete video.dataset.diaryPlayRefused; },
    (error: DOMException) => { video.dataset.diaryPlayRefused = error?.name || '1'; },
  );
}

/** 每个 <video> 只挂一次监听，标记留在元素上，换素材也不会重复绑定。 */
function watchBackgroundVideo(video: HTMLVideoElement): void {
  if (video.dataset.diaryWatched === '1') return;
  video.dataset.diaryWatched = '1';
  // loadeddata/canplay = 媒体就绪 → 补播；pause/ended/stalled = 掉了 → 补播。
  for (const type of ['loadeddata', 'canplay', 'playing', 'pause', 'ended', 'stalled', 'error', 'emptied']) {
    video.addEventListener(type, () => { ensureBackgroundPlayback(); });
  }
}

/**
 * 素材刚挂上去的一小段时间里多催几次播放。
 *
 * 换素材时元素会先 `removeAttribute('src')` 再写新 src，它可能停留在 NETWORK_EMPTY
 * 而不主动开始加载 —— 此时 `play()` 的 promise 会一直悬着，`canplay` 也永远不会来，
 * 光等事件就是「20 秒静止画面」。这道兜底按梯度重试，一旦真的播起来就立刻收手。
 */
const BACKGROUND_NUDGE_DELAYS = [500, 1200, 2500, 5000];
function scheduleBackgroundNudges(run: number): void {
  for (const delay of BACKGROUND_NUDGE_DELAYS) {
    window.setTimeout(() => {
      if (run !== backgroundRun || !bgWantPlay) return;
      const video = $<HTMLVideoElement>('bgVideo');
      if (!video.paused && !video.ended && !video.error) return;
      ensureBackgroundPlayback();
    }, delay);
  }
}

// 从后台切回前台、窗口重新聚焦时再补一次，覆盖任何被系统级调度打断的情况。
document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureBackgroundPlayback(); });
window.addEventListener('focus', () => { ensureBackgroundPlayback(); });

/**
 * blur / brightness 合成为一条 `filter`。两者都在中性值时返回 `none` ——
 * 无滤镜的元素不建合成层，4K 视频不会再为「模糊 0px、亮度 100%」白跑一遍 GPU。
 */
function backgroundFilterValue(blur: number, brightnessPercent: number): string {
  return blur > 0 || brightnessPercent !== 100
    ? `blur(${blur}px) brightness(${brightnessPercent / 100})`
    : 'none';
}

/**
 * 纯外观参数（模糊 / 亮度 / 透明度 / 暗角 / 铺法）——只写 CSS 变量和元素样式，
 * 永远不碰 `src`。这是「拖一次滑块就把正在播的视频打回炉」的分界线。
 */
function applyBackgroundFit(fit: BackgroundState['fit'], image: HTMLElement, video: HTMLVideoElement): void {
  // A positioned replaced element needs an explicit content box before
  // object-fit can produce visibly different results on every Chromium build.
  video.style.width = 'calc(100vw - var(--sidebar-w))';
  video.style.height = '100vh';
  video.style.objectFit = fit === 'cover' ? 'cover'
    : fit === 'fill' ? 'fill'
      : fit === 'center' || fit === 'tile' ? 'none' : 'contain';
  video.style.objectPosition = 'center';
  image.style.backgroundSize = fit === 'contain' ? 'contain'
    : fit === 'fill' ? '100% 100%'
      : fit === 'center' || fit === 'tile' ? 'auto' : 'cover';
  image.style.backgroundRepeat = fit === 'tile' ? 'repeat' : 'no-repeat';
  image.style.backgroundPosition = 'center';
}

function paintBackgroundAppearance(bg: BackgroundState, image: HTMLElement, video: HTMLVideoElement): void {
  // 透明度 0 = 原画质：既不动素材本身的透明度，也不盖任何白纱。
  const fade = fadeOf(bg);
  const blur = Math.max(0, bg.blur);
  const brightnessPercent = Math.min(150, Math.max(50, bg.brightness ?? 100));
  document.documentElement.style.setProperty('--bg-blur', `${blur}px`);
  document.documentElement.style.setProperty('--bg-brightness', String(brightnessPercent / 100));
  document.documentElement.style.setProperty('--bg-fade', String(fade));
  document.documentElement.style.setProperty('--bg-filter', backgroundFilterValue(blur, brightnessPercent));
  // Only a blurred wallpaper needs to overhang: at 0 blur the frame is drawn
  // exactly as encoded, so nothing is magnified and nothing is cropped. 无模糊时
  // 直接 `none`，静止图连合成层都不建。
  document.documentElement.style.setProperty('--bg-transform', blur > 0 ? 'scale(1.06)' : 'none');

  applyBackgroundFit(bg.fit ?? 'fill', image, video);
}

/**
 * Paints the active background. Stills use a <div> so 平铺/居中 are possible;
 * clips use a <video> so a 500 MB wallpaper stays a stream instead of a data URL.
 */
function applyBackground(bg: BackgroundState): void {
  const run = ++backgroundRun;
  const image = $('bgImage'), video = $<HTMLVideoElement>('bgVideo'), dim = $('bgDimLayer'), veil = $('bgVeilLayer');
  const source = backgroundSourceName(bg);
  const url = backgroundUrl(bg);
  const isVideo = Boolean(bg.kind) && Boolean(source) && VIDEO_FILE.test(source);

  // ---- 同一个素材，只改了外观：原地更新，绝不重新加载 ----
  // 滑块每松一次手都会触发一次 background:set → loadConfig() → 这里。若此时重设
  // src，正在播放的视频会黑屏重来一次，正是用户报告的「卡顿 / 卡成静态」。
  if (bg.kind && source && url && source === paintedSource && isVideo === paintedIsVideo) {
    dim.hidden = false;
    dim.style.opacity = String(Math.min(1, Math.max(0, bg.dim)));
    veil.hidden = false;
    veil.style.opacity = String(fadeOf(bg) * 0.55);
    paintBackgroundAppearance(bg, image, video);
    if (isVideo) ensureBackgroundPlayback();
    return;
  }

  // ---- 换素材：先把手上的东西干净地撤掉 ----
  // hidden 必须先于 pause()：补播监听会忽略隐藏元素，否则这里会触发一次无意义的重试。
  bgWantPlay = false;
  video.hidden = true;
  video.pause();
  video.removeAttribute('src');
  video.load();   // 真正卸载：清空解码器，否则换素材时会带着旧流一起重置
  image.hidden = true;
  image.style.backgroundImage = '';
  dim.hidden = true; dim.style.opacity = '0';
  veil.hidden = true; veil.style.opacity = '0';
  document.body.classList.remove('has-bg');
  paintedSource = null;
  paintedIsVideo = false;
  document.documentElement.style.setProperty('--bg-filter', 'none');
  document.documentElement.style.setProperty('--bg-transform', 'none');
  document.documentElement.style.setProperty('--bg-fade', '0');
  if (!bg.kind) return;
  if (!source || !url) return;

  dim.hidden = false;
  dim.style.opacity = String(Math.min(1, Math.max(0, bg.dim)));
  veil.hidden = false;
  veil.style.opacity = String(fadeOf(bg) * 0.55);
  document.body.classList.add('has-bg');
  if (run !== backgroundRun) return;

  paintedSource = source;
  paintedIsVideo = isVideo;
  if (isVideo) {
    watchBackgroundVideo(video);
    bgWantPlay = true;
    video.src = url;
    video.hidden = false;
    // 上一段素材留下的是 NETWORK_EMPTY；不显式 load()，元素可能不会重新开始取流。
    // 这次 load() 会打断紧随其后的 play()（AbortError），但 AbortError 在我们的
    // 判定里属于「可重试」，canplay 监听和看门狗都会把它补回来。
    video.load();
    paintBackgroundAppearance(bg, image, video);
    ensureBackgroundPlayback();
    scheduleBackgroundNudges(run);
    return;
  }
  image.style.backgroundImage = `url("${url}")`;
  paintBackgroundAppearance(bg, image, video);
  image.hidden = false;
}

/** 透明度换算成遮罩浓度，两处（增量更新 / 换素材）共用一份算法。 */
function fadeOf(bg: BackgroundState): number {
  return Math.min(1, Math.max(0, (bg.opacity ?? 0) / 100));
}

// ---------- 壁纸可读性：文字颜色 / 字号 / 顶栏底色 ----------
// 照搬 DSH 壁纸插件的做法：往 :root 注入 CSS 变量；总开关关闭时逐个 removeProperty，
// 而不是写回「默认值」。变量一旦不存在，CSS 里的 var(--x, fallback) 就各自回落到
// 原生值，界面与从未设置过完全一致 —— 这是「关掉就干干净净还原」的关键。
const CHROME_VARS = ['--chrome-font-color', '--chrome-font-scale', '--chrome-topbar-bg', '--chrome-topbar-blur'] as const;

/** 用户是否显式挑过顶栏颜色。空字符串表示「跟随主题」，而 <input type="color"> 表达不了空。 */
let topbarColorChosen = false;

function applyChrome(chrome: ChromeState): void {
  const root = document.documentElement;
  document.body.classList.toggle('chrome-custom', chrome.fontCustom);
  if (!chrome.fontCustom) {
    for (const name of CHROME_VARS) root.style.removeProperty(name);
    return;
  }
  root.style.setProperty('--chrome-font-color', chrome.fontColor);
  root.style.setProperty('--chrome-font-scale', String(chrome.fontSize / CHROME_BASE_FONT_SIZE));
  if (chrome.topbarColor) {
    root.style.setProperty('--chrome-topbar-bg', chrome.topbarColor);
    // 顶栏一旦是纯色，毛玻璃就没意义了 —— 每帧一次背景采样就此省掉。
    root.style.setProperty('--chrome-topbar-blur', 'none');
  } else {
    root.style.removeProperty('--chrome-topbar-bg');
    root.style.removeProperty('--chrome-topbar-blur');
  }
}

function renderChromePanel(chrome: ChromeState): void {
  const custom = $<HTMLInputElement>('chromeCustom');
  custom.checked = chrome.fontCustom;
  $('bgChromeBody').hidden = !chrome.fontCustom;
  $<HTMLInputElement>('chromeFontColor').value = chrome.fontColor;
  $<HTMLInputElement>('chromeFontSize').value = String(chrome.fontSize);
  $('chromeFontSizeValue').textContent = `${chrome.fontSize}px`;
  topbarColorChosen = Boolean(chrome.topbarColor);
  // <input type="color"> 永远要有一个合法值：没设过时展示主题白，但状态里仍是空。
  $<HTMLInputElement>('chromeTopbarColor').value = chrome.topbarColor || '#ffffff';
}

/** 三个控件当前的值，合成一份完整状态 —— 开关本身也从面板上读。 */
function readChromePanel(): ChromeState {
  return {
    fontCustom: $<HTMLInputElement>('chromeCustom').checked,
    fontColor: $<HTMLInputElement>('chromeFontColor').value,
    fontSize: Number($<HTMLInputElement>('chromeFontSize').value) || CHROME_BASE_FONT_SIZE,
    topbarColor: topbarColorChosen ? $<HTMLInputElement>('chromeTopbarColor').value : '',
  };
}

/** 保存并重新读回配置：宿主会把颜色和字号都过一遍消毒，不让非法值落盘。 */
async function saveChrome(patch: Partial<ChromeState>): Promise<void> {
  const chrome = await call<ChromeState>({ op: 'chrome:set', ...patch });
  applyChrome(chrome);
  renderChromePanel(chrome);
}

$<HTMLInputElement>('chromeCustom').onchange = action(async () => {
  await saveChrome({ fontCustom: $<HTMLInputElement>('chromeCustom').checked });
});
/** 开关勾选的瞬间先本地生效，避免一次 IPC 往返造成的闪动。 */
$<HTMLInputElement>('chromeCustom').oninput = () => {
  const state = readChromePanel();
  $('bgChromeBody').hidden = !state.fontCustom;
  applyChrome(state.fontCustom ? state : CHROME_FALLBACK);
};

{
  const fontColor = $<HTMLInputElement>('chromeFontColor');
  fontColor.oninput = () => { document.documentElement.style.setProperty('--chrome-font-color', fontColor.value); };
  fontColor.onchange = action(async () => { await saveChrome({ fontColor: fontColor.value }); });

  const fontSize = $<HTMLInputElement>('chromeFontSize');
  fontSize.oninput = () => {
    const size = Number(fontSize.value) || CHROME_BASE_FONT_SIZE;
    $('chromeFontSizeValue').textContent = `${size}px`;
    document.documentElement.style.setProperty('--chrome-font-scale', String(size / CHROME_BASE_FONT_SIZE));
  };
  fontSize.onchange = action(async () => { await saveChrome({ fontSize: Number(fontSize.value) }); });

  const topbarColor = $<HTMLInputElement>('chromeTopbarColor');
  topbarColor.oninput = () => {
    topbarColorChosen = true;
    document.documentElement.style.setProperty('--chrome-topbar-bg', topbarColor.value);
    document.documentElement.style.setProperty('--chrome-topbar-blur', 'none');
  };
  topbarColor.onchange = action(async () => { await saveChrome({ topbarColor: topbarColor.value }); });
}
$('chromeTopbarReset').onclick = action(async () => {
  topbarColorChosen = false;
  await saveChrome({ topbarColor: '' });
  toast('顶栏已跟随主题');
});

// ---------- Background music: one folder, played in order, then looped ----------
type Track = { name: string; url: string };
let playlist: Track[] = [];
let trackIndex = 0;
/** The user's intent. Track changes must never override it. */
let musicWanted = false;

function paintMusicButton(): void {
  const button = $('musicToggle');
  const player = $<HTMLAudioElement>('bgmPlayer');
  const playing = !player.paused && !player.ended && Boolean(player.getAttribute('src'));
  button.classList.toggle('playing', playing);
  const label = playing ? '暂停背景音乐' : '播放背景音乐';
  button.title = label;
  button.setAttribute('aria-label', label);
}
/** Loads a track by index, wrapping around so the folder loops forever. */
function playTrack(index: number): void {
  const player = $<HTMLAudioElement>('bgmPlayer');
  if (!playlist.length) { player.pause(); player.removeAttribute('src'); paintMusicButton(); return; }
  trackIndex = ((index % playlist.length) + playlist.length) % playlist.length;
  player.src = playlist[trackIndex]!.url;
  void player.play().catch(() => undefined);
  paintMusicButton();
}
function toggleMusic(): void {
  const player = $<HTMLAudioElement>('bgmPlayer');
  if (!playlist.length) { toast('还没有音乐，先在「设置 → 壁纸与背景 → 背景音乐」导入'); return; }
  if (player.paused) {
    musicWanted = true;
    if (player.getAttribute('src')) void player.play().catch(() => undefined);
    else playTrack(trackIndex);
  } else { musicWanted = false; player.pause(); }
  paintMusicButton();
}

function renderMusicLibrary(items: LibraryItem[]): void {
  const grid = $('bgMusicGrid');
  grid.replaceChildren();
  const tracks = items.filter(item => item.mime.startsWith('audio/'));
  if (!tracks.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '音乐文件夹还是空的。点「导入音乐…」添加音频，之后会按文件名顺序循环播放。';
    grid.append(empty);
    return;
  }
  for (const item of tracks) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `wallpaper-card${playlist[trackIndex]?.name === item.name ? ' active' : ''}`;
    card.title = item.name;
    const thumb = document.createElement('span');
    thumb.className = 'wallpaper-thumb music-thumb';
    thumb.textContent = '♪';
    const name = document.createElement('b');
    name.textContent = item.name;
    const meta = document.createElement('small');
    meta.textContent = `${Math.max(1, Math.round(item.size / 1024))} KB`;
    const remove = document.createElement('span');
    remove.className = 'wp-remove';
    remove.textContent = '×';
    remove.title = '从音乐文件夹删除';
    remove.onclick = (event: MouseEvent) => {
      event.stopPropagation();
      void action(async () => {
        await call({ op: 'music:remove', name: item.name });
        await loadConfig();
        toast(`已删除「${item.name}」`);
      })();
    };
    card.append(thumb, name, meta, remove);
    card.onclick = action(async () => {
      musicWanted = true;
      const index = playlist.findIndex(track => track.name === item.name);
      playTrack(index < 0 ? 0 : index);
    });
    grid.append(card);
  }
}

/** Rebuilds the playlist from the folder and keeps the player honest. */
function applyMusic(items: LibraryItem[], legacyBgm: string | null): void {
  const tracks = items.filter(item => item.mime.startsWith('audio/'));
  const previous = playlist[trackIndex]?.name ?? '';
  playlist = tracks.length
    ? tracks.map(item => ({ name: item.name, url: musicUrl(item.name) }))
    // A track configured before this folder existed keeps working.
    : (legacyBgm ? [{ name: 'BGM', url: schemeUrl('media', legacyBgm) }] : []);
  // Deleting the track that was playing must not leave a dangling index.
  const keep = playlist.findIndex(track => track.name === previous);
  trackIndex = keep >= 0 ? keep : 0;
  const player = $<HTMLAudioElement>('bgmPlayer');
  if (!playlist.length) { player.pause(); player.removeAttribute('src'); }
  else if (musicWanted && !player.getAttribute('src')) playTrack(trackIndex);
  renderMusicLibrary(items);
  paintMusicButton();
}

$('musicToggle').onclick = () => toggleMusic();
$('bgmImport').onclick = action(async () => {
  const result = await call<{ canceled: boolean; items: LibraryItem[] }>({ op: 'music:import' });
  if (result.canceled || !result.items.length) return;
  await loadConfig();
  toast(`已导入 ${result.items.length} 首音乐，将按顺序循环播放`);
});
$('bgmOpen').onclick = action(async () => { await call({ op: 'music:openFolder' }); });
// Sequential playback. A `loop` attribute on the <audio> element would repeat
// one file forever and never fire `ended` — which is exactly why the folder
// could not advance before.
$('bgmPlayer').onended = () => { if (playlist.length) playTrack(trackIndex + 1); };
$('bgmPlayer').onplay = paintMusicButton;
$('bgmPlayer').onpause = paintMusicButton;

/** Reflects the saved background in the settings preview card and its controls. */
/** The library scan is slow (registry + Steam libraries), so it runs once. */
let wallpapersLoaded = false;
function renderBackgroundPanel(bg: BackgroundState): void {
  const still = $<HTMLElement>('bgPreviewImage'), clip = $<HTMLVideoElement>('bgPreviewVideo');
  const empty = $('bgPreviewEmpty'), label = $('bgPreviewLabel');
  still.hidden = true; still.style.backgroundImage = '';
  clip.pause(); clip.removeAttribute('src'); clip.hidden = true;
  const source = backgroundSourceName(bg);
  const url = backgroundUrl(bg);
  label.textContent = bg.kind === 'wallpaper' ? `Wallpaper · ${bg.wallpaper?.title ?? ''}`
    : bg.kind === 'file' ? `背景库 · ${bg.file ?? ''}`
      : bg.kind === 'video' ? '本地视频'
        : bg.kind === 'image' ? '本地图片／动图' : '';
  empty.hidden = Boolean(bg.kind);
  if (source && url) {
    if (VIDEO_FILE.test(source)) { clip.src = url; clip.hidden = false; void clip.play().catch(() => undefined); }
    else { still.style.backgroundImage = `url("${url}")`; still.hidden = false; }
  }
  ($('bgFit') as HTMLSelectElement).value = bg.fit;
  ($('bgDim') as HTMLInputElement).value = String(Math.round(bg.dim * 100));
  ($('bgBlur') as HTMLInputElement).value = String(Math.round(bg.blur));
  ($('bgOpacity') as HTMLInputElement).value = String(Math.round(bg.opacity ?? 0));
  ($('bgBrightness') as HTMLInputElement).value = String(Math.round(bg.brightness ?? 100));
  $('bgDimValue').textContent = `${Math.round(bg.dim * 100)}%`;
  $('bgBlurValue').textContent = `${Math.round(bg.blur)}px`;
  $('bgOpacityValue').textContent = `${Math.round(bg.opacity ?? 0)}%`;
  $('bgBrightnessValue').textContent = `${Math.round(bg.brightness ?? 100)}%`;
  // The library is listed right there, so it fills itself in on first view;
  // "重新扫描" and "选择目录…" force a fresh pass afterwards.
  if (!wallpapersLoaded) { wallpapersLoaded = true; void loadWallpapers(); }
}
/** Renders the imported-media gallery: click a tile to insert it, × to delete it. */
let galleryRun = 0;
async function renderGallery() {
  const run = ++galleryRun;
  const list = await call<{ id: string; name: string; mime: string; size: number }[]>({ op: 'media:list' });
  const gallery = $('mediaGallery');
  gallery.replaceChildren();
  gallery.hidden = list.length === 0;
  // 一次建完所有瓦片会让 WebView 同时发起几十个文件读取，主线程被 IO 和解码占满
  // ——手机上的表现就是设置页「突然卡死」。分批建、批与批之间把控制权交还浏览器。
  const BATCH = 8;
  for (const [index, item] of list.entries()) {
    if (run !== galleryRun) return;            // 期间又刷新过一次，放弃这次旧渲染
    if (index > 0 && index % BATCH === 0) await new Promise(requestAnimationFrame);
    const tile = document.createElement('button');
    tile.title = `${item.name} · ${Math.max(1, Math.round(item.size / 1024))} KB`;
    if (item.mime.startsWith('image') || item.mime.startsWith('video')) {
      // Stream the file over the media scheme — a 200 MB clip must never be base64'd.
      const url = schemeUrl('media', item.id);
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
      if (item.size > 8 * 1024 * 1024) { toast('这个文件太大，无法嵌入日记正文'); return; }
      const url = await call<string>({ op: 'media:data', id: item.id });
      insertText(`![${item.name}](${url})`);
      toast(t('done'));
    });
    tile.append(caption, remove); gallery.append(tile);
  }
}
function openSettings() { $('settingsPanel').hidden = false; }
// 先开面板再取数据：loadConfig() 要走好几个桥调用，等在前面会让「设置」看起来没反应。
$('settings').onclick = action(async () => { openSettings(); await loadConfig(); });
$('settingsClose').onclick = () => { $('settingsPanel').hidden = true; };
// Scoped to the settings panel: the AI-model screen owns its own tabs.
{
  const panel = $('settingsPanel');
  panel.querySelectorAll<HTMLButtonElement>('.settings-tabs button').forEach(button => {
    button.onclick = () => {
      panel.querySelectorAll('.settings-tabs button').forEach(b => b.classList.remove('active'));
      button.classList.add('active');
      const tab = button.dataset.tab!;
      panel.querySelectorAll<HTMLElement>('[data-tabpanel]').forEach(p => { p.hidden = p.dataset.tabpanel !== tab; });
    };
  });
}
// ---- AI model screen (standalone entry in the sidebar) ----
$('aiModels').onclick = action(async () => { await openAiModels(); });
$('aiModelClose').onclick = () => { $('aiModelPanel').hidden = true; };
$('aiModelTabs').querySelectorAll<HTMLButtonElement>('button').forEach(button => {
  button.onclick = () => {
    $('aiModelTabs').querySelectorAll('button').forEach(b => b.classList.remove('active'));
    button.classList.add('active');
    const tab = button.dataset.aiTab!;
    document.querySelectorAll<HTMLElement>('[data-ai-panel]').forEach(p => { p.hidden = p.dataset.aiPanel !== tab; });
  };
});
// A dead end with no explanation is the worst outcome, so either page can prove
// the backend really answers instead of leaving the user to guess.
async function runProbe(outId: string): Promise<void> {
  const out = $(outId);
  out.className = 'ai-status pending';
  out.textContent = '正在测试，请稍候…';
  const result = await call<{ ok: boolean; ms: number; provider: string; model: string; detail: string }>({ op: 'agent:probe' });
  out.className = `ai-status ${result.ok ? 'ok' : 'bad'}`;
  out.textContent = result.ok
    ? `✓ ${result.provider} · ${result.model} · ${result.ms} ms · 回复「${result.detail}」`
    : `✗ ${result.provider} · ${result.model}：${result.detail}`;
}
$('aiApiSave').onclick = action(async () => {
  const id = $<HTMLSelectElement>('aiVendor').value;
  const key = $<HTMLInputElement>('aiApiKey').value;
  await call({ op: 'config:setProvider', id, baseUrl: $<HTMLInputElement>('aiApiBase').value, model: $<HTMLInputElement>('aiApiModel').value, ...(key ? { next: key } : {}) });
  await loadConfig();
  await openAiModels();
  toast('已保存并启用');
});
$('aiApiTest').onclick = action(async () => { await runProbe('aiApiTestResult'); });
$('aiCustomAdd').onclick = action(async () => {
  const id = $<HTMLInputElement>('aiCustomName').value.trim();
  if (!id) { toast('请先填写名称'); return; }
  const key = $<HTMLInputElement>('aiCustomKey').value;
  await call({
    op: 'provider:create', id,
    label: $<HTMLInputElement>('aiCustomLabel').value.trim(),
    baseUrl: $<HTMLInputElement>('aiCustomBase').value.trim(),
    model: $<HTMLInputElement>('aiCustomModel').value.trim(),
    ...(key ? { next: key } : {}),
  });
  for (const field of ['aiCustomName', 'aiCustomLabel', 'aiCustomBase', 'aiCustomModel', 'aiCustomKey']) $<HTMLInputElement>(field).value = '';
  await loadConfig();
  await openAiModels();
  toast(`已添加「${id}」并启用`);
});
$('aiWbSave').onclick = action(async () => {
  // Enabling the plugin and picking it as the active backend is one decision
  // here, so a user who just wants WorkBuddy to answer only clicks once.
  await call({ op: 'plugin:toggle', pluginId: 'workbuddy', enabled: true });
  await call({ op: 'config:setProvider', id: 'workbuddy', model: $<HTMLSelectElement>('aiWbModel').value });
  await loadConfig();
  await openAiModels();
  toast('已启用 WorkBuddy 插件');
});
$('aiWbTest').onclick = action(async () => { await runProbe('aiWbTestResult'); });
$('cfgLocale').onchange = () => { locale.setLocale($<HTMLSelectElement>('cfgLocale').value); localStorage.setItem('diary.locale', locale.locale); translate(); };
$('accountChangePwd').onclick = action(async () => {
  const r = await modal('修改密码', '输入原密码后设置新密码。', [
    { name: 'passcode', label: '原密码' },
    { name: 'next', label: '新密码（至少 8 位）' },
    { name: 'confirmation', label: '确认新密码' },
  ]);
  if (!r) return;
  await call({ op: 'account:changePassword', passcode: r.passcode ?? '', next: r.next ?? '', confirmation: r.confirmation ?? '' });
  await loadConfig(); toast('密码已修改');
});
$('accountRecovery').onclick = action(async () => {
  const r = await modal('设置密保问题', '忘记密码时可通过回答密保问题重置。请牢记答案。', [
    { name: 'question', label: '密保问题', type: 'text' },
    { name: 'answer', label: '密保答案', type: 'text' },
  ]);
  if (!r) return;
  await call({ op: 'account:setRecovery', question: r.question ?? '', answer: r.answer ?? '' });
  await loadConfig(); toast('密保问题已设置');
});
$('accountSet').onclick = action(async () => { showLock(false); });

// ---------- Google OAuth (real, built-in client IDs) ----------
const IS_DESKTOP = !!window.diary;
const GOOGLE_CLIENT_ID = IS_DESKTOP
  ? '933958043196-c8ktud98bdmkbiovnns1dst47b7mcb19.apps.googleusercontent.com'
  : '933958043196-8otpn6ub49h2oo2agrdjocljl5p3559g.apps.googleusercontent.com';
const GOOGLE_ANDROID_REDIRECT = 'com.googleusercontent.apps.933958043196-8otpn6ub49h2oo2agrdjocljl5p3559g:/oauth2callback';
async function pkceChallenge(): Promise<{ verifier: string; challenge: string }> {
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const challenge = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { verifier, challenge };
}
const oauthAndroidPending = new Map<string, { verifier: string }>();
let oauthAndroidResolve: ((value: { email?: string; name?: string } | null) => void) | null = null;
(window as unknown as { __diaryOAuthRedirect?: (uri: string) => void }).__diaryOAuthRedirect = (uri: string) => {
  try {
    const u = new URL(uri);
    const code = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    const pending = state ? oauthAndroidPending.get(state) : null;
    if (!code || !state || !pending) { toast('Google 授权回调无效，请重试，或在设置中手动粘贴授权码。'); return; }
    oauthAndroidPending.delete(state);
    void (async () => {
      try {
        const res = await call<{ ok: boolean; email: string; name: string }>({ op: 'account:oauthFinish', provider: 'google', code, codeVerifier: pending.verifier, redirectUri: GOOGLE_ANDROID_REDIRECT });
        oauthAndroidResolve?.(res.ok ? res : null);
      } catch (error) { toast('Google 登录失败：' + (error as Error).message); oauthAndroidResolve?.(null); }
    })();
  } catch { toast('Google 授权回调解析失败。'); }
};

async function loginWithGoogle(): Promise<void> {
  let info: { email?: string; name?: string } | null = null;
  if (IS_DESKTOP) {
    info = await call<{ email?: string; name?: string }>({ op: 'account:oauthGoogle' });
  } else {
    const { verifier, challenge } = await pkceChallenge();
    const state = crypto.randomUUID();
    oauthAndroidPending.set(state, { verifier });
    const begin = await call<{ url: string }>({ op: 'account:oauthBegin', provider: 'google', clientId: GOOGLE_CLIENT_ID, redirectUri: GOOGLE_ANDROID_REDIRECT, state, codeChallenge: challenge });
    await call({ op: 'openExternal', url: begin.url });
    toast('请在系统浏览器完成 Google 授权，授权后会自动返回 Diary。');
    info = await new Promise<{ email?: string; name?: string } | null>(resolve => { oauthAndroidResolve = resolve; });
  }
  if (!info) { toast('Google 登录未完成。'); return; }
  await afterGoogle(info);
}

// settings: sign in / sign out
$('googleLogin').onclick = action(async () => {
  $('googleState').textContent = '已打开浏览器，请在浏览器中完成 Google 授权…';
  try { await loginWithGoogle(); }
  catch (error) {
    const message = localizedError(error);
    $('googleState').textContent = `Google 登录失败：${message}`;
    throw error;
  }
});
$('googleLogout').onclick = action(async () => {
  if (!await modal(t('deleteEntry'), '退出后当前账户将回到登录界面，本地资料保留，需要时可重新登录。')) return;
  await call({ op: 'account:signOut' });
  await refreshSnapshot(); await loadConfig(); toast('已退出登录');
});
// Android manual fallback when the deep link does not fire
$('googleFinish').onclick = action(async () => {
  const code = $<HTMLInputElement>('googleCode').value.trim();
  const state = [...oauthAndroidPending.keys()][0];
  const pending = state ? oauthAndroidPending.get(state) : null;
  if (!code || !state || !pending) { toast(t('oauthCode')); return; }
  oauthAndroidPending.delete(state);
  const res = await call<{ ok: boolean; email: string; name: string }>({ op: 'account:oauthFinish', provider: 'google', code, codeVerifier: pending.verifier, redirectUri: GOOGLE_ANDROID_REDIRECT });
  await afterGoogle(res.ok ? res : { email: '', name: '' });
});

// ---------- Profile avatar ----------
/**
 * OS picker for what still needs raw bytes (avatars, diary illustrations).
 * The cancel path is load-bearing: Chromium fires no `change` event when the
 * user dismisses the dialog, so the old version left this promise pending
 * forever — and the global busy flag, and therefore every button in the app,
 * stuck behind it.
 */
function pickFile(accept: string): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = accept;
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      input.remove();
      resolve(file);
    };
    // The window regains focus right after the dialog closes either way; the
    // delay lets a genuine selection win the race.
    const onFocus = () => { setTimeout(() => finish(null), 600); };
    input.onchange = () => finish(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => finish(null));
    window.addEventListener('focus', onFocus, { once: true });
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
  const file = await pickFile('image/*'); if (!file) return;
  const { data, mime } = await fileToBase64(file);
  const info = await call<{ id: string }>({ op: 'media:import', name: file.name, mime, data });
  await call({ op: 'profile:set', avatar: info.id });
  const url = await resolveAvatar(info.id);
  const name = lastSnapshot?.currentUser?.displayName || lastSnapshot?.profile.username || '本地用户';
  setAvatar($<HTMLImageElement>('avatarImg'), $('userAvatar'), url, name);
  setAvatar($<HTMLImageElement>('profileAvatarPreview'), $('profileAvatarInitial'), url, name);
  toast(t('done'));
});
$('profileSave').onclick = action(async () => {
  const nickname = $<HTMLInputElement>('profileUsername').value.trim();
  await call({ op: 'profile:set', username: nickname, signature: $<HTMLTextAreaElement>('profileSignature').value });
  // Keep the signed-in account's display name in sync with the nickname.
  const uid = lastSnapshot?.currentUser?.id;
  if (uid && nickname) await call({ op: 'account:renameDisplay', id: uid, displayName: nickname }).catch(() => undefined);
  await refreshSnapshot(); await loadConfig();
  toast('资料已保存');
});

// ---------- Media: background & BGM ----------
async function importMediaAs(accept: string): Promise<string | null> {
  const file = await pickFile(accept); if (!file) return null;
  const { data, mime } = await fileToBase64(file);
  const info = await call<{ id: string }>({ op: 'media:import', name: file.name, mime, data });
  return info.id;
}
// ---------- Wallpaper plugin: sources, library, appearance ----------
type WallpaperEntry = {
  id: string; title: string; type: string; dir: string; source: string;
  media: string | null; preview: string | null; animated: boolean; note: string;
};

/**
 * Imports through the OS dialog and copies straight into <vault>/backgrounds.
 * The in-page <input type=file> path is gone for good: it could not report a
 * cancel, so its promise never settled, the global busy flag stayed set and
 * every later button answered "上一个操作还在进行中" — the "点不动" report.
 */
async function importBackgroundFiles(kind?: 'image' | 'video'): Promise<void> {
  const result = await call<{ canceled: boolean; items: LibraryItem[] }>({ op: 'background:import', ...(kind ? { kind } : {}) });
  if (result.canceled || !result.items.length) return;
  await call({ op: 'background:set', file: result.items[0]!.name });
  await loadConfig();
  toast(result.items.length > 1
    ? `已导入 ${result.items.length} 个文件，当前使用「${result.items[0]!.name}」`
    : `已应用背景：${result.items[0]!.name}`);
}
$('bgPickImage').onclick = action(() => importBackgroundFiles('image'));
$('bgPickGif').onclick = action(() => importBackgroundFiles('image'));
$('bgPickVideo').onclick = action(() => importBackgroundFiles('video'));
$('bgFolderImport').onclick = action(() => importBackgroundFiles());
$('bgFolderOpen').onclick = action(async () => { await call({ op: 'background:openFolder' }); });
$('bgClear').onclick = action(async () => {
  await call({ op: 'background:clear' });
  await loadConfig();
  toast('已清除背景');
});

/** The background folder itself, rendered as pickable tiles. */
function renderBackgroundLibrary(items: LibraryItem[], active: BackgroundState): void {
  const grid = $('bgFolderGrid');
  grid.replaceChildren();
  $('bgFolderState').textContent = items.length ? `${items.length} 个文件` : '';
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '背景库还是空的。点「导入文件…」添加图片、动图或视频，也可以直接把文件复制进背景库文件夹。';
    grid.append(empty);
    return;
  }
  for (const item of items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `wallpaper-card${active.kind === 'file' && active.file === item.name ? ' active' : ''}`;
    card.title = `${item.name} · ${Math.max(1, Math.round(item.size / 1024))} KB`;
    const thumb = document.createElement('span');
    thumb.className = 'wallpaper-thumb';
    const url = schemeUrl('bg', encodeURIComponent(item.name));
    if (item.mime.startsWith('video/')) {
      const clip = document.createElement('video');
      clip.src = url; clip.muted = true; clip.loop = true; clip.autoplay = true; clip.playsInline = true;
      thumb.append(clip);
    } else {
      thumb.style.backgroundImage = `url("${url}")`;
    }
    const name = document.createElement('b');
    name.textContent = item.name;
    const meta = document.createElement('small');
    meta.textContent = `${item.mime.startsWith('video/') ? '视频' : '图片'} · ${Math.max(1, Math.round(item.size / 1024))} KB`;
    const remove = document.createElement('span');
    remove.className = 'wp-remove';
    remove.textContent = '×';
    remove.title = '从背景库删除';
    remove.onclick = (event: MouseEvent) => {
      event.stopPropagation();
      void action(async () => {
        await call({ op: 'background:remove', name: item.name });
        await loadConfig();
        toast(`已删除「${item.name}」`);
      })();
    };
    card.append(thumb, name, meta, remove);
    card.onclick = action(async () => {
      await call({ op: 'background:set', file: item.name });
      await loadConfig();
      toast(`已应用背景：${item.name}`);
    });
    grid.append(card);
  }
}
{
  const fit = $<HTMLSelectElement>('bgFit');
  // Apply immediately so the user can see every fit mode without waiting for
  // disk I/O. Persisting uses the sanitised state returned by the host and
  // updates only the wallpaper, never reloads the video or the whole settings UI.
  fit.oninput = () => {
    applyBackgroundFit(fit.value as BackgroundState['fit'], $('bgImage'), $<HTMLVideoElement>('bgVideo'));
  };
  fit.onchange = action(async () => {
    const background = await call<BackgroundState>({ op: 'background:set', fit: fit.value });
    applyBackground(background);
    renderBackgroundPanel(background);
  });
}

/**
 * Live preview while dragging; only the release persists. `opacity` reads
 * backwards from most sliders on purpose: 0 is the untouched original, so the
 * preview keeps the clip at full strength until the user asks for less.
 */
/** 读一个 range 滑块的当前值，元素缺失或值异常时回落到给定默认。 */
function readSlider(id: string, fallback: number): number {
  const element = document.getElementById(id) as HTMLInputElement | null;
  const value = Number(element?.value);
  return Number.isFinite(value) ? value : fallback;
}

/** 拖动 blur / brightness 时的实时预览：两个滑块共用同一条 filter。 */
function previewBackgroundFilter(): void {
  const blur = readSlider('bgBlur', 0);
  const brightness = readSlider('bgBrightness', 100);
  document.documentElement.style.setProperty('--bg-filter', backgroundFilterValue(blur, brightness));
  document.documentElement.style.setProperty('--bg-transform', blur > 0 ? 'scale(1.06)' : 'none');
}

function bindBackgroundSlider(id: 'bgDim' | 'bgBlur' | 'bgOpacity' | 'bgBrightness', labelId: string, unit: string): void {
  const input = $<HTMLInputElement>(id);
  input.oninput = () => {
    const value = Number(input.value);
    $(labelId).textContent = `${value}${unit}`;
    if (id === 'bgDim') $('bgDimLayer').style.opacity = String(value / 100);
    else if (id === 'bgBlur' || id === 'bgBrightness') previewBackgroundFilter();
    else {
      const fade = value / 100;
      document.documentElement.style.setProperty('--bg-fade', String(fade));
      $('bgVeilLayer').style.opacity = String(fade * 0.55);
    }
  };
  input.onchange = action(async () => {
    const value = Number(input.value);
    const background = await call<BackgroundState>(id === 'bgDim' ? { op: 'background:set', dim: value / 100 }
      : id === 'bgBlur' ? { op: 'background:set', blur: value }
        : id === 'bgBrightness' ? { op: 'background:set', brightness: value }
          : { op: 'background:set', opacity: value });
    applyBackground(background);
    renderBackgroundPanel(background);
  });
}
bindBackgroundSlider('bgOpacity', 'bgOpacityValue', '%');
bindBackgroundSlider('bgBrightness', 'bgBrightnessValue', '%');
bindBackgroundSlider('bgDim', 'bgDimValue', '%');
bindBackgroundSlider('bgBlur', 'bgBlurValue', 'px');

const WALLPAPER_KIND: Record<string, string> = { video: '视频', scene: '场景', web: '网页', application: '应用', text: '文字', other: '壁纸' };
function renderWallpaperGrid(entries: WallpaperEntry[]): void {
  const grid = $('bgLibraryGrid');
  grid.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '没有可用的壁纸项目。可以点「选择目录…」手动指定，或直接用上面的图片／动图／视频。';
    grid.append(empty);
    return;
  }
  for (const entry of entries) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'wallpaper-card';
    card.title = entry.dir;
    const thumb = document.createElement('span');
    thumb.className = 'wallpaper-thumb';
    const thumbPath = entry.preview ?? entry.media;
    if (thumbPath) {
      const url = schemeUrl('wallpaper', toToken(thumbPath));
      if (VIDEO_FILE.test(thumbPath)) {
        const clip = document.createElement('video');
        clip.src = url; clip.muted = true; clip.loop = true; clip.autoplay = true; clip.playsInline = true;
        thumb.append(clip);
      } else thumb.style.backgroundImage = `url("${url}")`;
    }
    const name = document.createElement('b');
    name.textContent = entry.title;
    const meta = document.createElement('small');
    meta.textContent = `${WALLPAPER_KIND[entry.type] ?? '壁纸'} · ${entry.animated ? '动效' : '静态'}`;
    card.append(thumb, name, meta);
    if (entry.note) { const note = document.createElement('em'); note.textContent = entry.note; card.append(note); }
    card.onclick = action(async () => {
      const source = entry.media ?? entry.preview;
      if (!source) { toast('这个壁纸没有可直接播放的文件'); return; }
      await call({ op: 'background:set', kind: 'wallpaper', path: source, title: entry.title, animated: entry.animated });
      await loadConfig();
      toast(`已应用壁纸：${entry.title}`);
    });
    grid.append(card);
  }
}

async function loadWallpapers(): Promise<void> {
  $('bgLibraryState').textContent = '扫描中…';
  const scan = await call<{ engines: string[]; entries: WallpaperEntry[]; hint: string }>({ op: 'wallpaper:scan' });
  renderWallpaperGrid(scan.entries);
  $('bgLibraryState').textContent = `${scan.engines.length} 个目录 · ${scan.entries.length} 个壁纸`;
  $('bgLibraryHint').textContent = scan.hint || (scan.engines.length ? `扫描目录：${scan.engines.join(' · ')}` : '');
}
$('bgLibraryRescan').onclick = action(loadWallpapers);
$('bgLibraryPick').onclick = action(async () => {
  const result = await call<{ canceled: boolean; dir: string | null; engines: string[]; entries: WallpaperEntry[]; hint: string }>({ op: 'wallpaper:pick' });
  $('bgLibrary').hidden = false;
  if (result.canceled) return;
  renderWallpaperGrid(result.entries);
  $('bgLibraryState').textContent = `${result.engines.length} 个目录 · ${result.entries.length} 个壁纸`;
  $('bgLibraryHint').textContent = result.hint || `扫描目录：${result.engines.join(' · ')}`;
  toast(`已选择目录：${result.dir ?? ''}`);
});

// ---------- Permissions & location ----------
function renderPermissionState(cfg: Snapshot): void {
  setPortalNetwork(cfg.permissions.network);
  ($('permNetwork') as HTMLInputElement).checked = cfg.permissions.network;
  ($('permLocation') as HTMLInputElement).checked = cfg.permissions.location;
  ($('locMode') as HTMLSelectElement).value = cfg.location.mode;
  $('locManual').hidden = cfg.location.mode !== 'manual';
  ($('locLat') as HTMLInputElement).value = cfg.location.lat === null ? '' : String(cfg.location.lat);
  ($('locLon') as HTMLInputElement).value = cfg.location.lon === null ? '' : String(cfg.location.lon);
  ($('locLabel') as HTMLInputElement).value = cfg.location.label;
  const where = cfg.location.label
    || (cfg.location.lat !== null && cfg.location.lon !== null ? `${cfg.location.lat.toFixed(3)}, ${cfg.location.lon.toFixed(3)}` : '未设置');
  $('locState').textContent = !cfg.permissions.network
    ? '联网已关闭：天气、AI 问答与 AI 搜索都不会发起任何请求。'
    : cfg.permissions.location ? `天气位置将使用：${where}` : '未开启定位：请手动填写经纬度后再打开天气。';
}
$('permNetwork').onchange = action(async () => {
  const network = ($('permNetwork') as HTMLInputElement).checked;
  await call({ op: 'permission:set', network });
  await loadConfig();
  repaintActiveView();
  toast(network ? '已允许联网，天气会自动刷新' : '已关闭联网');
});
$('permLocation').onchange = action(async () => {
  const location = ($('permLocation') as HTMLInputElement).checked;
  await call({ op: 'permission:set', location });
  await loadConfig();
  repaintActiveView();
  toast(location ? '已允许定位' : '已关闭定位');
});
$('locMode').onchange = action(async () => {
  await call({ op: 'location:set', mode: ($('locMode') as HTMLSelectElement).value });
  await loadConfig();
  repaintActiveView();
});
$('locSave').onclick = action(async () => {
  const lat = Number(($('locLat') as HTMLInputElement).value);
  const lon = Number(($('locLon') as HTMLInputElement).value);
  await call({
    op: 'location:set', mode: 'manual', label: ($('locLabel') as HTMLInputElement).value.trim(),
    ...(Number.isFinite(lat) ? { lat } : {}), ...(Number.isFinite(lon) ? { lon } : {}),
  });
  await loadConfig();
  repaintActiveView();
  toast('定位已保存');
});

// ---------- Plugin manager (sidebar, between 导入日记 and 设置) ----------
function pluginRow(name: string, detail: string, badge: string, badgeClass: string, actionButton?: { label: string; run: () => void }): HTMLElement {
  const row = document.createElement('div');
  row.className = 'plugin-row';
  const info = document.createElement('div');
  info.className = 'plugin-info';
  const title = document.createElement('b');
  title.textContent = name;
  const sub = document.createElement('small');
  sub.textContent = detail;
  info.append(title, sub);
  const tag = document.createElement('span');
  tag.className = `plugin-badge ${badgeClass}`;
  tag.textContent = badge;
  row.append(info, tag);
  if (actionButton) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'plugin-toggle';
    button.textContent = actionButton.label;
    button.onclick = actionButton.run;
    row.append(button);
  }
  return row;
}

async function openPluginManager(): Promise<void> {
  const list = await call<PluginList>({ op: 'plugin:list' });
  // External plugins live in a desktop folder; on a phone the manager is a
  // switchboard for built-in features instead.
  if (window.NativeDiary) {
    $('externalPluginList').previousElementSibling!.textContent = '';
    $('externalPluginList').hidden = true;
    $('pluginOpenDir').hidden = true;
    $('pluginRescan').hidden = true;
    $('pluginPanel').querySelector<HTMLElement>('.settings-body > .hint')!.textContent = '管理手机端内置功能。关闭功能后，其入口会从侧边栏隐藏，数据仍会保留。';
  }
  const builtinHost = $('builtinPluginList');
  builtinHost.replaceChildren();
  for (const plugin of list.builtin) {
    builtinHost.append(pluginRow(
      `${plugin.name}`,
      `${plugin.description}　v${plugin.version}`,
      plugin.enabled ? '已启用' : '已停用',
      plugin.enabled ? 'on' : 'off',
      {
        label: plugin.enabled ? '停用' : '启用',
        run: () => { void (async () => {
          await call({ op: 'plugin:toggle', pluginId: plugin.id, enabled: !plugin.enabled });
          toast(`${plugin.name}已${plugin.enabled ? '停用' : '启用'}`);
          await loadConfig();
          await openPluginManager();
          repaintActiveView();
        })(); },
      },
    ));
  }
  const externalHost = $('externalPluginList');
  externalHost.replaceChildren();
  if (!list.external.length && !list.errors.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = '还没有外部插件。把 .mjs 文件放进下面的插件目录，重启后它会出现在侧边栏「AI 模型」里并可在那里启用。';
    externalHost.append(empty);
  }
  for (const plugin of list.external) {
    externalHost.append(pluginRow(
      plugin.label,
      `${plugin.custom ? '自带传输层（无需 API Key）' : `${plugin.baseUrl || '未填地址'} · ${plugin.model || '未指定模型'}`}　id: ${plugin.id}`,
      '已加载', 'on',
    ));
  }
  for (const problem of list.errors) {
    externalHost.append(pluginRow(problem.file.split(/[\\/]/).pop() ?? problem.file, problem.message, '加载失败', 'bad'));
  }
  $('pluginDirHint').textContent = list.directory ? `插件目录：${list.directory}` : '';
  $('pluginPanel').hidden = false;
}
$('pluginManage').onclick = action(openPluginManager);
$('pluginClose').onclick = () => { $('pluginPanel').hidden = true; };
$('pluginOpenDir').onclick = action(async () => { await call({ op: 'plugin:openDir' }); toast('已打开插件目录'); });
$('pluginRescan').onclick = action(async () => {
  const scan = await call<{ entries: unknown[] }>({ op: 'wallpaper:scan' });
  toast(`已重新扫描壁纸库：${scan.entries.length} 个项目`);
});

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
// ---------- Diary mode: the imported weather system ----------
let diaryWeather: WeatherOk | null = null;

/** Renders the full metric table inside the diary popover. */
function paintDiaryWeather(report: WeatherReport): void {
  const out = $('webResult');
  out.replaceChildren();
  if (!report.ok) {
    diaryWeather = null;
    out.textContent = report.message;
    return;
  }
  diaryWeather = report;
  const grid = document.createElement('div');
  grid.className = 'web-weather-grid';
  for (const [label, value] of weatherMetrics(report.weather)) {
    const cell = document.createElement('div');
    const key = document.createElement('small');
    key.textContent = label;
    const val = document.createElement('b');
    val.textContent = value;
    cell.append(key, val);
    grid.append(cell);
  }
  out.append(grid);
  const meta = document.createElement('p');
  meta.className = 'hint';
  meta.textContent = `${report.place || '当前位置'}`
    + (report.air ? ` · 空气 ${report.air.aqi ?? '—'} ${report.air.level}` : '')
    + ' · 来源 Open-Meteo';
  out.append(meta);
}

async function loadDiaryWeather(): Promise<boolean> {
  const report = await call<WeatherReport>({ op: 'weather:now' });
  paintDiaryWeather(report);
  if (!report.ok) toast(report.message);
  return report.ok;
}

$('webWeatherNow').onclick = action(loadDiaryWeather);
$('webWeatherImport').onclick = action(async () => {
  if (!diaryWeather && !await loadDiaryWeather()) return;
  if (!diaryWeather) return;
  insertText(weatherToMarkdown(diaryWeather));
  $('webPopover').hidden = true;
  toast('天气已写入日记正文');
});
$('webWeather').onclick = action(async () => {
  const lat = parseFloat($<HTMLInputElement>('webLat').value); const lon = parseFloat($<HTMLInputElement>('webLon').value);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { toast(t('fetchLocation')); return; }
  const w = await call<{ tempC: number; description: string; humidity: number | null }>({ op: 'web:weather', lat, lon });
  $('webResult').textContent = `${t('fetchWeather')}：${w.description}，${w.tempC}°C`;
  insertText(`天气：${w.description}，${w.tempC}°C`);
});

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
{
  const heading = document.querySelector<HTMLElement>('#diarySidebar .list-heading')!;
  heading.replaceChildren();
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'diary-catalog-toggle';
  toggle.innerHTML = '<span>日记目录</span><span class="catalog-arrow">⌄</span>'; toggle.setAttribute('aria-expanded', 'true');
  heading.append(toggle);
  toggle.onclick = () => {
    const open = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!open)); $('entries').hidden = open;
    toggle.querySelector('.catalog-arrow')!.textContent = open ? '›' : '⌄';
  };
}
title.oninput = editor.oninput = () => { dirty = true; status(); };
$('editTab').onclick = () => view(false); $('previewTab').onclick = () => view(true);
$('more').onclick = (event) => {
  event.stopPropagation();
  $('moreMenu').hidden = !$('moreMenu').hidden;
};
// The menu belongs to the three-dot button, not to the whole editor. Clicking
// anywhere beside it (including the wallpaper) dismisses it; clicks inside keep
// it open so Export/Delete remain usable. Capture phase also survives handlers
// on dynamically rendered portal content.
document.addEventListener('pointerdown', (event) => {
  const menu = $('moreMenu');
  if (menu.hidden) return;
  const target = event.target;
  if (!(target instanceof Node) || (!menu.contains(target) && !$('more').contains(target))) menu.hidden = true;
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') $('moreMenu').hidden = true;
});
$('openSidebar').onclick = () => document.body.classList.toggle('sidebar-open');
$('closeSidebar').onclick = () => document.body.classList.remove('sidebar-open');
// Tapping the dimmed area behind the drawer dismisses it, the way a native
// navigation drawer does; the button itself toggles so a second tap closes.
$('sidebarScrim').onclick = () => document.body.classList.remove('sidebar-open');
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

// ---------- Unified one-stop navigation ----------
const viewTitles: Record<PortalViewName, string> = { home: '首页', chat: 'AI 问答', 'search-view': 'AI 搜索', competition: '竞赛中心', guide: '办事指南', diary: '日记', vpn: '学校 VPN', pets: '桌面宠物' };
let activeView: PortalViewName | null = null;
function activateView(viewName: PortalViewName) {
  if (activeView === viewName) return;
  activeView = viewName;
  const ids: Record<PortalViewName, string> = { home: 'homeView', chat: 'chatView', 'search-view': 'searchView', competition: 'competitionView', guide: 'guideView', diary: 'diaryView', vpn: 'vpnView', pets: 'petsView' };
  for (const [name,id] of Object.entries(ids) as [PortalViewName,string][]) if (!$(id) && (name === 'vpn' || name === 'pets')) { const panel=document.createElement('section'); panel.id=id; panel.className='portal-view'; document.querySelector('main')?.insertBefore(panel,$('toast')); }
  for (const [name, id] of Object.entries(ids) as [PortalViewName, string][]) {
    const panel = $(id); panel.hidden = name !== viewName; panel.classList.toggle('active-view', name === viewName);
  }
  document.querySelectorAll<HTMLButtonElement>('#primaryNav [data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === viewName));
  $('diarySidebar').hidden = viewName !== 'diary';
  // The music button belongs to the portal screens; the diary editor has its
  // own chrome and needs no floating control over the page.
  $('musicToggle').hidden = viewName === 'diary';
  $('breadcrumbDate').textContent = viewTitles[viewName];
  document.body.classList.remove('sidebar-open');
  // Every portal screen renders itself from in-memory data, so opening a view
  // never waits on a probe or a network round-trip.
  mountPortal(viewName);
}
// Portal screens move the router through this hook (prompt chips -> chat).
setPortalNavigator(activateView);
{
  const button = document.createElement('button');
  button.id = 'tutorialButton'; button.type = 'button'; button.className = 'nav-item tutorial-nav';
  button.innerHTML = '<span>?</span><b>新手教程</b>';
  button.onclick = () => onboarding.open();
  $('diaryMode').after(button);
  const petButton = document.createElement('button'); petButton.id='petButton'; petButton.type='button'; petButton.className='nav-item'; petButton.dataset.view='pets'; petButton.innerHTML='<span>♟</span><b>桌面宠物</b>'; button.after(petButton);
  const vpnButton = document.createElement('button'); vpnButton.id='vpnButton'; vpnButton.type='button'; vpnButton.className='nav-item'; vpnButton.dataset.view='vpn'; vpnButton.innerHTML='<span>⌁</span><b>学校 VPN</b>'; $('settings').after(vpnButton);
}
document.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-view]');
  const name = target?.dataset.view as PortalViewName | undefined;
  if (name && name in viewTitles) activateView(name);
});

document.body.classList.toggle('dark', localStorage.getItem('diary.dark') === 'true');
installUiTranslations(locale.locale);
translate();
activateView('home');
// Boot: no account yet -> pick a sign-in method; otherwise honour "remember me".
void action(async () => {
  const cfg = await call<Snapshot>({ op: 'config:get' });
  lastSnapshot = cfg;
  if (!cfg.users.length) {
    showLock(true);
  } else if (cfg.remember && cfg.currentUser) {
    // Remembered account: skip the password prompt and go straight in.
    unlocked = true; $('lockScreen').hidden = true;
    await loadConfig(); await refresh();
    startOnboardingAfterEntry(true);
    toast(`欢迎回来，${cfg.currentUser.displayName}`);
    return;
  } else {
    showLock(false);
  }
  await loadConfig();
  await refresh();
})();
