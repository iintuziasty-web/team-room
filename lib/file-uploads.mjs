import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {internalDirectory,filePath,portablePath,MAX_FILE,hashFile} from './workspace.mjs';

export const UPLOAD_CHUNK=4*1024*1024;
const fail=(status,message)=>Object.assign(new Error(message),{status});
const valid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
async function json(file,value){const temp=file+'.'+crypto.randomUUID()+'.tmp';let h;try{h=await fs.open(temp,'wx',0o600);await h.writeFile(JSON.stringify(value));await h.sync();await h.close();h=null;await fs.rename(temp,file);}finally{await h?.close().catch(()=>{});await fs.rm(temp,{force:true});}}
export class FileUploads{
 constructor(root){this.root=root;this.queues=new Map();}
 async serial(id,fn){const next=(this.queues.get(id)||Promise.resolve()).catch(()=>{}).then(fn);this.queues.set(id,next);try{return await next}finally{if(this.queues.get(id)===next)this.queues.delete(id);}}
 async folder(project,id){if(!valid(project)||!valid(id))throw fail(400,'Некорректная загрузка.');return internalDirectory(this.root,project,id);}
 async read(project,id,owner){const dir=await this.folder(project,id),file=path.join(dir,'metadata.json'),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw fail(400,'Загрузка повреждена.');const m=JSON.parse(await fs.readFile(file,'utf8'));if(m.owner!==owner)throw fail(403,'Загрузка принадлежит другому аккаунту.');return {dir,m};}
 async create(project,id,owner,input){return this.serial(id,async()=>{
  const relative=portablePath(input.path);if(!Number.isSafeInteger(input.size)||input.size<0||input.size>MAX_FILE)throw fail(413,'Максимальный размер файла — 5 ГБ.');
  try{const {m}=await this.read(project,id,owner);if(m.path!==relative||m.size!==input.size)throw fail(409,'Параметры загрузки изменились.');return this.status(project,id,owner);}catch(error){if(error.code!=='ENOENT')throw error;}
  const dir=await this.folder(project,id),stat=await fs.statfs(dir);if(stat.bavail*stat.bsize<input.size+32*1024*1024)throw fail(507,'В хранилище Team Room недостаточно свободного места для этого файла.');
  const m={path:relative,size:input.size,owner,createdAt:Date.now()};await json(path.join(dir,'metadata.json'),m);const h=await fs.open(path.join(dir,'content'),'wx',0o600);await h.close();return {id,path:relative,size:m.size,offset:0,chunkBytes:UPLOAD_CHUNK};
 });}
 async status(project,id,owner){const {dir,m}=await this.read(project,id,owner);if(m.completed)return {id,path:m.path,size:m.size,offset:m.size,completed:true};const file=path.join(dir,'content');let st;try{st=await fs.lstat(file)}catch(error){if(error.code==='ENOENT'&&m.committing&&m.hash)return {id,path:m.path,size:m.size,offset:m.size,readyToCommit:true};throw error;}if(!st.isFile()||st.isSymbolicLink()||st.size>m.size)throw fail(400,'Загрузка повреждена.');return {id,path:m.path,size:m.size,offset:st.size,chunkBytes:UPLOAD_CHUNK};}
 async chunk(project,id,owner,offset,bytes){return this.serial(id,async()=>{
  const {dir,m}=await this.read(project,id,owner);if(m.completed)return {offset:m.size,completed:true};
  if(!Number.isSafeInteger(offset)||offset<0||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>UPLOAD_CHUNK||offset+bytes.length>m.size)throw fail(400,'Некорректная часть файла.');
  const file=path.join(dir,'content'),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw fail(400,'Загрузка повреждена.');const h=await fs.open(file,'r+');
  try{const current=(await h.stat()).size;if(offset>current)throw fail(409,'Часть файла пришла с пропуском.');
   if(offset<current){const length=Math.min(bytes.length,current-offset),old=Buffer.alloc(length);const read=await h.read(old,0,length,offset);if(read.bytesRead!==length||!old.equals(bytes.subarray(0,length)))throw fail(409,'Повторная часть файла содержит другие данные.');}
   let at=Math.max(0,current-offset);while(at<bytes.length){const result=await h.write(bytes,at,bytes.length-at,offset+at);if(!result.bytesWritten)throw new Error('Не удалось сохранить файл.');at+=result.bytesWritten;}await h.sync();return {offset:Math.max(current,offset+bytes.length)};
  }finally{await h.close();}
 });}
 async commit(project,id,owner,workspace){return this.serial(id,async()=>{
  const {dir,m}=await this.read(project,id,owner);const target=await filePath(workspace,m.path,{mkdir:true});
  if(!m.completed){const file=path.join(dir,'content');let stat;try{stat=await fs.lstat(file)}catch(error){if(error.code!=='ENOENT')throw error;const existing=await fs.lstat(target);if(!m.committing||!m.hash||existing.size!==m.size||existing.isSymbolicLink()||!existing.isFile()||await hashFile(target)!==m.hash)throw fail(409,'Загрузка ещё не завершена.');m.completed=true;}
   if(stat){if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==m.size)throw fail(409,'Загрузка ещё не завершена.');m.hash=await hashFile(file);m.committing=true;await json(path.join(dir,'metadata.json'),m);await fs.rename(file,target);m.completed=true;}
   await json(path.join(dir,'metadata.json'),m);
  }
  return {id,path:m.path,size:m.size,completed:true};
 });}
 async cleanup(){let projects;try{projects=await fs.readdir(this.root,{withFileTypes:true})}catch(error){if(error.code==='ENOENT')return;throw error;}for(const p of projects){if(!p.isDirectory()||p.isSymbolicLink()||!valid(p.name))continue;for(const e of await fs.readdir(path.join(this.root,p.name),{withFileTypes:true})){if(!e.isDirectory()||e.isSymbolicLink()||!valid(e.name)||this.queues.has(e.name))continue;const dir=path.join(this.root,p.name,e.name),stat=await fs.lstat(dir);if(stat.mtimeMs<Date.now()-86400000)await fs.rm(dir,{recursive:true,force:true});}}}
}
