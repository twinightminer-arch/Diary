// SPDX-License-Identifier: AGPL-3.0-only
import { changePasscode, decryptBatch, decryptContent, encryptBatch, encryptContent, changeBatchPasscode, isEncrypted } from '../security/encryption.ts';
import { parseMarkdown, serializeMarkdown } from '../storage/markdown.ts';
import type { MarkdownDocument } from '../storage/markdown.ts';
import type { Entry, EntrySummary } from '../storage/markdown-engine.ts';
import type { SchoolRecord } from './schools.ts';
import { BUILTIN_SCHOOLS, dedupeSchools, normaliseImportedSchool, searchSchools } from './schools.ts';

export type Request = {
  op: string; id?: string; document?: MarkdownDocument; passcode?: string; next?: string; confirmation?: string; content?: string;
  baseUrl?: string; model?: string;
  ids?: string[]; lat?: number; lon?: number; locale?: string; query?: string; prompt?: string;
  messages?: { role: 'system' | 'user' | 'assistant'; content: string }[];
  task?: string; system?: string; template?: string; markdown?: string;
  name?: string; mime?: string; data?: string; background?: string | null; bgm?: string | null;
  avatar?: string | null; username?: string; signature?: string;
  provider?: string; clientId?: string; redirectUri?: string; state?: string; codeChallenge?: string; code?: string; codeVerifier?: string; url?: string;
  displayName?: string; question?: string; answer?: string; question2?: string; answer2?: string; remember?: boolean;
  apiKey?: string;
  /** Background / wallpaper plugin. */
  kind?: string; folder?: string; fit?: string; dim?: number; blur?: number;
  /** Wallpaper transparency (0 = original quality) and brightness in percent. */
  opacity?: number; brightness?: number;
  path?: string; title?: string; animated?: boolean; file?: string;
  /** 字体与顶栏配色（照搬 DSH 壁纸插件的那套可读性设置）。 */
  fontCustom?: boolean; fontColor?: string; fontSize?: number; topbarColor?: string;
  /** Plugin manager + permission switches. */
  pluginId?: string; enabled?: boolean; network?: boolean; location?: boolean;
  mode?: string; label?: string;
  school?: Partial<SchoolRecord> & { url?: string }; schools?: unknown[]; source?: unknown;
};
declare global {
  interface Window {
    diary?: { call: (request: Request) => Promise<unknown>; platform: string };
    NativeDiary?: { request: (id: number, json: string) => void };
    __diaryReply?: (id: number, reply: { ok: boolean; value?: unknown; error?: string }) => void;
  }
}
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
window.__diaryReply = (id, reply) => {
  const task = pending.get(id); pending.delete(id);
  if (!task) return;
  if (reply.ok) task.resolve(reply.value); else task.reject(new Error(reply.error ?? 'Operation failed'));
};
function native(request: Request): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    try {
      if (!window.NativeDiary) throw new Error('Native storage unavailable');
      window.NativeDiary.request(id, JSON.stringify(request));
    } catch (error) { pending.delete(id); reject(error); }
  });
}
// ---- Android-only host fallbacks -------------------------------------------
// The APK has no Node host, so settings that need no file system live in
// localStorage, while batch encryption reuses the shared WebCrypto module so
// ciphertext stays byte-compatible with the desktop build.
const PBKDF2_ITERATIONS = 310_000;
const DEFAULT_PROVIDERS: Record<string, { baseUrl: string; model: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
};
type AiSettings = { activeProvider: string; providers: Record<string, { baseUrl: string; model: string }>; keys: Record<string, string> };
const defaultAi = (): AiSettings => ({ activeProvider: 'openai', providers: structuredClone(DEFAULT_PROVIDERS), keys: {} });

