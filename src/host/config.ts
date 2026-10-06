// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ITERATIONS = 310_000;

async function deriveKey(material: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', material as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: ITERATIONS },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}
async function seal(plain: string, key: CryptoKey): Promise<string> {
  const iv = randomBytes(12);
  const data = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plain)));
  return `v1:${iv.toString('base64')}:${Buffer.from(data).toString('base64')}`;
}
async function unseal(sealed: string, key: CryptoKey): Promise<string> {
  const parts = sealed.split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Unsupported secret envelope');
  const iv = Buffer.from(parts[1]!, 'base64');
  const data = Buffer.from(parts[2]!, 'base64');
  return decoder.decode(await subtle.decrypt({ name: 'AES-GCM', iv }, key, data));
}

export interface ProviderConfig { baseUrl: string; model: string; apiKeySealed?: string }
export interface LocalAccount { salt: string; hash: string }
export interface PersistedConfig {
  version: number;
  activeProvider: string;
  providers: Record<string, ProviderConfig>;
  account: { local: LocalAccount | null; oauth: Record<string, string>; oauthClients: Record<string, string> };
  profile: { username: string; avatar: string | null; signature: string };
  media: { background: string | null; bgm: string | null };
}

const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
};

function defaultConfig(): PersistedConfig {
  return {
    version: 1,
    activeProvider: 'openai',
    providers: structuredClone(DEFAULT_PROVIDERS),
    account: { local: null, oauth: {}, oauthClients: {} },
    profile: { username: '', avatar: null, signature: '' },
    media: { background: null, bgm: null },
  };
}

/**
 * Host-only. Persists Diary settings and encrypted secrets next to the vault.
 * API keys are sealed with a per-install device key so they never sit in plaintext.
 * Network and filesystem calls are confined to this module; the web UI never touches it.
 */
export class HostConfig {
  #root: string;
  #deviceKey: CryptoKey | null = null;
  #data: PersistedConfig;
  private constructor(root: string, data: PersistedConfig) { this.#root = root; this.#data = data; }

  static async open(root: string): Promise<HostConfig> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const deviceKeyPath = join(root, 'device.key');
    let deviceRaw: string;
    try { deviceRaw = (await readFile(deviceKeyPath, 'utf8')).trim(); }
    catch {
      deviceRaw = randomBytes(32).toString('base64url');
      await writeFile(deviceKeyPath, deviceRaw, { mode: 0o600 });
    }
    const deviceKey = await deriveKey(Buffer.from(deviceRaw, 'base64url'), encoder.encode('diary-device-v1'));
    let data: PersistedConfig = defaultConfig();
    try {
      const raw = await readFile(join(root, 'config.json'), 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
      data = { ...defaultConfig(), ...parsed, providers: { ...DEFAULT_PROVIDERS, ...(parsed.providers ?? {}) } };
    } catch { /* fresh config */ }
    const config = new HostConfig(root, data);
    config.#deviceKey = deviceKey;
    return config;
  }

  async save(): Promise<void> {
    if (!this.#deviceKey) throw new Error('Config not initialized');
    await writeFile(join(this.#root, 'config.json'), JSON.stringify(this.#data, null, 2), { mode: 0o600 });
  }

  get raw(): Readonly<PersistedConfig> { return this.#data; }
  get activeProvider(): string { return this.#data.activeProvider; }
  set activeProvider(id: string) { if (!Object.hasOwn(this.#data.providers, id)) throw new Error(`Unknown provider: ${id}`); this.#data.activeProvider = id; }
  getProvider(id: string): ProviderConfig { return this.#data.providers[id] ?? DEFAULT_PROVIDERS[id]!; }
  setProvider(id: string, patch: Partial<Omit<ProviderConfig, 'apiKeySealed'>>): void {
    this.#data.providers[id] = { ...(this.#data.providers[id] ?? DEFAULT_PROVIDERS[id]!), ...patch };
  }

  async setSecret(key: string, value: string): Promise<void> {
    if (!this.#deviceKey) throw new Error('Config not initialized');
    this.#data.providers[key] = { ...(this.#data.providers[key] ?? DEFAULT_PROVIDERS[key] ?? { baseUrl: '', model: '' }), apiKeySealed: await seal(value, this.#deviceKey) };
  }
  async getSecret(key: string): Promise<string | null> {
    if (!this.#deviceKey) throw new Error('Config not initialized');
    const sealed = this.#data.providers[key]?.apiKeySealed;
    if (!sealed) return null;
    try { return await unseal(sealed, this.#deviceKey); } catch { return null; }
  }

  setProfile(patch: Partial<PersistedConfig['profile']>): void { this.#data.profile = { ...this.#data.profile, ...patch }; }
  get profile(): Readonly<PersistedConfig['profile']> { return this.#data.profile; }
  setMedia(patch: Partial<PersistedConfig['media']>): void { this.#data.media = { ...this.#data.media, ...patch }; }
  get media(): Readonly<PersistedConfig['media']> { return this.#data.media; }
  setLocalAccount(account: LocalAccount | null): void { this.#data.account.local = account; }
  get localAccount(): LocalAccount | null { return this.#data.account.local; }
  setOAuth(provider: string, token: string | null): void {
    if (token === null) delete this.#data.account.oauth[provider];
    else this.#data.account.oauth[provider] = token;
  }
  getOAuth(provider: string): string | null { return this.#data.account.oauth[provider] ?? null; }
  setOAuthClient(provider: string, clientId: string): void { this.#data.account.oauthClients[provider] = clientId; }
  getOAuthClient(provider: string): string | null { return this.#data.account.oauthClients[provider] ?? null; }
}
