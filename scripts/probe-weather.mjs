// Minimal reproduction of the permission -> weather chain, so a failure points
// at exactly one hop instead of the whole shell.
import { _electron as electron } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';

const home = await mkdtemp(resolve('work/weather-'));
const env = { ...process.env, DIARY_TEST_HOME: home, DIARY_TEST_VAULT: resolve(home, 'journals') };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: resolve('node_modules/electron/dist/electron.exe'),
  args: ['--no-sandbox', resolve('.')],
  env,
  timeout: 90000,
});

try {
  const page = await app.firstWindow();
  await page.locator('#lockScreen').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#offlineCreate').click();
  await page.locator('[name=username]').fill('probe');
  await page.locator('[name=nickname]').fill('探针');
  await page.locator('[name=next]').fill('diary-pass-123');
  await page.locator('[name=confirmation]').fill('diary-pass-123');
  await page.locator('#modalConfirm').click();
  await page.locator('#lockScreen').waitFor({ state: 'hidden', timeout: 20000 });

  const trace = await page.evaluate(async () => {
    const steps = [];
    const get = async (op, extra = {}) => {
      try { const value = await window.diary.call({ op, ...extra }); steps.push({ op, value }); return value; }
      catch (error) { steps.push({ op, error: String(error) }); return null; }
    };
    await get('config:get');
    await get('permission:set', { network: true, location: false });
    const cfg = await get('config:get');
    await get('location:set', { mode: 'manual', lat: 39.9042, lon: 116.4074, label: '北京' });
    const report = await get('weather:now');
    return { permissions: cfg?.permissions, report };
  });
  console.log(JSON.stringify(trace, null, 1));

  // The offline card's 重试 button is exactly the path a real user takes.
  await page.locator('#heroWeather button', { hasText: '重试' }).click();
  await page.waitForTimeout(9000);
  console.log('panel:', JSON.stringify(await page.evaluate(() => {
    const card = document.querySelector('#heroWeather .weather-card');
    if (!card) return null;
    return {
      cls: card.className,
      place: card.querySelector('.weather-place')?.textContent,
      temp: card.querySelector('.weather-temp')?.textContent,
      desc: card.querySelector('.weather-desc')?.textContent,
      metrics: [...card.querySelectorAll('.weather-metric')].map(el => `${el.querySelector('small')?.textContent}=${el.querySelector('b')?.textContent}`),
      air: card.querySelector('.weather-air')?.textContent.replace(/\s+/g, ' ').trim(),
      foot: card.querySelector('.weather-foot')?.textContent,
    };
  }), null, 1));

  // Right-click -> import into the diary.
  await page.locator('#heroWeather .weather-card').click({ button: 'right' });
  await page.waitForTimeout(400);
  console.log('menu:', JSON.stringify(await page.evaluate(() => ({
    open: Boolean(document.getElementById('weatherMenu')),
    items: [...document.querySelectorAll('#weatherMenu button')].map(el => el.textContent),
  }))));
  await page.locator('#weatherMenu button', { hasText: '新建一篇天气日记' }).click();
  await page.waitForTimeout(1500);
  console.log('diary after import:', JSON.stringify(await page.evaluate(() => ({
    toast: document.getElementById('toast')?.textContent,
    entryCount: document.getElementById('entryCount')?.textContent,
  }))));
  const entry = await page.evaluate(async () => {
    const list = await window.diary.call({ op: 'list' });
    const target = list.find(item => String(item.id).includes('天气'));
    if (!target) return { ids: list.map(item => item.id) };
    const body = await window.diary.call({ op: 'read', id: target.id });
    return { id: target.id, head: String(body.body).slice(0, 260) };
  });
  console.log('stored entry:', JSON.stringify(entry, null, 1));
} finally {
  await app.close();
}
