// SPDX-License-Identifier: AGPL-3.0-only
import type { Request } from './api.ts';
import { BUILTIN_SCHOOLS, dedupeSchools, normaliseImportedSchool, safeWebUrl, searchSchools, type SchoolRecord } from './schools.ts';

export type VpnSchool = SchoolRecord;
export interface ImportPreview { valid: SchoolRecord[]; errors: string[]; duplicates: number }
export const BUILTIN_VPN_SCHOOLS = BUILTIN_SCHOOLS;
const LEGACY_KEY = 'diary.vpn.custom.v1';
async function hostCall<T=unknown>(request:Request):Promise<T>{const{call}=await import('./api.ts');return call<T>(request);}
export const safeVpnUrl = safeWebUrl;
export const filterSchools = searchSchools;
export function loadCustomSchools(storage: Pick<Storage,'getItem'> = localStorage): SchoolRecord[] {
  try { const rows = JSON.parse(storage.getItem(LEGACY_KEY) ?? '[]'); return Array.isArray(rows) ? rows.map(row => normaliseImportedSchool(row)).filter((row): row is SchoolRecord => !!row) : []; }
  catch { return []; }
}
export function saveCustomSchools(rows: SchoolRecord[], storage: Pick<Storage,'setItem'> = localStorage): void { storage.setItem(LEGACY_KEY, JSON.stringify(rows)); }
function csvCells(line: string): string[] { return line.split(',').map(value => value.trim().replace(/^"|"$/g, '')); }
export function previewSchoolImport(raw: string, kind: 'csv'|'json', existing: readonly SchoolRecord[]): ImportPreview {
  let source: unknown[] = []; const errors: string[] = [];
  try {
    if (kind === 'json') source = JSON.parse(raw) as unknown[];
    else source = raw.split(/\r?\n/).filter(Boolean).map((line,index) => {
      const [name,vpnUrl,aliases='',officialUrl='',accessMode='用户导入'] = csvCells(line);
      return index === 0 && /学校|name/i.test(name ?? '') ? null : { name,vpnUrl,officialUrl,accessMode,aliases:aliases.split(/[;；|]/).filter(Boolean) };
    }).filter(Boolean);
  } catch { return { valid: [], errors: ['文件内容无法解析'], duplicates: 0 }; }
  if (!Array.isArray(source)) return { valid: [], errors: ['JSON 顶层必须是数组'], duplicates: 0 };
  const valid: SchoolRecord[] = [];
  source.forEach((value,index) => { const school=normaliseImportedSchool((value ?? {}) as Partial<SchoolRecord> & {url?:string}); if(school) valid.push(school); else errors.push(`第 ${index+1} 条：学校名称或 VPN 地址无效`); });
  const result=dedupeSchools(existing,valid); return {valid:result.added,errors,duplicates:result.duplicates};
}

