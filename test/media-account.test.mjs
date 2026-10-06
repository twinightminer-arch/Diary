import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostConfig } from '../src/host/config.ts';
import { importMedia, listMedia, readMediaDataUrl, removeMedia } from '../src/host/media.ts';
import { setLocalPasscode, verifyLocalPasscode, hasLocalAccount, clearLocalAccount, buildAuthUrl, exchangeCode } from '../src/host/account.ts';

async function tmp() {
  const root = await mkdtemp(join(tmpdir(), 'diary-ma-'));
  const config = await HostConfig.open(root);
  return { root, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('media import, list, data-url and removal', async () => {
  const { root, cleanup } = await tmp();
  try {
    const info = await importMedia(root, new Uint8Array([1, 2, 3, 4]), 'cat.png', 'image/png');
    assert.match(info.id, /\.png$/);
    assert.equal(info.mime, 'image/png');
    const listed = await listMedia(root);
    assert.equal(listed.length, 1);
    const url = await readMediaDataUrl(root, info.id);
    assert.ok(url.startsWith('data:image/png;base64,'));
    await removeMedia(root, info.id);
    assert.equal((await listMedia(root)).length, 0);
  } finally { cleanup(); }
});

test('media rejects unsupported mime and oversized payload', async () => {
  const { root, cleanup } = await tmp();
  try {
    await assert.rejects(() => importMedia(root, new Uint8Array([1]), 'x.txt', 'text/plain'));
    const huge = new Uint8Array(201 * 1024 * 1024).fill(1);
    await assert.rejects(() => importMedia(root, huge, 'big.mp4', 'video/mp4'));
  } finally { cleanup(); }
});

test('local account passcode set/verify/clear', async () => {
  const { config, cleanup } = await tmp();
  try {
    assert.equal(hasLocalAccount(config), false);
    await assert.rejects(() => setLocalPasscode(config, '123'));
    await setLocalPasscode(config, 'secret');
    assert.equal(hasLocalAccount(config), true);
    assert.equal(await verifyLocalPasscode(config, 'secret'), true);
    assert.equal(await verifyLocalPasscode(config, 'wrong'), false);
    clearLocalAccount(config);
    assert.equal(hasLocalAccount(config), false);
  } finally { cleanup(); }
});

test('OAuth auth URL carries PKCE params; code exchange returns token', async () => {
  const url = buildAuthUrl('google', { clientId: 'cid', redirectUri: 'http://localhost', state: 's', codeChallenge: 'cc' });
  assert.ok(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?'));
  assert.ok(url.includes('code_challenge=cc') && url.includes('code_challenge_method=S256'));
  const fetchImpl = (async () => new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 }));
  const token = await exchangeCode('google', { clientId: 'cid', code: 'c', codeVerifier: 'v', redirectUri: 'http://localhost' }, fetchImpl);
  assert.equal(token.access_token, 'tok-1');
});
