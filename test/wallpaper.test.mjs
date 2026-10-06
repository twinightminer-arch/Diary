import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeWallpaperPath, encodeWallpaperPath, scanEngine, scanWallpapers } from '../src/host/wallpaper.ts';

test('wallpaper projects are read from myprojects and the workshop cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diary-wp-'));
  try {
    const engine = join(root, 'wallpaper_engine');
    const mine = join(engine, 'projects', 'myprojects', 'Forest');
    const workshop = join(engine, 'workshop', 'content', '431960', '987654');
    await mkdir(mine, { recursive: true });
    await mkdir(workshop, { recursive: true });
    await writeFile(join(mine, 'project.json'), JSON.stringify({ title: '晨雾森林', type: 'video', file: 'scene.mp4' }));
    await writeFile(join(mine, 'scene.mp4'), 'x');
    await writeFile(join(workshop, 'project.json'), JSON.stringify({ title: '霓虹城市', type: 'scene', file: 'scene.pkg' }));
    await writeFile(join(workshop, 'preview.gif'), 'x');

    const entries = await scanEngine(engine);
    assert.equal(entries.length, 2);

    const forest = entries.find(entry => entry.title === '晨雾森林');
    assert.equal(forest.type, 'video');
    assert.ok(forest.media.endsWith('scene.mp4'));
    assert.equal(forest.animated, true);
    assert.equal(forest.source, 'myprojects');
    assert.equal(forest.note, '');

    // A scene wall has no playable file in Electron, so its preview stands in
    // and the entry explains why.
    const neon = entries.find(entry => entry.title === '霓虹城市');
    assert.equal(neon.type, 'scene');
    assert.ok(neon.media.endsWith('preview.gif'));
    assert.ok(neon.note.includes('Wallpaper Engine'));
    assert.equal(neon.source, 'workshop');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a user-picked folder is accepted as an engine root or a plain project bag', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diary-wp2-'));
  try {
    const engine = join(root, 'engine');
    const project = join(engine, 'projects', 'myprojects', 'Solo');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'project.json'), JSON.stringify({ title: 'Solo', type: 'video', file: 'v.webm' }));
    await writeFile(join(project, 'v.webm'), 'x');

    const asEngine = await scanWallpapers(engine);
    assert.ok(asEngine.entries.some(entry => entry.title === 'Solo'));

    // Pointing at the myprojects folder itself must work too.
    const bag = join(engine, 'projects', 'myprojects');
    const asBag = await scanWallpapers(bag);
    assert.ok(asBag.entries.some(entry => entry.title === 'Solo'));

    // And pointing at one project directly.
    const single = await scanWallpapers(project);
    assert.ok(single.entries.some(entry => entry.title === 'Solo'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('wallpaper paths survive a base64url round trip, CJK and spaces included', () => {
  const path = 'E:/壁纸 库/我的 项目/scene 1.mp4';
  assert.equal(decodeWallpaperPath(encodeWallpaperPath(path)), path);
  // The token must be URL-safe so it can sit in a diary-wallpaper:// URL.
  assert.match(encodeWallpaperPath(path), /^[A-Za-z0-9_-]+$/);
});

test('scanning a folder without wallpapers still returns a usable report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'diary-wp3-'));
  try {
    const scan = await scanWallpapers(join(root, 'nope'));
    assert.ok(Array.isArray(scan.entries));
    assert.ok(Array.isArray(scan.engines));
    // Either a real install was detected elsewhere on this machine, or the UI
    // gets a sentence explaining why the list is empty. Never a silent blank.
    assert.ok(scan.entries.length > 0 || scan.hint.length > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
