import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractSource, searchSources } from '../dist/app/sources.js';
import { saveSource, listSources, deleteSource } from '../dist/host/sources.js';

test('text extraction rejects empty and invalid files', async () => {
  const encoded = new TextEncoder().encode('缓考申请须先联系学院教务办。');
  assert.deepEqual(await extractSource('通知.txt', encoded), [{ label: '正文', text: '缓考申请须先联系学院教务办。' }]);
  await assert.rejects(extractSource('空白.txt', new TextEncoder().encode(' \n ')), /未提取到/);
  await assert.rejects(extractSource('旧格式.doc', encoded), /仅支持/);
});

test('retrieval favors relevant sections and excludes deleted records', async () => {
  const vault = await mkdtemp(join(tmpdir(), 'diary-sources-'));
  const first = {
    id: '11111111-1111-4111-8111-111111111111', name: '缓考规定.txt', department: '教务处', importedAt: new Date().toISOString(),
    sections: [{ label: '第二条', text: '申请缓考需要提交医院证明。' }], data: Buffer.from('申请缓考需要提交医院证明。').toString('base64'),
  };
  const second = {
    id: '22222222-2222-4222-8222-222222222222', name: '图书馆通知.txt', department: '图书馆', importedAt: new Date().toISOString(),
    sections: [{ label: '正文', text: '借阅图书须按时归还。' }], data: Buffer.from('借阅图书须按时归还。').toString('base64'),
  };
  try {
    await saveSource(vault, first);
    await saveSource(vault, second);
    const stored = await listSources(vault);
    assert.equal(stored.length, 2);
    assert.equal('data' in stored[0], false);
    assert.equal(searchSources('缓考需要什么证明', stored)[0]?.source.id, first.id);
    await deleteSource(vault, first.id);
    assert.equal(searchSources('缓考需要什么证明', await listSources(vault)).length, 0);
  } finally { await rm(vault, { recursive: true, force: true }); }
});
