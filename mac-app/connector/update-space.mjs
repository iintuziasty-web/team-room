import fs from 'node:fs/promises';
import path from 'node:path';

export function updateSpaceError(error){
 return error?.code==='ENOSPC'?new Error('На этом Mac закончилось свободное место. Освободи место на диске и повтори обновление.'):error;
}

export async function requireUpdateSpace(root,bytes){
 const stat=await fs.statfs(root);
 const required=bytes+32*1024*1024,available=stat.bavail*stat.bsize;
 if(available<required)throw new Error(`Для обновления подключения освободи минимум ${Math.ceil((required-available)/1024/1024)} МБ на этом Mac. Приложение пока не меняло подключение.`);
}

// Only generated program backups are eligible. Unexpected files, symlinks,
// credentials and workspace contents make the entire backup ineligible.
export async function pruneProgramBackups(root,keep=2){
 const folder=path.join(root,'import-update-backups');let entries;
 try{const stat=await fs.lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink())return;entries=await fs.readdir(folder,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
 async function programOnly(dir,level=0){
  for(const entry of await fs.readdir(dir,{withFileTypes:true})){
   if(entry.isSymbolicLink())return false;
   if(entry.isDirectory()){if(level||entry.name!=='lib'||!await programOnly(path.join(dir,entry.name),1))return false;}
   else if(!entry.isFile()||!(level?/^[a-zA-Z0-9_-]+\.mjs$/.test(entry.name):['bridge.mjs','install-integration.mjs'].includes(entry.name)))return false;
  }
  return true;
 }
 const candidates=entries.filter(e=>e.isDirectory()&&!e.isSymbolicLink()&&/^\d{13}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(e.name)).sort((a,b)=>b.name.localeCompare(a.name));
 for(const entry of candidates.slice(keep)){const dir=path.join(folder,entry.name);if(await programOnly(dir))await fs.rm(dir,{recursive:true,force:true});}
}
