import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SchoolDirectory } from '../src/host/school-directory.ts';
import { fetchCampusCompetitions, validateCampusTarget, CampusFetchError } from '../src/host/campus-info.ts';
import { BUILTIN_SCHOOLS, safeWebUrl } from '../src/app/schools.ts';

const publicLookup = async () => [{ address: '203.0.113.8' }];

test('school directory migrates, deduplicates, searches, edits and persists custom schools', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'diary-school-'));
  const directory = new SchoolDirectory(vault);
  const legacy = { name: '示例大学', aliases: ['EXU'], officialUrl: 'https://www.example.edu/', url: 'https://vpn.example.edu/' };
  const migrated = await directory.migrate([legacy, legacy, { name: '坏数据', url: 'javascript:alert(1)' }]);
  assert.equal(migrated.added, 1); assert.equal(migrated.duplicates, 1);
  assert.equal((await directory.list('EXU'))[0].name, '示例大学');
  const custom = (await directory.list()).find(item => item.name === '示例大学');
  const edited = await directory.upsert({ ...custom, name: '示例科技大学' });
  assert.equal((await new SchoolDirectory(vault).get(edited.id)).name, '示例科技大学');
  await directory.remove(edited.id);
  assert.equal(await directory.get(edited.id), null);
  await assert.rejects(() => directory.remove('pku'), /内置学校不能删除/);
  assert.equal(JSON.parse(await readFile(join(vault, 'school-directory.json'), 'utf8')).custom.length, 0);
});

test('URL validation blocks executable, credential, local and private targets', async () => {
  for (const value of ['javascript:alert(1)', 'file:///tmp/a', 'http://127.0.0.1/', 'https://192.168.1.2/', 'https://user:pass@example.edu/']) assert.equal(safeWebUrl(value), null);
  await assert.rejects(() => validateCampusTarget('https://campus.example.edu/', 'example.edu', async () => [{ address: '10.0.0.8' }]), error => error instanceof CampusFetchError && error.code === 'private_network');
  await assert.rejects(() => validateCampusTarget('https://evil-example.edu/', 'example.edu', publicLookup), error => error instanceof CampusFetchError && error.code === 'invalid_url');
});

test('campus fetch parses official announcements, records sources and drops off-domain links', async () => {
  const school = { ...BUILTIN_SCHOOLS[0], officialUrl: 'https://www.example.edu/' };
  const html = '<p>2026-10-08</p><a href="/notice/1">大学生创新创业竞赛报名通知</a><a href="https://evil-example.edu/x">校级程序设计比赛</a>';
  const items = await fetchCampusCompetitions(school, { lookup: publicLookup, retries: 0, fetch: async () => new Response(html, { headers: { 'content-type': 'text/html' } }) });
  assert.equal(items.length, 1); assert.equal(items[0].sourceUrl, 'https://www.example.edu/notice/1');
  assert.equal(items[0].publishedAt, '2026-10-08'); assert.ok(!Number.isNaN(Date.parse(items[0].fetchedAt)));
});

test('campus fetch exposes permission, redirect and timeout failures without bypassing access', async () => {
  const school = { ...BUILTIN_SCHOOLS[0], officialUrl: 'https://www.example.edu/' };
  await assert.rejects(() => fetchCampusCompetitions(school, { lookup: publicLookup, retries: 0, fetch: async () => new Response('', { status: 403 }) }), error => error instanceof CampusFetchError && error.code === 'forbidden' && /不会读取 Cookie/.test(error.message));
  await assert.rejects(() => fetchCampusCompetitions(school, { lookup: publicLookup, retries: 0, fetch: async () => new Response('', { status: 302, headers: { location: 'https://attacker.example/x' } }) }), error => error instanceof CampusFetchError && error.code === 'invalid_url');
  await assert.rejects(() => fetchCampusCompetitions(school, { lookup: publicLookup, retries: 0, fetch: async () => { throw new DOMException('timed out', 'TimeoutError'); } }), error => error instanceof CampusFetchError && error.code === 'timeout');
});
