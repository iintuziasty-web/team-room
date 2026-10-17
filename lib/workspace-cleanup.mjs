import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {portablePath,MAX_FILE,MAX_PROJECT} from './workspace.mjs';

const MAX_ENTRIES=10000,MAX_LEDGER_BYTES=16*1024*1024,MAX_DIRECTORIES=10000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const READ_FLAGS=constants.O_RDONLY|constants.O_NOFOLLOW;
const rootQueues=new Map();
const changed=()=>Object.assign(new Error('Рабочий файл изменился во время проверки.'),{code:'CLEANUP_CHANGED'});
const invalid=()=>Object.assign(new Error('Некорректный журнал разрешённой очистки.'),{code:'INVALID_CLEANUP_PLAN'});
const skippable=error=>['ENOENT','ENOTDIR','EISDIR','ELOOP','EACCES','EPERM','ENOTSUP','EOPNOTSUPP','EXDEV','CLEANUP_CHANGED','CLEANUP_LINK'].includes(error.code);
const sameDirectory=(a,b)=>b.isDirectory()&&!b.isSymbolicLink()&&a.dev===b.dev&&a.ino===b.ino;
const sameIdentity=(a,b)=>b.isFile()&&!b.isSymbolicLink()&&a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode&&a.size===b.size&&a.mtimeNs===b.mtimeNs;
const sameState=(a,b)=>sameIdentity(a,b)&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink;
const stateKey=stat=>[stat.dev,stat.ino,stat.mode,stat.size,stat.mtimeNs,stat.ctimeNs,stat.nlink].join(':');
const checkSignal=signal=>signal?.throwIfAborted();

function projectId(value){if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,240}$/.test(value))throw invalid();return value;}
function planId(value){if(typeof value!=='string'||!UUID.test(value))throw invalid();return value;}
function entry(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();
 const candidate=portablePath(value.path),keeper=portablePath(value.keepPath);
 if(candidate!==value.path||keeper!==value.keepPath||candidate===keeper||path.posix.basename(candidate)!==path.posix.basename(keeper)||!Number.isSafeInteger(value.size)||value.size<0||value.size>MAX_FILE||typeof value.hash!=='string'||!HASH.test(value.hash))throw invalid();
 return {path:candidate,keepPath:keeper,size:value.size,hash:value.hash};
}
function validatePlan(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!Array.isArray(value.entries)||value.entries.length>MAX_ENTRIES)throw invalid();
 const plan={id:planId(value.id),projectId:projectId(value.projectId),entries:value.entries.map(entry)},removed=new Set(),keepers=new Set();let bytes=0;
 for(const item of plan.entries){if(removed.has(item.path))throw invalid();removed.add(item.path);keepers.add(item.keepPath);bytes+=item.size;if(bytes>MAX_PROJECT)throw invalid();}
 for(const keeper of keepers)if(removed.has(keeper))throw invalid();
 if(Buffer.byteLength(JSON.stringify(plan))>MAX_LEDGER_BYTES)throw invalid();
 return plan;
}
async function anchor(root){
 if(typeof root!=='string'||!root||root.includes('\0'))throw invalid();
 const full=path.resolve(root),stat=await fs.lstat(full,{bigint:true});
 if(stat.isSymbolicLink()||!stat.isDirectory()||await fs.realpath(full)!==full)throw Object.assign(new Error('Рабочая папка не может быть ссылкой.'),{code:'CLEANUP_LINK'});
 return {full,stat};
}
async function assertRoot(root){const stat=await fs.lstat(root.full,{bigint:true});if(!sameDirectory(root.stat,stat))throw changed();}
async function location(root,parts,{mkdir=false}={}){
 await assertRoot(root);let full=root.full;const parents=[{full,stat:root.stat}];
 for(let i=0;i<parts.length;i++){
  full=path.join(full,parts[i]);
  if(i<parts.length-1){
   let created=false;
   if(mkdir){await assertParents({parents});try{await fs.mkdir(full,{mode:0o700});created=true;}catch(error){if(error.code!=='EEXIST')throw error;}}
   const stat=await fs.lstat(full,{bigint:true});if(stat.isSymbolicLink()||!stat.isDirectory())throw Object.assign(new Error('Папка очистки не может быть ссылкой.'),{code:'CLEANUP_LINK'});
   // Persist each newly created directory entry in its own parent too. A
   // synced index cannot survive a crash if its enclosing folder is lost.
   if(created)await syncDirectory({full,parents});
   parents.push({full,stat});
  }
 }
 return {full,parents};
}
async function assertParents(place){
 for(const parent of place.parents){const stat=await fs.lstat(parent.full,{bigint:true});if(!sameDirectory(parent.stat,stat))throw changed();}
}
async function openRegular(place){
 await assertParents(place);const before=await fs.lstat(place.full,{bigint:true});
 if(before.isSymbolicLink()||!before.isFile())throw Object.assign(new Error('Файл очистки должен быть обычным файлом.'),{code:'CLEANUP_LINK'});
 let handle;
 try{handle=await fs.open(place.full,READ_FLAGS);const stat=await handle.stat({bigint:true});if(!sameState(before,stat))throw changed();await assertParents(place);return {place,handle,stat};}
 catch(error){await handle?.close().catch(()=>{});throw error;}
}
async function assertOpen(file,{ignoreLinkChange=false}={}){
 await assertParents(file.place);const [atPath,atHandle]=await Promise.all([fs.lstat(file.place.full,{bigint:true}),file.handle.stat({bigint:true})]);
 const same=ignoreLinkChange?sameIdentity:sameState;if(!same(file.stat,atPath)||!same(file.stat,atHandle))throw changed();return atPath;
}
async function boundedRead(file,maximum,signal){
 if(file.stat.size>BigInt(maximum))throw invalid();const chunks=[];let bytes=0;const buffer=Buffer.alloc(64*1024);
 for(;;){checkSignal(signal);const result=await file.handle.read(buffer,0,Math.min(buffer.length,maximum-bytes+1),bytes);if(!result.bytesRead)break;bytes+=result.bytesRead;if(bytes>maximum)throw invalid();chunks.push(Buffer.from(buffer.subarray(0,result.bytesRead)));}
 await assertOpen(file);return Buffer.concat(chunks,bytes).toString('utf8');
}

