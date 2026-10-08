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

export interface ProviderConfig {
  baseUrl: string;
  model: string;
  /** Display name. Only set for user-created backends; built-ins use a table. */
  label?: string;
  /** True for a backend the user added by hand (可改名、可删除). */
  custom?: boolean;
  apiKeySealed?: string;
}

/**
 * One local account = one independent identity. Every user owns a private
 * username, password (salted PBKDF2), profile and optional Google binding, so
 * several people can share a device without seeing each other's space.
 */
export interface UserAccount {
  id: string;
  /** User-chosen login name, unique and case-insensitive across the device. */
  username: string;
  displayName: string;
  /** data: URL so the avatar renders offline and under a strict CSP. */
  avatar: string | null;
  salt: string;
  hash: string;
  /** Google subject id, present only after this account is linked to Google. */
  googleId: string | null;
  googleEmail: string | null;
  /** Security question + answer hash, used to recover a forgotten password. */
  recoveryQuestion: string | null;
  recoverySalt: string | null;
  recoveryHash: string | null;
  createdAt: number;
  lastLoginAt: number | null;
  /** Remember this account and sign in automatically on the next launch. */
  autoLogin: boolean;
}

/** Google identity is kept apart from the access token on purpose. */
export interface GoogleIdentity {
  googleId: string;
  email: string;
  name: string;
  picture: string | null;
}

export interface StoredToken { accessToken: string; linkedUserId: string | null }
export interface Session { userId: string | null; remember: boolean }

export type BackgroundKind = 'image' | 'video' | 'wallpaper' | 'file';
export interface WallpaperRef { path: string; title: string; animated: boolean }
export interface BackgroundState {
  /** How the background is produced. `null` means "no background". */
  kind: BackgroundKind | null;
  /** Media id of an imported picture or clip (lives in <vault>/media). */
  media: string | null;
  /**
   * Plain file name inside `<vault>/backgrounds`, used when kind === 'file'.
   * The folder is meant to be browsable — the user can see their own file
   * names and drop new pictures in by hand — so a name, not an opaque id.
   */
  file: string | null;
  /** Wallpaper Engine project, used when kind === 'wallpaper'. */
  wallpaper: WallpaperRef | null;
  /**
   * How the wallpaper is fitted into the work area. `contain` is the default:
   * the whole frame is shown at its own resolution, never cropped, never blown
   * up. `fill` stretches to cover every pixel (may distort); `cover` fills by
   * cropping; `tile` repeats; `center` shows it at 1:1.
   */
  fit: 'cover' | 'contain' | 'fill' | 'tile' | 'center';
  /** Black overlay opacity 0…1, so text stays readable over busy wallpapers. */
  dim: number;
  /** Backdrop blur in px. */
  blur: number;
  /**
   * How see-through the wallpaper itself is, 0…100. **0 means untouched
   * original quality** — the clip plays exactly as it was encoded. 100 leaves
   * nothing but the page behind it.
   */
  opacity: number;
  /** Brightness in percent; 100 is the clip as encoded. */
  brightness: number;
}
/**
 * Typography and top-bar chrome — the readability half of the wallpaper plugin.
 * A wallpaper can be any colour, so the text on top of it has to be adjustable.
 * Ported from the DSH wallpaper plugin: one master switch, and when it is off
 * every variable is removed so the app looks exactly as it did before.
 */
export interface ChromeState {
  /** Off = inject nothing at all; the native look comes back. */
  fontCustom: boolean;
  /** `#rrggbb`. Applied to the text that sits directly on the wallpaper. */
  fontColor: string;
  /** Body size in px. Everything else scales by the same ratio. */
  fontSize: number;
  /** Top bar background; empty means "follow the theme". */
  topbarColor: string;
}

export interface PermissionState {
  /** Master switch for every outbound request the app makes. */
  network: boolean;
  /** Allows reading the device position for the weather panel. */
  location: boolean;
}
export interface LocationState {
  /** `auto` resolves a rough position from the network; `manual` uses lat/lon. */
  mode: 'auto' | 'manual';
  lat: number | null;
  lon: number | null;
  label: string;
}

