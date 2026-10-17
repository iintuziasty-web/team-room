import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readConnectorUpdateState,readConnectionDiagnostics} from './import-update.mjs';
import {updateSpaceError} from './update-space.mjs';

import {HUB} from './instance.mjs';
const exec=promisify(execFile);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const DEFAULT_VOLUME=process.env.TEAMROOM_EXTERNAL_VOLUME||'';
const CHUNK=1024*1024;
const identity=stat=>[stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
const contentIdentity=stat=>[stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
let storageModule;
async function storage(){
 if(!storageModule){
  // The same small module runs from a source checkout and the app's desktop
  // resources. It never imports the desktop UI or an installed application.
  for(const relative of ['../connect/lib/external-storage.mjs','../../lib/external-storage.mjs']){
   const url=new URL(relative,import.meta.url);
   try{await fs.access(fileURLToPath(url));storageModule=await import(url.href);break;}
   catch(error){if(error.code!=='ENOENT')throw error;}
  }
  if(!storageModule)throw new Error('В комплекте переноса отсутствует проверка внешнего диска. Скачай комплект заново.');
 }
 return storageModule;
}
async function exists(filename){try{await fs.lstat(filename);return true}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function directory(filename){const stat=await fs.lstat(filename,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(filename)!==filename)throw new Error('Папка переноса является ссылкой или недоступна.');return stat;}
async function privateFile(filename,maximum=65536){
 let handle;
 try{
  handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  const before=await handle.stat({bigint:true});
  if(!before.isFile()||before.nlink!==1n||before.size>BigInt(maximum))throw new Error('Файл подключения повреждён или является ссылкой.');
  const bytes=Buffer.alloc(Number(before.size));let offset=0;
  while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw new Error('Файл подключения изменился во время чтения.');offset+=bytesRead;}
  const after=await handle.stat({bigint:true}),current=await fs.lstat(filename,{bigint:true});
  if(!current.isFile()||current.isSymbolicLink()||identity(before)!==identity(after)||identity(before)!==identity(current))throw new Error('Файл подключения изменился во время чтения.');
  return bytes;
 }finally{await handle?.close();}
}
async function syncDirectory(filename){const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);try{await handle.sync()}finally{await handle.close()}}
async function atomic(filename,bytes,mode=0o600){
 await directory(path.dirname(filename));const temporary=filename+'.'+crypto.randomUUID()+'.tmp';let handle;
 try{handle=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,mode);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await fs.rename(temporary,filename);await syncDirectory(path.dirname(filename));}
 finally{await handle?.close();await fs.rm(temporary,{force:true}).catch(()=>{});}
}
function homeFor(desktopRoot){
 const home=desktopRoot?path.resolve(desktopRoot,'../../..'):os.homedir();
 if(desktopRoot&&path.resolve(desktopRoot)!==path.join(home,'Library','Application Support','Team Room Community Desktop'))throw new Error('Неверная папка приложения Team Room.');
 return home;
}
function sameJournals(left,right){return left.documents.every((document,index)=>{const other=right.documents[index];return other&&document.name===other.name&&document.exists===other.exists&&document.size===other.size&&document.hash===other.hash;});}
async function safeState(root,allowedRunIds=null){
 const state=await readConnectorUpdateState(root,{allowSavedResults:true}),diagnostics=await readConnectionDiagnostics(root);
 if(diagnostics?.loginBusy)throw new Error('Дождись завершения входа в подписку на этом Mac.');
 // workspaceReady:false also occurs during preparation. Only the explicit
 // durable nativeFinished record proves that no provider task can be stopped.
 const running=state.documents.find(document=>document.name==='running-jobs.json');
 for(const record of Object.values(running?.value||{}))if(record.finalization?.nativeFinished!==true||typeof record.workspaceReady!=='boolean'||!Array.isArray(record.events)||!Array.isArray(record.before))throw new Error('Дождись завершения задач на этом Mac. Перенос не прерывает работающую модель.');
 if(allowedRunIds&&state.runIds.some(id=>!allowedRunIds.includes(id)))throw new Error('На Mac появилась другая задача. Перенос отложен; файлы сохранены.');
 return {...state,savedOnly:!state.idle};
}
async function processTable(){
 const {stdout}=await exec('/bin/ps',['-axo','pid=,lstart=,command='],{timeout:5000,maxBuffer:16*1024*1024,env:{...process.env,LC_ALL:'C'}});
 return stdout.split('\n').flatMap(line=>{const match=line.match(/^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);return match?[{pid:Number(match[1]),started:match[2].replace(/\s+/g,' '),command:match[3]}]:[];});
}
async function serviceInfo(label){
 try{const {stdout}=await exec('/bin/launchctl',['print','gui/'+process.getuid()+'/'+label],{timeout:5000,maxBuffer:131072});return {registered:true,pid:Number(stdout.match(/\n\s*pid = (\d+)/)?.[1])||null};}
 catch(error){if(error.code==='ENOENT')throw error;return {registered:false,pid:null};}
}
async function bridgeProcesses(root){const bridge=path.join(root,'bridge.mjs');return (await processTable()).filter(row=>row.command.includes(bridge));}
async function waitStopped(root,known=[]){
 const deadline=Date.now()+30000,identities=new Set(known.map(row=>row.pid+':'+row.started));
 while(true){
  const rows=await processTable();
  if(!rows.some(row=>row.command.includes(path.join(root,'bridge.mjs'))||identities.has(row.pid+':'+row.started)))return;
  if(Date.now()>=deadline)throw new Error('Прежнее подключение ещё завершается. Перенос не менял его рабочие файлы.');
  await pause(200);
 }
}
async function stopService(label,root){
 const info=await serviceInfo(label),processes=await bridgeProcesses(root);
 if(info.pid&&!processes.some(row=>row.pid===info.pid))throw new Error('Работающий автозапуск не совпадает с программой этого подключения. Перенос отложен для проверки.');
 if(info.registered)await exec('/bin/launchctl',['bootout','gui/'+process.getuid()+'/'+label],{timeout:20000,maxBuffer:65536});
 await waitStopped(root,processes);
 return info;
}
async function ensureChildDirectory(parent,name){
 await directory(parent);const target=path.join(parent,name);
 try{await fs.mkdir(target,{mode:0o700})}catch(error){if(error.code!=='EEXIST')throw error;}
 await directory(target);return target;
}
function fileType(stat){return stat.isDirectory()?'directory':stat.isFile()?'file':stat.isSymbolicLink()?'symlink':null;}
async function inventory(root,{hash=false,guard=async()=>{},progress=()=>{}}={}){
 const rootStat=await directory(root),records=[],buffer=hash?Buffer.alloc(CHUNK):null;let bytes=0;
 async function walk(relative){
  await guard();const full=relative?path.join(root,relative):root,before=await fs.lstat(full,{bigint:true}),type=fileType(before);
  if(!type||before.dev!==rootStat.dev)throw new Error('В папке подключения есть отдельный том или специальный файл. Нужна отдельная проверка переноса.');
  const record={relative,type,mode:Number(before.mode&0o7777n),size:type==='file'?Number(before.size):0,identity:identity(before)};
  if(type==='file'){
   if(!Number.isSafeInteger(record.size)||!Number.isSafeInteger(bytes+record.size))throw new Error('Размер папки подключения не поддерживается.');
   const completed=bytes;bytes+=record.size;if(hash)record.hash=await digestFile(full,record,guard,buffer,offset=>progress(completed+offset,records.length+1));
  }else if(type==='symlink')record.link=await fs.readlink(full);
  records.push(record);progress(bytes,records.length);
  if(type==='directory'){
   const children=(await fs.readdir(full)).sort();
   for(const name of children){if(name==='.'||name==='..'||name.includes(path.sep)||name.includes('\0'))throw new Error('Недопустимое имя файла подключения.');await walk(relative?path.join(relative,name):name);}
  }
  const after=await fs.lstat(full,{bigint:true});if(identity(before)!==identity(after))throw new Error('Рабочие файлы изменились после остановки подключения. Перенос отменён.');
 }
 await walk('');return {records,bytes,rootIdentity:identity(rootStat)};
}
async function digestFile(filename,record,guard,buffer,progress){
 const handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await handle.stat({bigint:true});if(!before.isFile()||contentIdentity(before)!==record.identity)throw new Error('Рабочий файл изменился во время проверки.');
  const digest=crypto.createHash('sha256');let offset=0;
  while(offset<record.size){await guard();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,record.size-offset),offset);if(!bytesRead)throw new Error('Рабочий файл изменился во время проверки.');digest.update(buffer.subarray(0,bytesRead));offset+=bytesRead;progress(offset);}
  const after=await handle.stat({bigint:true}),current=await fs.lstat(filename,{bigint:true});
  if(!current.isFile()||current.isSymbolicLink()||identity(before)!==identity(after)||identity(before)!==identity(current))throw new Error('Рабочий файл изменился во время проверки.');
  return digest.digest('hex');
 }finally{await handle.close();}
}
function assertSameInventory(expected,current,{identities=false,renamedRoot=false}={}){
 if(expected.records.length!==current.records.length)throw new Error('Состав папки подключения изменился. Копия сохранена для восстановления.');
 for(let i=0;i<expected.records.length;i++){
  const a=expected.records[i],b=current.records[i];
  if(a.relative!==b.relative||a.type!==b.type||a.mode!==b.mode||a.size!==b.size||a.link!==b.link||a.hash!==undefined&&a.hash!==b.hash||identities&&!(renamedRoot&&!a.relative)&&a.identity!==b.identity)throw new Error('Проверка копии подключения не совпала. Прежние файлы сохранены.');
 }
}
async function copyInventory(root,destination,snapshot,guard,progress){
 await fs.mkdir(destination,{mode:0o700});const copied=[],buffer=Buffer.alloc(CHUNK);let bytes=0;
 for(const record of snapshot.records){
  if(typeof record.relative!=='string'||path.isAbsolute(record.relative)||record.relative&&path.normalize(record.relative)!==record.relative||record.relative.split(path.sep).includes('..'))throw new Error('Недопустимый путь файла в проверяемой копии.');
  await guard();const source=record.relative?path.join(root,record.relative):root,target=record.relative?path.join(destination,record.relative):destination;
  const sourceStat=await fs.lstat(source,{bigint:true});if(identity(sourceStat)!==record.identity||fileType(sourceStat)!==record.type)throw new Error('Рабочие файлы изменились после остановки подключения.');
  if(record.type==='directory'){if(record.relative)await fs.mkdir(target,{mode:0o700});copied.push({...record});progress(bytes,snapshot.bytes,copied.length);continue;}
  await directory(path.dirname(target));
  if(record.type==='symlink'){
   await fs.symlink(record.link,target);
   // chmod would follow the link. lchmod preserves unusual macOS link modes
   // while leaving an absolute, relative or dangling target untouched.
   if(Number((await fs.lstat(target,{bigint:true})).mode&0o7777n)!==record.mode){
    if(typeof fs.lchmod!=='function')throw new Error('Не удалось сохранить права ссылки на этом диске. Прежние файлы сохранены.');
    await fs.lchmod(target,record.mode);
   }
   if(typeof fs.lutimes==='function')await fs.lutimes(target,Number(sourceStat.atimeNs)/1e9,Number(sourceStat.mtimeNs)/1e9);
   if(await fs.readlink(source)!==record.link||identity(await fs.lstat(source,{bigint:true}))!==record.identity)throw new Error('Ссылка подключения изменилась во время переноса.');copied.push({...record});progress(bytes,snapshot.bytes,copied.length);continue;
  }
  const input=await fs.open(source,constants.O_RDONLY|constants.O_NOFOLLOW);let output;
  try{
   if(identity(await input.stat({bigint:true}))!==record.identity)throw new Error('Рабочий файл изменился во время переноса.');
   output=await fs.open(target,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   const digest=crypto.createHash('sha256');let offset=0;
   while(offset<record.size){
    await guard();const {bytesRead}=await input.read(buffer,0,Math.min(buffer.length,record.size-offset),offset);if(!bytesRead)throw new Error('Рабочий файл изменился во время переноса.');
    const chunk=buffer.subarray(0,bytesRead);digest.update(chunk);let written=0;while(written<bytesRead){const result=await output.write(chunk,written,bytesRead-written,offset+written);if(!result.bytesWritten)throw new Error('Внешний диск не подтвердил запись файла.');written+=result.bytesWritten;}
    offset+=bytesRead;bytes+=bytesRead;progress(bytes,snapshot.bytes);
   }
   if(identity(await input.stat({bigint:true}))!==record.identity||identity(await fs.lstat(source,{bigint:true}))!==record.identity)throw new Error('Рабочий файл изменился во время переноса.');
   await output.chmod(record.mode);await output.utimes(Number(sourceStat.atimeNs)/1e9,Number(sourceStat.mtimeNs)/1e9);await output.sync();copied.push({...record,hash:digest.digest('hex')});progress(bytes,snapshot.bytes,copied.length);
  }finally{await output?.close();await input.close();}
 }
 // Create writable directories first, then restore their original modes and
 // timestamps after the full subtree has been copied.
 for(const record of [...snapshot.records].reverse())if(record.type==='directory'){
  await guard();
  const target=record.relative?path.join(destination,record.relative):destination,source=record.relative?path.join(root,record.relative):root;
  const stat=await fs.lstat(source,{bigint:true});if(identity(stat)!==record.identity)throw new Error('Папка подключения изменилась во время переноса.');
  await directory(target);await fs.chmod(target,record.mode);await fs.utimes(target,Number(stat.atimeNs)/1e9,Number(stat.mtimeNs)/1e9);await syncDirectory(target);progress(bytes,snapshot.bytes,copied.length);
 }
 return {...snapshot,records:copied};
}
// These helpers operate only on caller-supplied fixture directories. Importing
// or using them never touches a volume, launch agent, registry or hub lease.
export async function inspectConnectionStorageFiles(root,options={}){return inventory(path.resolve(root),options);}
export async function copyConnectionStorageFiles(root,destination,snapshot,{guard=async()=>{},progress=()=>{}}={}){return copyInventory(path.resolve(root),path.resolve(destination),snapshot,guard,progress);}
export function verifyConnectionStorageFiles(expected,current,options={}){assertSameInventory(expected,current,options);return true;}
export async function verifyConnectionStorageAlias(originalRoot,targetRoot){
 const alias=await fs.lstat(originalRoot);
 if(!alias.isSymbolicLink()||await fs.readlink(originalRoot)!==targetRoot||await fs.realpath(originalRoot)!==targetRoot)throw new Error('Прежний путь подключения больше не ведёт на проверенную копию внешнего диска.');
 return true;
}
async function writeInventoryProof(filename,snapshot,metadata,guard,progress){
 const temporary=filename+'.'+crypto.randomUUID()+'.tmp';let handle;
 try{
  handle=await fs.open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  await handle.writeFile(JSON.stringify({version:1,...metadata}).slice(0,-1)+',"inventory":[\n');
  let parts=[],length=0;
  for(let index=0;index<snapshot.records.length;index++){
   await guard();const {relative,type,mode,size,hash,link}=snapshot.records[index],text=(index?',\n':'')+JSON.stringify({relative,type,mode,size,...(hash?{hash}:{}),...(link!==undefined?{link}:{})});
   parts.push(text);length+=Buffer.byteLength(text);
   if(length>=65536){await handle.writeFile(parts.join(''));parts=[];length=0;}
   progress(index+1);
  }
  if(parts.length)await handle.writeFile(parts.join(''));await handle.writeFile('\n]}\n');await handle.sync();await handle.close();handle=null;
  await fs.rename(temporary,filename);await syncDirectory(path.dirname(filename));
 }finally{await handle?.close();await fs.rm(temporary,{force:true}).catch(()=>{});}
}
async function programPatch(bundledConnect){
 if(!bundledConnect)return null;
 const root=await fs.realpath(path.resolve(bundledConnect));await directory(path.join(root,'lib'));
 const names=['bridge.mjs','install-integration.mjs','teamroom.mjs',...(await fs.readdir(path.join(root,'lib'),{withFileTypes:true})).filter(entry=>entry.isFile()&&/^[A-Za-z0-9_-]+\.mjs$/.test(entry.name)).map(entry=>'lib/'+entry.name)];
 const files=new Map();for(const name of names)files.set(name,await privateFile(path.join(root,name),4*1024*1024));
 const bridge=files.get('bridge.mjs').toString('utf8'),version=bridge.match(/^const connectorVersion='(\d+\.\d+\.\d+)';$/m)?.[1];
 if(!version||!files.has('lib/external-storage.mjs')||!bridge.includes('external-storage.mjs'))throw new Error('В комплекте отсутствует подключение с поддержкой внешнего диска.');
 return {files,version,bytes:[...files.values()].reduce((total,value)=>total+value.length,0)};
}
function replaceRoot(value,oldRoot,newRoot){
 if(typeof value==='string'){
  if(value===oldRoot||value.startsWith(oldRoot+path.sep))return newRoot+value.slice(oldRoot.length);
  // PATH is a list of independent absolute paths; avoid rewriting unrelated
  // names merely containing the managed root as part of another string.
  if(value.includes(':'))return value.split(':').map(part=>replaceRoot(part,oldRoot,newRoot)).join(':');
  return value;
 }
 if(Array.isArray(value))return value.map(item=>replaceRoot(item,oldRoot,newRoot));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,replaceRoot(item,oldRoot,newRoot)]));
 return value;
}
async function plistBytes(value,folder){
 const filename=path.join(folder,'.plist-'+crypto.randomUUID()+'.json');
 try{await fs.writeFile(filename,JSON.stringify(value),{mode:0o600,flag:'wx'});const result=await exec('/usr/bin/plutil',['-convert','xml1','-o','-',filename],{timeout:5000,maxBuffer:262144});return Buffer.from(result.stdout);}
 finally{await fs.rm(filename,{force:true}).catch(()=>{});}
}
async function bootstrap(plist){await exec('/bin/launchctl',['bootstrap','gui/'+process.getuid(),plist],{timeout:20000,maxBuffer:65536});}
async function waitReady(root,version,restartAt,guard,event){
 for(let attempt=0;attempt<120;attempt++){
  await guard();if(attempt&&attempt%30===0)event('storage-migration',{message:'Ожидаю подтверждение подключения с внешнего диска…'});
  try{const diagnostics=await readConnectionDiagnostics(root),at=Date.parse(diagnostics?.at);if(diagnostics?.connectorVersion===version&&diagnostics.state===1&&at>=restartAt&&at<=Date.now()+5000){const service=await serviceInfo('io.teamroom.community.connect.'+path.basename(root));if(service.pid&&(await bridgeProcesses(root)).some(row=>row.pid===service.pid))return diagnostics;}}catch(error){if(error.code!=='ENOENT'&&error.message.includes('ссылкой'))throw error;}
  await pause(500);
 }
 throw new Error('Подключение с внешнего диска не подтвердилось за 60 секунд. Восстанавливаю прежний запуск.');
}