// Mapping logs belong to the already approved, reversible server cleanup.
// Later state-only rows inherit metadata from their own prepared index only.
function readMapping(text,id,owner){
 const records=new Map();
 for(const line of text.split('\n')){
  if(!line.trim())continue;let row;try{row=JSON.parse(line)}catch{throw invalid();}
  if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.state!=='string')throw invalid();
  if(!Object.hasOwn(row,'index'))continue;
  if(!Number.isInteger(row.index)||row.index<0||row.index>=MAX_ENTRIES)throw invalid();
  const previous=records.get(row.index)||{index:row.index,quarantined:false};
  if(row.state==='quarantined'&&previous.quarantined)throw invalid();
  const next={...previous,state:row.state,quarantined:previous.quarantined||row.state==='quarantined'};
  for(const key of ['path','keepPath','size','hash'])if(Object.hasOwn(row,key)){
   if(Object.hasOwn(previous,key)&&previous[key]!==row[key])throw invalid();next[key]=row[key];
  }
  records.set(row.index,next);if(records.size>MAX_ENTRIES)throw invalid();
 }
 return validatePlan({id,projectId:owner,entries:[...records.values()].filter(row=>row.state==='quarantined').sort((a,b)=>a.index-b.index).map(entry)});
}

export async function readWorkspaceCleanupPlans(root,owner,{signal}={}){
 const id=projectId(owner);checkSignal(signal);let base;
 try{base=await anchor(root);}catch(error){if(error.code==='ENOENT')return [];throw error;}
 let directory;
 try{directory=await location(base,['.team-room','cleanup-quarantine','_']);await assertParents(directory);}
 catch(error){if(error.code==='ENOENT')return [];throw error;}
 const folder=path.dirname(directory.full),plans=[];let visited=0,bytes=0,count=0;
 const stream=await fs.opendir(folder);
 for await(const item of stream){
  checkSignal(signal);if(++visited>MAX_DIRECTORIES)throw invalid();if(!UUID.test(item.name)||item.isSymbolicLink()||!item.isDirectory())continue;
  let file;
  try{
   const place=await location(base,['.team-room','cleanup-quarantine',item.name,'mapping.jsonl']);file=await openRegular(place);
   if(file.stat.size>BigInt(MAX_LEDGER_BYTES-bytes))throw invalid();const text=await boundedRead(file,MAX_LEDGER_BYTES-bytes,signal);bytes+=Buffer.byteLength(text);
   const plan=readMapping(text,item.name,id);count+=plan.entries.length;if(count>MAX_ENTRIES)throw invalid();if(plan.entries.length)plans.push(plan);
  }catch(error){if(['ENOENT','ENOTDIR','CLEANUP_LINK'].includes(error.code))continue;throw error;}
  finally{await file?.handle.close().catch(()=>{});}
 }
 // A keeper is frozen across the entire response, including separate plans.
 const removed=new Set(),keepers=new Set();
 for(const plan of plans)for(const item of plan.entries){if(removed.has(item.path))throw invalid();removed.add(item.path);keepers.add(item.keepPath);}
 for(const keeper of keepers)if(removed.has(keeper))throw invalid();
 await assertParents(directory);return plans.sort((a,b)=>a.id.localeCompare(b.id));
}

