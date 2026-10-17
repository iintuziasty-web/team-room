import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {coalescedSave} from './coalesced-save.mjs';

const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,240}$/.test(value);
const MAX_PROGRESS=256*1024*1024;

// Frequent deltas need a durable current reply, not a rewrite of every imported
// conversation. The main state remains authoritative at request/turn boundaries.
export class RunProgress {
 constructor(storage){this.directory=path.join(storage,'run-progress');this.writers=new Map();this.preserved=new Set();}
 async init(){
  await fs.mkdir(this.directory,{recursive:true,mode:0o700});
  const stat=await fs.lstat(this.directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Недопустимая папка промежуточных ответов.');
  return this;
 }
 filename(runId){if(!validId(runId))throw new Error('Недопустимый запуск промежуточного сохранения.');return path.join(this.directory,runId+'.json');}
 async recover(data){
  let recovered=0;
  for(const entry of await fs.readdir(this.directory,{withFileTypes:true})){
   if(!entry.isFile()||entry.isSymbolicLink()||!entry.name.endsWith('.json'))continue;
   const runId=entry.name.slice(0,-5);if(!validId(runId))continue;
   const file=this.filename(runId);
   const chat=data.conversations?.find(c=>c.run?.id===runId),message=chat?.messages?.find(m=>m.runId===runId&&m.status==='running');
   // Unknown/stale records may be large. Preserve their bytes without parsing
   // them while the authoritative main state is already resident in memory.
   if(!message){this.preserved.add(file);continue;}
   try{
   const stat=await fs.lstat(file);
   if(stat.isSymbolicLink()||stat.size>MAX_PROGRESS)throw new Error('Промежуточный ответ повреждён. Сохранённые файлы оставлены для восстановления.');
   let value;try{value=JSON.parse(await fs.readFile(file,'utf8'));}catch{throw new Error('Промежуточный ответ повреждён. Сохранённые файлы оставлены для восстановления.');}
   if(value.version!==1||value.runId!==runId||value.chatId!==chat.id||value.messageId!==message.id||!validId(value.chatId)||!Number.isSafeInteger(value.revision)||value.revision<1||!value.message||typeof value.message.text!=='string'||!Array.isArray(value.message.actions))throw new Error('Некорректная промежуточная запись. Исходные данные сохранены.');
   if(message?.status==='running'&&chat.run?.id===runId&&value.revision>(message.progressRevision||0)){
    // A full save with the same revision can contain a later authoritative
    // result. Length is not an ordering signal: final text can be shorter.
    message.text=value.message.text;message.actions=value.message.actions;message.progressRevision=value.revision;
    if(Number.isSafeInteger(value.message.remoteSeq))message.remoteSeq=value.message.remoteSeq;
    if(Array.isArray(value.message.remoteEventSeqs))message.remoteEventSeqs=value.message.remoteEventSeqs.filter(Number.isSafeInteger);
    if(Array.isArray(value.message.agents))message.agents=value.message.agents;
    if(Array.isArray(value.message.replyBoundaries))message.replyBoundaries=value.message.replyBoundaries.filter(b=>b&&validId(b.messageId)&&Number.isSafeInteger(b.offset)&&b.offset>=0).map(b=>({messageId:b.messageId,offset:b.offset}));
    if(value.message.model)message.model=value.message.model;
    if(value.message.usage)message.usage=value.message.usage;
    if(value.message.permissionDenials)message.permissionDenials=value.message.permissionDenials;
    if(value.message.executionMode)message.executionMode=value.message.executionMode;
    if(value.message.plan)message.plan=value.message.plan;
    if(typeof value.message.nativeExecutionMode==='boolean')message.nativeExecutionMode=value.message.nativeExecutionMode;
    if(Number.isFinite(Date.parse(value.savedAt))&&Date.parse(value.savedAt)>(Date.parse(chat.updatedAt)||0))chat.updatedAt=value.savedAt;
    recovered++;
   }
   // Removal happens only after the merged main state has been made durable.
   }catch{
    // Optional progress damage must not prevent access to the valid main state.
    // Preserve the file for repair; never silently discard an unparsed reply.
    this.preserved.add(file);
    const quarantine=path.join(this.directory,'quarantine');
    try{await fs.mkdir(quarantine,{recursive:true,mode:0o700});const stat=await fs.lstat(quarantine);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error();await fs.rename(file,path.join(quarantine,runId+'.'+crypto.randomUUID()+'.json'));}catch{}
    console.error('Повреждён промежуточный ответ. Основная история доступна; исходная запись сохранена для восстановления.');
   }
  }
  return recovered;
 }
 save(chat,message){
  if(message.status!=='running')return Promise.resolve();
  const runId=message.runId;this.filename(runId);
  let entry=this.writers.get(runId);
  if(!entry){
   entry={chat,message};
   entry.write=coalescedSave(async()=>{
    const {chat,message}=entry;
    if(message.status!=='running')return;
    // Advance at capture time, before either JSON snapshot can be serialized.
    const revision=message.progressRevision=(message.progressRevision||0)+1;
    const value={version:1,revision,runId,chatId:chat.id,messageId:message.id,savedAt:new Date().toISOString(),message:{text:message.text||'',actions:message.actions||[],model:message.model,usage:message.usage,permissionDenials:message.permissionDenials,executionMode:message.executionMode,nativeExecutionMode:message.nativeExecutionMode,plan:message.plan,agents:message.agents,remoteSeq:message.remoteSeq,remoteEventSeqs:message.remoteEventSeqs,replyBoundaries:message.replyBoundaries}};
    const bytes=JSON.stringify(value);if(Buffer.byteLength(bytes)>MAX_PROGRESS)throw new Error('Промежуточный ответ превышает допустимый размер; результат остаётся на выполняющем компьютере.');
    const target=this.filename(runId),temporary=target+'.'+crypto.randomUUID()+'.tmp';
    const handle=await fs.open(temporary,'wx',0o600);
    try{await handle.writeFile(bytes);await handle.sync();}catch(error){await fs.rm(temporary,{force:true}).catch(()=>{});throw error;}finally{await handle.close();}
    await fs.rename(temporary,target);
   });this.writers.set(runId,entry);
  }
  entry.chat=chat;entry.message=message;entry.pending=entry.write();return entry.pending;
 }
 async clear(runId){
  const entry=this.writers.get(runId);if(entry)await entry.pending.catch(()=>{});
  this.writers.delete(runId);await fs.rm(this.filename(runId),{force:true});
 }
 async clearRecovered(){
  for(const entry of await fs.readdir(this.directory,{withFileTypes:true}))if(entry.isFile()&&!entry.isSymbolicLink()&&entry.name.endsWith('.json')&&validId(entry.name.slice(0,-5))&&!this.preserved.has(this.filename(entry.name.slice(0,-5))))await fs.rm(this.filename(entry.name.slice(0,-5)),{force:true});
 }
}
