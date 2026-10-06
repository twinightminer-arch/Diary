// SPDX-License-Identifier: AGPL-3.0-only
// Wallpaper Engine library integration.
//
// Wallpaper Engine stores every wallpaper as a folder that carries a
// project.json describing its type and its playable file:
//   <steam>/steamapps/common/wallpaper_engine/projects/myprojects/<name>/
//   <steam>/steamapps/workshop/content/431960/<workshopId>/
// Those folders are scanned and offered as backgrounds. The renderer runs
// under a CSP that refuses file:// URLs, so anything we hand it is addressed
// through the custom `diary-wallpaper://` protocol (registered in main.ts).
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type WallpaperKind = 'video' | 'scene' | 'web' | 'application' | 'text' | 'other';
export type WallpaperSource = 'myprojects' | 'defaultprojects' | 'workshop' | 'custom';

export interface WallpaperEntry {
  /** Stable key: workshop id when available, otherwise the folder name. */
  readonly id: string;
  readonly title: string;
  readonly type: WallpaperKind;
  readonly dir: string;
  readonly source: WallpaperSource;
  /** Playable video / displayable image. Null for scene pkg walls. */
  readonly media: string | null;
  /** Thumbnail shipped by Wallpaper Engine (jpg/gif/webp). */
  readonly preview: string | null;
  /** True when applying it produces motion rather than a still picture. */
  readonly animated: boolean;
  /** Human explanation shown when the wallpaper can only be approximated. */
  readonly note: string;
}

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif']);
const PREVIEW_NAMES = ['preview.jpg', 'preview.jpeg', 'preview.png', 'preview.gif', 'preview.webp', 'preview.mp4', 'preview.webm'];

/** Custom scheme used to serve local wallpaper files to the renderer. */
export const WALLPAPER_SCHEME = 'diary-wallpaper';

