import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_VPN_SCHOOLS, filterSchools, loadCustomSchools, previewSchoolImport, safeVpnUrl, saveCustomSchools } from '../src/app/vpn.ts';
import { loadPetState, savePetState, validatePetPackage } from '../src/app/pets.ts';

function memoryStorage() { const values=new Map(); return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}; }

test('attachment VPN data is unique, safe and searchable by name alias or URL', () => {
  assert.equal(BUILTIN_VPN_SCHOOLS.length,21);
  assert.equal(new Set(BUILTIN_VPN_SCHOOLS.map(item=>item.vpnUrl)).size,21);
  assert.ok(BUILTIN_VPN_SCHOOLS.every(item=>safeVpnUrl(item.vpnUrl)?.startsWith('https://')));
  assert.equal(filterSchools(BUILTIN_VPN_SCHOOLS,'清华')[0].id,'tsinghua');
  assert.equal(filterSchools(BUILTIN_VPN_SCHOOLS,'buaa')[0].name,'北京航空航天大学');
  assert.equal(filterSchools(BUILTIN_VPN_SCHOOLS,'webvpn.bit')[0].id,'bit');
  assert.equal(safeVpnUrl('javascript:alert(1)'),null);
  assert.equal(safeVpnUrl('file:///etc/passwd'),null);
});

test('custom VPN CSV and JSON preview deduplicates and persists CRUD results', () => {
  const csv='学校名称,网址,简称\n示例大学,https://vpn.example.edu.cn/,EXU\n示例大学,https://vpn.example.edu.cn/,EXU\n坏学校,javascript:bad,x';
  const preview=previewSchoolImport(csv,'csv',BUILTIN_VPN_SCHOOLS);
  assert.equal(preview.valid.length,1); assert.equal(preview.duplicates,1); assert.equal(preview.errors.length,1);
  const json=previewSchoolImport('[{"name":"第二大学","url":"https://vpn.two.edu/"}]','json',[]);
  assert.equal(json.valid.length,1);
  const storage=memoryStorage(); saveCustomSchools([...preview.valid,...json.valid],storage);
  let restored=loadCustomSchools(storage); assert.equal(restored.length,2);
  restored[0].name='编辑后的大学'; restored.pop(); saveCustomSchools(restored,storage);
  restored=loadCustomSchools(storage); assert.deepEqual(restored.map(item=>item.name),['编辑后的大学']);
});

test('PetDex v2 validator enforces manifest, states, directions, geometry and size', () => {
  const manifest={id:'buddy',displayName:'Buddy',spriteVersionNumber:2,spritesheetPath:'spritesheet.webp',states:Array(9),directions:Array(16)};
  assert.equal(validatePetPackage(manifest,1536,2288,1024).ok,true);
  assert.equal(validatePetPackage({...manifest,spriteVersionNumber:1},1536,1872,1024).ok,false);
  assert.equal(validatePetPackage({...manifest,directions:Array(8)},1536,2288,1024).ok,false);
  assert.equal(validatePetPackage(manifest,1500,2288,1024).ok,false);
  assert.equal(validatePetPackage(manifest,1536,2288,33*1024*1024).ok,false);
});

test('pet selection and disabled state persist locally', () => {
  const storage=memoryStorage(); savePetState({enabled:true,selectedId:'buddy'},storage);
  assert.deepEqual(loadPetState(storage),{enabled:true,selectedId:'buddy'});
  savePetState({enabled:false,selectedId:'diary-paw'},storage);
  assert.deepEqual(loadPetState(storage),{enabled:false,selectedId:'diary-paw'});
});
