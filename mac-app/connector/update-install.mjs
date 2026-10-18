import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),[target,candidate,pidText,stage]=process.argv.slice(2),pid=Number(pidText);
const parent=path.dirname(target||''),backup=path.join(parent,'.TeamRoom-previous-'+crypto.randomUUID()+'.app');
const allowed=['/Applications',path.join(os.homedir(),'Applications')];
if(!allowed.includes(parent)||path.basename(target)!=='Team Room Community.app'||path.dirname(candidate)!==parent||!/^\.TeamRoom-update-[a-f0-9-]+\.app$/.test(path.basename(candidate))||!Number.isSafeInteger(pid)||pid<2)process.exit(1);
let moved=false,replaced=false,installed=false;
try{
 const end=Date.now()+120000;while(Date.now()<end){try{process.kill(pid,0)}catch(error){if(error.code==='ESRCH')break;throw error;}await new Promise(resolve=>setTimeout(resolve,500));}
 try{process.kill(pid,0);throw new Error('Приложение не завершилось. Обновление отложено.');}catch(error){if(error.code!=='ESRCH')throw error;}
 await exec('/usr/bin/codesign',['--verify','--strict',candidate],{timeout:60000,maxBuffer:65536});
 await fs.rename(target,backup);moved=true;await fs.rename(candidate,target);replaced=true;
 await exec('/usr/bin/open',['-n',target],{timeout:30000,maxBuffer:65536});installed=true;
 await fs.writeFile(path.join(stage,'result.json'),JSON.stringify({ok:true,backup,at:new Date().toISOString()}),{mode:0o600});
}catch(error){
 if(moved)try{if(replaced)await fs.rename(target,candidate);await fs.rename(backup,target);await exec('/usr/bin/open',['-n',target]);}catch{}
 try{await fs.writeFile(path.join(stage,'result.json'),JSON.stringify({ok:false,error:String(error.message).slice(0,700),backup:moved?backup:null}),{mode:0o600});}catch{}
}

// Bound disk use to one previous Community version. Other apps are untouched.
if(installed){
 try{
  for(const name of await fs.readdir(parent)){
   const file=path.join(parent,name);if(file===backup||!/^\.TeamRoom-previous-[a-f0-9-]+\.app$/.test(name))continue;
   const stat=await fs.lstat(file);if(!stat.isDirectory()||stat.isSymbolicLink())continue;
   try{const plist=JSON.parse((await exec('/usr/bin/plutil',['-convert','json','-o','-',path.join(file,'Contents/Info.plist')],{timeout:5000,maxBuffer:65536})).stdout);if(plist.CFBundleIdentifier==='io.teamroom.community')await fs.rm(file,{recursive:true,force:true});}catch{}
  }
 }catch{}
}
if(stage&&/^release-[A-Za-z0-9]+$/.test(path.basename(stage))){
 try{const result=JSON.parse(await fs.readFile(path.join(stage,'result.json')));await fs.writeFile(path.join(path.dirname(stage),'last-update.json'),JSON.stringify(result),{mode:0o600});if(result.ok)await fs.rm(stage,{recursive:true,force:true});}catch{}
}