export function mountVpnPage(root: HTMLElement, openExternal: (url: string) => Promise<unknown>): void {
  let schools: SchoolRecord[] = [];
  root.innerHTML = `<div class="view-heading"><div><span class="eyebrow">CAMPUS ACCESS</span><h1 data-ui="schoolVpn">学校 VPN</h1><p data-ui="vpnPrivacy">查找学校校外访问入口。VPN 地址不代表登录权限，Diary 不保存账号、密码或 Cookie。</p></div></div><section class="vpn-toolbar"><input id="vpnSearch" data-ui-placeholder="schoolSearch" placeholder="搜索学校名称、简称、官网或网址"><select id="vpnSelect"><option value="">全部学校</option></select></section><div id="vpnList" class="vpn-list"></div><section class="vpn-import"><h2 data-ui="customSchools">用户自定义学校</h2><div class="vpn-add"><input id="vpnName" placeholder="学校名称"><input id="vpnOfficial" placeholder="学校官网（可选）"><input id="vpnUrl" placeholder="https://vpn.example.edu.cn/"><button id="vpnAdd" class="solid-button">添加</button></div><p class="hint">CSV：学校名称,VPN 地址,简称,学校官网,访问方式；JSON 支持 name、vpnUrl、aliases、officialUrl、accessMode。</p><div class="vpn-import-actions"><input id="vpnFile" type="file" accept=".csv,.json"><button id="vpnImport" class="outline-button">预览批量导入</button></div><div id="vpnPreview"></div></section>`;
  const search=root.querySelector<HTMLInputElement>('#vpnSearch')!,select=root.querySelector<HTMLSelectElement>('#vpnSelect')!,list=root.querySelector('#vpnList')!,preview=root.querySelector('#vpnPreview')!;
  const open=async(url:string)=>{const safe=safeWebUrl(url);if(!safe)throw new Error('网址无效，只允许 HTTP 或 HTTPS');await openExternal(safe);};
  const paint=()=>{
    const rows=searchSchools(schools,search.value).filter(item=>!select.value||item.id===select.value);
    const selected=select.value;select.replaceChildren(new Option('全部学校',''),...schools.map(item=>new Option(item.name,item.id)));select.value=selected;
    list.replaceChildren();
    for(const item of rows){
      const card=document.createElement('article');card.className='vpn-card';
      card.innerHTML=`<div><button class="vpn-school-link">${item.name}</button><a href="#">${item.vpnUrl}</a><small>${item.accessMode}${item.builtin?' · 内置':' · 自定义'}</small>${item.officialUrl?`<small>官网：${item.officialUrl}</small>`:''}</div><div class="vpn-card-actions"><button class="solid-button">打开 VPN</button>${item.builtin?'':'<button class="outline-button vpn-edit">编辑</button><button class="danger vpn-delete">删除</button>'}</div>`;
      card.querySelectorAll('.vpn-school-link,a,.solid-button').forEach(node=>node.addEventListener('click',event=>{event.preventDefault();void open(item.vpnUrl).catch(error=>alert((error as Error).message));}));
      card.querySelector('.vpn-delete')?.addEventListener('click',()=>{if(!confirm(`删除自定义学校“${item.name}”？`))return;void hostCall({op:'schools:delete',id:item.id}).then(refresh).catch(error=>alert((error as Error).message));});
      card.querySelector('.vpn-edit')?.addEventListener('click',()=>{root.querySelector<HTMLInputElement>('#vpnName')!.value=item.name;root.querySelector<HTMLInputElement>('#vpnUrl')!.value=item.vpnUrl;root.querySelector<HTMLInputElement>('#vpnOfficial')!.value=item.officialUrl;root.querySelector<HTMLButtonElement>('#vpnAdd')!.dataset.editId=item.id;});
      list.append(card);
    }
    if(!rows.length)list.innerHTML='<p class="empty-state">没有找到匹配的学校。</p>';
  };
  const refresh=async()=>{schools=await hostCall<SchoolRecord[]>({op:'schools:list'});paint();};
  search.oninput=()=>{select.value='';paint();};select.onchange=()=>{search.value=select.selectedOptions[0]?.text==='全部学校'?'':select.selectedOptions[0]?.text??'';paint();};
  root.querySelector<HTMLButtonElement>('#vpnAdd')!.onclick=()=>{const button=root.querySelector<HTMLButtonElement>('#vpnAdd')!;const value={...(button.dataset.editId?{id:button.dataset.editId}:{}),name:root.querySelector<HTMLInputElement>('#vpnName')!.value,vpnUrl:root.querySelector<HTMLInputElement>('#vpnUrl')!.value,officialUrl:root.querySelector<HTMLInputElement>('#vpnOfficial')!.value};void hostCall({op:'schools:upsert',school:value}).then(()=>{delete button.dataset.editId;return refresh();}).catch(error=>alert((error as Error).message));};
  root.querySelector<HTMLButtonElement>('#vpnImport')!.onclick=async()=>{const file=root.querySelector<HTMLInputElement>('#vpnFile')!.files?.[0];if(!file){preview.textContent='请先选择 CSV 或 JSON 文件';return;}const result=previewSchoolImport(await file.text(),file.name.toLowerCase().endsWith('.json')?'json':'csv',schools);preview.innerHTML=`<p>可导入 ${result.valid.length} 条，重复 ${result.duplicates} 条，错误 ${result.errors.length} 条。</p>${result.errors.map(x=>`<small>${x}</small>`).join('')}`;if(result.valid.length){const button=document.createElement('button');button.className='solid-button';button.textContent='确认导入';button.onclick=()=>{void hostCall({op:'schools:migrate',schools:result.valid}).then(()=>refresh()).then(()=>{preview.textContent='导入完成';}).catch(error=>{preview.textContent=`导入失败：${(error as Error).message}`;});};preview.append(button);}};
  const legacy=loadCustomSchools();void hostCall<{schools:SchoolRecord[]}>({op:'schools:migrate',schools:legacy}).then(result=>{schools=result.schools;if(legacy.length)localStorage.removeItem(LEGACY_KEY);paint();}).catch(error=>{preview.textContent=`学校数据加载失败：${(error as Error).message}`;});
}
