import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// First desktop release: install brand new pairings only. Existing services,
// registrations, plists, program files and workspaces are never modified.
const exec=promisify(execFile);
let externalStorageModule;
function storageModule(){if(!externalStorageModule){const bundled=new URL('../connect/lib/external-storage.mjs',import.meta.url);externalStorageModule=import(bundled.href).catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND'||error.url&&error.url!==bundled.href)throw error;return import(new URL('../../lib/external-storage.mjs',import.meta.url).href);});}return externalStorageModule;}
import {HUB} from './instance.mjs';
const xml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const options={};for(let i=2;i<process.argv.length;i+=2){if(!['--source','--runtime','--previous','--previous-label'].includes(process.argv[i])||!process.argv[i+1])throw new Error('Неверные параметры установки.');options[process.argv[i]]=process.argv[i+1]}
const privateBase=path.join(os.homedir(),'Library','Application Support','Team Room Community Connect');
const agentRoot=path.join(os.homedir(),'Library','LaunchAgents');
const pairingsRoot=path.join(os.homedir(),'Library','Application Support','Team Room Community Desktop','pairings');
const domain='gui/'+process.getuid();
const exists=async file=>{try{await fs.lstat(file);return true}catch(error){if(error.code==='ENOENT')return false;throw error}};
async function preparedConfigAt(root){
 const filename=path.join(root,'device-config.json'),handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=await handle.stat();if(!before.isFile()||before.nlink!==1||before.size>16384)throw new Error('Сохранённое подключение на внешнем диске повреждено.');const bytes=Buffer.alloc(before.size);let offset=0;while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw new Error('Сохранённое подключение изменилось.');offset+=bytesRead;}const after=await handle.stat(),current=await fs.lstat(filename),identity=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');if(!current.isFile()||current.isSymbolicLink()||after.nlink!==1||current.nlink!==1||identity(before)!==identity(after)||identity(after)!==identity(current)||await fs.realpath(root)!==root)throw new Error('Сохранённое подключение изменилось.');return JSON.parse(bytes.toString('utf8'));}finally{await handle.close();}
}
async function registered(label){
 if(!/^io\.teamroom\.community\.connect(?:\.[A-Za-z0-9-]{16,80})?$/.test(label))throw new Error('Неверное фоновое подключение.');
 try{await exec('/bin/launchctl',['print',domain+'/'+label],{timeout:5000,maxBuffer:100000});return true}catch{return false}
}
async function anyExistingAgent(){
 let names=[];try{names=await fs.readdir(agentRoot)}catch(error){if(error.code!=='ENOENT')throw error}
 return names.some(name=>/^io\.teamroom\.community\.connect(?:\.[A-Za-z0-9-]{16,80})?\.plist$/.test(name));
}
async function assertNoRegistration(label,plistPath){
 if(options['--previous-label']||await exists(plistPath)||await anyExistingAgent()||await registered(label)||await registered('io.teamroom.community.connect'))throw new Error('Подключение уже установлено. Используй «Включить существующее подключение».');
}
let claimed=null;
let publishedPlist=false;
try{
 if(process.platform!=='darwin')throw new Error('Эта установка предназначена для macOS.');
 if(!options['--source']||!options['--runtime']||!options['--previous'])throw new Error('Нужен новый архив подключения.');
 const source=await fs.realpath(path.resolve(options['--source']));
 const runtime=await fs.realpath(path.resolve(options['--runtime']));
 const previous=await fs.realpath(path.resolve(options['--previous']));
 let raw;try{raw=JSON.parse(await fs.readFile(path.join(source,'device-config.json'),'utf8'))}catch{throw new Error('Файл подключения повреждён.')}
 if(typeof raw.deviceId!=='string'||!/^[A-Za-z0-9-]{16,80}$/.test(raw.deviceId)||typeof raw.token!=='string'||raw.token.length<20||raw.token.length>4096)throw new Error('Не найдено подключение Team Room.');
 const hub=new URL(raw.hubUrl);if(hub.origin!==HUB||hub.username||hub.password||hub.pathname!=='/'||hub.search||hub.hash)throw new Error('Неверный адрес пространства.');
 const storage=await storageModule(),configured=await storage.resolveConfiguredDeviceRoot(raw.deviceId),managed=configured.root,label='io.teamroom.community.connect.'+raw.deviceId,plistPath=path.join(agentRoot,label+'.plist');
 const requireStorage=async()=>{if(configured.configured){const current=await storage.resolveConfiguredDeviceRoot(raw.deviceId);if(current.root!==managed||current.location.volumeUuid!==configured.location.volumeUuid)throw new Error('Выбранный внешний диск изменился. Повтори установку.');}};
 // These checks precede every filesystem write. A missing PID is insufficient:
 // KeepAlive may restart an existing registered process at any moment.
 await assertNoRegistration(label,plistPath);
 let preparedConfig=false,preparedRoot=false;
 if(await exists(managed)){
  if(!configured.configured)throw new Error('Папка подключения уже существует. Установка ничего не меняет. Используй существующее подключение или восстанови его отдельно.');
  await requireStorage();const names=await fs.readdir(managed);if(names.some(name=>![storage.STORAGE_LOCATION_MARKER,'device-config.json'].includes(name)))throw new Error('На внешнем диске уже есть подключение. Используй его без повторной установки.');
  if(names.includes('device-config.json')){const saved=await preparedConfigAt(managed);if(saved.deviceId!==raw.deviceId||saved.token!==raw.token||saved.hubUrl!==raw.hubUrl)throw new Error('На внешнем диске сохранено другое подключение.');preparedConfig=true;}
  preparedRoot=true;
 }
 if(previous!==path.join(pairingsRoot,raw.deviceId))throw new Error('Первый выпуск приложения устанавливает только новое подключение. Существующие папки остаются без изменений.');
 const pairingNames=await fs.readdir(previous);if(pairingNames.some(name=>name!=='device-config.json'))throw new Error('Это уже существующее подключение. Используй его без повторной установки.');
 const previousConfig=JSON.parse(await fs.readFile(path.join(previous,'device-config.json'),'utf8'));if(previousConfig.deviceId!==raw.deviceId||previousConfig.token!==raw.token)throw new Error('Подключение изменилось. Выбери архив заново.');
 for(const name of ['node','claude','codex']){const stat=await fs.stat(path.join(runtime,'bin',name));if(!stat.isFile()||!(stat.mode&0o111))throw new Error('В приложении отсутствует официальный компонент '+name+'.')}
 for(const name of ['bridge.mjs','lib','teamroom.mjs','install-integration.mjs','node_modules'])if(!await exists(path.join(source,name)))throw new Error('В приложении отсутствуют файлы подключения.');
 await requireStorage();if(!configured.configured){await fs.mkdir(privateBase,{recursive:true,mode:0o700});const base=await fs.lstat(privateBase);if(!base.isDirectory()||base.isSymbolicLink()||await fs.realpath(privateBase)!==privateBase)throw new Error('Папка подключения не может быть ссылкой.');}
 // Atomic exclusive claim, shared by all desktop installers on this Mac.
 try{if(preparedRoot)await fs.writeFile(path.join(managed,'.install-claim'),JSON.stringify({deviceId:raw.deviceId,at:new Date().toISOString()}),{mode:0o600,flag:'wx'});else await fs.mkdir(managed,{recursive:false,mode:0o700});claimed=managed}catch(error){if(error.code==='EEXIST')throw new Error('Подключение уже устанавливается или его папка уже существует. Обнови список компьютеров.');throw error}
 await assertNoRegistration(label,plistPath);
 const storageCopyGuard=configured.configured?{filter:async()=>{await requireStorage();return true;}}:{};
 for(const name of ['bridge.mjs','lib','teamroom.mjs','install-integration.mjs','node_modules']){await requireStorage();await fs.cp(path.join(source,name),path.join(managed,name),{recursive:true,dereference:false,force:false,errorOnExist:true,...storageCopyGuard});}
 await requireStorage();await fs.cp(runtime,path.join(managed,'runtime'),{recursive:true,dereference:false,force:false,errorOnExist:true,...storageCopyGuard});
 await requireStorage();
 await fs.writeFile(path.join(managed,'package.json'),JSON.stringify({name:'team-room-community-connect',private:true,type:'module'}),{mode:0o600,flag:'wx'});
 if(!preparedConfig)await fs.writeFile(path.join(managed,'device-config.json'),JSON.stringify(raw,null,2),{mode:0o600,flag:'wx'});
 const nodeBin=path.join(managed,'runtime','bin','node');
 const launchPath=[path.join(managed,'runtime','bin'),path.join(managed,'node_modules','.bin'),path.join(os.homedir(),'.local','bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'].join(':');
 // Export commands use a local launcher, so shared skills contain no device paths.
 const plist=`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${xml(label)}</string>\n<key>ProgramArguments</key><array><string>${xml(nodeBin)}</string><string>${xml(path.join(managed,'bridge.mjs'))}</string></array>\n<key>WorkingDirectory</key><string>${xml(managed)}</string>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>\n<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(launchPath)}</string></dict>\n<key>StandardOutPath</key><string>${xml(path.join(managed,'connect.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(managed,'connect-error.log'))}</string>\n</dict></plist>`;
 await requireStorage();await assertNoRegistration(label,plistPath);
 await fs.mkdir(agentRoot,{recursive:true});
 // Exclusive creation can never truncate a plist appearing during installation.
 await fs.writeFile(plistPath,plist,{mode:0o600,flag:'wx'});publishedPlist=true;
 await exec('/usr/bin/plutil',['-lint',plistPath]);
 await exec('/bin/launchctl',['bootstrap',domain,plistPath],{timeout:10000,maxBuffer:65536});
 let integrationReady=true;try{await exec(nodeBin,[path.join(managed,'install-integration.mjs')],{cwd:managed,timeout:15000,maxBuffer:65536})}catch{integrationReady=false}
 if(preparedRoot){await requireStorage();await fs.rm(path.join(managed,'.install-claim'),{force:true});}
 process.stdout.write(JSON.stringify({ok:true,installed:true,integrationReady,name:String(raw.name||'Этот Mac').slice(0,120)})+'\n');
}catch(error){
 // A newly published plist may already be bootstrapped. Never delete or alter
 // it; retain partial installations for explicit recovery instead of guessing.
 const message=error.name==='SyntaxError'?'Файл подключения повреждён.':String(error.message||'Не удалось установить подключение.');
 process.stdout.write(JSON.stringify({ok:false,error:(message+(claimed?' Файлы нового подключения сохранены; существующие подключения не изменены.':'')).slice(0,700),partialInstallation:Boolean(claimed),savedRegistration:publishedPlist})+'\n');process.exitCode=1;
}
