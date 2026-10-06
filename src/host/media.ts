// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, readFile, writeFile, unlink, readdir, stat, copyFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface MediaInfo { readonly id: string; readonly name: string; readonly mime: string; readonly size: number }
const MAX_BYTES = 200 * 1024 * 1024; // 200 MB cap for video/audio.
const ID = /^[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9]{1,8}$/;
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'image/avif': 'avif', 'image/bmp': 'bmp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'weba',
  'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/opus': 'opus',
};
/** Extension → MIME. The bucket folders are user-visible, so files may arrive
 *  from anywhere and we must be able to type them without a browser's help. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac', '.weba': 'audio/webm', '.opus': 'audio/opus',
};
function extFor(mime: string): string {
  const ext = EXT_BY_MIME[mime];
  if (!ext) throw new TypeError(`Unsupported media type: ${mime}`);
  return ext;
}
function mediaDir(vault: string): string { return join(vault, 'media'); }

/**
 * Which folder a file belongs to.
 *
 * Backgrounds and music are deliberately separate directories: they used to
 * share `<vault>/media`, which is why a picture showed up under "背景音乐"
 * and the user could not tell which file was which. Illustrations and avatars
 * keep the original `media` folder so existing data keeps working untouched.
 */
export type MediaBucket = 'media' | 'backgrounds' | 'music';

export function bucketDir(vault: string, bucket: MediaBucket): string {
  return join(vault, bucket);
}

export function mimeForName(name: string): string {
  return MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream';
}

const AUDIO_EXT = /\.(mp3|m4a|wav|ogg|oga|flac|aac|weba|opus)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|mkv|avi)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
export function isAudioName(name: string): boolean { return AUDIO_EXT.test(name); }
export function isVideoName(name: string): boolean { return VIDEO_EXT.test(name); }
export function isImageName(name: string): boolean { return IMAGE_EXT.test(name); }
/** True for anything a background slot can actually paint. */
export function isBackgroundName(name: string): boolean { return IMAGE_EXT.test(name) || VIDEO_EXT.test(name); }

/**
 * Keeps the user's own file name. The whole point of a per-kind folder is that
 * the user can recognise their files and drop new ones in by hand, so an opaque
 * uuid would defeat the feature. Only characters the filesystem rejects (or
 * that could escape the folder) are rewritten.
 */
export function safeFileName(raw: string, fallbackExt = 'bin'): string {
  const withoutDirs = raw.replaceAll('\\', '/').split('/').pop() ?? '';
  const cleaned = withoutDirs
    .normalize('NFC')
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  if (cleaned) return cleaned.slice(0, 160);
  return `media-${randomUUID().slice(0, 8)}.${fallbackExt}`;
}

export interface LibraryItem {
  readonly name: string;
  readonly size: number;
  readonly mime: string;
  readonly modified: number;
}

/** Lists one bucket, newest name order fixed so the grid does not reshuffle. */
export async function listBucket(vault: string, bucket: MediaBucket): Promise<LibraryItem[]> {
  const dir = bucketDir(vault, bucket);
  let names: string[];
  try { names = await readdir(dir); } catch { return []; }
  const items: LibraryItem[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    try {
      const info = await stat(join(dir, name));
      if (!info.isFile()) continue;
      items.push({ name, size: info.size, mime: mimeForName(name), modified: info.mtimeMs });
    } catch { /* vanished mid-scan */ }
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

/** Resolves a bucket file safely — a bare name only, so nothing can escape. */
export function bucketFilePath(vault: string, bucket: MediaBucket, name: string): string {
  const base = basename(name);
  if (!base || base !== name || base.startsWith('.') || base.includes('..')) throw new TypeError('Invalid file name');
  return join(bucketDir(vault, bucket), base);
}

/** Never silently overwrite: "cat.png" becomes "cat (2).png". */
async function uniqueName(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; n < 500; n++) {
    try { await stat(join(dir, candidate)); candidate = `${stem} (${n})${ext}`; } catch { return candidate; }
  }
  return `${stem}-${randomUUID().slice(0, 6)}${ext}`;
}

export async function importToBucket(
  vault: string, bucket: MediaBucket, data: Uint8Array, name: string, mime?: string,
): Promise<LibraryItem> {
  if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new TypeError('Empty media payload');
  if (data.byteLength > MAX_BYTES) throw new TypeError('Media exceeds 200 MB');
  const dir = bucketDir(vault, bucket);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const final = await uniqueName(dir, safeFileName(name, mime ? extFor(mime) : 'bin'));
  await writeFile(join(dir, final), data, { mode: 0o600 });
  return { name: final, size: data.byteLength, mime: mime || mimeForName(final), modified: Date.now() };
}

/**
 * Copies a file the OS file-picker already gave us straight into the bucket.
 * Going through the renderer would mean base64-ing a 200 MB clip across IPC
 * (and the old HTML-file-input path could also hang forever if the user
 * cancelled, which froze every later button in the app).
 */
export async function copyIntoBucket(vault: string, bucket: MediaBucket, sourcePath: string): Promise<LibraryItem> {
  const info = await stat(sourcePath);
  if (!info.isFile()) throw new TypeError('Not a file');
  if (info.size > MAX_BYTES) throw new TypeError('Media exceeds 200 MB');
  const dir = bucketDir(vault, bucket);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const final = await uniqueName(dir, safeFileName(basename(sourcePath), 'bin'));
  await copyFile(sourcePath, join(dir, final));
  return { name: final, size: info.size, mime: mimeForName(final), modified: Date.now() };
}

export async function readBucket(vault: string, bucket: MediaBucket, name: string): Promise<{ data: Buffer; mime: string }> {
  const path = bucketFilePath(vault, bucket, name);
  const data = await readFile(path);
  return { data, mime: mimeForName(name) };
}

export async function readBucketDataUrl(vault: string, bucket: MediaBucket, name: string): Promise<string> {
  const { data, mime } = await readBucket(vault, bucket, name);
  return `data:${mime};base64,${data.toString('base64')}`;
}

export async function removeFromBucket(vault: string, bucket: MediaBucket, name: string): Promise<void> {
  const path = bucketFilePath(vault, bucket, name);
  await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
}

// ----- Legacy `<vault>/media` API (illustrations & avatars) -----
// Kept byte-compatible so existing entries keep resolving their pictures.

/** Host-only. Stores diary media (illustrations, avatars) next to the vault. */
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
