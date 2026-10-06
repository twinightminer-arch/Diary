// SPDX-License-Identifier: AGPL-3.0-only
import { readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { join } from 'node:path';
import { encryptBatch, decryptBatch, changeBatchPasscode, type MarkdownFile, type BatchResult } from '../security/encryption.ts';

const ID = /^[\p{L}\p{N}_-][\p{L}\p{N}_ .-]{0,99}$/u;
function validate(ids: readonly string[]): void {
  for (const id of ids) if (!ID.test(id) || /[. ]$/.test(id)) throw new TypeError(`Invalid entry id: ${id}`);
}

async function readEntries(vault: string, ids: readonly string[]): Promise<MarkdownFile[]> {
  validate(ids);
  return Promise.all(ids.map(async id => ({ name: `${id}.md`, content: await readFile(join(vault, `${id}.md`), 'utf8') })));
}
async function writeBack(vault: string, results: readonly BatchResult[]): Promise<void> {
  for (const result of results) {
    if (!result.ok) continue;
    const target = join(vault, result.name);
    const temp = join(vault, `.diary-${crypto.randomUUID()}.tmp`);
    const file = await open(temp, 'w', 0o600);
    try {
      await file.writeFile(result.content, 'utf8');
      await file.sync();
      await file.close();
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }
}

/** Host-only. Encrypt many entries at once; returns per-file success/failure. */
export async function batchEncrypt(vault: string, ids: readonly string[], passcode: string): Promise<BatchResult[]> {
  const files = await readEntries(vault, ids);
  const results = await encryptBatch(files, passcode);
  await writeBack(vault, results);
  return results;
}
export async function batchDecrypt(vault: string, ids: readonly string[], passcode: string): Promise<BatchResult[]> {
  const files = await readEntries(vault, ids);
  const results = await decryptBatch(files, passcode);
  await writeBack(vault, results);
  return results;
}
export async function batchChangePasscode(
  vault: string, ids: readonly string[], oldPasscode: string, next: string, confirmation: string,
): Promise<BatchResult[]> {
  const files = await readEntries(vault, ids);
  const results = await changeBatchPasscode(files, oldPasscode, next, confirmation);
  await writeBack(vault, results);
  return results;
}
