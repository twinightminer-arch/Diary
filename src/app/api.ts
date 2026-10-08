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
// 31 万次迭代是桌面端的取值：桌面 CPU 上约 0.3s，但手机 WebView（尤其鸿蒙
// 4.2 自带的旧 WebView）要把这段 PBKDF2 跑成几秒级，表现为「离线登录转圈很久
// 甚至像登录不进去」。移动端单独降到 12 万次 —— 对本地离线口令仍是足够硬的
// 慢哈希，而登录耗时回到几百毫秒。
const PBKDF2_ITERATIONS = 120_000;
// 老账户的哈希是用旧迭代数算出来的：迭代数是哈希输入的一部分，改常量会让存量
// 账户全部登不上。所以按账户记录各自的迭代数，登录后静默升级到新值。
const LEGACY_PBKDF2_ITERATIONS = 310_000;
const DEFAULT_PROVIDERS: Record<string, { baseUrl: string; model: string; label?: string; custom?: boolean }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
};
type AiSettings = { activeProvider: string; providers: Record<string, { baseUrl: string; model: string; label?: string; custom?: boolean }>; keys: Record<string, string> };
const defaultAi = (): AiSettings => ({ activeProvider: 'openai', providers: structuredClone(DEFAULT_PROVIDERS), keys: {} });
/** Android ships no external plugin folder; the manager toggles these instead. */
const MOBILE_PLUGINS = [
  { id: 'wallpaper', name: '壁纸与背景', description: '图片与背景设置。', version: '1.0.0' },
  { id: 'weather', name: '实时天气', description: '首页天气信息。', version: '1.0.0' },
  { id: 'ai-agent', name: 'AI 助手', description: 'AI 问答、搜索与写作。', version: '1.0.0' },
  { id: 'campus', name: '办事指南', description: '校园办事清单与进度。', version: '1.0.0' },
  { id: 'competition', name: '竞赛中心', description: '竞赛目录与日历。', version: '1.0.0' },
] as const;

