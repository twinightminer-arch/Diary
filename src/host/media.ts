// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface MediaInfo { readonly id: string; readonly name: string; readonly mime: string; readonly size: number }
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB cap for video/audio.
const ID = /^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9]{1,8}$/;
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'weba', 'audio/ogg': 'ogg',
};
function extFor(mime: string): string {
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new TypeError(`Unsupported media type: ${mime}`);
  return ext;
}
function mediaDir(vault: string): string { return join(vault, 'media'); }

/** Host-only. Stores diary media (backgrounds, BGM, illustrations, avatars) next to the vault. */
export async function importMedia(vault: string, data: Uint8Array, name: string, mime: string): Promise<MediaInfo> {
  if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new TypeError('Empty media payload');
  if (data.byteLength > MAX_BYTES) throw new TypeError('Media exceeds 200 MB');
  const ext = extFor(mime);
  const id = `${randomUUID()}.${ext}`;
  await mkdir(mediaDir(vault), { recursive: true, mode: 0o700 });
  await writeFile(join(mediaDir(vault), id), data, { mode: 0o600 });
  return { id, name: name.slice(0, 120) || id, mime, size: data.byteLength };
}
export async function listMedia(vault: string): Promise<MediaInfo[]> {
  try {
    const names = await readdir(mediaDir(vault));
    const result: MediaInfo[] = [];
    for (const id of names) {
      if (!ID.test(id)) continue;
      const buffer = await readFile(join(mediaDir(vault), id));
      const mime = Object.entries(EXT_BY_MIME).find(([, e]) => e === id.split('.').pop())?.[0] ?? 'application/octet-stream';
      result.push({ id, name: id, mime, size: buffer.byteLength });
    }
    return result.sort((a, b) => a.id < b.id ? -1 : 1);
  } catch { return []; }
}
export async function readMedia(vault: string, id: string): Promise<{ data: Buffer; mime: string }> {
  if (!ID.test(id) || id.includes('/') || id.includes('..')) throw new TypeError('Invalid media id');
  const path = join(mediaDir(vault), id);
  const buffer = await readFile(path);
  const mime = Object.entries(EXT_BY_MIME).find(([, e]) => e === id.split('.').pop())?.[0] ?? 'application/octet-stream';
  return { data: buffer, mime };
}
export async function readMediaDataUrl(vault: string, id: string): Promise<string> {
  const { data, mime } = await readMedia(vault, id);
  return `data:${mime};base64,${data.toString('base64')}`;
}
export async function removeMedia(vault: string, id: string): Promise<void> {
  if (!ID.test(id) || id.includes('/') || id.includes('..')) throw new TypeError('Invalid media id');
  await unlink(join(mediaDir(vault), id)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
}
