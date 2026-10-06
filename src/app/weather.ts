// SPDX-License-Identifier: AGPL-3.0-only
// Shared weather presentation. The home-page panel and the diary-mode popover
// both quote the same metric list and write the same Markdown block, so this
// module owns the wording in exactly one place.

export type WeatherNow = {
  tempC: number; apparentC: number | null; code: number; description: string; icon: string;
  humidity: number | null; windKmh: number | null; windDir: number | null; windDirText: string;
  windScale: string; gustKmh: number | null; pressure: number | null; precipitation: number | null;
  cloudCover: number | null; uvIndex: number | null; visibilityKm: number | null; isDay: boolean;
  observedAt: string;
};
export type AirQuality = {
  aqi: number | null; level: string; color: string; advice: string;
  pm25: number | null; pm10: number | null; no2: number | null; o3: number | null;
  so2: number | null; co: number | null;
};
export type WeatherOk = {
  ok: true; lat: number; lon: number; place: string;
  weather: WeatherNow; air: AirQuality | null; fetchedAt: string;
};
export type WeatherFailure = { ok: false; reason: string; message: string };
export type WeatherReport = WeatherOk | WeatherFailure;

export function unit(value: number | null, suffix: string, round = true): string {
  return value === null ? '—' : `${round ? Math.round(value) : value}${suffix}`;
}

/** Every number the app quotes, so the card and the diary note never drift. */
export function weatherMetrics(w: WeatherNow): [string, string][] {
  return [
    ['温度', `${Math.round(w.tempC)}°C`],
    ['体感', w.apparentC === null ? '—' : `${Math.round(w.apparentC)}°C`],
    ['天气', w.description],
    ['风向', w.windDirText ? `${w.windDirText} ${w.windDir === null ? '' : `${Math.round(w.windDir)}°`}`.trim() : '—'],
    ['风力', w.windScale || '—'],
    ['风速', unit(w.windKmh, ' km/h')],
    ['阵风', unit(w.gustKmh, ' km/h')],
    ['湿度', unit(w.humidity, '%')],
    ['气压', unit(w.pressure, ' hPa')],
    ['能见度', unit(w.visibilityKm, ' km', false)],
    ['降水量', unit(w.precipitation, ' mm', false)],
    ['云量', unit(w.cloudCover, '%')],
    ['紫外线', unit(w.uvIndex, ' 级')],
  ];
}

/** Markdown block inserted into a diary entry. */
export function weatherToMarkdown(report: WeatherOk): string {
  const w = report.weather;
  const rows = weatherMetrics(w).map(([label, value]) => `| ${label} | ${value} |`);
  const air = report.air;
  const airRows = air ? [
    `| 空气质量 | ${air.aqi ?? '—'} · ${air.level} |`,
    `| PM2.5 | ${unit(air.pm25, ' µg/m³', false)} |`,
    `| PM10 | ${unit(air.pm10, ' µg/m³', false)} |`,
    `| 二氧化氮 | ${unit(air.no2, ' µg/m³', false)} |`,
    `| 臭氧 | ${unit(air.o3, ' µg/m³', false)} |`,
  ] : [];
  return [
    `## 天气记录 · ${report.place || '当前位置'}`,
    '',
    `${w.icon} **${w.description}**　${Math.round(w.tempC)}°C`,
    '',
    '| 指标 | 数值 |',
    '| --- | --- |',
    ...rows,
    ...airRows,
    ...(air ? ['', `> 空气质量建议：${air.advice}`] : []),
    `> 数据来源：Open-Meteo · 观测时间 ${w.observedAt || report.fetchedAt}`,
  ].join('\n');
}

/** One-line summary for compact UI such as the diary popover. */
export function weatherSummary(report: WeatherOk): string {
  const w = report.weather;
  const parts = [
    `${w.icon} ${w.description}`,
    `${Math.round(w.tempC)}°C`,
    w.apparentC === null ? '' : `体感 ${Math.round(w.apparentC)}°C`,
    w.windDirText ? `${w.windDirText}${w.windScale ? ` ${w.windScale}` : ''}` : '',
    w.humidity === null ? '' : `湿度 ${Math.round(w.humidity)}%`,
    report.air?.aqi == null ? '' : `空气 ${report.air.aqi} ${report.air.level}`,
  ];
  return parts.filter(Boolean).join(' · ');
}
