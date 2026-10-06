// Capture real Electron screenshots of the Diary lock screen and the
// QQ-style profile page. Uses webContents.capturePage() so it never blocks on
// document.fonts.ready the way page.screenshot() does.
import { _electron as electron } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';

await mkdir('work/shots', { recursive: true });
const home = await mkdtemp(resolve('work/shots/run-'));
const env = { ...process.env, DIARY_TEST_HOME: home, DIARY_TEST_VAULT: resolve(home, 'journals') };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: resolve('node_modules/electron/dist/electron.exe'),
  args: ['--no-sandbox', resolve('.')],
  env,
  timeout: 30000,
});

async function shot(page, path) {
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return (await win.webContents.capturePage()).toPNG().toString('base64');
  });
  await writeFile(path, Buffer.from(b64, 'base64'));
  console.log('saved', path);
}

try {
  const page = await app.firstWindow();
  await page.locator('#lockScreen').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(1200);
  console.log('lock screen:', JSON.stringify({
    lockScreen: await page.locator('#lockScreen').isVisible(),
    google: await page.locator('[data-login-provider="google"]').isVisible(),
    offlineCreate: await page.locator('#offlineCreate').isVisible(),
  }));
  await shot(page, '../releases/Diary-login.png');

  // Create an offline account (this is the flow the user reported as broken).
  await page.locator('#offlineCreate').click();
  await page.locator('[name=username]').fill('lizhonghao');
  await page.locator('[name=nickname]').fill('李忠浩');
  await page.locator('[name=next]').fill('diary-pass-123');
  await page.locator('[name=confirmation]').fill('diary-pass-123');
  await page.locator('#modalConfirm').click();
  await page.locator('#lockScreen').waitFor({ state: 'hidden', timeout: 20000 });
  console.log('offline account created and lock released');

  // QQ-style profile page.
  await page.locator('#settings').click();
  await page.locator('.settings-tabs button[data-tab="profile"]').click();
  await page.waitForTimeout(1200);
  console.log('profile card:', JSON.stringify({
    name: await page.locator('#profileCardName').textContent(),
    username: await page.locator('#profileCardUsername').textContent(),
  }));
  await shot(page, '../releases/Diary-profile.png');
} finally {
  await app.close();
}