async function hashOpen(file,signal){
 const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);let position=0;
 for(;;){checkSignal(signal);const result=await file.handle.read(buffer,0,buffer.length,position);if(!result.bytesRead)break;position+=result.bytesRead;if(BigInt(position)>file.stat.size)throw changed();hash.update(buffer.subarray(0,result.bytesRead));}
 if(BigInt(position)!==file.stat.size)throw changed();await assertOpen(file);return hash.digest('hex');
}
async function readExactly(handle,buffer,length,position,signal){
 let total=0;while(total<length){checkSignal(signal);const result=await handle.read(buffer,total,length-total,position+total);if(!result.bytesRead)throw changed();total+=result.bytesRead;}
}
async function compareAndHash(candidate,keeper,signal){
 const hash=crypto.createHash('sha256'),left=Buffer.alloc(1024*1024),right=Buffer.alloc(left.length),size=Number(candidate.stat.size);
 for(let position=0;position<size;position+=left.length){
  checkSignal(signal);const length=Math.min(left.length,size-position);await Promise.all([readExactly(candidate.handle,left,length,position,signal),readExactly(keeper.handle,right,length,position,signal)]);
  if(!left.subarray(0,length).equals(right.subarray(0,length)))return null;hash.update(left.subarray(0,length));
 }
 await assertOpen(candidate);await assertOpen(keeper);return hash.digest('hex');
}
async function syncDirectory(place){
 await assertParents(place);const full=path.dirname(place.full),stat=place.parents.at(-1).stat,handle=await fs.open(full,READ_FLAGS);
 try{if(!sameDirectory(stat,await handle.stat({bigint:true})))throw changed();await handle.sync();}finally{await handle.close();}
 await assertParents(place);
}
async function ensureRestoreIndex(root,plan,signal){
 checkSignal(signal);const indexPlace=await location(root,['.team-room','cleanup-quarantine',plan.id,'restore-index.json'],{mkdir:true});
 const fingerprint=crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex'),entries=plan.entries.map(item=>({...item,backupPath:'files/'+item.path}));
 async function existing(){
  const file=await openRegular(indexPlace);try{const value=JSON.parse(await boundedRead(file,MAX_LEDGER_BYTES,signal));if(value?.version!==1||value.fingerprint!==fingerprint||value.id!==plan.id||value.projectId!==plan.projectId||JSON.stringify(value.entries)!==JSON.stringify(entries))throw invalid();}finally{await file.handle.close();}
 }
 try{await existing();return;}catch(error){if(error.code!=='ENOENT')throw error;}
 const bytes=Buffer.from(JSON.stringify({version:1,id:plan.id,projectId:plan.projectId,fingerprint,createdAt:new Date().toISOString(),entries}));if(bytes.length>MAX_LEDGER_BYTES)throw invalid();
 const tempPlace=await location(root,['.team-room','cleanup-quarantine',plan.id,'.restore-index-'+crypto.randomUUID()+'.tmp']),handle=await fs.open(tempPlace.full,'wx',0o600);let linked=false;
 try{
  await handle.writeFile(bytes);await handle.sync();await assertParents(tempPlace);await assertParents(indexPlace);checkSignal(signal);
  try{await fs.link(tempPlace.full,indexPlace.full);linked=true;}catch(error){if(error.code!=='EEXIST')throw error;await existing();}
  // The index must survive a crash before any source pathname is removed.
  await syncDirectory(indexPlace);
 }finally{await handle.close();await fs.unlink(tempPlace.full).catch(()=>{});}
 if(linked)await existing();
}

