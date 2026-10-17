import fs from 'node:fs/promises';
import {createReadStream,constants as fsConstants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {internalDirectory,filePath,portablePath,isIgnoredPortablePath,validateFileInventory,MAX_TRANSFER,MAX_FILE,MAX_PROJECT,MAX_WORKSPACE_FILES,MAX_WORKSPACE_INVENTORY_BYTES} from './workspace.mjs';

export const RESULT_CHUNK_BYTES=4*1024*1024;
const MAX_VALIDATED_FILES=10000;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=message=>Object.assign(new Error(message),{status:400});
function validateRun(runId){if(!/^[a-zA-Z0-9_-]{1,240}$/.test(runId||''))throw fail('Недопустимый запуск передачи результата.');}
function classifyMetadata(files){
 if(!Array.isArray(files)||files.length>MAX_WORKSPACE_FILES)throw fail('Недопустимый список файлов.');
 const portable=[],ignored=[],seen=new Set();let bytes=0;
 for(const file of files){const skip=isIgnoredPortablePath(file?.path);if(seen.has(file.path)||!Number.isSafeInteger(file.size)||file.size<0||file.size>MAX_FILE||!/^[a-f0-9]{64}$/.test(file.hash||''))throw fail('Некорректный список файлов.');seen.add(file.path);bytes+=file.size;if(bytes>MAX_PROJECT)throw fail('Проект превышает 50 ГБ.');const row={path:file.path,size:file.size,hash:file.hash,...(file.updatedAt?{updatedAt:file.updatedAt}:{})};(skip?ignored:portable).push(row);}
 validateFileInventory(portable);portable.sort((a,b)=>a.path.localeCompare(b.path));ignored.sort((a,b)=>a.path.localeCompare(b.path));return {files:portable,ignoredFiles:ignored};
}
function metadata(files){return classifyMetadata(files).files;}
function deletedMetadata(files){
 if(!Array.isArray(files)||files.length>MAX_WORKSPACE_FILES)throw fail('Некорректный список удалённых файлов.');const result=[],seen=new Set();
 for(const file of files){const ignored=isIgnoredPortablePath(file?.path);if(seen.has(file.path)||!/^[a-f0-9]{64}$/.test(file.hash||''))throw fail('Некорректный список удалённых файлов.');seen.add(file.path);if(!ignored)result.push({path:file.path,hash:file.hash});}return result;
}
const signature=files=>JSON.stringify(files.map(({path,size,hash})=>({path,size,hash})));
async function regular(filename,options){const stat=await fs.lstat(filename,options);if(!stat.isFile()||stat.isSymbolicLink())throw fail('Файл передачи повреждён.');return stat;}
const fileIdentity=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
async function writeJson(filename,value){const tmp=filename+'.'+crypto.randomUUID()+'.tmp';let handle;try{handle=await fs.open(tmp,'wx',0o600);await handle.writeFile(JSON.stringify(value));await handle.sync();await handle.close();handle=null;await fs.rename(tmp,filename);}finally{await handle?.close().catch(()=>{});await fs.rm(tmp,{force:true}).catch(()=>{});}}
async function digestFile(handle){const digest=crypto.createHash('sha256');let size=0;for await(const bytes of handle.createReadStream({autoClose:false})){size+=bytes.length;digest.update(bytes)}return {size,hash:digest.digest('hex')};}
class TransferStore{
 constructor(root){this.root=root;this.manifests=new Map();}
 async directory(runId){validateRun(runId);return internalDirectory(this.root,runId);}
 async read(runId){validateRun(runId);if(this.manifests.has(runId))return this.manifests.get(runId);const dir=await this.directory(runId),filename=path.join(dir,'manifest.json');const stat=await regular(filename);if(stat.size>MAX_WORKSPACE_INVENTORY_BYTES)throw fail('Список файлов результата слишком большой.');const inventory=classifyMetadata(JSON.parse(await fs.readFile(filename,'utf8')));const value={dir,...inventory,index:new Map(inventory.files.map(file=>[file.path,file])),ignoredIndex:new Map(inventory.ignoredFiles.map(file=>[file.path,file]))};this.manifests.set(runId,value);return value;}
 async blob(dir,file){const filename=path.join(dir,hash(Buffer.from(file.path))+'.data');try{await regular(filename)}catch(error){if(error.code!=='ENOENT')throw error}return filename;}
 async cleanup(runId){validateRun(runId);this.manifests.delete(runId);await this.directory(runId);await fs.rm(path.join(this.root,runId),{recursive:true,force:true});}
}

// This spool is immutable once the manifest exists. Retried delivery always
// reads exactly the bytes produced by that turn, never a later workspace edit.
export class OutgoingResults extends TransferStore{
 async prepare(runId,workspace,files,{deleted=[]}={}){
  deleted=deletedMetadata(deleted);
  files=metadata(files);const dir=await this.directory(runId);
  try{const old=await this.read(runId);if(signature(old.files)!==signature(files))throw fail('Сохранённый результат уже содержит другой список файлов.');return old.files;}catch(error){if(error.code!=='ENOENT')throw error}
  for(const file of files){
   const target=await this.blob(dir,file),temporary=target+'.'+crypto.randomUUID()+'.tmp';let handle;
   try{handle=await fs.open(temporary,'wx',0o600);const digest=crypto.createHash('sha256');let size=0;
    for await(const bytes of createReadStream(await filePath(workspace,file.path))){size+=bytes.length;if(size>file.size)throw fail('Файл изменился во время сохранения результата: '+file.path);digest.update(bytes);await handle.writeFile(bytes)}
    if(size!==file.size||digest.digest('hex')!==file.hash)throw fail('Файл изменился во время сохранения результата: '+file.path);
    await handle.sync();await handle.close();handle=null;await fs.rename(temporary,target);
   }finally{await handle?.close().catch(()=>{});await fs.rm(temporary,{force:true}).catch(()=>{});}
  }
  await writeJson(path.join(dir,'changes.json'),{deleted});await writeJson(path.join(dir,'manifest.json'),files);return files;
 }
 async readChanges(runId){const {dir,files}=await this.read(runId);const filename=path.join(dir,'changes.json');const stat=await regular(filename);if(stat.size>MAX_WORKSPACE_INVENTORY_BYTES)throw fail('Список изменений результата слишком большой.');const value=JSON.parse(await fs.readFile(filename,'utf8'));return {changed:files,deleted:deletedMetadata(value.deleted)};}
 async readChunk(runId,name,offset){
  portablePath(name);const {dir,index}=await this.read(runId),file=index.get(name);if(!file||!Number.isSafeInteger(offset)||offset<0||offset>file.size)throw fail('Недопустимый участок результата.');
  const handle=await fs.open(await this.blob(dir,file),'r');try{const buffer=Buffer.alloc(Math.min(RESULT_CHUNK_BYTES,file.size-offset)),{bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(bytesRead!==buffer.length)throw fail('Сохранённый файл результата повреждён.');return {path:file.path,hash:file.hash,offset,content:buffer.toString('base64')};}finally{await handle.close();}
 }
 async inline(runId){const {dir,files}=await this.read(runId);if(files.reduce((n,f)=>n+f.size,0)>MAX_TRANSFER)throw fail('Серверу нужно обновление для переноса больших результатов. Файлы сохранены на компьютере.');const result=[];for(const file of files){const bytes=await fs.readFile(await this.blob(dir,file));if(bytes.length!==file.size||hash(bytes)!==file.hash)throw fail('Сохранённый файл результата повреждён.');result.push({...file,content:bytes.toString('base64')});}return result;}
}

// The caller authorizes the run/device and serializes operations per run.
export class IncomingResults extends TransferStore{
 constructor(root){super(root);this.validatedFiles=new Map();}
 async cleanup(runId){validateRun(runId);for(const [filename,cached]of this.validatedFiles)if(cached.runId===runId)this.validatedFiles.delete(filename);await super.cleanup(runId);}
 async checkedFile(runId,filename){
  // Cached hashes remain authority only for the same unchanged regular file.
  // Nanosecond mtime/ctime also invalidate same-size edits and restored mtimes.
  const before=await regular(filename,{bigint:true}),identity=fileIdentity(before),cached=this.validatedFiles.get(filename);
  if(cached?.identity===identity){this.validatedFiles.delete(filename);this.validatedFiles.set(filename,cached);return {size:Number(before.size),hash:cached.hash,identity};}
  this.validatedFiles.delete(filename);const handle=await fs.open(filename,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW||0));
  try{
   if(fileIdentity(await handle.stat({bigint:true}))!==identity)throw fail('Файл передачи изменился во время проверки.');
   const checked=await digestFile(handle);
   if(BigInt(checked.size)!==before.size||fileIdentity(await handle.stat({bigint:true}))!==identity||fileIdentity(await regular(filename,{bigint:true}))!==identity)throw fail('Файл передачи изменился во время проверки.');
   this.validatedFiles.set(filename,{runId,identity,hash:checked.hash});while(this.validatedFiles.size>MAX_VALIDATED_FILES)this.validatedFiles.delete(this.validatedFiles.keys().next().value);
   return {...checked,identity};
  }finally{await handle.close();}
 }
 async resetFile(filename,identity,existingHandle){
  this.validatedFiles.delete(filename);const handle=existingHandle||await fs.open(filename,fsConstants.O_RDWR|(fsConstants.O_NOFOLLOW||0));
  try{if(fileIdentity(await handle.stat({bigint:true}))!==identity)throw fail('Файл передачи изменился во время восстановления.');await handle.truncate(0);await handle.sync();}finally{if(!existingHandle)await handle.close();}
 }
 async status(runId,files){
  const inventory=classifyMetadata(files);files=inventory.files;const dir=await this.directory(runId);
  try{const old=await this.read(runId);if(signature(old.files)!==signature(files))throw fail('Список передаваемого результата изменился.');}catch(error){if(error.code!=='ENOENT')throw error;await writeJson(path.join(dir,'manifest.json'),[...files,...inventory.ignoredFiles]);}
  const states=[];for(const file of files){const filename=await this.blob(dir,file);let offset=0,exists=false;try{offset=(await regular(filename)).size;exists=true}catch(error){if(error.code!=='ENOENT')throw error}
   if(offset>file.size)throw fail('Размер передаваемого результата повреждён.');
   if(offset===file.size){if(file.size===0&&!exists){try{this.validatedFiles.delete(filename);await fs.writeFile(filename,Buffer.alloc(0),{flag:'wx',mode:0o600})}catch(error){if(error.code!=='EEXIST')throw error}}const checked=await this.checkedFile(runId,filename);if(checked.size!==file.size||checked.hash!==file.hash){
    // Preserve the manifest and every other file. The immutable sender spool
    // can repair this one corrupt completed blob from offset zero.
    if(file.size===0)throw fail('Контрольная сумма результата не совпадает: '+file.path);await this.resetFile(filename,checked.identity);offset=0;
   }}
   states.push({...file,offset});
  }
  // Older Macs may still include live browser profiles. Confirm only that
  // those entries are ignored so they skip uploading their contents.
  return {files:[...states,...inventory.ignoredFiles.map(file=>({...file,offset:file.size,ignored:true}))],complete:states.every(f=>f.offset===f.size)};
 }
 async chunk(runId,input){
  const ignored=isIgnoredPortablePath(input?.path);if(!Number.isSafeInteger(input.offset)||input.offset<0||typeof input.content!=='string'||input.content.length>Math.ceil(RESULT_CHUNK_BYTES/3)*4)throw fail('Некорректная часть результата.');
  const bytes=Buffer.from(input.content,'base64');if(!bytes.length||bytes.length>RESULT_CHUNK_BYTES||bytes.toString('base64')!==input.content)throw fail('Некорректная часть результата.');
  const {dir,index,ignoredIndex}=await this.read(runId),file=(ignored?ignoredIndex:index).get(input.path);if(!file||file.hash!==input.hash||input.offset+bytes.length>file.size)throw fail('Часть результата не соответствует списку файлов.');
  if(ignored)return {offset:file.size,complete:true,ignored:true};
  const filename=await this.blob(dir,file);let handle;try{handle=await fs.open(filename,'r+')}catch(error){if(error.code!=='ENOENT')throw error;this.validatedFiles.delete(filename);handle=await fs.open(filename,'wx+',0o600)}
  try{const size=(await handle.stat()).size;if(input.offset>size)throw fail('Часть результата пришла с пропуском. Повтори передачу.');
   // A reconnect can replay a chunk after the process saved only its prefix.
   // Verify every existing byte, then append the remaining tail without truncation.
   let written=0;
   if(input.offset<size){written=Math.min(bytes.length,size-input.offset);const old=Buffer.alloc(written),read=await handle.read(old,0,old.length,input.offset);if(read.bytesRead!==old.length||!old.equals(bytes.subarray(0,written)))throw fail('Повторная часть результата содержит другие данные.');if(written===bytes.length){await handle.sync();if(size===file.size){const checked=await this.checkedFile(runId,filename);if(checked.size!==file.size||checked.hash!==file.hash){await this.resetFile(filename,checked.identity,handle);throw fail('Контрольная сумма результата не совпадает: '+file.path);}}return {offset:size,complete:size===file.size};}}
   this.validatedFiles.delete(filename);
   while(written<bytes.length){const result=await handle.write(bytes,written,bytes.length-written,input.offset+written);if(!result.bytesWritten)throw fail('Не удалось сохранить часть результата.');written+=result.bytesWritten;}await handle.sync();const offset=input.offset+bytes.length;
   if(offset===file.size){const checked=await this.checkedFile(runId,filename);if(checked.size!==file.size||checked.hash!==file.hash){await this.resetFile(filename,checked.identity,handle);throw fail('Контрольная сумма результата не совпадает: '+file.path);}}
   return {offset,complete:offset===file.size};
  }finally{await handle.close();}
 }
 async batch(runId,chunks){
  if(!Array.isArray(chunks)||!chunks.length||chunks.length>128)throw fail('Некорректный пакет файлов.');
  const {index}=await this.read(runId),names=new Set();let bytes=0;
  // Verify every small complete file before writing the first. Retried batches
  // then use the same immutable manifest and normal idempotent chunk handling.
  for(const input of chunks){portablePath(input?.path);const file=index.get(input.path);if(names.has(input.path)||!file||input.hash!==file.hash||input.offset!==0||typeof input.content!=='string'||input.content.length>Math.ceil(RESULT_CHUNK_BYTES/3)*4)throw fail('Некорректный пакет файлов.');names.add(input.path);const content=Buffer.from(input.content,'base64');bytes+=content.length;if(!content.length||content.length!==file.size||bytes>RESULT_CHUNK_BYTES||content.toString('base64')!==input.content||hash(content)!==file.hash)throw fail('Повреждённый пакет файлов.');}
  const files=[];for(const input of chunks)files.push({path:input.path,...await this.chunk(runId,input)});return {files};
 }
 async apply(runId,changes,mergeCallback,{stream=false}={}){
  if(!changes)throw fail('Некорректный результат.');const changed=metadata(changes.changed),changedNames=new Set(changed.map(f=>f.path)),deletedFiles=deletedMetadata(changes.deleted);for(const file of deletedFiles)if(changedNames.has(file.path))throw fail('Некорректный список удалённых файлов.');
  const {dir,files}=await this.read(runId);if(signature(changed)!==signature(files))throw fail('Результат не соответствует принятому списку файлов.');
  // Verify every file before the first merge, so an incomplete transfer cannot
  // partially apply an otherwise valid turn. Only one file is held in memory.
  for(const file of files){const checked=await this.checkedFile(runId,await this.blob(dir,file));if(checked.size!==file.size||checked.hash!==file.hash)throw fail('Результат ещё не полностью сохранён: '+file.path);}
  const results=[];for(const file of files){if(stream){const full=await this.blob(dir,file);results.push(await mergeCallback({changed:[{...file,source:()=>createReadStream(full)}],deleted:[]}));continue;}const bytes=await fs.readFile(await this.blob(dir,file));if(bytes.length!==file.size||hash(bytes)!==file.hash)throw fail('Сохранённый файл результата изменился.');results.push(await mergeCallback({changed:[{...file,content:bytes.toString('base64')}],deleted:[]}));}
  if(deletedFiles.length)results.push(await mergeCallback({changed:[],deleted:deletedFiles}));return results;
 }
}

export async function workspaceChunk(workspace,file,offset){
 validateFileInventory([file]);if(!Number.isSafeInteger(offset)||offset<0||offset>file.size)throw fail('Некорректный участок файла.');
 const full=await filePath(workspace,file.path),handle=await fs.open(full,'r');try{const stat=await handle.stat();if(stat.size!==file.size)throw fail('Файл изменился во время передачи.');const bytes=Buffer.alloc(Math.min(RESULT_CHUNK_BYTES,file.size-offset)),read=await handle.read(bytes,0,bytes.length,offset);if(read.bytesRead!==bytes.length)throw fail('Файл изменился во время передачи.');return {path:file.path,hash:file.hash,offset,content:bytes.toString('base64')};}finally{await handle.close();}
}
