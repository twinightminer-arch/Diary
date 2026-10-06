// SPDX-License-Identifier: AGPL-3.0-only
import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from 'electron';
import { join, resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { MarkdownEngine } from '../storage/markdown-engine.ts';
import type { Request } from '../app/api.ts';
import { HostConfig, type BackgroundState, type LocationState, type PermissionState } from '../host/config.ts';
import { loadPlugins, type ProviderPlugin } from '../host/plugins.ts';
import { buildAgent } from '../agent/skills.ts';
import { batchEncrypt, batchDecrypt, batchChangePasscode } from '../host/batch.ts';
import { importMedia, listMedia, readMediaDataUrl, removeMedia } from '../host/media.ts';
import { WALLPAPER_SCHEME, decodeWallpaperPath, scanWallpapers, type WallpaperScan } from '../host/wallpaper.ts';
import {
  createLocalAccount, signIn, signOut, changeUserPassword, setRecoveryQuestion,
  recoverPassword, linkGoogleToUser,
  buildAuthUrl, exchangeCode, googleUserInfo, googleClientId, GOOGLE_DESKTOP_CLIENT_SECRET,
  type OAuthProvider,
} from '../host/account.ts';

app.setName('Diary');
if (process.env.DIARY_TEST_HOME) app.setPath('userData', process.env.DIARY_TEST_HOME);

// Wallpapers and imported clips live outside the app bundle, and the renderer
// runs under a CSP that rejects file:// URLs. A privileged custom scheme is the
// only way to stream them (Range requests included) into <img>/<video>.
protocol.registerSchemesAsPrivileged([{
  scheme: WALLPAPER_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true },
}]);

/** Directories a `diary-wallpaper://` request is allowed to read from. */
const mediaRoots = new Set<string>();

/**
 * Feature plugins that ship with the app. They appear in 插件管理 next to the
 * user's own .mjs files and can be switched off the same way.
 */
const BUILTIN_PLUGINS = [
  { id: 'wallpaper', name: '壁纸与背景', description: '图片、动图、视频背景，并可直接读取本机 Wallpaper Engine 库。', version: '1.0.0' },
  { id: 'weather', name: '实时天气', description: '首页天气面板：气温、风向、湿度、空气质量，支持一键导入日记。', version: '1.0.0' },
  { id: 'ai-agent', name: 'AI 助手', description: 'AI 问答、搜索与写作，走内置或插件提供的模型后端。', version: '1.0.0' },
  { id: 'campus', name: '办事指南', description: '24 项校园事务的材料清单、办理流程与进度追踪。', version: '1.0.0' },
  { id: 'competition', name: '竞赛中心', description: '竞赛目录、方向筛选与日历标记。', version: '1.0.0' },
] as const;

/** Append one diagnostic line for the Google OAuth flow; never breaks the flow. */
function oauthLog(step: string, detail = ''): void {
  try { appendFileSync(join(app.getPath('userData'), 'oauth-debug.log'), `${new Date().toISOString()} ${step} ${detail}\n`); } catch { /* diagnostics only */ }
}
/** Append one diagnostic line for the AI layer; never breaks startup. */
function aiLog(step: string, detail = ''): void {
  try { appendFileSync(join(app.getPath('userData'), 'ai-debug.log'), `${new Date().toISOString()} ${step} ${detail}\n`); } catch { /* diagnostics only */ }
}

/** Makes backends declared by plugin files addressable in the settings screen. */
async function registerPluginProviders(config: HostConfig, plugins: readonly ProviderPlugin[]): Promise<void> {
  let changed = false;
  for (const plugin of plugins) {
    if (config.raw.providers[plugin.id]) continue;
    config.setProvider(plugin.id, { baseUrl: plugin.baseUrl ?? '', model: plugin.model ?? '' });
    aiLog('plugin-registered', `${plugin.id} -> ${plugin.baseUrl ?? ''}`);
    changed = true;
  }
  if (changed) await config.save();
}

