import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const RECORD_NAME=/^(\d{16})-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.json$/;
const safeSequence=value=>Number.isSafeInteger(value)&&value>=0;
const operationObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const checksum=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error=(code,message)=>Object.assign(new Error(message),{code});
const unavailable=()=>error('MESSAGE_JOURNAL_UNAVAILABLE','Не удалось надёжно сохранить сообщение. Повтори отправку после восстановления хранилища.');
const corrupt=()=>error('MESSAGE_JOURNAL_CORRUPT','Журнал сообщений повреждён. Исходные записи сохранены для восстановления.');
const tooLarge=()=>Object.assign(error('MESSAGE_JOURNAL_TOO_LARGE','Сообщение слишком большое для сохранения. Прикрепи текст файлом.'),{status:413});

async function syncDirectory(directory){
 const handle=await fs.open(directory,constants.O_RDONLY|(constants.O_DIRECTORY||0)|(constants.O_NOFOLLOW||0));
 try{if(!(await handle.stat()).isDirectory())throw unavailable();await handle.sync();}finally{await handle.close();}
}

function applySynchronously(apply,operation){
 const result=apply(operation);
 if(result&&typeof result.then==='function'){Promise.resolve(result).catch(()=>{});throw unavailable();}
}

/**
 * Durable input acceptance, independent of the large application snapshot.
 * The caller owns operation validation/application and stores appliedSequence
 * inside the same JSON snapshot it later passes to checkpoint().
 */
