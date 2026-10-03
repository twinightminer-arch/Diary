import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, OpenAICompatibleProvider, DeepSeekProvider } from '../src/agent/connectors.ts';
import { ProviderError } from '../src/agent/provider.ts';

const openaiCfg = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };

function mockFetch(handler) {
  return (async (url, init) => {
    const result = handler(url, init);
    return new Response(JSON.stringify(result.body ?? {}), { status: result.status ?? 200 });
  });
}

test('chat returns assistant content and forwards model/headers', async () => {
  let seen;
  const fetchImpl = mockFetch((url, init) => {
    seen = { url, init };
    return { body: { choices: [{ message: { content: 'Hello from model' } }] } };
  });
  const p = new OpenAICompatibleProvider('openai', openaiCfg, 'sk-x', fetchImpl);
  const text = await p.chat([{ role: 'user', content: 'hi' }]);
  assert.equal(text, 'Hello from model');
  assert.equal(seen.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(seen.init.headers.authorization, 'Bearer sk-x');
  assert.match(seen.init.body, /"model":"gpt-4o-mini"/);
});

test('generateImage returns base64 payload', async () => {
  const fetchImpl = mockFetch(() => ({ body: { data: [{ b64_json: 'QUJD' }] } }));
  const p = new OpenAICompatibleProvider('openai', openaiCfg, 'sk-x', fetchImpl);
  const img = await p.generateImage('a cat');
  assert.equal(img.b64, 'QUJD');
  assert.equal(img.mime, 'image/png');
});

test('non-ok response throws ProviderError with status', async () => {
  const fetchImpl = mockFetch(() => ({ status: 401, body: { error: 'nope' } }));
  const p = new OpenAICompatibleProvider('openai', openaiCfg, 'sk-x', fetchImpl);
  await assert.rejects(() => p.chat([{ role: 'user', content: 'hi' }]), (e) => e instanceof ProviderError && e.status === 401);
});

test('DeepSeek image generation is unsupported; factory selects provider', async () => {
  const cfg = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' };
  const ds = new DeepSeekProvider('deepseek', cfg, 'sk-x');
  await assert.rejects(() => ds.generateImage('x'), /image generation/i);
  const created = createProvider('deepseek', cfg, 'sk-x');
  assert.ok(created instanceof DeepSeekProvider);
  assert.throws(() => createProvider('openai', openaiCfg, ''), ProviderError);
});
