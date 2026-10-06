// SPDX-License-Identifier: AGPL-3.0-only
import { constants } from 'node:fs';
import { mkdir, realpath, lstat, open, link, rename, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { changePasscode, decryptContent, encryptContent, isEncrypted } from '../security/encryption.ts';

import { parseMarkdown, serializeMarkdown } from './markdown.ts';
import type { MarkdownDocument } from './markdown.ts';
export { parseMarkdown, serializeMarkdown } from './markdown.ts';
export type { Metadata, MarkdownDocument } from './markdown.ts';
export interface Entry extends MarkdownDocument { id: string; encrypted: boolean }
export interface EntrySummary { id: string; encrypted: boolean }
function filename(id: string): string {
  if (!/^[\p{L}\p{N}_-][\p{L}\p{N}_ .-]{0,99}$/u.test(id) || /[. ]$/.test(id) ||
      /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(id)) throw new TypeError('Invalid entry id');
  return `${id}.md`;
}

/** Node/Electron host only. One instance owns a private vault; external writers need host coordination. */
export class MarkdownEngine {
  #root: string;
  #queue: Promise<unknown> = Promise.resolve();
  private constructor(root: string) { this.#root = root; }
  static async open(directory: string): Promise<MarkdownEngine> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('Vault cannot be a symbolic link');
    return new MarkdownEngine(await realpath(directory));
  }
  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }
  async #read(id: string): Promise<string> {
    const path = join(this.#root, filename(id));
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Entry must be a regular file');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await file.stat()).isFile()) throw new Error('Entry must be a regular file');
      return await file.readFile('utf8');
    } finally { await file.close(); }
  }
  async #write(id: string, content: string, create = false): Promise<void> {
    const target = join(this.#root, filename(id));
    const temp = join(this.#root, `.diary-${crypto.randomUUID()}.tmp`);
    const file = await open(temp, 'wx', 0o600);
    try {
      try { await file.writeFile(content, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      if (create) await link(temp, target); // Atomic create, never overwrite an existing entry.
      else await rename(temp, target);
    } finally {
      await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async #decode(id: string, content: string, passcode?: string): Promise<Entry> {
    const encrypted = isEncrypted(content);
    if (encrypted && passcode === undefined) throw new Error('Passcode required');
    return { id, encrypted, ...parseMarkdown(encrypted ? await decryptContent(content, passcode!) : content) };
  }
  createEntry(id: string, document: MarkdownDocument, passcode?: string): Promise<Entry> {
    const source = serializeMarkdown(document);
    return this.#serial(async () => {
      const content = passcode === undefined ? source : await encryptContent(source, passcode);
      await this.#write(id, content, true);
      return { id, encrypted: passcode !== undefined, ...parseMarkdown(source) };
    });
  }
  readEntry(id: string, passcode?: string): Promise<Entry> {
    return this.#serial(async () => this.#decode(id, await this.#read(id), passcode));
  }
  updateEntry(id: string, patch: Partial<MarkdownDocument>, passcode?: string): Promise<Entry> {
    // Snapshot agent input before queued work; metadata replaces the entire previous map.
    const snapshot = structuredClone(patch);
    return this.#serial(async () => {
      const current = await this.#decode(id, await this.#read(id), passcode);
      const source = serializeMarkdown({ metadata: snapshot.metadata ?? current.metadata, body: snapshot.body ?? current.body });
      await this.#write(id, current.encrypted ? await encryptContent(source, passcode!) : source);
      return { id, encrypted: current.encrypted, ...parseMarkdown(source) };
    });
  }
  deleteEntry(id: string, passcode?: string): Promise<void> {
    return this.#serial(async () => {
      const content = await this.#read(id);
      if (isEncrypted(content)) {
        if (passcode === undefined) throw new Error('Passcode required');
        await decryptContent(content, passcode);
      }
      await unlink(join(this.#root, filename(id)));
    });
  }
  listEntries(): Promise<EntrySummary[]> {
    return this.#serial(async () => {
      const results: EntrySummary[] = [];
      for (const item of await readdir(this.#root, { withFileTypes: true })) {
        if (!item.isFile() || !item.name.endsWith('.md')) continue;
        const id = item.name.slice(0, -3);
        filename(id);
        results.push({ id, encrypted: isEncrypted(await this.#read(id)) });
      }
      return results.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  }
  encryptEntry(id: string, passcode: string, confirmation: string): Promise<void> {
    return this.#serial(async () => {
      if (passcode !== confirmation) throw new Error('Passcode confirmation mismatch');
      const source = await this.#read(id);
      if (isEncrypted(source)) throw new Error('Entry is already encrypted');
      await this.#write(id, await encryptContent(source, passcode));
    });
  }
  decryptEntry(id: string, passcode: string): Promise<void> {
    return this.#serial(async () => this.#write(id, await decryptContent(await this.#read(id), passcode)));
  }
  changeEntryPasscode(id: string, oldPasscode: string, next: string, confirmation: string): Promise<void> {
    return this.#serial(async () => this.#write(id, await changePasscode(await this.#read(id), oldPasscode, next, confirmation)));
  }
}
