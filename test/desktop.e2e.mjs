import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _electron as electron, expect } from '@playwright/test';
import { resolve, join } from 'node:path';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { launchBrowserHost } from './browser-host.mjs';
import { zipSync, strToU8 } from 'fflate';

function samplePdf() {
  const stream='BT /F1 18 Tf 40 80 Td (School PDF) Tj ET\n';const objects=['1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n','2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n','3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n','4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',`5 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream\nendobj\n`];let pdf='%PDF-1.4\n',offsets=[0];for(const object of objects){offsets.push(Buffer.byteLength(pdf));pdf+=object;}const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(value=>String(value).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return [...Buffer.from(pdf)];
}
function sampleDocx(){return [...zipSync({'word/document.xml':strToU8('<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>学籍规定</w:t></w:r></w:p><w:p><w:r><w:t>缓考需要提交证明。</w:t></w:r></w:p></w:body></w:document>')})];}

test(`${process.env.DIARY_BROWSER_TEST ? 'Browser + real filesystem' : 'Electron'}: CRUD, restart persistence, encryption, preview and languages`, { timeout: 180000 }, async () => {
  await mkdir('work/ui-tests', { recursive: true });
  const home = await mkdtemp(resolve('work/ui-tests/run-'));
  const env = { ...process.env, DIARY_TEST_HOME: home, DIARY_TEST_VAULT: join(home, 'journals') };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.DIARY_EXE || resolve('node_modules/electron/dist/electron.exe');
  const args = process.env.DIARY_EXE ? [] : [resolve('.')];
  // Only the automated test process may opt out when the host cannot nest Chromium sandboxes.
  if (process.env.DIARY_TEST_NO_SANDBOX === '1') args.unshift('--no-sandbox');
  let app;
  const errors = [];
  try {
    const launch = () => process.env.DIARY_BROWSER_TEST ? launchBrowserHost(env.DIARY_TEST_VAULT) : electron.launch({ executablePath, args, env, timeout: 30000 });
    app = await launch();
    let page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    const lock = page.locator('#lockScreen');
    let lockShown = false;
    try { await lock.waitFor({ state: 'visible', timeout: 12000 }); lockShown = true; } catch { /* booted straight in */ }
    if (lockShown) {
      try { await page.screenshot({ path: '../releases/Diary-login.png', timeout: 8000 }); } catch { /* screenshot is best-effort */ }
      await expect(page.locator('#offlineCreate')).toBeVisible();
      await expect(page.locator('[data-login-provider="google"]')).toBeVisible();
      await page.locator('#offlineCreate').click();
      await page.locator('[name=username]').fill('lizhonghao');
      await page.locator('[name=next]').fill('local-test-123');
      await page.locator('[name=confirmation]').fill('local-test-123');
      await page.locator('#modalConfirm').click();
      await expect(lock).toBeHidden({ timeout: 15000 });
    }
    // A newly created account must receive the first-run guide. Verify both
    // top-right skip controls exist, then dismiss it so the legacy CRUD flow
    // below can continue and prove no underlying feature regressed.
    await expect(page.locator('.tutorial-layer')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#tutorialSkipModule')).toBeVisible();
    await expect(page.locator('#tutorialSkipAll')).toBeVisible();
    await page.locator('#tutorialSkipAll').click();
    await expect(page.locator('.tutorial-layer')).toBeHidden();
    const parsed=await page.evaluate(async ({pdf,docx})=>{const module=await import('./app/sources.js');const pdfSections=await module.extractSource('sample.pdf',new Uint8Array(pdf)),docxSections=await module.extractSource('sample.docx',new Uint8Array(docx));let damaged='';try{await module.extractSource('damaged.pdf',new Uint8Array([37,80,68,70,45,49]));}catch(error){damaged=String(error);}return{pdf:pdfSections.map(item=>item.text).join(' '),docx:docxSections.map(item=>item.text).join(' '),damaged};},{pdf:samplePdf(),docx:sampleDocx()});
    assert.match(parsed.pdf,/School PDF/);assert.match(parsed.docx,/缓考需要提交证明/);assert.ok(parsed.damaged);
    // Manual replay starts the complete guide, while module skipping reaches
    // the newly integrated VPN and pet steps without spawning a second guide.
    await page.locator('#tutorialButton').click();
    await expect(page.locator('#tutorialTitle')).toContainText('Diary 0.1.8');
    await page.locator('#tutorialSkipModule').click();
    await page.locator('#tutorialSkipModule').click();
    await expect(page.locator('#tutorialModule')).toHaveText('内置文件存储消化问答');
    await expect(page.locator('.school-source-library')).toHaveClass(/tutorial-target/);
    for (const selector of ['#schoolImport','#schoolSourceList','.source-library-tools','#portalPrompt','#schoolEvidence']) {
      await page.locator('#tutorialNext').click(); await expect(page.locator(selector)).toHaveClass(/tutorial-target/);
    }
    for (let i = 0; i < 6; i++) await page.locator('#tutorialSkipModule').click();
    await expect(page.locator('#tutorialModule')).toHaveText('学校 VPN');
    await expect(page.locator('#vpnButton')).toHaveClass(/tutorial-target/);
    for (const selector of ['.vpn-toolbar', '#vpnList', '.vpn-add', '.vpn-import-actions']) {
      await page.locator('#tutorialNext').click();
      await expect(page.locator(selector)).toHaveClass(/tutorial-target/);
    }
    await page.locator('#tutorialNext').click();
    await expect(page.locator('#tutorialModule')).toHaveText('桌面宠物');
    await expect(page.locator('#petButton')).toHaveClass(/tutorial-target/);
    for (const selector of ['#petList', '#petToggle', '.pet-import', '.petdex-footer']) {
      await page.locator('#tutorialNext').click();
      await expect(page.locator(selector)).toHaveClass(/tutorial-target/);
    }
    await page.locator('#tutorialNext').click();
    await expect(page.locator('#tutorialModule')).toHaveText('查找校园竞赛');
    await expect(page.locator('#campusCompetitionOpen')).toHaveClass(/tutorial-target/);
    await page.locator('#tutorialSkipAll').click();
    await expect(page.locator('.tutorial-layer')).toBeHidden();
    await page.locator('#vpnButton').click();
    await page.locator('#vpnSearch').fill('清华');
    await expect(page.locator('.vpn-card')).toHaveCount(1);
    await expect(page.locator('.vpn-card')).toContainText('清华大学');
    await page.locator('#petButton').click();
    await expect(page.locator('.pet-card')).toContainText('Diary 小爪');
    await expect(page.locator('#petdexLink')).toHaveAttribute('href', 'https://petdex.dev/zh');
    const sourceId='12345678-1234-1234-1234-123456789abc',sourceText='缓考申请需要在考试前向教务处提交证明材料。';
    await page.evaluate(async ({sourceId,sourceText})=>{const bytes=new TextEncoder().encode(sourceText),data=btoa(String.fromCharCode(...bytes)),checksum=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');await window.diary.call({op:'sources:save',source:{id:sourceId,name:'学生规定.txt',extension:'txt',size:bytes.length,department:'教务处',schoolId:'demo',schoolName:'示例大学',importedAt:new Date().toISOString(),checksum,parseStatus:'ready',analysis:{status:'not_requested',summary:'',topics:[],keywords:[],updatedAt:null},sections:[{label:'正文',text:sourceText}],data}});},{sourceId,sourceText});
    await page.locator('#primaryNav [data-view="chat"]').click();
    await expect(page.locator('.school-source-row')).toContainText('学生规定.txt');
    await page.locator('#schoolSourceSearch').fill('示例大学'); await expect(page.locator('.school-source-row')).toHaveCount(1);
    await page.locator('#schoolSourceFilter').selectOption('pdf'); await expect(page.locator('.school-source-row')).toHaveCount(0);
    await page.locator('#schoolSourceFilter').selectOption('txt'); await page.locator('#schoolSourceSearch').fill('');
    await page.locator('.source-scope').check(); await page.locator('#portalPrompt').fill('缓考需要什么材料？'); await page.locator('#portalSend').click();
    await expect(page.locator('#portalConversation .bubble-citations')).toContainText('学生规定.txt',{timeout:30000});
    await page.locator('[data-view="diary"]').first().click();
    await expect(page.locator('#firstEntry')).toBeVisible();
    await page.locator('#firstEntry').click();
    await page.locator('#title').fill('把今天，写进日记');
    await page.locator('#editor').fill('# 九月的最后一天\n\n窗边的光刚刚好，给自己留一点安静的时间。\n\n## 今天的小确幸\n- 读了几页喜欢的书\n- 喝到一杯温热的咖啡\n- 完成了想做的小事\n\n> 不必每一天都特别，但每一天都值得被记住。\n\n**明天，也要好好生活。**');
    await page.locator('#save').click();
    await expect(page.locator('#saveState')).toHaveText('已保存到此设备');
    assert.equal((await readdir(join(home, 'journals'))).filter(name => name.endsWith('.md')).length, 1);
    await page.locator('#previewTab').click();
    await expect(page.locator('#preview h1')).toHaveText('九月的最后一天');
    try { await page.screenshot({ path: '../releases/Diary-preview.png', timeout: 8000 }); } catch { /* screenshot is best-effort */ }
    await page.locator('#editTab').click();
    await page.locator('#encrypt').click();
    await page.locator('[name=next]').fill('diary-test-123');
    await page.locator('[name=confirmation]').fill('diary-test-123');
    await page.locator('#modalConfirm').click();
    await expect(page.locator('#securityBadge')).toHaveText('● 已加密');
    const file = (await readdir(join(home, 'journals'))).find(name => name.endsWith('.md'));
    const raw = await readFile(join(home, 'journals', file), 'utf8');
    assert.ok(raw.startsWith('DIARY-ENC:1\n'));
    assert.ok(!raw.includes('小确幸'));
    await page.locator('#lock').click();
    await expect(page.locator('#workspace')).toBeHidden();
    await app.close();

    app = await launch();
    page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    const lock2 = page.locator('#lockScreen');
    let lockShown2 = false;
    try { await lock2.waitFor({ state: 'visible', timeout: 12000 }); lockShown2 = true; } catch { /* remembered session skipped the lock */ }
    if (lockShown2) {
      await page.locator('#authUsername').fill('lizhonghao');
      await page.locator('#authPasscode').fill('local-test-123');
      await page.locator('#authSubmit').click();
      await expect(lock2).toBeHidden({ timeout: 15000 });
    }
    await page.locator('[data-view="diary"]').first().click();
    await page.locator('.entry-card').click();
    await page.locator('[name=password]').fill('wrong'); await page.locator('#modalConfirm').click();
    await expect(page.locator('#toast')).toContainText('密码错误');
    await page.locator('.entry-card').click();
    await page.locator('[name=password]').fill('diary-test-123'); await page.locator('#modalConfirm').click();
    await expect(page.locator('#title')).toHaveValue('把今天，写进日记');
    await page.locator('#editor').fill('Updated **Markdown**\n<script>window.injected=true</script>');
    await page.locator('#save').click(); await expect(page.locator('#saveState')).toHaveText('已保存到此设备');
    await page.locator('#previewTab').click();
    await expect(page.locator('#preview strong')).toHaveText('Markdown');
    assert.equal(await page.evaluate(() => window.injected), undefined);
    // Regression: the three-dot menu must dismiss when the user clicks beside
    // it, while remaining fully usable when clicked again.
    await page.locator('#more').click();
    await expect(page.locator('#moreMenu')).toBeVisible();
    await page.locator('#title').click();
    await expect(page.locator('#moreMenu')).toBeHidden();
    await page.locator('#more').click(); await page.locator('#changePassword').click();
    await page.locator('[name=old]').fill('diary-test-123'); await page.locator('[name=next]').fill('diary-test-456');
    await page.locator('[name=confirmation]').fill('diary-test-456'); await page.locator('#modalConfirm').click();
    await expect(page.locator('#toast')).toHaveText('操作完成');
    await page.locator('#settings').click(); await page.locator('.settings-tabs button[data-tab="lang"]').click();
    await page.evaluate(() => { document.documentElement.style.setProperty('--chrome-font-color', '#123456'); document.documentElement.style.setProperty('--chrome-font-scale', '1.25'); });
    await page.locator('#cfgLocale').selectOption('en-US');
    await expect(page.locator('#save')).toHaveText('Save');
    await expect(page.locator('#primaryNav [data-view="home"] b')).toHaveText('Home');
    assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.documentElement).getPropertyValue('--chrome-font-color').trim(), getComputedStyle(document.documentElement).getPropertyValue('--chrome-font-scale').trim()]), ['#123456','1.25']);
    await page.locator('#settingsClose').click();
    await page.reload(); await expect(page.locator('#primaryNav [data-view="home"] b')).toHaveText('Home');
    for (const view of ['home','chat','search-view','competition','guide','diary','home','diary']) await page.locator(`#primaryNav [data-view="${view}"]`).click();
    await expect(page.locator('#diaryView')).toBeVisible();
    await page.locator('.entry-card').click();
    await page.locator('[name=password]').fill('diary-test-456'); await page.locator('#modalConfirm').click();
    await page.locator('#theme').click(); await expect(page.locator('body')).toHaveClass('dark');
    await page.locator('#more').click(); await page.locator('#delete').click(); await page.locator('#modalConfirm').click();
    await expect(page.locator('.entry-card')).toHaveCount(0);
    assert.equal((await readdir(join(home, 'journals'))).filter(name => name.endsWith('.md')).length, 0);
    assert.deepEqual(errors, []);
    await writeFile(join(home, 'test-result.json'), JSON.stringify({ ok: true, executablePath, errors }, null, 2));
  } finally { if (app) await app.close(); }
});
