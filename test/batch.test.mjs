import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchEncrypt, batchDecrypt, batchChangePasscode } from '../src/host/batch.ts';
import { isEncrypted, decryptContent } from '../src/security/encryption.ts';

async function vault() {
  const root = await mkdtemp(join(tmpdir(), 'diary-batch-'));
  await writeFile(join(root, '2026-01-01.md'), '---\ntitle: "A"\n---\n早上好。', 'utf8');
  await writeFile(join(root, '2026-01-02.md'), '---\ntitle: "B"\n---\n下午好。', 'utf8');
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('batch encrypt then decrypt round-trips content', async () => {
  const { root, cleanup } = await vault();
  try {
    const enc = await batchEncrypt(root, ['2026-01-01', '2026-01-02'], 'pw-12345');
    assert.equal(enc.length, 2);
    assert.ok(enc.every(r => r.ok));
    const cipher = await readFile(join(root, '2026-01-01.md'), 'utf8');
    assert.ok(isEncrypted(cipher));
    // Manually decrypt the still-encrypted file before the batch decrypt rewrites it.
    const text = await decryptContent(cipher, 'pw-12345');
    assert.ok(text.includes('早上好'));
    const dec = await batchDecrypt(root, ['2026-01-01', '2026-01-02'], 'pw-12345');
    assert.ok(dec.every(r => r.ok));
    assert.ok(!isEncrypted(await readFile(join(root, '2026-01-01.md'), 'utf8')));
  } finally { cleanup(); }
});

test('batch change passcode and reject wrong old passcode', async () => {
  const { root, cleanup } = await vault();
  try {
    await batchEncrypt(root, ['2026-01-01'], 'old-pw-1');
    const ok = await batchChangePasscode(root, ['2026-01-01'], 'old-pw-1', 'new-pw-2', 'new-pw-2');
    assert.ok(ok[0].ok);
    const fail = await batchChangePasscode(root, ['2026-01-01'], 'wrong', 'x-3', 'x-3');
    assert.equal(fail[0].ok, false);
  } finally { cleanup(); }
});

test('batch skips invalid ids', async () => {
  const { root, cleanup } = await vault();
  try {
    await assert.rejects(() => batchEncrypt(root, ['../escape'], 'pw'));
  } finally { cleanup(); }
});
