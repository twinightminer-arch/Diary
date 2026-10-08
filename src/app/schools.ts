// SPDX-License-Identifier: AGPL-3.0-only
export type SchoolRecord = {
  id: string;
  name: string;
  aliases: string[];
  officialUrl: string;
  vpnUrl: string;
  accessMode: string;
  badgeUrl: string | null;
  updatedAt: string;
  builtin: boolean;
};

const UPDATED = '2026-10-08T00:00:00.000Z';
const rows = [
  ['pku','北京大学','https://www.pku.edu.cn/','https://vpn.pku.edu.cn/','官网提示使用客户端，不提供网页版'],
  ['tsinghua','清华大学','https://www.tsinghua.edu.cn/','https://webvpn.tsinghua.edu.cn/login','WebVPN'],
  ['ruc','中国人民大学','https://www.ruc.edu.cn/','https://rvpn.ruc.edu.cn/','客户端 VPN'],
  ['buaa','北京航空航天大学','https://www.buaa.edu.cn/','https://vpn.buaa.edu.cn/','客户端 VPN'],
  ['bit','北京理工大学','https://www.bit.edu.cn/','https://webvpn.bit.edu.cn/','WebVPN'],
  ['bnu','北京师范大学','https://www.bnu.edu.cn/','https://webvpn.bnu.edu.cn/','WebVPN'],
  ['cau','中国农业大学','https://www.cau.edu.cn/','https://vpn.cau.edu.cn/','VPN'],
  ['muc','中央民族大学','https://www.muc.edu.cn/','https://vpn.muc.edu.cn/','网页访问；部分资源需客户端'],
  ['cufe','中央财经大学','https://www.cufe.edu.cn/','https://webvpn.cufe.edu.cn/','WebVPN'],
  ['uibe','对外经济贸易大学','https://www.uibe.edu.cn/','https://webvpn.uibe.edu.cn/','WebVPN'],
  ['bupt','北京邮电大学','https://www.bupt.edu.cn/','https://vpn.bupt.edu.cn/','VPN'],
  ['bfsu','北京外国语大学','https://www.bfsu.edu.cn/','https://webvpn.bfsu.edu.cn/','WebVPN'],
  ['bjtu','北京交通大学','https://www.bjtu.edu.cn/','https://vpn.bjtu.edu.cn/','VPN'],
  ['ustb','北京科技大学','https://www.ustb.edu.cn/','https://n.ustb.edu.cn/','校外访问入口'],
  ['cuc','中国传媒大学','https://www.cuc.edu.cn/','https://vpn.cuc.edu.cn/','客户端 VPN'],
  ['bjut','北京工业大学','https://www.bjut.edu.cn/','https://vpn.bjut.edu.cn/','VPN'],
  ['buct','北京化工大学','https://www.buct.edu.cn/','https://w.buct.edu.cn/','网页版 VPN'],
  ['bjfu','北京林业大学','https://www.bjfu.edu.cn/','https://vpn1.bjfu.edu.cn/','VPN'],
  ['ncepu','华北电力大学','https://www.ncepu.edu.cn/','https://webvpn.ncepu.edu.cn/login','WebVPN'],
  ['bucm','北京中医药大学','https://www.bucm.edu.cn/','https://vpn.bucm.edu.cn/','VPN'],
  ['cugb','中国地质大学（北京）','https://www.cugb.edu.cn/','https://portals.cugb.edu.cn/','校外经信息门户访问'],
] as const;

export const BUILTIN_SCHOOLS: readonly SchoolRecord[] = rows.map(([id,name,officialUrl,vpnUrl,accessMode]) => ({
  id, name, officialUrl, vpnUrl, accessMode, aliases: [id], badgeUrl: null, updatedAt: UPDATED, builtin: true,
}));

export function safeWebUrl(value: string, allowHttp = true): string | null {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:'))) return null;
    if (!url.hostname || /^(localhost|0\.0\.0\.0|\[?::1\]?)$/i.test(url.hostname)) return null;
    const ipv4 = url.hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const [,a,b,c,d] = ipv4.map(Number);
      if ([a,b,c,d].some(part => part! < 0 || part! > 255) || a === 0 || a === 10 || a === 127 ||
          (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)) return null;
    }
    return url.href;
  } catch { return null; }
}

export function searchSchools(schools: readonly SchoolRecord[], query: string): SchoolRecord[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...schools];
  return schools.filter(item => [item.name, item.officialUrl, item.vpnUrl, ...item.aliases]
    .some(value => value.toLocaleLowerCase().includes(needle)));
}

export function normaliseImportedSchool(value: Partial<SchoolRecord> & { url?: string }, now = new Date().toISOString()): SchoolRecord | null {
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  const vpnUrl = safeWebUrl(String(value.vpnUrl ?? value.url ?? ''));
  const officialUrl = safeWebUrl(String(value.officialUrl ?? '')) ?? '';
  if (!name || !vpnUrl) return null;
  return {
    id: typeof value.id === 'string' && /^custom-[a-z0-9-]+$/i.test(value.id) ? value.id : `custom-${crypto.randomUUID()}`,
    name,
    aliases: Array.isArray(value.aliases) ? value.aliases.filter((item): item is string => typeof item === 'string' && !!item.trim()).map(item => item.trim()) : [],
    officialUrl,
    vpnUrl,
    accessMode: String(value.accessMode ?? (value as { usage?: string }).usage ?? '用户导入'),
    badgeUrl: typeof value.badgeUrl === 'string' ? safeWebUrl(value.badgeUrl, false) : null,
    updatedAt: now,
    builtin: false,
  };
}

export function dedupeSchools(existing: readonly SchoolRecord[], incoming: readonly SchoolRecord[]): { added: SchoolRecord[]; duplicates: number } {
  const seen = new Set(existing.map(item => `${item.name.toLocaleLowerCase()}\n${item.vpnUrl.toLocaleLowerCase()}`));
  const added: SchoolRecord[] = []; let duplicates = 0;
  for (const school of incoming) {
    const key = `${school.name.toLocaleLowerCase()}\n${school.vpnUrl.toLocaleLowerCase()}`;
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key); added.push(school);
  }
  return { added, duplicates };
}
