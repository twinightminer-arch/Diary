// SPDX-License-Identifier: AGPL-3.0-only
export type CompetitionSite = { url: string; updatedAt: number };
export const SITE_CACHE_KEY = 'diary.portal.competitionSites';
export const SITE_TTL = 1000 * 60 * 60 * 24 * 7;
export function normalizeSiteUrl(raw: string): string {
  const trimmed=(raw??'').trim().replace(/[.,;:!?。，；：！？、）)】\]》>"'’]+$/g,'');
  try{const url=new URL(trimmed);return (url.protocol==='http:'||url.protocol==='https:')&&!url.username&&!url.password&&url.hostname.includes('.')?url.href:'';}catch{return '';}
}
export function extractSiteUrl(answer:string):string{for(const match of answer.match(/https?:\/\/[^\s"'<>()（）\[\]【】]+/gi)??[]){const url=normalizeSiteUrl(match);if(url)return url;}return '';}
export function readSiteCache():Record<string,CompetitionSite>{try{const value=JSON.parse(localStorage.getItem(SITE_CACHE_KEY)||'{}') as Record<string,CompetitionSite>;if(!value||typeof value!=='object')return{};const clean:Record<string,CompetitionSite>={};for(const[name,entry]of Object.entries(value)){const url=normalizeSiteUrl(String(entry?.url??''));if(url&&Number.isFinite(entry?.updatedAt))clean[name]={url,updatedAt:entry.updatedAt};}return clean;}catch{return{};}}
export function writeSiteCache(sites:Record<string,CompetitionSite>):void{try{localStorage.setItem(SITE_CACHE_KEY,JSON.stringify(sites));}catch{/* current session still works */}}
export function siteHost(url:string):string{try{return new URL(url).host.replace(/^www\./,'');}catch{return url;}}
export function siteIsFresh(entry:CompetitionSite,now=Date.now()):boolean{return Number.isFinite(entry.updatedAt)&&now-entry.updatedAt<=SITE_TTL;}
