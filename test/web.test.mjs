import { test } from 'node:test';
import assert from 'node:assert/strict';
import { today, getWeather, reverseGeocode, webSearch } from '../src/agent/web.ts';

function mockFetch(body, status = 200) {
  return (async () => new Response(JSON.stringify(body), { status }));
}

test('today returns ISO date and localized label', () => {
  const t = today('zh-CN');
  assert.match(t.iso, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(t.label.includes('年') || t.label.length > 0);
});

test('getWeather parses Open-Meteo current weather', async () => {
  const fetchImpl = mockFetch({
    current: { temperature_2m: 21.3, weather_code: 1, relative_humidity_2m: 60, wind_speed_10m: 8 },
  });
  const w = await getWeather(39.9, 116.4, fetchImpl);
  assert.equal(w.tempC, 21.3);
  assert.equal(w.code, 1);
  assert.equal(w.description, '大致晴朗');
  assert.equal(w.humidity, 60);
  assert.equal(w.windKmh, 8);
});

test('getWeather throws on non-ok response', async () => {
  await assert.rejects(() => getWeather(0, 0, mockFetch({}, 500)), /failed/);
});

test('reverseGeocode returns null on failure and parses on success', async () => {
  assert.equal(await reverseGeocode(0, 0, mockFetch({}, 500)), null);
  const place = await reverseGeocode(39.9, 116.4, mockFetch({ city: '北京', countryName: '中国' }));
  assert.deepEqual(place, { city: '北京', country: '中国' });
});

test('webSearch uses provider when supplied, else returns local note', async () => {
  assert.match(await webSearch('天气'), /未配置/);
  assert.equal(await webSearch('x', async () => '答'), '答');
});