export async function migrateConnectionStorage(entry,{volumePath=DEFAULT_VOLUME,externalBase,desktopRoot,event=()=>{},bundledConnect}={}){
 if(process.platform!=='darwin')throw new Error('Перенос подключения на внешний диск предназначен для macOS.');
 const lib=await storage(),home=homeFor(desktopRoot),desktop=desktopRoot||path.join(home,'Library','Application Support','Team Room Community Desktop');
 const deviceId=entry?.config?.deviceId;
 if(!/^[A-Za-z0-9-]{16,80}$/.test(deviceId||''))throw new Error('Не найдено подключение этого Mac.');
 const originalRoot=lib.managedDeviceRoot(deviceId,{home}),label='io.teamroom.community.connect.'+deviceId;
 const existing=(await lib.loadStorageLocations({home})).locations[deviceId];
 if(existing){
  const location=await lib.validateExternalLocation(existing,{home});
  const alias=await fs.lstat(originalRoot);
  if(await fs.realpath(entry.root)===location.root&&alias.isSymbolicLink()&&await fs.readlink(originalRoot)===location.root&&await fs.realpath(originalRoot)===location.root)return {migrated:true,alreadyMigrated:true,root:location.root,message:'Подключение уже хранится на внешнем диске.'};
  throw new Error('Для этого подключения уже сохранён другой путь. Нужна проверка прежнего переноса.');
 }
 const root=path.resolve(entry.root||'');
 if(root!==originalRoot||await fs.realpath(root)!==root||entry.agent?.label!==label||!entry.agent?.plist||path.resolve(entry.agent.plist)!==path.join(home,'Library','LaunchAgents',label+'.plist'))throw new Error('Этот выпуск переносит только подключение, установленное приложением Team Room. Прежний ручной запуск требует отдельной проверки.');
 const originalStat=await directory(root),originalPlist=await privateFile(entry.agent.plist),config=JSON.parse((await privateFile(path.join(root,'device-config.json'),16384)).toString('utf8'));
 if(config.deviceId!==deviceId||config.token!==entry.config.token||typeof config.token!=='string'||config.token.length<20||config.token.length>4096||new URL(config.hubUrl).origin!==HUB)throw new Error('Файл подключения изменился или относится к другому пространству.');
 const parsedPlist=JSON.parse((await exec('/usr/bin/plutil',['-convert','json','-o','-',entry.agent.plist],{timeout:5000,maxBuffer:262144})).stdout),args=parsedPlist.ProgramArguments;
 if(parsedPlist.Label!==label||!Array.isArray(args)||args[1]!==path.join(root,'bridge.mjs')||typeof args[0]!=='string'||!path.isAbsolute(args[0])||parsedPlist.WorkingDirectory!==root)throw new Error('Автозапуск подключения имеет другую конфигурацию. Перенос отменён.');
 const patch=await programPatch(bundledConnect),sourceBridge=(await privateFile(path.join(root,'bridge.mjs'),4*1024*1024)).toString('utf8');
 const expectedVersion=patch?.version||sourceBridge.match(/^const connectorVersion='(\d+\.\d+\.\d+)';$/m)?.[1];
 if(!expectedVersion||!patch&&(!sourceBridge.includes('external-storage.mjs')||!await exists(path.join(root,'lib','external-storage.mjs'))))throw new Error('Сначала нужен комплект подключения с поддержкой внешнего диска. Малый комплект переноса может обновить его без загрузки полного приложения.');
 volumePath=path.resolve(volumePath);const volume=await lib.inspectExternalVolume(volumePath),base=lib.externalStorageBase(volumePath);
 if(externalBase&&path.resolve(externalBase)!==base)throw new Error('Для внешнего диска разрешена папка mac-offload/team-room-community-connect.');
 const targetRoot=path.join(base,deviceId),location={version:1,deviceId,root:targetRoot,originalRoot,volumePath,volumeUuid:volume.volumeUuid,migratedAt:new Date().toISOString()};
 await lib.validateExternalLocation(location,{home,requireRoot:false});
 if(await exists(targetRoot))throw new Error('Папка этого подключения уже есть на внешнем диске. Сохраняю её для отдельной проверки.');
 const initial=await safeState(root),initialService=await serviceInfo(label);
 // The mounted volume must already exist. Only its two approved children may
 // be created; recursive mkdir can never fabricate a missing /Volumes mount.
 const offload=await ensureChildDirectory(volumePath,'mac-offload');await ensureChildDirectory(offload,'team-room-community-connect');
 await directory(desktop);const locks=await ensureChildDirectory(desktop,'storage-migration-locks'),lock=path.join(locks,deviceId);
 try{await fs.mkdir(lock,{mode:0o700})}catch(error){if(error.code==='EEXIST')throw new Error('Перенос этого подключения уже выполняется или требует восстановления после остановки.');throw error;}
 const migrationId=crypto.randomUUID(),stage=path.join(base,'.'+deviceId+'.migration-'+migrationId),backup=root+'.storage-backup-'+Date.now()+'-'+migrationId;
 const recoveryFile=path.join(base,'.'+deviceId+'.migration-'+migrationId+'.json'),savedPlist=path.join(base,'.'+deviceId+'.migration-'+migrationId+'.plist'),inventoryFile=path.join(base,'.'+deviceId+'.migration-'+migrationId+'.inventory.json');
 let lease=null,leaseError=null,renewing=null,lastRenew=0,renewTimer=null,lastGuard=0,lastVolumeCheck=0,lastProgress=0,volumeStat=null,baseStat=null;
 let stopped=false,published=false,plistChanged=false,sourceRenamed=false,aliasInstalled=false,registered=false,started=false,cleanupStarted=false,copyProof=null,migratedPlist=null,recoveryEvidence={},internalSpaceBefore=null;
 async function hub(method,input){
  const response=await fetch(HUB+'/api/device-import-maintenance',{method,headers:{Authorization:'Bearer '+config.token,'content-type':'application/json'},body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(15000)});
  let data;try{data=await response.json()}catch{throw new Error('Сервер не подтвердил безопасный перенос.');}
  if(!response.ok)throw new Error(typeof data.error==='string'?data.error:'Сервер не разрешил перенос занятого Mac.');return data;
 }
 async function renew(){
  if(renewing)return renewing;
  renewing=(async()=>{try{const updated=await hub('POST',{leaseId:lease.leaseId,renew:true});if(updated.leaseId!==lease.leaseId||!Number.isFinite(updated.expiresAt)||updated.expiresAt<Date.now()+60000)throw new Error('Сервер не продлил безопасный перенос.');lease=updated;lastRenew=Date.now();}catch(error){leaseError=error;throw error;}finally{renewing=null;}})();return renewing;
 }
 async function guard(force=false){
  if(leaseError)throw new Error('Сервер перестал подтверждать безопасный перенос. Копия сохранена; восстанавливаю прежний запуск.');
  if(lease&&(!Number.isFinite(lease.expiresAt)||lease.expiresAt<Date.now()+75000))await renew();
  if(!force&&Date.now()-lastGuard<1000)return;lastGuard=Date.now();
  const stat=await directory(volumePath);if(String(stat.dev)!==String(volumeStat.dev))throw new Error('Внешний диск отключён или заменён. Прежние файлы сохранены.');
  if(force||Date.now()-lastVolumeCheck>30000){const current=await lib.inspectExternalVolume(volumePath);if(current.volumeUuid!==volume.volumeUuid)throw new Error('Подключён другой внешний диск. Перенос остановлен.');lastVolumeCheck=Date.now();}
  const currentBase=await directory(base);if(currentBase.dev!==volumeStat.dev||currentBase.dev!==baseStat.dev||currentBase.ino!==baseStat.ino)throw new Error('Папка внешнего диска изменилась во время переноса.');
  if(aliasInstalled)await verifyConnectionStorageAlias(originalRoot,targetRoot);
 }
 function reportProgress(message,bytes,total,files){if(Date.now()-lastProgress>=30000){lastProgress=Date.now();event('storage-migration',{message,bytes,...(total!==undefined?{total}:{}),...(files!==undefined?{files}:{})});}}
 async function saveRecovery(phase,extra={}){recoveryEvidence={...recoveryEvidence,...extra};await atomic(recoveryFile,Buffer.from(JSON.stringify({version:1,migrationId,deviceId,phase,originalRoot,targetRoot,stage,backup,plist:entry.agent.plist,savedPlist,inventoryFile,location,at:new Date().toISOString(),...recoveryEvidence},null,2)));}
 try{
  volumeStat=await directory(volumePath);baseStat=await directory(base);
  if(baseStat.dev!==volumeStat.dev)throw new Error('Папка подключения находится на другом диске.');
  await fs.writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:process.pid,migrationId,root,targetRoot}),{mode:0o600,flag:'wx'});
  event('storage-migration',{message:initial.savedOnly?'Проверяю сохранённые результаты перед переносом…':'Проверяю, что этот Mac свободен…'});
  lease=await hub('POST',initial.savedOnly?{savedResults:true,runIds:initial.runIds}:{});
  if(typeof lease.leaseId!=='string'||!Number.isFinite(lease.expiresAt)||lease.expiresAt<Date.now()+75000)throw new Error('Сервер не подтвердил время безопасного переноса.');lastRenew=Date.now();
  renewTimer=setInterval(()=>{if(Date.now()-lastRenew>=120000)void renew().catch(()=>{});},10000);renewTimer.unref();
  await safeState(root,initial.runIds);await guard(true);
  if(!(await privateFile(entry.agent.plist)).equals(originalPlist))throw new Error('Автозапуск изменился во время проверки.');
  await atomic(savedPlist,originalPlist);await saveRecovery('stopping');
  // Recheck under the hub lease immediately before bootout, then wait for the
  // actual process identities and all instances using the old bridge path.
  await safeState(root,initial.runIds);stopped=true;await stopService(label,root);
  const preserved=await safeState(root,initial.runIds);await guard(true);
  const stoppedRoot=await directory(root);if(stoppedRoot.dev!==originalStat.dev||stoppedRoot.ino!==originalStat.ino)throw new Error('Папка подключения изменилась после проверки автозапуска.');
  event('storage-migration',{message:'Копирую всё подключение на внешний диск: рабочие файлы, память и сохранённые результаты…'});
  const snapshot=await inventory(root,{guard,progress:(bytes,files)=>reportProgress('Считаю рабочие файлы подключения…',bytes,undefined,files)});
  internalSpaceBefore=await fs.statfs(path.dirname(root),{bigint:true});
  const disk=await fs.statfs(base,{bigint:true}),required=BigInt(snapshot.bytes+(patch?.bytes||0))+BigInt(snapshot.records.length)*4096n+256n*1024n*1024n;
  if(disk.bavail*disk.bsize<required)throw new Error('На внешнем диске недостаточно свободного места для полной проверенной копии подключения.');
  await saveRecovery('copying',{bytes:snapshot.bytes,files:snapshot.records.length});
  copyProof=await copyInventory(root,stage,snapshot,guard,(bytes,total,files)=>reportProgress('Перенос на внешний диск…',bytes,total,files));
  event('storage-migration',{message:'Проверяю каждый скопированный файл по его полному содержимому…'});
  const copied=await inventory(stage,{hash:true,guard,progress:(bytes,files)=>reportProgress('Проверяю копию на внешнем диске…',bytes,copyProof.bytes,files)});assertSameInventory(copyProof,copied);const stageStat=await directory(stage);
  const current=await inventory(root,{guard,progress:(bytes,files)=>reportProgress('Проверяю, что прежние файлы не изменились…',bytes,snapshot.bytes,files)});assertSameInventory(snapshot,current,{identities:true});
  if(!sameJournals(preserved,await safeState(root,initial.runIds)))throw new Error('Журнал результатов изменился после остановки подключения.');
  await writeInventoryProof(inventoryFile,copyProof,{deviceId,originalRoot,targetRoot,bytes:copyProof.bytes},guard,files=>reportProgress('Сохраняю проверку переноса…',copyProof.bytes,copyProof.bytes,files));await saveRecovery('verified',{bytes:copyProof.bytes,inventoryVerified:true});
  if(patch){
   for(const [name,bytes]of patch.files){await guard();const filename=path.join(stage,name);if(await exists(filename)){const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Файл программы в копии является ссылкой.');}await atomic(filename,bytes);if(!(await privateFile(filename,4*1024*1024)).equals(bytes))throw new Error('Внешний диск не подтвердил файлы новой программы.');}
  }
  if(!sameJournals(preserved,await safeState(stage,initial.runIds)))throw new Error('Сохранённые результаты в копии не совпали с прежним подключением.');
  await guard(true);if(await exists(targetRoot))throw new Error('Во время переноса появилась другая папка подключения на внешнем диске.');
  const stageNow=await directory(stage);if(stageNow.dev!==stageStat.dev||stageNow.ino!==stageStat.ino)throw new Error('Проверенная копия изменилась перед переключением подключения.');
  await fs.rename(stage,targetRoot);published=true;await syncDirectory(base);
  await lib.writeStorageLocationMarker(targetRoot,location,{home});
  await guard(true);const runtimeTemp=await ensureChildDirectory(targetRoot,'.runtime-temp'),npmCache=await ensureChildDirectory(targetRoot,'.npm-cache');
  await fs.chmod(runtimeTemp,0o700);await fs.chmod(npmCache,0o700);await syncDirectory(targetRoot);
  const newPlist=replaceRoot(parsedPlist,root,targetRoot);newPlist.ProgramArguments[1]=path.join(targetRoot,'bridge.mjs');newPlist.WorkingDirectory=targetRoot;
  if(newPlist.EnvironmentVariables!==undefined&&(!newPlist.EnvironmentVariables||typeof newPlist.EnvironmentVariables!=='object'||Array.isArray(newPlist.EnvironmentVariables)))throw new Error('Автозапуск содержит неверные настройки окружения.');
  newPlist.EnvironmentVariables={...(newPlist.EnvironmentVariables||{}),TMPDIR:runtimeTemp,TMP:runtimeTemp,TEMP:runtimeTemp,NPM_CONFIG_CACHE:npmCache};
  migratedPlist=await plistBytes(newPlist,base);
  await guard(true);if(!(await privateFile(entry.agent.plist)).equals(originalPlist))throw new Error('Автозапуск изменился перед переключением подключения.');
  await atomic(entry.agent.plist,migratedPlist);plistChanged=true;
  const sourceNow=await inventory(root,{guard,progress:(bytes,files)=>reportProgress('Проверяю прежние файлы перед переключением…',bytes,snapshot.bytes,files)});assertSameInventory(snapshot,sourceNow,{identities:true});
  if(identity(await directory(root))!==snapshot.rootIdentity)throw new Error('Папка прежнего подключения изменилась перед переключением.');
  await fs.rename(root,backup);sourceRenamed=true;await fs.symlink(targetRoot,root,'dir');aliasInstalled=true;await syncDirectory(path.dirname(root));
  await lib.saveStorageLocation(deviceId,location,{home});registered=true;
  await saveRecovery('starting',{bytes:copyProof.bytes});await guard(true);await renew();
  event('storage-migration',{message:'Запускаю то же подключение с внешнего диска…'});
  const restartAt=Date.now();await bootstrap(entry.agent.plist);started=true;stopped=false;
  await waitReady(targetRoot,expectedVersion,restartAt,guard,event);
  // This is the only deletion of the original data. Hash its unchanged backup
  // after the new bridge has confirmed the expected version and connection.
  event('storage-migration',{message:'Подключение работает с внешнего диска. Проверяю прежнюю копию перед освобождением места на Mac…'});
  const beforeDelete=await inventory(backup,{hash:true,guard,progress:(bytes,files)=>reportProgress('Проверяю прежнюю копию перед освобождением места…',bytes,copyProof.bytes,files)});assertSameInventory(copyProof,beforeDelete,{identities:true,renamedRoot:true});
  await lib.validateExternalLocation(location,{home});await guard(true);
  const ready=await readConnectionDiagnostics(targetRoot);
  if(ready?.state!==1||ready.connectorVersion!==expectedVersion||Date.now()-Date.parse(ready.at)>90000)throw new Error('Связь с внешнего диска пропала перед удалением прежней копии.');
  const backupStat=await directory(backup);if(backupStat.dev!==originalStat.dev||backupStat.ino!==originalStat.ino)throw new Error('Прежняя копия изменилась; удаление отменено.');
  await saveRecovery('removing-verified-backup',{bytes:copyProof.bytes});cleanupStarted=true;
  try{await fs.rm(backup,{recursive:true,force:false});}
  catch{event('storage-migration',{message:'Подключение работает с внешнего диска. Часть проверенной прежней копии требует отдельного освобождения места на Mac.'});return {migrated:true,root:targetRoot,originalRoot,internalBackupKept:true,backup,recoveryFile,message:'Подключение перенесено. Прежняя проверенная копия на Mac удалена не полностью; она сохранена для завершения очистки.'};}
  await syncDirectory(path.dirname(root)).catch(()=>{});await fs.rm(savedPlist,{force:true}).catch(()=>{});await fs.rm(inventoryFile,{force:true}).catch(()=>{});await fs.rm(recoveryFile,{force:true}).catch(()=>{});
  const internalSpaceAfter=await fs.statfs(path.dirname(root),{bigint:true}).catch(()=>null),difference=internalSpaceAfter?internalSpaceAfter.bavail*internalSpaceAfter.bsize-internalSpaceBefore.bavail*internalSpaceBefore.bsize:null;
  return {migrated:true,root:targetRoot,originalRoot,bytesMoved:copyProof.bytes,...(difference!==null?{freedBytes:Number(difference>0n?difference:0n)}:{}),message:'Всё подключение перенесено на внешний диск. Рабочие файлы, память и сохранённые результаты сохранены; прежняя копия на Mac удалена.'};
 }catch(error){
  let rollbackError;
  if(!cleanupStarted){
   try{
    if(started||published&&(await serviceInfo(label)).registered){await stopService(label,published?targetRoot:root);started=false;stopped=true;}
    if(aliasInstalled){const stat=await fs.lstat(root);if(!stat.isSymbolicLink()||await fs.readlink(root)!==targetRoot)throw new Error('Путь прежнего подключения изменился.');await fs.unlink(root);aliasInstalled=false;}
    if(sourceRenamed){const stat=await directory(backup);if(stat.dev!==originalStat.dev||stat.ino!==originalStat.ino||await exists(root))throw new Error('Прежняя копия изменилась.');await fs.rename(backup,root);sourceRenamed=false;await syncDirectory(path.dirname(root));}
    if(plistChanged){if(!(await privateFile(entry.agent.plist)).equals(migratedPlist))throw new Error('Автозапуск изменился после переключения.');await atomic(entry.agent.plist,originalPlist);plistChanged=false;}
    if(registered){await lib.removeStorageLocation(deviceId,{home});registered=false;}
    if(stopped&&initialService.registered&&!(await serviceInfo(label)).registered){await waitStopped(root);await bootstrap(entry.agent.plist);stopped=false;}
   }catch(failure){rollbackError=failure;}
  }
  if(await exists(stage)||published)await saveRecovery(rollbackError?'recovery-required':'rolled-back',{bytes:copyProof?.bytes||0}).catch(()=>{});
  if(rollbackError)throw Object.assign(new Error('Перенос не завершён. Полная копия и прежний запуск сохранены; требуется восстановление подключения. Прежние файлы не удалены.'),{recoveryFile,backup,root:published?targetRoot:stage,cause:rollbackError});
  const failure=error?.code==='ENOSPC'?new Error('Во время переноса закончилось свободное место на диске. Прежние файлы сохранены.'):updateSpaceError(error);
  throw Object.assign(failure,{recoveryFile:await exists(recoveryFile)?recoveryFile:null,recoveryRoot:published?targetRoot:await exists(stage)?stage:null});
 }finally{
  if(renewTimer)clearInterval(renewTimer);if(renewing)await renewing.catch(()=>{});
  if(lease)try{await hub('DELETE',{leaseId:lease.leaseId})}catch{event('storage-migration',{message:'Сервер временно удерживает обслуживание этого Mac. Ограничение снимется автоматически.'});}
  await fs.rm(lock,{recursive:true,force:true}).catch(()=>{});
 }
}

