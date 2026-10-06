// SPDX-License-Identifier: AGPL-3.0-only
type FetchLike = typeof fetch;
const realFetch: FetchLike = (...args: Parameters<typeof fetch>) => fetch(...args);

export interface WeatherNow {
  readonly tempC: number;
  readonly apparentC: number | null;
  readonly code: number;
  readonly description: string;
  readonly icon: string;
  readonly humidity: number | null;
  readonly windKmh: number | null;
  readonly windDir: number | null;
  readonly windDirText: string;
  readonly windScale: string;
  readonly gustKmh: number | null;
  readonly pressure: number | null;
  readonly precipitation: number | null;
  readonly cloudCover: number | null;
  readonly uvIndex: number | null;
  readonly visibilityKm: number | null;
  readonly isDay: boolean;
  readonly observedAt: string;
}
export interface AirQuality {
  readonly aqi: number | null;
  readonly level: string;
  readonly color: string;
  readonly advice: string;
  readonly pm25: number | null;
  readonly pm10: number | null;
  readonly no2: number | null;
  readonly o3: number | null;
  readonly so2: number | null;
  readonly co: number | null;
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
const WEATHER_ICON: Record<number, string> = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️', 45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌦️', 55: '🌧️', 56: '🌧️', 57: '🌧️',
  61: '🌦️', 63: '🌧️', 65: '🌧️', 66: '🌧️', 67: '🌧️',
  71: '🌨️', 73: '❄️', 75: '❄️', 77: '❄️',
  80: '🌦️', 81: '🌧️', 82: '⛈️', 85: '🌨️', 86: '🌨️',
  95: '⛈️', 96: '⛈️', 99: '⛈️',
};

/** 8-point compass, which is how wind is described in Chinese. */
const WIND_DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
export function windDirectionText(degrees: number | null): string {
  if (degrees === null || !Number.isFinite(degrees)) return '';
  return `${WIND_DIRS[Math.round(((degrees % 360) + 360) % 360 / 45) % 8]}风`;
}
/** Beaufort scale — the number people actually quote in a forecast. */
export function windScale(kmh: number | null): string {
  if (kmh === null || !Number.isFinite(kmh)) return '';
  const steps = [1, 5, 11, 19, 28, 38, 49, 61, 74, 88, 102, 117];
  let level = 0;
  for (const limit of steps) { if (kmh >= limit) level += 1; }
  return `${level} 级`;
}
/** Chinese AQI bands, applied to Open-Meteo's US AQI. */
export function aqiBand(aqi: number | null): { level: string; color: string; advice: string } {
  if (aqi === null || !Number.isFinite(aqi)) return { level: '暂无数据', color: '#8290a6', advice: '空气质量数据不可用。' };
  if (aqi <= 50) return { level: '优', color: '#31a24c', advice: '空气很好，适合开窗通风与户外活动。' };
  if (aqi <= 100) return { level: '良', color: '#c9a227', advice: '空气可接受，敏感人群可减少长时间户外活动。' };
  if (aqi <= 150) return { level: '轻度污染', color: '#e08b2f', advice: '敏感人群建议减少户外运动，外出可戴口罩。' };
  if (aqi <= 200) return { level: '中度污染', color: '#d64545', advice: '建议减少户外活动，关闭门窗。' };
  if (aqi <= 300) return { level: '重度污染', color: '#8e44ad', advice: '尽量避免外出，务必佩戴防护口罩。' };
  return { level: '严重污染', color: '#7a2f2f', advice: '留在室内并开启空气净化设备。' };
}

export function today(locale = 'zh-CN'): { iso: string; label: string } {
  const now = new Date();
  const iso = now.toISOString().slice(0, 10);
  const label = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(now);
  return { iso, label };
}

const CURRENT_FIELDS = [
  'temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'is_day',
  'precipitation', 'weather_code', 'cloud_cover', 'pressure_msl',
  'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'visibility',
].join(',');

export async function getWeather(lat: number, lon: number, fetchImpl: FetchLike = realFetch): Promise<WeatherNow> {
  // The host must be api.open-meteo.com: the hyphen-less spelling does not resolve.
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + `&current=${CURRENT_FIELDS}&daily=uv_index_max&forecast_days=1&timezone=auto`;
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`Weather request failed (${response.status})`);
  const json = await response.json() as {
    current?: Record<string, number | string | undefined>;
    daily?: { uv_index_max?: (number | null)[] };
  };
  const current = json.current ?? {};
  const number = (key: string): number | null => {
    const value = current[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const code = number('weather_code') ?? 0;
  const windKmh = number('wind_speed_10m');
  const windDir = number('wind_direction_10m');
  const visibilityM = number('visibility');
  return {
    tempC: number('temperature_2m') ?? 0,
    apparentC: number('apparent_temperature'),
    code,
    description: WEATHER_TEXT[code] ?? '未知',
    icon: WEATHER_ICON[code] ?? '🌡️',
    humidity: number('relative_humidity_2m'),
    windKmh,
    windDir,
    windDirText: windDirectionText(windDir),
    windScale: windScale(windKmh),
    gustKmh: number('wind_gusts_10m'),
    pressure: number('pressure_msl'),
    precipitation: number('precipitation'),
    cloudCover: number('cloud_cover'),
    uvIndex: json.daily?.uv_index_max?.[0] ?? null,
    visibilityKm: visibilityM === null ? null : Math.round(visibilityM / 100) / 10,
    isDay: (number('is_day') ?? 1) === 1,
    observedAt: typeof current.time === 'string' ? current.time : '',
  };
}

/** Open-Meteo air quality: AQI plus the pollutants people ask about by name. */
export async function getAirQuality(lat: number, lon: number, fetchImpl: FetchLike = realFetch): Promise<AirQuality | null> {
  const fields = 'european_aqi,us_aqi,pm10,pm2_5,nitrogen_dioxide,sulphur_dioxide,ozone,carbon_monoxide';
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&current=${fields}&timezone=auto`;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) return null;
    const json = await response.json() as { current?: Record<string, number | undefined> };
    const current = json.current ?? {};
    const pick = (key: string): number | null => {
      const value = current[key];
      return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
    };
    // US AQI is the scale closest to the Chinese bands users expect.
    const aqi = pick('us_aqi') ?? pick('european_aqi');
    const band = aqiBand(aqi);
    return { aqi, level: band.level, color: band.color, advice: band.advice, pm25: pick('pm2_5'), pm10: pick('pm10'), no2: pick('nitrogen_dioxide'), o3: pick('ozone'), so2: pick('sulphur_dioxide'), co: pick('carbon_monoxide') };
  } catch { return null; }
}

/**
 * Rough position from the network, used when the user allows location but the
 * app has no GPS. Returns null on any failure so callers fall back to manual
 * coordinates.
 */
export async function locateByIp(fetchImpl: FetchLike = realFetch): Promise<{ lat: number; lon: number; label: string } | null> {
  for (const url of [
    'https://ipwho.is/?fields=success,city,region,country,latitude,longitude',
    'https://ipapi.co/json/',
  ]) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) continue;
      const json = await response.json() as { success?: boolean; city?: string; region?: string; country?: string; latitude?: number; longitude?: number };
      if (json.success === false) continue;
      if (typeof json.latitude !== 'number' || typeof json.longitude !== 'number') continue;
      const label = [json.city, json.region].filter(Boolean).join(' · ') || json.country || '';
      return { lat: json.latitude, lon: json.longitude, label };
    } catch { /* try the next provider */ }
  }
  return null;
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
