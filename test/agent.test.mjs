import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostConfig } from '../src/host/config.ts';
import { buildAgent } from '../src/agent/skills.ts';

function mockFetch(url) {
  const target = String(url);
  if (target.includes('chat/completions')) return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: 'AI 日记草稿' } }] }), { status: 200 }));
  if (target.includes('images/generations')) return Promise.resolve(new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('PNGDATA').toString('base64') }] }), { status: 200 }));
  if (target.includes('air-quality-api.open-meteo.com')) {
    return Promise.resolve(new Response(JSON.stringify({ current: { us_aqi: 42, pm2_5: 12.5, pm10: 20, ozone: 60 } }), { status: 200 }));
  }
  // The host is api.open-meteo.com — a hyphen-less spelling does not resolve.
  if (target.includes('api.open-meteo.com')) {
    return Promise.resolve(new Response(JSON.stringify({
      current: {
        temperature_2m: 20, weather_code: 0, relative_humidity_2m: 55, apparent_temperature: 21,
        wind_speed_10m: 12, wind_direction_10m: 135, wind_gusts_10m: 24, pressure_msl: 1012,
        precipitation: 0, cloud_cover: 15, visibility: 20000, is_day: 1, time: '2026-10-06T10:00',
      },
      daily: { uv_index_max: [4] },
    }), { status: 200 }));
  }
  return Promise.resolve(new Response('{}', { status: 200 }));
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'diary-agent-'));
  const config = await HostConfig.open(root);
  await config.setSecret('openai', 'sk-test');
  config.activeProvider = 'openai';
  const vault = join(root, 'vault');
  const agent = buildAgent({ vault, config, fetchImpl: mockFetch });
  return { root, config, vault, agent, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('compose calls provider chat and returns text', async () => {
  const { agent, cleanup } = await setup();
  try {
    const text = await agent.api.compose({ messages: [{ role: 'user', content: '今天天气好' }] });
    assert.equal(text, 'AI 日记草稿');
  } finally { cleanup(); }
});

test('illustrate generates, stores media and returns a data url', async () => {
  const { agent, vault, cleanup } = await setup();
  try {
    const result = await agent.api.illustrate('山间清晨');
    assert.ok(result.dataUrl.startsWith('data:image/png;base64,'));
    assert.match(result.id, /\.png$/);
    const media = await readdir(join(vault, 'media'));
    assert.equal(media.length, 1);
  } finally { cleanup(); }
});

test('web date and weather route correctly', async () => {
  const { agent, cleanup } = await setup();
  try {
    const date = await agent.api.web({ kind: 'date', locale: 'zh-CN' });
    assert.match(date.iso, /^\d{4}-\d{2}-\d{2}$/);
    const weather = await agent.api.web({ kind: 'weather', lat: 39.9, lon: 116.4 });
    assert.equal(weather.tempC, 20);
    assert.equal(weather.description, '晴');
    // The panel quotes these, so they must survive the round trip.
    assert.equal(weather.humidity, 55);
    assert.equal(weather.windDirText, '东南风');
    assert.equal(weather.windScale, '3 级');
    assert.equal(weather.apparentC, 21);
    assert.equal(weather.uvIndex, 4);
    assert.equal(weather.visibilityKm, 20);
    assert.equal(weather.isDay, true);
    const air = await agent.api.web({ kind: 'air', lat: 39.9, lon: 116.4 });
    assert.equal(air.aqi, 42);
    assert.equal(air.level, '优');
    assert.equal(air.pm25, 12.5);
  } finally { cleanup(); }
});

test('layout applies journal template with date header', async () => {
  const { agent, cleanup } = await setup();
  try {
    const out = await agent.api.layout({ markdown: '今天很开心。', template: 'journal' });
    assert.match(out, /^# \d{4}-\d{2}-\d{2}/);
  } finally { cleanup(); }
});