// ---- Android local account model (mirrors the desktop HostConfig) ----------
interface MobileUser {
  id: string; username: string; displayName: string; avatar: string | null;
  salt: string; hash: string; googleId: string | null; googleEmail: string | null;
  recoveryQuestion: string | null; recoverySalt: string | null; recoveryHash: string | null;
  createdAt: number; lastLoginAt: number | null; autoLogin: boolean;
}
interface MobileAccount {
  users: MobileUser[];
  session: { userId: string | null; remember: boolean };
  google: { googleId: string; email: string; name: string; picture: string | null } | null;
}
const emptyMobileAccount = (): MobileAccount => ({ users: [], session: { userId: null, remember: false }, google: null });
const USERNAME_PATTERN = /^[A-Za-z0-9_一-龥]{2,20}$/;
function loadAccount(): MobileAccount { return load<MobileAccount>('account', emptyMobileAccount()); }
function saveAccount(account: MobileAccount): void { store('account', account); }
function newSalt(): Uint8Array { return crypto.getRandomValues(new Uint8Array(16)); }
async function hashPassword(passcode: string, salt: Uint8Array): Promise<string> {
  const key = await derivePasscode(passcode, salt);
  return toBase64(Uint8Array.from(key.match(/../g)!.map(byte => parseInt(byte, 16))));
}
async function verifyPassword(passcode: string, user: MobileUser): Promise<boolean> {
  return safeEqual(await hashPassword(passcode, fromBase64(user.salt)), user.hash);
}
function checkUsername(account: MobileAccount, username: string, exceptId?: string): string {
  const name = (username ?? '').trim();
  if (!USERNAME_PATTERN.test(name)) throw new Error('用户名需为 2-20 位中英文、数字或下划线');
  if (account.users.some(u => u.id !== exceptId && u.username.toLowerCase() === name.toLowerCase())) throw new Error('该用户名已被占用');
  return name;
}
function checkPassword(passcode: string, confirmation?: string): string {
  if (typeof passcode !== 'string' || passcode.length < 6) throw new Error('密码至少 6 位');
  if (confirmation !== undefined && passcode !== confirmation) throw new Error('两次输入的密码不一致');
  return passcode;
}
function load<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(`diary.${key}`); return raw === null ? fallback : JSON.parse(raw) as T; } catch { return fallback; }
}
function store(key: string, value: unknown): void { localStorage.setItem(`diary.${key}`, JSON.stringify(value)); }
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array {
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
async function derivePasscode(passcode: string, salt: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(bits)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
function mobileConfig() {
  const settings = load<AiSettings>('ai', defaultAi());
  const providers = { ...DEFAULT_PROVIDERS, ...settings.providers };
  const account = load<MobileAccount>('account', emptyMobileAccount());
  const current = account.session.userId ? account.users.find(u => u.id === account.session.userId) ?? null : null;
  return {
    activeProvider: settings.activeProvider,
    providers: Object.entries(providers).map(([id, entry]) => ({ id, baseUrl: entry.baseUrl, model: entry.model, hasKey: Boolean(settings.keys[id]), needsKey: true })),
    profile: load<{ username: string; avatar: string | null; signature: string }>('profile', { username: '', avatar: null, signature: '' }),
    media: load<{ background: string | null; bgm: string | null }>('media', { background: null, bgm: null }),
    users: account.users.map(u => ({
      id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar,
      googleEmail: u.googleEmail, autoLogin: u.autoLogin, hasRecovery: Boolean(u.recoveryQuestion),
    })),
    currentUser: current ? { id: current.id, username: current.username, displayName: current.displayName, avatar: current.avatar, googleEmail: current.googleEmail } : null,
    remember: account.session.remember,
    google: account.google,
    oauthClients: load<Record<string, string>>('oauthClients', {}),
  };
}
// Android uses the same TypeScript crypto and Markdown format over private native files.
async function mobile(request: Request): Promise<unknown> {
  const { op, id, passcode } = request;
  if (op.startsWith('schools:')) {
    const custom = load<SchoolRecord[]>('school-directory', []).map(row => normaliseImportedSchool(row, row.updatedAt)).filter((row): row is SchoolRecord => !!row);
    const all = () => [...BUILTIN_SCHOOLS, ...custom];
    if (op === 'schools:list') return searchSchools(all(), request.query ?? '');
    if (op === 'schools:migrate') {
      const incoming = (request.schools ?? []).map(row => normaliseImportedSchool((row ?? {}) as Partial<SchoolRecord> & {url?:string})).filter((row): row is SchoolRecord => !!row);
      const merged = dedupeSchools(all(), incoming); if (merged.added.length) store('school-directory', [...custom, ...merged.added]);
      return { added: merged.added.length, duplicates: merged.duplicates, schools: [...all(), ...merged.added] };
    }
    if (op === 'schools:upsert') {
      const school = normaliseImportedSchool(request.school ?? {}); if (!school) throw new Error('学校名称或 VPN 地址无效');
      const index=custom.findIndex(item=>item.id===school.id); if(index>=0)custom[index]=school; else {if(!dedupeSchools(all(),[school]).added.length)throw new Error('该学校和 VPN 地址已经存在');custom.push(school);} store('school-directory',custom);return school;
    }
    if (op === 'schools:delete') { if(!id?.startsWith('custom-'))throw new Error('内置学校不能删除');store('school-directory',custom.filter(item=>item.id!==id));return {ok:true}; }
  }
  if (op === 'campus:competitions') {
    const custom=load<SchoolRecord[]>('school-directory',[]);const school=[...BUILTIN_SCHOOLS,...custom].find(item=>item.id===id);if(!school)throw new Error('没有找到该学校');
    throw new Error('Android WebView 无法直接读取多数学校官网（跨域或 VPN 权限限制），请使用系统浏览器访问学校官网');
  }
  const file = async () => String(await native({ op: 'read', id: id! }));
  const write = (content: string, create = false) => native({ op: create ? 'create' : 'write', id: id!, content });
  if (op === 'list') {
    const ids = await native({ op: 'list' }) as string[];
    return Promise.all(ids.map(async id => ({ id, encrypted: isEncrypted(String(await native({ op: 'read', id }))) })));
  }
  if (op === 'create') {
    const source = serializeMarkdown(request.document!);
    await write(passcode === undefined ? source : await encryptContent(source, passcode), true);
    return { id, encrypted: passcode !== undefined, ...parseMarkdown(source) };
  }
  if (op === 'read' || op === 'update' || op === 'delete') {
    const raw = await file(), encrypted = isEncrypted(raw);
    if (encrypted && passcode === undefined) throw new Error('Passcode required');
    const source = encrypted ? await decryptContent(raw, passcode!) : raw;
    if (op === 'delete') return native({ op, id: id! });
    if (op === 'read') return { id, encrypted, ...parseMarkdown(source) };
    const updated = serializeMarkdown(request.document!);
    await write(encrypted ? await encryptContent(updated, passcode!) : updated);
    return { id, encrypted, ...parseMarkdown(updated) };
  }
  if (op === 'encrypt') {
    if (passcode !== request.confirmation) throw new Error('Passcode confirmation mismatch');
    const source = await file();
    if (isEncrypted(source)) throw new Error('Already encrypted');
    return write(await encryptContent(source, passcode!));
  }
  if (op === 'decrypt') return write(await decryptContent(await file(), passcode!));
  if (op === 'changePasscode') return write(await changePasscode(await file(), passcode!, request.next!, request.confirmation!));
  // Settings that touch no file stay in localStorage.
  if (op === 'config:get') return mobileConfig();
  if (op === 'config:setProvider') {
    if (!id) throw new Error('Provider id required');
    const settings = load<AiSettings>('ai', defaultAi());
    const entry = { ...(DEFAULT_PROVIDERS[id] ?? { baseUrl: '', model: '' }), ...(settings.providers[id] ?? {}) };
    if (typeof request.baseUrl === 'string') entry.baseUrl = request.baseUrl;
    if (typeof request.model === 'string') entry.model = request.model;
    settings.providers[id] = entry;
    if (typeof request.next === 'string' && request.next) settings.keys[id] = request.next;
    settings.activeProvider = id; store('ai', settings);
    return mobileConfig();
  }
  if (op === 'profile:get') return load('profile', { username: '', avatar: null, signature: '' });
  if (op === 'profile:set') {
    const profile = load<{ username: string; avatar: string | null; signature: string }>('profile', { username: '', avatar: null, signature: '' });
    if (typeof request.username === 'string') profile.username = request.username;
    if (typeof request.signature === 'string') profile.signature = request.signature;
    if (typeof request.avatar === 'string' || request.avatar === null) profile.avatar = request.avatar;
    store('profile', profile); return profile;
  }
  if (op === 'account:list') return mobileConfig();
  if (op === 'account:create') {
    const account = loadAccount();
    const username = checkUsername(account, String(request.username ?? ''));
    const chosen = checkPassword(String(request.passcode ?? ''), typeof request.confirmation === 'string' ? request.confirmation : undefined);
    const salt = newSalt();
    const user: MobileUser = {
      id: crypto.randomUUID(), username, displayName: (request.displayName ?? username).trim() || username, avatar: null,
      salt: toBase64(salt), hash: await hashPassword(chosen, salt),
      googleId: null, googleEmail: null, recoveryQuestion: null, recoverySalt: null, recoveryHash: null,
      createdAt: Date.now(), lastLoginAt: Date.now(), autoLogin: Boolean(request.remember),
    };
    account.users.push(user);
    account.session = { userId: user.id, remember: Boolean(request.remember) };
    saveAccount(account);
    store('profile', { ...load('profile', { username: '', avatar: null, signature: '' }), username: user.displayName, avatar: user.avatar });
    return mobileConfig();
  }
  if (op === 'account:signIn') {
    const account = loadAccount();
    const user = account.users.find(u => u.username.toLowerCase() === String(request.username ?? '').trim().toLowerCase());
    if (!user) throw new Error('用户不存在');
    if (!(await verifyPassword(String(request.passcode ?? ''), user))) throw new Error('密码错误');
    user.lastLoginAt = Date.now();
    if (request.remember) user.autoLogin = true;
    account.session = { userId: user.id, remember: Boolean(request.remember) };
    saveAccount(account);
    store('profile', { ...load('profile', { username: '', avatar: null, signature: '' }), username: user.displayName, avatar: user.avatar });
    return mobileConfig();
  }
  if (op === 'account:signOut') { const account = loadAccount(); account.session = { userId: null, remember: false }; saveAccount(account); return mobileConfig(); }
  if (op === 'account:renameDisplay') {
    const account = loadAccount();
    const user = account.users.find(u => u.id === String(request.id ?? ''));
    if (!user) throw new Error('Unknown user');
    const displayName = String(request.displayName ?? '').trim();
    if (displayName) user.displayName = displayName;
    saveAccount(account); return mobileConfig();
  }
  if (op === 'account:changePassword') {
    const account = loadAccount();
    const user = account.users.find(u => u.id === account.session.userId);
    if (!user) throw new Error('Not signed in');
    if (!(await verifyPassword(String(request.passcode ?? ''), user))) throw new Error('原密码错误');
    const next = checkPassword(String(request.next ?? ''), typeof request.confirmation === 'string' ? request.confirmation : undefined);
    const salt = newSalt(); user.salt = toBase64(salt); user.hash = await hashPassword(next, salt);
    saveAccount(account); return { ok: true };
  }
  if (op === 'account:setRecovery') {
    const account = loadAccount();
    const user = account.users.find(u => u.id === account.session.userId);
    if (!user) throw new Error('Not signed in');
    const question = String(request.question ?? '').trim(); const answer = String(request.answer ?? '').trim();
    if (question.length < 4) throw new Error('密保问题至少 4 个字');
    if (answer.length < 2) throw new Error('密保答案至少 2 个字');
    const salt = newSalt();
    user.recoveryQuestion = question; user.recoverySalt = toBase64(salt);
    user.recoveryHash = await hashPassword(answer.toLowerCase(), salt);
    saveAccount(account); return mobileConfig();
  }
  if (op === 'account:recover') {
    const account = loadAccount();
    const user = account.users.find(u => u.id === String(request.id ?? ''));
    if (!user || !user.recoveryHash) throw new Error('该账户未设置密保问题');
    if (!safeEqual(await hashPassword(String(request.answer ?? '').trim().toLowerCase(), fromBase64(user.recoverySalt!)), user.recoveryHash)) throw new Error('密保答案不正确');
    const next = checkPassword(String(request.next ?? ''), typeof request.confirmation === 'string' ? request.confirmation : undefined);
    const salt = newSalt(); user.salt = toBase64(salt); user.hash = await hashPassword(next, salt);
    saveAccount(account); return { ok: true };
  }
  if (op === 'media:setBackground' || op === 'media:setBgm') {
    const media = load<{ background: string | null; bgm: string | null }>('media', { background: null, bgm: null });
    if (op === 'media:setBackground') media.background = request.background ?? null;
    else media.bgm = request.bgm ?? null;
    store('media', media); return media;
  }
  // Batch encryption reuses the shared module, so files stay portable to desktop.
  if (op === 'batch:encrypt' || op === 'batch:decrypt' || op === 'batch:changePasscode') {
    const ids = request.ids ?? [];
    const files = await Promise.all(ids.map(async entryId => ({ name: `${entryId}.md`, content: String(await native({ op: 'read', id: entryId })) })));
    const results = op === 'batch:encrypt' ? await encryptBatch(files, String(passcode))
      : op === 'batch:decrypt' ? await decryptBatch(files, String(passcode))
      : await changeBatchPasscode(files, String(passcode), String(request.next), String(request.confirmation));
    let written = 0;
    for (const result of results) {
      if (!result.ok) continue;
      await native({ op: 'write', id: result.name.replace(/\.md$/i, ''), content: result.content }); written++;
    }
    return { total: results.length, written, failed: results.flatMap(result => result.ok ? [] : [{ name: result.name, error: result.error.message }]) };
  }
  // OAuth: remember the client id here, since the Android host has no config file.
  if (op === 'account:oauthBegin') {
    if (typeof request.provider === 'string' && typeof request.clientId === 'string') {
      const clients = load<Record<string, string>>('oauthClients', {});
      clients[request.provider] = request.clientId; store('oauthClients', clients);
    }
    return native(request);
  }
  if (op === 'account:oauthFinish') {
    const clients = load<Record<string, string>>('oauthClients', {});
    const clientId = typeof request.provider === 'string' ? clients[request.provider] : undefined;
    const result = await native({ ...request, ...(clientId ? { clientId } : {}) }) as { ok?: boolean; email?: string; name?: string; picture?: string };
    if (result?.ok && result.email) {
      // One Google account <-> one local account; import name + avatar on first link.
      const account = loadAccount();
      const googleId = result.email;
      let user = account.users.find(u => u.googleId === googleId) ?? null;
      const picture = result.picture || null;
      if (!user) {
        const base = (result.name || googleId.split('@')[0] || 'user').replace(/[^A-Za-z0-9_一-龥]/g, '').slice(0, 20) || 'user';
        let username = base.length >= 2 ? base : base + '用户'.slice(0, 2 - base.length);
        while (account.users.some(u => u.username.toLowerCase() === username.toLowerCase())) username = `${username}${Math.floor(Math.random() * 90 + 10)}`.slice(0, 20);
        const salt = newSalt();
        const passcode = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        user = {
          id: crypto.randomUUID(), username, displayName: result.name || username, avatar: picture,
          salt: toBase64(salt), hash: await hashPassword(passcode, salt),
          googleId, googleEmail: googleId, recoveryQuestion: null, recoverySalt: null, recoveryHash: null,
          createdAt: Date.now(), lastLoginAt: Date.now(), autoLogin: true,
        };
        account.users.push(user);
      } else {
        user.avatar = user.avatar ?? picture;
        user.displayName = user.displayName || result.name || user.username;
        user.lastLoginAt = Date.now();
      }
      account.google = { googleId, email: googleId, name: result.name || user.displayName, picture };
      account.session = { userId: user.id, remember: true };
      saveAccount(account);
      store('profile', { ...load('profile', { username: '', avatar: null, signature: '' }), username: user.displayName, avatar: user.avatar });
      return { ok: true, email: googleId, name: user.displayName, picture: user.avatar, userId: user.id };
    }
    return result;
  }
  // Network calls are host-only; carry the saved provider settings down with them.
  if (op === 'agent:compose' || op === 'agent:illustrate') {
    const settings = load<AiSettings>('ai', defaultAi());
    const active = settings.activeProvider, entry = settings.providers[active] ?? DEFAULT_PROVIDERS[active], key = settings.keys[active];
    return native({ ...request, provider: active, ...(entry ? { baseUrl: entry.baseUrl, model: entry.model } : {}), ...(key ? { apiKey: key } : {}) });
  }
  return native(request);
}
let queue: Promise<unknown> = Promise.resolve();
export function call<T = unknown>(request: Request): Promise<T> {
  const task = queue.then(() => window.diary ? window.diary.call(request) : mobile(request));
  queue = task.catch(() => undefined);
  return task as Promise<T>;
}
export type { Entry, EntrySummary, MarkdownDocument };
