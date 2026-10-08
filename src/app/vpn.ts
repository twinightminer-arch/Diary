// SPDX-License-Identifier: AGPL-3.0-only
export interface VpnSchool { id: string; name: string; aliases: string[]; url: string; usage: string; builtin: boolean }
export interface ImportPreview { valid: VpnSchool[]; errors: string[]; duplicates: number }

const VPN_ROWS = [
  ['pku','北京大学','https://vpn.pku.edu.cn/','官网提示使用客户端，不提供网页版'],
  ['tsinghua','清华大学','https://webvpn.tsinghua.edu.cn/login','WebVPN'],
  ['ruc','中国人民大学','https://rvpn.ruc.edu.cn/','客户端 VPN'],
  ['buaa','北京航空航天大学','https://vpn.buaa.edu.cn/','客户端 VPN'],
  ['bit','北京理工大学','https://webvpn.bit.edu.cn/','WebVPN'],
  ['bnu','北京师范大学','https://webvpn.bnu.edu.cn/','WebVPN'],
  ['cau','中国农业大学','https://vpn.cau.edu.cn/','VPN'],
  ['muc','中央民族大学','https://vpn.muc.edu.cn/','网页访问；部分资源需客户端'],
  ['cufe','中央财经大学','https://webvpn.cufe.edu.cn/','WebVPN'],
  ['uibe','对外经济贸易大学','https://webvpn.uibe.edu.cn/','WebVPN'],
  ['bupt','北京邮电大学','https://vpn.bupt.edu.cn/','VPN'],
  ['bfsu','北京外国语大学','https://webvpn.bfsu.edu.cn/','WebVPN'],
  ['bjtu','北京交通大学','https://vpn.bjtu.edu.cn/','VPN'],
  ['ustb','北京科技大学','https://n.ustb.edu.cn/','校外访问入口'],
  ['cuc','中国传媒大学','https://vpn.cuc.edu.cn/','客户端 VPN'],
  ['bjut','北京工业大学','https://vpn.bjut.edu.cn/','VPN'],
  ['buct','北京化工大学','https://w.buct.edu.cn/','网页版 VPN'],
  ['bjfu','北京林业大学','https://vpn1.bjfu.edu.cn/','VPN'],
  ['ncepu','华北电力大学','https://webvpn.ncepu.edu.cn/login','WebVPN'],
  ['bucm','北京中医药大学','https://vpn.bucm.edu.cn/','VPN'],
  ['cugb','中国地质大学（北京）','https://portals.cugb.edu.cn/','校外经信息门户访问'],
] as const;
export const BUILTIN_VPN_SCHOOLS: readonly VpnSchool[] = VPN_ROWS.map(([id,name,url,usage]) => ({ id, name, url, usage, aliases: [id], builtin: true }));

const STORAGE_KEY = 'diary.vpn.custom.v1';
export function safeVpnUrl(value: string): string | null {
  try { const url = new URL(value.trim()); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null; } catch { return null; }
}
export function filterSchools(schools: readonly VpnSchool[], query: string): VpnSchool[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...schools];
  return schools.filter(item => [item.name, item.url, ...item.aliases].some(value => value.toLocaleLowerCase().includes(needle)));
}
export function loadCustomSchools(storage: Pick<Storage,'getItem'> = localStorage): VpnSchool[] {
  try { const rows = JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]'); return Array.isArray(rows) ? rows.filter(row => row && !row.builtin && safeVpnUrl(row.url)) : []; } catch { return []; }
}
export function saveCustomSchools(rows: VpnSchool[], storage: Pick<Storage,'setItem'> = localStorage): void { storage.setItem(STORAGE_KEY, JSON.stringify(rows)); }
function csvCells(line: string): string[] { return line.split(',').map(value => value.trim().replace(/^"|"$/g, '')); }
export function previewSchoolImport(raw: string, kind: 'csv'|'json', existing: readonly VpnSchool[]): ImportPreview {
  let source: unknown[] = [];
  const errors: string[] = [];
  try {
    if (kind === 'json') source = JSON.parse(raw) as unknown[];
    else source = raw.split(/\r?\n/).filter(Boolean).map((line, index) => { const [name,url,aliases=''] = csvCells(line); return index === 0 && /学校|name/i.test(name ?? '') ? null : { name, url, aliases: aliases.split(/[;；|]/).filter(Boolean) }; }).filter(Boolean);
  } catch { return { valid: [], errors: ['文件内容无法解析'], duplicates: 0 }; }
  if (!Array.isArray(source)) return { valid: [], errors: ['JSON 顶层必须是数组'], duplicates: 0 };
  const seen = new Set(existing.map(item => `${item.name}\n${item.url}`)); let duplicates = 0; const valid: VpnSchool[] = [];
  source.forEach((value, index) => {
    const row = value as { name?: unknown; url?: unknown; aliases?: unknown };
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    const url = typeof row?.url === 'string' ? safeVpnUrl(row.url) : null;
    if (!name || !url) { errors.push(`第 ${index + 1} 条：学校名称或网址无效`); return; }
    const key = `${name}\n${url}`; if (seen.has(key)) { duplicates++; return; } seen.add(key);
    const aliases = Array.isArray(row.aliases) ? row.aliases.filter((x): x is string => typeof x === 'string') : [];
    valid.push({ id: `custom-${crypto.randomUUID()}`, name, url, aliases, usage: '用户导入', builtin: false });
  });
  return { valid, errors, duplicates };
}

