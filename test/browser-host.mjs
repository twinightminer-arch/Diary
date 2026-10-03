import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { MarkdownEngine } from '../src/storage/markdown-engine.ts';

export async function launchBrowserHost(directory) {
  const engine = await MarkdownEngine.open(directory);
  const root = resolve('dist/web');
  const server = createServer(async (request, response) => {
    try {
      const name = new URL(request.url, 'http://localhost').pathname;
      const file = resolve(root, '.' + (name === '/' ? '/index.html' : name));
      if (!file.startsWith(root + '\\')) throw Error('Invalid path');
      response.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' }[extname(file)] || 'text/plain');
      response.end(await readFile(file));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  await page.exposeBinding('hostCall', async (_source, request) => {
    const { op, id, document, passcode, next, confirmation } = request;
    switch (op) {
      case 'list': return engine.listEntries();
      case 'read': return engine.readEntry(id, passcode);
      case 'create': return engine.createEntry(id, document, passcode);
      case 'update': return engine.updateEntry(id, document, passcode);
      case 'delete': return engine.deleteEntry(id, passcode);
      case 'encrypt': return engine.encryptEntry(id, passcode, confirmation);
      case 'decrypt': return engine.decryptEntry(id, passcode);
      case 'changePasscode': return engine.changeEntryPasscode(id, passcode, next, confirmation);
      case 'info': return { location: directory };
      case 'config:get': return { activeProvider: 'openai', providers: [{ id: 'openai', baseUrl: '', model: '', hasKey: false }], profile: { username: '', avatar: null, signature: '' }, media: { background: null, bgm: null }, hasLocalAccount: false, oauthClients: {} };
      case 'media:list': return [];
      default: throw Error('Unsupported test action');
    }
  });
  await page.addInitScript(() => { window.diary = { platform: 'browser-test', call: request => window.hostCall(request) }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  return {
    firstWindow: async () => page,
    close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); },
  };
}
