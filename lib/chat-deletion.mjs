import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {snapshot,filePath,internalDirectory} from './workspace.mjs';
// Imported archives have explicit ownership. A shared project snapshot alone
// does not establish ownership of generated files.
export async function deletionPreview(root,chat,related,memories,{protectedPaths=new Set()}={}){
 const inventory=await snapshot(root),other=related.filter(c=>c.id!==chat.id);
 const sameSource=chat.importSource&&other.some(c=>c.importSource?.provider===chat.importSource.provider&&c.importSource?.sessionId===chat.importSource.sessionId);
 const archive=chat.importSource&&!sameSource?`imports/${chat.importSource.provider}/${chat.importSource.sessionId}/`:null;
 const attachments=new Set(chat.messages.flatMap(m=>(m.attachments||[]).map(a=>a.path)));
 const referenced=(name)=>other.some(c=>c.messages.some(m=>(m.attachments||[]).some(a=>a.path===name)||(m.text||'').includes(name))||Object.hasOwn(c.importSource?.fileHashes||{},name));
 const files=inventory.filter(f=>{
  if(protectedPaths.has(f.path)||referenced(f.path))return false;
  if(archive&&f.path.startsWith(archive))return true;
  if(other.some(c=>(c.files||[]).some(x=>x.path===f.path)))return false;
  return chat.importSource?.fileHashes?.[f.path]===f.hash||attachments.has(f.path);
 });
 const token=crypto.createHash('sha256').update(JSON.stringify({revision:chat.revision||0,files:files.map(f=>[f.path,f.hash]),memories:memories.filter(m=>m.sourceChatId===chat.id).map(m=>[m.id,m.text])})).digest('hex');
 return {token,title:chat.title,revision:chat.revision||0,messages:chat.messages.length,memories:memories.filter(m=>m.sourceChatId===chat.id).length,files:files.map(f=>f.path),inventory};
}
export async function stageDeletion(root,names){
 const folder=await internalDirectory(root,'.team-room','deletion-staging',crypto.randomUUID()),moved=[];
 try{for(const name of names){const source=await filePath(root,name),target=path.join(folder,String(moved.length));await fs.rename(source,target);moved.push({source,target});}}
 catch(error){for(const f of moved.reverse())await fs.rename(f.target,f.source);await fs.rm(folder,{recursive:true,force:true});throw error}
 return {rollback:async()=>{for(const f of moved.reverse())await fs.rename(f.target,f.source);await fs.rm(folder,{recursive:true,force:true});},commit:()=>fs.rm(folder,{recursive:true,force:true})};
}