async function applyPlan(root,plan,signal){
 const result={moved:0,skipped:0,bytes:0},keepers=new Map(),frozenInodes=new Set();let base,indexReady=false;
 checkSignal(signal);try{base=await anchor(root);}catch(error){if(error.code==='ENOENT')return {...result,skipped:plan.entries.length};throw error;}
 // Different spelling can name the same file on a Mac. Freeze keeper inodes
 // as well as manifest paths, without traversing any other workspace files.
 for(const name of new Set(plan.entries.map(item=>item.keepPath))){
  checkSignal(signal);let keeper;
  try{keeper=await openRegular(await location(base,name.split('/')));frozenInodes.add(keeper.stat.dev+':'+keeper.stat.ino);}
  catch(error){checkSignal(signal);if(!skippable(error))throw error;}
  finally{await keeper?.handle.close().catch(()=>{});}
 }
 for(const item of plan.entries){
  checkSignal(signal);let candidate,keeper,backup,moved=false;
  try{
   candidate=await openRegular(await location(base,item.path.split('/')));keeper=await openRegular(await location(base,item.keepPath.split('/')));
   if(frozenInodes.has(candidate.stat.dev+':'+candidate.stat.ino)||candidate.stat.size!==BigInt(item.size)||keeper.stat.size!==BigInt(item.size)){result.skipped++;continue;}
   const cache=keepers.get(item.keepPath),key=stateKey(keeper.stat),keeperHash=cache?.key===key?cache.hash:await hashOpen(keeper,signal);
   keepers.set(item.keepPath,{key,hash:keeperHash});if(keeperHash!==item.hash||await compareAndHash(candidate,keeper,signal)!==item.hash){result.skipped++;continue;}
   checkSignal(signal);if(!indexReady){await ensureRestoreIndex(base,plan,signal);indexReady=true;}
   const backupPlace=await location(base,['.team-room','cleanup-quarantine',plan.id,'files',...item.path.split('/')],{mkdir:true});
   await assertOpen(candidate);await assertOpen(keeper);await assertParents(backupPlace);checkSignal(signal);
   // link is an atomic no-overwrite reservation of this exact inode. Removing
   // its original pathname completes a move; no content is copied or erased.
   let created=true;
   try{await fs.link(candidate.place.full,backupPlace.full);}catch(error){if(error.code==='EEXIST')created=false;else if(skippable(error)){result.skipped++;continue;}else throw error;}
   backup=await openRegular(backupPlace);
   // A previous boot may have stopped after creating the link. Complete only
   // that same-inode move; an unrelated existing backup is never overwritten.
   if(!sameIdentity(candidate.stat,backup.stat)||created&&backup.stat.nlink!==candidate.stat.nlink+1n)throw changed();
   const linkedState=await assertOpen(candidate,{ignoreLinkChange:created});if(!sameState(linkedState,backup.stat))throw changed();
   await assertOpen(keeper,{ignoreLinkChange:keeper.stat.dev===candidate.stat.dev&&keeper.stat.ino===candidate.stat.ino});
   await backup.handle.sync();await syncDirectory(backupPlace);await assertParents(candidate.place);await assertParents(keeper.place);
   const latest=await fs.lstat(candidate.place.full,{bigint:true});if(!sameState(linkedState,latest)||!sameState(linkedState,await candidate.handle.stat({bigint:true})))throw changed();
   await assertOpen(keeper,{ignoreLinkChange:keeper.stat.dev===candidate.stat.dev&&keeper.stat.ino===candidate.stat.ino});await assertOpen(backup);checkSignal(signal);
   await fs.unlink(candidate.place.full);moved=true;result.moved++;result.bytes+=item.size;await syncDirectory(candidate.place);
  }catch(error){checkSignal(signal);if(!skippable(error))throw error;if(!moved)result.skipped++;}
  finally{await Promise.all([candidate?.handle.close().catch(()=>{}),keeper?.handle.close().catch(()=>{}),backup?.handle.close().catch(()=>{})]);}
 }
 return result;
}

export async function applyWorkspaceCleanup(root,value,{signal}={}){
 const plan=validatePlan(value),key=path.resolve(root),previous=rootQueues.get(key)||Promise.resolve();
 // Multiple plans for one workspace cannot race their source/keeper checks.
 const task=previous.catch(()=>{}).then(()=>applyPlan(key,plan,signal));rootQueues.set(key,task);
 try{return await task;}finally{if(rootQueues.get(key)===task)rootQueues.delete(key);}
}
