// SPDX-License-Identifier: AGPL-3.0-only
export interface PetManifest { id: string; displayName: string; description?: string; spriteVersionNumber: number; spritesheetPath: string; license?: string; states?: unknown[]; directions?: unknown[] }
export interface PetRecord extends PetManifest { builtin: boolean; sprite?: Blob }
export interface PetValidation { ok: boolean; errors: string[]; frameWidth?: number; frameHeight?: number }

const DB_NAME='diary-pets-v1', STORE='pets', STATE_KEY='diary.pet.state.v1';
const builtin: PetRecord={id:'diary-paw',displayName:'Diary 小爪',description:'Diary 原创内置伙伴',spriteVersionNumber:2,spritesheetPath:'',license:'AGPL-3.0-only',builtin:true};
type PetState={enabled:boolean;selectedId:string};
export function validatePetPackage(value: unknown,width:number,height:number,size:number): PetValidation {
  const errors:string[]=[]; const manifest=value as Partial<PetManifest>;
  if(!manifest||typeof manifest!=='object') errors.push('pet.json 必须是 JSON 对象');
  if(typeof manifest.id!=='string'||!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(manifest.id)) errors.push('宠物 id 无效');
  if(typeof manifest.displayName!=='string'||!manifest.displayName.trim()) errors.push('缺少 displayName');
  if(manifest.spriteVersionNumber!==2) errors.push('仅支持 PetDex v2（spriteVersionNumber 必须为 2）');
  if(typeof manifest.spritesheetPath!=='string'||!/\.(png|webp)$/i.test(manifest.spritesheetPath)||/[\\/]/.test(manifest.spritesheetPath)) errors.push('spritesheetPath 必须指向同目录 PNG 或 WebP');
  if(size<=0||size>32*1024*1024) errors.push('精灵图必须小于 32 MB');
  if(width%8||height%11||width/8*208!==height/11*192) errors.push('v2 精灵图必须是 8×11 网格，单格比例为 192×208');
  if(Array.isArray(manifest.states)&&manifest.states.length<9) errors.push('动画状态少于 9 个');
  if(Array.isArray(manifest.directions)&&manifest.directions.length<16) errors.push('观察方向少于 16 个');
  return {ok:errors.length===0,errors,...(errors.length?{}:{frameWidth:width/8,frameHeight:height/11})};
}
export function loadPetState(storage:Pick<Storage,'getItem'>=localStorage):PetState { try{return {...{enabled:true,selectedId:builtin.id},...JSON.parse(storage.getItem(STATE_KEY)??'{}')}}catch{return{enabled:true,selectedId:builtin.id}} }
export function savePetState(value:PetState,storage:Pick<Storage,'setItem'>=localStorage):void{storage.setItem(STATE_KEY,JSON.stringify(value));}
function database():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const request=indexedDB.open(DB_NAME,1);request.onupgradeneeded=()=>request.result.createObjectStore(STORE,{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function records():Promise<PetRecord[]>{const db=await database();return new Promise((resolve,reject)=>{const request=db.transaction(STORE).objectStore(STORE).getAll();request.onsuccess=()=>resolve([builtin,...request.result as PetRecord[]]);request.onerror=()=>reject(request.error);});}
async function put(record:PetRecord):Promise<void>{const db=await database();return new Promise((resolve,reject)=>{const request=db.transaction(STORE,'readwrite').objectStore(STORE).put(record);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);});}
async function remove(id:string):Promise<void>{const db=await database();return new Promise((resolve,reject)=>{const request=db.transaction(STORE,'readwrite').objectStore(STORE).delete(id);request.onsuccess=()=>resolve();request.onerror=()=>reject(request.error);});}

let objectUrl:string|null=null, timer:number|null=null;
async function paintFloatingPet():Promise<void>{
  document.getElementById('desktopPet')?.remove(); if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;} if(timer!==null){clearInterval(timer);timer=null;}
  const state=loadPetState(); if(!state.enabled)return; const pet=(await records()).find(item=>item.id===state.selectedId)??builtin;
  const host=document.createElement('div');host.id='desktopPet';host.title=pet.displayName;document.body.append(host);
  if(pet.builtin){host.className='desktop-pet builtin-pet';host.textContent='🐾';return;}
  objectUrl=URL.createObjectURL(pet.sprite!);const canvas=document.createElement('canvas');canvas.width=96;canvas.height=104;host.className='desktop-pet';host.append(canvas);const context=canvas.getContext('2d')!,image=new Image();image.src=objectUrl;await image.decode();let frame=0;const draw=()=>{context.clearRect(0,0,96,104);const fw=image.naturalWidth/8,fh=image.naturalHeight/11;context.drawImage(image,frame*fw,0,fw,fh,0,0,96,104);frame=(frame+1)%6;};draw();timer=window.setInterval(draw,180);
}

