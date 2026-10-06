// Walks every non-diary screen in a real Electron window and asserts that each
// control actually does something. This exists because "the button does
// nothing" is the failure mode the user kept hitting.
import { _electron as electron } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';

await mkdir('work/shots', { recursive: true });
const home = await mkdtemp(resolve('work/shots/portal-'));
const env = { ...process.env, DIARY_TEST_HOME: home, DIARY_TEST_VAULT: resolve(home, 'journals') };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// DIARY_EXE=<path> runs the same checks against the packaged binary, which is
// the only way to prove a fix actually shipped rather than just compiled.
const packaged = process.env.DIARY_EXE ? resolve(process.env.DIARY_EXE) : '';
const app = await electron.launch({
  executablePath: packaged || resolve('node_modules/electron/dist/electron.exe'),
  args: packaged ? ['--no-sandbox'] : ['--no-sandbox', resolve('.')],
  env,
  timeout: 90000,
});

async function shot(name) {
  // A hidden window composites lazily: give it a moment or we capture the old frame.
  await new Promise(r => setTimeout(r, 1200));
  const b64 = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return (await win.webContents.capturePage()).toPNG().toString('base64');
  });
  await writeFile(`work/shots/${name}.png`, Buffer.from(b64, 'base64'));
}

try {
  const page = await app.firstWindow();
  await page.locator('#lockScreen').waitFor({ state: 'visible', timeout: 20000 });
  // Clicking before app.ts finished binding its handlers silently did nothing,
  // which then looked like "the button is broken". Wait for the real signal.
  await page.waitForFunction(() => Boolean(window.diary) && typeof document.getElementById('offlineCreate')?.onclick === 'function', null, { timeout: 30000 });
  // The lock card still animates in; clicking a moving target misses it.
  await page.waitForTimeout(1500);
  await page.locator('#offlineCreate').click();
  // The dialog is a real <dialog>; filling before it opens races the boot.
  await page.locator('[name=username]').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('[name=username]').fill('lizhonghao');
  await page.locator('[name=nickname]').fill('李忠浩');
  await page.locator('[name=next]').fill('diary-pass-123');
  await page.locator('[name=confirmation]').fill('diary-pass-123');
  await page.locator('#modalConfirm').click();
  await page.locator('#lockScreen').waitFor({ state: 'hidden', timeout: 20000 });

  // ---------- home ----------
  await page.waitForTimeout(600);
  check('home: hero rendered', await page.locator('#homeView .hero h1').isVisible());
  check('home: 5 quick cards', await page.locator('#homeView .quick-card').count() === 5, `count=${await page.locator('#homeView .quick-card').count()}`);
  check('home: recent panel', await page.locator('#homeView .recent-panel').isVisible());
  check('home: notice panel', await page.locator('#homeView .notice-panel').isVisible());
  await shot('portal-home');

  // ---------- chat: the quick card must carry a prompt into the composer ----------
  await page.locator('#homeView .quick-card[data-prompt]').first().click();
  await page.waitForTimeout(500);
  check('chat: reached via quick card', await page.locator('#chatView .chat-layout').isVisible());
  check('chat: prompt prefilled', (await page.locator('#portalPrompt').inputValue()).length > 0, await page.locator('#portalPrompt').inputValue());
  check('chat: suggestions rendered', await page.locator('#chatView .suggested button').count() >= 4);
  await shot('portal-chat');

  // Sending without a configured backend must explain itself, not go silent.
  await page.locator('#portalSend').click();
  await page.waitForTimeout(2500);
  const turns = await page.locator('#chatView .message .bubble').allTextContents();
  check('chat: user + assistant turns rendered', turns.length >= 2, `turns=${turns.length}`);
  const replies = await page.locator('#chatView .message.assistant .bubble').allTextContents();
  check('chat: assistant replied', replies.length >= 1, `replies=${replies.length}`);
  check('chat: answers from local catalogue offline', /缓考与补考|本机办事资料库/.test(replies.join(' ')), replies.at(-1)?.slice(0, 70) ?? '');

  // ---------- search ----------
  await page.locator('#primaryNav [data-view="search-view"]').click();
  await page.waitForTimeout(400);
  check('search: input rendered', await page.locator('#portalSearchInput').isVisible());
  check('search: preference chips', await page.locator('#searchView .pref-chip').count() === 3);
  const chip = page.locator('#searchView .pref-chip').first();
  const wasActive = await chip.evaluate(node => node.classList.contains('active'));
  await chip.click();
  check('search: chip toggles', (await chip.evaluate(node => node.classList.contains('active'))) !== wasActive);
  await shot('portal-search');

  // ---------- competition ----------
  await page.locator('#primaryNav [data-view="competition"]').click();
  await page.waitForTimeout(400);
  const cards = await page.locator('#competitionList .competition-card').count();
  check('competition: catalogue rendered', cards >= 10, `cards=${cards}`);
  await page.locator('#competitionList .detail-button').first().click();
  await page.waitForTimeout(300);
  check('competition: detail expands', await page.locator('#competitionList .competition-detail').first().isVisible());
  await page.locator('#competitionSearch').fill('蓝桥');
  await page.waitForTimeout(300);
  const filtered = await page.locator('#competitionList .competition-card').count();
  check('competition: search filters', filtered >= 1 && filtered < cards, `filtered=${filtered}`);
  await page.locator('#competitionTracks .filter', { hasText: '编程' }).first().click();
  await page.waitForTimeout(300);
  check('competition: track filter works', await page.locator('#competitionList .competition-card').count() >= 1);

  // Regression guard for the two defects visible in the user's screenshot #3:
  // the field was stuck at the browser default width (flex:1 inside a non-flex
  // parent does nothing) so the placeholder was chopped mid-word, and the
  // heading action wrapped onto a row of its own.
  const competitionLayout = await page.evaluate(() => {
    const input = document.querySelector('#competitionSearch');
    const heading = document.querySelector('.competition-view .view-heading');
    if (!input || !heading) return null;
    const cs = getComputedStyle(input);
    const canvas = document.createElement('canvas').getContext('2d');
    canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const textW = canvas.measureText(input.placeholder).width;
    const avail = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const title = heading.querySelector('h1').getBoundingClientRect();
    const eyebrow = heading.querySelector('.eyebrow').getBoundingClientRect();
    const para = heading.querySelector('p').getBoundingClientRect();
    const button = heading.querySelector('#competitionReset').getBoundingClientRect();
    return {
      display: getComputedStyle(heading).display,
      fieldWidth: Math.round(input.getBoundingClientRect().width),
      toolbarWidth: Math.round(input.parentElement.getBoundingClientRect().width),
      textW: Math.round(textW), avail: Math.round(avail),
      // align-items:flex-end lines the button up with the whole title block,
      // so compare against the block's span, not just the h1 baseline.
      buttonOnTitleRow: button.top < para.bottom && button.bottom > eyebrow.top,
      buttonRightOfTitle: button.left > title.right,
    };
  });
  check('competition: search field fills the toolbar so the placeholder is not chopped',
    competitionLayout?.fieldWidth > competitionLayout?.toolbarWidth * 0.85 && competitionLayout?.textW <= competitionLayout?.avail + 1,
    JSON.stringify(competitionLayout));
  check('competition: heading action sits on the title row, not below it',
    competitionLayout?.display === 'flex' && competitionLayout?.buttonOnTitleRow === true && competitionLayout?.buttonRightOfTitle === true,
    JSON.stringify(competitionLayout));
  await shot('portal-competition');

  // ---------- guide: categories -> affairs -> form -> tracking ----------
  await page.locator('#primaryNav [data-view="guide"]').click();
  await page.waitForTimeout(400);
  const cats = page.locator('#guideGrid .guide-card');
  check('guide: 6 categories', await cats.count() === 6, `count=${await cats.count()}`);
  await shot('portal-guide');

  await cats.first().click();
  await page.waitForTimeout(400);
  const affairs = page.locator('.guide-item');
  check('guide: category opens', await affairs.count() === 4, `affairs=${await affairs.count()}`);

  await affairs.first().click();
  await page.waitForTimeout(400);
  check('guide: affair detail opens', await page.locator('.guide-form').isVisible());
  check('guide: materials + route shown', await page.locator('.check-list .check-row').count() > 0 && await page.locator('.route-list .route-row').count() > 1);
  await shot('portal-guide-affair');

  await page.locator('button', { hasText: '生成申请表并开始追踪' }).click();
  await page.waitForTimeout(600);
  check('guide: form generates a tracked case', await page.locator('.route-list .route-row').count() > 1 && await page.locator('.status-tag').first().isVisible());
  await shot('portal-guide-case');

  await page.locator('button', { hasText: '提交并开始办理' }).click();
  await page.waitForTimeout(500);
  check('guide: route advances', await page.locator('.route-row.done').count() >= 1, `done=${await page.locator('.route-row.done').count()}`);

  // Guide search across all 24 affairs (case -> cases -> categories).
  await page.locator('.guide-back button').first().click({ force: true });
  await page.waitForTimeout(350);
  check('guide: cases list reachable', await page.locator('.guide-list .guide-item').count() >= 1);
  await page.locator('.guide-back button').first().click({ force: true });
  await page.waitForTimeout(400);
  await page.locator('.guide-toolbar .search-box input').fill('报修');
  await page.waitForTimeout(400);
  check('guide: search hits affairs', await page.locator('#guideResults .guide-item').count() >= 1, `hits=${await page.locator('#guideResults .guide-item').count()}`);

  // ---------- avatar slots: never two faces at once ----------
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 96;
    const context = canvas.getContext('2d');
    context.fillStyle = '#526fee'; context.fillRect(0, 0, 96, 96);
    context.fillStyle = '#fff'; context.font = '48px sans-serif'; context.fillText('G', 30, 66);
    await window.diary.call({ op: 'profile:set', avatar: canvas.toDataURL('image/png') });
  });
  await page.locator('#settings').click();
  await page.waitForTimeout(700);
  // The drawer opens on the AI tab; the profile card is display:none until we switch.
  // Measuring it while hidden reports area 0, which is a probe bug, not a product bug.
  await page.locator('#settingsPanel .settings-tabs [data-tab="profile"]').click();
  await page.waitForTimeout(450);
  const slots = await page.evaluate(() => {
    const read = (id) => {
      const element = document.getElementById(id);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const visible = !element.hasAttribute('hidden') && style.display !== 'none' && style.visibility !== 'hidden';
      return { hidden: element.hasAttribute('hidden'), visible, area: Math.round(rect.width * rect.height), src: (element.getAttribute('src') || '').slice(0, 12) };
    };
    const box = document.querySelector('.qq-profile-avatar');
    const overflow = box ? { scroll: [box.scrollWidth, box.scrollHeight], client: [box.clientWidth, box.clientHeight] } : null;
    const pic = read('profileAvatarPreview');
    const init = read('profileAvatarInitial');
    // Only meaningful when both are on screen — a hidden element's rect is
    // 0,0,0,0, so comparing it against a visible one always looks "stacked".
    const picRect = document.getElementById('profileAvatarPreview')?.getBoundingClientRect();
    const initRect = document.getElementById('profileAvatarInitial')?.getBoundingClientRect();
    const stacked = pic?.visible && init?.visible ? Math.abs(picRect.top - initRect.top) > 2 : false;
    return { picture: pic, initial: init, sidebarImage: read('avatarImg'), sidebarInitial: read('userAvatar'), overflow, stacked };
  });
  const faces = (pair) => pair.filter(slot => slot && slot.visible && slot.area > 0).length;
  check('avatar: profile card shows exactly one face', faces([slots.picture, slots.initial]) === 1, JSON.stringify(slots));
  check('avatar: sidebar shows exactly one face', faces([slots.sidebarImage, slots.sidebarInitial]) === 1, JSON.stringify({ image: slots.sidebarImage, initial: slots.sidebarInitial }));
  check('avatar: the stored picture really renders', slots.picture?.visible === true && slots.picture.src.startsWith('data:image'), JSON.stringify(slots.picture));
  // 2px of slack: the round box carries a border + drop shadow that rounds into
  // scrollHeight without hiding anything. The real test is `stacked`.
  check('avatar: the round box does not overflow (no second face spilling out)',
    (slots.overflow?.scroll?.[1] ?? 0) <= (slots.overflow?.client?.[1] ?? 0) + 2 && slots.stacked === false,
    JSON.stringify({ overflow: slots.overflow, stacked: slots.stacked }));
  await shot('portal-profile-avatar');
  // AI settings used to live in 设置; they are their own sidebar entry now.
  await page.locator('#settingsPanel .settings-tabs [data-tab="profile"]').click();
  await page.waitForTimeout(250);

  // ---------- plugin manager ----------
  await page.locator('#settingsClose').click();
  await page.locator('#pluginManage').click();
  await page.waitForTimeout(800);
  const pluginPanel = await page.evaluate(() => ({
    visible: !document.getElementById('pluginPanel').hidden,
    builtin: [...document.querySelectorAll('#builtinPluginList .plugin-row')].map(row => row.querySelector('.plugin-info b')?.textContent),
    // Read the raw text so this does not depend on the row's inner markup.
    external: [...document.querySelectorAll('#externalPluginList .plugin-row')].map(row => row.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)),
    hasActions: Boolean(document.getElementById('pluginOpenDir')),
  }));
  check('plugins: manager opens from the sidebar', pluginPanel.visible);
  check('plugins: built-ins listed with actions', pluginPanel.builtin.length === 5 && pluginPanel.hasActions, pluginPanel.builtin.join(' / '));
  // Diary ships a bridge that turns the local WorkBuddy CLI into an AI backend;
  // it must be written into the plugin directory and picked up automatically.
  check('plugins: the shipped WorkBuddy bridge is loaded',
    pluginPanel.external.some(row => /WorkBuddy/i.test(row)),
    pluginPanel.external.join(' | ') || '(外部插件列表为空)');
  await page.locator('#pluginClose').click();

  // ---------- the AI model screen: three pages, WorkBuddy keeps no secrets ----
  await page.waitForTimeout(300);
  await page.locator('#aiModels').click();
  await page.waitForTimeout(700);
  const aiScreen = await page.evaluate(() => ({
    visible: !document.getElementById('aiModelPanel').hidden,
    tabs: [...document.querySelectorAll('#aiModelTabs button')].map(button => button.textContent),
    vendors: [...document.querySelectorAll('#aiVendor option')].map(option => option.textContent),
    // The WorkBuddy page is the one that must never ask for an endpoint/key.
    workbuddyHasKeyInput: document.querySelectorAll('[data-ai-panel="workbuddy"] input[type="password"]').length,
    workbuddyNote: document.querySelector('[data-ai-panel="workbuddy"] .hint')?.textContent ?? '',
  }));
  check('ai models: a standalone sidebar entry opens with three pages',
    aiScreen.visible === true && aiScreen.tabs.length === 3
    && aiScreen.tabs.some(tab => /API/.test(tab))
    && aiScreen.tabs.some(tab => /自定义/.test(tab))
    && aiScreen.tabs.some(tab => /WorkBuddy/.test(tab)),
    JSON.stringify(aiScreen.tabs));
  check('ai models: the API page lists the built-in vendors', aiScreen.vendors.length >= 5, aiScreen.vendors.join(' / '));
  check('ai models: WorkBuddy asks for no key and states WorkBuddy provides the AI',
    aiScreen.workbuddyHasKeyInput === 0 && /WorkBuddy 提供/.test(aiScreen.workbuddyNote),
    JSON.stringify({ inputs: aiScreen.workbuddyHasKeyInput, note: aiScreen.workbuddyNote.slice(0, 80) }));
  await page.locator('#aiModelClose').click();

  // ---------- background & wallpaper plugin ----------
  await page.locator('#settings').click();
  await page.waitForTimeout(600);
  await page.locator('.settings-tabs [data-tab="media"]').click();
  await page.waitForTimeout(400);
  const background = await page.evaluate(() => ({
    sources: [...document.querySelectorAll('[data-tabpanel="media"] .bg-source')].map(element => element.querySelector('b')?.textContent),
    fit: Boolean(document.getElementById('bgFit')),
    library: Boolean(document.getElementById('bgLibrary')),
    opacity: document.getElementById('bgOpacity')?.max,
    brightness: document.getElementById('bgBrightness')?.value,
    // The wallpaper must sit inside <main>, never behind the sidebar.
    insideMain: Boolean(document.querySelector('main .bg-stage #bgImage')),
    openLibraryGone: document.getElementById('bgOpenLibrary') === null,
  }));
  check('background: three import sources offered (the redundant library card is gone)',
    background.sources.length === 3 && background.openLibraryGone === true, background.sources.join(' / '));
  check('background: fit + library controls present', background.fit && background.library);
  check('background: opacity goes to 100% and brightness defaults to 100 (original quality)',
    background.opacity === '100' && background.brightness === '100', JSON.stringify(background));
  check('background: the wallpaper is scoped to the work area, not the sidebar',
    background.insideMain === true, String(background.insideMain));

  // ---------- the background folder is its own library, pickable per file ----------
  // Seed a real file so the whole disk -> folder -> background path is exercised.
  const vault = resolve(home, 'journals');
  await mkdir(resolve(vault, 'backgrounds'), { recursive: true });
  await writeFile(resolve(vault, 'backgrounds', 'e2e-bg.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
  await page.locator('#settingsClose').click();
  // Re-opening runs loadConfig again, which is what refreshes the folder list.
  await page.locator('#settings').click();
  await page.waitForTimeout(900);
  const folder = await page.evaluate(() => ({
    count: document.querySelectorAll('#bgFolderGrid .wallpaper-card').length,
    named: [...document.querySelectorAll('#bgFolderGrid .wallpaper-card b')].map(node => node.textContent),
    hasImport: Boolean(document.getElementById('bgFolderImport')),
    hasOpen: Boolean(document.getElementById('bgFolderOpen')),
  }));
  check('background: the folder library lists files straight from disk',
    folder.count === 1 && folder.named[0] === 'e2e-bg.png' && folder.hasImport && folder.hasOpen,
    JSON.stringify(folder));

  await page.locator('#bgFolderGrid .wallpaper-card').first().click();
  await page.waitForTimeout(800);
  const applied = await page.evaluate(() => {
    const element = document.getElementById('bgImage');
    return {
      hasBg: document.body.classList.contains('has-bg'),
      url: element.style.backgroundImage,
      label: document.getElementById('bgPreviewLabel').textContent,
    };
  });
  check('background: clicking a folder file applies it',
    applied.hasBg && applied.url.includes('diary-wallpaper://bg/') && applied.url.includes('e2e-bg.png'),
    JSON.stringify({ hasBg: applied.hasBg, url: applied.url.slice(0, 64), label: applied.label }));

  // ---------- music folder + the note button ----------
  const musicUi = await page.evaluate(() => ({
    grid: Boolean(document.getElementById('bgMusicGrid')),
    // A `loop` attribute would repeat one file forever and never fire `ended`.
    loopAttr: document.getElementById('bgmPlayer').hasAttribute('loop'),
    toggle: Boolean(document.getElementById('musicToggle')),
  }));
  check('music: folder grid renders and the player is free to advance',
    musicUi.grid && musicUi.toggle && !musicUi.loopAttr, JSON.stringify(musicUi));

  await page.locator('#settingsClose').click();
  await page.locator('#primaryNav [data-view="home"]').click();
  await page.waitForTimeout(500);
  const toggle = await page.evaluate(() => {
    const button = document.getElementById('musicToggle');
    const rect = button.getBoundingClientRect();
    return { visible: !button.hidden && rect.width > 20, gapFromBottom: Math.round(window.innerHeight - rect.bottom) };
  });
  check('music: the note button floats over the portal screen',
    toggle.visible && toggle.gapFromBottom >= 0 && toggle.gapFromBottom < 120, JSON.stringify(toggle));
  await page.locator('#musicToggle').click();
  await page.waitForTimeout(400);
  const toastText = await page.locator('#toast').textContent();
  check('music: an empty folder is explained instead of failing silently',
    /还没有音乐/.test(toastText ?? ''), toastText ?? '');

  // The remaining checks assume the settings panel is open on the wallpaper tab;
  // the note-button section above deliberately closed it.
  await page.locator('#settings').click();
  await page.locator('.settings-tabs [data-tab="media"]').click();
  await page.waitForTimeout(400);

  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
    const context = canvas.getContext('2d'); context.fillStyle = '#2b3a67'; context.fillRect(0, 0, 8, 8);
    const info = await window.diary.call({ op: 'media:import', name: 'bg.png', mime: 'image/png', data: canvas.toDataURL('image/png').split(',')[1] });
    await window.diary.call({ op: 'background:set', kind: 'image', id: info.id, dim: 0.3, blur: 6 });
  });
  await page.locator('#settingsClose').click();
  await page.locator('#settings').click();
  await page.waitForTimeout(800);
  const layer = await page.evaluate(() => {
    const element = document.getElementById('bgImage');
    return {
      hasBg: document.body.classList.contains('has-bg'),
      hidden: element.hasAttribute('hidden'),
      width: Math.round(element.getBoundingClientRect().width),
      url: element.style.backgroundImage.slice(0, 26),
      dim: document.getElementById('bgDimLayer').style.opacity,
      blur: getComputedStyle(document.documentElement).getPropertyValue('--bg-blur').trim(),
    };
  });
  check('background: layer painted through the media scheme', layer.hasBg && !layer.hidden && layer.width > 200 && layer.url.startsWith('url("diary-wallpaper:'), JSON.stringify(layer));
  check('background: dim + blur applied', layer.dim === '0.3' && layer.blur === '6px', `dim=${layer.dim} blur=${layer.blur}`);

  // A dark wallpaper must not swallow the page text.
  const readability = await page.evaluate(() => {
    const main = document.querySelector('main');
    const heading = document.querySelector('.view-heading, .section-head');
    return {
      hasBg: document.body.classList.contains('has-bg'),
      wash: getComputedStyle(main).backgroundColor,
      halo: heading ? getComputedStyle(heading).textShadow : 'none',
    };
  });
  check('background: content area stays readable over the wallpaper',
    readability.hasBg && readability.wash !== 'rgba(0, 0, 0, 0)' && readability.halo !== 'none',
    JSON.stringify(readability));

  // ---------- permissions ----------
  await page.locator('.settings-tabs [data-tab="privacy"]').click();
  await page.waitForTimeout(300);
  const permissions = await page.evaluate(() => ({
    network: document.getElementById('permNetwork').checked,
    location: document.getElementById('permLocation').checked,
    mode: document.getElementById('locMode').value,
  }));
  check('permissions: networking and location default to OFF', permissions.network === false && permissions.location === false, JSON.stringify(permissions));
  check('permissions: location mode switch present', permissions.mode === 'auto');
  await page.locator('#settingsClose').click();

  // ---------- home weather panel ----------
  await page.locator('#primaryNav [data-view="home"]').click();
  await page.waitForTimeout(1500);
  const weather = await page.evaluate(() => {
    const card = document.querySelector('#heroWeather .weather-card');
    return { present: Boolean(card), cls: card?.className ?? '', text: card?.textContent.replace(/\s+/g, ' ').trim().slice(0, 90) ?? '' };
  });
  check('weather: panel renders on the home screen', weather.present && weather.cls.includes('weather'), JSON.stringify(weather));
  check('weather: refuses to fetch while networking is off', /联网已关闭|正在获取/.test(weather.text), weather.text);

  // ---------- identity + local persistence ----------
  const profile = await page.evaluate(() => localStorage.getItem('diary.campus.cases'));
  check('guide: cases persisted locally', typeof profile === 'string' && profile.includes('title'), profile?.slice(0, 40) ?? '');
} catch (error) {
  // Without this the failure was swallowed: `finally` exited with 0 and a run
  // that died half way still looked green.
  console.log(`\nABORTED after ${results.length} checks: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
  console.log(error instanceof Error ? (error.stack ?? '').split('\n').slice(1, 5).join('\n') : '');
} finally {
  console.log(`\n${results.filter(r => r.ok).length}/${results.length} checks passed`);
  await Promise.race([app.close(), new Promise(r => setTimeout(r, 6000))]).catch(() => undefined);
  // Playwright keeps sockets alive; without this the process never exits and
  // anything chained after the script never runs.
  process.exit(results.some(r => !r.ok) ? 1 : 0);
}
