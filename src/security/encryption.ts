// SPDX-License-Identifier: AGPL-3.0-only
const PREFIX = 'DIARY-ENC:';
const VERSION = `${PREFIX}1\n`;
const ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
type Envelope = { iterations: number; salt: string; iv: string; data: string };

export class DecryptionError extends Error {
  constructor() { super('Invalid passcode or damaged encrypted content'); this.name = 'DecryptionError'; }
}
export function isEncrypted(content: string): boolean { return content.startsWith(PREFIX); }
function passcodeBytes(passcode: string): Uint8Array<ArrayBuffer> {
  if (typeof passcode !== 'string' || passcode.length === 0 || passcode.length > 1024) {
    throw new TypeError('Passcode must contain 1–1024 characters');
  }
  return encoder.encode(passcode);
}
function base64(value: ArrayBuffer | Uint8Array<ArrayBuffer>): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
function unbase64(value: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new TypeError('Invalid base64');
  }
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}
async function derive(passcode: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<CryptoKey> {
  const bytes = passcodeBytes(passcode);
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  } finally { bytes.fill(0); }
}
function aad(envelope: Omit<Envelope, 'data'>): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(['Diary', 1, 'AES-256-GCM', 'PBKDF2-SHA256',
    envelope.iterations, envelope.salt, envelope.iv]));
}
export async function encryptContent(content: string, passcode: string): Promise<string> {
  if (typeof content !== 'string') throw new TypeError('Content must be text');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = { iterations: ITERATIONS, salt: base64(salt), iv: base64(iv) };
  const key = await derive(passcode, salt, ITERATIONS);
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(header), tagLength: 128 }, key, encoder.encode(content),
  );
  return VERSION + JSON.stringify({ ...header, data: base64(data) });
}
export async function decryptContent(content: string, passcode: string): Promise<string> {
  // Validate caller input separately; malformed envelopes and authentication failures share one error.
  passcodeBytes(passcode).fill(0);
  try {
    if (!content.startsWith(VERSION)) throw new Error('Unsupported envelope');
    const envelope: Envelope = JSON.parse(content.slice(VERSION.length));
    if (!envelope || !Number.isInteger(envelope.iterations) ||
        envelope.iterations < ITERATIONS || envelope.iterations > 2_000_000 ||
        typeof envelope.salt !== 'string' || envelope.salt.length !== 24 ||
        typeof envelope.iv !== 'string' || envelope.iv.length !== 16) throw new Error('Invalid envelope');
    const salt = unbase64(envelope.salt), iv = unbase64(envelope.iv), data = unbase64(envelope.data);
    if (salt.length !== 16 || iv.length !== 12 || data.length < 16) throw new Error('Invalid envelope');
    const key = await derive(passcode, salt, envelope.iterations);
    return decoder.decode(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(envelope), tagLength: 128 }, key, data,
    ));
  } catch { throw new DecryptionError(); }
}
export async function verifyPasscode(content: string, passcode: string): Promise<boolean> {
  try { await decryptContent(content, passcode); return true; }
  catch (error) { if (error instanceof DecryptionError) return false; throw error; }
}
export async function changePasscode(content: string, oldPasscode: string, next: string, confirmation: string): Promise<string> {
  if (next !== confirmation) throw new Error('Passcode confirmation mismatch');
  passcodeBytes(next).fill(0);
  return encryptContent(await decryptContent(content, oldPasscode), next);
}

export interface MarkdownFile { readonly name: string; readonly content: string }
export type BatchResult = { name: string; ok: true; content: string } | { name: string; ok: false; error: Error };
export interface BatchOptions {
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (progress: Readonly<{ completed: number; total: number; name: string; ok: boolean }>) => void;
}
/** In-memory transforms only. Results preserve order; file failures never discard other results. */
export async function processBatch(
  files: readonly MarkdownFile[], transform: (content: string) => Promise<string>, options: BatchOptions = {},
): Promise<BatchResult[]> {
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new RangeError('Concurrency must be 1–8');
  const input = files.map(file => ({ ...file }));
  if (input.some(file => !/\.md$/i.test(file.name))) throw new TypeError('Only .md files are supported');
  const results: BatchResult[] = new Array(input.length);
  let cursor = 0, completed = 0;
  const observers: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    while (cursor < input.length) {
      const index = cursor++, file = input[index]!;
      let result: BatchResult;
      try {
        options.signal?.throwIfAborted();
        result = { name: file.name, ok: true, content: await transform(file.content) };
      } catch (error) {
        result = { name: file.name, ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
      results[index] = result;
      try { options.onProgress?.(Object.freeze({ completed: ++completed, total: input.length, name: file.name, ok: result.ok })); }
      catch (error) { observers.push(error); }
    }
  }));
  if (observers.length) throw new AggregateError(observers, 'Progress callback failed; input files were not modified');
  return results;
}
export const encryptBatch = (files: readonly MarkdownFile[], passcode: string, options?: BatchOptions): Promise<BatchResult[]> =>
  processBatch(files, content => {
    if (isEncrypted(content)) throw new Error('Content is already encrypted');
    return encryptContent(content, passcode);
  }, options);
export const decryptBatch = (files: readonly MarkdownFile[], passcode: string, options?: BatchOptions): Promise<BatchResult[]> =>
  processBatch(files, content => decryptContent(content, passcode), options);
export const changeBatchPasscode = (
  files: readonly MarkdownFile[], oldPasscode: string, next: string, confirmation: string, options?: BatchOptions,
): Promise<BatchResult[]> => {
  if (next !== confirmation) throw new Error('Passcode confirmation mismatch');
  return processBatch(files, content => changePasscode(content, oldPasscode, next, confirmation), options);
};
