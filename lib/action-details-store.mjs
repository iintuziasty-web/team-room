import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Tool-call details were ~70% of team-data.json and pushed the single JSON
// string toward V8's maximum string length. Large details now live in
// immutable, content-addressed files; in memory every action still carries
// its full `details`, so the rest of the hub is unchanged. Only the persisted
// form carries `detailsRef`. Files are never deleted by the hub: older daily
// backups and other hub versions may still reference them.
const SHA=/^[a-f0-9]{64}$/;
const each=(data,visit)=>{for(const chat of Array.isArray(data?.conversations)?data.conversations:[])for(const message of Array.isArray(chat?.messages)?chat.messages:[])if(Array.isArray(message?.actions))message.actions.forEach((action,index)=>{if(action&&typeof action==='object')visit(action,message.actions,index);});};
// Swap one key for another at the same position: message fingerprints hash
// the JSON of actions, so key order must survive a save/load round trip.
const swapKey=(object,from,to,value)=>{const out={};for(const key of Object.keys(object))if(key===from)out[to]=value;else if(key!==to)out[key]=object[key];return out;};
async function syncDirectory(directory){const handle=await fs.open(directory,constants.O_RDONLY|(constants.O_DIRECTORY||0));try{await handle.sync();}finally{await handle.close();}}
async function batches(items,size,work){for(let i=0;i<items.length;i+=size)await Promise.all(items.slice(i,i+size).map(work));}

export class ActionDetailsStore{
 constructor(folder,{threshold=16384,concurrency=8}={}){this.folder=folder;this.threshold=threshold;this.concurrency=concurrency;this.known=new Set();this.cache=new WeakMap();}
 file(sha){if(!SHA.test(sha))throw new Error('Некорректная ссылка на подробности действия.');return path.join(this.folder,sha.slice(0,2),sha+'.json');}
 async init(){
  await fs.mkdir(this.folder,{recursive:true,mode:0o700});
  const stat=await fs.lstat(this.folder);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Недопустимая папка подробностей действий.');
  for(const shard of await fs.readdir(this.folder,{withFileTypes:true})){
   if(!shard.isDirectory()||!/^[a-f0-9]{2}$/.test(shard.name))continue;
   for(const entry of await fs.readdir(path.join(this.folder,shard.name),{withFileTypes:true}))if(entry.isFile()&&/^[a-f0-9]{64}\.json$/.test(entry.name))this.known.add(entry.name.slice(0,64));
  }
  return this;
 }
 measure(action){
  const cached=this.cache.get(action);if(cached&&cached.details===action.details)return cached;
  let entry={details:action.details,ref:null,text:null};
  if(action.details!==undefined&&action.details!==null){const text=JSON.stringify(action.details);if(typeof text==='string'&&text.length>=this.threshold)entry={details:action.details,ref:{sha256:crypto.createHash('sha256').update(text).digest('hex'),chars:text.length},text};}
  this.cache.set(action,entry);return entry;
 }
 async write(sha,text){
  if(this.known.has(sha))return false;
  const target=this.file(sha),dir=path.dirname(target);await fs.mkdir(dir,{recursive:true,mode:0o700});
  try{await fs.lstat(target);this.known.add(sha);return false;}catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=path.join(dir,'.'+sha+'.'+crypto.randomUUID()+'.tmp');
  try{const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}await fs.rename(temporary,target);}
  finally{await fs.rm(temporary,{force:true}).catch(()=>{});}
  return true;
 }
 async flush(pending){
  const items=[...pending];if(!items.length)return 0;const dirs=new Set();let written=0;
  await batches(items,this.concurrency,async([sha,text])=>{if(await this.write(sha,text)){written++;dirs.add(path.dirname(this.file(sha)));}});
  for(const dir of dirs)await syncDirectory(dir);if(dirs.size)await syncDirectory(this.folder);
  for(const [sha]of items)this.known.add(sha);
  return written;
 }
 // Boot: restore spilled details and move large inline details out, so the
 // first save does not have to write hundreds of megabytes at once.
 async load(data){
  const refs=[],inline=[];each(data,(action,list,index)=>{if(action.details===undefined&&action.detailsRef)refs.push({action,list,index});else inline.push(action);});
  const report={restored:0,missing:0,migrated:0};
  await batches(refs,this.concurrency,async({action,list,index})=>{
   const ref=action.detailsRef;
   try{
    const text=await fs.readFile(this.file(ref?.sha256),'utf8');
    if(crypto.createHash('sha256').update(text).digest('hex')!==ref.sha256)throw Object.assign(new Error('checksum'),{code:'CHECKSUM'});
    const restored=swapKey(action,'detailsRef','details',JSON.parse(text));list[index]=restored;this.known.add(ref.sha256);this.cache.set(restored,{details:restored.details,ref:{sha256:ref.sha256,chars:text.length},text:null});report.restored++;
   }catch(error){report.missing++;if(report.missing<=5)console.error('Подробности действия недоступны:',String(ref?.sha256||'').slice(0,12),error.code||error.message);}
  });
  const pending=new Map();for(const action of inline){const entry=this.measure(action);if(entry.ref&&!this.known.has(entry.ref.sha256))pending.set(entry.ref.sha256,entry.text);if(entry.ref)entry.text=null;}
  report.migrated=await this.flush(pending);return report;
 }
 // Synchronous so the caller's snapshot stays consistent with what it has
 // captured before any await. Unchanged objects are shared, not copied.
 prepare(data){
  const pending=new Map();let spilled=0;
  const conversations=Array.isArray(data.conversations)?data.conversations.map(chat=>{
   if(!Array.isArray(chat?.messages))return chat;let messages=null;
   chat.messages.forEach((message,mi)=>{
    if(!Array.isArray(message?.actions))return;let actions=null;
    message.actions.forEach((action,ai)=>{
     if(!action||typeof action!=='object'||action.details===undefined)return;
     const entry=this.measure(action);if(!entry.ref)return;
     if(!this.known.has(entry.ref.sha256))pending.set(entry.ref.sha256,entry.text??JSON.stringify(action.details));
     entry.text=null;actions||=message.actions.slice();actions[ai]=swapKey(action,'details','detailsRef',entry.ref);spilled++;
    });
    if(actions){messages||=chat.messages.slice();messages[mi]={...message,actions};}
   });
   return messages?{...chat,messages}:chat;
  }):data.conversations;
  return {value:{...data,conversations},pending,spilled};
 }
}
