// Diagnostic harness: opens the real window, seeds an account, then reports how
// many avatar nodes are *actually visible* per screen and which nodes overflow
// their box (the "text is cut off" complaint). Read-only: it never asserts, it
// just dumps facts so a fix can be aimed at a proven cause.
import { _electron as electron } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';

await mkdir('work/shots', { recursive: true });
const home = await mkdtemp(resolve('work/probe-'));
const env = { ...process.env, DIARY_TEST_HOME: home, DIARY_TEST_VAULT: resolve(home, 'journals') };
delete env.ELECTRON_RUN_AS_NODE;

const app = await electron.launch({
  executablePath: resolve('node_modules/electron/dist/electron.exe'),
  args: ['--no-sandbox', resolve('.')],
  env,
  timeout: 90000,
});

async function shot(name) {
  await new Promise(r => setTimeout(r, 1200));
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return (await win.webContents.capturePage()).toPNG().toString('base64');
  });
  await writeFile(`work/shots/${name}.png`, Buffer.from(b64, 'base64'));
}

const AVATarSEL = '#userAvatar, #avatarImg, #profileAvatarPreview, #profileAvatarInitial, #loginIdentityAvatar';

try {
  const page = await app.firstWindow();
  await page.locator('#lockScreen').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#offlineCreate').click();
  await page.locator('[name=username]').fill('lizhonghao');
  await page.locator('[name=nickname]').fill('李忠浩');
  await page.locator('[name=next]').fill('diary-pass-123');
  await page.locator('[name=confirmation]').fill('diary-pass-123');
  await page.locator('#modalConfirm').click();
  await page.locator('#lockScreen').waitFor({ state: 'hidden', timeout: 20000 });
  await page.waitForTimeout(800);

  // Seed a data-URL avatar exactly the way Google login stores one.
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 96; c.height = 96;
    const g = c.getContext('2d');
    g.fillStyle = '#526fee'; g.fillRect(0, 0, 96, 96);
    g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText('G', 30, 66);
    return c.toDataURL('image/png');
  });
  const stored = await page.evaluate(async (png) => {
    await window.diary.call({ op: 'profile:set', avatar: png });
    const cfg = await window.diary.call({ op: 'config:get' });
    return { profileAvatarIsData: String(cfg.profile.avatar).startsWith('data:'), len: String(cfg.profile.avatar).length };
  }, png);
  console.log('seeded avatar:', JSON.stringify(stored));

  await page.locator('#settings').click();
  await page.waitForTimeout(400);

  console.log('=== sidebar (workbench) ===');
  console.log(JSON.stringify(await page.evaluate((sel) => {
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      out.push({
        id: el.id, tag: el.tagName.toLowerCase(),
        hiddenAttr: el.hasAttribute('hidden'), display: cs.display,
        visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        text: (el.textContent || '').trim().slice(0, 12),
        src: el.getAttribute('src') ? el.getAttribute('src').slice(0, 30) : null,
      });
    }
    return out;
  }, AVATarSEL), null, 1));
  await shot('probe-sidebar');

  // Profile tab.
  await page.locator('.settings-tabs [data-tab="profile"]').click();
  await page.waitForTimeout(400);
  console.log('=== settings > profile ===');
  console.log(JSON.stringify(await page.evaluate((sel) => {
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      out.push({ id: el.id, display: cs.display, visible: r.width > 0 && r.height > 0 && cs.display !== 'none',
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        text: (el.textContent || '').trim().slice(0, 10), src: el.getAttribute('src') ? el.getAttribute('src').slice(0, 26) : null });
    }
    const panel = document.querySelector('.qq-profile-avatar');
    return { nodes: out, avatarBox: panel ? { rect: [...[panel.getBoundingClientRect().x, panel.getBoundingClientRect().y, panel.getBoundingClientRect().width, panel.getBoundingClientRect().height].map(Math.round)], overflow: getComputedStyle(panel).overflow, scroll: [panel.scrollWidth, panel.scrollHeight], client: [panel.clientWidth, panel.clientHeight] } : null };
  }, AVATarSEL), null, 1));
  await shot('probe-profile');

  // Background tab: does it expose all four sources, and does applying a
  // picture actually paint the background layer?
  await page.locator('.settings-tabs [data-tab="media"]').click();
  await page.waitForTimeout(300);
  console.log('=== settings > media → 壁纸与背景 ===');
  console.log(JSON.stringify(await page.evaluate(() => {
    const panel = document.querySelector('[data-tabpanel="media"]');
    if (!panel) return null;
    const png = (() => {
      const c = document.createElement('canvas'); c.width = 8; c.height = 8;
      const g = c.getContext('2d'); g.fillStyle = '#2b3a67'; g.fillRect(0, 0, 8, 8);
      return c.toDataURL('image/png');
    })();
    return {
      sources: [...panel.querySelectorAll('.bg-source')].map(el => el.querySelector('b')?.textContent),
      hasFit: Boolean(panel.querySelector('#bgFit')),
      hasDim: Boolean(panel.querySelector('#bgDim')),
      hasBlur: Boolean(panel.querySelector('#bgBlur')),
      hasLibrary: Boolean(panel.querySelector('#bgLibrary')),
      hasBgm: Boolean(panel.querySelector('#bgmImport')),
      seeded: png.length > 0,
    };
  }), null, 1));

  const bgResult = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 8; c.height = 8;
    const g = c.getContext('2d'); g.fillStyle = '#2b3a67'; g.fillRect(0, 0, 8, 8);
    const data = c.toDataURL('image/png').split(',')[1];
    const info = await window.diary.call({ op: 'media:import', name: 'probe.png', mime: 'image/png', data });
    await window.diary.call({ op: 'background:set', kind: 'image', id: info.id, dim: 0.2, blur: 4 });
    const cfg = await window.diary.call({ op: 'config:get' });
    return { background: cfg.background };
  });
  console.log('background:set ->', JSON.stringify(bgResult));
  await page.locator('#settingsClose').click();
  await page.locator('#settings').click();
  await page.waitForTimeout(700);
  console.log('after reload ->', JSON.stringify(await page.evaluate(() => ({
    bodyHasBg: document.body.classList.contains('has-bg'),
    bgLayerVisible: (() => { const el = document.getElementById('bgImage'); const r = el.getBoundingClientRect(); return { hidden: el.hasAttribute('hidden'), w: Math.round(r.width), h: Math.round(r.height), hasImage: el.style.backgroundImage.slice(0, 40) }; })(),
    dimOpacity: document.getElementById('bgDimLayer').style.opacity,
    blur: getComputedStyle(document.documentElement).getPropertyValue('--bg-blur'),
    preview: document.getElementById('bgPreviewImage').style.backgroundImage.slice(0, 40),
    previewLabel: document.getElementById('bgPreviewLabel').textContent,
  }))));
  await shot('probe-media');

  // Privacy tab + plugin manager.
  await page.locator('.settings-tabs [data-tab="privacy"]').click();
  await page.waitForTimeout(250);
  console.log('=== settings > privacy ===');
  console.log(JSON.stringify(await page.evaluate(() => ({
    network: document.getElementById('permNetwork').checked,
    location: document.getElementById('permLocation').checked,
    mode: document.getElementById('locMode').value,
    state: document.getElementById('locState').textContent,
  })), null, 1));
  await shot('probe-privacy');
  await page.locator('#settingsClose').click();

  await page.locator('#pluginManage').click();
  await page.waitForTimeout(600);
  console.log('=== plugin manager ===');
  console.log(JSON.stringify(await page.evaluate(() => ({
    visible: !document.getElementById('pluginPanel').hidden,
    builtin: [...document.querySelectorAll('#builtinPluginList .plugin-row')].map(row => ({
      name: row.querySelector('.plugin-info b')?.textContent,
      badge: row.querySelector('.plugin-badge')?.textContent,
      action: row.querySelector('.plugin-toggle')?.textContent,
    })),
    external: [...document.querySelectorAll('#externalPluginList .plugin-row')].map(row => row.querySelector('.plugin-info b')?.textContent),
    dir: document.getElementById('pluginDirHint').textContent,
  })), null, 1));
  await shot('probe-plugins');
  await page.locator('#pluginClose').click();

  // Weather panel: the panel must explain itself when the switches are off,
  // then really fetch once the user opts in.
  await page.locator('#primaryNav [data-view="home"]').click();
  await page.waitForTimeout(900);
  console.log('=== home weather (network OFF) ===');
  console.log(JSON.stringify(await page.evaluate(() => {
    const card = document.querySelector('#heroWeather .weather-card');
    return card ? { cls: card.className, text: card.textContent.replace(/\s+/g, ' ').trim().slice(0, 160) } : null;
  }), null, 1));

  // Flip every switch through the real UI instead of the IPC shortcut: that is
  // the path the user actually takes, and it is the path that has to repaint.
  await page.locator('#settings').click();
  await page.waitForTimeout(500);
  await page.locator('.settings-tabs [data-tab="privacy"]').click();
  await page.waitForTimeout(300);
  await page.locator('#permNetwork').check();
  await page.waitForTimeout(400);
  await page.locator('#locMode').selectOption('manual');
  await page.waitForTimeout(300);
  await page.locator('#locLat').fill('39.9042');
  await page.locator('#locLon').fill('116.4074');
  await page.locator('#locLabel').fill('北京');
  await page.locator('#locSave').click();
  await page.waitForTimeout(400);
  await page.locator('#settingsClose').click();
  await page.waitForTimeout(6500);
  console.log('=== home weather (network ON, 北京) ===');
  console.log(JSON.stringify(await page.evaluate(() => {
    const card = document.querySelector('#heroWeather .weather-card');
    if (!card) return null;
    return {
      cls: card.className,
      place: card.querySelector('.weather-place')?.textContent,
      temp: card.querySelector('.weather-temp')?.textContent,
      desc: card.querySelector('.weather-desc')?.textContent,
      metrics: [...card.querySelectorAll('.weather-metric')].map(el => `${el.querySelector('small')?.textContent}=${el.querySelector('b')?.textContent}`),
      air: card.querySelector('.air-text')?.textContent,
      foot: card.querySelector('.weather-foot')?.textContent,
    };
  }), null, 1));
  await shot('probe-weather');

  // Right-click must offer the diary import path.
  await page.locator('#heroWeather .weather-card').click({ button: 'right' });
  await page.waitForTimeout(400);
  console.log('=== weather context menu ===');
  console.log(JSON.stringify(await page.evaluate(() => ({
    open: Boolean(document.getElementById('weatherMenu')),
    items: [...document.querySelectorAll('#weatherMenu button')].map(el => el.textContent),
  })), null, 1));
  await shot('probe-weather-menu');
  await page.keyboard.press('Escape');

  // Diary mode has its own DOM — scan it too, since that is where a
  // "text is cut off" screenshot usually comes from.
  await page.locator('#diaryMode').click({ timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(700);
  await page.locator('#firstEntry').click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(600);
  await page.locator('#title').fill('测试标题', { timeout: 5000 }).catch(() => undefined);
  await page.locator('#editor').fill('今天去图书馆，看了三个小时的书，把报告写完了。', { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(300);

  const sweep = () => {
    const skip = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'HTML', 'BODY', 'MAIN', 'SCRIPT', 'STYLE']);
    const scrollable = (v) => v === 'auto' || v === 'scroll';
    const out = [];

    // Inputs are skipped by the box sweep below (their scrollWidth is useless),
    // but a placeholder wider than the field is *exactly* the "text is cut off"
    // complaint the user filed — measure the glyphs and compare with the field.
    // A textarea's placeholder wraps, so measure its longest single line.
    const canvas = document.createElement('canvas').getContext('2d');
    for (const el of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4) continue;
      canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const textW = Math.max(...el.placeholder.split('\n').map(line => canvas.measureText(line).width));
      const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (textW <= avail + 1) continue;
      out.push({
        sel: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`,
        box: [Math.round(r.width), Math.round(r.height)],
        scroll: [Math.round(textW)], client: [Math.round(avail)],
        overflow: `${cs.overflowX}/${cs.overflowY}`,
        why: ['placeholder-cut'],
        text: el.placeholder.slice(0, 54),
      });
    }

    for (const el of document.querySelectorAll('body *')) {
      if (skip.has(el.tagName)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 2) continue;
      // A scroll container is allowed to scroll; anything else that has more
      // content than box is, by definition, hiding text from the user. Note this
      // must NOT require overflow:visible — overflow:hidden + the default
      // text-overflow:clip is exactly how text gets silently chopped, and the
      // old `overflowX === 'visible'` guard skipped all of those.
      // Only overflow:hidden/clip actually hides a glyph. overflow:visible lets
      // content spill out and stay readable, which is a 2px line-height quirk,
      // not the bug the user reported — do not cry wolf about it.
      const hides = (value) => value === 'hidden' || value === 'clip';
      const leaf = el.children.length === 0;
      const clippedX = leaf && el.scrollWidth > el.clientWidth + 1 && hides(cs.overflowX);
      const clippedY = leaf && el.scrollHeight > el.clientHeight + 1 && hides(cs.overflowY);
      const ellipsis = cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1;
      const clamp = cs.webkitLineClamp && cs.webkitLineClamp !== 'none' && Number(cs.webkitLineClamp) > 0;
      if (!clippedX && !clippedY && !ellipsis && !clamp) continue;
      out.push({
        sel: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`.slice(0, 80),
        box: [Math.round(r.width), Math.round(r.height)],
        scroll: [el.scrollWidth, el.scrollHeight], client: [el.clientWidth, el.clientHeight],
        overflow: `${cs.overflowX}/${cs.overflowY}`,
        why: [clippedX && 'clipX', clippedY && 'clipY', ellipsis && 'ellipsis', clamp && `clamp${cs.webkitLineClamp}`].filter(Boolean),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 54),
      });
    }
    return out;
  };

  // Diary mode has its own DOM and was entered above — sweep it now that
  // `sweep` actually exists (declaring it after the call was a TDZ crash).
  const diaryRows = await page.evaluate(sweep);
  console.log(`=== clipped text @ diary (${diaryRows.length}) ===`);
  if (diaryRows.length) console.log(JSON.stringify(diaryRows, null, 1));
  await shot('probe-diary');

  // Sidebar chrome is always on screen, so sweep it separately and look only at
  // the label boxes — a nav button whose text is wider than the button reads as
  // "text is cut off" even when the element itself does not overflow.
  const sidebarLabels = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('.sidebar button, .sidebar-footer button, #primaryNav button')) {
      const r = el.getBoundingClientRect();
      if (r.width < 4) continue;
      out.push({
        sel: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`,
        label: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24),
        box: [Math.round(r.width), Math.round(r.height)],
        scroll: [el.scrollWidth, el.scrollHeight], client: [el.clientWidth, el.clientHeight],
        overflow: getComputedStyle(el).overflow,
        cut: el.scrollWidth > el.clientWidth + 1,
      });
    }
    return out;
  });

  if (await page.locator('#settingsPanel').isVisible()) await page.locator('#settingsClose').click();
  for (const view of ['home', 'chat', 'search-view', 'competition', 'guide']) {
    await page.locator(`#primaryNav [data-view="${view}"]`).click();
    await page.waitForTimeout(500);
    const rows = await page.evaluate(sweep);
    console.log(`=== clipped text @ ${view} (${rows.length}) ===`);
    if (rows.length) console.log(JSON.stringify(rows, null, 1));
  }
  // Settings tabs too: the modal is where the user was looking.
  await page.locator('#settings').click();
  await page.waitForTimeout(400);
  console.log('=== sidebar labels ===');
  console.log(JSON.stringify(sidebarLabels.filter(row => row.cut), null, 1));
  for (const tab of ['ai', 'account', 'profile', 'media', 'privacy', 'lang']) {
    await page.locator(`.settings-tabs [data-tab="${tab}"]`).click();
    await page.waitForTimeout(250);
    const rows = await page.evaluate(sweep);
    console.log(`=== clipped text @ settings/${tab} (${rows.length}) ===`);
    if (rows.length) console.log(JSON.stringify(rows, null, 1));
    await shot(`probe-settings-${tab}`);
  }

  // The plugin manager is a separate panel, not a settings tab — sweep it too.
  await page.locator('#settingsClose').click();
  await page.waitForTimeout(300);
  await page.locator('#pluginManage').click();
  await page.waitForTimeout(600);
  const pluginRows = await page.evaluate(sweep);
  console.log(`=== clipped text @ plugin manager (${pluginRows.length}) ===`);
  if (pluginRows.length) console.log(JSON.stringify(pluginRows, null, 1));
  await shot('probe-plugins-clip');

  console.log('\nshots written to work/shots/probe-*.png');
} finally {
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 6000))]).catch(() => undefined);
}
// Playwright can leave sockets open, which keeps Node alive forever and blocks
// whatever script is chained after this one. Exit explicitly.
process.exit(0);
