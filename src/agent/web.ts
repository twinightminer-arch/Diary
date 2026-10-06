// SPDX-License-Identifier: AGPL-3.0-only
type FetchLike = typeof fetch;
const realFetch: FetchLike = (...args: Parameters<typeof fetch>) => fetch(...args);

export interface WeatherNow {
  readonly tempC: number;
  readonly code: number;
  readonly description: string;
  readonly humidity: number | null;
  readonly windKmh: number | null;
}
export interface Place {
  readonly city: string;
  readonly country: string;
}

// WMO weather interpretation codes (Open-Meteo / ECMWF).
const WEATHER_TEXT: Record<number, string> = {
  0: '晴', 1: '大致晴朗', 2: '局部多云', 3: '阴',
  45: '有雾', 48: '雾凇', 51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨', 61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨', 71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹',
};

export function today(locale = 'zh-CN'): { iso: string; label: string } {
  const now = new Date();
  const iso = now.toISOString().slice(0, 10);
  const label = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(now);
  return { iso, label };
}

export async function getWeather(lat: number, lon: number, fetchImpl: FetchLike = realFetch): Promise<WeatherNow> {
  const url = `https://api.openmeteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Weather request failed (${response.status})`);
  const json = await response.json() as {
    current?: { temperature_2m?: number; weather_code?: number; relative_humidity_2m?: number; wind_speed_10m?: number };
  };
  const current = json.current ?? {};
  const code = current.weather_code ?? 0;
  return {
    tempC: current.temperature_2m ?? 0,
    code,
    description: WEATHER_TEXT[code] ?? '未知',
    humidity: current.relative_humidity_2m ?? null,
    windKmh: current.wind_speed_10m ?? null,
  };
}

export async function reverseGeocode(lat: number, lon: number, fetchImpl: FetchLike = realFetch): Promise<Place | null> {
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh`;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    const json = await response.json() as { city?: string; locality?: string; countryName?: string };
    const city = json.city || json.locality || '';
    return { city, country: json.countryName || '' };
  } catch { return null; }
}

/**
 * Best-effort web answer. When a provider with chat is available, it answers from its training;
 * otherwise returns a local note. Real grounded search needs a provider that exposes a web tool.
 */
export async function webSearch(query: string, ask?: (prompt: string) => Promise<string>): Promise<string> {
  if (ask) return ask(`请简洁回答以下问题（如涉及实时信息请说明来源或不确定性）：${query}`);
  return `未能联网检索「${query}」：当前未配置可用的 AI 检索服务。日期与天气可离线/免密钥获取。`;
}
