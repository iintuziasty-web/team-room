import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {MAX_PROJECT,hashFile,snapshot,filePath,internalDirectory,portablePath,digest} from './workspace.mjs';

const token=value=>digest(Buffer.from(JSON.stringify(value)));
export async function projectDeletionPreview(root,project,chats,memories,tasks){
 const files=await snapshot(root);
 const owned=chats.filter(c=>c.projectId===project.id),notes=memories.filter(m=>m.projectId===project.id),work=tasks.filter(t=>t.projectId===project.id);
 return {token:token({project,chats:owned.map(c=>[c.id,c.revision||0,c.messages.length]),notes,work,files:files.map(f=>[f.path,f.hash])}),title:project.name,chats:owned.length,messages:owned.reduce((n,c)=>n+c.messages.length,0),memories:notes.length,tasks:work.length,files:files.length,bytes:files.reduce((n,f)=>n+f.size,0)};
}
export async function movePreview(sourceRoot,targetRoot,chat,target,memories,tasks){
 const source=(await snapshot(sourceRoot)).filter(f=>{const archive=f.path.match(/(?:^|\/)imports\/(claude|codex)\/([^/]+)\//);const moved=f.path.match(/(?:^|\/)imports\/team-room\/([^/]+)\//);return (!archive||(chat.importSource?.provider===archive[1]&&chat.importSource?.sessionId===archive[2]))&&(!moved||moved[1]===chat.id);}),destination=await snapshot(targetRoot),known=new Map(destination.map(f=>[f.path,f]));
 const directories=new Set();for(const name of known.keys()){const parts=name.split('/');for(let n=1;n<parts.length;n++)directories.add(parts.slice(0,n).join('/'));}
 const blocked=name=>directories.has(name)||name.split('/').slice(0,-1).some((_,n)=>known.has(name.split('/').slice(0,n+1).join('/')));
 const conflicts=source.filter(f=>blocked(f.path)||known.has(f.path)&&known.get(f.path).hash!==f.hash);
 // Keep a complete tree together when names collide, preserving relative assets.
 let prefix='';
 if(conflicts.length){let suffix=0;do{prefix=`_moved-${chat.id}${suffix?'-'+suffix:''}/`;suffix++;}while(known.has(prefix.slice(0,-1))||directories.has(prefix.slice(0,-1)));}
 const mapping=Object.fromEntries(source.map(f=>[f.path,portablePath(prefix+f.path)]));
 const additions=source.filter(f=>!known.has(mapping[f.path]));
 if(destination.length+additions.length>10000||destination.reduce((n,f)=>n+f.size,0)+additions.reduce((n,f)=>n+f.size,0)>MAX_PROJECT)throw Object.assign(new Error('После переноса проект превысит 50 ГБ или 10 000 файлов.'),{status:413});
 const notes=memories.filter(m=>m.sourceChatId===chat.id),work=tasks.filter(t=>t.sourceChatId===chat.id);
 return {token:token({chatId:chat.id,projectId:chat.projectId,revision:chat.revision||0,target,source:source.map(f=>[f.path,f.hash]),destination:destination.map(f=>[f.path,f.hash]),notes,work}),revision:chat.revision||0,files:source.length,memories:notes.length,tasks:work.length,conflicts:conflicts.length,prefix,mapping,source,additions};
}
export async function stageMoveFiles(sourceRoot,targetRoot,preview){
 const folder=await internalDirectory(targetRoot,'.team-room','move-staging',crypto.randomUUID()),added=[];
 try{
  for(const file of preview.additions){
   const original=await filePath(sourceRoot,file.path),temp=path.join(folder,String(added.length));
   await fs.copyFile(original,temp,fs.constants.COPYFILE_EXCL);
   if(await hashFile(temp)!==file.hash)throw new Error('Исходный файл изменился. Открой перенос ещё раз.');
   const handle=await fs.open(temp,'r');try{await handle.sync()}finally{await handle.close()}
   const target=await filePath(targetRoot,preview.mapping[file.path],{mkdir:true});
   // link is exclusive: even unexpected writers cannot be overwritten.
   await fs.link(temp,target);added.push(target);await fs.rm(temp);
  }
 }catch(error){for(const name of added)await fs.rm(name,{force:true});await fs.rm(folder,{recursive:true,force:true});throw error;}
 return {addFile:async(name,bytes)=>{const target=await filePath(targetRoot,name,{mkdir:true});const handle=await fs.open(target,'wx',0o600);added.push(target);try{await handle.writeFile(bytes);await handle.sync()}finally{await handle.close()}},rollback:async()=>{for(const name of added)await fs.rm(name,{force:true});await fs.rm(folder,{recursive:true,force:true});},commit:()=>fs.rm(folder,{recursive:true,force:true})};
}
export async function stageProjectRemoval(storage,root,projectId){
 const folder=await internalDirectory(storage,'.project-deletions',crypto.randomUUID()),backup=path.join(folder,'project');
 const stat=await fs.lstat(root);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('Рабочая папка проекта повреждена.');
 const intent=await fs.open(path.join(folder,'intent.json'),'wx',0o600);try{await intent.writeFile(JSON.stringify({projectId}));await intent.sync()}finally{await intent.close()}
 await fs.rename(root,backup);
 return {rollback:async()=>{try{await fs.rmdir(root);}catch(error){if(error.code!=='ENOENT')throw error;}await fs.rename(backup,root);await fs.rm(folder,{recursive:true,force:true});},commit:()=>fs.rm(folder,{recursive:true,force:true})};
}
// If the process stops before the data commit, restore the original directory.
// If the project is already absent from durable data, finish its cleanup.
export async function recoverProjectRemovals(storage,projects){
 const base=await internalDirectory(storage,'.project-deletions'),retained=new Set(projects.map(p=>p.id));
 for(const name of await fs.readdir(base)){
  if(!/^[a-f0-9-]{36}$/.test(name))continue;
  const folder=path.join(base,name),stat=await fs.lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink())continue;
  const marker=path.join(folder,'intent.json');let intent;
  try{const st=await fs.lstat(marker);if(!st.isFile()||st.isSymbolicLink())continue;intent=JSON.parse(await fs.readFile(marker,'utf8'))}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(!/^[a-f0-9-]{36}$/.test(intent.projectId||''))continue;
  if(retained.has(intent.projectId)){
   const backup=path.join(folder,'project');let exists=true;try{const st=await fs.lstat(backup);if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Повреждена резервная папка проекта.')}catch(error){if(error.code==='ENOENT')exists=false;else throw error;}
   if(exists){const original=path.join(storage,'storage','projects',intent.projectId);try{const st=await fs.lstat(original);if(st.isSymbolicLink())throw new Error('Рабочая папка проекта не может быть ссылкой.');await fs.rmdir(original)}catch(error){if(error.code!=='ENOENT')throw error;}await fs.mkdir(path.dirname(original),{recursive:true});await fs.rename(backup,original);}
  }
  await fs.rm(folder,{recursive:true,force:true});
 }
}