export interface PersistedConfig {
  version: number;
  activeProvider: string;
  providers: Record<string, ProviderConfig>;
  account: {
    users: UserAccount[];
    session: Session;
    google: GoogleIdentity | null;
    tokens: Record<string, StoredToken>;
    oauthClients: Record<string, string>;
  };
  profile: { username: string; avatar: string | null; signature: string };
  media: { background: BackgroundState; bgm: string | null; chrome: ChromeState };
  /** Built-in feature switches, e.g. { wallpaper: false } disables the plugin. */
  plugins: { disabled: string[] };
  /** On/off switch per AI plugin file in <userData>/plugins. Missing = on. */
  pluginStates: Record<string, boolean>;
  permissions: PermissionState;
  location: LocationState;
  /** Optional extra folder scanned for Wallpaper Engine projects. */
  wallpaperDir: string | null;
}

// Built-in OpenAI-compatible endpoints. DeepSeek leads because it is reachable
// from mainland China without a proxy; `local` targets any OpenAI-compatible
// server on this machine (openclaw gateway, Ollama, LM Studio, vLLM …).
const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  local: { baseUrl: 'http://127.0.0.1:3000/v1', model: 'deepseek-v4-flash' },
};

/** Ids owned by the built-in table — a hand-made backend may not claim one. */
export const DEFAULT_PROVIDER_IDS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_PROVIDERS));

export const EMPTY_BACKGROUND: BackgroundState = {
  kind: null, media: null, file: null, wallpaper: null,
  // 工作区默认不留空白；像素不经过滤镜、遮罩或透明处理。
  fit: 'fill', dim: 0, blur: 0, opacity: 0, brightness: 100,
};

/** Design baseline: every other text size is expressed as a ratio of this. */
export const BASE_FONT_SIZE = 15;
export const CHROME_DEFAULTS: ChromeState = { fontCustom: false, fontColor: '#20283a', fontSize: BASE_FONT_SIZE, topbarColor: '' };

/** A hex colour is either exactly `#rrggbb` or rejected; empty means "unset". */
function sanitiseHex(value: unknown, fallback: string, allowEmpty = false): string {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  if (!text) return allowEmpty ? '' : fallback;
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : fallback;
}

function sanitiseChrome(raw: unknown): ChromeState {
  const input = (raw ?? {}) as Partial<ChromeState>;
  const size = Number(input.fontSize);
  return {
    fontCustom: Boolean(input.fontCustom),
    fontColor: sanitiseHex(input.fontColor, CHROME_DEFAULTS.fontColor),
    fontSize: Number.isFinite(size) ? Math.min(24, Math.max(11, size)) : CHROME_DEFAULTS.fontSize,
    topbarColor: sanitiseHex(input.topbarColor, '', true),
  };
}

/** Clamps one background number into its documented range. */
export function clampBackgroundNumber(field: 'dim' | 'blur' | 'opacity' | 'brightness', value: number): number {
  const range = { dim: [0, 1], blur: [0, 40], opacity: [0, 100], brightness: [50, 150] } as const;
  if (!Number.isFinite(value)) return EMPTY_BACKGROUND[field];
  const [min, max] = range[field];
  return Math.min(max, Math.max(min, value));
}

function defaultConfig(): PersistedConfig {
  return {
    version: 1,
    activeProvider: 'deepseek',
    providers: structuredClone(DEFAULT_PROVIDERS),
    account: { users: [], session: { userId: null, remember: false }, google: null, tokens: {}, oauthClients: {} },
    profile: { username: '', avatar: null, signature: '' },
    media: { background: structuredClone(EMPTY_BACKGROUND), bgm: null, chrome: structuredClone(CHROME_DEFAULTS) },
    plugins: { disabled: [] },
    pluginStates: {},
    // Offline-first: nothing leaves the machine until the user opts in.
    permissions: { network: false, location: false },
    location: { mode: 'auto', lat: null, lon: null, label: '' },
    wallpaperDir: null,
  };
}

/** Old configs predate opacity/brightness; fill and clamp them in. */
function sanitiseBackground(raw: Partial<BackgroundState>): BackgroundState {
  const merged = { ...structuredClone(EMPTY_BACKGROUND), ...raw };
  return {
    ...merged,
    dim: clampBackgroundNumber('dim', merged.dim),
    blur: clampBackgroundNumber('blur', merged.blur),
    opacity: clampBackgroundNumber('opacity', merged.opacity),
    brightness: clampBackgroundNumber('brightness', merged.brightness),
  };
}

