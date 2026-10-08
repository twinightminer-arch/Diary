import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

test('AI search history restores answers and sources, including after reload and for legacy records', { timeout: 30000 }, async () => {
  const root = resolve('dist/web');
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://localhost').pathname;
      const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
      if (!file.startsWith(root + '\\')) throw Error('Invalid path');
      response.setHeader('Content-Type', { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' }[extname(file)] ?? 'text/plain');
      response.end(await readFile(file));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    await page.addInitScript(() => {
      window.diary = { platform: 'browser-test', call: async request => {
        switch (request.op) {
          case 'config:get': return { activeProvider: 'openai', providers: [{ id: 'openai', baseUrl: 'https://example.test/v1', model: 'test', hasKey: true }], users: [], currentUser: null, remember: false, profile: { username: '', avatar: null, signature: '' }, media: { background: null, bgm: null }, oauthClients: {} };
          case 'list': case 'sources:list': case 'media:list': return [];
          case 'agent:compose': return '申请材料可在官网查询。\n\n来源：https://example.edu/notice';
          default: return null;
        }
      } };
    });
    const url = `http://127.0.0.1:${server.address().port}/index.html`;
    const unlock = async () => page.locator('#lockScreen').evaluate(element => { element.hidden = true; element.style.display = 'none'; });
    await page.goto(url);
    await unlock();
    await page.locator('#primaryNav [data-view="search-view"]').click();
    await page.locator('#portalSearchInput').fill('奖学金申请材料');
    await page.locator('#portalSearchButton').click();
    await page.getByText('申请材料可在官网查询。').waitFor();
    assert.match(await page.locator('#portalSearchSources').innerText(), /example\.edu\/notice/);

    await page.locator('#primaryNav [data-view="home"]').click();
    await page.locator('.recent-item').filter({ hasText: '奖学金申请材料' }).click();
    assert.equal(await page.locator('#portalSearchInput').inputValue(), '奖学金申请材料');
    assert.match(await page.locator('#portalSearchResult').innerText(), /申请材料可在官网查询/);

    await page.reload();
    await unlock();
    await page.locator('.recent-item').filter({ hasText: '奖学金申请材料' }).click();
    assert.match(await page.locator('#portalSearchResult').innerText(), /申请材料可在官网查询/);
    assert.match(await page.locator('#portalSearchSources').innerText(), /example\.edu\/notice/);
    await page.setViewportSize({ width: 390, height: 780 });
    const answer = await page.locator('#portalSearchResult').boundingBox();
    const sources = await page.locator('.result-sources').boundingBox();
    assert.ok(answer && sources && sources.y >= answer.y + answer.height, 'sources should stack below the answer on mobile');

    await page.evaluate(() => localStorage.setItem('diary.portal.recent', JSON.stringify([{ text: '旧问题', kind: 'search-view', at: Date.now() }])));
    await page.reload();
    await unlock();
    await page.locator('.recent-item').filter({ hasText: '旧问题' }).click();
    assert.equal(await page.locator('#portalSearchInput').inputValue(), '旧问题');
    assert.match(await page.locator('#portalSearchResult').innerText(), /旧记录未保存回答和来源/);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
