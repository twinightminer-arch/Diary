// SPDX-License-Identifier: AGPL-3.0-only
import { call } from './api.ts';
import type { Entry, EntrySummary, MarkdownDocument } from './api.ts';
import { locale, t } from './copy.ts';
import { decryptContent, isEncrypted } from '../security/encryption.ts';
import { parseMarkdown } from '../storage/markdown.ts';
import { mountPortal, setPortalIdentity, setPortalNavigator, setPortalPlugins } from './portal.ts';
import type { PortalViewName } from './portal.ts';
import { weatherMetrics, weatherToMarkdown } from './weather.ts';
import type { WeatherOk, WeatherReport } from './weather.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const title = $<HTMLInputElement>('title'), editor = $<HTMLTextAreaElement>('editor');
let current: Entry | null = null, password: string | undefined, dirty = false, draft = false, busy = false;
let entries: (EntrySummary & { title: string; snippet: string })[] = [];
let toastTimer: ReturnType<typeof setTimeout>;
let unlocked = true;
let selected = new Set<string>();
type Field = { name: string; label: string; type?: string; options?: [string, string][]; required?: boolean };
function modal(heading: string, message = '', fields: Field[] = []): Promise<Record<string, string> | null> {
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
    // Never swallow a click silently: an in-flight operation used to make every
    // later button appear dead, which is indistinguishable from a crash.
    if (busy) { toast('请稍等，上一个操作还在进行中…'); return; }
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
  renderList(); status();
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

// ---------- Lock screen & accounts (QQ-style) ----------
type AccountSummary = { id: string; username: string; displayName: string; avatar: string | null; googleEmail: string | null; autoLogin: boolean; hasRecovery: boolean };
type BackgroundState = {
  kind: 'image' | 'video' | 'wallpaper' | null;
  media: string | null;
  wallpaper: { path: string; title: string; animated: boolean } | null;
  fit: 'cover' | 'contain' | 'tile' | 'center';
  dim: number; blur: number;
};
type BuiltinPlugin = { id: string; name: string; description: string; version: string; kind: 'builtin'; enabled: boolean };
type PluginList = {
  builtin: BuiltinPlugin[];
  external: { file: string; id: string; label: string; baseUrl: string; model: string; custom: boolean }[];
  errors: { file: string; message: string }[];
  directory: string;
};
type Snapshot = {
  activeProvider: string; providers: { id: string; baseUrl: string; model: string; hasKey: boolean }[];
  profile: { username: string; avatar: string | null; signature: string };
  media: { background: BackgroundState; bgm: string | null };
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
  plugins: { file: string; id: string; label: string; baseUrl: string; model: string; custom: boolean }[];
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

/** Shared success path after Google sign-in or account creation. */
async function afterGoogle(info: { email?: string; name?: string; picture?: string | null }): Promise<void> {
  // The host already stored the Google identity and profile; just re-read state.
  await refreshSnapshot();
  const name = lastSnapshot?.currentUser?.displayName ?? info.name ?? info.email ?? '';
  hideLock(); await loadConfig(); await refresh();
  toast(`已登录：${name}`);
}

// ---- sign in ----
$('authSubmit').onclick = action(async () => {
  const username = ($('authUsername') as HTMLInputElement).value.trim();
  const passcode = ($('authPasscode') as HTMLInputElement).value;
  const remember = ($('authRemember') as HTMLInputElement).checked;
  if (!username) { toast('请输入用户名'); return; }
  if (!passcode) { toast('请输入密码'); return; }
  await call({ op: 'account:signIn', username, passcode, remember });
  await refreshSnapshot();
  hideLock(); await loadConfig(); await refresh();
  toast('登录成功');
});
$('authPasscode').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('authSubmit').click(); } });

