// SPDX-License-Identifier: AGPL-3.0-only
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { SchoolRecord } from '../app/schools.ts';

export type CampusCompetition = { title: string; summary: string; publishedAt: string | null; sourceUrl: string; fetchedAt: string };
export class CampusFetchError extends Error {
  readonly code: 'invalid_url'|'private_network'|'forbidden'|'timeout'|'network';
  constructor(code: 'invalid_url'|'private_network'|'forbidden'|'timeout'|'network', message: string) { super(message); this.code = code; }
}
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type LookupLike = (hostname: string) => Promise<{ address: string }[]>;

function privateAddress(address: string): boolean {
  const value = address.replace(/^::ffff:/, '');
  if (value === '::1' || value === '0.0.0.0') return true;
  if (isIP(value) === 4) {
    const [a,b] = value.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  }
  return /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(value);
}
export async function validateCampusTarget(raw: string, allowedHost: string, lookup: LookupLike = async hostname => dnsLookup(hostname, { all: true })): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new CampusFetchError('invalid_url', '学校网址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.hostname !== allowedHost && !url.hostname.endsWith(`.${allowedHost}`))) throw new CampusFetchError('invalid_url', '只允许访问登记的学校 HTTPS 官方域名');
  if (isIP(url.hostname) && privateAddress(url.hostname)) throw new CampusFetchError('private_network', '已阻止访问本机或内网地址');
  const addresses = await lookup(url.hostname);
  if (!addresses.length || addresses.some(item => privateAddress(item.address))) throw new CampusFetchError('private_network', '已阻止解析到本机或内网的学校网址');
  return url;
}
function text(value: string): string { return value.replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|amp);/g, ' ').replace(/\s+/g, ' ').trim(); }
export function parseCompetitionHtml(html: string, base: string, fetchedAt: string): CampusCompetition[] {
  const hits: CampusCompetition[] = [], seen = new Set<string>();
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const title = text(match[2] ?? '');
    if (title.length < 4 || !/(竞赛|比赛|大赛|创新创业|挑战杯|建模|程序设计)/i.test(title)) continue;
    let sourceUrl: string; try { sourceUrl = new URL(match[1]!, base).href; } catch { continue; }
    if (seen.has(sourceUrl)) continue; seen.add(sourceUrl);
    const context = text(html.slice(Math.max(0, match.index! - 180), Math.min(html.length, match.index! + match[0].length + 240)));
    const publishedAt = context.match(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?/)?.[0] ?? null;
    hits.push({ title: title.slice(0, 180), summary: context.slice(0, 260), publishedAt, sourceUrl, fetchedAt });
    if (hits.length >= 20) break;
  }
  return hits;
}
export async function fetchCampusCompetitions(school: SchoolRecord, options: { fetch?: FetchLike; lookup?: LookupLike; timeoutMs?: number; retries?: number } = {}): Promise<CampusCompetition[]> {
  if (!school.officialUrl) throw new CampusFetchError('invalid_url', '该学校尚未登记官方网站');
  const allowedHost = new URL(school.officialUrl).hostname;
  const fetcher = options.fetch ?? fetch; const retries = options.retries ?? 1; const timeoutMs = options.timeoutMs ?? 8000;
  let target = await validateCampusTarget(school.officialUrl, allowedHost, options.lookup);
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      for (let redirect = 0; redirect <= 3; redirect++) {
        const response = await fetcher(target.href, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'text/html', 'User-Agent': 'Diary/0.1.7 campus-information' } });
        if ([301,302,303,307,308].includes(response.status)) {
          const location = response.headers.get('location'); if (!location) throw new CampusFetchError('network', '学校网站重定向缺少目标地址');
          target = await validateCampusTarget(new URL(location, target).href, allowedHost, options.lookup); continue;
        }
        if (response.status === 401 || response.status === 403) throw new CampusFetchError('forbidden', '学校网站需要登录、WebVPN 或相应访问权限；Diary 不会读取 Cookie 或绕过认证');
        if (!response.ok) throw new CampusFetchError('network', `学校网站返回 HTTP ${response.status}`);
        const type = response.headers.get('content-type') ?? '';
        if (!type.includes('text/html')) throw new CampusFetchError('network', '学校网站未返回可读取的网页内容');
        const html = (await response.text()).slice(0, 2_000_000);
        return parseCompetitionHtml(html, target.href, new Date().toISOString()).filter(item => {
          const hostname = new URL(item.sourceUrl).hostname;
          return hostname === allowedHost || hostname.endsWith(`.${allowedHost}`);
        });
      }
      throw new CampusFetchError('network', '学校网站重定向次数过多');
    } catch (error) {
      if (error instanceof CampusFetchError && ['forbidden','invalid_url','private_network'].includes(error.code)) throw error;
      if (attempt >= retries) {
        if (error instanceof DOMException && error.name === 'TimeoutError') throw new CampusFetchError('timeout', '获取学校公告超时，请稍后重试');
        throw error instanceof CampusFetchError ? error : new CampusFetchError('network', `无法获取学校公告：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return [];
}
