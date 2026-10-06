// One-off repair: merge the auto-created Google account into the existing
// offline account, and cache the Google avatar as a data URL (the CSP blocks
// remote images). Uses Electron's network stack so the proxy is honoured.
import { _electron as electron } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile, copyFile } from 'node:fs/promises';

const CONFIG = 'C:\\Users\\李忠浩\\AppData\\Roaming\\Diary\\config.json';
const PICTURE = 'https://lh3.googleusercontent.com/a/ACg8ocJrLbxlDcMJ59BW248QbEgvUoEE8_IOVp0Ix3wlWbjOVPpkyuc=s96-c';

await mkdir('work/probe', { recursive: true });
const home = await mkdtemp(resolve('work/probe/run-'));
const env = { ...process.env, DIARY_TEST_HOME: home, DIARY_TEST_VAULT: resolve(home, 'journals') };
delete env.ELECTRON_RUN_AS_NODE;

// 1) fetch the avatar through the app's own network stack
const app = await electron.launch({
  executablePath: resolve('node_modules/electron/dist/electron.exe'),
  args: ['--no-sandbox', resolve('.')],
  env,
  timeout: 30000,
});
let avatar = null;
try {
  avatar = await app.evaluate(async ({ net }, picture) => {
    try {
      const response = await net.fetch(picture, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) return { error: `HTTP ${response.status}` };
      const mime = (response.headers.get('content-type') ?? 'image/png').split(';')[0];
      const bytes = Buffer.from(await response.arrayBuffer());
      return { mime, size: bytes.byteLength, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
    } catch (error) { return { error: String(error) }; }
  }, PICTURE);
} finally { await app.close(); }
console.log('avatar fetch:', avatar?.error ? avatar.error : `${avatar.size}B ${avatar.mime}`);

// 2) merge the duplicate account
const raw = await readFile(CONFIG, 'utf8');
await copyFile(CONFIG, CONFIG + '.before-merge.bak');
const config = JSON.parse(raw);
const users = config.account.users;
const offline = users.find(u => !u.googleId);
const linked = users.find(u => u.googleId);
console.log('before:', users.map(u => `${u.id}/${u.username}/google=${u.googleId ?? '-'}`).join(' | '));

if (offline && linked && offline.id !== linked.id) {
  offline.googleId = linked.googleId;
  offline.googleEmail = linked.googleEmail;
  if (avatar?.dataUrl) offline.avatar = avatar.dataUrl;
  config.account.users = users.filter(u => u.id !== linked.id);
  config.account.session = { userId: offline.id, remember: false };
  config.profile.username = linked.displayName || config.profile.username;
  if (avatar?.dataUrl) config.profile.avatar = avatar.dataUrl;
  await writeFile(CONFIG, JSON.stringify(config, null, 2) + '\n');
  console.log('merged -> kept', offline.id, '| removed', linked.id);
} else {
  console.log('no duplicate account found; nothing merged');
}

const after = JSON.parse(await readFile(CONFIG, 'utf8'));
console.log('after:', after.account.users.map(u => `${u.id}/${u.username}/google=${u.googleId ?? '-'}/avatar=${u.avatar ? u.avatar.slice(0, 24) + '…' : 'none'}`).join(' | '));
console.log('session:', JSON.stringify(after.account.session));
console.log('profile:', after.profile.username, '|', after.profile.avatar ? after.profile.avatar.slice(0, 30) + '…' : 'none');
