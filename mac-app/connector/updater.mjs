import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {HUB,updatesEnabled} from './instance.mjs';
const exec=promisify(execFile);
let externalStorageModule;
function storageModule(){if(!externalStorageModule){const bundled=new URL('../connect/lib/external-storage.mjs',import.meta.url);externalStorageModule=import(bundled.href).catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND'||error.url&&error.url!==bundled.href)throw error;return import(new URL('../../lib/external-storage.mjs',import.meta.url).href);});}return externalStorageModule;}
async function privateDirectory(directory,existingBase=null){
 if(!path.isAbsolute(directory)||path.resolve(directory)!==directory)throw new Error('Неверная папка обновления.');let current=existingBase||path.parse(directory).root;
 if(existingBase){if(directory!==existingBase&&!directory.startsWith(existingBase+path.sep))throw new Error('Неверная папка обновления.');const stat=await fs.lstat(existingBase);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(existingBase)!==existingBase)throw new Error('Рабочая папка внешнего диска недоступна.');}
 for(const part of path.relative(current,directory).split(path.sep).filter(Boolean)){current=path.join(current,part);try{await fs.mkdir(current,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Папка обновления не может быть ссылкой.');}await fs.chmod(directory,0o700);return directory;
}
const newer=(a,b)=>{const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i];return false;};
async function boundedJSON(response){if(Number(response.headers.get('content-length'))>32768)throw new Error('Неверное описание обновления.');let text='';for await(const chunk of response.body){text+=Buffer.from(chunk).toString('utf8');if(text.length>32768)throw new Error('Описание обновления слишком большое.');}return JSON.parse(text);}
export class DesktopUpdater{
 constructor({resources,desktopRoot,event}){this.resources=resources;this.internalFolder=path.join(desktopRoot,'updates');this.folder=this.internalFolder;this.event=event;this.prepared=null;}
 async updateStorage(){
  const storage=await storageModule(),registry=await storage.loadStorageLocations(),locations=Object.values(registry.locations);if(!locations.length)return {folder:this.internalFolder,location:null};
  const verified=[];for(const location of locations){const resolved=await storage.resolveConfiguredDeviceRoot(location.deviceId);verified.push(resolved.location);}
  const bases=new Set(verified.map(location=>storage.externalStorageBase(location.volumePath)));if(bases.size!==1)throw new Error('Для подключений выбраны разные внешние диски. Уточни папку Team Room перед обновлением приложения.');
  return {folder:path.join([...bases][0],'desktop-updates'),location:verified[0]};
 }
 async requireStorage(selected){if(selected.location){const current=await this.updateStorage();if(current.folder!==selected.folder||current.location?.volumeUuid!==selected.location.volumeUuid)throw new Error('Выбранный диск изменился. Подготовь обновление заново.');}else{const current=await this.updateStorage();if(current.location)throw new Error('Папка обновления изменилась. Подготовь обновление заново.');}}
 async check(){
  const local=JSON.parse(await fs.readFile(path.join(this.resources,'build-info.json'),'utf8'));
  if(!updatesEnabled)return {available:false,current:local.version,message:'Обновления этой сборки настраивает владелец сервера.'};
  const response=await fetch(HUB+'/desktop/releases/latest',{redirect:'error',signal:AbortSignal.timeout(20000)});
  if(response.status===404)return {available:false,current:local.version,message:'Обновлений пока нет.'};
  if(!response.ok)throw new Error('Сервер обновлений недоступен. Попробуй позже.');
  const envelope=await boundedJSON(response),key=await fs.readFile(path.join(this.resources,'desktop','update-public-key.pem'),'utf8');
  if(typeof envelope.payload!=='string'||typeof envelope.signature!=='string'||!crypto.verify(null,Buffer.from(envelope.payload,'base64'),key,Buffer.from(envelope.signature,'base64')))throw new Error('Подпись обновления не прошла проверку. Установка отменена.');
  const release=JSON.parse(Buffer.from(envelope.payload,'base64').toString('utf8'));
  if(!/^\d+\.\d+\.\d+$/.test(release.version)||!/^\d+\.\d+(?:\.\d+)?$/.test(release.minimumMacOS)||!/^[a-f0-9]{64}$/.test(release.sha256)||!Number.isSafeInteger(release.bytes)||release.bytes<1000000||release.bytes>1400000000||release.path!=='/desktop/releases/'+release.sha256+'.zip')throw new Error('Неверные параметры обновления.');
  const currentOS=(await exec('/usr/bin/sw_vers',['-productVersion'],{timeout:5000,maxBuffer:4096})).stdout.trim().split('.').map(Number),required=release.minimumMacOS.split('.').map(Number);
  if(currentOS[0]<required[0]||currentOS[0]===required[0]&&currentOS[1]<required[1])throw new Error('Новая версия требует macOS '+release.minimumMacOS+' или новее.');
  this.release=release;return {available:newer(release.version,local.version),current:local.version,version:release.version,bytes:release.bytes,notes:String(release.notes||'').slice(0,3000)};
 }
 async prepare(){
  const info=await this.check();if(!info.available)return info;const release=this.release;
  const target=await fs.realpath(process.env.TEAMROOM_APP_PATH||path.resolve(this.resources,'../..')),parent=path.dirname(target);
  const allowed=['/Applications',path.join(os.homedir(),'Applications')];if(!allowed.includes(parent)||path.basename(target)!=='Team Room Community.app')throw new Error('Сначала перенеси Team Room в папку «Программы» и запусти оттуда.');
  try{await fs.access(parent,constants.W_OK)}catch{throw new Error('Нет прав на обновление в папке «Программы». Установи Team Room в «Программы» своего пользователя.');}
  const updateStorage=await this.updateStorage();this.folder=updateStorage.folder;await this.requireStorage(updateStorage);await privateDirectory(this.folder,updateStorage.location?path.dirname(this.folder):null);await this.requireStorage(updateStorage);const stage=await fs.mkdtemp(path.join(this.folder,'release-')),archive=path.join(stage,'update.zip');
  this.event('update',{stage:'downloading',message:'Загружаю Team Room '+release.version+'…'});
  const response=await fetch(HUB+release.path,{redirect:'error',signal:AbortSignal.timeout(600000)});if(!response.ok)throw new Error('Не удалось загрузить обновление. Повтори позже.');
  await this.requireStorage(updateStorage);const handle=await fs.open(archive,'wx',0o600),hash=crypto.createHash('sha256');let bytes=0,lastProgress=0;
  try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>release.bytes)throw new Error('Размер обновления не совпал.');hash.update(chunk);let offset=0;while(offset<chunk.length){const result=await handle.write(chunk,offset,chunk.length-offset);if(!result.bytesWritten)throw new Error('Не удалось сохранить обновление.');offset+=result.bytesWritten;}const pct=Math.floor(bytes/release.bytes*100);if(pct>=lastProgress+5){lastProgress=pct;this.event('update',{stage:'downloading',message:'Загружаю обновление: '+pct+'%'});}}await handle.sync();}finally{await handle.close();}
  if(bytes!==release.bytes||hash.digest('hex')!==release.sha256)throw new Error('Контрольная сумма обновления не совпала. Установка отменена.');
  this.event('update',{stage:'preparing',message:'Проверяю и подготавливаю новую версию…'});
  await this.requireStorage(updateStorage);await exec('/usr/bin/ditto',['-x','-k',archive,stage],{timeout:180000,maxBuffer:65536});
  const app=path.join(stage,'Team Room Community.app');const plist=JSON.parse((await exec('/usr/bin/plutil',['-convert','json','-o','-',path.join(app,'Contents','Info.plist')],{timeout:5000,maxBuffer:65536})).stdout);
  if(plist.CFBundleIdentifier!=='io.teamroom.community'||plist.CFBundleShortVersionString!==release.version)throw new Error('Обновление содержит другое приложение.');
  await exec('/usr/bin/codesign',['--verify','--strict',app],{timeout:60000,maxBuffer:65536});
  await this.requireStorage(updateStorage);const candidate=path.join(parent,'.TeamRoom-update-'+crypto.randomUUID()+'.app');await fs.cp(app,candidate,{recursive:true,dereference:false,force:false,errorOnExist:true});
  this.prepared={stage,app,candidate,target,version:release.version,updateStorage};return {ready:true,version:release.version,message:'Обновление готово. Можно перезапустить окно приложения; фоновые задачи продолжат работу.'};
 }
 async install(){
  const p=this.prepared;if(!p)throw new Error('Сначала подготовь обновление.');
  await this.requireStorage(p.updateStorage);
  const pid=Number(process.env.TEAMROOM_APP_PID);if(!Number.isSafeInteger(pid)||pid<2)throw new Error('Не удалось определить окно приложения.');
  const node=path.join(p.app,'Contents','Resources','runtime',process.arch,'bin','node'),script=path.join(p.app,'Contents','Resources','desktop','update-install.mjs');
  const child=spawn(node,[script,p.target,p.candidate,String(pid),p.stage],{detached:true,stdio:'ignore',env:{...process.env,TEAMROOM_APP_PID:''}});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(new Error('Не удалось запустить установку обновления.')));});child.unref();this.prepared=null;return {started:true,version:p.version};
 }
}
