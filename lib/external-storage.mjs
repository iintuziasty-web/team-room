import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec=promisify(execFile);
const MAX_SETTINGS_BYTES=64*1024;
const DEVICE_ID=/^[A-Za-z0-9-]{16,80}$/;
const UUID=/^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/;
export const STORAGE_LOCATION_MARKER='storage-location.json';
const guards=new Map();
const internalRoots=new Map(),markerCache=new Map();
let internalFilesystemDevices;

function invalid(message='Настройки внешнего диска Team Room повреждены.'){
 return Object.assign(new Error(message),{code:'INVALID_EXTERNAL_STORAGE_CONFIG'});
}
export function externalStorageUnavailable(message='Внешний диск Team Room недоступен. Подключи выбранный диск и повтори действие.'){
 return Object.assign(new Error(message),{code:'EXTERNAL_STORAGE_UNAVAILABLE'});
}
function deviceId(value){
 if(typeof value!=='string'||!DEVICE_ID.test(value))throw invalid('Неверное подключение Team Room.');
 return value;
}
function absolute(value){
 if(typeof value!=='string'||!value||value.length>4096||/[\x00-\x1f\x7f]/.test(value)||!path.isAbsolute(value)||path.resolve(value)!==value)throw invalid('Неверная папка внешнего диска.');
 return value;
}
function volumePath(value){
 value=absolute(value);
 if(path.dirname(value)!=='/Volumes'||['.','..'].includes(path.basename(value)))throw invalid('Выбери подключённый диск в папке /Volumes.');
 return value;
}
export function externalStorageBase(volume){return path.join(volumePath(volume),'mac-offload','team-room-community-connect');}
export function managedDeviceRoot(id,{home=os.homedir()}={}){
 return path.join(absolute(home),'Library','Application Support','Team Room Community Connect',deviceId(id));
}
export function storageLocationsPath({home=os.homedir()}={}){
 return path.join(absolute(home),'Library','Application Support','Team Room Community Desktop','storage-locations.json');
}
function normalizedLocation(value,{home=os.homedir(),id}={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1)throw invalid();
 const currentId=deviceId(value.deviceId);
 if(id!==undefined&&currentId!==deviceId(id))throw invalid('Настройки диска относятся к другому подключению.');
 const volume=volumePath(value.volumePath),root=absolute(value.root),originalRoot=absolute(value.originalRoot);
 if(root!==path.join(externalStorageBase(volume),currentId))throw invalid('Рабочая папка должна находиться в mac-offload/team-room-community-connect выбранного диска.');
 if(originalRoot!==managedDeviceRoot(currentId,{home}))throw invalid('Настройки диска относятся к другой папке подключения.');
 if(typeof value.volumeUuid!=='string'||!UUID.test(value.volumeUuid))throw invalid('Не сохранён идентификатор выбранного диска.');
 if(typeof value.migratedAt!=='string'||value.migratedAt.length>40||!Number.isFinite(Date.parse(value.migratedAt)))throw invalid();
 return {version:1,deviceId:currentId,root,originalRoot,volumePath:volume,volumeUuid:value.volumeUuid.toUpperCase(),migratedAt:value.migratedAt};
}
const sameLocation=(a,b)=>a.deviceId===b.deviceId&&a.root===b.root&&a.originalRoot===b.originalRoot&&a.volumePath===b.volumePath&&a.volumeUuid===b.volumeUuid;
const contains=(base,target)=>target===base||target.startsWith(base+path.sep);