export class MessageJournal{
 constructor(directory,{sequence=0,maxBytes=2*1024*1024}={}){
  if(typeof directory!=='string'||!directory||!safeSequence(sequence)||!Number.isSafeInteger(maxBytes)||maxBytes<=0)throw new TypeError('Некорректные настройки журнала сообщений.');
  this.directory=path.resolve(directory);this.maxBytes=maxBytes;this.appliedSequence=sequence;this.nextSequence=sequence;
  this.files=new Map();this.tail=Promise.resolve();this.cleanupTail=Promise.resolve();this.initialized=false;this.initializing=false;this.failed=null;
 }
 async init(apply){
  if(this.initialized||this.initializing||typeof apply!=='function')throw new TypeError('Журнал сообщений должен быть инициализирован один раз.');
  if(this.failed)throw this.failed;
  this.initializing=true;
  try{
   let created=false;try{const stat=await fs.lstat(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw corrupt();}catch(reason){if(reason.code!=='ENOENT')throw reason;await fs.mkdir(this.directory,{recursive:true,mode:0o700});created=true;}
   const stat=await fs.lstat(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw corrupt();
   if(created)await syncDirectory(path.dirname(this.directory));
   const entries=await fs.readdir(this.directory,{withFileTypes:true}),records=[];let removedTemporary=false;
   for(const entry of entries){
    const match=entry.name.match(RECORD_NAME);
    if(!match){
     if(entry.name.endsWith('.tmp')){if(entry.isFile()&&!entry.isSymbolicLink()){await fs.unlink(path.join(this.directory,entry.name));removedTemporary=true;}continue;}
     if(entry.name.endsWith('.json'))throw corrupt();
     continue;
    }
    const sequence=Number(match[1]);if(!safeSequence(sequence)||sequence===0)throw corrupt();
    this.nextSequence=Math.max(this.nextSequence,sequence);this.files.set(entry.name,sequence);
    // A saved snapshot already owns these operations. They need no parsing,
    // but their filenames remain tracked until a durable cleanup succeeds.
    if(sequence<=this.appliedSequence)continue;
    if(!entry.isFile()||entry.isSymbolicLink())throw corrupt();
    records.push({name:entry.name,sequence});
   }
   records.sort((left,right)=>left.sequence-right.sequence||left.name.localeCompare(right.name));
   for(const file of records){
    if(file.sequence!==this.appliedSequence+1)throw corrupt();
    const handle=await fs.open(path.join(this.directory,file.name),constants.O_RDONLY|(constants.O_NOFOLLOW||0));let value;
    try{
     const stat=await handle.stat();if(!stat.isFile()||stat.size>this.maxBytes||stat.size===0)throw corrupt();
     const content=await handle.readFile();if(content.length>this.maxBytes)throw corrupt();
     try{value=JSON.parse(content.toString('utf8'));}catch{throw corrupt();}
    }finally{await handle.close();}
    if(!operationObject(value)||Object.keys(value).some(key=>!['version','sequence','operation','checksum'].includes(key))||value.version!==1||value.sequence!==file.sequence||!operationObject(value.operation)||typeof value.checksum!=='string'||!/^[a-f0-9]{64}$/.test(value.checksum)||checksum({version:1,sequence:value.sequence,operation:value.operation})!==value.checksum)throw corrupt();
    applySynchronously(apply,value.operation);this.appliedSequence=file.sequence;
   }
   if(removedTemporary||created)await syncDirectory(this.directory);
   this.initialized=true;return this;
  }catch(reason){this.failed=reason?.code==='MESSAGE_JOURNAL_CORRUPT'?reason:unavailable();throw this.failed;}finally{this.initializing=false;}
 }
 commit(operation,apply){
  if(this.failed)return Promise.reject(this.failed);
  if(!this.initialized||typeof apply!=='function'||!operationObject(operation))return Promise.reject(unavailable());
  // Snapshot the small operation at call time. Waiting for another append must
  // not allow the caller to change what is eventually made durable.
  let captured;try{const json=JSON.stringify(operation);if(typeof json!=='string')throw unavailable();if(Buffer.byteLength(json)>this.maxBytes)throw tooLarge();captured=JSON.parse(json);if(!operationObject(captured))throw unavailable();}catch(reason){return Promise.reject(reason?.code==='MESSAGE_JOURNAL_TOO_LARGE'?reason:unavailable());}
  const result=this.tail.then(async()=>{
   if(this.failed)throw this.failed;
   if(!safeSequence(this.nextSequence+1)){this.failed=unavailable();throw this.failed;}
   const sequence=this.nextSequence+1,body={version:1,sequence,operation:captured},bytes=Buffer.from(JSON.stringify({...body,checksum:checksum(body)}));
   if(bytes.length>this.maxBytes)throw tooLarge();
   this.nextSequence=sequence;
   const name=String(sequence).padStart(16,'0')+'-'+crypto.randomUUID()+'.json',filename=path.join(this.directory,name),temporary=filename+'.tmp';let handle,renamed=false;
   try{
    const stat=await fs.lstat(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw unavailable();
    handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;
    await fs.rename(temporary,filename);renamed=true;this.files.set(name,sequence);
    await syncDirectory(this.directory);
    applySynchronously(apply,captured);this.appliedSequence=sequence;
    return {sequence,bytes:bytes.length};
   }catch{
    // Nothing reached the journal before the rename: the temporary file is
    // removed below and memory is unchanged, so this sequence can be reused
    // and the next send may succeed once the disk recovers.
    if(!renamed){this.nextSequence=sequence-1;throw unavailable();}
    // A failed apply or I/O can leave a durable but unapplied event. Never
    // advance beyond it or remove it; startup replay will resolve the prefix.
    this.failed=unavailable();throw this.failed;
   }finally{await handle?.close().catch(()=>{});if(!renamed)await fs.unlink(temporary).catch(()=>{});}
  });
  this.tail=result.catch(()=>{});return result;
 }
 checkpoint(capturedSequence){
  if(!this.initialized||!safeSequence(capturedSequence)||capturedSequence>this.appliedSequence)return Promise.reject(unavailable());
  const result=this.cleanupTail.then(async()=>{
   const retired=[...this.files].filter(([,sequence])=>sequence<=capturedSequence);
   if(!retired.length)return {sequence:capturedSequence,removed:0};
   try{
    const stat=await fs.lstat(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw unavailable();
    for(const [name]of retired)try{await fs.unlink(path.join(this.directory,name));}catch(reason){if(reason.code!=='ENOENT')throw reason;}
    await syncDirectory(this.directory);
    // Keep every entry tracked until both deletion and directory fsync succeed.
    // A failed cleanup can safely retry files that were already unlinked.
    for(const [name,sequence]of retired)if(this.files.get(name)===sequence)this.files.delete(name);
    return {sequence:capturedSequence,removed:retired.length};
   }catch{throw unavailable();}
  });
  this.cleanupTail=result.catch(()=>{});return result;
 }
 async drain(){await this.tail;if(this.failed)throw this.failed;}
}
