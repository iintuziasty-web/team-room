import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// A failed storage move must not repeatedly take an otherwise usable Mac
// offline. Keep this decision across helper/app restarts; manual moves remain
// available and clear the pause only after successful completion.
export class MigrationPauseStore {
 constructor(desktopRoot){this.base=desktopRoot;this.folder=path.join(desktopRoot,'storage-migration-pauses');}
 filename(deviceId){if(!/^[A-Za-z0-9-]{16,80}$/.test(deviceId))throw new Error('Неверное подключение Mac.');return path.join(this.folder,deviceId+'.json');}
 async directory(create=false){
  const base=await fs.lstat(this.base);if(!base.isDirectory()||base.isSymbolicLink()||await fs.realpath(this.base)!==this.base)throw new Error('Папка настроек переноса недоступна.');
  if(create)try{await fs.mkdir(this.folder,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const stat=await fs.lstat(this.folder);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(this.folder)!==this.folder)throw new Error('Папка настроек переноса недоступна.');
 }
 async read(deviceId){
  const filename=this.filename(deviceId);let handle;
  try{await this.directory();handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>8192)throw new Error('Настройки переноса повреждены.');const value=JSON.parse(await handle.readFile('utf8'));if(value?.version!==1||value.deviceId!==deviceId||typeof value.message!=='string'||value.message.length>1400)throw new Error('Настройки переноса повреждены.');return value;}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  finally{await handle?.close();}
 }
 async pause(deviceId,message){
  const filename=this.filename(deviceId);await this.directory(true);
  const value={version:1,deviceId,at:new Date().toISOString(),message:String(message).slice(0,1400)},temporary=filename+'.'+crypto.randomUUID()+'.tmp';let handle;
  try{handle=await fs.open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await handle.writeFile(JSON.stringify(value));await handle.sync();await handle.close();handle=null;await fs.rename(temporary,filename);const dir=await fs.open(this.folder,constants.O_RDONLY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}}
  finally{await handle?.close();await fs.rm(temporary,{force:true}).catch(()=>{});}
  return value;
 }
 async clear(deviceId){await this.directory().catch(error=>{if(error.code!=='ENOENT')throw error;});await fs.unlink(this.filename(deviceId)).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
