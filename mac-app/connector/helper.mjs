import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {inflateRawSync} from 'node:zlib';
import {createInterface} from 'node:readline';
import {DesktopUpdater} from './updater.mjs';
import {updateImport,readConnectorUpdateState,readConnectionDiagnostics} from './import-update.mjs';
import {IdleConnectorUpdater} from './auto-update.mjs';
import {migrateConnectionStorage} from './storage-migration.mjs';
import {MigrationPauseStore} from './migration-pause.mjs';

// The native app invokes these operations from native controls and its idle updater.
// Remote pages have no access to this JSON Lines channel or device credentials.
const exec=promisify(execFile);
export {HUB} from './instance.mjs';
import {HUB} from './instance.mjs';
const self=path.dirname(fileURLToPath(import.meta.url));
const resources=path.resolve(process.env.TEAMROOM_BUNDLE_ROOT||path.join(self,'..'));
const home=os.homedir();
const desktopRoot=path.join(home,'Library','Application Support','Team Room Community Desktop');
const managedBase=path.join(home,'Library','Application Support','Team Room Community Connect');
const agentRoot=path.join(home,'Library','LaunchAgents');
const domain='gui/'+process.getuid();
const runtime=path.join(resources,'runtime',process.arch);
const bundledConnect=path.join(resources,'connect');
const storageModule=await import(await fs.access(new URL('../connect/lib/external-storage.mjs',import.meta.url)).then(()=>new URL('../connect/lib/external-storage.mjs',import.meta.url).href,()=>new URL('../../lib/external-storage.mjs',import.meta.url).href));
const {loadStorageLocations,resolveConfiguredDeviceRoot,assertStorageForPath,externalStorageBase}=storageModule;
// External storage is selected explicitly in this installation.
const preferredExternalVolumes={};
const storageMigrations=new Map();
const migrationPauses=new MigrationPauseStore(desktopRoot);
let backgroundPending=null;
const logins=new Map();
const updater=new DesktopUpdater({resources,desktopRoot,event:(name,data)=>event(name,data)});
let mutation=Promise.resolve();
let shuttingDown=false;
const safeError=error=>error?.code==='ENOSPC'?'На этом Mac закончилось свободное место. Освободи место на диске и повтори обновление.':error?.name==='SyntaxError'?'Файл или запрос повреждён. Скачай архив подключения заново.':String(error?.message||'Не удалось выполнить действие.').replace(/(?:[A-Za-z0-9_-]{36,}\.){2}[A-Za-z0-9_-]+/g,'[скрыто]').replace(/(?:token|authorization|password)\s*[:=]\s*\S+/gi,'[скрыто]').slice(0,700);
const output=value=>{if(!shuttingDown)process.stdout.write(JSON.stringify(value)+'\n');};
const event=(name,data={})=>output({type:'event',event:name,...data});
const exists=async target=>{try{await fs.access(target);return true}catch{return false}};
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function configValue(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('В архиве отсутствует подключение компьютера.');
 if(!/^[A-Za-z0-9-]{16,80}$/.test(value.deviceId)||typeof value.token!=='string'||value.token.length<20||value.token.length>4096)throw new Error('Файл подключения повреждён. Скачай полный архив в разделе «Компьютеры».');
 let hub;try{hub=new URL(value.hubUrl)}catch{throw new Error('Неверный адрес пространства.')}
 if(hub.origin!==HUB||hub.username||hub.password||hub.pathname!=='/'||hub.search||hub.hash)throw new Error('Это подключение другого пространства. Нужен архив нашего Team Room.');
 return {hubUrl:HUB,deviceId:value.deviceId,token:value.token,name:String(value.name||'Этот Mac').replace(/[\x00-\x1f\x7f]/g,'').slice(0,120),...(typeof value.projectId==='string'?{projectId:value.projectId.slice(0,100)}:{})};
}
async function readConfig(root){
 const target=path.join(root,'device-config.json');const stat=await fs.lstat(target);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw new Error('Неверный файл подключения.');
 return configValue(JSON.parse(await fs.readFile(target,'utf8')));
}
async function privateJson(target,value){
 await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});
 const temp=target+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
 await fs.writeFile(temp,JSON.stringify(value,null,2),{mode:0o600,flag:'wx'});
 await fs.rename(temp,target);await fs.chmod(target,0o600);
}
async function launchInfo(label){
 if(!/^io\.teamroom\.community\.connect(?:\.[A-Za-z0-9-]{16,80})?$/.test(label))return {registered:false,running:false};
 try{const r=await exec('/bin/launchctl',['print',domain+'/'+label],{timeout:5000,maxBuffer:100000});const pid=Number(r.stdout.match(/\n\s*pid = (\d+)/)?.[1])||null;return {registered:true,running:Boolean(pid),pid}}catch{return {registered:false,running:false,pid:null}}
}
async function journals(root){
 try{const state=await readConnectorUpdateState(root,{allowSavedResults:true});return {running:state.running,pending:state.pending,valid:true,savedResultsUpdateEligible:state.savedOnly&&state.canUpdate};}
 catch{return {running:0,pending:0,valid:false,savedResultsUpdateEligible:false};}
}
async function diagnostics(root){
 try{return await readConnectionDiagnostics(root);}catch{return null;}
}
async function preparedPairingSource(item){
 const source=path.join(desktopRoot,'pairings',item.config.deviceId);
 try{
  if(item.root===source)return (await fs.readdir(source)).every(name=>name==='device-config.json')?source:null;
  if(!item.storage?.external||item.storageUnavailable)return null;
  await assertStorageForPath(item.root);const names=await fs.readdir(item.root);
  if(!names.includes('device-config.json')||names.some(name=>![storageModule.STORAGE_LOCATION_MARKER,'device-config.json'].includes(name)))return null;
  const stat=await fs.lstat(source);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(source)!==source||(await fs.readdir(source)).some(name=>name!=='device-config.json'))return null;
  const original=await readConfig(source);if(original.deviceId!==item.config.deviceId||original.token!==item.config.token||original.hubUrl!==item.config.hubUrl)return null;
  return source;
 }catch{return null;}
}
async function discover(){
 const entries=new Map(),registry=await loadStorageLocations();
 async function add(root,agent=null){
  try{root=await fs.realpath(root);const config=await readConfig(root);const key=config.deviceId+':'+hash(root).slice(0,12);const old=entries.get(key);agent=agent||old?.agent||null;
   if(!agent){const label='io.teamroom.community.connect.'+config.deviceId,plist=path.join(agentRoot,label+'.plist'),state=await launchInfo(label);if(await exists(plist)||state.registered)agent={label,plist:await exists(plist)?plist:null,...state};}
   const location=registry.locations[config.deviceId]||null;if(location&&location.root!==root)throw new Error('Папка подключения не соответствует выбранному диску.');
   if(location)await assertStorageForPath(root);
   entries.set(key,{id:key,root,config,agent,storage:location?{external:true,root,volumePath:location.volumePath,available:true}:{external:false,root,available:true}});
  }catch{}
 }
 let names=[];try{names=await fs.readdir(agentRoot)}catch{}
 for(const name of names.filter(value=>/^io\.teamroom\.community\.connect(?:\.[A-Za-z0-9-]{16,80})?\.plist$/.test(value))){
  try{const r=await exec('/usr/bin/plutil',['-convert','json','-o','-',path.join(agentRoot,name)],{timeout:5000,maxBuffer:65536});const value=JSON.parse(r.stdout);const label=name.slice(0,-6);if(value.Label!==label)continue;
   const args=Array.isArray(value.ProgramArguments)?value.ProgramArguments:[];
   const bridge=args.find(arg=>typeof arg==='string'&&path.basename(arg)==='bridge.mjs');
   const desktop=args.find(arg=>typeof arg==='string'&&path.basename(arg)==='desktop-connect.mjs');
   if(bridge)await add(path.dirname(bridge),{label,plist:path.join(agentRoot,name),...await launchInfo(label)});
   else if(desktop)await add(path.join(path.dirname(desktop),'storage','connect-local'),{label,plist:path.join(agentRoot,name),...await launchInfo(label)});
  }catch{}
 }
 for(const base of [managedBase,path.join(desktopRoot,'pairings')]){
  let children=[];try{children=await fs.readdir(base,{withFileTypes:true})}catch{}
  for(const child of children)if(child.isDirectory()&&/^[A-Za-z0-9-]{16,80}$/.test(child.name))await add(path.join(base,child.name));
 }
 // Keep an unplugged external connection visible. Do not create another
 // internal pairing or silently start using an internal workspace.
 for(const [deviceId,location]of Object.entries(registry.locations))if(![...entries.values()].some(item=>item.config.deviceId===deviceId)){
  const resolved=await resolveConfiguredDeviceRoot(deviceId,{requireAvailable:false});
  if(resolved.available){await add(location.root);if([...entries.values()].some(item=>item.config.deviceId===deviceId))continue;}
  const label='io.teamroom.community.connect.'+deviceId,plist=path.join(agentRoot,label+'.plist');let name='Этот Mac';
  try{name=(await readConfig(path.join(desktopRoot,'pairings',deviceId))).name;}catch{}
  const savedPlist=await exists(plist),service=await launchInfo(label),agent=savedPlist||service.registered?{label,plist:savedPlist?plist:null,...service}:null;
  entries.set(deviceId+':'+hash(location.root).slice(0,12),{id:deviceId+':'+hash(location.root).slice(0,12),root:location.root,config:{deviceId,name},agent,storage:{external:true,root:location.root,volumePath:location.volumePath,available:resolved.available},storageUnavailable:true,storageError:resolved.error||'Не удалось прочитать сохранённое подключение на выбранном диске. Его файлы сохранены; нужна проверка подключения.'});
 }
 let processList='';try{processList=(await exec('/bin/ps',['-axo','pid=,command='],{timeout:5000,maxBuffer:8*1024*1024})).stdout}catch{}
 const result=[];
 for(const item of entries.values()){
  const [state,status]=item.storageUnavailable?[{running:0,pending:0,valid:false,savedResultsUpdateEligible:false},null]:await Promise.all([journals(item.root),diagnostics(item.root)]);
  const fresh=Boolean(status&&Date.now()-Date.parse(status.at)<90000);
  const processRunning=processList.split('\n').some(line=>line.includes(path.join(item.root,'bridge.mjs'))&&!line.includes('install-background.mjs'));
  const pairingSource=await preparedPairingSource(item),pairingOnly=Boolean(pairingSource),managedRoot=path.join(managedBase,item.config.deviceId);let managedExists=await exists(managedRoot);
  // A registered compatibility link to this same marker/config-only pairing
  // is not a second installation. A real pre-existing managed directory is.
  if(pairingOnly&&item.storage?.external&&managedExists)try{const stat=await fs.lstat(managedRoot);if(stat.isSymbolicLink()&&path.resolve(path.dirname(managedRoot),await fs.readlink(managedRoot))===item.root&&await fs.realpath(managedRoot)===item.root)managedExists=false;}catch{}
  const hasSavedAgent=names.some(name=>/^io\.teamroom\.community\.connect(?:\.[A-Za-z0-9-]{16,80})?\.plist$/.test(name));
  result.push({...item,pairingOnly,pairingSource,managedExists,hasSavedAgent,processRunning,running:state.running,pending:state.pending,journalValid:state.valid,savedResultsUpdateEligible:state.savedResultsUpdateEligible,connected:fresh&&status.state===1,diagnostics:status});
 }
 // Prefer an existing active service over an imported pairing of the same device.
 return result.sort((a,b)=>Number(Boolean(b.agent?.running||b.processRunning||b.connected))-Number(Boolean(a.agent?.running||a.processRunning||a.connected)));
}
function publicEntry(item){return {id:item.id,deviceId:item.config.deviceId,name:item.config.name,connected:item.connected,serviceRunning:Boolean(item.agent?.running||item.processRunning||item.connected),installed:Boolean(item.agent),running:item.running,pending:item.pending,journalValid:item.journalValid,savedResultsUpdateEligible:Boolean(item.savedResultsUpdateEligible),connectorVersion:item.diagnostics?.connectorVersion||null,canInstall:Boolean(item.pairingOnly&&!item.managedExists&&!item.hasSavedAgent&&!item.agent&&!item.processRunning&&!item.connected&&!item.running&&!item.pending&&item.journalValid),canStart:Boolean(item.agent&&!item.agent.running&&!item.processRunning&&!item.connected&&item.journalValid&&!item.storageUnavailable),storage:item.storage||{external:false,root:item.root,available:true},storageError:item.storageError||null,location:item.root.startsWith(managedBase)?'managed':item.root.startsWith(desktopRoot)?'paired':'existing'};}
async function selected(id){const value=(await discover()).find(item=>item.id===id);if(!value)throw new Error('Подключение не найдено. Обнови список компьютеров.');if(value.storageUnavailable)throw new Error(value.storageError||'Подключи выбранный внешний диск.');await assertStorageForPath(value.root);return value;}
function cli(provider){
 if(!['claude','codex'].includes(provider))throw new Error('Неверный провайдер.');
 return path.join(runtime,'bin',provider);
}
function cliEnv(){
 const value={...process.env,PATH:[path.join(runtime,'bin'),path.join(home,'.local','bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin',process.env.PATH||''].join(':')};
 for(const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','CODEX_API_KEY','ANTHROPIC_BASE_URL','CLAUDECODE'])delete value[key];
 return value;
}
async function readiness(){
 const files={node:path.join(runtime,'bin','node'),claude:cli('claude'),codex:cli('codex'),bridge:path.join(bundledConnect,'bridge.mjs'),ws:path.join(bundledConnect,'node_modules','ws','package.json'),mcp:path.join(bundledConnect,'node_modules','@modelcontextprotocol','sdk','package.json')};
 const result={};for(const [key,value]of Object.entries(files)){try{const stat=await fs.stat(value);result[key]=stat.isFile()&&(!['node','claude','codex'].includes(key)||(stat.mode&0o111)!==0)}catch{result[key]=false}}
 return {ready:Object.values(result).every(Boolean),architecture:process.arch,components:result};
}
let authCache=null;
async function providerStatus(force=false){
 if(!force&&authCache&&Date.now()-authCache.at<30000)return authCache.value;
 const value={};await Promise.all(['claude','codex'].map(async provider=>{
  if(!await exists(cli(provider))){value[provider]={available:false,connected:false};return}
  try{const r=await exec(cli(provider),provider==='claude'?['auth','status']:['login','status'],{env:cliEnv(),timeout:18000,maxBuffer:65536});const auth=provider==='claude'?JSON.parse(r.stdout):null;value[provider]={available:true,connected:provider==='claude'?Boolean(auth.loggedIn&&auth.authMethod==='claude.ai'):/logged in using chatgpt/i.test(r.stdout+r.stderr),...(provider==='claude'&&auth.subscriptionType?{subscription:String(auth.subscriptionType).slice(0,50)}:{})}}catch{value[provider]={available:true,connected:false}}
 }));authCache={at:Date.now(),value};return value;
}
async function status(payload={}){
 const [entries,dependencies]=await Promise.all([discover(),readiness()]);
 const current=entries.find(item=>item.agent?.running||item.processRunning||item.connected)||entries[0];
 return {hubUrl:HUB,connections:entries.map(publicEntry),current:current?publicEntry(current):null,connectorUpdate:current?connectorUpdater.snapshot(current.id):null,storageMigration:current?storageMigrations.get(current.config.deviceId)||null:null,connected:Boolean(current?.connected),running:current?.running||0,pending:current?.pending||0,deviceName:current?.config.name||null,runtime:dependencies,providers:payload.auth?await providerStatus(Boolean(payload.force)):null};
}

// Read only a bounded config member. No ZIP scripts or binaries are extracted.
function configFromZip(bytes){
 if(bytes.length<22||bytes.length>64*1024*1024)throw new Error('Архив повреждён или слишком большой.');
 let end=-1;for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--)if(bytes.readUInt32LE(offset)===0x06054b50&&offset+22+bytes.readUInt16LE(offset+20)===bytes.length){end=offset;break}
 if(end<0)throw new Error('Это не обычный ZIP-архив подключения.');
 if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||bytes.readUInt16LE(end+8)!==bytes.readUInt16LE(end+10))throw new Error('Составной ZIP-архив не поддерживается.');
 const count=bytes.readUInt16LE(end+10),dirSize=bytes.readUInt32LE(end+12),start=bytes.readUInt32LE(end+16);
 if(count>3000||count===65535||start+dirSize!==end)throw new Error('Неверная структура ZIP-архива.');
 let offset=start,config=null;
 for(let n=0;n<count;n++){
  if(offset+46>end||bytes.readUInt32LE(offset)!==0x02014b50)throw new Error('ZIP-архив повреждён.');
  const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),checksum=bytes.readUInt32LE(offset+16),compressed=bytes.readUInt32LE(offset+20),size=bytes.readUInt32LE(offset+24),nameLength=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32),attrs=bytes.readUInt32LE(offset+38),local=bytes.readUInt32LE(offset+42);
  const next=offset+46+nameLength+extra+comment;if(next>end)throw new Error('ZIP-архив повреждён.');
  const name=bytes.subarray(offset+46,offset+46+nameLength).toString('utf8');
  if(name.split('/').at(-1)==='device-config.json'){
   if(config||flags&1||!nameLength||name.startsWith('/')||name.includes('\\')||name.split('/').some(part=>part==='..'||part==='.'||!part)||((attrs>>>16)&0o170000)===0o120000||size>16384||compressed>32768||![0,8].includes(method))throw new Error('Неверный файл подключения в архиве.');
   if(local+30>start||bytes.readUInt32LE(local)!==0x04034b50)throw new Error('ZIP-архив повреждён.');
   const localFlags=bytes.readUInt16LE(local+6),localMethod=bytes.readUInt16LE(local+8),ln=bytes.readUInt16LE(local+26),le=bytes.readUInt16LE(local+28);const content=local+30+ln+le;
   if(localFlags!==flags||localMethod!==method||content+compressed>start||bytes.subarray(local+30,local+30+ln).toString('utf8')!==name)throw new Error('ZIP-архив повреждён.');
   const raw=bytes.subarray(content,content+compressed);const unpacked=method===0?raw:inflateRawSync(raw,{maxOutputLength:16384});
   let crc=0xffffffff;for(const byte of unpacked){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc&1)?0xedb88320^(crc>>>1):crc>>>1;}crc=(crc^0xffffffff)>>>0;
   if(unpacked.length!==size||crc!==checksum)throw new Error('Файл подключения повреждён.');
   let value;try{value=JSON.parse(unpacked.toString('utf8'))}catch{throw new Error('Файл подключения повреждён. Скачай архив заново.')}config=configValue(value);
  }
  offset=next;
 }
 if(offset!==end||!config)throw new Error('Нужен полный архив компьютера: «Компьютеры» → «Добавить компьютер». Архив обновления не содержит подключения.');
 return config;
}
async function importZip(payload){
 if(typeof payload.path!=='string'||!path.isAbsolute(payload.path)||path.extname(payload.path).toLowerCase()!=='.zip')throw new Error('Выбери ZIP-архив подключения.');
 const stat=await fs.stat(payload.path);if(!stat.isFile()||stat.size>64*1024*1024)throw new Error('Архив слишком большой.');
 const config=configFromZip(await fs.readFile(payload.path));return importConfig(config);
}
async function importConfig(value){
 const config=configValue(value),entries=await discover();const previous=entries.find(item=>item.config.deviceId===config.deviceId);
 if(previous){if(previous.config.token!==config.token)throw new Error('На Mac уже есть это подключение с другим ключом. Для нового подключения создай отдельный компьютер в Team Room.');return {connection:publicEntry(previous),reused:true}}
 if(entries.some(item=>item.agent?.running||item.processRunning||item.connected))throw new Error('Этот Mac уже подключён. Второе подключение не требуется.');
 const root=path.join(desktopRoot,'pairings',config.deviceId);
 await fs.mkdir(path.dirname(root),{recursive:true,mode:0o700});
 try{await fs.mkdir(root,{recursive:false,mode:0o700})}catch(error){if(error.code==='EEXIST')throw new Error('Папка этого подключения уже существует. Её данные оставлены без изменений; восстанови существующее подключение отдельно.');throw error}
 await fs.writeFile(path.join(root,'device-config.json'),JSON.stringify(config,null,2),{mode:0o600,flag:'wx'});const entry=(await discover()).find(item=>item.root===root);
 return {connection:publicEntry(entry),reused:false};
}
async function pair(payload){
 const entries=await discover(),existing=entries.find(item=>item.agent||item.processRunning||item.connected)||entries[0];
 if(existing){
  if(existing.agent&&!existing.agent.running&&!existing.processRunning&&!existing.connected)return start({id:existing.id});
  if(existing.pairingOnly)return install({id:existing.id});
  if(!existing.agent&&!existing.processRunning&&!existing.connected)throw new Error('Найдена незавершённая установка. Её файлы сохранены; нужна проверка подключения.');
  return {...await status(),reused:true,message:'Этот Mac уже подключён. Использую существующее подключение без перезапуска.'};
 }
 const name=String(payload.name||'').trim().normalize('NFC');if(!name||name.length>80||/[\x00-\x1f\x7f]/.test(name))throw new Error('Укажи имя компьютера до 80 символов.');
 if(!/^[a-f0-9]{64}$/.test(payload.session||''))throw new Error('Сначала войди в Team Room в главном окне приложения.');
 if(!(await readiness()).ready)throw new Error('В сборке отсутствуют компоненты подключения. Установи полную версию приложения.');
 let agents=[];try{agents=await fs.readdir(agentRoot)}catch{}if(agents.some(name=>/^io\.teamroom\.community\.connect(?:\.[A-Za-z0-9-]{16,80})?\.plist$/.test(name)))throw new Error('На Mac осталось прежнее подключение, но его файлы не найдены. Нужна проверка; новое подключение не создано.');
 const planPath=path.join(desktopRoot,'pairing-request.json');let plan;
 try{const stat=await fs.lstat(planPath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw new Error('Сохранённая настройка повреждена.');plan=configValue(JSON.parse(await fs.readFile(planPath,'utf8')));}
 catch(error){if(error.code!=='ENOENT')throw error;plan={hubUrl:HUB,deviceId:crypto.randomUUID(),token:crypto.randomBytes(32).toString('hex'),name};await privateJson(planPath,plan);}
 event('installation',{stage:'registering',message:'Подключаю Mac к общему пространству…'});
 let response;try{response=await fetch(HUB+'/api/native-device-pair',{method:'POST',redirect:'error',headers:{'content-type':'application/json',cookie:'trc_session='+payload.session,origin:HUB},body:JSON.stringify({name:plan.name,deviceId:plan.deviceId,token:plan.token}),signal:AbortSignal.timeout(30000)});}catch{throw new Error('Не удалось связаться с Team Room. Нажми «Подключить» ещё раз: повторная регистрация не создаст дубликат.');}
 if(Number(response.headers.get('content-length'))>16384)throw new Error('Неверный ответ сервера.');const text=await response.text();if(text.length>16384)throw new Error('Неверный ответ сервера.');let result;try{result=JSON.parse(text)}catch{throw new Error('Не удалось прочитать ответ сервера.');}
 if(!response.ok)throw new Error(response.status===401?'Войди в Team Room в главном окне приложения.':response.status===404?'Обновление сервера ещё не готово. Повтори подключение немного позже.':String(result.error||'Не удалось зарегистрировать Mac.'));
 if(result.deviceId!==plan.deviceId||result.hubUrl!==HUB)throw new Error('Сервер вернул другое подключение.');
 const imported=await importConfig({...plan,name:result.name});const installed=await install({id:imported.connection.id});await fs.rm(planPath,{force:true});return installed;
}

async function install(payload){
 const entry=await selected(payload.id);const all=await discover();const siblings=all.filter(item=>item.config.deviceId===entry.config.deviceId);
 const existing=siblings.find(item=>item.agent);
 if(existing)return {connection:publicEntry(existing),reused:true,message:'Подключение уже установлено. Используй «Включить существующее подключение». Программа и рабочие данные оставлены без изменений.'};
 const active=siblings.find(item=>item.agent?.running||item.processRunning||item.connected);
 if(active)return {connection:publicEntry(active),reused:true,message:'Это подключение уже работает. Приложение использует его без перезапуска.'};
 if(all.some(item=>item.config.deviceId!==entry.config.deviceId&&(item.agent?.running||item.processRunning||item.connected)))throw new Error('Этот Mac уже подключён через другой компьютер в списке. Используй работающее подключение.');
 if(!entry.pairingOnly||entry.managedExists||entry.hasSavedAgent)throw new Error('Существующее или незавершённое подключение не переустанавливается в этом выпуске. Используй его текущий запуск или восстанови подключение отдельно.');
 if(siblings.some(item=>item.running||item.pending||!item.journalValid))throw new Error('Дождись завершения работы и сохранения результатов. Подключение оставлено без изменений.');
 if(!(await readiness()).ready)throw new Error('В приложении отсутствует часть компонентов. Установи полную сборку Team Room.');
 event('installation',{stage:'preparing',message:'Подготавливаю фоновое подключение…'});
 const storage=await resolveConfiguredDeviceRoot(entry.config.deviceId);const tempBase=storage.configured?await externalStagingDirectory(storage):os.tmpdir();
 const temp=await fs.mkdtemp(path.join(tempBase,'teamroom-desktop-'));
 try{
  const source=path.join(temp,'connect');await fs.cp(bundledConnect,source,{recursive:true,dereference:false,...(storage.configured?{filter:async()=>{await assertStorageForPath(storage.root);return true;}}:{})});
  if(storage.configured)await assertStorageForPath(storage.root);
  await privateJson(path.join(source,'device-config.json'),entry.config);
  const args=[path.join(self,'install-background.mjs'),'--source',source,'--runtime',runtime,'--previous',entry.pairingSource||entry.root];
  if(storage.configured)await assertStorageForPath(storage.root);let r;try{r=await exec(path.join(runtime,'bin','node'),args,{env:cliEnv(),timeout:300000,maxBuffer:65536})}catch(error){let value;try{value=JSON.parse(error.stdout?.trim().split('\n').at(-1))}catch{}throw new Error(value?.error||'Не удалось установить фоновое подключение.');}
  let result;try{result=JSON.parse(r.stdout.trim().split('\n').at(-1))}catch{throw new Error('Не удалось получить результат установки.')}
  if(!result.ok)throw new Error(result.error||'Не удалось установить подключение.');
  event('installation',{stage:'complete',message:'Фоновое подключение установлено. Окно можно закрыть.'});return {...await status(),installed:true};
 }finally{if(storage.configured)await assertStorageForPath(storage.root).then(()=>fs.rm(temp,{recursive:true,force:true})).catch(()=>{});else await fs.rm(temp,{recursive:true,force:true});}
}
async function externalStagingDirectory(storage){
 await assertStorageForPath(storage.root);const base=externalStorageBase(storage.location.volumePath),target=path.join(base,'.desktop-staging'),root=await fs.lstat(storage.root),parent=await fs.lstat(base);
 if(!parent.isDirectory()||parent.isSymbolicLink()||parent.dev!==root.dev||await fs.realpath(base)!==base)throw new Error('Папка выбранного внешнего диска недоступна.');
 try{await fs.mkdir(target,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}const stat=await fs.lstat(target);
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.dev!==root.dev||await fs.realpath(target)!==target)throw new Error('Папка временных файлов внешнего диска не может быть ссылкой.');
 await assertStorageForPath(storage.root);await fs.chmod(target,0o700);return target;
}
async function start(payload){
 const entry=await selected(payload.id);const siblings=await discover();const active=siblings.find(item=>item.config.deviceId===entry.config.deviceId&&(item.agent?.running||item.processRunning||item.connected));if(active)return {connection:publicEntry(active),reused:true};
 if(siblings.some(item=>item.config.deviceId!==entry.config.deviceId&&(item.agent?.running||item.processRunning||item.connected)))throw new Error('Этот Mac уже подключён. Второе фоновое подключение не требуется.');
 if(!entry.journalValid)throw new Error('Журнал работы повреждён. Необходима проверка подключения.');
 if(!entry.agent)throw new Error('Сначала установи фоновое подключение.');
 // No -k: a running connector is never killed or restarted here.
 const registration=await launchInfo(entry.agent.label);
 if(!registration.registered){
  if(!entry.agent.plist||!await exists(entry.agent.plist))throw new Error('Сохранённый автозапуск не найден. Необходима отдельная проверка подключения.');
  const r=await exec('/usr/bin/plutil',['-convert','json','-o','-',entry.agent.plist],{timeout:5000,maxBuffer:65536});const saved=JSON.parse(r.stdout);if(saved.Label!==entry.agent.label||!Array.isArray(saved.ProgramArguments)||!saved.ProgramArguments.some(arg=>typeof arg==='string'&&['bridge.mjs','desktop-connect.mjs'].includes(path.basename(arg))))throw new Error('Сохранённый автозапуск повреждён. Нужна отдельная проверка подключения.');
  try{await exec('/bin/launchctl',['bootstrap',domain,entry.agent.plist],{timeout:10000,maxBuffer:65536})}catch(error){if(!(await launchInfo(entry.agent.label)).registered)throw error}
 }
 await exec('/bin/launchctl',['kickstart',domain+'/'+entry.agent.label],{timeout:10000,maxBuffer:65536});return {...await status(),started:true};
}
const oauthHosts=new Set(['claude.ai','console.anthropic.com','platform.claude.com','auth.openai.com','chatgpt.com','platform.openai.com','login.openai.com']);
async function beginLogin(payload){
 const provider=payload.provider;if(!['claude','codex'].includes(provider))throw new Error('Неверный провайдер.');
 if(logins.has(provider))return {started:true,alreadyRunning:true};
 if(!await exists(cli(provider)))throw new Error('Официальный '+(provider==='claude'?'Claude Code':'Codex')+' отсутствует в сборке.');
 const connections=await discover();if(connections.some(item=>item.running||item.pending||!item.journalValid))throw new Error('Дождись завершения работы перед изменением авторизации.');
 const child=spawn(cli(provider),provider==='claude'?['auth','login']:['login'],{cwd:home,env:cliEnv(),stdio:['pipe','pipe','pipe']});
 const seen=new Set();let buffer='';logins.set(provider,child);
 const capture=chunk=>{
  buffer=(buffer+chunk.toString()).slice(-16384);const cut=Math.max(buffer.lastIndexOf('\n'),buffer.lastIndexOf('\r'));if(cut<0)return;const text=buffer.slice(0,cut+1);buffer=buffer.slice(cut+1);
  for(const value of text.match(/https:\/\/[^\s<>"\x1b]+/g)||[]){
   let url;try{url=new URL(value.replace(/[),.;]+$/,''))}catch{continue}
   if(url.protocol!=='https:'||url.username||url.password||!oauthHosts.has(url.hostname)||seen.has(url.href))continue;
   seen.add(url.href);event('login-url',{provider,url:url.href});
  }
 };
 child.stdout.on('data',capture);child.stderr.on('data',capture);
 child.once('error',()=>{logins.delete(provider);event('login-complete',{provider,success:false,message:'Не удалось открыть официальный вход.'})});
 child.once('exit',async code=>{logins.delete(provider);authCache=null;const auth=await providerStatus(true);event('login-complete',{provider,success:code===0&&auth[provider]?.connected,message:code===0&&auth[provider]?.connected?'Подписка подключена.':'Вход не завершён. Повтори вход в официальный аккаунт.'})});
 return {started:true};
}
async function cancelLogin(payload){const child=logins.get(payload.provider);if(child)child.kill('SIGTERM');return {cancelled:Boolean(child)}}
function storageEvent(deviceId,name,data){
 const value={...data,updatedAt:new Date().toISOString()};storageMigrations.set(deviceId,value);event(name,{...data,deviceId});
}
async function migrateStorage(payload){
 if(logins.size)throw new Error('Дождись завершения входа в подписку на этом Mac.');
 const entry=await selected(payload.id),selectedPath=String(payload.volumePath||preferredExternalVolumes[entry.config.deviceId]||'');
 const parts=path.resolve(selectedPath).split(path.sep);if(parts[1]!=='Volumes'||!parts[2])throw new Error('Выбери подключённый внешний диск.');
 const volumePath=path.join('/Volumes',parts[2]);
 const result=await migrateConnectionStorage(entry,{volumePath,externalBase:externalStorageBase(volumePath),desktopRoot,bundledConnect,event:(name,data)=>storageEvent(entry.config.deviceId,name,data)});
 await migrationPauses.clear(entry.config.deviceId).catch(()=>{});
 storageEvent(entry.config.deviceId,'storage-migration',{state:'completed',message:result.message||'Подключение перенесено на внешний диск.',...(result.root?{root:result.root}:{}),...(result.originalRoot?{originalRoot:result.originalRoot}:{}),...(Number.isFinite(result.bytesMoved)?{bytesMoved:result.bytesMoved}:{}),...(Number.isFinite(result.freedBytes)?{freedBytes:result.freedBytes}:{}),...(result.internalBackupKept?{internalBackupKept:true}:{})});
 return {...result,message:result.message||'Рабочие файлы, история и временные передачи перенесены на внешний диск.'};
}
async function autoExternalMigration(){
 return serializeMutation(async()=>{
  if(shuttingDown||logins.size)return false;
  const registry=await loadStorageLocations(),entries=await discover();
  const entry=entries.find(item=>preferredExternalVolumes[item.config.deviceId]&&!registry.locations[item.config.deviceId]&&item.agent?.plist&&!item.pairingOnly);
  if(!entry)return false;
  const id=entry.config.deviceId,previous=storageMigrations.get(id);
  if(previous?.state==='attention')return false;
  let paused;
  try{paused=await migrationPauses.read(id);}
  catch{storageEvent(id,'storage-migration',{state:'attention',message:'Автоматический перенос приостановлен: не удалось прочитать его состояние. Подключение можно обновить отдельно; файлы сохранены.'});return false;}
  if(paused){storageEvent(id,'storage-migration',{state:'attention',message:paused.message});return false;}
  const label='io.teamroom.community.connect.'+id;
  if(entry.root!==path.join(managedBase,id)||entry.agent.label!==label||entry.agent.plist!==path.join(agentRoot,label+'.plist')){const message='Это подключение использует прежний ручной запуск. Для переноса его папки нужна отдельная проверка; обновление подключения доступно.';if(previous?.state!=='attention'||previous.message!==message)storageEvent(id,'storage-migration',{state:'attention',message});return false;}
  if((entry.running||entry.pending)&&!entry.savedResultsUpdateEligible){storageEvent(id,'storage-migration',{state:'waiting',message:'Файлы будут перенесены на выбранный диск после завершения работы.'});return true;}
  try{await migrateStorage({id:entry.id,volumePath:preferredExternalVolumes[id]});}
  catch(error){const message=safeError(error)+' Автоматические попытки переноса остановлены, чтобы не отключать этот Mac повторно. Для повторной попытки используй «Перенести на внешний диск…».';storageEvent(id,'storage-migration',{state:'attention',message});await migrationPauses.pause(id,message).catch(()=>{});return false;}
  return true;
 });
}
function backgroundCheck(){
 if(backgroundPending)return backgroundPending;
 const pending=(async()=>{if(shuttingDown)return;const pendingMigration=await autoExternalMigration();if(!pendingMigration&&!shuttingDown)await connectorUpdater.check();})().catch(error=>event('storage-migration',{state:'attention',message:safeError(error)})).finally(()=>{if(backgroundPending===pending)backgroundPending=null;});backgroundPending=pending;return pending;
}
const actions={migrateStorage,updateImport:async payload=>{if(logins.size)throw new Error('Дождись завершения входа в подписку перед обновлением.');return updateImport(await selected(payload.id),{managedBase,bundledConnect,event,allowSavedResults:true});},status,importZip,pair,install,start,login:beginLogin,cancelLogin,updateStatus:()=>updater.check(),prepareUpdate:()=>updater.prepare(),installUpdate:()=>updater.install()};
function serializeMutation(action){const previous=mutation;mutation=previous.catch(()=>{}).then(action);return mutation;}
const connectorUpdater=new IdleConnectorUpdater({
 version:JSON.parse(await fs.readFile(path.join(bundledConnect,'package.json'),'utf8')).version,
 discover,serialize:serializeMutation,canRun:()=>!shuttingDown&&logins.size===0,event,safeError,
 update:(entry,options)=>updateImport(entry,{managedBase,bundledConnect,event,allowSavedResults:options?.allowSavedResults===true})
});
async function dispatch(request){
 if(shuttingDown)throw new Error('Приложение завершает безопасное обновление подключения.');
 if(!request||typeof request.id!=='string'||request.id.length>100||!Object.hasOwn(actions,request.action)||request.payload!=null&&(typeof request.payload!=='object'||Array.isArray(request.payload)))throw new Error('Неверный запрос приложения.');
 const action=()=>actions[request.action](request.payload||{});
 if(['importZip','pair','install','start','login','prepareUpdate','installUpdate','updateImport','migrateStorage'].includes(request.action))return serializeMutation(action);
 return action();
}
if(process.argv.includes('--status')){
 try{output({ok:true,result:await status({auth:process.argv.includes('--auth')})})}catch(error){output({ok:false,error:safeError(error)});process.exitCode=1}
}else{
 const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
 const initialUpdate=setTimeout(()=>void backgroundCheck(),5000);initialUpdate.unref();
 const updateTimer=setInterval(()=>void backgroundCheck(),30000);updateTimer.unref();
 lines.on('line',line=>{
  if(line.length>32768){output({id:null,ok:false,error:'Слишком большой запрос приложения.'});return}
  let request;try{request=JSON.parse(line)}catch{output({id:null,ok:false,error:'Неверный запрос приложения.'});return}
  dispatch(request).then(result=>output({id:request.id,ok:true,result}),error=>output({id:request.id||null,ok:false,error:safeError(error)}));
 });
 // Closing the app must not kill a connector update between bootout and
 // bootstrap. Finish or roll back the serialized mutation before exiting.
 const close=()=>{if(shuttingDown)return;shuttingDown=true;connectorUpdater.stop();clearTimeout(initialUpdate);clearInterval(updateTimer);for(const child of logins.values())child.kill('SIGTERM');void mutation.catch(()=>{}).finally(()=>process.exit(0));};
 lines.on('close',close);process.on('SIGTERM',close);process.on('SIGINT',close);
 process.stdout.on('error',error=>{if(error.code==='EPIPE')close();else throw error;});
}
