import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostConfig } from '../src/host/config.ts';
import { importMedia, listMedia, readMediaDataUrl, removeMedia } from '../src/host/media.ts';
import { createLocalAccount, signIn, verifyUserPassword, changeUserPassword, setRecoveryQuestion, recoverPassword, linkGoogleToUser, buildAuthUrl, exchangeCode } from '../src/host/account.ts';
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

test('multi-user accounts: create, unique usernames, sign in and change password', async () => {
  const { config, cleanup } = await tmp();
  try {
    assert.equal(config.hasAnyUser, false);
    const alice = await createLocalAccount(config, { username: 'alice', passcode: 'secret1', displayName: 'Alice' });
    assert.equal(alice.displayName, 'Alice');
    assert.equal(alice.googleId, null);
    // Usernames are unique and case-insensitive.
    await assert.rejects(() => createLocalAccount(config, { username: 'ALICE', passcode: 'secret2' }), /已被占用/);
    const bob = await createLocalAccount(config, { username: 'bob', passcode: 'secret3' });
    assert.notEqual(alice.id, bob.id);
    // Each account verifies only against its own password.
    assert.equal(await verifyUserPassword(config, alice.id, 'secret1'), true);
    assert.equal(await verifyUserPassword(config, alice.id, 'secret3'), false);
    // Sign in by username resolves the right account and sets the session.
    const signed = await signIn(config, 'ALICE', 'secret1', true);
    assert.equal(signed.id, alice.id);
    assert.equal(config.session.userId, alice.id);
    assert.equal(config.session.remember, true);
    // Change password invalidates the old one.
    await changeUserPassword(config, alice.id, 'secret1', 'newpass', 'newpass');
    assert.equal(await verifyUserPassword(config, alice.id, 'secret1'), false);
    assert.equal(await verifyUserPassword(config, alice.id, 'newpass'), true);
  } finally { cleanup(); }
});

test('password recovery via security question', async () => {
  const { config, cleanup } = await tmp();
  try {
    const user = await createLocalAccount(config, { username: 'carol', passcode: 'first123' });
    await assert.rejects(() => recoverPassword(config, user.id, 'anything', 'new12345'), /未设置密保|不正确/);
    await setRecoveryQuestion(config, user.id, '你的第一只宠物叫什么？', '旺财');
    // Wrong answer is rejected.
    await assert.rejects(() => recoverPassword(config, user.id, '不对', 'new12345'), /答案不正确/);
    // Correct answer resets the password.
    await recoverPassword(config, user.id, '旺财', 'new12345');
    assert.equal(await verifyUserPassword(config, user.id, 'new12345'), true);
  } finally { cleanup(); }
});

test('google identity binds one-to-one and imports avatar on first link', async () => {
  const { config, cleanup } = await tmp();
  try {
    const identity = { googleId: 'g@example.com', email: 'g@example.com', name: 'Grace', picture: 'data:image/png;base64,AAA' };
    const user = await linkGoogleToUser(config, identity);
    assert.equal(user.googleId, 'g@example.com');
    // Avatar and display name are carried over from Google.
    assert.equal(user.avatar, 'data:image/png;base64,AAA');
    assert.equal(user.displayName, 'Grace');
    // Re-linking the same Google account reuses the same local account.
    const again = await linkGoogleToUser(config, identity);
    assert.equal(again.id, user.id);
    assert.equal(config.users.length, 1);
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

test('code exchange forwards the client secret and surfaces the provider error body', async () => {
  let seen = '';
  const okFetch = (async (_url, init) => {
    seen = String(init.body);
    return new Response(JSON.stringify({ access_token: 'tok-2' }), { status: 200 });
  });
  await exchangeCode('google', { clientId: 'cid', code: 'c', codeVerifier: 'v', redirectUri: 'http://localhost', clientSecret: 'sec-1' }, okFetch);
  assert.ok(seen.includes('client_secret=sec-1'), 'client_secret must be sent when provided');

  const failFetch = (async () => new Response('{"error":"redirect_uri_mismatch"}', { status: 400 }));
  await assert.rejects(
    () => exchangeCode('google', { clientId: 'cid', code: 'c', codeVerifier: 'v', redirectUri: 'http://localhost' }, failFetch),
    /redirect_uri_mismatch/,
  );
});