/** Folds the pre-plugin `background: <media id>` shape into the new model. */
function normalizeMedia(raw: unknown): PersistedConfig['media'] {
  const media = (raw ?? {}) as { background?: unknown; bgm?: unknown; chrome?: unknown };
  const bgm = typeof media.bgm === 'string' ? media.bgm : null;
  const chrome = sanitiseChrome(media.chrome);
  const flat = media.background;
  if (typeof flat === 'string') return { background: { ...structuredClone(EMPTY_BACKGROUND), kind: 'image', media: flat }, bgm, chrome };
  if (flat && typeof flat === 'object') return { background: sanitiseBackground(flat as Partial<BackgroundState>), bgm, chrome };
  return { background: structuredClone(EMPTY_BACKGROUND), bgm, chrome };
}

/**
 * Upgrade configs written by earlier builds. The old format kept a single
 * `account.local` passcode plus an `account.oauth` map that mixed Google
 * identity and access token together; both are folded into the new model so
 * existing users keep their diary and their Google sign-in.
 */
function migrate(raw: Partial<PersistedConfig> & { account?: Record<string, unknown> }): PersistedConfig {
  const base = defaultConfig();
  const legacyAccount = (raw.account ?? {}) as {
    local?: { salt: string; hash: string } | null;
    oauth?: Record<string, string>;
    oauthClients?: Record<string, string>;
  };
  // A build from the new model already carries a users array; keep it as-is.
  if (Array.isArray((raw.account as { users?: unknown } | undefined)?.users)) {
    return reconcile(raw);
  }
  const users: UserAccount[] = [];
  const legacyLocal = legacyAccount.local;
  if (legacyLocal && typeof legacyLocal.hash === 'string') {
    users.push({
      id: 'local', username: 'local', displayName: '本地用户', avatar: null,
      salt: legacyLocal.salt, hash: legacyLocal.hash,
      googleId: null, googleEmail: null,
      recoveryQuestion: null, recoverySalt: null, recoveryHash: null,
      createdAt: 0, lastLoginAt: null, autoLogin: false,
    });
  }
  return reconcile({
    ...raw,
    account: {
      users,
      session: { userId: null, remember: false },
      google: null,
      // Legacy oauth values were access tokens; keep them addressable by provider.
      tokens: Object.fromEntries(Object.entries(legacyAccount.oauth ?? {}).map(([k, v]) => [k, { accessToken: v, linkedUserId: null }])),
      oauthClients: legacyAccount.oauthClients ?? {},
    },
  });
}

/** Keeps only `id -> boolean` pairs, so a hand-edited config cannot break us. */
function sanitisePluginStates(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id && typeof value === 'boolean') out[id] = value;
  }
  return out;
}

