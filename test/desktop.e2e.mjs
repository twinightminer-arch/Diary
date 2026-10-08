import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { resolve, join } from 'node:path';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { launchBrowserHost } from './browser-host.mjs';

test(`${process.env.DIARY_BROWSER_TEST ? 'Browser + real filesystem' : 'Electron'}: CRUD, restart persistence, encryption, preview and languages`, { timeout: 180000 }, async () => {
  await mkdir('work/ui-tests', { recursive: true });
  const home = await mkdtemp(resolve('work/ui-tests/run-'));
  const env = { ...process.env, DIARY_TEST_HOME: home, DIARY_TEST_VAULT: join(home, 'journals') };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.DIARY_EXE || resolve('node_modules/electron/dist/electron.exe');
  const args = process.env.DIARY_EXE ? [] : [resolve('.')];
  // Only the automated test process may opt out when the host cannot nest Chromium sandboxes.
  if (process.env.DIARY_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  let app;
  const errors = [];
  try {
    const launch = () => process.env.DIARY_BROWSER_TEST ? launchBrowserHost(env.DIARY_TEST_VAULT) : electron.launch({ executablePath, args, env, timeout: 30000 });
    app = await launch();
    let page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    const lock = page.locator('#lockScreen');
    let lockShown = false;
    try { await lock.waitFor({ state: 'visible', timeout: 12000 }); lockShown = true; } catch { /* booted straight in */ }
    if (lockShown) {
      try { await page.screenshot({ path: '../releases/Diary-login.png', timeout: 8000 }); } catch { /* screenshot is best-effort */ }
      await expect(page.locator('#offlineCreate')).toBeVisible();
      await expect(page.locator('[data-login-provider="google"]')).toBeVisible();
      await page.locator('#offlineCreate').click();
      await page.locator('[name=username]').fill('lizhonghao');
      await page.locator('[name=next]').fill('local-test-123');
      await page.locator('[name=confirmation]').fill('local-test-123');
      await page.locator('#modalConfirm').click();
      await expect(lock).toBeHidden({ timeout: 15000 });
    }
    // A newly created account must receive the first-run guide. Verify both
    // top-right skip controls exist, then dismiss it so the legacy CRUD flow
    // below can continue and prove no underlying feature regressed.
    await expect(page.locator('.tutorial-layer')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#tutorialSkipModule')).toBeVisible();
    await expect(page.locator('#tutorialSkipAll')).toBeVisible();
    await page.locator('#tutorialSkipAll').click();
    await expect(page.locator('.tutorial-layer')).toBeHidden();
    await page.locator('[data-view="diary"]').first().click();
    await expect(page.locator('#firstEntry')).toBeVisible();
    await page.locator('#firstEntry').click();
    await page.locator('#title').fill('把今天，写进日记');
    await page.locator('#editor').fill('# 九月的最后一天\n\n窗边的光刚刚好，给自己留一点安静的时间。\n\n## 今天的小确幸\n- 读了几页喜欢的书\n- 喝到一杯温热的咖啡\n- 完成了想做的小事\n\n> 不必每一天都特别，但每一天都值得被记住。\n\n**明天，也要好好生活。**');
    await page.locator('#save').click();
    await expect(page.locator('#saveState')).toHaveText('已保存到此设备');
    assert.equal((await readdir(join(home, 'journals'))).filter(name => name.endsWith('.md')).length, 1);
    await page.locator('#previewTab').click();
    await expect(page.locator('#preview h1')).toHaveText('九月的最后一天');
    try { await page.screenshot({ path: '../releases/Diary-preview.png', timeout: 8000 }); } catch { /* screenshot is best-effort */ }
    await page.locator('#editTab').click();
    await page.locator('#encrypt').click();
    await page.locator('[name=next]').fill('diary-test-123');
    await page.locator('[name=confirmation]').fill('diary-test-123');
    await page.locator('#modalConfirm').click();
    await expect(page.locator('#securityBadge')).toHaveText('● 已加密');
    const file = (await readdir(join(home, 'journals'))).find(name => name.endsWith('.md'));
    const raw = await readFile(join(home, 'journals', file), 'utf8');
    assert.ok(raw.startsWith('DIARY-ENC:1\n'));
    assert.ok(!raw.includes('小确幸'));
    await page.locator('#lock').click();
    await expect(page.locator('#workspace')).toBeHidden();
    await app.close();

    app = await launch();
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    const lock2 = page.locator('#lockScreen');
    let lockShown2 = false;
    try { await lock2.waitFor({ state: 'visible', timeout: 12000 }); lockShown2 = true; } catch { /* remembered session skipped the lock */ }
    if (lockShown2) {
      await page.locator('#authUsername').fill('lizhonghao');
      await page.locator('#authPasscode').fill('local-test-123');
      await page.locator('#authSubmit').click();
      await expect(lock2).toBeHidden({ timeout: 15000 });
    }
    await page.locator('[data-view="diary"]').first().click();
    await page.locator('.entry-card').click();
    await page.locator('[name=password]').fill('wrong'); await page.locator('#modalConfirm').click();
    await expect(page.locator('#toast')).toContainText('密码错误');
    await page.locator('.entry-card').click();
    await page.locator('[name=password]').fill('diary-test-123'); await page.locator('#modalConfirm').click();
    await expect(page.locator('#title')).toHaveValue('把今天，写进日记');
    await page.locator('#editor').fill('Updated **Markdown**\n<script>window.injected=true</script>');
    await page.locator('#save').click(); await expect(page.locator('#saveState')).toHaveText('已保存到此设备');
    await page.locator('#previewTab').click();
    await expect(page.locator('#preview strong')).toHaveText('Markdown');
    assert.equal(await page.evaluate(() => window.injected), undefined);
    // Regression: the three-dot menu must dismiss when the user clicks beside
    // it, while remaining fully usable when clicked again.
    await page.locator('#more').click();
    await expect(page.locator('#moreMenu')).toBeVisible();
    await page.locator('#title').click();
    await expect(page.locator('#moreMenu')).toBeHidden();
    await page.locator('#more').click(); await page.locator('#changePassword').click();
    await page.locator('[name=old]').fill('diary-test-123'); await page.locator('[name=next]').fill('diary-test-456');
    await page.locator('[name=confirmation]').fill('diary-test-456'); await page.locator('#modalConfirm').click();
    await expect(page.locator('#toast')).toHaveText('操作完成');
    await page.locator('#settings').click(); await page.locator('.settings-tabs button[data-tab="lang"]').click(); await page.locator('#cfgLocale').selectOption('en-US');
    await expect(page.locator('#save')).toHaveText('Save');
    await page.locator('#settingsClose').click();
    for (const view of ['home','chat','search-view','competition','guide','diary','home','diary']) await page.locator(`#primaryNav [data-view="${view}"]`).click();
    await expect(page.locator('#diaryView')).toBeVisible();
    await page.locator('#theme').click(); await expect(page.locator('body')).toHaveClass('dark');
    await page.locator('#more').click(); await page.locator('#delete').click(); await page.locator('#modalConfirm').click();
    await expect(page.locator('.entry-card')).toHaveCount(0);
    assert.equal((await readdir(join(home, 'journals'))).filter(name => name.endsWith('.md')).length, 0);
    assert.deepEqual(errors, []);
    await writeFile(join(home, 'test-result.json'), JSON.stringify({ ok: true, executablePath, errors }, null, 2));
  } finally { if (app) await app.close(); }
});
