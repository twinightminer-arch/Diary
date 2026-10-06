// SPDX-License-Identifier: AGPL-3.0-only
import { changePasscode, decryptBatch, decryptContent, encryptBatch, encryptContent, changeBatchPasscode, isEncrypted } from '../security/encryption.ts';
import { parseMarkdown, serializeMarkdown } from '../storage/markdown.ts';
import type { MarkdownDocument } from '../storage/markdown.ts';
import type { Entry, EntrySummary } from '../storage/markdown-engine.ts';

export type Request = {
  op: string; id?: string; document?: MarkdownDocument; passcode?: string; next?: string; confirmation?: string; content?: string;
  baseUrl?: string; model?: string;
  ids?: string[]; lat?: number; lon?: number; locale?: string; query?: string; prompt?: string;
  messages?: { role: 'system' | 'user' | 'assistant'; content: string }[];
  task?: string; system?: string; template?: string; markdown?: string;
  name?: string; mime?: string; data?: string; background?: string | null; bgm?: string | null;
  avatar?: string | null; username?: string; signature?: string;
  provider?: string; clientId?: string; redirectUri?: string; state?: string; codeChallenge?: string; code?: string; codeVerifier?: string; url?: string;
  apiKey?: string;
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
  return {
    activeProvider: settings.activeProvider,
    providers: Object.entries(providers).map(([id, entry]) => ({ id, baseUrl: entry.baseUrl, model: entry.model, hasKey: Boolean(settings.keys[id]) })),
    profile: load<{ username: string; avatar: string | null; signature: string }>('profile', { username: '', avatar: null, signature: '' }),
    media: load<{ background: string | null; bgm: string | null }>('media', { background: null, bgm: null }),
    hasLocalAccount: load<{ salt: string; hash: string } | null>('account', null) !== null,
    oauthClients: load<Record<string, string>>('oauthClients', {}),
    oauth: load<Record<string, string>>('oauth', {}),
  };
}
// Android uses the same TypeScript crypto and Markdown format over private native files.
async function mobile(request: Request): Promise<unknown> {
  const { op, id, passcode } = request;
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
  if (op === 'account:setLocal') {
    if (typeof passcode !== 'string' || passcode.length < 4) throw new Error('Passcode too short');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    store('account', { salt: toBase64(salt), hash: await derivePasscode(passcode, salt) });
    return { ok: true };
  }
  if (op === 'account:verifyLocal') {
    const saved = load<{ salt: string; hash: string } | null>('account', null);
    if (!saved || typeof passcode !== 'string') return { ok: false };
    return { ok: safeEqual(await derivePasscode(passcode, fromBase64(saved.salt)), saved.hash) };
  }
  if (op === 'account:clearLocal') { localStorage.removeItem('diary.account'); return { ok: true }; }
  if (op === 'account:clearOAuth') { localStorage.removeItem('diary.account'); const p = load<{ username: string; avatar: string | null; signature: string }>('profile', { username: '', avatar: null, signature: '' }); p.username = ''; store('profile', p); return { ok: true }; }
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
    return native({ ...request, ...(clientId ? { clientId } : {}) });
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
