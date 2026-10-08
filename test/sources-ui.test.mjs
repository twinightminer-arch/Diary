import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

test('imported source is cited in chat and disappears after deletion', { timeout: 30000 }, async () => {
  const root = resolve('dist/web');
  const server = createServer(async (request, response) => {
    const file = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname);
    if (!file.startsWith(root + '\\')) { response.writeHead(404).end(); return; }
    try {
      response.setHeader('Content-Type', { '.mjs': 'application/javascript', '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(file)] ?? 'application/octet-stream');
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    page.on('dialog', dialog => dialog.accept());
    await page.addInitScript(() => {
      const data = btoa(unescape(encodeURIComponent('缓考申请必须提交医院证明。')));
      window.schoolTest = { sources: [], questions: [] };
      window.diary = { platform: 'browser-test', call: async request => {
        const state = window.schoolTest;
        switch (request.op) {
          case 'config:get': return { activeProvider: 'openai', providers: [{ id: 'openai', baseUrl: 'https://example.test/v1', model: 'test', hasKey: true }], users: [], currentUser: null, remember: false, profile: { username: '', avatar: null, signature: '' }, media: { background: null, bgm: null }, oauthClients: {} };
          case 'list': return [];
          case 'sources:list': return state.sources;
          case 'sources:pick': return { name: '缓考规定.txt', data };
          case 'sources:save': state.sources = [request.source]; return request.source;
          case 'sources:delete': state.sources = state.sources.filter(source => source.id !== request.id); return { ok: true };
          case 'agent:compose': state.questions.push(request); return request.messages[1].content.includes('[资料1]') ? '缓考需要医院证明。[资料1]' : '请咨询教务处。';
          default: return null;
        }
      } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.locator('#lockScreen').evaluate(element => { element.hidden = true; element.style.display = 'none'; });
    await page.locator('#primaryNav [data-view="chat"]').click();
    await page.locator('#schoolDepartment').fill('教务处');
    await page.locator('#schoolImport').click();
    await page.locator('.school-source-row strong').waitFor();
    await page.locator('#portalPrompt').fill('缓考需要什么证明？');
    await page.locator('#portalSend').click();
    await page.getByText('缓考需要医院证明。[资料1]').waitFor();
    assert.match(await page.locator('#schoolEvidence').innerText(), /缓考规定.txt/);
    await page.locator('.school-source-row button[title^="删除"]').click();
    await page.locator('#portalPrompt').fill('缓考需要什么证明？');
    await page.locator('#portalSend').click();
    await page.getByText(/本地资料中未找到相关内容。以下仅供一般参考/).waitFor();
    const requests = await page.evaluate(() => window.schoolTest.questions);
    assert.match(requests[0].messages[1].content, /医院证明/);
    assert.doesNotMatch(requests[1].messages[1].content, /医院证明/);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