export async function runStorageMigrationCli(argv=process.argv.slice(2)){
 const options={};for(let i=0;i<argv.length;i+=2){if(!['--root','--device','--volume','--external-base','--desktop-root','--bundled-connect'].includes(argv[i])||!argv[i+1]||Object.hasOwn(options,argv[i]))throw new Error('Неверные параметры переноса.');options[argv[i]]=argv[i+1];}
 const home=homeFor(options['--desktop-root']),lib=await storage();
 let root=options['--root'];if(!root&&options['--device'])root=lib.managedDeviceRoot(options['--device'],{home});if(!root)throw new Error('Укажи установленное подключение этого Mac.');
 root=path.resolve(root);const config=JSON.parse((await privateFile(path.join(root,'device-config.json'),16384)).toString('utf8'));
 if(options['--device']&&options['--device']!==config.deviceId)throw new Error('Выбрано другое подключение Mac.');
 const label='io.teamroom.community.connect.'+config.deviceId,entry={root,config,agent:{label,plist:path.join(home,'Library','LaunchAgents',label+'.plist')}};
 return migrateConnectionStorage(entry,{volumePath:options['--volume']||DEFAULT_VOLUME,externalBase:options['--external-base'],desktopRoot:options['--desktop-root'],bundledConnect:options['--bundled-connect'],event:(event,data)=>process.stdout.write(JSON.stringify({type:'event',event,...data})+'\n')});
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 try{const result=await runStorageMigrationCli();process.stdout.write(JSON.stringify({ok:true,...result})+'\n');}
 catch(error){const message=error.name==='SyntaxError'?'Файл подключения повреждён.':String(error.message||'Не удалось перенести подключение.').replace(/(?:[A-Za-z0-9_-]{36,}\.){2}[A-Za-z0-9_-]+/g,'[скрыто]').replace(/(?:token|authorization|password)\s*[:=]\s*\S+/gi,'[скрыто]').slice(0,700);process.stdout.write(JSON.stringify({ok:false,error:message,...(error.recoveryFile?{recoveryFile:error.recoveryFile}:{}),...(error.recoveryRoot?{recoveryRoot:error.recoveryRoot}:{})})+'\n');process.exitCode=1;}
}
