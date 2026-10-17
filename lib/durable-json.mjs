import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {coalescedSave} from './coalesced-save.mjs';

// A successful return is authority to acknowledge/delete the previous copy.
// Keep serialization before the first await so the saved bytes are one state.
export async function syncDirectory(directory,{io=fs,platform=process.platform}={}){
 let handle;
 try{handle=await io.open(directory,constants.O_RDONLY|(constants.O_DIRECTORY||0)|(constants.O_NOFOLLOW||0));if(!(await handle.stat()).isDirectory())throw new Error('Недопустимая папка сохранения состояния.');await handle.sync();}
 catch(error){if(platform!=='win32'||!['EISDIR','EINVAL','ENOTSUP','EBADF','EPERM'].includes(error.code))throw error;}
 finally{await handle?.close();}
}
export async function writeDurableJson(filename,value,{io=fs}={}){
 const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));
 const directory=path.dirname(filename),temporary=filename+'.'+crypto.randomUUID()+'.tmp';let handle;
 try{
  const stat=await io.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Недопустимая папка сохранения состояния.');
  handle=await io.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
  await io.rename(temporary,filename);
  await syncDirectory(directory,{io});
 }finally{await handle?.close().catch(()=>{});await io.rm(temporary,{force:true}).catch(()=>{});}
}

export function createDurableJsonSaver(filename,readState,{write=writeDurableJson,onError=()=>{}}={}){
 let latest;
 const save=coalescedSave(async()=>{const bytes=Buffer.from(JSON.stringify(readState()));await write(filename,bytes);});
 const request=()=>{const pending=save();if(pending!==latest){latest=pending;pending.catch(error=>{try{onError(error)}catch{}});}return pending;};
 request.drain=async()=>{if(latest)await latest;};return request;
}

// Retrying persistence must never repeat a native model turn. The value belongs
// to that already finished turn; only run(value) may be repeated on storage errors.
export class RetryFinalizer{
 constructor({run,onFailure=()=>{},baseDelay=1000,maxDelay=30000,maxConcurrent=1,schedule=setTimeout,cancel=clearTimeout,now=Date.now}={}){
  if(typeof run!=='function'||!Number.isFinite(baseDelay)||baseDelay<1||!Number.isFinite(maxDelay)||maxDelay<baseDelay||!Number.isInteger(maxConcurrent)||maxConcurrent<1)throw new TypeError('Некорректная очередь сохранения результатов.');
  this.run=run;this.onFailure=onFailure;this.baseDelay=baseDelay;this.maxDelay=maxDelay;this.maxConcurrent=maxConcurrent;this.schedule=schedule;this.cancel=cancel;this.now=now;this.entries=new Map();this.running=0;this.stopped=false;
 }
 enqueue(key,value){
  const existing=this.entries.get(key);if(existing)return existing;
  let resolve;const promise=new Promise(done=>{resolve=done;});
  const entry={key,value,promise,resolve,attempts:0,state:'ready',running:null,timer:null,error:null,retryAt:null};this.entries.set(key,entry);queueMicrotask(()=>this.pump());return entry;
 }
 pump(){
  if(this.stopped)return;
  for(const entry of this.entries.values()){
   if(this.running>=this.maxConcurrent)break;if(entry.state!=='ready')continue;
   entry.state='running';entry.attempts++;entry.retryAt=null;this.running++;
   entry.running=Promise.resolve().then(()=>this.run(entry.value,entry)).then(result=>{
    entry.state='completed';entry.error=null;this.entries.delete(entry.key);entry.resolve(result);
   },error=>{
    entry.error=error;entry.state='waiting';const delay=Math.min(this.maxDelay,this.baseDelay*2**Math.min(entry.attempts-1,20));entry.retryAt=this.now()+delay;
    try{Promise.resolve(this.onFailure(error,entry)).catch(()=>{});}catch{}
    if(!this.stopped){entry.timer=this.schedule(()=>{entry.timer=null;entry.state='ready';this.pump();},delay);entry.timer?.unref?.();}
   }).finally(()=>{entry.running=null;this.running--;this.pump();});
  }
 }
 stop(){this.stopped=true;for(const entry of this.entries.values())if(entry.timer){this.cancel(entry.timer);entry.timer=null;}}
 async drain(){await Promise.allSettled([...this.entries.values()].map(entry=>entry.running).filter(Boolean));}
}
