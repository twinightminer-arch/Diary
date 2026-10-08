// SPDX-License-Identifier: AGPL-3.0-only
// 竞赛中心「报名官网直达」的纯逻辑：链接校验、从模型回答里抽取官网地址、
// 以及本地缓存读写。刻意与 DOM 无关，方便单独测试与复用。
export type CompetitionSite = { url: string; updatedAt: number };

export const SITE_CACHE_KEY = 'diary.portal.competitionSites';
/** 缓存一周后视为过期，会重新联网确认。 */
export const SITE_TTL = 1000 * 60 * 60 * 24 * 7;

/**
 * 规范化并校验一个候选链接；非 http/https 或不像域名的返回空串。
 * 同时剥掉中文/英文句读结尾，模型常把链接和标点一起返回。
 */
export function normalizeSiteUrl(raw: string): string {
  const trimmed = (raw ?? '').trim().replace(/[.,;:!?。，；：！？、）)】\]》>"'’]+$/g, '');
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    if (!url.hostname.includes('.')) return '';
    return url.href;
  } catch {
    return '';
  }
}

/** 从模型回答里挑出第一条合法 http(s) 链接。 */
export function extractSiteUrl(answer: string): string {
  const matches = (answer ?? '').match(/https?:\/\/[^\s"'<>()（）\[\]【】]+/gi) ?? [];
  for (const candidate of matches) {
    const url = normalizeSiteUrl(candidate);
    if (url) return url;
  }
  return '';
}

/** 读取缓存；环境没有 localStorage（测试 / 无 DOM）时返回空表。 */
export function readSiteCache(): Record<string, CompetitionSite> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const value = JSON.parse(localStorage.getItem(SITE_CACHE_KEY) || '{}') as Record<string, CompetitionSite>;
    if (!value || typeof value !== 'object') return {};
    const clean: Record<string, CompetitionSite> = {};
    for (const [name, entry] of Object.entries(value)) {
      const url = normalizeSiteUrl(String(entry?.url ?? ''));
      const updatedAt = entry?.updatedAt;
      if (url && typeof updatedAt === 'number' && Number.isFinite(updatedAt)) clean[name] = { url, updatedAt };
    }
    return clean;
  } catch {
    return {};
  }
}

/** 写回缓存；配额满或没有 localStorage 时安静忽略。 */
export function writeSiteCache(sites: Record<string, CompetitionSite>): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(SITE_CACHE_KEY, JSON.stringify(sites));
  } catch {
    /* 配额满：内存里的结果本次仍然可用 */
  }
}

/** 只取主机名做展示，去掉 www. 前缀。 */
export function siteHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function siteIsFresh(entry: CompetitionSite, now = Date.now()): boolean {
  return Number.isFinite(entry.updatedAt) && now - entry.updatedAt <= SITE_TTL;
}
