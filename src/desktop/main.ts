// SPDX-License-Identifier: AGPL-3.0-only
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MarkdownEngine } from '../storage/markdown-engine.ts';
import type { Request } from '../app/api.ts';
import { HostConfig } from '../host/config.ts';
import { buildAgent } from '../agent/skills.ts';
import { batchEncrypt, batchDecrypt, batchChangePasscode } from '../host/batch.ts';
import { importMedia, listMedia, readMediaDataUrl, removeMedia } from '../host/media.ts';
import {
  setLocalPasscode, verifyLocalPasscode, hasLocalAccount, clearLocalAccount,
  buildAuthUrl, exchangeCode, type OAuthProvider,
} from '../host/account.ts';

app.setName('Diary');
if (process.env.DIARY_TEST_HOME) app.setPath('userData', process.env.DIARY_TEST_HOME);
const appDir = fileURLToPath(new URL('.', import.meta.url));
let win: BrowserWindow | null = null;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win?.isMinimized()) win.restore(); win?.show(); win?.focus(); });
  app.whenReady().then(async () => {
    const dataDir = process.env.DIARY_TEST_VAULT ? join(process.env.DIARY_TEST_VAULT, '..') : app.getPath('userData');
    const vault = process.env.DIARY_TEST_VAULT || join(app.getPath('userData'), 'journals');
    const engine = await MarkdownEngine.open(vault);
    const config = await HostConfig.open(dataDir);
    const agent = buildAgent({ vault, config });

    const configSnapshot = () => ({
      activeProvider: config.activeProvider,
      providers: Object.entries(config.raw.providers).map(([id, p]) => ({ id, baseUrl: p.baseUrl, model: p.model, hasKey: Boolean(p.apiKeySealed) })),
      profile: config.profile,
      media: config.media,
      hasLocalAccount: hasLocalAccount(config),
      oauthClients: config.raw.account.oauthClients,
    });

    ipcMain.handle('diary:call', async (event, request: Request) => {
      if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted caller');
      if (!request || typeof request.op !== 'string') throw new Error('Invalid request');
      const { op, id, document, passcode, next, confirmation, ids, lat, lon, locale, query, prompt, messages, task, system, template, markdown, name, mime, data, background, bgm, avatar, username, signature, provider, clientId, redirectUri, state, codeChallenge, code, codeVerifier, baseUrl, model, url } = request;
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
        // ----- Accounts -----
        case 'account:setLocal': { if (typeof passcode !== 'string') throw new Error('Passcode required'); await setLocalPasscode(config, passcode); return { ok: true }; }
        case 'account:verifyLocal': return { ok: typeof passcode === 'string' && await verifyLocalPasscode(config, passcode) };
        case 'account:clearLocal': clearLocalAccount(config); await config.save(); return { ok: true };
        case 'account:oauthBegin': {
          if (!provider || !clientId || !redirectUri || !state || !codeChallenge) throw new Error('OAuth params required');
          config.setOAuthClient(provider, clientId); await config.save();
          return { url: buildAuthUrl(provider as OAuthProvider, { clientId, redirectUri, state, codeChallenge }) };
        }
        case 'account:oauthFinish': {
          if (!provider || !code || !codeVerifier || !redirectUri) throw new Error('OAuth finish params required');
          const cid = config.getOAuthClient(provider);
          if (!cid) throw new Error('OAuth client not registered');
          const token = await exchangeCode(provider as OAuthProvider, { clientId: cid, code, codeVerifier, redirectUri });
          config.setOAuth(provider, token.access_token); await config.save();
          return { ok: true };
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
        case 'media:setBackground': config.setMedia({ background: typeof background === 'string' || background === null ? background : config.media.background }); await config.save(); return config.media;
        case 'media:setBgm': config.setMedia({ bgm: typeof bgm === 'string' || bgm === null ? bgm : config.media.bgm }); await config.save(); return config.media;
        // ----- AI agent -----
        case 'agent:compose': return agent.api.compose({ messages: messages as never, task: task as never, ...(typeof system === 'string' ? { system } : {}) });
        case 'agent:illustrate': { if (typeof prompt !== 'string') throw new Error('Prompt required'); return agent.api.illustrate(prompt); }
        case 'agent:layout': return agent.api.layout({ markdown: String(markdown ?? ''), template: (template as never) ?? 'none' });
        // ----- Web / online -----
        case 'web:date': return agent.api.web({ kind: 'date', locale: typeof locale === 'string' ? locale : 'zh-CN' });
        case 'web:weather': return agent.api.web({ kind: 'weather', lat: Number(lat), lon: Number(lon) });
        case 'web:geocode': return agent.api.web({ kind: 'geocode', lat: Number(lat), lon: Number(lon) });
        case 'web:search': return agent.api.web({ kind: 'search', query: typeof query === 'string' ? query : '' });
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
      webPreferences: { preload: join(appDir, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
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
