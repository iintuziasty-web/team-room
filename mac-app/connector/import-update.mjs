import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify,TextDecoder} from 'node:util';
import {pruneProgramBackups,requireUpdateSpace,updateSpaceError} from './update-space.mjs';
import {HUB} from './instance.mjs';
const exec=promisify(execFile);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let externalStorageModule;
function storageModule(){if(!externalStorageModule){const bundled=new URL('../connect/lib/external-storage.mjs',import.meta.url);externalStorageModule=import(bundled.href).catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND'||error.url&&error.url!==bundled.href)throw error;return import(new URL('../../lib/external-storage.mjs',import.meta.url).href);});}return externalStorageModule;}
// Replace the complete application module set, including newly introduced
// dependencies. A syntax check alone does not detect missing ESM imports.
async function programFiles(bundledConnect){
 const entries=await fs.readdir(path.join(bundledConnect,'lib'),{withFileTypes:true});
 const modules=entries.filter(entry=>entry.isFile()&&/^[a-zA-Z0-9_-]+\.mjs$/.test(entry.name)).map(entry=>'lib/'+entry.name).sort();
 if(!modules.includes('lib/permission-policy.mjs')||!modules.includes('lib/claude-models.mjs'))throw new Error('В приложении неполный комплект подключения. Обнови само приложение.');
 return [...modules,'bridge.mjs','install-integration.mjs'];
}
async function checkModules(node,root){
 const modules=['voice-device','skill-sync','mcp-sync','providers','conversation','native-sessions','memory','workspace'];
 const code='const {pathToFileURL}=await import("node:url");const path=await import("node:path");await Promise.all('+JSON.stringify(modules)+'.map(name=>import(pathToFileURL(path.join(process.cwd(),"lib",name+".mjs")))))';
 try{await exec(node,['--input-type=module','-e',code],{cwd:root,timeout:15000,maxBuffer:65536});}
 catch(error){const text=String(error.stderr||error.message||'');const missing=text.match(/(?:Cannot find module|does not provide an export named)[^\n]{0,500}/)?.[0];const name=missing?.match(/([a-zA-Z0-9_-]+\.mjs)/)?.[1];throw new Error(name?'В подключении не загрузился модуль '+name+'. Прежняя версия будет восстановлена.':'Компоненты подключения несовместимы с установленным запуском. Прежняя версия будет восстановлена.');}
}
async function startupProblem(root){
 for(const name of ['connect-error.log','connect.log']){
  try{const target=path.join(root,name),st=await fs.lstat(target);if(!st.isFile()||st.isSymbolicLink())continue;const handle=await fs.open(target,'r');let bytes;try{const stat=await handle.stat();bytes=Buffer.alloc(Math.min(stat.size,16384));await handle.read(bytes,0,bytes.length,Math.max(0,stat.size-bytes.length));}finally{await handle.close()}
   const text=bytes.toString('utf8');const missing=text.match(/Cannot find (?:module|package) ['"]([^'"]+)['"]/g)?.at(-1);if(missing){const file=missing.match(/['"]([^'"]+)['"]/)?.[1]||'';return 'Не найден компонент '+path.basename(file).slice(0,80)+'.';}
   if(/SyntaxError/.test(text))return 'Фоновый запуск сообщил об ошибке совместимости программы.';
  }catch{}
 }
 return 'Подключение к серверу не подтвердилось за 60 секунд.';
}
const journalNames=['running-jobs.json','pending-results.json'];
const meaningfulId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{7,239}$/.test(value)&&!['constructor','prototype','__proto__'].includes(value);
const plainRecord=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
const MAX_LOCAL_JOURNAL_BYTES=2*1024*1024*1024;
const journalProjectionCache=new Map();
const journalIdentity=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
const journalDamage=()=>new Error('Журнал подключения повреждён.');
const projectedFields=new Set(['runId','chatId','projectId','provider','text','type','workspaceReady','finalization','events','before']);
const projectedStrings=new Set(['runId','chatId','projectId','provider','type']);
const stringSpecial=/["\\\u0000-\u001f]/;

// Validate the entire JSON stream, but retain only the small eligibility
// projection. Tool results, message text, inventories and event payloads never
// become large strings/objects in the updater process.
class JournalProjection{
 constructor(){this.frames=[];this.value=null;this.started=false;this.complete=false;this.token=null;}
 top(){return this.frames.at(-1);}
 assign(type,value){
  const frame=this.top();if(!frame||!['value','valueOrEnd'].includes(frame.state))throw journalDamage();
  if(frame.context==='root'){
   if(!Object.hasOwn(frame.value,frame.key)&&Object.keys(frame.value).length>=256)throw new Error('В журнале слишком много незавершённых результатов. Обновление требует отдельной проверки.');frame.value[frame.key]=value;
  }else if(frame.context==='record'&&projectedFields.has(frame.key))frame.value[frame.key]=value;
  else if(frame.context==='finalization'&&frame.key==='nativeFinished')frame.value.nativeFinished=value;
  frame.state='commaOrEnd';
 }
 open(kind){
  const parent=this.top();let context=null,value=kind==='array'?[]:{};
  if(!this.started){if(kind!=='object')throw journalDamage();this.started=true;context='root';value=Object.create(null);this.value=value;}
  else{if(parent?.context==='root'&&kind==='object')context='record';else if(parent?.context==='record'&&parent.key==='finalization'&&kind==='object')context='finalization';this.assign(kind,value);}
  if(this.frames.length>=4096)throw journalDamage();this.frames.push({kind,context,value:context?value:null,state:kind==='object'?'keyOrEnd':'valueOrEnd',key:null});
 }
 close(kind){const frame=this.top();if(!frame||frame.kind!==kind||!(frame.state==='commaOrEnd'||frame.state===(kind==='object'?'keyOrEnd':'valueOrEnd')))throw journalDamage();this.frames.pop();if(!this.frames.length)this.complete=true;}
 startString(key){
  const frame=this.top(),capture=key?Boolean(frame.context):frame.context==='record'&&projectedStrings.has(frame.key);
  this.token={kind:'string',key,capture,value:'',overflow:false,limit:key&&frame.context==='root'?240:256,escape:false,unicode:0,code:0};
 }
 append(char){const token=this.token;if(!token.capture)return;if(token.value.length+char.length>token.limit){if(token.key&&this.top().context==='root')throw journalDamage();token.capture=false;token.overflow=true;token.value='';return;}token.value+=char;}
 endString(){
  const token=this.token;this.token=null;
  if(token.key){const frame=this.top();frame.key=token.capture&&!token.overflow?token.value:null;if(frame.context==='root'&&!meaningfulId(frame.key))throw journalDamage();frame.state='colon';}
  else this.assign('string',token.capture?token.value:'');
 }
 endNumber(){if(!['zero','int','fraction','exponentDigits'].includes(this.token.state))throw journalDamage();this.token=null;this.assign('number',0);}
 feed(text){
  for(let index=0;index<text.length;){const char=text[index],token=this.token;
   if(token?.kind==='string'){
    if(!token.capture&&!token.escape&&!token.unicode){const next=text.slice(index).search(stringSpecial);if(next<0){index=text.length;continue;}if(next>0){index+=next;continue;}}
    index++;
    if(token.unicode){if(!/^[0-9a-fA-F]$/.test(char))throw journalDamage();token.code=token.code*16+parseInt(char,16);if(!--token.unicode)this.append(String.fromCharCode(token.code));continue;}
    if(token.escape){token.escape=false;if(char==='u'){token.unicode=4;token.code=0;}else{const escapes={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};if(!Object.hasOwn(escapes,char))throw journalDamage();this.append(escapes[char]);}continue;}
    if(char==='"'){this.endString();continue;}if(char==='\\'){token.escape=true;continue;}if(char.charCodeAt(0)<32)throw journalDamage();this.append(char);continue;
   }
   if(token?.kind==='literal'){
    if(char!==token.expected[token.index++])throw journalDamage();index++;if(token.index===token.expected.length){this.token=null;this.assign(token.expected==='null'?'null':'boolean',token.expected==='true'?true:token.expected==='false'?false:null);}continue;
   }
   if(token?.kind==='number'){
    const digit=char>='0'&&char<='9';let consumed=true;
    if(token.state==='minus'){if(!digit)throw journalDamage();token.state=char==='0'?'zero':'int';}
    else if(token.state==='zero'){if(digit)throw journalDamage();if(char==='.')token.state='dot';else if(char==='e'||char==='E')token.state='exponent';else consumed=false;}
    else if(token.state==='int'){if(digit){}else if(char==='.')token.state='dot';else if(char==='e'||char==='E')token.state='exponent';else consumed=false;}
    else if(token.state==='dot'){if(!digit)throw journalDamage();token.state='fraction';}
    else if(token.state==='fraction'){if(digit){}else if(char==='e'||char==='E')token.state='exponent';else consumed=false;}
    else if(token.state==='exponent'){if(char==='+'||char==='-')token.state='exponentSign';else if(digit)token.state='exponentDigits';else throw journalDamage();}
    else if(token.state==='exponentSign'){if(!digit)throw journalDamage();token.state='exponentDigits';}
    else if(token.state==='exponentDigits'){if(!digit)consumed=false;}
    if(consumed)index++;else this.endNumber();continue;
   }
   if(char===' '||char==='\t'||char==='\r'||char==='\n'){index++;continue;}if(this.complete)throw journalDamage();
   const frame=this.top();
   if(!this.started){if(char!=='{')throw journalDamage();this.open('object');index++;continue;}
   if(frame.kind==='object'&&['keyOrEnd','key'].includes(frame.state)){if(char==='}'&&frame.state==='keyOrEnd')this.close('object');else if(char==='"')this.startString(true);else throw journalDamage();index++;continue;}
   if(frame.state==='colon'){if(char!==':')throw journalDamage();frame.state='value';index++;continue;}
   if(frame.state==='commaOrEnd'){if(char===',')frame.state=frame.kind==='object'?'key':'value';else if(char===(frame.kind==='object'?'}':']'))this.close(frame.kind);else throw journalDamage();index++;continue;}
   if(!['value','valueOrEnd'].includes(frame.state))throw journalDamage();
   if(char===']'&&frame.kind==='array'&&frame.state==='valueOrEnd')this.close('array');
   else if(char==='{')this.open('object');else if(char==='[')this.open('array');else if(char==='"')this.startString(false);
   else if(char==='t'||char==='f'||char==='n')this.token={kind:'literal',expected:char==='t'?'true':char==='f'?'false':'null',index:1};
   else if(char==='-'||char>='0'&&char<='9')this.token={kind:'number',state:char==='-'?'minus':char==='0'?'zero':'int'};
   else throw journalDamage();index++;
  }
 }
 end(){if(this.token?.kind==='number')this.endNumber();if(this.token||!this.complete||this.frames.length)throw journalDamage();return this.value;}
}

async function projectedStateFile(root,name){
 if(!journalNames.includes(name))throw journalDamage();if(await fs.realpath(root)!==root)throw new Error('Папка подключения является ссылкой.');const filename=path.join(root,name);let handle;
 try{
  handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);const before=await handle.stat({bigint:true});
  if(!before.isFile()||before.nlink!==1n||before.size<0n||before.size>BigInt(MAX_LOCAL_JOURNAL_BYTES))throw journalDamage();
  const identity=journalIdentity(before),cached=journalProjectionCache.get(filename);let value,hash;
  if(cached?.identity===identity){value=structuredClone(cached.value);hash=cached.hash;}
  else{
   const projection=new JournalProjection(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}),digest=crypto.createHash('sha256'),bytes=Buffer.alloc(65536);let offset=0;
   while(offset<Number(before.size)){const {bytesRead}=await handle.read(bytes,0,Math.min(bytes.length,Number(before.size)-offset),offset);if(!bytesRead)throw new Error('Состояние подключения изменилось. Повтори обновление.');const chunk=bytes.subarray(0,bytesRead);digest.update(chunk);projection.feed(decoder.decode(chunk,{stream:true}));offset+=bytesRead;}
   projection.feed(decoder.decode());value=projection.end();hash=digest.digest('hex');
  }
  const after=await handle.stat({bigint:true}),current=await fs.lstat(filename,{bigint:true});
  if(!current.isFile()||current.isSymbolicLink()||after.nlink!==1n||current.nlink!==1n||journalIdentity(after)!==identity||journalIdentity(current)!==identity||await fs.realpath(root)!==root)throw new Error('Состояние подключения изменилось. Повтори обновление.');
  if(cached?.identity!==identity){journalProjectionCache.delete(filename);journalProjectionCache.set(filename,{identity,hash,value:structuredClone(value)});while(journalProjectionCache.size>64)journalProjectionCache.delete(journalProjectionCache.keys().next().value);}
  return {name,exists:true,size:Number(before.size),hash,value};
 }catch(error){if(error.code==='ENOENT'&&!handle){journalProjectionCache.delete(filename);return {name,exists:false,size:0,hash:null,value:{}};}throw error;}
 finally{await handle?.close();}
}
// Open only the exact generated state files. A descriptor bound and a second
// inode/stat check prevent symlinks, growing files and atomic replacement races
// from turning an eligibility check into an unbounded or stale read.
async function boundedStateFile(root,name,maximum){
 if(![...journalNames,'connection-status.json'].includes(name))throw new Error('Недопустимый файл состояния подключения.');
 if(await fs.realpath(root)!==root)throw new Error('Папка подключения является ссылкой.');
 const filename=path.join(root,name);let handle;
 try{
  handle=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  const before=await handle.stat();
  if(!before.isFile()||before.nlink!==1||!Number.isSafeInteger(before.size)||before.size>maximum)throw new Error('Журнал подключения повреждён.');
  const bytes=Buffer.alloc(before.size);let offset=0;
  while(offset<bytes.length){const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);if(!bytesRead)throw new Error('Состояние подключения изменилось. Повтори обновление.');offset+=bytesRead;}
  const after=await handle.stat(),current=await fs.lstat(filename);
  if(!current.isFile()||current.isSymbolicLink()||after.nlink!==1||current.nlink!==1||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||after.dev!==current.dev||after.ino!==current.ino||after.size!==current.size||after.mtimeMs!==current.mtimeMs||await fs.realpath(root)!==root)throw new Error('Состояние подключения изменилось. Повтори обновление.');
  const value=JSON.parse(bytes.toString('utf8'));if(!plainRecord(value))throw new Error('Журнал подключения повреждён.');
  return {name,bytes,value};
 }catch(error){if(error.code==='ENOENT'&&!handle)return {name,bytes:null,value:{}};throw error;}
 finally{await handle?.close();}
}
export async function readConnectionDiagnostics(root){
 const {bytes,value}=await boundedStateFile(root,'connection-status.json',32768);
 if(!bytes)return null;
 return {at:String(value.at||''),state:Number(value.state),connectorVersion:String(value.connectorVersion||'').slice(0,30),loginBusy:Boolean(value.loginBusy)};
}
export async function readConnectorUpdateState(root,{allowSavedResults=false}={}){
 const documents=await Promise.all(journalNames.map(name=>projectedStateFile(root,name)));
 const [running,pending]=documents.map(document=>Object.entries(document.value));
 const runIds=new Set();let savedOnly=true;
 for(const [id,record]of [...running,...pending]){
  if(!meaningfulId(id)||!plainRecord(record)||record.runId!==id||!meaningfulId(record.chatId)||!meaningfulId(record.projectId)||!['claude','codex'].includes(record.provider)||typeof record.text!=='string')throw new Error('Журнал подключения повреждён.');
  runIds.add(id);
 }
 if(runIds.size>256)throw new Error('В журнале слишком много незавершённых результатов. Обновление требует отдельной проверки.');
 for(const [,record]of running)if(typeof record.workspaceReady!=='boolean'||record.finalization?.nativeFinished!==true||!Array.isArray(record.events)||!Array.isArray(record.before))savedOnly=false;
 for(const [,record]of pending)if(record.type!=='turn-result')throw new Error('Очередь результатов подключения повреждена.');
 const idle=!running.length&&!pending.length;
 return {running:running.length,pending:pending.length,idle,savedOnly:!idle&&savedOnly,canUpdate:idle||allowSavedResults&&savedOnly,runIds:[...runIds].sort(),documents};
}
async function requireUpdateState(root,{allowSavedResults=false,runIds=null}={}){
 const state=await readConnectorUpdateState(root,{allowSavedResults}),status=await readConnectionDiagnostics(root);
 if(status?.loginBusy)throw new Error('Дождись завершения входа в подписку на этом Mac.');
 if(!state.canUpdate)throw new Error('Дождись завершения задач на этом Mac. Обновление не прерывает работающую модель.');
 if(runIds&&state.runIds.some(id=>!runIds.includes(id)))throw new Error('На Mac появилась другая задача. Обновление отложено; файлы не изменены.');
 return state;
}
async function unchangedJournals(root,preserved){
 const current=await readConnectorUpdateState(root,{allowSavedResults:true});
 if(current.documents.some((document,index)=>{const saved=preserved.documents[index];return document.exists!==saved.exists||document.size!==saved.size||document.hash!==saved.hash;}))throw new Error('Журнал изменился после остановки подключения. Программа будет восстановлена; результаты сохранены.');
}
async function waitProgramStopped(root){
 const deadline=Date.now()+20000;
 while(true){
  const processes=(await exec('/bin/ps',['-axo','command='],{timeout:5000,maxBuffer:8*1024*1024})).stdout;
  if(!processes.split('\n').some(line=>line.includes(path.join(root,'bridge.mjs'))))return;
  if(Date.now()>=deadline)throw new Error('Прежнее подключение ещё завершается. Файлы программы не заменены.');
  await pause(100);
 }
}
async function atomic(file,bytes){const temp=file+'.'+crypto.randomUUID()+'.tmp';try{await fs.writeFile(temp,bytes,{mode:0o600,flag:'wx'});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}}
export async function updateImport(entry,{managedBase,bundledConnect,event,allowSavedResults=false}){
 if(process.platform!=='darwin'||!entry.agent?.plist||!/^io\.teamroom\.community\.connect(?:\.[A-Za-z0-9-]{16,80})?$/.test(entry.agent.label))throw new Error('Для этого подключения обновление из окна недоступно. Нужна проверка его установки; новое подключение не создавалось.');
 const storage=await storageModule(),configured=await storage.resolveConfiguredDeviceRoot(entry.config.deviceId);
 const root=await fs.realpath(entry.root);if(root!==entry.root)throw new Error('Папка подключения является ссылкой.');
 const requireStorage=async()=>{if(configured.configured){const current=await storage.resolveConfiguredDeviceRoot(entry.config.deviceId);if(current.root!==root||current.location.volumeUuid!==configured.location.volumeUuid)throw new Error('Папка внешнего диска изменилась. Повтори обновление подключения.');}};
 const plist=JSON.parse((await exec('/usr/bin/plutil',['-convert','json','-o','-',entry.agent.plist],{timeout:5000,maxBuffer:65536})).stdout);
 const args=plist.ProgramArguments;
 const managedRoot=configured.configured?configured.root:path.join(managedBase,entry.config.deviceId);
 const managed=entry.root===managedRoot&&args?.[1]===path.join(root,'bridge.mjs')&&entry.agent.label==='io.teamroom.community.connect.'+entry.config.deviceId;
 const legacy=!configured.configured&&entry.agent.label==='io.teamroom.community.connect'&&typeof args?.[1]==='string'&&path.basename(args[1])==='desktop-connect.mjs'&&root===path.join(path.dirname(args[1]),'storage','connect-local');
 if(plist.Label!==entry.agent.label||!Array.isArray(args)||!(managed||legacy)||typeof args[0]!=='string'||!path.isAbsolute(args[0]))throw new Error('Существующий автозапуск имеет другую конфигурацию. Обновление отменено.');
 if(legacy){const wrapper=await fs.lstat(args[1]);if(!wrapper.isFile()||wrapper.isSymbolicLink()||await fs.realpath(args[1])!==args[1])throw new Error('Прежний запуск является ссылкой. Обновление отменено.');}

 const initialState=await requireUpdateState(root,{allowSavedResults});
 const expectedVersion=(await fs.readFile(path.join(bundledConnect,'bridge.mjs'),'utf8')).match(/^const connectorVersion='(\d+\.\d+\.\d+)';$/m)?.[1];
 if(!expectedVersion)throw new Error('В приложении не найдена версия подключения. Обнови само приложение.');
 const filenames=await programFiles(bundledConnect);
 const replacements=new Map(),originals=new Map();
 for(const name of filenames){const file=path.join(root,name);if(await fs.realpath(path.dirname(file))!==path.dirname(file))throw new Error('Папка программы является ссылкой.');try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Файл программы является ссылкой.');originals.set(name,await fs.readFile(file));}catch(error){if(error.code!=='ENOENT')throw error;originals.set(name,null);}replacements.set(name,await fs.readFile(path.join(bundledConnect,name)));}
 if(entry.diagnostics?.connectorVersion===expectedVersion&&entry.connected&&[...replacements].every(([name,bytes])=>originals.get(name)&&bytes.equals(originals.get(name)))){await exec(args[0],[path.join(root,'install-integration.mjs')],{cwd:root,timeout:15000,maxBuffer:65536});return {message:'Подключение уже обновлено. Режимы разрешений и команды переноса готовы.'};}
 await requireStorage();await pruneProgramBackups(root);
 await requireUpdateSpace(root,[...originals.values(),...replacements.values()].reduce((total,bytes)=>total+(bytes?.length||0),0));
 async function hub(method,input){const response=await fetch(HUB+'/api/device-import-maintenance',{method,headers:{Authorization:'Bearer '+entry.config.token,'content-type':'application/json'},body:JSON.stringify(input),redirect:'error',signal:AbortSignal.timeout(15000)});let data;try{data=await response.json()}catch{throw new Error('Сервер пока не подтвердил безопасное обновление.')}if(!response.ok)throw new Error(data.error||'Сервер не разрешил обновление занятого Mac.');return data;}
 event('import-update',{message:initialState.savedOnly?'Проверяю безопасное восстановление сохранённых результатов…':'Проверяю, что этот Mac свободен…'});
 const lease=await hub('POST',initialState.savedOnly?{savedResults:true,runIds:initialState.runIds}:{});let stopped=false,changed=false,success=false,backup;
 try{
  await requireUpdateState(root,{allowSavedResults:initialState.savedOnly,runIds:initialState.runIds});
  await requireStorage();backup=path.join(root,'import-update-backups',Date.now()+'-'+crypto.randomUUID());await fs.mkdir(backup,{recursive:true,mode:0o700});
  for(const [name,bytes]of originals){if(bytes===null)continue;await requireStorage();const target=path.join(backup,name);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,bytes,{mode:0o600,flag:'wx'});}
  event('import-update',{message:initialState.savedOnly?'Обновляю программу для восстановления результатов. История и рабочие файлы сохранены…':'Обновляю подключение, перенос и режимы разрешений…'});
  // The lease prevents new hub work. Recheck immediately before shutdown as
  // well: preparing work and native calls are never eligible for replacement.
  await requireUpdateState(root,{allowSavedResults:initialState.savedOnly,runIds:initialState.runIds});
  await exec('/bin/launchctl',['bootout','gui/'+process.getuid()+'/'+entry.agent.label],{timeout:15000,maxBuffer:65536});stopped=true;
  // Use the actual program path, not a potentially stale PID discovered before
  // the lease. This also waits for the legacy launcher's connector child.
  await waitProgramStopped(root);
  // The service has finished its durable shutdown. Preserve an exact-byte hash
  // and size proof; program replacement and rollback never write journals.
  const preserved=await requireUpdateState(root,{allowSavedResults:initialState.savedOnly,runIds:initialState.runIds});
  changed=true;for(const [name,bytes]of replacements){await requireStorage();await atomic(path.join(root,name),bytes);}
  await exec(args[0],['--check',path.join(root,'bridge.mjs')],{timeout:10000,maxBuffer:65536});await exec(args[0],['--check',path.join(root,'lib/native-sessions.mjs')],{timeout:10000,maxBuffer:65536});
  await checkModules(args[0],root);
  await unchangedJournals(root,preserved);
  await requireStorage();const restartAt=Date.now();await exec('/bin/launchctl',['bootstrap','gui/'+process.getuid(),entry.agent.plist],{timeout:15000,maxBuffer:65536});stopped=false;
  // Wait for the restarted program to publish its version before releasing the lease.
  let ready=false;for(let attempt=0;attempt<120;attempt++){if(attempt&&attempt%30===0)event('import-update',{message:'Ожидаю подтверждение запуска подключения…'});try{const d=JSON.parse(await fs.readFile(path.join(root,'connection-status.json'),'utf8'));if(d.connectorVersion===expectedVersion&&Date.parse(d.at)>=restartAt&&d.state===1){ready=true;break}}catch{}await pause(500);}
  if(!ready)throw new Error(await startupProblem(root)+' Обновление не подтверждено; восстанавливаю прежнюю версию.');
  success=true;
  await requireStorage();await pruneProgramBackups(root).catch(()=>{});
  try{await exec(args[0],[path.join(root,'install-integration.mjs')],{cwd:root,timeout:15000,maxBuffer:65536});}catch{return {message:'Перенос обновлён. Команды /teamroom и $teamroom требуют отдельной проверки.'};}
  return {message:initialState.savedOnly?'Подключение обновлено. Сохранённые результаты восстанавливаются автоматически; повторный запрос модели не запускается.':'Подключение обновлено. Дополнения передаются прямо в текущую работу Claude и Codex. Крупные проекты переносятся частями.'};
 }catch(error){
  if(changed&&!success){try{if(!stopped){await exec('/bin/launchctl',['bootout','gui/'+process.getuid()+'/'+entry.agent.label],{timeout:15000,maxBuffer:65536});stopped=true;}await waitProgramStopped(root);for(const [name,bytes]of originals){await requireStorage();if(bytes===null)await fs.rm(path.join(root,name),{force:true});else await atomic(path.join(root,name),bytes);}}catch{throw new Error('Обновление не завершено. Резервная копия программы сохранена; нужно восстановление подключения.');}}
  if(backup&&!changed)await requireStorage().then(()=>fs.rm(backup,{recursive:true,force:true})).catch(()=>{});
  throw updateSpaceError(error);
 }finally{
  if(stopped)try{await exec('/bin/launchctl',['bootstrap','gui/'+process.getuid(),entry.agent.plist],{timeout:15000,maxBuffer:65536});}catch{event('import-update',{message:'Автозапуск не подтвердился. Открой «Включить существующее подключение».'});}
  try{await hub('DELETE',{leaseId:lease.leaseId});}catch{event('import-update',{message:'Сервер временно удерживает обновление этого Mac. Ограничение снимется автоматически в течение 10 минут.'});}
 }
}
