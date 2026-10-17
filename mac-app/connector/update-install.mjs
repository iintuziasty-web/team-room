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
let moved=false,replaced=false;
try{
 const end=Date.now()+120000;while(Date.now()<end){try{process.kill(pid,0)}catch(error){if(error.code==='ESRCH')break;throw error;}await new Promise(resolve=>setTimeout(resolve,500));}
 try{process.kill(pid,0);throw new Error('Приложение не завершилось. Обновление отложено.');}catch(error){if(error.code!=='ESRCH')throw error;}
 await exec('/usr/bin/codesign',['--verify','--strict',candidate],{timeout:60000,maxBuffer:65536});
 await fs.rename(target,backup);moved=true;await fs.rename(candidate,target);replaced=true;
 await exec('/usr/bin/open',['-n',target],{timeout:30000,maxBuffer:65536});
 await fs.writeFile(path.join(stage,'result.json'),JSON.stringify({ok:true,backup,at:new Date().toISOString()}),{mode:0o600});
}catch(error){
 if(moved&&!replaced)try{await fs.rename(backup,target);await exec('/usr/bin/open',['-n',target]);}catch{}
 try{await fs.writeFile(path.join(stage,'result.json'),JSON.stringify({ok:false,error:String(error.message).slice(0,700),backup:moved?backup:null}),{mode:0o600});}catch{}
}
