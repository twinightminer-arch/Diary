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

test('oauth tokens and media preferences round-trip through reload', async () => {
  const { root, config, cleanup } = await fresh();
  try {
    config.setOAuth('google', 'tok-abc');
    config.setMedia({ background: 'bg-1', bgm: 'bgm-2' });
    await config.save();
    const reloaded = await HostConfig.open(root);
    assert.equal(reloaded.getOAuth('google'), 'tok-abc');
    assert.equal(reloaded.getOAuth('microsoft'), null);
    assert.equal(reloaded.media.background, 'bg-1');
    assert.equal(reloaded.media.bgm, 'bgm-2');
  } finally { cleanup(); }
});