// ---- create offline account ----
$('offlineCreate').onclick = action(async () => {
  const r = await modal('创建本地离线账户', '设置一个专属用户名和密码。同一台设备上的每个用户互相独立，资料互不相见。', [
    { name: 'username', label: '用户名（2-20 位中英文/数字/下划线）', type: 'text' },
    { name: 'nickname', label: '昵称（可选）', type: 'text', required: false },
    { name: 'next', label: '密码（至少 6 位）' },
    { name: 'confirmation', label: '确认密码' },
  ]);
  if (!r) return;
  await call({
    op: 'account:create', username: r.username ?? '', displayName: r.nickname || r.username || '',
    passcode: r.next ?? '', confirmation: r.confirmation ?? '', remember: true,
  });
  await refreshSnapshot();
  hideLock(); await loadConfig(); await refresh();
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
    { name: 'next', label: '新密码（至少 6 位）' },
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

// ---------- Settings panel ----------
/** Lists AI plugins discovered on disk, plus where to drop new ones. */
function renderPlugins(cfg: Snapshot): void {
  const host = $('aiPlugins');
  host.hidden = false;
  host.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = cfg.plugins.length ? `已加载 ${cfg.plugins.length} 个 AI 插件` : 'AI 插件';
  host.append(title);
  for (const plugin of cfg.plugins) {
    const row = document.createElement('div');
    row.className = 'ai-plugin-row';
    const name = document.createElement('b'); name.textContent = plugin.label;
    const code = document.createElement('code'); code.textContent = plugin.id;
    const note = document.createElement('small');
    note.textContent = plugin.custom ? '自定义传输' : plugin.baseUrl || '未设置服务地址';
    row.append(name, code, note);
    host.append(row);
  }
  for (const problem of cfg.pluginErrors) {
    const row = document.createElement('div');
    row.className = 'ai-plugin-row bad';
    row.textContent = `插件加载失败：${problem.file} — ${problem.message}`;
    host.append(row);
  }
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = '把 .mjs 插件放进 Diary 数据目录的 plugins 文件夹，重启后即会出现在上方并可被选中。';
  host.append(hint);
}

async function loadConfig() {
  const cfg = await call<Snapshot>({ op: 'config:get' });
  lastSnapshot = cfg;
  const sel = $<HTMLSelectElement>('cfgProvider'); sel.replaceChildren();
  for (const p of cfg.providers) { const opt = document.createElement('option'); opt.value = p.id; opt.textContent = `${p.id} · ${p.model || p.baseUrl}`; sel.append(opt); }
  sel.value = cfg.activeProvider;
  $<HTMLInputElement>('cfgBaseUrl').value = cfg.providers.find(p => p.id === cfg.activeProvider)?.baseUrl ?? '';
  $<HTMLInputElement>('cfgModel').value = cfg.providers.find(p => p.id === cfg.activeProvider)?.model ?? '';
  $<HTMLInputElement>('cfgApiKey').value = '';
  renderPlugins(cfg);
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
  applyBackground(cfg.background);
  applyBgm(cfg.media);
  renderBackgroundPanel(cfg.background);
  renderPermissionState(cfg);
  applyPluginVisibility(cfg);
  await renderGallery();
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
    applyBackground({ kind: null, media: null, wallpaper: null, fit: 'cover', dim: 0, blur: 0 });
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
function schemeUrl(kind: 'media' | 'wallpaper', token: string): string {
  return `diary-wallpaper://${kind}/${token}`;
}

let backgroundRun = 0;
/**
 * Paints the active background. Stills use a <div> so 平铺/居中 are possible;
 * clips use a <video> so a 500 MB wallpaper stays a stream instead of a data URL.
 */
function applyBackground(bg: BackgroundState): void {
  const run = ++backgroundRun;
  const image = $('bgImage'), video = $<HTMLVideoElement>('bgVideo'), dim = $('bgDimLayer');
  video.pause(); video.removeAttribute('src'); video.hidden = true;
  image.hidden = true; image.style.backgroundImage = '';
  dim.hidden = true; dim.style.opacity = '0';
  document.body.classList.remove('has-bg');
  document.documentElement.style.setProperty('--bg-blur', '0px');
  if (!bg.kind) return;

  const source = bg.kind === 'wallpaper' ? (bg.wallpaper?.path ?? '') : (bg.media ?? '');
  if (!source) return;
  const url = bg.kind === 'wallpaper' ? schemeUrl('wallpaper', toToken(source)) : schemeUrl('media', source);
  const isVideo = VIDEO_FILE.test(source);

  document.documentElement.style.setProperty('--bg-blur', `${Math.max(0, bg.blur)}px`);
  dim.hidden = false;
  dim.style.opacity = String(Math.min(1, Math.max(0, bg.dim)));
  document.body.classList.add('has-bg');
  if (run !== backgroundRun) return;

  if (isVideo) {
    video.src = url;
    video.style.objectFit = bg.fit === 'contain' ? 'contain' : 'cover';
    video.hidden = false;
    video.load();
    void video.play().catch(() => undefined);
    return;
  }
  image.style.backgroundImage = `url("${url}")`;
  image.style.backgroundSize = bg.fit === 'contain' ? 'contain' : bg.fit === 'center' || bg.fit === 'tile' ? 'auto' : 'cover';
  image.style.backgroundRepeat = bg.fit === 'tile' ? 'repeat' : 'no-repeat';
  image.style.backgroundPosition = 'center';
  image.hidden = false;
}

/** The background music track lives outside the wallpaper plugin on purpose. */
function applyBgm(media: { bgm: string | null }): void {
  const player = $<HTMLAudioElement>('bgmPlayer');
  if (media.bgm) {
    call<string>({ op: 'media:data', id: media.bgm })
      .then(url => { player.src = url; void player.play().catch(() => undefined); })
      .catch(() => undefined);
  } else { player.pause(); player.removeAttribute('src'); }
}

/** Reflects the saved background in the settings preview card and its controls. */
function renderBackgroundPanel(bg: BackgroundState): void {
  const still = $<HTMLElement>('bgPreviewImage'), clip = $<HTMLVideoElement>('bgPreviewVideo');
  const empty = $('bgPreviewEmpty'), label = $('bgPreviewLabel');
  still.hidden = true; still.style.backgroundImage = '';
  clip.pause(); clip.removeAttribute('src'); clip.hidden = true;
  const source = bg.kind === 'wallpaper' ? (bg.wallpaper?.path ?? '') : (bg.media ?? '');
  label.textContent = bg.kind === 'wallpaper' ? `Wallpaper · ${bg.wallpaper?.title ?? ''}` : bg.kind === 'video' ? '本地视频' : bg.kind === 'image' ? '本地图片／动图' : '';
  empty.hidden = Boolean(bg.kind);
  if (source) {
    const url = bg.kind === 'wallpaper' ? schemeUrl('wallpaper', toToken(source)) : schemeUrl('media', source);
    if (VIDEO_FILE.test(source)) { clip.src = url; clip.hidden = false; void clip.play().catch(() => undefined); }
    else { still.style.backgroundImage = `url("${url}")`; still.hidden = false; }
  }
  ($('bgFit') as HTMLSelectElement).value = bg.fit;
  ($('bgDim') as HTMLInputElement).value = String(Math.round(bg.dim * 100));
  ($('bgBlur') as HTMLInputElement).value = String(Math.round(bg.blur));
  $('bgDimValue').textContent = `${Math.round(bg.dim * 100)}%`;
  $('bgBlurValue').textContent = `${Math.round(bg.blur)}px`;
}
/** Renders the imported-media gallery: click a tile to insert it, × to delete it. */
async function renderGallery() {
  const list = await call<{ id: string; name: string; mime: string; size: number }[]>({ op: 'media:list' });
  const gallery = $('mediaGallery');
  gallery.replaceChildren();
  gallery.hidden = list.length === 0;
  for (const item of list) {
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
  await call({ op: 'config:setProvider', id, baseUrl: $<HTMLInputElement>('cfgBaseUrl').value, model: $<HTMLInputElement>('cfgModel').value, ...(key ? { next: key } : {}) });
  await loadConfig();
  toast(t('done'));
});
// A dead end with no explanation is the worst outcome, so the panel can prove
// the backend really answers instead of leaving the user to guess.
$('cfgTest').onclick = action(async () => {
  const out = $('cfgTestResult');
  out.className = 'ai-status pending';
  out.textContent = '正在测试，请稍候…';
  const result = await call<{ ok: boolean; ms: number; provider: string; model: string; detail: string }>({ op: 'agent:probe' });
  out.className = `ai-status ${result.ok ? 'ok' : 'bad'}`;
  out.textContent = result.ok
    ? `✓ ${result.provider} · ${result.model} · ${result.ms} ms · 回复「${result.detail}」`
    : `✗ ${result.provider} · ${result.model}：${result.detail}`;
});
$('cfgLocale').onchange = () => { locale.setLocale($<HTMLSelectElement>('cfgLocale').value); localStorage.setItem('diary.locale', locale.locale); translate(); };
$('accountChangePwd').onclick = action(async () => {
  const r = await modal('修改密码', '输入原密码后设置新密码。', [
    { name: 'passcode', label: '原密码' },
    { name: 'next', label: '新密码（至少 6 位）' },
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

async function importBackground(kind: 'image' | 'video'): Promise<void> {
  const accept = kind === 'video'
    ? 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov'
    : 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif';
  const file = await pickFile(accept);
  if (!file) return;
  const { data, mime } = await fileToBase64(file);
  const info = await call<{ id: string }>({ op: 'media:import', name: file.name, mime, data });
  await call({ op: 'background:set', kind, id: info.id });
  await loadConfig();
  toast(kind === 'video' ? '视频背景已应用' : '背景已应用');
}
$('bgPickImage').onclick = action(() => importBackground('image'));
$('bgPickGif').onclick = action(() => importBackground('image'));
$('bgPickVideo').onclick = action(() => importBackground('video'));
$('bgClear').onclick = action(async () => {
  await call({ op: 'background:clear' });
  await loadConfig();
  toast('已清除背景');
});
$('bgFit').onchange = action(async () => {
  await call({ op: 'background:set', fit: ($('bgFit') as HTMLSelectElement).value });
  await loadConfig();
});

/** Live preview while dragging; only the release persists. */
function bindBackgroundSlider(id: 'bgDim' | 'bgBlur', labelId: string, unit: string): void {
  const input = $<HTMLInputElement>(id);
  input.oninput = () => {
    const value = Number(input.value);
    $(labelId).textContent = `${value}${unit}`;
    if (id === 'bgDim') $('bgDimLayer').style.opacity = String(value / 100);
    else document.documentElement.style.setProperty('--bg-blur', `${value}px`);
  };
  input.onchange = action(async () => {
    await call(id === 'bgDim'
      ? { op: 'background:set', dim: Number(input.value) / 100 }
      : { op: 'background:set', blur: Number(input.value) });
    await loadConfig();
  });
}
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
$('bgOpenLibrary').onclick = action(async () => {
  $('bgLibrary').hidden = false;
  await loadWallpapers();
});
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

$('bgmImport').onclick = action(async () => {
  const id = await importMediaAs('audio/*,video/*');
  if (!id) return;
  await call({ op: 'media:setBgm', bgm: id });
  await loadConfig();
  toast(t('done'));
});
$('bgmClear').onclick = action(async () => {
  await call({ op: 'media:setBgm', bgm: null });
  $<HTMLAudioElement>('bgmPlayer').pause();
  await loadConfig();
});

// ---------- Permissions & location ----------
function renderPermissionState(cfg: Snapshot): void {
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
    empty.textContent = '还没有外部插件。把 .mjs 文件放进下面的插件目录，重启后它会出现在这里并可在设置 → AI 中选用。';
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
  $('pluginDirHint').textContent = `插件目录：${list.directory}`;
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

// ---------- Unified one-stop navigation ----------
const viewTitles: Record<PortalViewName, string> = { home: '首页', chat: 'AI 问答', 'search-view': 'AI 搜索', competition: '竞赛中心', guide: '办事指南', diary: '日记' };
let activeView: PortalViewName | null = null;
function activateView(viewName: PortalViewName) {
  if (activeView === viewName) return;
  activeView = viewName;
  const ids: Record<PortalViewName, string> = { home: 'homeView', chat: 'chatView', 'search-view': 'searchView', competition: 'competitionView', guide: 'guideView', diary: 'diaryView' };
  for (const [name, id] of Object.entries(ids) as [PortalViewName, string][]) {
    const panel = $(id); panel.hidden = name !== viewName; panel.classList.toggle('active-view', name === viewName);
  }
  document.querySelectorAll<HTMLButtonElement>('#primaryNav [data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === viewName));
  $('diarySidebar').hidden = viewName !== 'diary';
  $('breadcrumbDate').textContent = viewTitles[viewName];
  document.body.classList.remove('sidebar-open');
  // Every portal screen renders itself from in-memory data, so opening a view
  // never waits on a probe or a network round-trip.
  mountPortal(viewName);
}
// Portal screens move the router through this hook (prompt chips -> chat).
setPortalNavigator(activateView);
document.addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-view]');
  const name = target?.dataset.view as PortalViewName | undefined;
  if (name && name in viewTitles) activateView(name);
});

document.body.classList.toggle('dark', localStorage.getItem('diary.dark') === 'true');
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
    toast(`欢迎回来，${cfg.currentUser.displayName}`);
    return;
  } else {
    showLock(false);
  }
  await loadConfig();
  await refresh();
})();
