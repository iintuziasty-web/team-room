import {RunProcesses,pruneOwners} from './lib/run-processes.mjs';
import {UnknownResults,parkResult} from './lib/orphaned-results.mjs';
import {staleEntries,parkDirectory} from './lib/transfer-sweeper.mjs';
import {applyAgentEvent,finishAgents,validAgentId} from './lib/agent-progress.mjs';
import {VoiceDevice} from './lib/voice-device.mjs';
import fs from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {IncomingResults,OutgoingResults} from './lib/result-transfer.mjs';
import {OutgoingResultEnvelopes,resultEnvelopeRequired} from './lib/result-envelope.mjs';
import {createDurableJsonSaver,RetryFinalizer,syncDirectory,writeDurableJson} from './lib/durable-json.mjs';
import {readStorageLocationMarker,registerStorageGuard,assertStorageForPath} from './lib/external-storage.mjs';
import {CheckpointState,checkpointContentKey} from './lib/checkpoint-state.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {WebSocket} from 'ws';
import {SkillDevice,SkillDiscovery} from './lib/skill-sync.mjs';
import {McpDevice,discoverMcp} from './lib/mcp-sync.mjs';
import {Providers} from './lib/providers.mjs';
import {executionMode} from './lib/permission-policy.mjs';
import {ProviderAccounts} from './lib/provider-accounts.mjs';
import {continueConversation,sessionKey} from './lib/conversation.mjs';
import {NativeSessions} from './lib/native-sessions.mjs';
import {readAgentNotes} from './lib/memory.mjs';
import {applySnapshot,applyStagedSnapshot,stageFileBatch,internalDirectory,snapshot,inspectWorkspaceFiles,changes,readFileBatch,MAX_WORKSPACE_FILES,MAX_TRANSFER,atomicProjectWrite,validateFileInventory,isIgnoredPortablePath,reuseWorkspaceFiles} from './lib/workspace.mjs';
import {applyWorkspaceCleanup} from './lib/workspace-cleanup.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const storageLocation=await readStorageLocationMarker(root,{optional:true});
if(storageLocation)registerStorageGuard(root,storageLocation);
await assertStorageForPath(root);
const config=JSON.parse(await fs.readFile(path.join(root,'device-config.json'),'utf8'));
if(storageLocation&&storageLocation.deviceId!==config.deviceId)throw new Error('Настройки внешнего диска относятся к другому подключению Team Room.');
let workspaceRoot=root;
if(storageLocation){
 try{
  const alias=await fs.lstat(storageLocation.originalRoot);
  if(alias.isSymbolicLink()){
   await assertStorageForPath(storageLocation.originalRoot);workspaceRoot=storageLocation.originalRoot;
  }
 }catch(error){if(error.code!=='ENOENT')throw error;}
}
// A full disk once made Connect die on its first write and relaunch every few
// seconds. Wait before touching anything so the relaunch loop stays quiet.
try{const s=await fs.statfs(root),free=Number(s.bavail)*Number(s.bsize);if(free<64*1024*1024){console.error(new Date().toISOString(),`Диск почти заполнен (свободно ${Math.round(free/1048576)} МБ). Освободи место; повторная попытка запуска через 60 с.`);await new Promise(resolve=>setTimeout(resolve,60000));}}catch{}
const url=new URL('/bridge',config.hubUrl);url.protocol=url.protocol==='https:'?'wss:':'ws:';
const voice=new VoiceDevice(root);
const providers=new Providers();const accounts=await new ProviderAccounts(root,providers).init();const mcp=await new McpDevice(root).init();providers.mcp=mcp;const skills=await new SkillDevice(root,{loadBlob:async hash=>{const response=await fetch(new URL('/api/skills/blobs/'+hash,config.hubUrl),{headers:{Authorization:'Bearer '+config.token},redirect:'error',signal:AbortSignal.timeout(45000)});if(!response.ok)throw new Error('Не удалось загрузить файл скилла.');const length=Number(response.headers.get('content-length'));if(length>16*1024*1024)throw new Error('Файл скилла слишком большой.');const parts=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>16*1024*1024)throw new Error('Файл скилла слишком большой.');parts.push(Buffer.from(chunk));}return Buffer.concat(parts);}}).init();providers.skills=skills;const skillDiscovery=new SkillDiscovery({workspaceRoot:root,codexList:()=>providers.skillList()});const nativeSessions=new NativeSessions(providers);let ws,retry=1000,closing=false,lastReceived=Date.now(),lastHealthTick=Date.now(),probeUntil=0,reconnectTimer,statusBusy=false,pendingStatusForce=false,lastStatus=0,keepAwakeProcess,lastDiagnosticSave=0;
const connectorVersion='0.4.57';
const connectorInstanceId=crypto.randomUUID();
const outgoingResults=new OutgoingResults(path.join(root,'.result-transfers'));
const outgoingResultEnvelopes=new OutgoingResultEnvelopes(path.join(root,'.result-envelope-transfers'));
const incomingWorkspaces=new IncomingResults(path.join(root,'.inbound-transfers'));
const resultDeliveries=new Map(),hubRequests=new Map(),resultProgress=new Map();
const transferStages=new Map();
async function transferDirectory(runId){if(!/^[a-zA-Z0-9_-]{1,240}$/.test(runId||''))throw new Error('Недопустимый запуск передачи.');return internalDirectory(root,'.file-transfers',runId);}
function workspaceFor(projectId,chatId){if(!/^[a-zA-Z0-9_-]{1,240}$/.test(projectId||'')||chatId!==undefined&&!/^[a-zA-Z0-9_-]{1,240}$/.test(chatId||''))throw new Error('Недопустимый проект или чат.');return chatId?path.join(workspaceRoot,'session-workspaces',projectId,chatId):path.join(workspaceRoot,'workspaces',projectId);}
const workFor=msg=>workspaceFor(msg.project.id,msg.options?.workspaceMode==='chat-v1'?msg.chat.id:undefined);
const log=(...values)=>console.log(new Date().toISOString(),...values);
// Disk pressure is reported in heartbeats and diagnostics, never fatal.
const LOW_DISK_BYTES=512*1024*1024;let lastDisk=null,lowDiskSince=0;
async function checkDisk(){
 try{const s=await fs.statfs(root);lastDisk={free:Number(s.bavail)*Number(s.bsize),total:Number(s.blocks)*Number(s.bsize),at:Date.now()};}catch{return lastDisk;}
 if(lastDisk.free<LOW_DISK_BYTES){if(!lowDiskSince){lowDiskSince=Date.now();log(`Мало места на диске: свободно ${Math.round(lastDisk.free/1048576)} МБ. Освободи место, иначе результаты и журналы не сохранятся.`);}}
 else if(lowDiskSince){lowDiskSince=0;log('Место на диске снова доступно.');}
 return lastDisk;
}
let connectionReason='starting';
let storageError=null,storageMonitorBusy=false;
async function ensureStorage(){
 try{await assertStorageForPath(root);if(workspaceRoot!==root)await assertStorageForPath(workspaceRoot);if(storageError){storageError=null;connectionReason=ws?.readyState===WebSocket.OPEN?'connected':'starting';log('Внешний диск Team Room снова доступен.');}}
 catch(error){
  const unavailable=['EXTERNAL_STORAGE_UNAVAILABLE','INVALID_EXTERNAL_STORAGE_CONFIG'].includes(error.code);
  if(unavailable){
   if(!storageError)log('Работа приостановлена:',error.message);
   storageError=error;connectionReason='external-storage-unavailable';
   for(const job of jobs.values())job.controller.abort(error);
   voice.close();accounts.close();
  }
  throw error;
 }
}
async function monitorStorage(){
 if(!storageLocation||storageMonitorBusy||closing)return;storageMonitorBusy=true;
 try{await ensureStorage();}catch{}finally{storageMonitorBusy=false;}
}
const storageCommands=new Set(['run','skills-sync','skills-export','skills-scan','mcp-sync','mcp-scan','voice-status','voice-prepare','voice-transcribe','catalog','workspace-status','workspace-transfer-status','workspace-file-chunk','workspace-file-batch','workspace-stage','native-list','native-read','memory','steer','approval','accounts','login','result-ack']);
function updateKeepAwake(){
 if(process.platform!=='darwin')return;
 if((jobs.size||Object.keys(journal).length||Object.keys(outbox).length||transferStages.size||voice.busy||voice.preparing)&&!keepAwakeProcess){const child=spawn('/usr/bin/caffeinate',['-i','-w',String(process.pid)],{stdio:'ignore'});keepAwakeProcess=child;child.on('error',error=>{log('Защита от автоматического сна:',error.message);if(keepAwakeProcess===child)keepAwakeProcess=null;});child.on('exit',()=>{if(keepAwakeProcess===child)keepAwakeProcess=null;});}
 else if(!jobs.size&&!Object.keys(journal).length&&!Object.keys(outbox).length&&!transferStages.size&&!voice.busy&&!voice.preparing&&keepAwakeProcess){const child=keepAwakeProcess;keepAwakeProcess=null;child.kill();}
}
function heartbeatState(){return {type:'heartbeat',protocolVersion:6,permissionsVersion:1,executionModeVersion:1,accountsVersion:1,runRecoveryVersion:1,loginBusy:accounts.logins.size>0,connectorVersion,workspaceFileLimit:MAX_WORKSPACE_FILES,fileTransferVersion:1,resultEnvelopeVersion:1,largeFilesVersion:1,workspaceBatchVersion:1,agentMonitorVersion:1,liveInputVersion:1,approvalAckVersion:1,voiceVersion:1,mcpSyncVersion:1,mcpRevision:mcp.revision,skillsSyncVersion:1,skillsRevision:skills.revision,diskFreeBytes:lastDisk?.free??null,diskLow:lowDiskSince>0,running:[...new Set([...jobs.keys(),...Object.keys(journal)])],results:Object.keys(outbox),resultTransfers:[...resultProgress.values()].map(({runId,bytes,total,error,retryAt})=>({runId,bytes,total,...(error?{error,retryAt}:{})})),connectionReason};}
let connectionDiagnostic;
const saveConnectionDiagnostic=atomicSaver(path.join(root,'connection-status.json'),()=>connectionDiagnostic);
function saveDiagnostics(force=false){if(!force&&Date.now()-lastDiagnosticSave<30000)return;lastDiagnosticSave=Date.now();connectionDiagnostic={at:new Date().toISOString(),connectorVersion,executionModeVersion:1,runRecoveryVersion:1,loginBusy:accounts.logins.size>0,fileTransferVersion:1,largeFilesVersion:1,agentMonitorVersion:1,liveInputVersion:1,approvalAckVersion:1,state:ws?.readyState,lastReceivedAt:new Date(lastReceived).toISOString(),reason:connectionReason,running:jobs.size,pendingResults:Object.keys(outbox).length,diskFreeBytes:lastDisk?.free??null,diskLow:lowDiskSince>0};void saveConnectionDiagnostic();}
async function cleanTransferStages(){
 const base=await internalDirectory(root,'.file-transfers');
 for(const entry of await fs.readdir(base,{withFileTypes:true})){
  if(!entry.isDirectory()||entry.isSymbolicLink()||!/^[a-zA-Z0-9_-]{1,240}$/.test(entry.name)||jobs.has(entry.name)||transferStages.has(entry.name))continue;
  const full=path.join(base,entry.name),stat=await fs.lstat(full);if(stat.mtimeMs<Date.now()-86400000)await fs.rm(full,{recursive:true,force:true});
 }
}
const processOwnersPath=path.join(root,'process-owners.json');let processOwners={};
try{processOwners=JSON.parse(await fs.readFile(processOwnersPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('Журнал процессов повреждён; восстанови process-owners.json из резервной копии.');}
const saveProcessOwners=atomicSaver(processOwnersPath,()=>processOwners);
// Owners of finished processes are useless once their PID is gone; keep the journal small and current.
if(process.platform!=='win32')try{const pruned=await pruneOwners(processOwners);if(JSON.stringify(pruned)!==JSON.stringify(processOwners)){processOwners=pruned;await saveProcessOwners();}}catch(error){log('Журнал процессов не очищен:',error.message);}
const jobs=new Map();const jobJournalPath=path.join(root,'running-jobs.json');let journal;try{journal=JSON.parse(await fs.readFile(jobJournalPath,'utf8'))}catch(error){if(error.code!=='ENOENT')throw new Error('Журнал работы повреждён. Файлы сохранены; восстанови running-jobs.json из резервной копии.');journal={}}
// Serialize the latest state once per disk write. Callers still await their own
// revision; slow storage cannot build a queue of obsolete, full journal copies.
function atomicSaver(filename,readState){
 return createDurableJsonSaver(filename,readState,{write:async(file,bytes)=>{await assertStorageForPath(path.dirname(file));await writeDurableJson(file,bytes);},onError:error=>log('Сохранение состояния подключения:',error.message)});
}
const saveJournal=atomicSaver(jobJournalPath,()=>journal);
void cleanTransferStages().catch(()=>{});const transferCleanup=setInterval(()=>void cleanTransferStages().catch(()=>{}),3600000);transferCleanup.unref();
void checkDisk().catch(()=>{});const diskCheck=setInterval(()=>void checkDisk().catch(()=>{}),300000);diskCheck.unref();
const outboxPath=path.join(root,'pending-results.json');let outbox;try{outbox=JSON.parse(await fs.readFile(outboxPath,'utf8'))}catch(error){if(error.code!=='ENOENT')throw new Error('Очередь результатов повреждена. Файлы сохранены; восстанови pending-results.json из резервной копии.');outbox={}}
// RAM entries are not delivery authority. Both the outbox and removal from the
// running journal must be durable before a hub can acknowledge/clean the spool.
const readyResults=new Set(Object.keys(outbox).filter(runId=>!journal[runId]));
const resultAcknowledgements=new Map();
const save=atomicSaver(outboxPath,()=>outbox);
const unknownResults=new UnknownResults();
// Inbound staging of runs that never executed (aborted before dispatch, bridge
// crash) only holds copies of hub files: delete after seven days. Result spools
// without an outbox entry are leftovers of acknowledged results: park, never delete.
async function sweepStaleTransfers(){
 const week=7*86400000;
 for(const entry of await staleEntries(path.join(root,'.inbound-transfers'),{maxAgeMs:week,keep:name=>jobs.has(name)||Object.hasOwn(journal,name)||transferStages.has(name)}))await incomingWorkspaces.cleanup(entry.name).then(()=>log('Удалена старая входящая передача:',entry.name),error=>log('Очистка старой передачи:',entry.name,error.message));
 for(const base of ['.result-transfers','.result-envelope-transfers'])for(const entry of await staleEntries(path.join(root,base),{maxAgeMs:week,keep:name=>Object.hasOwn(outbox,name)||jobs.has(name)||Object.hasOwn(journal,name)}))await parkDirectory(entry.path,path.join(root,'.result-orphaned',entry.name),base.slice(1)).then(target=>{if(target)log('Старый результат без очереди перенесён:',entry.name,target);},error=>log('Перенос старого результата:',entry.name,error.message));
}
void sweepStaleTransfers().catch(error=>log('Проверка старых передач:',error.message));const staleSweep=setInterval(()=>void sweepStaleTransfers().catch(()=>{}),6*3600000);staleSweep.unref();
function recordProcessStop(reason,error){
 const code=typeof error?.code==='string'&&/^[A-Z0-9_]{1,60}$/.test(error.code)?error.code:null;
 const failure=error instanceof SyntaxError?'syntax-error':error instanceof TypeError?'type-error':error?'runtime-error':null;
 const record={at:new Date().toISOString(),connectorVersion,reason,code,failure,running:jobs.size,pendingResults:Object.keys(outbox).length};
 try{writeFileSync(path.join(root,'last-process-stop.json'),JSON.stringify(record),{mode:0o600});}catch{}
 log('Состояние процесса:',JSON.stringify(record));
}
// Observe fatal errors for diagnosis; preserve Node's default fatal exit policy.
process.on('uncaughtExceptionMonitor',(error,origin)=>recordProcessStop(origin==='unhandledRejection'?'unhandled-rejection':'uncaught-exception',error));
function send(value,socket=ws){
 if(socket!==ws||socket?.readyState!==WebSocket.OPEN)return false;
 try{socket.send(JSON.stringify(value));return true;}catch(error){log('Отправка в пространство:',error.message);socket.terminate();return false;}
}
const pendingSends=new WeakMap();
function sendPending(packet){
 if(packet.type==='turn-result'&&!readyResults.has(packet.runId))return false;
 if(packet.type==='turn-result')return sendPreparedResult(packet);
 const socket=ws;if(socket?.readyState!==WebSocket.OPEN||socket.bufferedAmount>2*1024*1024)return false;
 const previous=pendingSends.get(packet);if(previous?.socket===socket&&Date.now()-previous.at<30000)return false;
 if(!send(packet,socket))return false;pendingSends.set(packet,{socket,at:Date.now()});return true;
}

function requestHub(socket,type,payload){
 if(socket!==ws||socket.readyState!==WebSocket.OPEN)return Promise.reject(new Error('Связь временно потеряна.'));
 return new Promise((resolve,reject)=>{
  // Verification of a large, already saved file can outlive a normal RPC.
  // Keep one outstanding request rather than piling up retries on the hub.
  const timeout=['result-file-chunk','result-envelope-chunk'].includes(type)?180000:120000;
  const requestId=crypto.randomUUID(),timer=setTimeout(()=>finish(Object.assign(new Error('Сервер не подтвердил часть результата вовремя.'),{code:'RESULT_TIMEOUT'})),timeout);
  const finish=(error,result)=>{clearTimeout(timer);hubRequests.delete(requestId);error?reject(error):resolve(result);};
  hubRequests.set(requestId,{socket,finish});if(!send({type,...payload,requestId},socket))finish(new Error('Связь временно потеряна.'));
 });
}
// Reduce only the wire copy, never the sealed local outbox. Coverage comes
// from the hub's fsynced checkpoint, so a restart cannot lose skipped events.
function resultWire(result,coverage){
 if(!Array.isArray(result.events)||!coverage)return result;
 const through=Number.isSafeInteger(coverage.through)&&coverage.through>=0?coverage.through:0;
 const known=new Set(Array.isArray(coverage.seqs)?coverage.seqs.filter(seq=>Number.isSafeInteger(seq)&&seq>0):[]);
 return {...result,events:result.events.filter(packet=>{
  // Repeated context counters carry the entire file inventory in legacy
  // journals. The full final session below is authoritative for those counters.
  if(packet.event?.type==='session'&&packet.event.contextOnly&&result.session?.sessionId&&packet.event.session?.sessionId===result.session.sessionId)return false;
  return !Number.isSafeInteger(packet.seq)||packet.seq<=0||packet.seq>through&&!known.has(packet.seq);
 })};
}
function sendPreparedResult(result){
 const socket=ws;if(socket?.readyState!==WebSocket.OPEN||!socket.capabilitiesReady||socket.bufferedAmount>2*1024*1024||resultDeliveries.has(result.runId))return false;
 const previous=pendingSends.get(result);if(previous?.socket===socket&&Date.now()-previous.at<30000)return false;
 const delivery={socket},oldProgress=resultProgress.get(result.runId),files=result.changes?.changed||[],progress={runId:result.runId,bytes:oldProgress?.bytes||0,total:files.reduce((sum,file)=>sum+file.size,0),lastSent:0};resultDeliveries.set(result.runId,delivery);resultProgress.set(result.runId,progress);
 const reportProgress=(force=false)=>{if(force||Date.now()-progress.lastSent>2000){progress.lastSent=Date.now();send(heartbeatState(),socket);}};
 delivery.promise=(async()=>{
  await ensureStorage();
  let wire=result;
  if(result.fileTransfer?.version===1&&socket.resultTransferVersion===1){
   reportProgress(true);const state=await requestHub(socket,'result-transfer-status',{runId:result.runId,files});
   if(state?.completed)return;
   if(!Array.isArray(state?.files)||state.files.length!==files.length)throw new Error('Сервер вернул некорректное состояние передачи.');
   wire=resultWire(result,state.eventCoverage);
   progress.bytes=state.files.reduce((sum,file)=>sum+(Number.isSafeInteger(file.offset)?file.offset:0),0);reportProgress(true);
   for(const file of files){
    const remote=state.files.find(f=>f.path===file.path);let offset=remote?.offset;
    if(remote?.hash!==file.hash||remote.size!==file.size||!Number.isSafeInteger(offset)||offset<0||offset>file.size)throw new Error('Сервер вернул некорректный участок результата.');
    while(offset<file.size){
     const chunk=await outgoingResults.readChunk(result.runId,file.path,offset),next=await requestHub(socket,'result-file-chunk',{runId:result.runId,...chunk});
     const sentBytes=Buffer.byteLength(chunk.content,'base64');if(!Number.isSafeInteger(next?.offset)||next.offset<offset+sentBytes||next.offset>file.size)throw new Error('Сервер не подтвердил сохранение части результата.');progress.bytes+=next.offset-offset;offset=next.offset;reportProgress();
    }
   }
  }else if(result.fileTransfer?.version===1){
   const changed=await outgoingResults.inline(result.runId);wire={...result,changes:{...result.changes,changed}};delete wire.fileTransfer;
  }
  // Files and final metadata use separate, resumable spools. The result ACK
  // remains the only permission to remove either local copy.
  const serialized=JSON.stringify(wire);
  if(resultEnvelopeRequired(serialized)){
   if(socket.resultEnvelopeVersion!==1)throw Object.assign(new Error('Для сохранения большого журнала нужно обновить сервер Team Room. Результат сохранён на Mac.'),{code:'RESULT_ENVELOPE_UNSUPPORTED'});
   const envelope=await outgoingResultEnvelopes.prepare(result.runId,wire,serialized),state=await requestHub(socket,'result-envelope-status',{runId:result.runId,envelope});
   if(state?.completed===true&&!Number.isSafeInteger(state?.offset))return;
   let offset=state?.offset;
   if(!Number.isSafeInteger(offset)||offset<0||offset>envelope.file.size)throw new Error('Сервер вернул некорректное состояние журнала.');
   const fileBytes=progress.bytes;progress.total=fileBytes+envelope.file.size;progress.bytes=fileBytes+offset;reportProgress(true);
   while(offset<envelope.file.size){
    const chunk=await outgoingResultEnvelopes.readChunk(result.runId,offset),next=await requestHub(socket,'result-envelope-chunk',{runId:result.runId,...chunk}),sentBytes=Buffer.byteLength(chunk.content,'base64');
    if(!Number.isSafeInteger(next?.offset)||next.offset<offset+sentBytes||next.offset>envelope.file.size)throw new Error('Сервер не подтвердил часть журнала.');
    offset=next.offset;progress.bytes=fileBytes+offset;reportProgress();
   }
   reportProgress(true);if(send({type:'turn-result',runId:result.runId,resultEnvelope:envelope},socket))pendingSends.set(result,{socket,at:Date.now()});
  }else{
   reportProgress(true);if(send(wire,socket))pendingSends.set(result,{socket,at:Date.now()});
  }
 })().catch(error=>{
  // Delivery failure must never trigger another paid native model turn.
  pendingSends.set(result,{socket,at:Date.now()});
  progress.error=String(error.message||'Не удалось сохранить результат.').slice(0,300);progress.retryAt=Date.now()+30000;
  reportProgress(true);log('Повтор сохранения результата:',result.runId,error.status||error.code||'connection-error',progress.error);
 }).finally(()=>{if(resultDeliveries.get(result.runId)===delivery)resultDeliveries.delete(result.runId);});
 return true;
}
function replayJob(job,socket=ws){
 if(socket?.readyState!==WebSocket.OPEN||socket!==ws)return Promise.resolve(false);
 if(job.replaySocket!==socket){job.replaySocket=socket;job.replayCursor=0;}
 if(job.replayPromise?.socket===socket)return job.replayPromise.pending;
 const pending=(async()=>{
  while(socket===ws&&socket.readyState===WebSocket.OPEN&&job.replayCursor<job.events.length){
   const started=Date.now();let count=0;
   while(job.replayCursor<job.events.length&&socket.bufferedAmount<2*1024*1024&&count++<64&&Date.now()-started<8){
    if(!send(job.events[job.replayCursor],socket))return false;job.replayCursor++;
   }
   if(job.replayCursor<job.events.length)await new Promise(resolve=>setTimeout(resolve,socket.bufferedAmount>=2*1024*1024?25:0));
  }
  return job.replayCursor===job.events.length;
 })();
 job.replayPromise={socket,pending};pending.then(()=>{if(job.replayPromise?.pending===pending)job.replayPromise=null;if(job.replaySocket===ws&&ws?.readyState===WebSocket.OPEN&&job.replayCursor<job.events.length)void replayJob(job);},error=>{if(job.replayPromise?.pending===pending)job.replayPromise=null;log('Восстановление событий:',error.message);});return pending;
}
// Keep only confirmation metadata; answers and permission input stay in the live
// provider callback, never in this cache or the durable job journal.
const answeredApprovals=new Map();
async function applyApproval(msg){
 const original=msg.approvalRequestId||msg.requestId,key=msg.runId+'\0'+original;
 if(answeredApprovals.has(key))return answeredApprovals.get(key);
 const job=jobs.get(msg.runId),reply=job?.approvals.get(original);
 if(!reply){const error=new Error('Этот вопрос уже закрыт или работа на компьютере завершена. Обнови чат.');error.status=409;throw error;}
 const operation=(async()=>{
  const outcome=await reply(msg.allow,msg.answers);
  if(outcome?.accepted===false){const error=new Error(outcome.stale?'Этот вопрос уже закрыт. Обнови чат.':'Не удалось доставить ответ модели. Проверь связь и повтори.');error.status=outcome.stale?409:503;throw error;}
  job.approvals.delete(original);job.publicApprovals.delete(original);return {ok:true};
 })();
 answeredApprovals.set(key,operation);
 try{const result=await operation;answeredApprovals.set(key,Promise.resolve(result));while(answeredApprovals.size>512)answeredApprovals.delete(answeredApprovals.keys().next().value);return result;}
 catch(error){answeredApprovals.delete(key);throw error;}
}
let skillsScanning=false,lastSkillsScan=0;
async function scanSkills(){if(skillsScanning)return {busy:true};skillsScanning=true;try{await ensureStorage();const report=await skillDiscovery.scan();lastSkillsScan=Date.now();send({type:'skills-report',report});return {ok:true,count:report.items.length,issues:report.issues};}finally{skillsScanning=false;}}
let mcpScanning=false,lastMcpScan=0;
async function scanMcp(){if(mcpScanning)return {busy:true};mcpScanning=true;try{await ensureStorage();const report=await discoverMcp({codexList:()=>providers.mcpList()});lastMcpScan=Date.now();send({type:'mcp-report',report});return {ok:true,count:report.items.length,issues:report.issues};}finally{mcpScanning=false;}}
async function status(force=false){if(statusBusy){pendingStatusForce||=force;return;}if(!force&&Date.now()-lastStatus<60000)return;statusBusy=true;try{await ensureStorage();const report=value=>send({type:'status',protocolVersion:6,permissionsVersion:1,executionModeVersion:1,accountsVersion:1,runRecoveryVersion:1,loginBusy:accounts.logins.size>0,connectorVersion,workspaceFileLimit:MAX_WORKSPACE_FILES,fileTransferVersion:1,resultEnvelopeVersion:1,largeFilesVersion:1,workspaceBatchVersion:1,agentMonitorVersion:1,liveInputVersion:1,approvalAckVersion:1,voiceVersion:1,mcpSyncVersion:1,skillsSyncVersion:1,accounts:accounts.list(),accountsError:accounts.error||null,status:value});const value=await providers.status(force);lastStatus=Date.now();report(value);if(accounts.records.length){await accounts.status(force);report(await providers.status());}}finally{statusBusy=false;if(pendingStatusForce){pendingStatusForce=false;void status(true).catch(()=>{});}}}
function waitForPreparation(pending,signal){
 signal.throwIfAborted();return new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason||new Error('Сессия остановлена.'));
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve(pending).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
 });
}
const validReplyOffset=value=>Number.isSafeInteger(value)&&value>=0;
function mergeSteerOutcome(previous,next){
 // Delivery is terminal; a replay may add a previously missing boundary but
 // must never move the first boundary confirmed by the native provider.
 const outcome=previous?.status==='delivered'?{...previous}:{status:next.status,detail:next.detail};
 const replyOffset=validReplyOffset(previous?.replyOffset)?previous.replyOffset:next.status==='delivered'&&validReplyOffset(next.replyOffset)?next.replyOffset:undefined;
 if(replyOffset!==undefined)outcome.replyOffset=replyOffset;
 return outcome;
}
function runState(runId,afterSeq=0){
 const since=Number.isSafeInteger(afterSeq)&&afterSeq>=0?afterSeq:0;
 const job=jobs.get(runId);
 if(job)return {state:'running',runId,seq:job.seq,text:job.text,agents:job.agents||[],session:job.session,executionMode:executionMode(job.msg.options?.executionMode),nativeExecutionMode:job.nativeExecutionMode,plan:job.plan,canSteer:Boolean(job.steer&&!job.closing&&!job.controller.signal.aborted),preparing:Boolean(job.preparing),finishing:Boolean(job.closing),finalizationRetry:job.finalizationRetry||null,approvals:[...job.publicApprovals.values()],events:job.events.filter(packet=>packet.seq>since&&['model','session','context','tool','tool-result','usage','limits','notice','followup-delivery','phase','plan','execution-mode'].includes(packet.event?.type)),followups:Object.entries(job.steerOutcomes).map(([messageId,r])=>({messageId,...r}))};
 if(journal[runId]?.finalization?.nativeFinished===true)return {state:'result-saving',runId,nativeFinished:true,finishing:true};
 return {state:Object.hasOwn(outbox,runId)?'result-pending':'missing',runId};
}
function flushJobAgents(job){
 clearTimeout(job.agentTimer);job.agentTimer=null;
 for(const id of job.agentUpdates||[]){const agent=job.agents?.find(a=>a.id===id);if(agent)send({type:'turn-agent',runId:job.msg.runId,agent});}
 job.agentUpdates?.clear();scheduleJobJournal(job);
}
function flushJobJournal(job){
 clearTimeout(job.journalTimer);job.journalTimer=null;
 const entry=journal[job.msg.runId];if(!entry)return Promise.resolve();
 entry.text=job.text;entry.plan=job.plan;entry.nativeExecutionMode=job.nativeExecutionMode;entry.events=job.events;entry.agents=job.agents||[];entry.followups=Object.entries(job.steerOutcomes).map(([messageId,r])=>({messageId,...r}));return saveJournal();
}
function scheduleJobJournal(job){
 if(job.journalTimer||!journal[job.msg.runId])return;
 job.journalTimer=setTimeout(()=>{void flushJobJournal(job);},500);job.journalTimer.unref?.();
}
const finalizers=new RetryFinalizer({run:finalizeResult,onFailure:(error,entry)=>{
 const job=entry.value.job,detail=error.code==='EXTERNAL_STORAGE_UNAVAILABLE'?'Внешний диск отключён. Подключи его — сохранение продолжится автоматически.':['ENOSPC','EDQUOT'].includes(error.code)?'На Mac закончилось место. Освободи место — сохранение продолжится автоматически.':'Не удалось сохранить результат. Повторяю сохранение автоматически…';
 if(job){job.finalizationRetry={attempts:entry.attempts,retryAt:entry.retryAt,code:error.code||null};job.emit({type:'phase',phase:'saving',text:detail});}
 log('Сохранение результата будет повторено:',entry.key,error.code||'storage-error');updateKeepAwake();
}});
async function finalizeResult(state){
 await ensureStorage();
 const {runId,job}=state;
 if(job)await flushJobJournal(job);
 if(!state.result){
  const dir=state.dir;
  if(!state.changes){try{state.changes=await outgoingResults.readChanges(runId);state.prepared=true;}catch(error){if(error.code!=='ENOENT')throw error;const checkpointState=new CheckpointState(state.before||[],state.publications||[]);state.changes=state.workspaceReady===false?{changed:[],deleted:[]}:checkpointState.finalChanges(await changes(dir,checkpointState.finalBaseline(),{contents:false}));}}
  if(!state.prepared){
   try{await outgoingResults.prepare(runId,dir,state.changes.changed,{deleted:state.changes.deleted});state.prepared=true;}
   catch(error){
    // A background writer can finish just after the final scan. Until a sealed
    // manifest exists, refresh its inventory instead of retrying a stale hash
    // forever. Once sealed, delivery always reuses those immutable bytes.
    if(error.code==='ENOENT'||error.message?.startsWith('Файл изменился во время сохранения результата:')){
     try{state.changes=await outgoingResults.readChanges(runId);state.prepared=true;}catch(readError){if(readError.code!=='ENOENT')throw readError;state.changes=null;}
    }
    throw error;
   }
  }
  // The spool's files/manifest are fsynced separately; persist their directory
  // entries before putting references into the durable delivery outbox.
  await syncDirectory(path.join(root,'.result-transfers',runId));
  await syncDirectory(path.join(root,'.result-transfers'));
  state.result=structuredClone({...state.nativeResult,fileTransfer:{version:1},changes:state.changes,agentNotes:await readAgentNotes(dir,state.chat)});
 }
 if(!state.outboxDurable){outbox[runId]=state.result;await save();state.outboxDurable=true;}
 const previous=journal[runId];if(previous){delete journal[runId];try{await saveJournal();}catch(error){if(!journal[runId])journal[runId]=previous;throw error;}}
 readyResults.add(runId);
 if(job){job.processes?.dispose();clearTimeout(job.journalTimer);clearTimeout(job.agentTimer);delete job.finalizationRetry;jobs.delete(runId);}
 updateKeepAwake();sendPending(state.result);void scanSkills().catch(()=>{});return state.result;
}
async function acknowledgeResult(runId){
 await ensureStorage();
 if(resultAcknowledgements.has(runId))return resultAcknowledgements.get(runId);
 if(!readyResults.has(runId))return;
 const pending=(async()=>{
  const previous=outbox[runId];delete outbox[runId];
  try{await save();}catch(error){if(previous&&!Object.hasOwn(outbox,runId))outbox[runId]=previous;throw error;}
  readyResults.delete(runId);resultProgress.delete(runId);updateKeepAwake();await outgoingResults.cleanup(runId).catch(error=>log('Очистка сохранённого результата:',error.message));
  await outgoingResultEnvelopes.cleanup(runId).catch(error=>log('Очистка сохранённого журнала:',error.message));
 })();resultAcknowledgements.set(runId,pending);
 try{return await pending}finally{if(resultAcknowledgements.get(runId)===pending)resultAcknowledgements.delete(runId)}
}
// Repeated result-unknown answers mean the hub will never accept this result;
// retrying forever kept the chat busy and the Mac awake. Park it, never delete it.
async function disownResult(runId){
 if(!/^[a-zA-Z0-9_-]{1,240}$/.test(runId||'')||!readyResults.has(runId)||!outbox[runId]||resultAcknowledgements.has(runId))return;
 if(!unknownResults.note(runId))return;
 const previous=outbox[runId];delete outbox[runId];
 try{await save();}catch(error){if(!Object.hasOwn(outbox,runId))outbox[runId]=previous;throw error;}
 readyResults.delete(runId);resultProgress.delete(runId);unknownResults.forget(runId);updateKeepAwake();
 try{const dir=await parkResult(root,runId,previous,[path.join(root,'.result-transfers',runId),path.join(root,'.result-envelope-transfers',runId)]);log('Сервер больше не ждёт результат; он сохранён отдельно:',runId,dir);}
 catch(error){log('Результат, который сервер не ждёт, не удалось перенести:',runId,error.message);}
}
async function run(msg){
 await ensureStorage();
 const mode=executionMode(msg.options?.executionMode);
 const dir=workFor(msg);if(!/^[a-zA-Z0-9_-]{1,240}$/.test(msg.chat?.id||'')||!/^[a-zA-Z0-9_-]{1,240}$/.test(msg.runId||''))throw new Error('Недопустимый запрос работы.');
 if(closing)throw new Error('Подключение перезапускается. Сохранённую задачу можно продолжить после восстановления связи.');
 if(resultAcknowledgements.has(msg.runId))return;
 if(Object.hasOwn(outbox,msg.runId)){sendPending(outbox[msg.runId]);return;}
 if(jobs.has(msg.runId)){send({type:'run-accepted',runId:msg.runId});return;}
 if([...jobs.values()].some(j=>j.msg.project.id===msg.project.id&&(j.msg.chat.id===msg.chat.id||j.msg.options?.workspaceMode!=='chat-v1'||msg.options?.workspaceMode!=='chat-v1'))){send({type:'turn-result',runId:msg.runId,error:'Этот чат ещё выполняется на компьютере. Для параллельных чатов обнови Team Room Community Connect.'});return;}
 if(Object.values(journal).some(r=>r.projectId===msg.project.id&&(r.chatId===msg.chat.id||r.workspaceMode!=='chat-v1'))){send({type:'turn-result',runId:msg.runId,error:'Сначала нужно восстановить предыдущую работу этого проекта. Журнал и файлы сохранены.'});return;}
 if(Object.values(outbox).some(r=>r.projectId===msg.project.id&&(r.chatId===msg.chat.id||r.workspaceMode!=='chat-v1'))){send({type:'turn-result',runId:msg.runId,error:'Есть несинхронизированный результат этого проекта. Дождись его сохранения.'});return}
 const job={controller:new AbortController(),approvals:new Map(),publicApprovals:new Map(),events:[],seq:0,text:'',revision:0,checkpointBusy:false,lastCheckpointAt:0,preparing:true,steerRequests:new Map(),steerOutcomes:{},msg};jobs.set(msg.runId,job);updateKeepAwake();let error,before=[],workspaceReady=false;
 const emit=event=>{
  if(event.type==='agent-control'){job.agentControl=event.control;return;}
  if(event.type==='agent'){const agent=applyAgentEvent(job,event);if(agent){job.agentUpdates||=new Set();job.agentUpdates.add(agent.id);if(!job.agentTimer){job.agentTimer=setTimeout(()=>flushJobAgents(job),500);job.agentTimer.unref?.();}scheduleJobJournal(job);}return;}
  if(event.type==='control'){job.steer=event.steer;emit({type:'steer-ready'});return;}
  if(event.type==='approval-cancelled'){job.approvals.delete(event.requestId);job.publicApprovals.delete(event.requestId);}
  if(event.type==='followup-delivery'){
   const outcome=mergeSteerOutcome(job.steerOutcomes[event.messageId],event);job.steerOutcomes[event.messageId]=outcome;event={...event,...outcome};
   if(outcome.status==='delivered'){const m=job.msg.chat.messages.find(m=>m.id===event.messageId);if(m){m.delivery='delivered';m.status='completed';}}
  }
  if(event.type==='approval'){job.approvals.set(event.requestId,event.reply);const {reply,...approval}=event;job.publicApprovals.set(event.requestId,approval);}
  if(event.type==='delta')job.text+=event.text;
  if(event.type==='plan')job.plan={itemId:event.itemId,text:typeof event.text==='string'?event.text:(job.plan?.itemId===event.itemId?job.plan.text:'')+(event.delta||''),status:event.status};
  if(event.type==='execution-mode')job.nativeExecutionMode=event.native;
  if(event.type==='session'){job.session=event.session;if(journal[msg.runId]){journal[msg.runId].session=event.session;void saveJournal()}}
  const {reply,...publicEvent}=event;
  if(publicEvent.type==='session'&&publicEvent.contextOnly&&publicEvent.session?.sessionId){publicEvent.sessionPatch=true;publicEvent.session={sessionId:publicEvent.session.sessionId,contextUsage:publicEvent.session.contextUsage};}
  const packet={type:'turn-event',runId:msg.runId,seq:++job.seq,event:publicEvent};job.events.push(packet);void replayJob(job);
  if(event.type==='followup-delivery')void flushJobJournal(job);else scheduleJobJournal(job);
  if(event.type==='tool-result')void checkpointJob(job);
 };
 job.emit=emit;
 try{
  // Reserve durably before slow skill/file preparation. The hub can now see this
  // run in heartbeats and must not time it out or launch another copy.
  journal[msg.runId]={runId:msg.runId,chatId:msg.chat.id,projectId:msg.project.id,workspaceMode:msg.options.workspaceMode,executionMode:mode,provider:msg.options.provider,accountId:msg.options.accountId||'',workspaceReady:false,before:[],text:'',events:[]};
  await saveJournal();send({type:'run-accepted',runId:msg.runId});emit({type:'phase',phase:'starting',text:'Подготавливает подключение и рабочие файлы…'});
  await waitForPreparation(mcp.tail.catch(()=>{}),job.controller.signal);await waitForPreparation(skills.tail.catch(()=>{}),job.controller.signal);
  job.controller.signal.throwIfAborted();
  if(msg.fileTransfer?.version===2){await waitForPreparation(transferStages.get(msg.runId),job.controller.signal);const staging=await transferDirectory(msg.runId);await incomingWorkspaces.apply(msg.runId,{changed:msg.files.filter(f=>msg.fileTransfer.paths.includes(f.path)),deleted:[]},async delta=>{for(const file of delta.changed)await atomicProjectWrite(staging,file.path,file.source())},{stream:true});await applyStagedSnapshot(dir,msg.files,staging,msg.fileTransfer.paths,job.controller.signal);}else if(msg.fileTransfer?.version===1){await waitForPreparation(transferStages.get(msg.runId),job.controller.signal);await applyStagedSnapshot(dir,msg.files,await transferDirectory(msg.runId),msg.fileTransfer.paths,job.controller.signal);}else await applySnapshot(dir,msg.files);
  job.controller.signal.throwIfAborted();before=await snapshot(dir);workspaceReady=true;job.before=before;job.checkpoints=new CheckpointState(before);Object.assign(journal[msg.runId],{workspaceReady:true,before});await saveJournal();job.preparing=false;
  job.processes=await RunProcesses.start(dir,owned=>{processOwners[msg.chat.id]=owned;void saveProcessOwners().catch(error=>log('Журнал процессов:',error.message));if(journal[msg.runId]){journal[msg.runId].ownedProcesses=owned;scheduleJobJournal(job);}},processOwners[msg.chat.id]||[]);
  if(job.controller.signal.aborted)await job.processes.stop();
  job.controller.signal.throwIfAborted();
  await ensureStorage();job.controller.signal.throwIfAborted();emit({type:'phase',phase:'running',text:'Запускает модель…'});const key=sessionKey(msg.options);await continueConversation({providers:accounts.get(msg.options.provider,msg.options.accountId),cwd:dir,chat:msg.chat,project:msg.project,memories:msg.memories,tasks:msg.tasks,relatedChats:msg.relatedChats||[],options:msg.options,session:msg.chat.providerSessions?.[key]},emit,job.controller.signal)}catch(e){error=e.message}
 if(msg.fileTransfer?.version){try{await fs.rm(await transferDirectory(msg.runId),{recursive:true,force:true});}catch{}if(msg.fileTransfer.version===2)await incomingWorkspaces.cleanup(msg.runId).catch(()=>{});}
 await job.stopProcesses?.catch(error=>{error=String(error.message);log('Остановка процессов:',error);});
 job.closing=true;job.preparing=false;finishAgents(job,job.controller.signal.aborted?'interrupted':error?'failed':'completed');for(const agent of job.agents||[]){job.agentUpdates||=new Set();job.agentUpdates.add(agent.id);}flushJobAgents(job);await Promise.allSettled([...job.steerRequests.values()]);
 // Wait for the in-flight checkpoint before the final scan. Two full scans of
 // an actively changing workspace used to compete and inflate memory/IO.
 await job.checkpointPromise?.catch(()=>{});
 const nativeResult=structuredClone({type:'turn-result',runId:msg.runId,chatId:msg.chat.id,projectId:msg.project.id,workspaceMode:msg.options.workspaceMode,provider:msg.options.provider,accountId:msg.options.accountId||'',executionMode:mode,nativeExecutionMode:job.nativeExecutionMode,plan:job.plan,session:job.session,text:job.text,agents:job.agents||[],before,error,followups:Object.entries(job.steerOutcomes).map(([messageId,r])=>({messageId,...r})),events:job.events.filter(packet=>['tool','tool-result','model','session','limits','usage','followup-delivery'].includes(packet.event?.type))});
 if(journal[msg.runId])journal[msg.runId].finalization={nativeFinished:true,error:error||null};
 job.emit({type:'phase',phase:'saving',text:'Сохраняет ответ и файлы…'});
 job.finalization=finalizers.enqueue(msg.runId,{runId:msg.runId,job,dir,chat:msg.chat,before,workspaceReady,nativeResult,publications:job.checkpoints?.publications()||[]});return job.finalization.promise;
}
async function steerJob(msg){
 const job=jobs.get(msg.runId),message=msg.message;
 if(!message?.id||typeof message.text!=='string'||message.text.length>100000)throw new Error('Недопустимое дополнение.');
 if(!job)return outbox[msg.runId]?.followups?.find(f=>f.messageId===message.id)||{status:'queued'};
 if(job.steerRequests.has(message.id))return job.steerRequests.get(message.id);
 if(job.closing||job.controller.signal.aborted||!job.steer)return {status:'queued'};
 const pending=(async()=>{
  job.steerOutcomes[message.id]=mergeSteerOutcome(job.steerOutcomes[message.id],{status:'uncertain'});
  await flushJobJournal(job);
  let result;try{result=await job.steer(message)}catch(error){result={status:'uncertain',detail:error.message};}
  result=mergeSteerOutcome(job.steerOutcomes[message.id],result);job.steerOutcomes[message.id]=result;
  if(['received','delivered'].includes(result.status)&&!job.msg.chat.messages.some(m=>m.id===message.id))job.msg.chat.messages.push({...message,status:result.status==='delivered'?'completed':'pending',delivery:result.status});
  await flushJobJournal(job);job.emit({type:'followup-delivery',messageId:message.id,...result});return result;
 })();job.steerRequests.set(message.id,pending);return pending;
}
async function checkpointJob(job){
 if(job.closing||job.checkpointBusy||!job.before)return;
 if(job.lastCheckpoint){sendPending(job.lastCheckpoint);return;}
 if(Date.now()-job.lastCheckpointAt<5000)return;job.checkpointBusy=true;job.lastCheckpointAt=Date.now();
 job.checkpointPromise=(async()=>{
  const dir=workFor(job.msg),state=job.checkpoints||=new CheckpointState(job.before),metadata=await changes(dir,state.baseline(),{contents:false});let size=0;
  const small=metadata.changed.filter(file=>{if(size+file.size>24*1024*1024)return false;size+=file.size;return true});
  const details={text:job.text,followups:Object.entries(job.steerOutcomes).map(([messageId,outcome])=>({messageId,...outcome})),agentNotes:await readAgentNotes(dir,job.msg.chat)};
  if(!small.length&&!metadata.deleted.length&&checkpointContentKey(details)===state.contentKey)return;
  const delta={changed:await readFileBatch(dir,small),deleted:metadata.deleted},packet={type:'turn-checkpoint',runId:job.msg.runId,revision:++job.revision,...details,changes:delta};
  // Persist attempted paths before the socket send. An ACK can be lost after
  // the hub applies the packet, so final reconciliation must cover them too.
  state.record(delta);if(journal[job.msg.runId])journal[job.msg.runId].checkpointPublications=state.publications();await flushJobJournal(job);
  job.lastCheckpoint=packet;sendPending(packet);
 })();
 try{await job.checkpointPromise}catch(e){console.error('Контрольная точка:',e.message)}finally{job.checkpointBusy=false}
}
function acknowledgeCheckpoint(runId,revision){const job=jobs.get(runId),packet=job?.lastCheckpoint;if(packet?.revision!==revision)return;job.checkpoints.acknowledge(packet);job.lastCheckpoint=null;}
// A crashed bridge leaves a journal and its working files. Return that evidence instead of rerunning tools.
// Apply only explicitly approved, byte-identical duplicate maintenance before
// restoring finalizers or accepting any new native work. Journals stay intact.
async function restoreApprovedCleanup(){
 const budget=AbortSignal.timeout(40000);
 try{
  const endpoint=new URL('/api/workspace-cleanup-plans',config.hubUrl);
  if(endpoint.username||endpoint.password||endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)))return;
  const response=await fetch(endpoint,{headers:{Authorization:'Bearer '+config.token},redirect:'error',signal:AbortSignal.any([budget,AbortSignal.timeout(12000)])});
  if(!response.ok)return;
  const parts=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>4*1024*1024)throw new Error('Список восстановления слишком большой.');parts.push(chunk);}
  const {plans}=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!Array.isArray(plans)||plans.length>100)throw new Error('Некорректный список восстановления.');
  for(const plan of plans){
   budget.throwIfAborted();
   if(!/^[a-zA-Z0-9_-]{1,240}$/.test(plan?.projectId||''))throw new Error('Некорректный проект восстановления.');
   const targets=[workspaceFor(plan.projectId)],base=path.join(root,'session-workspaces',plan.projectId);
   try{const stat=await fs.lstat(base);if(stat.isDirectory()&&!stat.isSymbolicLink()){const children=await fs.readdir(base,{withFileTypes:true});if(children.length>1000)throw new Error('Слишком много локальных копий проекта.');for(const child of children)if(child.isDirectory()&&!child.isSymbolicLink()&&/^[a-zA-Z0-9_-]{1,240}$/.test(child.name))targets.push(workspaceFor(plan.projectId,child.name));}}catch(error){if(error.code!=='ENOENT')throw error;}
   for(const target of targets){let stat;try{stat=await fs.lstat(target)}catch(error){if(error.code==='ENOENT')continue;throw error;}if(!stat.isDirectory()||stat.isSymbolicLink())continue;
    await assertStorageForPath(target);const cleanupRoot=await fs.realpath(target);const result=await applyWorkspaceCleanup(cleanupRoot,plan,{signal:budget});if(result.moved)log('Восстановлена рабочая копия проекта:',plan.projectId,'сохранены дубликаты:',result.moved);
   }
  }
 }catch(error){log('Очистка рабочей копии отложена; локальные файлы и результаты сохранены:',error.message);}
}
updateKeepAwake();await restoreApprovedCleanup();
if(Object.keys(journal).length)log('Восстанавливаю результаты после перезапуска подключения:',Object.keys(journal).length);
for(const [runId,old]of Object.entries(journal)){
 if(old.followups)old.followups=old.followups.map(f=>f.status==='received'?{...f,status:'uncertain',detail:'Подключение перезапустилось до подтверждения обработки дополнения.'}:f);
 const nativeResult={type:'turn-result',...old,error:old.finalization?.nativeFinished?old.finalization.error||undefined:'Подключение перезапустилось во время работы. Сохранённые действия и файлы восстановлены; продолжи задачу.'};
 finalizers.enqueue(runId,{runId,dir:workspaceFor(old.projectId,old.workspaceMode==='chat-v1'?old.chatId:undefined),chat:{id:old.chatId},before:old.before,workspaceReady:old.workspaceReady,nativeResult,result:outbox[runId],outboxDurable:Boolean(outbox[runId]),publications:old.checkpointPublications||[]});
}
function connect(){
 if(closing||ws?.readyState===WebSocket.OPEN||ws?.readyState===WebSocket.CONNECTING)return;
 clearTimeout(reconnectTimer);
 const socket=new WebSocket(url,{headers:{Authorization:`Bearer ${config.token}`,'X-TeamRoom-Instance':connectorInstanceId},maxPayload:192*1024*1024,handshakeTimeout:15000});ws=socket;
 socket.on('open',()=>{if(ws!==socket)return;retry=1000;lastReceived=lastHealthTick=Date.now();probeUntil=0;connectionReason='connected';log(`Подключён: ${config.name}. Открой ${config.hubUrl} в браузере.`);send(heartbeatState());if(skills.autoDiscovery===true)void scanSkills().catch(()=>log('Скиллы: не удалось прочитать локальные файлы.'));if(mcp.autoDiscovery===true)void scanMcp().catch(()=>log('MCP: не удалось прочитать локальные подключения.'));void status(true).catch(error=>log('Проверка подписок:',error.message));for(const job of jobs.values()){send({type:'run-accepted',runId:job.msg.runId});void replayJob(job,socket).then(()=>{if(job.lastCheckpoint)sendPending(job.lastCheckpoint);}).catch(error=>log('Восстановление событий после подключения:',error.message));}for(const result of Object.values(outbox))sendPending(result);saveDiagnostics(true);});
 socket.on('pong',()=>{if(ws===socket){lastReceived=Date.now();probeUntil=0;}});
 socket.on('message',async raw=>{if(ws!==socket)return;lastReceived=Date.now();probeUntil=0;connectionReason=storageError?'external-storage-unavailable':'connected';let msg;try{msg=JSON.parse(raw.toString());
  if(storageCommands.has(msg.type))try{await ensureStorage();}catch(error){if(msg.type==='run')send({type:'turn-result',runId:msg.runId,error:error.message});else if(msg.requestId)send({type:'response',requestId:msg.requestId,error:error.message,code:error.code});return;}
  if(msg.type==='ping'){send({type:'pong',at:msg.at});return;}
  if(msg.type==='heartbeat-ack'||msg.type==='welcome'){socket.capabilitiesReady=true;if(msg.resultTransferVersion!==undefined)socket.resultTransferVersion=msg.resultTransferVersion===1?1:0;if(msg.resultEnvelopeVersion!==undefined)socket.resultEnvelopeVersion=msg.resultEnvelopeVersion===1?1:0;for(const result of Object.values(outbox))sendPending(result);return;}
  if(msg.type==='pong')return;
  if(msg.type==='response'){const pending=hubRequests.get(msg.requestId);if(pending?.socket===socket)pending.finish(msg.error?Object.assign(new Error(msg.error),{status:msg.status,code:msg.code}):null,msg.result);return;}
  if(msg.type==='skills-sync'){try{await skills.apply(msg.snapshot);skills.autoDiscovery=msg.snapshot?.auto===true;send({type:'skills-applied',info:skills.info});}catch{send({type:'skills-applied',info:{revision:skills.revision,count:skills.info.count,error:true}});}}
  else if(msg.type==='skills-export'){try{send({type:'response',requestId:msg.requestId,result:await skillDiscovery.export(msg.id,msg.hash,msg.paths)});}catch{send({type:'response',requestId:msg.requestId,error:'Файлы скилла изменились. Повторю синхронизацию.'});}}
  else if(msg.type==='skills-scan'){try{send({type:'response',requestId:msg.requestId,result:await scanSkills()});}catch{send({type:'response',requestId:msg.requestId,error:'Не удалось прочитать скиллы.'});}}
  else if(msg.type==='mcp-sync'){try{await mcp.apply(msg.snapshot);mcp.autoDiscovery=msg.snapshot?.auto===true;send({type:'mcp-applied',info:mcp.info});}catch{send({type:'mcp-applied',info:{revision:mcp.revision,error:true,servers:[]}});}}
  else if(msg.type==='mcp-scan'){try{send({type:'response',requestId:msg.requestId,result:await scanMcp()});}catch{send({type:'response',requestId:msg.requestId,error:'Не удалось прочитать MCP на компьютере.'});}}
  else if(['voice-status','voice-prepare','voice-transcribe'].includes(msg.type)){try{const pending=msg.type==='voice-status'?voice.info():msg.type==='voice-prepare'?voice.prepare():voice.transcribe(msg);updateKeepAwake();const result=msg.type==='voice-status'?{...await pending,error:voice.error||null}:await pending;send({type:'response',requestId:msg.requestId,result});}catch(error){send({type:'response',requestId:msg.requestId,error:error.message});}finally{updateKeepAwake();}}
  else if(msg.type==='catalog'){try{const selected=accounts.get(msg.provider,msg.accountId);if(msg.force){selected.invalidateAuth();selected.claudeCatalog=null}send({type:'response',requestId:msg.requestId,result:await selected.catalog(msg.provider)})}catch(error){send({type:'response',requestId:msg.requestId,error:error.message})}}
  else if(msg.type==='workspace-status'){let operation;try{
   if(msg.runId!==undefined&&!/^[a-zA-Z0-9_-]{1,240}$/.test(msg.runId))throw new Error('Недопустимый запуск.');
   const preparationKey=msg.runId||'workspace-status-'+msg.projectId+'-'+(msg.chatId||'project');
   operation=(transferStages.get(preparationKey)||Promise.resolve()).catch(()=>{}).then(async()=>{
   const target=workspaceFor(msg.projectId,msg.workspaceMode==='chat-v1'?msg.chatId:undefined),incoming=msg.files.filter(file=>!isIgnoredPortablePath(file?.path));validateFileInventory(incoming);const candidates=[];
   if(msg.workspaceMode==='chat-v1'){
    candidates.push(workspaceFor(msg.projectId));const folder=path.join(root,'session-workspaces',msg.projectId);
    try{const entries=await fs.readdir(folder,{withFileTypes:true});for(const entry of entries){if(candidates.length>=6)break;if(entry.isDirectory()&&!entry.isSymbolicLink()&&entry.name!==msg.chatId&&/^[a-zA-Z0-9_-]{1,240}$/.test(entry.name))candidates.push(workspaceFor(msg.projectId,entry.name));}}catch(error){if(error.code!=='ENOENT')throw error;}
   }
   const reused=await reuseWorkspaceFiles(target,incoming,candidates);const files=await inspectWorkspaceFiles(target,incoming),known=new Map(files.map(f=>[f.path,f.hash]));return {fileTransferVersion:1,largeFilesVersion:1,workspaceBatchVersion:1,agentMonitorVersion:1,liveInputVersion:1,reusedFiles:reused.reused.length,reusedBytes:reused.bytes,needed:incoming.filter(f=>known.get(f.path)!==f.hash).map(f=>f.path)};
   });transferStages.set(preparationKey,operation);updateKeepAwake();send({type:'response',requestId:msg.requestId,result:await operation});
  }catch(e){send({type:'response',requestId:msg.requestId,error:e.message})}finally{const key=msg.runId||'workspace-status-'+msg.projectId+'-'+(msg.chatId||'project');if(transferStages.get(key)===operation)transferStages.delete(key);updateKeepAwake();}}
  else if(msg.type==='workspace-transfer-status'||msg.type==='workspace-file-chunk'||msg.type==='workspace-file-batch'){
   let operation;try{workspaceFor(msg.projectId,msg.workspaceMode==='chat-v1'?msg.chatId:undefined);
    operation=(transferStages.get(msg.runId)||Promise.resolve()).catch(()=>{}).then(()=>msg.type==='workspace-transfer-status'?incomingWorkspaces.status(msg.runId,msg.files):msg.type==='workspace-file-batch'?incomingWorkspaces.batch(msg.runId,msg.chunks):incomingWorkspaces.chunk(msg.runId,msg));transferStages.set(msg.runId,operation);updateKeepAwake();send({type:'response',requestId:msg.requestId,result:await operation});
   }catch(e){send({type:'response',requestId:msg.requestId,error:e.message})}finally{if(transferStages.get(msg.runId)===operation)transferStages.delete(msg.runId);updateKeepAwake();}
  }
  else if(msg.type==='workspace-stage'){
   let operation;try{
    workspaceFor(msg.projectId,msg.workspaceMode==='chat-v1'?msg.chatId:undefined);const staging=await transferDirectory(msg.runId);
    operation=(transferStages.get(msg.runId)||Promise.resolve()).catch(()=>{}).then(()=>stageFileBatch(staging,msg.files));transferStages.set(msg.runId,operation);updateKeepAwake();
    send({type:'response',requestId:msg.requestId,result:await operation});
   }catch(e){send({type:'response',requestId:msg.requestId,error:e.message})}finally{if(transferStages.get(msg.runId)===operation)transferStages.delete(msg.runId);updateKeepAwake()}
  }
  else if(msg.type==='native-list'){try{send({type:'response',requestId:msg.requestId,result:await accounts.native(msg.provider,msg.accountId).list(msg.provider,msg.cursor)})}catch(e){send({type:'response',requestId:msg.requestId,error:e.message})}}
  else if(msg.type==='native-read'){try{send({type:'response',requestId:msg.requestId,result:await accounts.native(msg.provider,msg.accountId).read(msg.provider,msg.sessionId,{files:msg.files})})}catch(e){send({type:'response',requestId:msg.requestId,error:e.message})}}
  else if(msg.type==='memory'){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),110000);try{const dir=workspaceFor(msg.projectId,msg.chatId);await fs.mkdir(dir,{recursive:true});let limits;const r=await accounts.get(msg.options.provider,msg.options.accountId).run({...msg.options,cwd:dir,prompt:msg.prompt,readOnly:true},e=>{if(e.type==='approval')e.reply(false);if(e.type==='limits')limits=e.limits},controller.signal);send({type:'response',requestId:msg.requestId,result:{...r,limits}})}catch(e){send({type:'response',requestId:msg.requestId,error:e.message})}finally{clearTimeout(timer)}}
  else if(msg.type==='checkpoint-ack')acknowledgeCheckpoint(msg.runId,msg.revision);
  else if(msg.type==='run')void run(msg).catch(e=>{send({type:'turn-result',runId:msg.runId,error:e.message});console.error('Запуск:',e.message)});
  else if(msg.type==='run-state'){send({type:'response',requestId:msg.requestId,result:runState(msg.runId,msg.afterSeq)});}
  else if(msg.type==='agent-control'){
   try{const job=jobs.get(msg.runId);if(!job||job.msg.chat.id!==msg.chatId||job.closing||job.controller.signal.aborted||!job.agentControl)throw new Error('Работа уже завершена или управление ещё не готово.');
    if(msg.action==='resume')await ensureStorage();
    if(!validAgentId(msg.agentId)||!['stop','resume'].includes(msg.action))throw new Error('Недопустимое действие агента.');
    const agent=job.agents?.find(a=>a.id===msg.agentId);if(!agent?.capabilities?.[msg.action])throw new Error('Действие сейчас недоступно для выбранного агента.');
    job.agentRequests||=new Map();const key=msg.agentId+':'+msg.action;let pending=job.agentRequests.get(key);
    if(!pending){pending=Promise.resolve().then(()=>job.agentControl(msg.agentId,msg.action)).finally(()=>job.agentRequests.delete(key));job.agentRequests.set(key,pending);}
    const result=await pending;flushJobAgents(job);send({type:'response',requestId:msg.requestId,result});
   }catch(error){send({type:'response',requestId:msg.requestId,error:error.message,status:409});}
  }
  else if(msg.type==='steer'){try{send({type:'response',requestId:msg.requestId,result:await steerJob(msg)})}catch(error){send({type:'response',requestId:msg.requestId,error:error.message})}}
  else if(msg.type==='abort'){
   const job=jobs.get(msg.runId);if(job){job.controller.abort();job.stopProcesses||=job.processes?.stop();await job.stopProcesses;
    if(job.finalization){job.finalization.value.nativeResult.error='Сессия остановлена.';if(job.finalization.value.result)job.finalization.value.result.error='Сессия остановлена.';}
   }else if(journal[msg.runId]?.finalization?.nativeFinished){
    const old=journal[msg.runId];await RunProcesses.restore(workspaceFor(old.projectId,old.workspaceMode==='chat-v1'?old.chatId:undefined),old.ownedProcesses||[]).stop();
    const entry=finalizers.entries.get(msg.runId);if(entry){entry.value.nativeResult.error='Сессия остановлена.';if(entry.value.result)entry.value.result.error='Сессия остановлена.';}
   }
  }
  else if(msg.type==='approval'){try{const result=await applyApproval(msg);if(msg.approvalRequestId)send({type:'response',requestId:msg.requestId,result});}catch(error){if(msg.approvalRequestId)send({type:'response',requestId:msg.requestId,error:error.message,status:error.status===409?409:503});else log('Ответ на вопрос:',error.message);}}
  else if(msg.type==='result-ack')await acknowledgeResult(msg.runId);
  else if(msg.type==='result-unknown')await disownResult(msg.runId);
  else if(msg.type==='accounts'){try{const record=msg.action==='create'?await accounts.create(msg.provider,msg.name):null;send({type:'response',requestId:msg.requestId,result:{accounts:accounts.list(),accountsError:accounts.error||null,record}});lastStatus=0;void status().catch(()=>{});}catch(error){send({type:'response',requestId:msg.requestId,error:error.message});}}
  else if(msg.type==='login'){try{if([...jobs.values()].some(j=>j.msg.options.provider===msg.provider&&(j.msg.options.accountId||'')===(msg.accountId||'')))throw new Error('Этот аккаунт сейчас выполняет задачу. Дождись завершения перед входом.');const result=accounts.startLogin(msg.provider,msg.accountId,event=>{send(event);if(event.type==='login-complete'){send(heartbeatState());saveDiagnostics(true);lastStatus=0;void status(true).catch(error=>log('Проверка подписок после входа:',error.message));}});send(heartbeatState());saveDiagnostics(true);send({type:'response',requestId:msg.requestId,result});}catch(error){send({type:'response',requestId:msg.requestId,error:error.message});}}
 }catch(error){log('Ошибка:',error.message)}});
 socket.on('error',error=>{if(ws===socket){connectionReason=error.code||'network-error';log('Связь с пространством:',error.message);saveDiagnostics(true);}});
 socket.on('close',(code)=>{for(const request of hubRequests.values())if(request.socket===socket)request.finish(new Error('Связь временно потеряна.'));if(ws!==socket)return;if(code===4009)connectionReason='duplicate-connection';saveDiagnostics(true);if(!closing){log(code===4009?'Этот Mac уже подключён другим фоновым процессом. Повторю проверку позже.':'Восстанавливаю соединение. Работа и результаты сохраняются.',code);clearTimeout(reconnectTimer);const delay=code===4009?60000:retry;reconnectTimer=setTimeout(connect,delay+Math.floor(Math.random()*250));retry=Math.min(retry*2,10000);}});
}
const heartbeat=setInterval(()=>{
 if(storageLocation)void monitorStorage();
 updateKeepAwake();const stamp=Date.now(),afterSleep=stamp-lastHealthTick>45000;lastHealthTick=stamp;
 if(ws?.readyState===WebSocket.OPEN){
  if(afterSleep){connectionReason='wake-or-timer-pause';probeUntil=stamp+20000;log('Проверяю связь после сна.');}
  // Incoming application messages also prove liveness; control-frame pong is not required.
  if(probeUntil?stamp>probeUntil:stamp-lastReceived>60000){connectionReason='heartbeat-timeout';log('Переподключаюсь: сервер не ответил на проверку связи.');ws.terminate();return;}
  send(heartbeatState());ws.ping();
 }else if(afterSleep&&ws?.readyState!==WebSocket.CONNECTING){clearTimeout(reconnectTimer);connect();}
 if(skills.autoDiscovery===true&&Date.now()-lastSkillsScan>60000)void scanSkills().catch(()=>log('Скиллы: не удалось обновить список.'));
 if(mcp.autoDiscovery===true&&Date.now()-lastMcpScan>60000)void scanMcp().catch(()=>log('MCP: не удалось обновить список.'));
 void status().catch(error=>log('Проверка подписок:',error.message));
 for(const result of Object.values(outbox))sendPending(result);
 for(const job of jobs.values()){void replayJob(job);if(job.lastCheckpoint)sendPending(job.lastCheckpoint);else void checkpointJob(job);}
 saveDiagnostics();
},15000);heartbeat.unref();
connect();
function stop(signal){
 if(closing)return;recordProcessStop(signal||'stop-requested');closing=true;clearTimeout(reconnectTimer);clearInterval(heartbeat);finalizers.stop();keepAwakeProcess?.kill();
 for(const job of jobs.values()){clearTimeout(job.journalTimer);clearTimeout(job.agentTimer);job.controller.abort();}
 voice.close();accounts.close();ws?.close();
 const deadline=setTimeout(()=>process.exit(1),15000);
 void (async()=>{
  await finalizers.drain();
  for(const job of jobs.values()){clearTimeout(job.journalTimer);const entry=journal[job.msg.runId];if(entry){entry.text=job.text;entry.plan=job.plan;entry.nativeExecutionMode=job.nativeExecutionMode;entry.events=job.events;entry.agents=job.agents||[];entry.followups=Object.entries(job.steerOutcomes).map(([messageId,value])=>({messageId,...value}));}}
  await Promise.all([saveJournal(),save()]);clearTimeout(deadline);process.exit(0);
 })().catch(error=>{clearTimeout(deadline);log('Не удалось завершить сохранение перед остановкой:',error.code||'storage-error');process.exit(1);});
}
process.on('SIGINT',()=>stop('SIGINT'));process.on('SIGTERM',()=>stop('SIGTERM'));