async function readPrivateJson(filename,{optional=false}={}){
 let handle;
 try{
  handle=await fs.open(filename,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
  const before=await handle.stat();
  if(!before.isFile()||before.nlink!==1||before.size>MAX_SETTINGS_BYTES)throw invalid();
  const bytes=await handle.readFile();
  if(bytes.length>MAX_SETTINGS_BYTES)throw invalid();
  const after=await handle.stat(),current=await fs.lstat(filename);
  if(current.isSymbolicLink()||!current.isFile()||current.nlink!==1||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||current.dev!==after.dev||current.ino!==after.ino||current.size!==after.size||current.mtimeMs!==after.mtimeMs)throw invalid('Настройки внешнего диска изменились во время чтения. Повтори действие.');
  try{return JSON.parse(bytes.toString('utf8'));}catch{throw invalid();}
 }catch(error){
  if(optional&&error.code==='ENOENT')return null;
  if(error.code==='ELOOP')throw invalid('Настройки внешнего диска не могут быть ссылкой.');
  throw error;
 }finally{await handle?.close();}
}
async function syncDirectory(directory){
 const handle=await fs.open(directory,'r');try{await handle.sync();}finally{await handle.close();}
}
async function atomicPrivateJson(filename,value){
 const text=JSON.stringify(value,null,2)+'\n';
 if(Buffer.byteLength(text)>MAX_SETTINGS_BYTES)throw invalid('Слишком много сохранённых подключений внешнего диска.');
 try{const old=await fs.lstat(filename);if(old.isSymbolicLink()||!old.isFile()||old.nlink!==1)throw invalid('Настройки внешнего диска не могут быть ссылкой.');}catch(error){if(error.code!=='ENOENT')throw error;}
 const temporary=filename+'.'+crypto.randomUUID()+'.tmp';let handle;
 try{
  handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(text);await handle.sync();await handle.close();handle=null;
  await fs.rename(temporary,filename);await fs.chmod(filename,0o600);await syncDirectory(path.dirname(filename));
 }finally{await handle?.close().catch(()=>{});await fs.rm(temporary,{force:true}).catch(()=>{});}
}
async function plistJson(xml){
 return new Promise((resolve,reject)=>{
  const child=execFile('/usr/bin/plutil',['-convert','json','-o','-','--','-'],{timeout:10000,maxBuffer:1024*1024},(error,stdout)=>{
   if(error)return reject(error);
   try{resolve(JSON.parse(stdout));}catch(error){reject(error);}
  });
  child.stdin.on('error',reject);child.stdin.end(xml);
 });
}
async function nativeVolumeInfo(volume){
 if(process.platform!=='darwin')throw externalStorageUnavailable('Проверка внешнего диска доступна на Mac.');
 const {stdout}=await exec('/usr/sbin/diskutil',['info','-plist',volume],{timeout:10000,maxBuffer:1024*1024});
 return plistJson(stdout);
}
async function mountedVolume(volume){
 try{
  internalFilesystemDevices||=Promise.all([fs.stat('/Volumes'),fs.stat('/')]).then(([parent,system])=>({parent:parent.dev,system:system.dev})).catch(error=>{internalFilesystemDevices=null;throw error;});
  const [mount,devices]=await Promise.all([fs.lstat(volume),internalFilesystemDevices]);
  if(!mount.isDirectory()||mount.isSymbolicLink()||mount.dev===devices.parent||mount.dev===devices.system||await fs.realpath(volume)!==volume)throw externalStorageUnavailable('Выбранный внешний диск не подключён. Team Room ждёт его подключения.');
  return mount;
 }catch(error){if(error.code==='EXTERNAL_STORAGE_UNAVAILABLE')throw error;throw externalStorageUnavailable();}
}
export async function inspectExternalVolume(value,{readVolumeInfo=nativeVolumeInfo}={}){
 const volume=volumePath(value);await mountedVolume(volume);
 let info;try{info=await readVolumeInfo(volume);}catch(error){if(error.code==='EXTERNAL_STORAGE_UNAVAILABLE')throw error;throw externalStorageUnavailable('Не удалось проверить выбранный внешний диск.');}
 const uuid=info?.VolumeUUID||info?.APFSVolumeUUID;
 if(info?.MountPoint!==volume||info?.Internal!==false||typeof uuid!=='string'||!UUID.test(uuid))throw externalStorageUnavailable('Выбранный путь не является подключённым внешним диском.');
 return {volumePath:volume,volumeUuid:uuid.toUpperCase(),deviceIdentifier:String(info.DeviceIdentifier||''),internal:false};
}
async function existingRoot(location){
 try{
  const root=await fs.lstat(location.root),mount=await mountedVolume(location.volumePath);
  if(!root.isDirectory()||root.isSymbolicLink()||root.dev!==mount.dev||await fs.realpath(location.root)!==location.root)throw externalStorageUnavailable('Рабочая папка Team Room на внешнем диске недоступна.');
  return {root,mount};
 }catch(error){if(error.code==='EXTERNAL_STORAGE_UNAVAILABLE')throw error;throw externalStorageUnavailable('Рабочая папка Team Room на внешнем диске недоступна.');}
}
export async function validateExternalLocation(value,{home=os.homedir(),requireRoot=true,readVolumeInfo=nativeVolumeInfo}={}){
 const location=normalizedLocation(value,{home}),volume=await inspectExternalVolume(location.volumePath,{readVolumeInfo});
 if(volume.volumeUuid!==location.volumeUuid)throw externalStorageUnavailable('Подключён другой диск. Нужен диск, выбранный для Team Room.');
 if(requireRoot)await existingRoot(location);
 else{
  const mount=await mountedVolume(location.volumePath);let current=location.volumePath;
  for(const part of ['mac-offload','team-room-community-connect',location.deviceId]){
   current=path.join(current,part);
   try{const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==mount.dev||await fs.realpath(current)!==current)throw externalStorageUnavailable('Папка Team Room на внешнем диске не может быть ссылкой или другим диском.');}
   catch(error){if(error.code==='ENOENT')break;throw error;}
  }
 }
 return location;
}
export async function loadStorageLocations({home=os.homedir()}={}){
 const value=await readPrivateJson(storageLocationsPath({home}),{optional:true});
 if(value===null)return {version:1,locations:{}};
 if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1||!value.locations||typeof value.locations!=='object'||Array.isArray(value.locations)||Object.keys(value.locations).length>100)throw invalid();
 const locations={};for(const [id,row]of Object.entries(value.locations))locations[deviceId(id)]=normalizedLocation(row,{home,id});
 return {version:1,locations};
}
export async function readStorageLocationMarker(root,{home=os.homedir(),optional=false}={}){
 root=absolute(root);const filename=path.join(root,STORAGE_LOCATION_MARKER),key=home+'\0'+filename;let stat;
 try{stat=await fs.lstat(filename);}catch(error){if(optional&&error.code==='ENOENT')return null;throw error;}
 if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1||stat.size>MAX_SETTINGS_BYTES)throw invalid();
 const identity=[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':'),cached=markerCache.get(key);
 if(cached?.identity===identity)return {...cached.location};
 const raw=await readPrivateJson(filename,{optional});
 if(raw===null)return null;
 const location=normalizedLocation(raw,{home});
 if(root!==location.root&&root!==location.originalRoot)throw invalid('Маркер внешнего диска относится к другой рабочей папке.');
 const after=await fs.lstat(filename);
 if(after.isSymbolicLink()||!after.isFile()||after.nlink!==1||[after.dev,after.ino,after.size,after.mtimeMs,after.ctimeMs].join(':')!==identity)throw invalid('Маркер внешнего диска изменился во время проверки.');
 markerCache.set(key,{identity,location});if(markerCache.size>256)markerCache.delete(markerCache.keys().next().value);
 return location;
}
export async function writeStorageLocationMarker(root,value,{home=os.homedir()}={}){
 const location=await validateExternalLocation(value,{home});
 if(absolute(root)!==location.root)throw invalid();
 const previous=await readStorageLocationMarker(root,{home,optional:true});
 if(previous&&!sameLocation(previous,location))throw invalid('На внешнем диске уже находится другое подключение Team Room.');
 await atomicPrivateJson(path.join(root,STORAGE_LOCATION_MARKER),location);
 return location;
}
async function saveRegistry(value,{home}){
 const filename=storageLocationsPath({home}),directory=path.dirname(filename);
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 if((await fs.lstat(directory)).isSymbolicLink()||await fs.realpath(directory)!==directory)throw invalid('Папка настроек внешнего диска не может быть ссылкой.');
 await atomicPrivateJson(filename,value);
}
export async function saveStorageLocation(id,value,{home=os.homedir()}={}){
 id=deviceId(id);const location=await validateExternalLocation(normalizedLocation(value,{home,id}),{home});
 const marker=await readStorageLocationMarker(location.root,{home});
 if(!sameLocation(marker,location))throw invalid('Маркер внешнего диска не совпадает с настройками подключения.');
 const registry=await loadStorageLocations({home});registry.locations[id]=location;
 await saveRegistry(registry,{home});registerStorageGuard(location,{home});return location;
}
export async function removeStorageLocation(id,{home=os.homedir()}={}){
 id=deviceId(id);const registry=await loadStorageLocations({home});
 if(!Object.hasOwn(registry.locations,id))return false;
 const previous=registry.locations[id];delete registry.locations[id];await saveRegistry(registry,{home});guards.delete(previous.root);internalRoots.clear();return true;
}
export function registerStorageGuard(rootOrLocation,locationOrOptions={},options={}){
 const explicitRoot=typeof rootOrLocation==='string',value=explicitRoot?locationOrOptions:rootOrLocation;
 const {home=os.homedir()}=explicitRoot?options:locationOrOptions;
 const location=normalizedLocation(value,{home});
 if(explicitRoot&&absolute(rootOrLocation)!==location.root&&rootOrLocation!==location.originalRoot)throw invalid('Проверка диска относится к другой рабочей папке.');
 const previous=guards.get(location.root);
 const same=previous&&sameLocation(previous.location,location);
 guards.set(location.root,{location,home,identity:same?previous.identity:null,aliasIdentity:same?previous.aliasIdentity:null});internalRoots.clear();
 return location;
}
export async function resolveConfiguredDeviceRoot(id,{home=os.homedir(),requireAvailable=true}={}){
 id=deviceId(id);const registry=await loadStorageLocations({home}),location=registry.locations[id]||null,originalRoot=managedDeviceRoot(id,{home});
 if(!location)return {root:originalRoot,originalRoot,location:null,configured:false,available:true};
 registerStorageGuard(location,{home});
 try{
  await assertRegisteredLocation(guards.get(location.root));
  return {root:location.root,originalRoot,location,configured:true,available:true};
 }catch(error){
  if(requireAvailable||error.code!=='EXTERNAL_STORAGE_UNAVAILABLE')throw error;
  return {root:location.root,originalRoot,location,configured:true,available:false,error:error.message};
 }
}
async function assertRegisteredLocation(guard,target=guard.location.root){
 const {location,home}=guard,{root,mount}=await existingRoot(location);
 const identity=[root.dev,root.ino,mount.dev,mount.ino].join(':');
 if(identity!==guard.identity){await validateExternalLocation(location,{home});guard.identity=identity;}
 let marker;try{marker=await readStorageLocationMarker(location.root,{home});}catch(error){if(error.code==='ENOENT')throw externalStorageUnavailable('На выбранном диске отсутствует сохранённое подключение Team Room.');throw error;}
 if(!sameLocation(marker,location))throw externalStorageUnavailable('Выбранный диск содержит другое подключение Team Room.');
 if(contains(location.originalRoot,target)){
  try{
   const alias=await fs.lstat(location.originalRoot);
   if(!alias.isSymbolicLink())throw externalStorageUnavailable('Сохранённая папка подключения больше не ведёт на выбранный внешний диск.');
   const aliasIdentity=[alias.dev,alias.ino,alias.size,alias.mtimeMs,alias.ctimeMs].join(':');
   if(aliasIdentity!==guard.aliasIdentity){
    if(path.resolve(path.dirname(location.originalRoot),await fs.readlink(location.originalRoot))!==location.root||await fs.realpath(location.originalRoot)!==location.root)throw externalStorageUnavailable('Сохранённая папка подключения больше не ведёт на выбранный внешний диск.');
    guard.aliasIdentity=aliasIdentity;
   }
  }catch(error){if(error.code==='EXTERNAL_STORAGE_UNAVAILABLE')throw error;throw externalStorageUnavailable('Сохранённая папка подключения на внешнем диске недоступна.');}
 }
 return location;
}
export async function assertStorageForPath(value,{home=os.homedir()}={}){
 const target=absolute(path.resolve(value)),cacheKey=home+'\0'+target;
 let guard=[...guards.values()].find(item=>contains(item.location.root,target)||contains(item.location.originalRoot,target));
 if(!guard&&internalRoots.has(cacheKey))return null;
 if(!guard){
  const registry=await loadStorageLocations({home});
  const location=Object.values(registry.locations).find(item=>contains(item.root,target)||contains(item.originalRoot,target));
  if(location){registerStorageGuard(location,{home});guard=guards.get(location.root);}
 }
 if(guard)return assertRegisteredLocation(guard,target);
 let directory=target;
 for(let depth=0;depth<24&&directory!==path.dirname(directory);depth++,directory=path.dirname(directory)){
  let marker;try{marker=await readStorageLocationMarker(directory,{home,optional:true});}catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))continue;throw error;}
  if(marker){registerStorageGuard(marker,{home});return assertRegisteredLocation(guards.get(marker.root),target);}
 }
 // A broken compatibility link must never turn into a new internal workspace.
 const managedBase=path.join(absolute(home),'Library','Application Support','Team Room Community Connect');
 if(contains(managedBase,target)){
  const first=path.relative(managedBase,target).split(path.sep)[0];
  if(DEVICE_ID.test(first))try{
   const root=path.join(managedBase,first),stat=await fs.lstat(root);
   if(stat.isSymbolicLink()){
    const linked=path.resolve(path.dirname(root),await fs.readlink(root));
    if(linked.startsWith('/Volumes/'))throw externalStorageUnavailable('Внешний диск этого подключения недоступен.');
   }
  }catch(error){if(error.code!=='ENOENT')throw error;}
 }
 if(target.startsWith('/Volumes/')&&target.split(path.sep).includes('team-room-community-connect'))throw externalStorageUnavailable('На внешнем диске отсутствуют проверенные настройки подключения Team Room.');
 internalRoots.set(cacheKey,true);if(internalRoots.size>256)internalRoots.delete(internalRoots.keys().next().value);
 return null;
}
