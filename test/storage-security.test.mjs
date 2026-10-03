import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  encryptContent, decryptContent, verifyPasscode, changePasscode,
  encryptBatch, decryptBatch, changeBatchPasscode, DecryptionError,
} from '../src/security/encryption.ts';
import { MarkdownEngine, parseMarkdown, serializeMarkdown } from '../src/storage/markdown-engine.ts';

test('AES-GCM round trip, randomness, wrong passcode and tampering', async () => {
  const text = '# 日记\n😊\r\n';
  const encrypted = await encryptContent(text, '123456');
  assert.equal(await decryptContent(encrypted, '123456'), text);
  assert.notEqual(await encryptContent(text, '123456'), encrypted);
  assert.equal(await verifyPasscode(encrypted, 'wrong'), false);
  assert.equal(await verifyPasscode(encrypted, '123456'), true);
  const header = JSON.parse(encrypted.split('\n')[1]);
  for (const field of ['salt', 'iv', 'data']) {
    const altered = { ...header, [field]: (header[field][0] === 'A' ? 'B' : 'A') + header[field].slice(1) };
    await assert.rejects(decryptContent('DIARY-ENC:1\n' + JSON.stringify(altered), '123456'), DecryptionError);
  }
  await assert.rejects(decryptContent(encrypted.replace('600000', '599999'), '123456'), DecryptionError);
  await assert.rejects(decryptContent(encrypted.replace('ENC:1', 'ENC:2'), '123456'), DecryptionError);
  assert.equal(await decryptContent(await encryptContent('', 'p'), 'p'), '');
  const large = '日记😊\n'.repeat(50_000);
  assert.equal(await decryptContent(await encryptContent(large, 'p'), 'p'), large);
  await assert.rejects(encryptContent('text', ''), TypeError);
});
test('passcode changes authenticate old key and confirm new key', async () => {
  const encrypted = await encryptContent('secret', 'old');
  await assert.rejects(changePasscode(encrypted, 'old', 'new', 'other'), /confirmation/);
  await assert.rejects(changePasscode(encrypted, 'wrong', 'new', 'new'), DecryptionError);
  const changed = await changePasscode(encrypted, 'old', 'new', 'new');
  assert.equal(await verifyPasscode(changed, 'old'), false);
  assert.equal(await decryptContent(changed, 'new'), 'secret');
});
test('batch order, partial errors, progress, cancellation and rotation', async () => {
  const files = [{ name: 'a.md', content: 'A' }, { name: 'b.md', content: 'B' }];
  const progress = [];
  const encrypted = await encryptBatch(files, 'old', { onProgress: event => progress.push(event.completed) });
  assert.deepEqual(progress, [1, 2]);
  assert.deepEqual(encrypted.map(file => file.name), ['a.md', 'b.md']);
  const changed = await changeBatchPasscode(encrypted, 'old', 'new', 'new');
  assert.deepEqual((await decryptBatch(changed, 'new')).map(file => file.content), ['A', 'B']);
  const mixed = await decryptBatch([encrypted[0], { name: 'bad.md', content: 'corrupt' }], 'old');
  assert.deepEqual(mixed.map(file => file.ok), [true, false]);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual((await encryptBatch(files, 'p', { signal: controller.signal })).map(file => file.ok), [false, false]);
  assert.deepEqual(await encryptBatch([], 'p'), []);
  await assert.rejects(encryptBatch([{ name: 'a.txt', content: '' }], 'p'), /\.md/);
  await assert.rejects(encryptBatch(files, 'p', { concurrency: 0 }), RangeError);
  await assert.rejects(encryptBatch(files, 'p', { onProgress: () => { throw new Error('observer'); } }), AggregateError);
  assert.equal(files[0].content, 'A');
});
test('frontmatter subset preserves body and rejects unsupported structures', () => {
  const document = { metadata: { title: '日记: #1', date: '2026-09-30', tags: ['日常', 'a'], score: 1, done: true, nil: null }, body: '---\r\n# 原样\r\n' };
  const parsed = parseMarkdown(serializeMarkdown(document));
  assert.deepEqual({ ...parsed.metadata }, document.metadata);
  assert.equal(parsed.body, document.body);
  assert.equal(parseMarkdown('\uFEFF---\r\ntitle: 今日\r\n---\r\n正文').body, '正文');
  assert.equal(parseMarkdown("---\ntitle: 'it''s fine'\n---\n").metadata.title, "it's fine");
  assert.equal(parseMarkdown('plain\r\n').body, 'plain\r\n');
  for (const source of ['---\na: 1\na: 2\n---\n', '---\na:\n  b: 1\n---\n', '---\na: |\n---\n', '---\na: [one, two]\n---\n', '---\na: 1']) {
    assert.throws(() => parseMarkdown(source), SyntaxError);
  }
  assert.throws(() => serializeMarkdown({ metadata: { x: Infinity }, body: '' }), TypeError);
  assert.equal(Object.getPrototypeOf(parseMarkdown('---\n__proto__: safe\n---\n').metadata), null);
});
test('local CRUD, encryption preservation, atomic failures and safe identifiers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'diary-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engine = await MarkdownEngine.open(directory);
  const document = { metadata: { title: '私密' }, body: '# Secret\n' };
  await engine.createEntry('今日', document, 'old');
  const initial = await readFile(join(directory, '今日.md'), 'utf8');
  assert.ok(!initial.includes('Secret'));
  await assert.rejects(engine.createEntry('今日', document), { code: 'EEXIST' });
  await assert.rejects(engine.updateEntry('今日', { body: 'bad' }, 'wrong'), DecryptionError);
  assert.equal(await readFile(join(directory, '今日.md'), 'utf8'), initial);
  await assert.rejects(engine.readEntry('今日'), /Passcode required/);
  const update = await engine.updateEntry('今日', { body: '# Updated' }, 'old');
  assert.equal(update.encrypted, true);
  assert.equal((await engine.readEntry('今日', 'old')).body, '# Updated');
  await engine.changeEntryPasscode('今日', 'old', 'new', 'new');
  await assert.rejects(engine.deleteEntry('今日', 'old'), DecryptionError);
  await engine.decryptEntry('今日', 'new');
  assert.equal((await engine.readEntry('今日')).encrypted, false);
  await assert.rejects(engine.encryptEntry('今日', 'p', 'q'), /confirmation/);
  await engine.encryptEntry('今日', 'p', 'p');
  assert.deepEqual(await engine.listEntries(), [{ id: '今日', encrypted: true }]);
  await engine.deleteEntry('今日', 'p');
  for (const id of ['../escape', 'a/b', 'C:evil', 'NUL', 'COM1', 'name.', 'x\\y']) {
    await assert.rejects(engine.createEntry(id, document), /Invalid entry id/);
  }
  await engine.createEntry('plain', document);
  await Promise.all([engine.updateEntry('plain', { body: 'new' }), engine.updateEntry('plain', { metadata: { n: 2 } })]);
  const plain = await engine.readEntry('plain');
  assert.equal(plain.body, 'new'); assert.equal(plain.metadata.n, 2);
  await writeFile(join(directory, 'broken.md'), 'DIARY-ENC:99\ninvalid');
  await assert.rejects(engine.updateEntry('broken', { body: 'overwrite' }, 'p'), DecryptionError);
  assert.deepEqual((await readdir(directory)).sort(), ['broken.md', 'plain.md']);
});
