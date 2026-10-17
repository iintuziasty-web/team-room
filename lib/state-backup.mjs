import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BACKUP_NAME=/^team-data-\d{4}-\d{2}-\d{2}\.json$/;
const identity=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
async function regular(filename){const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Недопустимый файл резервной копии состояния.');return stat;}
async function syncDirectory(directory){const handle=await fs.open(directory,constants.O_RDONLY|(constants.O_DIRECTORY||0)|(constants.O_NOFOLLOW||0));try{await handle.sync();}finally{await handle.close();}}
async function existingBackup(filename){try{await regular(filename);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function prune(folder,cutoff){
 let changed=false;
 for(const entry of await fs.readdir(folder,{withFileTypes:true}))if(BACKUP_NAME.test(entry.name)&&entry.name.slice(10,20)<cutoff){
  // Remove only old regular backup files; never follow links or recurse into
  // another directory sharing a date-shaped name.
  if(!entry.isFile()||entry.isSymbolicLink())continue;await regular(path.join(folder,entry.name));await fs.unlink(path.join(folder,entry.name));changed=true;
 }
 if(changed)await syncDirectory(folder);
}

// The running server has already parsed this source successfully. Backing up
// those immutable, previously serialized bytes must not parse a second copy of
// the complete application state into the JavaScript heap.
export async function ensureDailyStateBackup(dataPath,{day=new Date().toISOString().slice(0,10),now=Date.now}={}){
 if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00.000Z'))||new Date(day+'T00:00:00.000Z').toISOString().slice(0,10)!==day)throw new Error('Некорректная дата резервной копии.');
 const parent=await fs.realpath(path.dirname(path.resolve(dataPath))),source=path.join(parent,path.basename(dataPath)),folder=path.join(parent,'backups');
 try{await fs.mkdir(folder,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
 const folderStat=await fs.lstat(folder),parentStat=await fs.stat(parent);
 if(!folderStat.isDirectory()||folderStat.isSymbolicLink()||folderStat.dev!==parentStat.dev)throw new Error('Недопустимая папка резервных копий состояния.');
 const target=path.join(folder,'team-data-'+day+'.json'),cutoff=new Date(now()-14*86400000).toISOString().slice(0,10);
 if(await existingBackup(target)){await prune(folder,cutoff);return {day,created:false};}
 let before;try{before=await regular(source);}catch(error){if(error.code!=='ENOENT')throw error;await prune(folder,cutoff);return {day,created:false,missing:true};}
 if(before.dev!==folderStat.dev)throw new Error('Резервная копия должна оставаться на диске основной базы.');
 const temporary=path.join(folder,'.team-data-'+day+'.'+crypto.randomUUID()+'.tmp');let handle,created=false,temporaryCreated=false;
 try{
  // Reflink where supported, kernel copy otherwise: memory does not grow with
  // state size. The destination is exclusive and stays on the same volume.
  await fs.copyFile(source,temporary,constants.COPYFILE_EXCL|(constants.COPYFILE_FICLONE||0));temporaryCreated=true;await fs.chmod(temporary,0o600);
  const after=await regular(source),copied=await regular(temporary);if(identity(before)!==identity(after)||copied.size!==before.size)throw new Error('Основная база изменилась во время резервного копирования.');
  handle=await fs.open(temporary,constants.O_RDONLY|(constants.O_NOFOLLOW||0));await handle.sync();await handle.close();handle=null;
  // Publishing by link is atomic and cannot replace an existing daily copy.
  try{await fs.link(temporary,target);created=true;}catch(error){if(error.code!=='EEXIST')throw error;await regular(target);}
 }finally{
  await handle?.close().catch(()=>{});
  if(temporaryCreated){await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});await syncDirectory(folder);}
 }
 await prune(folder,cutoff);return {day,created,bytes:before.size};
}