// ---- Android local account model (mirrors the desktop HostConfig) ----------
interface MobileUser {
  id: string; username: string; displayName: string; avatar: string | null;
  salt: string; hash: string; googleId: string | null; googleEmail: string | null;
  recoveryQuestion: string | null; recoverySalt: string | null; recoveryHash: string | null;
  createdAt: number; lastLoginAt: number | null; autoLogin: boolean;
  /** PBKDF2 迭代数。缺省的老账户按 LEGACY_PBKDF2_ITERATIONS 处理。 */
  iter?: number;
  /** 密保答案哈希用的迭代数，缺省同上。 */
  recoveryIter?: number;
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
async function hashPassword(passcode: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const key = await derivePasscode(passcode, salt, iterations);
  return toBase64(Uint8Array.from(key.match(/../g)!.map(byte => parseInt(byte, 16))));
}
function iterationsFor(user: MobileUser): number { return user.iter ?? LEGACY_PBKDF2_ITERATIONS; }
async function verifyPassword(passcode: string, user: MobileUser): Promise<boolean> {
  const salt = fromBase64(user.salt);
  return safeEqual(await hashPassword(passcode, salt, iterationsFor(user)), user.hash);
}
/** 老账户登录成功后把哈希重算成当前迭代数，下一次登录就不再走旧的那次慢哈希。 */
async function upgradePasswordHash(passcode: string, user: MobileUser, account: MobileAccount): Promise<void> {
  if (iterationsFor(user) === PBKDF2_ITERATIONS) return;
  const salt = newSalt();
  user.salt = toBase64(salt);
  user.hash = await hashPassword(passcode, salt);
  user.iter = PBKDF2_ITERATIONS;
  saveAccount(account);
  // 密保答案的明文只有用户自己知道，登录时拿不到，所以 recoveryHash 不在这里
  // 迁移：它继续按 recoveryIter 验证，用户下次重设密保时自然切到新迭代数。
}
function checkUsername(account: MobileAccount, username: string, exceptId?: string): string {
  const name = (username ?? '').trim();
  if (!USERNAME_PATTERN.test(name)) throw new Error('用户名需为 2-20 位中英文、数字或下划线');
  if (account.users.some(u => u.id !== exceptId && u.username.toLowerCase() === name.toLowerCase())) throw new Error('该用户名已被占用');
  return name;
}
function checkPassword(passcode: string, confirmation?: string): string {
  // 8 位，和界面上所有提示文案保持一致（曾经校验 6 位而文案写 8 位）。
  if (typeof passcode !== 'string' || passcode.length < 8) throw new Error('密码至少 8 位');
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
async function derivePasscode(passcode: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<string> {
  // 某些定制 WebView 上 crypto.subtle 是缺的；缺了就明确报错，不要让登录界面
  // 一直转圈，用户看不出到底是密码错还是环境不支持。
  if (!globalThis.crypto?.subtle) throw new Error('当前环境不支持 WebCrypto，无法校验密码');
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' }, key, 256);
    return Array.from(new Uint8Array(bits)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    throw new Error(error instanceof Error && error.message.includes('WebCrypto') ? error.message : `密码校验失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
// The Android host keeps no config file, so the network/location switches and
// the saved coordinates live in localStorage and travel back via config:get.
const defaultPermissions = (): { network: boolean; location: boolean } => ({ network: true, location: false });
const defaultLocation = (): { mode: 'auto' | 'manual'; lat: number | null; lon: number | null; label: string } => ({ mode: 'manual', lat: null, lon: null, label: '' });
/** Host weather only returns a Chinese summary; pick the matching glyph. */
function weatherGlyph(description: string): string {
  if (description.includes('雷')) return '⛈';
  if (description.includes('雪')) return '❄';
  if (description.includes('雨')) return '🌧';
  if (description.includes('雾')) return '🌫';
  if (description.includes('阴')) return '☁';
  if (description.includes('多云')) return '⛅';
  if (description.includes('晴')) return '☀';
  return '🌤';
}
function mobileConfig() {
  const settings = load<AiSettings>('ai', defaultAi());
  const providers = { ...DEFAULT_PROVIDERS, ...settings.providers };
  const account = load<MobileAccount>('account', emptyMobileAccount());
  const current = account.session.userId ? account.users.find(u => u.id === account.session.userId) ?? null : null;
  return {
    activeProvider: settings.activeProvider,
    providers: Object.entries(providers).map(([id, entry]) => ({ id, label: entry.label ?? id, baseUrl: entry.baseUrl, model: entry.model, models: [], custom: Boolean(entry.custom), hasKey: Boolean(settings.keys[id]), needsKey: true })),
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
    permissions: load('permissions', defaultPermissions()),
    location: load('location', defaultLocation()),
    builtinPlugins: MOBILE_PLUGINS.map(plugin => ({ ...plugin, kind: 'builtin', enabled: load<Record<string, boolean>>('plugins', {})[plugin.id] !== false })),
    plugins: [], pluginErrors: [], pluginDirectory: '',
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
  // Android scans no wallpaper folder and owns no music library, so the
  // settings screen gets empty listings rather than a failed native call.
  if (op === 'background:list' || op === 'music:list') return [];
  if (op === 'plugin:list') return { builtin: mobileConfig().builtinPlugins, external: [], errors: [], directory: '' };
  if (op === 'plugin:toggle') {
    if (!MOBILE_PLUGINS.some(plugin => plugin.id === request.pluginId)) throw new Error('安卓端不支持该外部插件');
    const plugins = load<Record<string, boolean>>('plugins', {});
    plugins[request.pluginId!] = request.enabled !== false;
    store('plugins', plugins);
    return mobileConfig();
  }
  if (op === 'provider:create') {
    const wanted = id?.trim() ?? '';
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(wanted)) throw new Error('名称只能用字母、数字、点、下划线和连字符（最多 40 个字符）');
    const settings = load<AiSettings>('ai', defaultAi());
    if (wanted in DEFAULT_PROVIDERS || wanted in settings.providers) throw new Error('这个模型名称已被占用');
    settings.providers[wanted] = { baseUrl: request.baseUrl?.trim() ?? '', model: request.model?.trim() ?? '', label: request.label?.trim() || wanted, custom: true };
    if (request.next) settings.keys[wanted] = request.next;
    settings.activeProvider = wanted;
    store('ai', settings);
    return mobileConfig();
  }
  if (op === 'provider:delete') {
    const settings = load<AiSettings>('ai', defaultAi());
    if (!id || !settings.providers[id]?.custom) throw new Error('找不到可删除的自定义模型');
    delete settings.providers[id];
    delete settings.keys[id];
    if (settings.activeProvider === id) settings.activeProvider = 'openai';
    store('ai', settings);
    return mobileConfig();
  }
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
      salt: toBase64(salt), hash: await hashPassword(chosen, salt), iter: PBKDF2_ITERATIONS,
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
    const passcode = String(request.passcode ?? '');
    if (!(await verifyPassword(passcode, user))) throw new Error('密码错误');
    user.lastLoginAt = Date.now();
    if (request.remember) user.autoLogin = true;
    account.session = { userId: user.id, remember: Boolean(request.remember) };
    saveAccount(account);
    // 存量账户第一次登录仍要走一次旧的 31 万次迭代，登录成功后立刻按新迭代数
    // 重算，之后每次登录都是几百毫秒。
    await upgradePasswordHash(passcode, user, account);
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
    const salt = newSalt(); user.salt = toBase64(salt); user.hash = await hashPassword(next, salt); user.iter = PBKDF2_ITERATIONS;
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
    user.recoveryIter = PBKDF2_ITERATIONS;
    saveAccount(account); return mobileConfig();
  }
  if (op === 'account:recover') {
    const account = loadAccount();
    const user = account.users.find(u => u.id === String(request.id ?? ''));
    if (!user || !user.recoveryHash) throw new Error('该账户未设置密保问题');
    // 密保哈希按它自己当时记录的迭代数校验，老账户不会因为这次改动而答不对。
    if (!safeEqual(await hashPassword(String(request.answer ?? '').trim().toLowerCase(), fromBase64(user.recoverySalt!), user.recoveryIter ?? LEGACY_PBKDF2_ITERATIONS), user.recoveryHash)) throw new Error('密保答案不正确');
    const next = checkPassword(String(request.next ?? ''), typeof request.confirmation === 'string' ? request.confirmation : undefined);
    const salt = newSalt(); user.salt = toBase64(salt); user.hash = await hashPassword(next, salt); user.iter = PBKDF2_ITERATIONS;
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
          salt: toBase64(salt), hash: await hashPassword(passcode, salt), iter: PBKDF2_ITERATIONS,
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
  // Permission switches and the saved coordinates: the settings screen reads
  // both back through config:get, and the weather panel depends on them.
  if (op === 'permission:set') {
    const permissions = load('permissions', defaultPermissions());
    if (typeof request.network === 'boolean') permissions.network = request.network;
    if (typeof request.location === 'boolean') permissions.location = request.location;
    store('permissions', permissions);
    return mobileConfig();
  }
  if (op === 'location:set') {
    const location = load('location', defaultLocation());
    if (request.mode === 'auto') location.mode = 'auto';
    else if (request.mode === 'manual') location.mode = 'manual';
    if (typeof request.lat === 'number' && Number.isFinite(request.lat)) location.lat = request.lat;
    if (typeof request.lon === 'number' && Number.isFinite(request.lon)) location.lon = request.lon;
    if (typeof request.label === 'string') location.label = request.label;
    store('location', location);
    return mobileConfig();
  }
  // Home-panel weather. The host only exposes a raw Open-Meteo reading, so it
  // is shaped into the same report the desktop builds; fields the host cannot
  // supply stay null and the card prints them as a dash.
  if (op === 'weather:now') {
    const permissions = load('permissions', defaultPermissions());
    const location = load('location', defaultLocation());
    if (!permissions.network)
      return { ok: false, reason: 'offline', message: '联网已关闭。打开「设置 → 联网与定位」的联网开关即可显示实时天气。' };
    if (typeof location.lat !== 'number' || typeof location.lon !== 'number')
      return { ok: false, reason: 'noposition', message: '还没有位置。打开「设置 → 联网与定位」填写经纬度后即可显示天气。' };
    try {
      const raw = await native({ op: 'web:weather', lat: location.lat, lon: location.lon }) as { tempC: number; humidity: number | null; description: string };
      let place = location.label.trim();
      if (!place) {
        const geo = await native({ op: 'web:geocode', lat: location.lat, lon: location.lon }).catch(() => null) as { city?: string; country?: string } | null;
        place = [geo?.city, geo?.country].filter(Boolean).join(' · ');
      }
      const description = String(raw?.description ?? '');
      const now = new Date();
      const hour = now.getHours();
      return {
        ok: true, lat: location.lat, lon: location.lon, place,
        weather: {
          tempC: Number(raw?.tempC) || 0, apparentC: null, code: 0, description, icon: weatherGlyph(description),
          humidity: typeof raw?.humidity === 'number' ? raw.humidity : null,
          windKmh: null, windDir: null, windDirText: '', windScale: '', gustKmh: null,
          pressure: null, precipitation: null, cloudCover: null, uvIndex: null, visibilityKm: null,
          isDay: hour >= 6 && hour < 18, observedAt: now.toISOString(),
        },
        air: null, fetchedAt: now.toISOString(),
      };
    } catch (error) {
      return { ok: false, reason: 'error', message: error instanceof Error ? error.message : String(error) };
    }
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