export function mountVpnPage(root: HTMLElement, openExternal: (url: string) => Promise<unknown>): void {
  const custom = loadCustomSchools(); const all = () => [...BUILTIN_VPN_SCHOOLS, ...custom];
  root.innerHTML = `<div class="view-heading"><div><span class="eyebrow">CAMPUS ACCESS</span><h1>各学校 VPN</h1><p>查找学校校外访问入口。仅提供网址，不保存账号、密码或 Cookie。</p></div></div><section class="vpn-toolbar"><input id="vpnSearch" placeholder="搜索学校名称、简称或网址"><select id="vpnSelect"><option value="">全部学校</option></select></section><div id="vpnList" class="vpn-list"></div><section class="vpn-import"><h2>手动导入学校</h2><div class="vpn-add"><input id="vpnName" placeholder="学校名称"><input id="vpnUrl" placeholder="https://vpn.example.edu.cn/"><button id="vpnAdd" class="solid-button">添加</button></div><p class="hint">批量格式：CSV 每行 <code>学校名称,网址,简称1;简称2</code>；JSON 为 <code>[{"name":"学校","url":"https://...","aliases":[]}]</code>。</p><div class="vpn-import-actions"><input id="vpnFile" type="file" accept=".csv,.json"><button id="vpnImport" class="outline-button">预览批量导入</button></div><div id="vpnPreview"></div></section>`;
  const search = root.querySelector<HTMLInputElement>('#vpnSearch')!, select = root.querySelector<HTMLSelectElement>('#vpnSelect')!, list = root.querySelector('#vpnList')!, preview = root.querySelector('#vpnPreview')!;
  const open = async (url: string) => { const safe = safeVpnUrl(url); if (!safe) throw new Error('网址无效，只允许 HTTP 或 HTTPS'); await openExternal(safe); };
  const paint = () => {
    const rows = filterSchools(all(), search.value).filter(item => !select.value || item.id === select.value);
    select.replaceChildren(new Option('全部学校',''), ...all().map(item => new Option(item.name,item.id))); select.value = select.dataset.value ?? '';
    list.replaceChildren();
    for (const item of rows) {
      const card = document.createElement('article'); card.className = 'vpn-card';
      card.innerHTML = `<div><button class="vpn-school-link">${item.name}</button><a href="#">${item.url}</a><small>${item.usage}${item.builtin ? ' · 内置' : ' · 自定义'}</small></div><div class="vpn-card-actions"><button class="solid-button">打开 VPN</button>${item.builtin ? '' : '<button class="outline-button vpn-edit">编辑</button><button class="danger vpn-delete">删除</button>'}</div>`;
      card.querySelectorAll('.vpn-school-link,a,.solid-button').forEach(node => node.addEventListener('click', event => { event.preventDefault(); void open(item.url).catch(error => alert((error as Error).message)); }));
      card.querySelector('.vpn-delete')?.addEventListener('click', () => { if (!confirm(`删除自定义学校“${item.name}”？`)) return; const i=custom.findIndex(x=>x.id===item.id); if(i>=0) custom.splice(i,1); saveCustomSchools(custom); paint(); });
      card.querySelector('.vpn-edit')?.addEventListener('click', () => { (root.querySelector<HTMLInputElement>('#vpnName')!).value=item.name; (root.querySelector<HTMLInputElement>('#vpnUrl')!).value=item.url; const i=custom.findIndex(x=>x.id===item.id); if(i>=0) custom.splice(i,1); saveCustomSchools(custom); paint(); });
      list.append(card);
    }
    if (!rows.length) list.innerHTML = '<p class="empty-state">没有找到匹配的学校。</p>';
  };
  search.oninput=()=>{ select.dataset.value=''; paint(); }; select.onchange=()=>{select.dataset.value=select.value; search.value=select.selectedOptions[0]?.text==='全部学校'?'':select.selectedOptions[0]?.text??''; paint();};
  root.querySelector<HTMLButtonElement>('#vpnAdd')!.onclick=()=>{ const name=root.querySelector<HTMLInputElement>('#vpnName')!.value.trim(), url=safeVpnUrl(root.querySelector<HTMLInputElement>('#vpnUrl')!.value); if(!name||!url){alert('请填写有效学校名称和 HTTP/HTTPS 网址');return;} custom.push({id:`custom-${crypto.randomUUID()}`,name,url,aliases:[],usage:'用户添加',builtin:false}); saveCustomSchools(custom); paint(); };
  root.querySelector<HTMLButtonElement>('#vpnImport')!.onclick=async()=>{ const file=root.querySelector<HTMLInputElement>('#vpnFile')!.files?.[0]; if(!file){preview.textContent='请先选择 CSV 或 JSON 文件';return;} const result=previewSchoolImport(await file.text(),file.name.toLowerCase().endsWith('.json')?'json':'csv',all()); preview.innerHTML=`<p>可导入 ${result.valid.length} 条，重复 ${result.duplicates} 条，错误 ${result.errors.length} 条。</p>${result.errors.map(x=>`<small>${x}</small>`).join('')}`; if(result.valid.length){const button=document.createElement('button');button.className='solid-button';button.textContent='确认导入';button.onclick=()=>{custom.push(...result.valid);saveCustomSchools(custom);paint();preview.textContent='导入完成';};preview.append(button);} };
  paint();
}
