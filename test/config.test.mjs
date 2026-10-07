import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostConfig } from '../src/host/config.ts';

async function fresh() {
  const root = await mkdtemp(join(tmpdir(), 'diary-cfg-'));
  const config = await HostConfig.open(root);
  return { root, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('device key and config persist across reloads; secrets stay encrypted at rest', async () => {
  const { root, config, cleanup } = await fresh();
  try {
    await config.setSecret('openai', 'sk-secret-123');
    config.activeProvider = 'deepseek';
    config.setProvider('openai', { model: 'gpt-4o' });
    config.setProfile({ username: 'Li', signature: 'hello' });
    await config.save();
    const onDisk = await readFile(join(root, 'config.json'), 'utf8');
    assert.ok(!onDisk.includes('sk-secret-123'), 'API key must not be stored in plaintext');
    assert.ok(/v1:/.test(onDisk), 'secret envelope expected on disk');
    const reloaded = await HostConfig.open(root);
    assert.equal(await reloaded.getSecret('openai'), 'sk-secret-123');
    assert.equal(reloaded.activeProvider, 'deepseek');
    assert.equal(reloaded.getProvider('openai').model, 'gpt-4o');
    assert.equal(reloaded.profile.username, 'Li');
  } finally { cleanup(); }
});

test('unknown provider cannot be selected; missing secret returns null', async () => {
  const { config, cleanup } = await fresh();
  try {
    assert.throws(() => { config.activeProvider = 'nope'; });
    assert.equal(await config.getSecret('missing'), null);
  } finally { cleanup(); }
});

test('oauth tokens, google identity and media preferences round-trip through reload', async () => {
  const { root, config, cleanup } = await fresh();
  try {
    config.setToken('google', { accessToken: 'tok-abc', linkedUserId: 'u-1' });
    config.setGoogle({ googleId: 'g@x.com', email: 'g@x.com', name: 'G User', picture: null });
    config.setBackground({ kind: 'image', media: 'bg-1', dim: 0.25, blur: 6 });
    config.setMedia({ bgm: 'bgm-2' });
    await config.save();
    const reloaded = await HostConfig.open(root);
    assert.equal(reloaded.getToken('google')?.accessToken, 'tok-abc');
    assert.equal(reloaded.getToken('google')?.linkedUserId, 'u-1');
    assert.equal(reloaded.getToken('microsoft'), null);
    // Google identity is stored separately from the access token.
    assert.equal(reloaded.google?.email, 'g@x.com');
    assert.equal(reloaded.google?.name, 'G User');
    assert.equal(reloaded.media.background.kind, 'image');
    assert.equal(reloaded.media.background.media, 'bg-1');
    assert.equal(reloaded.media.background.dim, 0.25);
    assert.equal(reloaded.media.background.blur, 6);
    assert.equal(reloaded.media.bgm, 'bgm-2');
  } finally { cleanup(); }
});

test('network and location stay off until the user opts in', async () => {
  const { root, config, cleanup } = await fresh();
  try {
    assert.equal(config.permissions.network, false);
    assert.equal(config.permissions.location, false);
    config.setPermissions({ network: true });
    await config.save();
    const reloaded = await HostConfig.open(root);
    assert.equal(reloaded.permissions.network, true);
    assert.equal(reloaded.permissions.location, false);
  } finally { cleanup(); }
});

test('built-in plugins are enabled by default and can be switched off', async () => {
  const { root, config, cleanup } = await fresh();
  try {
    assert.equal(config.isPluginEnabled('wallpaper'), true);
    config.setPluginEnabled('wallpaper', false);
    await config.save();
    const reloaded = await HostConfig.open(root);
    assert.equal(reloaded.isPluginEnabled('wallpaper'), false);
    assert.equal(reloaded.isPluginEnabled('weather'), true);
  } finally { cleanup(); }
});

test('the flat pre-plugin background value migrates into the new shape', async () => {
  const { root, config, cleanup } = await fresh();
  try {
    config.setMedia({ background: 'legacy-bg' });
    await config.save();
    const reloaded = await HostConfig.open(root);
    assert.equal(reloaded.media.background.kind, 'image');
    assert.equal(reloaded.media.background.media, 'legacy-bg');
    // 默认「完整显示」：原画质、不裁切、不放大。
    assert.equal(reloaded.media.background.fit, 'contain');
    // 迁移出来的配置必须带上新的可读性字段，否则面板会拿到 undefined。
    assert.equal(reloaded.media.chrome.fontCustom, false);
    assert.equal(reloaded.media.chrome.fontSize, 15);
    assert.equal(reloaded.media.chrome.topbarColor, '');
  } finally { cleanup(); }
});

test('chrome settings round-trip and reject malformed values', async () => {
  const { root, config, cleanup } = await fresh();
  try {
    config.setChrome({ fontCustom: true, fontColor: '#FF8800', fontSize: 19, topbarColor: '#101a31' });
    await config.save();
    const reloaded = await HostConfig.open(root);
    assert.equal(reloaded.media.chrome.fontCustom, true);
    // 颜色统一小写，方便前端直接比较。
    assert.equal(reloaded.media.chrome.fontColor, '#ff8800');
    assert.equal(reloaded.media.chrome.fontSize, 19);
    assert.equal(reloaded.media.chrome.topbarColor, '#101a31');

    // 非法颜色 / 越界字号必须被消毒，坏值不能落盘。
    reloaded.setChrome({ fontColor: 'red', fontSize: 999, topbarColor: 'not-a-colour' });
    assert.equal(reloaded.media.chrome.fontColor, '#20283a');
    assert.equal(reloaded.media.chrome.fontSize, 24);
    assert.equal(reloaded.media.chrome.topbarColor, '');

    // 空串顶栏 = 跟随主题，是合法状态，不能被当成坏值。
    reloaded.setChrome({ topbarColor: '' });
    assert.equal(reloaded.media.chrome.topbarColor, '');
  } finally { cleanup(); }
});