/** Adds every field introduced after version 1 without dropping existing data. */
function reconcile(raw: Partial<PersistedConfig>): PersistedConfig {
  const base = defaultConfig();
  return {
    ...base,
    ...raw,
    providers: { ...DEFAULT_PROVIDERS, ...(raw.providers ?? {}) },
    profile: { ...base.profile, ...(raw.profile ?? {}) },
    media: normalizeMedia(raw.media),
    plugins: { disabled: Array.isArray(raw.plugins?.disabled) ? raw.plugins.disabled.filter(item => typeof item === 'string') : [] },
    pluginStates: sanitisePluginStates(raw.pluginStates),
    permissions: { ...base.permissions, ...(raw.permissions ?? {}) },
    location: { ...base.location, ...(raw.location ?? {}) },
    wallpaperDir: typeof raw.wallpaperDir === 'string' && raw.wallpaperDir ? raw.wallpaperDir : null,
  } as PersistedConfig;
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
      data = migrate(JSON.parse(raw) as Partial<PersistedConfig>);
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
  /** Drops a user-created backend. The caller checks it is safe to remove. */
  removeProvider(id: string): void { delete this.#data.providers[id]; }

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

  // ---- Background / wallpaper ----
  setBackground(patch: Partial<BackgroundState>): void {
    // Every number is clamped here so a bad slider value can never be persisted.
    const next = sanitiseBackground({ ...this.#data.media.background, ...patch });
    this.#data.media = { ...this.#data.media, background: next };
  }
  clearBackground(): void { this.#data.media = { ...this.#data.media, background: structuredClone(EMPTY_BACKGROUND) }; }
  get background(): Readonly<BackgroundState> { return this.#data.media.background; }
  get wallpaperDir(): string | null { return this.#data.wallpaperDir; }
  setWallpaperDir(dir: string | null): void { this.#data.wallpaperDir = dir; }

  // ---- Typography / top bar ----
  /** Current chrome settings. Always sanitised, never a raw hand-edited value. */
  get chrome(): Readonly<ChromeState> { return this.#data.media.chrome; }
  setChrome(patch: Partial<ChromeState>): void {
    this.#data.media = { ...this.#data.media, chrome: sanitiseChrome({ ...this.#data.media.chrome, ...patch }) };
  }

  // ---- Permissions & location ----
  get permissions(): Readonly<PermissionState> { return this.#data.permissions; }
  setPermissions(patch: Partial<PermissionState>): void { this.#data.permissions = { ...this.#data.permissions, ...patch }; }
  get location(): Readonly<LocationState> { return this.#data.location; }
  setLocation(patch: Partial<LocationState>): void { this.#data.location = { ...this.#data.location, ...patch }; }

  // ---- External AI plugin switches ----
  /** A plugin never seen before defaults to enabled. */
  isAiPluginEnabled(id: string): boolean { return this.#data.pluginStates[id] !== false; }
  setAiPluginEnabled(id: string, enabled: boolean): void { this.#data.pluginStates[id] = enabled; }

  // ---- Built-in feature plugins ----
  get disabledPlugins(): readonly string[] { return this.#data.plugins.disabled; }
  isPluginEnabled(id: string): boolean { return !this.#data.plugins.disabled.includes(id); }
  setPluginEnabled(id: string, enabled: boolean): void {
    const set = new Set(this.#data.plugins.disabled);
    if (enabled) set.delete(id); else set.add(id);
    this.#data.plugins.disabled = [...set];
  }

  // ---- Multi-user accounts ----
  get users(): readonly UserAccount[] { return this.#data.account.users; }
  getUser(id: string): UserAccount | null { return this.#data.account.users.find(u => u.id === id) ?? null; }
  /** Usernames are unique and case-insensitive, like a QQ/WeChat id. */
  findUserByName(username: string): UserAccount | null {
    const key = username.trim().toLowerCase();
    return this.#data.account.users.find(u => u.username.toLowerCase() === key) ?? null;
  }
  findUserByGoogleId(googleId: string): UserAccount | null {
    return this.#data.account.users.find(u => u.googleId === googleId) ?? null;
  }
  addUser(user: UserAccount): void { this.#data.account.users.push(user); }
  updateUser(id: string, patch: Partial<UserAccount>): void {
    const index = this.#data.account.users.findIndex(u => u.id === id);
    if (index < 0) throw new Error(`Unknown user: ${id}`);
    this.#data.account.users[index] = { ...this.#data.account.users[index]!, ...patch };
  }
  removeUser(id: string): void { this.#data.account.users = this.#data.account.users.filter(u => u.id !== id); }
  get hasAnyUser(): boolean { return this.#data.account.users.length > 0; }

  // ---- Session (remember / auto sign-in) ----
  get session(): Readonly<Session> { return this.#data.account.session; }
  setSession(patch: Partial<Session>): void { this.#data.account.session = { ...this.#data.account.session, ...patch }; }

  // ---- Google identity (separate from the access token) ----
  get google(): GoogleIdentity | null { return this.#data.account.google; }
  setGoogle(identity: GoogleIdentity | null): void { this.#data.account.google = identity; }
  getToken(provider: string): StoredToken | null { return this.#data.account.tokens[provider] ?? null; }
  setToken(provider: string, token: StoredToken | null): void {
    if (token === null) delete this.#data.account.tokens[provider];
    else this.#data.account.tokens[provider] = token;
  }
  setOAuthClient(provider: string, clientId: string): void { this.#data.account.oauthClients[provider] = clientId; }
  getOAuthClient(provider: string): string | null { return this.#data.account.oauthClients[provider] ?? null; }
}