/** Absolute path <-> opaque token, so paths with spaces/CJK never break a URL. */
export function encodeWallpaperPath(absolute: string): string {
  return Buffer.from(absolute, 'utf8').toString('base64url');
}
export function decodeWallpaperPath(token: string): string {
  return Buffer.from(token, 'base64url').toString('utf8');
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}
async function isDir(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/** Steam install locations, from the registry plus the usual drive layouts. */
export async function detectSteamRoots(): Promise<string[]> {
  const found = new Set<string>();
  const probes: string[] = [
    'C:/Program Files (x86)/Steam', 'C:/Program Files/Steam', 'C:/Steam',
    'D:/Steam', 'E:/Steam', 'F:/Steam', 'G:/Steam',
    'D:/SteamLibrary', 'E:/SteamLibrary', 'F:/SteamLibrary', 'G:/SteamLibrary',
    'D:/Games/Steam', 'E:/Games/Steam', 'E:/Program Files (x86)/Steam',
  ];
  const registryKeys = [
    ['HKCU', 'Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM', 'SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM', 'SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ] as const;
  for (const [hive, key, value] of registryKeys) {
    try {
      const { stdout } = await run('reg', ['query', `${hive}\\${key}`, '/v', value], { windowsHide: true, timeout: 4000 });
      const match = stdout.match(/REG_SZ\s+(.+)/);
      if (match?.[1]) probes.push(match[1].trim().replaceAll('\\', '/').replace(/\/+$/, ''));
    } catch { /* Steam not installed here — that is fine. */ }
  }
  for (const probe of probes) {
    if (!await isDir(probe)) continue;
    found.add(probe);
    // Extra libraries live in steamapps/libraryfolders.vdf.
    try {
      const vdf = await readFile(join(probe, 'steamapps', 'libraryfolders.vdf'), 'utf8');
      for (const match of vdf.matchAll(/"path"\s+"([^"]+)"/g)) {
        const extra = match[1]?.replaceAll('\\\\', '/').replaceAll('\\', '/').trim();
        if (extra && await isDir(extra)) found.add(extra.replace(/\/+$/, ''));
      }
    } catch { /* No extra libraries. */ }
  }
  return [...found];
}

/** Every `<wallpaper_engine>` directory reachable from the detected Steam roots. */
export async function detectEngineDirs(): Promise<string[]> {
  const engines = new Set<string>();
  for (const root of await detectSteamRoots()) {
    for (const rel of ['steamapps/common/wallpaper_engine', 'common/wallpaper_engine', 'steamapps/common/Wallpaper Engine']) {
      const candidate = join(root, rel);
      if (await isDir(join(candidate, 'projects')) || await isDir(join(candidate, 'workshop'))) engines.add(candidate);
    }
  }
  return [...engines];
}

async function readProject(dir: string): Promise<Record<string, unknown> | null> {
  for (const name of ['project.json', 'Project.json']) {
    try {
      const raw = await readFile(join(dir, name), 'utf8');
      const clean = raw.replace(/^\uFEFF/, '');
      return JSON.parse(clean) as Record<string, unknown>;
    } catch { /* try the next spelling */ }
  }
  return null;
}

async function firstFileWith(dir: string, extensions: Set<string>): Promise<string | null> {
  let names: string[];
  try { names = await readdir(dir); } catch { return null; }
  for (const name of names) if (extensions.has(extname(name).toLowerCase())) return join(dir, name);
  return null;
}

async function findPreview(dir: string): Promise<string | null> {
  for (const name of PREVIEW_NAMES) {
    const candidate = join(dir, name);
    if (await exists(candidate)) return candidate;
  }
  // scene.pkg walls often ship a bare .jpg next to the pkg.
  return firstFileWith(dir, IMAGE_EXT);
}

/** Normalises project.json into something the UI can render and apply. */
async function toEntry(dir: string, source: WallpaperSource, id: string): Promise<WallpaperEntry | null> {
  const json = await readProject(dir);
  if (!json) return null;
  const rawType = String(json.type ?? '').toLowerCase();
  const type: WallpaperKind = (['video', 'scene', 'web', 'application', 'text'] as const).includes(rawType as never)
    ? rawType as WallpaperKind : 'other';
  const title = String(json.title ?? '').trim() || basename(dir);
  const declared = typeof json.file === 'string' ? json.file : '';
  const declaredPath = declared ? join(dir, declared) : '';
  const preview = await findPreview(dir);

  let media: string | null = null;
  if (type === 'video') {
    if (declaredPath && await exists(declaredPath)) media = declaredPath;
    else media = await firstFileWith(dir, VIDEO_EXT);
  }
  // scene/web/application projects need Wallpaper Engine's own renderer, so the
  // best a plain Electron window can do is animate their preview file.
  if (!media && type !== 'video' && preview && (extname(preview).toLowerCase() === '.gif' || VIDEO_EXT.has(extname(preview).toLowerCase()))) media = preview;
  if (!media && type !== 'video' && preview) media = preview;

  const mediaExt = media ? extname(media).toLowerCase() : '';
  const animated = VIDEO_EXT.has(mediaExt) || mediaExt === '.gif' || mediaExt === '.webp';
  const note = type === 'video'
    ? (media && mediaExt === '.gif' ? '未找到视频文件，改用预览动图' : '')
    : type === 'scene' || type === 'web' || type === 'application'
      ? '此壁纸需要 Wallpaper Engine 渲染，这里使用它的预览图/动图'
      : '';

  return {
    id: id || basename(dir),
    title,
    type,
    dir,
    source,
    media,
    preview,
    animated,
    note,
  };
}

/** Treats a folder as either one wallpaper project or a bag of them. */
async function scanPlainFolder(dir: string): Promise<WallpaperEntry[]> {
  if (await readProject(dir)) {
    const single = await toEntry(dir, 'custom', basename(dir));
    return single ? [single] : [];
  }
  let children: string[];
  try { children = await readdir(dir); } catch { return []; }
  const entries: WallpaperEntry[] = [];
  for (const child of children) {
    const sub = join(dir, child);
    if (!await isDir(sub)) continue;
    const entry = await toEntry(sub, 'custom', child);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Scans one wallpaper_engine directory (myprojects + defaultprojects + workshop). */
export async function scanEngine(engineDir: string): Promise<WallpaperEntry[]> {
  const entries: WallpaperEntry[] = [];
  const groups: { path: string; source: WallpaperSource }[] = [
    { path: join(engineDir, 'projects', 'myprojects'), source: 'myprojects' },
    { path: join(engineDir, 'projects', 'defaultprojects'), source: 'defaultprojects' },
    { path: join(engineDir, 'workshop', 'content', '431960'), source: 'workshop' },
  ];
  for (const group of groups) {
    if (!await isDir(group.path)) continue;
    let children: string[];
    try { children = await readdir(group.path); } catch { continue; }
    for (const child of children) {
      const dir = join(group.path, child);
      if (!await isDir(dir)) continue;
      const entry = await toEntry(dir, group.source, group.source === 'workshop' ? child : child);
      if (entry) entries.push(entry);
    }
  }
  return entries.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'));
}

export interface WallpaperScan {
  readonly engines: string[];
  readonly entries: WallpaperEntry[];
  /** Set when nothing was found so the UI can explain why. */
  readonly hint: string;
}

/**
 * Full discovery: auto-detected engine folders plus an optional user-supplied
 * folder (which may be an engine root or a plain directory of wallpapers).
 */
export async function scanWallpapers(customDir?: string): Promise<WallpaperScan> {
  const engines = await detectEngineDirs();
  const entries: WallpaperEntry[] = [];
  const seen = new Set<string>();
  const push = (list: WallpaperEntry[]) => {
    for (const entry of list) {
      if (seen.has(entry.dir)) continue;
      seen.add(entry.dir);
      entries.push(entry);
    }
  };
  for (const engine of engines) push(await scanEngine(engine));
  // A user-picked folder may be an engine root, a myprojects folder, or a
  // single wallpaper project — accept all three shapes.
  if (customDir && await isDir(customDir)) {
    const engineHits = await scanEngine(customDir);
    push(engineHits.length ? engineHits : await scanPlainFolder(customDir));
  }
  const hint = entries.length
    ? ''
    : engines.length
      ? '找到了 Wallpaper Engine 目录，但里面没有可用的壁纸项目。'
      : '未检测到 Wallpaper Engine。可在下方手动填写 wallpaper_engine 目录，或直接导入图片／动图／视频作为背景。';
  return { engines, entries, hint };
}