export async function mountPetsPage(root:HTMLElement):Promise<void>{
  root.innerHTML=`<div class="view-heading"><div><span class="eyebrow">DESKTOP COMPANION</span><h1>桌面宠物</h1><p>选择、导入和管理 PetDex v2 桌宠。关闭桌宠会立即停止动画。</p></div><button id="petToggle" class="outline-button"></button></div><div id="petList" class="pet-grid"></div><section class="pet-import"><h2>导入桌宠</h2><p>依次选择同一宠物包中的 <code>pet.json</code> 和精灵图。只接受 v2 8×11 PNG/WebP，最大 32 MB。</p><label>清单文件 <input id="petManifestFile" type="file" accept=".json,application/json"></label><label>精灵图 <input id="petSpriteFile" type="file" accept=".png,.webp,image/png,image/webp"></label><button id="petImportButton" class="solid-button">校验并导入</button><p id="petImportState" class="hint"></p></section><footer class="petdex-footer"><a id="petdexLink" href="https://petdex.dev/zh">petdex.dev/zh</a><p>你可以前往 PetDex 获取更多桌面宠物。下载和导入前请确认素材来源与授权许可。</p></footer>`;
  const state=loadPetState(),list=root.querySelector('#petList')!,toggle=root.querySelector<HTMLButtonElement>('#petToggle')!,status=root.querySelector('#petImportState')!;
  const render=async()=>{const items=await records();toggle.textContent=state.enabled?'停用桌宠':'启用桌宠';list.replaceChildren();for(const pet of items){const card=document.createElement('article');card.className=`pet-card${state.selectedId===pet.id?' active':''}`;card.innerHTML=`<div class="pet-preview">${pet.builtin?'🐾':'<canvas width="96" height="104"></canvas>'}</div><strong>${pet.displayName}</strong><small>${pet.description??''}</small><em>${state.selectedId===pet.id&&state.enabled?'使用中':pet.builtin?'内置':'已安装'}</em><div><button class="solid-button pet-use">选择</button>${pet.builtin?'':'<button class="danger pet-remove">删除</button>'}</div>`;if(!pet.builtin){const image=new Image(),previewUrl=URL.createObjectURL(pet.sprite!);image.src=previewUrl;await image.decode();const canvas=card.querySelector('canvas')!,ctx=canvas.getContext('2d')!;ctx.drawImage(image,0,0,image.naturalWidth/8,image.naturalHeight/11,0,0,96,104);URL.revokeObjectURL(previewUrl);}card.querySelector('.pet-use')!.addEventListener('click',()=>{state.selectedId=pet.id;state.enabled=true;savePetState(state);void paintFloatingPet();void render();});card.querySelector('.pet-remove')?.addEventListener('click',()=>{if(!confirm(`删除桌宠“${pet.displayName}”？`))return;void remove(pet.id).then(()=>{if(state.selectedId===pet.id){state.selectedId=builtin.id;savePetState(state);}return paintFloatingPet();}).then(render);});list.append(card);}};
  toggle.onclick=()=>{state.enabled=!state.enabled;savePetState(state);void paintFloatingPet();void render();};
  root.querySelector<HTMLButtonElement>('#petImportButton')!.onclick=async()=>{try{const json=root.querySelector<HTMLInputElement>('#petManifestFile')!.files?.[0],sprite=root.querySelector<HTMLInputElement>('#petSpriteFile')!.files?.[0];if(!json||!sprite)throw new Error('请选择 pet.json 和精灵图');const manifest=JSON.parse(await json.text()) as PetManifest;if(sprite.name!==manifest.spritesheetPath)throw new Error(`清单要求的精灵图是 ${manifest.spritesheetPath}`);const bitmap=await createImageBitmap(sprite),validation=validatePetPackage(manifest,bitmap.width,bitmap.height,sprite.size);bitmap.close();if(!validation.ok)throw new Error(validation.errors.join('；'));await put({...manifest,builtin:false,sprite});status.textContent=`已导入：${manifest.displayName}`;await render();}catch(error){status.textContent=`导入失败：${(error as Error).message}`;}};
  root.querySelector('#petdexLink')!.addEventListener('click',event=>{event.preventDefault();void import('./api.ts').then(({call})=>call({op:'openExternal',url:'https://petdex.dev/zh'}));});
  await render();await paintFloatingPet();
}