/**
 * Wires an AI backend from the environment when the user has not set one up.
 * Explicit DIARY_AI_* variables win, then the vendor variables. A provisioned
 * machine therefore ends up with a working assistant and no manual setup.
 */
async function autoWireProvider(config: HostConfig): Promise<void> {
  const env = process.env;
  const explicit = env.DIARY_AI_KEY?.trim();
  const vendors: [string, string | undefined][] = [
    ['deepseek', env.DEEPSEEK_API_KEY],
    ['moonshot', env.MOONSHOT_API_KEY],
    ['zhipu', env.ZHIPU_API_KEY ?? env.GLM_API_KEY],
    ['siliconflow', env.SILICONFLOW_API_KEY],
  ];
  let target: { id: string; key: string } | null = null;
  if (explicit) target = { id: (env.DIARY_AI_PROVIDER ?? 'deepseek').trim() || 'deepseek', key: explicit };
  else {
    const hit = vendors.find(([, key]) => Boolean(key?.trim()));
    if (hit?.[1]) target = { id: hit[0], key: hit[1].trim() };
  }
  if (!target) return;
  if (env.DIARY_AI_BASE_URL?.trim()) config.setProvider(target.id, { baseUrl: env.DIARY_AI_BASE_URL.trim() });
  if (env.DIARY_AI_MODEL?.trim()) config.setProvider(target.id, { model: env.DIARY_AI_MODEL.trim() });
  if (!(await config.getSecret(target.id))) await config.setSecret(target.id, target.key);
  config.activeProvider = target.id;
  await config.save();
  aiLog('auto-wired', `${target.id} via ${explicit ? 'DIARY_AI_KEY' : 'vendor env'}`);
}
const appDir = fileURLToPath(new URL('.', import.meta.url));
let win: BrowserWindow | null = null;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win?.isMinimized()) win.restore(); win?.show(); win?.focus(); });
  app.whenReady().then(async () => {
    // Follow the operating system proxy so Google requests work behind Clash/VPN.
    try { await session.defaultSession.setProxy({ mode: 'system' }); } catch { /* keep Electron default */ }
    const dataDir = process.env.DIARY_TEST_VAULT ? join(process.env.DIARY_TEST_VAULT, '..') : app.getPath('userData');
    const vault = process.env.DIARY_TEST_VAULT || join(app.getPath('userData'), 'journals');
    const engine = await MarkdownEngine.open(vault);
    const config = await HostConfig.open(dataDir);
    // AI plugins: every .mjs dropped into <userData>/plugins/ becomes a
    // selectable backend (see src/host/plugins.ts for the contract).
    const plugins = await loadPlugins(join(dataDir, 'plugins'));
    for (const problem of plugins.errors) aiLog('plugin-error', `${problem.file} ${problem.message}`);
    await registerPluginProviders(config, plugins.providers);
    await autoWireProvider(config);
    // Electron's net.fetch runs on the Chromium network stack and honours the OS
    // proxy; Node's global fetch ignores it and then hangs forever behind Clash.
    const aiFetch = net.fetch.bind(net) as unknown as typeof fetch;
    const agent = buildAgent({ vault, config, fetchImpl: aiFetch, plugins: plugins.providers });
    aiLog('ready', `provider=${config.activeProvider} plugins=${plugins.sources.length}`);

    // ---- Media protocol + Wallpaper Engine library ----
    // Imported media and wallpaper projects live outside the bundle, and the
    // renderer CSP forbids file://, so everything is served over this scheme.
    mediaRoots.add(resolve(join(vault, 'media')));
    let wallpaperCache: WallpaperScan = { engines: [], entries: [], hint: '' };
    const refreshWallpapers = async (force = false): Promise<WallpaperScan> => {
      if (!force && (wallpaperCache.entries.length || wallpaperCache.hint)) return wallpaperCache;
      try {
        wallpaperCache = await scanWallpapers(config.wallpaperDir ?? undefined);
      } catch (error) {
        wallpaperCache = { engines: [], entries: [], hint: `扫描失败：${error instanceof Error ? error.message : String(error)}` };
      }
      for (const engine of wallpaperCache.engines) mediaRoots.add(resolve(engine));
      if (config.wallpaperDir) mediaRoots.add(resolve(config.wallpaperDir));
      aiLog('wallpaper-scan', `engines=${wallpaperCache.engines.length} entries=${wallpaperCache.entries.length}`);
      return wallpaperCache;
    };
    await refreshWallpapers(true);

    protocol.handle(WALLPAPER_SCHEME, async (request) => {
      try {
        const url = new URL(request.url);
        const kind = url.hostname;
        const rest = decodeURIComponent(url.pathname.replace(/^\//, ''));
        let file: string;
        if (kind === 'wallpaper') file = decodeWallpaperPath(rest);
        else if (kind === 'media') {
          if (!/^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9]{1,8}$/.test(rest)) return new Response('bad media id', { status: 400 });
          file = join(vault, 'media', rest);
        } else return new Response('unknown host', { status: 400 });
        const target = resolve(file);
        const allowed = [...mediaRoots].some(root => target.toLowerCase().startsWith(root.toLowerCase()));
        if (!allowed) { aiLog('media-denied', target); return new Response('forbidden', { status: 403 }); }
        return await net.fetch(pathToFileURL(target).toString());
      } catch (error) {
        return new Response(String(error), { status: 500 });
      }
    });

    const configSnapshot = () => {
      const session = config.session;
      const current = session.userId ? config.getUser(session.userId) : null;
      return {
        activeProvider: config.activeProvider,
        providers: Object.entries(config.raw.providers).map(([id, p]) => ({ id, baseUrl: p.baseUrl, model: p.model, hasKey: Boolean(p.apiKeySealed) })),
        profile: config.profile,
        media: config.media,
        users: config.users.map(u => ({
          id: u.id, username: u.username, displayName: u.displayName, avatar: u.avatar,
          googleEmail: u.googleEmail, autoLogin: u.autoLogin, hasRecovery: Boolean(u.recoveryQuestion),
        })),
        currentUser: current ? { id: current.id, username: current.username, displayName: current.displayName, avatar: current.avatar, googleEmail: current.googleEmail } : null,
        remember: session.remember,
        google: config.google,
        oauthClients: config.raw.account.oauthClients,
        background: config.background,
        permissions: config.permissions,
        location: config.location,
        wallpaperDir: config.wallpaperDir,
        builtinPlugins: BUILTIN_PLUGINS.map(plugin => ({ ...plugin, kind: 'builtin' as const, enabled: config.isPluginEnabled(plugin.id) })),
        plugins: plugins.sources,
        pluginErrors: plugins.errors,
        pluginDirectory: plugins.directory,
      };
    };

    ipcMain.handle('diary:call', async (event, request: Request) => {
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted caller');
      if (!request || typeof request.op !== 'string') throw new Error('Invalid request');
      const {
        op, id, document, passcode, next, confirmation, ids, lat, lon, locale, query, prompt, messages, task, system,
        template, markdown, name, mime, data, bgm, avatar, username, signature, provider, clientId, redirectUri, state,
        codeChallenge, code, codeVerifier, baseUrl, model, url,
        kind, folder, fit, dim, blur, path, title, animated,
        pluginId, enabled, network, location, mode, label,
      } = request;
      switch (op) {
        case 'list': return engine.listEntries();
        case 'read': return engine.readEntry(id!, passcode);
        case 'create': return engine.createEntry(id!, document!, passcode);
        case 'update': return engine.updateEntry(id!, document!, passcode);
        case 'delete': return engine.deleteEntry(id!, passcode);
        case 'encrypt': return engine.encryptEntry(id!, passcode!, confirmation!);
        case 'decrypt': return engine.decryptEntry(id!, passcode!);
        case 'changePasscode': return engine.changeEntryPasscode(id!, passcode!, next!, confirmation!);
        case 'info': return { platform: 'Windows', location: vault, version: app.getVersion() };
        case 'showFolder': return shell.openPath(vault);
        case 'openExternal': await shell.openExternal(String(url)); return { ok: true };
        case 'import': {
          const result = await dialog.showOpenDialog(win, { filters: [{ name: 'Markdown', extensions: ['md'] }], properties: ['openFile'] });
          if (result.canceled || !result.filePaths[0]) return null;
          const source = await readFile(result.filePaths[0], 'utf8');
          if (source.length > 10_000_000) throw new Error('File exceeds 10 MB');
          return source;
        }
        case 'export': {
          const entries = await engine.listEntries();
          if (!entries.some(entry => entry.id === id)) throw new Error('Entry not found');
          const result = await dialog.showSaveDialog(win, { defaultPath: `${id}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
          if (result.canceled || !result.filePath) return false;
          await writeFile(result.filePath, await readFile(join(vault, `${id}.md`)), { mode: 0o600 });
          return true;
        }
        // ----- Configuration & AI provider -----
        case 'config:get': return configSnapshot();
        case 'config:setProvider': {
          if (typeof id !== 'string') throw new Error('Provider id required');
          if (typeof baseUrl === 'string') config.setProvider(id, { baseUrl });
          if (typeof model === 'string') config.setProvider(id, { model });
          if (typeof next === 'string' && next) await config.setSecret(id, next);
          if (id) config.activeProvider = id;
          await config.save();
          return configSnapshot();
        }
        // ----- Accounts (multi-user) -----
        case 'account:list': return configSnapshot();
        case 'account:create': {
          const confirmation = typeof request.confirmation === 'string' ? request.confirmation : undefined;
          const displayName = typeof request.displayName === 'string' ? request.displayName : undefined;
          const user = await createLocalAccount(config, {
            username: String(request.username ?? ''), passcode: String(passcode ?? ''),
            ...(confirmation !== undefined ? { confirmation } : {}),
            ...(displayName !== undefined ? { displayName } : {}),
            autoLogin: Boolean(request.remember),
          });
          config.setSession({ userId: user.id, remember: Boolean(request.remember) });
          if (displayName) config.setProfile({ username: displayName });
          await config.save();
          return configSnapshot();
        }
        case 'account:signIn': {
          const user = await signIn(config, String(request.username ?? ''), String(passcode ?? ''), Boolean(request.remember));
          if (user.displayName) config.setProfile({ username: user.displayName, avatar: user.avatar });
          await config.save();
          return configSnapshot();
        }
        case 'account:signOut': signOut(config); await config.save(); return configSnapshot();
        case 'account:renameDisplay': {
          const target = String(id ?? ''); const displayName = String(request.displayName ?? '').trim();
          if (!config.getUser(target)) throw new Error('Unknown user');
          if (displayName) config.updateUser(target, { displayName });
          await config.save(); return configSnapshot();
        }
        case 'account:changePassword': {
          const userId = config.session.userId; if (!userId) throw new Error('Not signed in');
          const confirmation = typeof request.confirmation === 'string' ? request.confirmation : undefined;
          await changeUserPassword(config, userId, String(passcode ?? ''), String(request.next ?? ''), ...(confirmation !== undefined ? [confirmation] : []));
          await config.save(); return { ok: true };
        }
        case 'account:setRecovery': {
          const userId = config.session.userId; if (!userId) throw new Error('Not signed in');
          await setRecoveryQuestion(config, userId, String(request.question ?? ''), String(request.answer ?? ''));
          await config.save(); return configSnapshot();
        }
        case 'account:recover': {
          const confirmation = typeof request.confirmation === 'string' ? request.confirmation : undefined;
          await recoverPassword(config, String(id ?? ''), String(request.answer ?? ''), String(request.next ?? ''), ...(confirmation !== undefined ? [confirmation] : []));
          await config.save(); return { ok: true };
        }
        case 'account:oauthGoogle': {
          try {
          // PKCE for a public client: verifier -> S256 challenge.
          const verifier = randomBytes(43).toString('hex'); // 86 hex chars, within the 43-128 range
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          const oauthState = randomUUID();
          const clientId = googleClientId('desktop');
          let redirectUri = '';
          const codeReceived = new Promise<string>((resolve, reject) => {
            const server = createServer((req, res) => {
              try {
                const parsed = new URL(req.url ?? '/', 'http://127.0.0.1');
                if (parsed.searchParams.get('state') !== oauthState) {
                  res.writeHead(400); res.end('state mismatch'); server.close();
                  reject(new Error('Google 回调校验失败（state 不匹配），请重新发起登录。'));
                  return;
                }
                const error = parsed.searchParams.get('error');
                if (error) {
                  res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
                  res.end(`Google 授权失败：${error}`); reject(new Error(`Google 授权被拒绝：${error}`)); server.close(); return;
                }
                const code = parsed.searchParams.get('code');
                if (!code) {
                  res.writeHead(400); res.end('missing authorization code'); server.close();
                  reject(new Error('Google 未返回授权码，请重试。'));
                  return;
                }
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
                res.end('<html><head><meta charset="utf-8"><style>body{font-family:system-ui,sans-serif;padding:3rem;color:#333}</style></head>'
                  + '<body><h2>Diary 登录成功 ✓</h2><p>您可以关闭此页面，并返回 Diary 应用继续。</p></body></html>');
                resolve(code); server.close();
              } catch {
                res.writeHead(500); res.end('internal error'); server.close();
                reject(new Error('本地回调处理失败，请重试。'));
              }
            });
            server.on('error', reject);
            server.listen(0, '127.0.0.1', () => {
              redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/oauth2callback`;
              const authUrl = buildAuthUrl('google' as OAuthProvider, { clientId, redirectUri, state: oauthState, codeChallenge: challenge });
              oauthLog('browser-opened', redirectUri);
              void shell.openExternal(authUrl);
            });
          });
          const code = await Promise.race([
            codeReceived,
            new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Google 登录超时（5 分钟），请在浏览器完成授权后重试。')), 5 * 60_000)),
          ]);
          oauthLog('code-received', redirectUri);
          try { oauthLog('proxy', await session.defaultSession.resolveProxy('https://oauth2.googleapis.com')); } catch { /* ignore */ }
          // Electron's net.fetch goes through the Chromium network stack, so it
          // honours the OS proxy settings. A plain Node fetch ignores them and
          // then simply hangs forever when a proxy is required.
          const googleFetch = net.fetch.bind(net) as unknown as typeof fetch;
          const token = await exchangeCode('google' as OAuthProvider, {
            clientId, code, codeVerifier: verifier, redirectUri, clientSecret: process.env.GOOGLE_DESKTOP_CLIENT_SECRET || GOOGLE_DESKTOP_CLIENT_SECRET,
          }, googleFetch);
          oauthLog('token-ok', token.access_token.slice(0, 6));
          // Fetch the Google identity, then bind it to a local account (one-to-one).
          let info = { email: '', name: '', picture: '' as string | null };
          try { info = await googleUserInfo(token.access_token, googleFetch); }
          catch (error) { oauthLog('userinfo-failed', error instanceof Error ? error.message : String(error)); }
          if (!info.email) throw new Error('无法获取 Google 账户信息，请重试');
          const identity = { googleId: info.email, email: info.email, name: info.name || info.email, picture: info.picture || null };
          config.setGoogle(identity);
          const user = await linkGoogleToUser(config, identity);
          config.setToken('google', { accessToken: token.access_token, linkedUserId: user.id });
          config.setSession({ userId: user.id, remember: Boolean(request.next) });
          // Cache the Google avatar as a data URL: a remote picture is blocked by
          // the CSP (img-src 'self' data:) and would also break offline use.
          let avatar = user.avatar;
          if (identity.picture?.startsWith('https://')) {
            try {
              const picture = await googleFetch(identity.picture, { signal: AbortSignal.timeout(15_000) });
              const mime = (picture.headers.get('content-type') ?? '').split(';')[0] ?? '';
              const bytes = picture.ok ? Buffer.from(await picture.arrayBuffer()) : Buffer.alloc(0);
              if (mime.startsWith('image/') && bytes.byteLength > 0 && bytes.byteLength < 4_000_000) {
                avatar = `data:${mime};base64,${bytes.toString('base64')}`;
                config.updateUser(user.id, { avatar });
                oauthLog('avatar-cached', `${bytes.byteLength}B ${mime}`);
              }
            } catch (error) { oauthLog('avatar-failed', error instanceof Error ? error.message : String(error)); }
          }
          // Import the Google display name and avatar into the local profile.
          config.setProfile({ username: user.displayName, avatar });
          await config.save();
          oauthLog('done', user.username);
          return { ok: true, email: info.email, name: user.displayName, picture: user.avatar, userId: user.id, snapshot: configSnapshot() };
          } catch (error) {
            oauthLog('failed', error instanceof Error ? error.message : String(error));
            throw error;
          }
        }
        // ----- Profile -----
        case 'profile:get': return config.profile;
        case 'profile:set': {
          const patch: Record<string, unknown> = {};
          if (typeof username === 'string') patch.username = username;
          if (typeof signature === 'string') patch.signature = signature;
          if (typeof avatar === 'string' || avatar === null) patch.avatar = avatar;
          config.setProfile(patch);
          await config.save();
          return config.profile;
        }
        // ----- Media (background, BGM, illustrations, avatar) -----
        case 'media:import': {
          if (typeof data !== 'string' || typeof mime !== 'string') throw new Error('Media payload required');
          const buffer = Uint8Array.from(Buffer.from(data, 'base64'));
          return importMedia(vault, buffer, typeof name === 'string' ? name : 'media', mime);
        }
        case 'media:list': return listMedia(vault);
        case 'media:data': { if (typeof id !== 'string') throw new Error('Media id required'); return readMediaDataUrl(vault, id); }
        case 'media:remove': { if (typeof id !== 'string') throw new Error('Media id required'); await removeMedia(vault, id); return { ok: true }; }
        case 'media:setBgm': config.setMedia({ bgm: typeof bgm === 'string' || bgm === null ? bgm : config.media.bgm }); await config.save(); return config.media;
        // ----- Background & wallpaper (the built-in wallpaper plugin) -----
        case 'background:set': {
          const patch: Partial<BackgroundState> = {};
          if (kind === 'image' || kind === 'video' || kind === 'wallpaper') patch.kind = kind;
          if (typeof id === 'string' || id === null) patch.media = id ?? null;
          if (typeof path === 'string') {
            patch.wallpaper = { path, title: typeof title === 'string' ? title : '', animated: Boolean(animated) };
            patch.kind = 'wallpaper';
          }
          if (fit === 'cover' || fit === 'contain' || fit === 'tile' || fit === 'center') patch.fit = fit;
          if (typeof dim === 'number' && Number.isFinite(dim)) patch.dim = Math.min(1, Math.max(0, dim));
          if (typeof blur === 'number' && Number.isFinite(blur)) patch.blur = Math.min(40, Math.max(0, blur));
          config.setBackground(patch);
          await config.save();
          return config.background;
        }
        case 'background:clear': config.clearBackground(); await config.save(); return config.background;
        case 'wallpaper:scan': return await refreshWallpapers(true);
        case 'wallpaper:dir': {
          if (typeof folder === 'string' || folder === null) {
            config.setWallpaperDir(folder || null);
            await config.save();
          }
          return { dir: config.wallpaperDir, ...(await refreshWallpapers(true)) };
        }
        case 'wallpaper:pick': {
          const picked = await dialog.showOpenDialog(win!, {
            title: '选择 Wallpaper Engine 目录',
            message: '通常位于 Steam/steamapps/common/wallpaper_engine',
            properties: ['openDirectory'],
          });
          if (picked.canceled || !picked.filePaths[0]) return { canceled: true, dir: config.wallpaperDir, engines: wallpaperCache.engines, entries: wallpaperCache.entries, hint: wallpaperCache.hint };
          config.setWallpaperDir(picked.filePaths[0]);
          await config.save();
          return { canceled: false, dir: config.wallpaperDir, ...(await refreshWallpapers(true)) };
        }
        // ----- Permissions & location -----
        case 'permission:set': {
          const patch: Partial<PermissionState> = {};
          if (typeof network === 'boolean') patch.network = network;
          if (typeof location === 'boolean') patch.location = location;
          config.setPermissions(patch);
          await config.save();
          return config.permissions;
        }
        case 'location:set': {
          const patch: Partial<LocationState> = {};
          if (mode === 'auto' || mode === 'manual') patch.mode = mode;
          if (typeof lat === 'number' && Number.isFinite(lat)) patch.lat = lat;
          if (typeof lon === 'number' && Number.isFinite(lon)) patch.lon = lon;
          if (typeof label === 'string') patch.label = label;
          config.setLocation(patch);
          await config.save();
          return config.location;
        }
        // ----- Plugin manager -----
        case 'plugin:list': return {
          builtin: BUILTIN_PLUGINS.map(plugin => ({ ...plugin, kind: 'builtin' as const, enabled: config.isPluginEnabled(plugin.id) })),
          external: plugins.sources,
          errors: plugins.errors,
          directory: plugins.directory,
        };
        case 'plugin:toggle': {
          if (typeof pluginId !== 'string' || !BUILTIN_PLUGINS.some(plugin => plugin.id === pluginId)) throw new Error('未知插件');
          config.setPluginEnabled(pluginId, enabled !== false);
          await config.save();
          return { builtin: BUILTIN_PLUGINS.map(plugin => ({ ...plugin, kind: 'builtin' as const, enabled: config.isPluginEnabled(plugin.id) })) };
        }
        case 'plugin:openDir': { await shell.openPath(plugins.directory); return { ok: true, directory: plugins.directory }; }
        // ----- AI agent -----
        case 'agent:compose': return agent.api.compose({ messages: messages as never, task: task as never, ...(typeof system === 'string' ? { system } : {}) });
        case 'agent:probe': return agent.api.probe();
        case 'agent:illustrate': { if (typeof prompt !== 'string') throw new Error('Prompt required'); return agent.api.illustrate(prompt); }
        case 'agent:layout': return agent.api.layout({ markdown: String(markdown ?? ''), template: (template as never) ?? 'none' });
        // ----- Web / online -----
        case 'web:date': return agent.api.web({ kind: 'date', locale: typeof locale === 'string' ? locale : 'zh-CN' });
        case 'web:weather': return agent.api.web({ kind: 'weather', lat: Number(lat), lon: Number(lon) });
        case 'web:geocode': return agent.api.web({ kind: 'geocode', lat: Number(lat), lon: Number(lon) });
        case 'web:search': return agent.api.web({ kind: 'search', query: typeof query === 'string' ? query : '' });
        // One aggregate call for the home-page weather panel: resolves the
        // position (only with permission), then fetches sky + air together.
        case 'weather:now': {
          if (!config.permissions.network) {
            return { ok: false, reason: 'offline', message: '联网已关闭。打开「设置 → 联网与定位 → 联网」即可显示实时天气。' };
          }
          const saved = config.location;
          let lat = saved.lat;
          let lon = saved.lon;
          let place = saved.label;
          if (config.permissions.location && saved.mode === 'auto') {
            const located = await agent.api.web({ kind: 'locate' }) as { lat: number; lon: number; label: string } | null;
            if (located) {
              lat = located.lat; lon = located.lon; place = located.label || place;
              config.setLocation({ lat, lon, label: place });
              await config.save();
            }
          }
          if (typeof lat !== 'number' || typeof lon !== 'number') {
            return { ok: false, reason: 'noposition', message: '还没有位置。打开「设置 → 联网与定位」填写经纬度，或打开定位开关自动识别。' };
          }
          const [weather, air] = await Promise.all([
            agent.api.web({ kind: 'weather', lat, lon }),
            agent.api.web({ kind: 'air', lat, lon }).catch(() => null),
          ]);
          if (!place) {
            const geo = await agent.api.web({ kind: 'geocode', lat, lon }).catch(() => null) as { city?: string; country?: string } | null;
            place = [geo?.city, geo?.country].filter(Boolean).join(' · ');
          }
          return { ok: true, lat, lon, place, weather, air, fetchedAt: new Date().toISOString() };
        }
        // Writes the weather snapshot into the vault: today's entry when it
        // exists and is plaintext, otherwise a dedicated dated entry.
        case 'weather:import': {
          const block = typeof markdown === 'string' ? markdown.trim() : '';
          if (!block) throw new Error('天气内容为空');
          const heading = typeof title === 'string' && title.trim() ? title.trim() : '天气记录';
          const stamp = new Date();
          const iso = `${stamp.getFullYear()}-${String(stamp.getMonth() + 1).padStart(2, '0')}-${String(stamp.getDate()).padStart(2, '0')}`;
          const summaries = await engine.listEntries();
          const existing = kind === 'new' ? undefined : summaries.find(entry => entry.id === iso);
          if (existing && !existing.encrypted) {
            const current = await engine.readEntry(existing.id);
            const merged = `${current.body.trimEnd()}\n\n${block}\n`.trimStart();
            const updated = await engine.updateEntry(existing.id, { metadata: current.metadata, body: merged });
            return { ok: true, id: updated.id, mode: 'appended' };
          }
          const taken = new Set(summaries.map(entry => entry.id));
          let id = `${iso}-天气`;
          let suffix = 2;
          while (taken.has(id)) { id = `${iso}-天气-${suffix}`; suffix += 1; }
          const created = await engine.createEntry(id, { metadata: { title: heading }, body: `${block}\n` });
          return { ok: true, id: created.id, mode: 'created' };
        }
        // ----- Batch encryption -----
        case 'batch:encrypt': return batchEncrypt(vault, (ids as string[]) ?? [], String(passcode));
        case 'batch:decrypt': return batchDecrypt(vault, (ids as string[]) ?? [], String(passcode));
        case 'batch:changePasscode': return batchChangePasscode(vault, (ids as string[]) ?? [], String(passcode), String(next), String(confirmation));
        default: throw new Error('Unsupported operation');
      }
    });
    win = new BrowserWindow({
      width: 1280, height: 850, minWidth: 760, minHeight: 560, title: 'Diary',
      backgroundColor: '#f8f7f4', icon: join(appDir, '../assets/icon.ico'), show: !process.env.DIARY_TEST_HOME,
      webPreferences: { preload: join(appDir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: process.env.DIARY_TEST_NO_SANDBOX !== '1' },
    });
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    win.webContents.on('will-prevent-unload', event => {
      const choice = dialog.showMessageBoxSync(win!, { type: 'question', buttons: ['继续编辑 / Keep editing', '放弃修改 / Discard'], defaultId: 0, cancelId: 0, message: '有未保存的修改。Unsaved changes.' });
      if (choice === 1) event.preventDefault();
    });
    await win.loadFile(join(appDir, '../web/index.html'));
    if (process.env.DIARY_SMOKE_PATH) {
      await mkdir(process.env.DIARY_SMOKE_PATH, { recursive: true });
      await writeFile(join(process.env.DIARY_SMOKE_PATH, 'ready.txt'), 'Diary ready');
    }
  }).catch(error => { dialog.showErrorBox('Diary', String(error)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
}
