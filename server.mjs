import {cancelledRunsMissing} from './lib/cancelled-runs.mjs';
import http from 'node:http';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
const compress=promisify(gzip);
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {getHeapStatistics} from 'node:v8';
import {fileURLToPath} from 'node:url';
import {WebSocketServer} from 'ws';
import {HubUpdates} from './lib/hub-updates.mjs';
import {serveMacRelease} from './lib/mac-release.mjs';
import {createAdminDiagnostics} from './lib/admin-diagnostics.mjs';
import {SessionBoardStore,boardList,ownsBoardChat} from './lib/session-board.mjs';
import {versionUiDocument} from './lib/ui-assets.mjs';
import {NativeSessions} from './lib/native-sessions.mjs';
import {Providers,login} from './lib/providers.mjs';
import {ProviderAccounts,accountId} from './lib/provider-accounts.mjs';
import {continueConversation,sessionKey,finishSession} from './lib/conversation.mjs';
import {sessionContexts} from './lib/session-context.mjs';
import {recordCompletion,completionState,readCompletion} from './lib/completion-state.mjs';
import {orderedProjects,moveProject} from './lib/project-order.mjs';
import {prepareRemoteContext} from './lib/remote-context.mjs';
import {MAX_WORKSPACE_FILES,snapshot,changes,filePath,portablePath,isIgnoredPortablePath,digest,prepareContext,fileBatches,readFileBatch,MAX_FILE,MAX_TRANSFER,MAX_PROJECT,atomicProjectWrite} from './lib/workspace.mjs';
import {zip} from './lib/zip.mjs';
import {ProjectFiles,syncWorkspace,mergeChanges} from './lib/project-files.mjs';
import {readWorkspaceCleanupPlans} from './lib/workspace-cleanup.mjs';
import {serveSharedFile} from './lib/shared-file.mjs';
import {FileOpenLinks} from './lib/file-open.mjs';
import {Notifications,responseNeedsAnswer} from './lib/notifications.mjs';
import {VoiceDevice} from './lib/voice-device.mjs';
const fileOpenLinks=new FileOpenLinks();
import {checkpoint,parseMemory,summaryBatches,memoryPrompt,storeMemory,readAgentNotes,writeHandoff,messageKey} from './lib/memory.mjs';
import {quotaState,isUsageLimit,safeModel,memoryModel} from './lib/routing.mjs';
import {deletionPreview,stageDeletion} from './lib/chat-deletion.mjs';
import {projectDeletionPreview,movePreview,stageMoveFiles,stageProjectRemoval,recoverProjectRemovals} from './lib/project-lifecycle.mjs';
import {permissionMode} from './lib/permission-policy.mjs';
import {compactChat,actionView} from './lib/chat-view.mjs';
import {searchChats,forkChat,forkRequest,queuedFollowups,prepareFollowupOperation,applyFollowupOperation} from './lib/chat-tools.mjs';
import {FileReviews} from './lib/file-review.mjs';
import {coalescedSave} from './lib/coalesced-save.mjs';
import {ensureDailyStateBackup} from './lib/state-backup.mjs';
import {ActionDetailsStore} from './lib/action-details-store.mjs';
import {MessageJournal} from './lib/message-journal.mjs';
import {BrowserReplies,sendBrowserPacket} from './lib/browser-events.mjs';
import {applyAgentEvent,replaceAgents,finishAgents,agentSummary,validAgentId} from './lib/agent-progress.mjs';
import {RunProgress} from './lib/run-progress.mjs';
import {initializeTitle} from './lib/chat-titles.mjs';
import {TitleQueue} from './lib/title-queue.mjs';
import {createReadStream} from 'node:fs';
import {FileUploads,UPLOAD_CHUNK} from './lib/file-uploads.mjs';
import {IncomingResults,workspaceChunk} from './lib/result-transfer.mjs';
import {IncomingResultEnvelopes} from './lib/result-envelope.mjs';
import {TelegramAuth,RateLimiter,cookieValue,secureCookie,sameOrigin,securityHeaders,appCsp,fail,validMessageId} from './lib/security.mjs';
import {SkillStore,SkillDevice,SkillDiscovery,skillId,skillMetadata,skillPath} from './lib/skill-sync.mjs';
import {McpVault,McpDevice,discoverMcp,mcpName} from './lib/mcp-sync.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const appVersion=JSON.parse(await fs.readFile(new URL('./package.json',import.meta.url),'utf8')).version;
const storage=process.env.TEAM_ROOM_DATA_DIR||path.join(root,'storage','community-hub');
const fileReviews=new FileReviews(path.join(storage,'file-reviews'));
async function captureFileReview(kind,dir,chatId,runId,files){try{await fileReviews[kind](dir,chatId,runId,files);}catch{console.warn(JSON.stringify({event:'file-review-unavailable',kind,chatId,runId}));}}
const incomingResults=new IncomingResults(path.join(storage,'incoming-results'));
const incomingResultEnvelopes=new IncomingResultEnvelopes(path.join(storage,'incoming-result-envelopes'));
const oversizedRemoteResults=new Map();
const fileUploads=new FileUploads(path.join(storage,'browser-uploads'));
const uploadCleanup=setInterval(()=>void fileUploads.cleanup().catch(console.error),3600000);uploadCleanup.unref();
let shuttingDown=false,updateMaintenance=process.env.TEAM_ROOM_UPDATE_TRIAL==='1',writeRequests=0;
process.on('message',packet=>{if(packet?.type==='community-update-committed')updateMaintenance=false;else if(packet?.type==='community-update-rejected'){updateMaintenance=false;hubUpdates.phase='ready';hubUpdates.error=String(packet.message||'Обновление не установлено.');}});
const dataPath=path.join(storage,'team-data.json');
const port=Number(process.env.PORT||4173);const host=process.env.HOST||'127.0.0.1';
const now=()=>new Date().toISOString();const id=()=>crypto.randomUUID();const tokenHash=value=>digest(Buffer.from(value));
await fs.mkdir(storage,{recursive:true});
let data;try{data=JSON.parse(await fs.readFile(dataPath,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error;data={users:[],authSessions:[],inviteHash:null,project:{name:'Мой проект',description:''},tasks:[],memories:[],activity:[],conversations:[]};}
// Large tool-call details live in content-addressed files; memory keeps them inline.
const actionDetails=await new ActionDetailsStore(path.join(storage,'action-details')).init();const actionDetailsLoad=await actionDetails.load(data);
const loadedMemory=process.memoryUsage();console.log(JSON.stringify({event:'state-loaded',bytes:(await fs.stat(dataPath).catch(()=>null))?.size||0,actionDetails:actionDetailsLoad,heapUsedBytes:loadedMemory.heapUsed,heapLimitBytes:getHeapStatistics().heap_size_limit,rssBytes:loadedMemory.rss}));
let lastBackupDay='',messageSaveTimer;
const persist=coalescedSave(async()=>{
 const saveStarted=Date.now();
 const day=new Date().toISOString().slice(0,10);
 if(lastBackupDay!==day){await ensureDailyStateBackup(dataPath,{day});lastBackupDay=day;}
 // Serialize only the write being performed; queued events share the next save.
 clearTimeout(messageSaveTimer);messageSaveTimer=null;
 // Capture the applied journal prefix and state together, before any write awaits.
 // Later appends must survive pruning of this particular snapshot.
 const savedSequence=messageJournal.appliedSequence,savedCompletedRuns=[...data.completedRuns],savedCheckpointRevisions=Object.entries(data.pendingRemote).map(([runId,record])=>[runId,record.revision||0]),savedEventCoverage=captureRemoteEventCoverage();
 data.messageJournalSequence=savedSequence;const serializeStarted=Date.now(),prepared=actionDetails.prepare(data),json=JSON.stringify(prepared.value),serializeMs=Date.now()-serializeStarted;
 // Spilled details must be durable before the state that references them.
 await actionDetails.flush(prepared.pending);
 const handle=await fs.open(dataPath+'.tmp','w',0o600);try{await handle.writeFile(json);await handle.sync();}finally{await handle.close();}await fs.rename(dataPath+'.tmp',dataPath);
 const directory=await fs.open(storage,'r');try{await directory.sync();}finally{await directory.close();}
 durableCompletedRuns=new Set(savedCompletedRuns);
 durableCheckpointRevisions=new Map(savedCheckpointRevisions);
 durableEventCoverage=savedEventCoverage;
 await messageJournal.checkpoint(savedSequence).catch(()=>console.error('Основная база сохранена; очистка журнала сообщений будет повторена.'));
 if(Date.now()-saveStarted>=250)console.log(JSON.stringify({event:'state-saved',characters:json.length,spilledDetails:prepared.spilled,serializeMs,elapsedMs:Date.now()-saveStarted}));
});
data.providerLimits||={};data.integrationTokens||=[];data.settings||={autoMemory:true,autoSwitch:false};data.titleWorkspaceId||=id();data.suppressedMemoryKeys||=[];data.authSessions||=[];data.devices||=[];data.pendingRemote||={};data.completedRuns||=[];data.conversations||=[];data.projects||=[{id:id(),...data.project,createdAt:now()}];data.tasks||=[];data.memories||=[];data.activity||=[];
let durableCompletedRuns=new Set(data.completedRuns);
let durableCheckpointRevisions=new Map(Object.entries(data.pendingRemote).map(([runId,record])=>[runId,record.revision||0]));
let durableEventCoverage=captureRemoteEventCoverage();
function captureRemoteEventCoverage(){
 return new Map(Object.entries(data.pendingRemote).map(([runId,pending])=>{
  const message=data.conversations.find(chat=>chat.id===pending.chatId)?.messages?.find(message=>message.id===pending.messageId);
  const through=Number.isSafeInteger(message?.remoteSeq)&&message.remoteSeq>0?message.remoteSeq:0;
  const seqs=[...new Set((Array.isArray(message?.remoteEventSeqs)?message.remoteEventSeqs:[]).filter(seq=>Number.isSafeInteger(seq)&&seq>through))].sort((a,b)=>a-b);
  return [runId,{through,seqs}];
 }));
}
function savedRemoteEventCoverage(runId){const saved=durableEventCoverage.get(runId);return saved?{through:saved.through,seqs:[...saved.seqs]}:{through:0,seqs:[]};}
const replayedMessages=[],messageCommits=new Map(),pendingChatCreates=new Map(),pendingForks=new Map(),pendingForkSources=new Map(),queueMutations=new Map(),queueResumes=new Map();
const messageJournal=new MessageJournal(path.join(storage,'message-journal'),{sequence:data.messageJournalSequence||0});
await messageJournal.init(operation=>applyMessageOperation(operation,true));
function applyMessageOperation(operation,replaying=false){
 if(!operation||typeof operation!=='object')throw new Error('Некорректная запись журнала сообщений.');
 if(operation.type==='chat-create'){
  const chat=operation.chat;
  if(!chat||typeof chat.id!=='string'||typeof chat.projectId!=='string'||!Array.isArray(chat.messages)||chat.messages.length)throw new Error('Некорректное создание чата в журнале.');
  if(!data.projects.some(p=>p.id===chat.projectId)||data.conversations.some(c=>c.id===chat.id))return false;
  data.conversations.unshift(structuredClone(chat));return true;
 }
 if(!['message-accept','message-sending','followup-edit','followup-reorder'].includes(operation.type)||typeof operation.chatId!=='string'||typeof operation.projectId!=='string')throw new Error('Неизвестная запись журнала сообщений.');
 const chat=data.conversations.find(c=>c.id===operation.chatId&&c.projectId===operation.projectId);
 // A newer durable deletion, move, or archive must never be undone by replay.
 if(!chat||chat.archivedAt||!data.projects.some(p=>p.id===chat.projectId))return false;
 chat.messages||=[];
 if(['followup-edit','followup-reorder'].includes(operation.type))return applyFollowupOperation(chat,operation);
 if(operation.type==='message-sending'){
  if(typeof operation.messageId!=='string'||typeof operation.runId!=='string')throw new Error('Некорректная доставка в журнале.');
  const message=chat.messages.find(m=>m.id===operation.messageId&&m.followup&&m.afterRunId===operation.runId);
  if(!message||!['queued','sending'].includes(message.delivery))return false;
  message.delivery='sending';return true;
 }
 const message=operation.message;
 if(!message||typeof message.id!=='string'||message.role!=='user'||typeof message.text!=='string'||message.text.length>100000||!Array.isArray(message.attachments))throw new Error('Некорректное сообщение в журнале.');
 if(chat.messages.some(m=>m.id===message.id))return false;
 chat.messages.push(structuredClone(message));chat.updatedAt=message.createdAt;
 if(operation.userId&&data.users.some(u=>u.id===operation.userId))chat.notificationUsers=[...new Set([...(chat.notificationUsers||[]),operation.userId])];
 if(operation.options){
  chat.route=structuredClone(operation.options);
  chat.executionDeviceId=chat.pendingRoute?.deviceId||operation.options.deviceId;
  chat.pendingSubmission={messageId:message.id,userId:operation.userId,createdAt:message.createdAt};
  if(chat.importSource)chat.importSource.watch=false;
  for(const id of operation.options.queuedMessageIds||[]){const queued=chat.messages.find(m=>m.id===id&&m.followup&&m.delivery==='queued');if(queued){queued.delivery='dispatching';queued.status='completed';delete queued.rejectedRunId;}}
  if(replaying)replayedMessages.push({chatId:chat.id,messageId:message.id});
 }
 return true;
}
function scheduleMessageSnapshot(delay=750){
 if(shuttingDown||messageSaveTimer)return;
 messageSaveTimer=setTimeout(()=>{messageSaveTimer=null;void persist().catch(()=>{console.error('Журнал сообщений сохранён; обновление основной базы будет повторено.');scheduleMessageSnapshot(5000);});},delay);messageSaveTimer.unref();
}
function pendingMessageCount(chatId){let count=0;for(const pending of messageCommits.values())if(pending.chatId===chatId)count++;return count;}
async function acceptedMessageExists(chat,messageId){
 if(!messageId)return false;
 const pending=messageCommits.get(chat.id+':'+messageId);if(pending)await pending.promise;
 return chat.messages.some(m=>m.id===messageId);
}
function commitAcceptedMessage(chat,operation){
 const key=chat.id+':'+operation.message.id,existing=messageCommits.get(key);
 if(existing)return existing.promise;
 if(chat.messages.some(m=>m.id===operation.message.id))return Promise.resolve({sequence:messageJournal.appliedSequence,bytes:0,duplicate:true});
 const promise=messageJournal.commit(operation,entry=>applyMessageOperation(entry));
 const pending={chatId:chat.id,promise};messageCommits.set(key,pending);
 return promise.finally(()=>{if(messageCommits.get(key)===pending)messageCommits.delete(key);});
}
// Preserve device-era display names, while accepting an unambiguous short login.
for(const user of data.users){const short=user.name?.match(/^(.+)\s+(?:Mac|Windows)$/i)?.[1]?.trim();if(short&&!data.users.some(other=>other.id!==user.id&&(other.name.toLocaleLowerCase()===short.toLocaleLowerCase()||(other.loginAliases||[]).some(a=>a.toLocaleLowerCase()===short.toLocaleLowerCase())))){user.loginAliases=[...new Set([...(user.loginAliases||[]),short])];}}
function findAccount(name){const key=String(name||'').trim().normalize('NFC').toLocaleLowerCase();return data.users.find(u=>u.name.normalize('NFC').toLocaleLowerCase()===key||(u.loginAliases||[]).some(a=>a.normalize('NFC').toLocaleLowerCase()===key));}
const defaultProject=data.projects[0].id;
await recoverProjectRemovals(storage,data.projects);
if(data.inviteHash&&!data.inviteExpiresAt)data.inviteExpiresAt=Date.now()+7*86400000;
const telegramAuth=await new TelegramAuth({storage}).init();if(data.telegramRequired&&!telegramAuth.status().telegramEnabled)throw new Error('Telegram configuration is missing. Restore security-config.json and security-key; password fallback is disabled.');const securityLimits=new RateLimiter();
// Uploads share the volume with team-data.json; a full disk would stop every save.
const VOLUME_RESERVE=2*1024*1024*1024;
async function ensureVolumeSpace(dir,bytes){const stat=await fs.statfs(dir).catch(()=>null);if(!stat)return;const free=Number(stat.bavail)*Number(stat.bsize);if(free-Math.max(0,Number(bytes)||0)<VOLUME_RESERVE)throw fail(507,'На сервере заканчивается место. Файл не сохранён, чтобы не повредить базу.');}

// Behind Railway every request arrives from the edge proxy, so the socket address
// is shared by the whole team. The edge appends the real client as the last
// X-Forwarded-For entry; earlier entries are client-controlled and ignored.
const trustProxy=Boolean(process.env.RAILWAY_ENVIRONMENT||process.env.TEAM_ROOM_TRUST_PROXY==='1');
function clientAddress(req){if(trustProxy){const forwarded=String(req.headers['x-forwarded-for']||'').split(',').map(value=>value.trim()).filter(Boolean).at(-1);if(forwarded&&forwarded.length<=64&&/^[0-9a-fA-F:.]+$/.test(forwarded))return forwarded;}return req.socket.remoteAddress||'unknown';}

const mcpVault=await new McpVault(storage).init();const skillStore=await new SkillStore(path.join(storage,'skill-store'),{keyPath:path.join(storage,'security-key')}).init();
const secureSite=Boolean(process.env.RAILWAY_PUBLIC_DOMAIN||process.env.PUBLIC_URL?.startsWith('https:'));
const canonicalOrigin=process.env.PUBLIC_URL?new URL(process.env.PUBLIC_URL).origin:process.env.RAILWAY_PUBLIC_DOMAIN?'https://'+process.env.RAILWAY_PUBLIC_DOMAIN:null;
const ownerId=data.users[0]?.id;const isOwner=user=>user?.id===(ownerId||data.users[0]?.id);
function requireOwner(user){if(!isOwner(user))throw fail(403,'Эту настройку меняет только владелец пространства.');}
const runProgress=await new RunProgress(storage).init();await runProgress.recover(data);
let sessionBoardStore;try{sessionBoardStore=await new SessionBoardStore(storage).init();}catch{console.warn(JSON.stringify({event:'session-board-unavailable'}));}
for(const c of data.conversations){
 if(!c.ownerId){const owners=data.users.filter(user=>user.name===c.owner);if(owners.length===1)c.ownerId=owners[0].id;}
 c.projectId||=defaultProject;c.title||='Сохранённый чат';c.messages||=[];initializeTitle(c);c.messages.forEach(m=>{m.id||=id();m.provider||=c.provider;m.status||='completed'});
 c.executionDeviceId||=c.pendingRoute?.deviceId||c.route?.deviceId||c.importSource?.deviceId||c.run?.deviceId||null;
 if(!c.run){const entry=Object.entries(data.pendingRemote).find(([,p])=>p.chatId===c.id);if(entry)c.run={id:entry[0],deviceId:entry[1].deviceId,provider:entry[1].provider};}
 if(c.run){
  const pending=data.pendingRemote[c.run.id];
  if(pending&&pending.chatId===c.id&&data.devices.some(d=>d.id===pending.deviceId)){
   // The remote worker owns execution. Reconnect to that exact run instead of
   // cancelling it or launching the model again after a hub restart.
   c.run.phase='reconnecting';c.run.connectionLost=true;c.run.recovering=true;c.run.text='Восстанавливаю связь с выполняющейся задачей…';
  }else{c.run=null;for(const m of c.messages)if(m.status==='running'){m.status='interrupted';m.error='Приложение перезапустилось. Сохранённую работу можно продолжить любым провайдером.';finishAgents(m,m.status)}}
 }
 if(!c.run?.recovering)c.approvals=[];
}
for(const c of data.conversations)for(const m of c.messages)if(['sending','received','dispatching'].includes(m.delivery)&&!(c.run?.recovering&&m.afterRunId===c.run.id)){m.delivery='uncertain';m.status='pending';m.deliveryDetail='Приложение перезапустилось до подтверждения доставки.';}
// Acceptance alone is never authority to repeat a native run after a crash.
// Show a recoverable start failure only when no later assistant/run was saved.
for(const accepted of [...replayedMessages,...data.conversations.filter(c=>c.pendingSubmission).map(c=>({chatId:c.id,messageId:c.pendingSubmission.messageId}))]){
 const chat=data.conversations.find(c=>c.id===accepted.chatId);if(!chat||chat.run?.recovering)continue;
 const index=chat.messages.findIndex(m=>m.id===accepted.messageId);
 if(index>=0&&!chat.messages.slice(index+1).some(m=>m.role==='assistant'))chat.messages.push({id:id(),role:'assistant',provider:chat.route?.provider||chat.provider,text:'',status:'interrupted',error:'Сообщение сохранено. Приложение перезапустилось до подтверждения запуска; сохранённую задачу можно продолжить.',createdAt:now()});
 delete chat.pendingSubmission;
}
for(const x of [...data.tasks,...data.memories])x.projectId||=defaultProject;
await persist();await runProgress.clearRecovered();
const providers=new Providers();const accounts=await new ProviderAccounts(path.join(storage,'storage','local-accounts'),providers).init();const nativeSessions=new NativeSessions(providers);const events=new Set();const bridges=new Map();const requests=new Map();const active=new Map();const chatLaunches=new Map();const chatLocks=new Set();const dispatchDevices=new Map();const projectFiles=new ProjectFiles();const loginProcesses=new Map();const catalogs=new Map();
const hubOnly=process.env.TEAM_ROOM_HUB_ONLY!=='0';const localId='local';const localName=process.env.DEVICE_NAME||os.hostname();
const localVoice=hubOnly?null:new VoiceDevice(storage);const voiceRequests=new Set();
const notifications=await new Notifications(storage,{sessions:()=>data.authSessions,users:()=>data.users,origin:canonicalOrigin||`http://127.0.0.1:${port}`,alive:event=>{const c=data.conversations.find(c=>c.id===event.chatId);if(!c)return false;if(event.demoUser)return true;if(event.approvalId)return c.approvals?.some(a=>a.id===event.approvalId);return c.messages?.some(m=>m.id===event.messageId)&&!c.messages.some(m=>m.role==='user'&&Date.parse(m.createdAt)>Date.parse(event.at));}}).init();
const hubUpdates=await new HubUpdates({storage,version:appVersion,managed:process.env.TEAM_ROOM_MANAGED_UPDATES==='1'&&Boolean(process.send),idle:()=>!active.size&&!chatLaunches.size&&!chatLocks.size&&!requests.size&&!Object.keys(data.pendingRemote).length&&!messageCommits.size&&!fileUploads.queues.size&&!voiceRequests.size&&!memoryJobs.size&&!importLocks.size&&!importingChats.size&&!deletingProjects.size&&!deletingChats.size&&!projectDeleting.size&&!importRefreshBusy&&!accounts.logins.size&&!loginProcesses.size&&![...bridges.values()].some(ws=>ws.loginBusy||ws.accounts?.some(account=>account.loginBusy)||ws.skills?.importing)&&writeRequests<=1}).init();
let updateTimer;if(process.env.TEAM_ROOM_DISABLE_UPDATE_CHECKS!=='1'){updateTimer=setInterval(()=>void hubUpdates.check(),6*3600000);updateTimer.unref();const first=setTimeout(()=>void hubUpdates.check(),20000);first.unref();}
function notifyChat(chat,kind,message,extra={}){const event={id:extra.approvalId?'approval:'+extra.approvalId:kind+':'+message.id,kind,chatId:chat.id,projectId:chat.projectId,messageId:message.id,provider:message.provider,title:String(chat.title||'Чат').slice(0,100),userIds:[...new Set([...(chat.notificationUsers||[]),...data.users.filter(u=>u.name===chat.owner).map(u=>u.id)])],at:now(),...extra};void notifications.enqueue(event).catch(()=>console.error('Не удалось сохранить уведомление.'));}

let localSkills=null,localSkillDiscovery=null;if(!hubOnly){localSkills=await new SkillDevice(path.join(storage,'storage','local-skills'),{loadBlob:hash=>skillStore.blob(hash)}).init();providers.skills=localSkills;localSkillDiscovery=new SkillDiscovery({codexList:()=>providers.skillList()});await localSkills.apply(skillStore.snapshot());}
function pushSkills(){const snapshot=skillStore.snapshot();for(const ws of bridges.values())if(ws.skillsSyncVersion===1){out(ws,{type:'skills-sync',snapshot});ws.skillsSentRevision=snapshot.revision;}if(localSkills)void localSkills.apply(snapshot).then(()=>changed()).catch(()=>{});}
async function scanLocalSkills(){if(localSkillDiscovery){const report=await localSkillDiscovery.scan();if(await skillStore.publish('local',report,(id,hash,paths)=>localSkillDiscovery.export(id,hash,paths))){pushSkills();changed();}}}
if(localSkillDiscovery){void scanLocalSkills().catch(()=>{});const timer=setInterval(()=>void scanLocalSkills().catch(()=>{}),60000);timer.unref();}
let localMcp=null;if(!hubOnly){localMcp=await new McpDevice(path.join(storage,'storage','local-mcp')).init();providers.mcp=localMcp;await localMcp.apply(mcpVault.snapshot());}
function pushMcp(){const snapshot=mcpVault.snapshot();for(const ws of bridges.values())if(ws.mcpSyncVersion===1){out(ws,{type:'mcp-sync',snapshot});ws.mcpSentRevision=snapshot.revision;}if(localMcp)void localMcp.apply(snapshot).then(()=>changed()).catch(()=>{});}
async function scanLocalMcp(){if(!localMcp)return;const report=await discoverMcp({codexList:()=>providers.mcpList()});if(await mcpVault.publish('local',report))pushMcp();}
if(!hubOnly){void scanLocalMcp().catch(()=>{});const timer=setInterval(()=>void scanLocalMcp().catch(()=>{}),60000);timer.unref();}
const projectById=value=>{const project=value?data.projects.find(p=>p.id===value):data.projects[0];if(!project)throw fail(404,'Проект не найден.');if(projectDeleting.has(project.id))throw fail(409,'Проект удаляется. Подожди несколько секунд.');return project;};
const workspace=p=>path.join(storage,'storage','projects',p.id);
const portableFiles=files=>files.filter(file=>!isIgnoredPortablePath(file?.path));
const resultFiles=(before,delta)=>{const files=new Map(portableFiles(before).map(f=>[f.path,f]));for(const f of portableFiles(delta?.deleted||[]))files.delete(f.path);for(const {content,...f} of portableFiles(delta?.changed||[]))files.set(f.path,f);return [...files.values()];};
const sessionWorkspace=chat=>path.join(storage,'storage','sessions',chat.projectId,chat.id);
const parallelReady=deviceId=>deviceId===localId||bridges.get(deviceId)?.protocolVersion>=6;
function checkPermissions(deviceId,mode){const selected=permissionMode(mode);if(selected!=='manual'&&deviceId!==localId&&bridges.get(deviceId)?.permissionsVersion!==1)throw fail(426,'Обнови Team Room на выбранном Mac, затем нажми «Этот Mac → Обновить подключение». Эта версия подключения ещё не поддерживает режимы разрешений.');return selected;}
function executionMode(deviceId,value='build'){
 if(!['build','plan'].includes(value))throw fail(400,'Выбери работу или планирование.');
 if(value==='plan'&&deviceId!==localId&&bridges.get(deviceId)?.executionModeVersion!==1)throw fail(426,'Для режима планирования обнови Team Room на выбранном Mac и его подключение.');
 return value;
}
const selectedExecutionMode=(deviceId,input,current)=>executionMode(deviceId,input.executionMode===undefined?current||'build':input.executionMode);
function legacyBusy(chat,deviceId){return !parallelReady(deviceId)&&[...chatLocks].some(chatId=>chatId!==chat.id&&(active.get(chatId)?.deviceId||dispatchDevices.get(chatId))===deviceId&&data.conversations.find(c=>c.id===chatId)?.projectId===chat.projectId);}
function syncNotice(chat,message,result){if(message){message.fileOverrides||={};for(const name of result.changedPaths||[])if(!Object.hasOwn(result.overrides,name))delete message.fileOverrides[name];Object.assign(message.fileOverrides,result.overrides);if(!result.conflicts.length&&!Object.keys(message.fileOverrides).length)delete message.syncWarning;}if(result.conflicts.length){chat.syncWarning='Две сессии изменили один файл. Общая версия сохранена; версия этого ответа доступна в _conflicts.';if(message)message.syncWarning=chat.syncWarning;}}
const scrypt=promisify(crypto.scrypt);
async function hash(value,salt=crypto.randomBytes(16).toString('hex')){return {salt,hash:(await scrypt(value,salt,64)).toString('hex')}}
async function matches(value,saved){if(!saved||typeof value!=='string'||value.length>1024)return false;const a=Buffer.from((await hash(value,saved.salt)).hash,'hex'),b=Buffer.from(saved.hash,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)}
const validInvite=value=>data.inviteHash&&(!data.inviteExpiresAt||data.inviteExpiresAt>Date.now())?matches(value,data.inviteHash):Promise.resolve(false);
function currentUser(req){const token=cookieValue(req,'trc_session');const session=token&&data.authSessions.find(s=>s.tokenHash===tokenHash(token)&&s.expiresAt>Date.now());return session&&data.users.find(u=>u.id===session.userId)}
async function issueSession(user){const token=crypto.randomBytes(32).toString('hex');data.authSessions=data.authSessions.filter(s=>s.expiresAt>Date.now());data.authSessions.push({tokenHash:tokenHash(token),userId:user.id,expiresAt:Date.now()+30*86400000});await persist();return secureCookie('trc_session',token,2592000,secureSite)}
function publicChat(c,user){return {...completionState(c,user?.id),id:c.id,revision:c.revision||0,title:c.title,projectId:c.projectId,owner:c.owner,provider:c.provider,kind:c.kind||null,fork:c.fork||null,executionDeviceId:c.executionDeviceId||c.route?.deviceId||null,deviceName:data.devices.find(d=>d.id===c.executionDeviceId)?.name||c.deviceName,updatedAt:c.updatedAt,createdAt:c.createdAt,messageCount:c.messages.length,archivedAt:c.archivedAt||null,run:c.run||null,lastError:c.messages.at(-1)?.error||null,memoryStatus:c.memory?.status||'pending',checkpointAt:c.checkpoint?.updatedAt||null,sessionContexts:sessionContexts(c)}}
const contextChats=chat=>data.conversations.filter(c=>c.projectId===chat.projectId&&(c.kind!=='side'||c.id===chat.id));
const noFileChanges=()=>({conflicts:[],overrides:{},changedPaths:[]});
async function createFork(source,input,user){
 const request=forkRequest(source,input,user),key=request?user.id+':'+request.requestId:id();
 const existing=request&&data.conversations.find(c=>c.fork?.requestId===request.requestId&&c.fork.userId===user.id);
 if(existing){if(existing.fork.key!==request.key)throw fail(409,'Этот запрос уже создал другое ответвление.');return existing;}
 const pending=pendingForks.get(key);if(pending){if(pending.request?.key!==request?.key)throw fail(409,'Этот запрос уже создаёт другое ответвление.');return pending.promise;}
 const projectId=source.projectId;
 pendingChatCreates.set(projectId,(pendingChatCreates.get(projectId)||0)+1);pendingForkSources.set(source.id,(pendingForkSources.get(source.id)||0)+1);
 const promise=(async()=>{
  if(shuttingDown)throw fail(503,'Приложение перезапускается. Повтори создание ответвления.');
  const project=projectById(projectId);
  if(deletingProjects.has(projectId)||deletingChats.has(source.id)||!data.conversations.includes(source))throw fail(409,'Исходная сессия сейчас меняется.');
  const files=await projectFiles.run(projectId,()=>snapshot(workspace(project)));
  if(shuttingDown||source.projectId!==projectId||!data.projects.includes(project)||!data.conversations.includes(source)||deletingChats.has(source.id))throw fail(409,'Исходная сессия изменилась. Повтори создание ответвления.');
  const chat=forkChat(source,input,user,files);chat.ownerId=user.id;if(request)Object.assign(chat.fork,request);checkpoint(chat,chat.files,'fork');data.conversations.unshift(chat);
  try{await persist()}catch(error){data.conversations=data.conversations.filter(c=>c!==chat);throw error;}
  changed(chat);return chat;
 })();pendingForks.set(key,{request,promise});
 try{return await promise;}finally{pendingForks.delete(key);for(const [map,id]of [[pendingChatCreates,projectId],[pendingForkSources,source.id]]){const count=(map.get(id)||1)-1;if(count)map.set(id,count);else map.delete(id);}}
}
function devices(){return [...(hubOnly?[]:[{id:localId,name:localName,owner:'Этот компьютер',online:true,local:true,mcpSyncVersion:1,mcp:localMcp?.info,skillsSyncVersion:1,skills:localSkills?.info,voiceVersion:1,executionModeVersion:1,permissionsVersion:1,accountsVersion:1,agentMonitorVersion:1,accounts:accounts.list(),accountsError:accounts.error||null}]),...data.devices.map(d=>({id:d.id,name:d.name,owner:d.owner,online:Boolean(bridges.get(d.id)?.readyState===1)&&!importMaintenance(d.id),maintenance:Boolean(importMaintenance(d.id)),lastSeen:d.lastSeen,executionModeVersion:bridges.get(d.id)?.executionModeVersion||0,permissionsVersion:bridges.get(d.id)?.permissionsVersion||0,connectorVersion:bridges.get(d.id)?.connectorVersion||null,agentMonitorVersion:bridges.get(d.id)?.agentMonitorVersion||0,fileTransferVersion:bridges.get(d.id)?.fileTransferVersion||0,liveInputVersion:bridges.get(d.id)?.liveInputVersion||0,voiceVersion:bridges.get(d.id)?.voiceVersion||0,accountsVersion:bridges.get(d.id)?.accountsVersion||0,accountsError:bridges.get(d.id)?.accountsError||null,accounts:bridges.get(d.id)?.accounts||d.accounts||[],status:bridges.get(d.id)?.status||null,statusCheckedAt:bridges.get(d.id)?.statusAt||null,mcpSyncVersion:bridges.get(d.id)?.mcpSyncVersion||0,mcp:bridges.get(d.id)?.mcp||null,skillsSyncVersion:bridges.get(d.id)?.skillsSyncVersion||0,skills:bridges.get(d.id)?.skills||null}))]}
function safeState(user){return {me:{id:user.id,name:user.name,owner:isOwner(user)},security:telegramAuth.status(),settings:data.settings,updates:{current:appVersion,available:hubUpdates.status().available,version:hubUpdates.status().version},members:data.users.map(({id,name})=>({id,name})),projects:orderedProjects(data.projects,user.projectOrder),project:orderedProjects(data.projects,user.projectOrder)[0],chats:data.conversations.map(c=>publicChat(c,user)),tasks:data.tasks,memories:data.memories,devices:devices()}}
function knownExecutionDevice(value){
 if(value==null||value==='')return null;
 if(typeof value!=='string'||value!==localId&&!data.devices.some(d=>d.id===value)||value===localId&&hubOnly)throw fail(400,'Выбери зарегистрированный компьютер для работы.');
 return value;
}
function chatExecutionDevice(chat){return chat.pendingRoute?.deviceId||chat.executionDeviceId||chat.route?.deviceId||chat.importSource?.deviceId||data.projects.find(p=>p.id===chat.projectId)?.executionDeviceId||(!hubOnly?localId:null);}
function executionAccount(deviceId,provider,value){
 const profile=accountId(value);
 if(profile&&deviceId!==localId&&bridges.get(deviceId)?.readyState!==1){if(!data.devices.find(d=>d.id===deviceId)?.accounts?.some(a=>a.id===profile&&a.provider===provider))throw fail(409,'Этот аккаунт ещё не известен пространству. Подключи Mac или выбери основной аккаунт.');return profile;}
 return selectedAccount(deviceId,provider,profile);
}
function out(ws,value,serialized){if(ws?.readyState===1){try{ws.send(serialized??JSON.stringify(value));return true}catch{}}return false}
const browserReplies=new BrowserReplies();
function broadcast(value){if(value.type==='delta')return browserReplies.broadcast(value,events,validBrowserSession);if(value.type==='reply-complete')browserReplies.complete(value);const packet=JSON.stringify(value);for(const ws of events)if(validBrowserSession(ws))sendBrowserPacket(ws,packet);else ws.close(4001,'Вход завершён');}
function changed(chat){if(chat)chat.revision=(chat.revision||0)+1;broadcast({type:'state',chatId:chat?.id});}
function boardChanged(userId){const packet=JSON.stringify({type:'board-changed'});for(const ws of events)if(validBrowserSession(ws)&&data.authSessions.some(s=>s.tokenHash===ws.sessionHash&&s.userId===userId))sendBrowserPacket(ws,packet);}
function acceptsGzip(req){return String(req?.headers['accept-encoding']||'').split(',').some(value=>{const [name,...params]=value.trim().split(';');return name==='gzip'&&!params.some(param=>/^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(param));});}
function send(res,status,body,headers={}){
 const bytes=Buffer.from(JSON.stringify(body));
 const finish=(output,compressed=false)=>{if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','vary':'Accept-Encoding','content-length':output.length,...(compressed?{'content-encoding':'gzip'}:{}),...headers});res.end(output);};
 if(bytes.length>=1024&&acceptsGzip(res.req))gzip(bytes,(error,output)=>error?finish(bytes):finish(output,true));else finish(bytes);
}
async function readBody(req,limit=1000000){if(Number(req.headers['content-length'])>limit)throw fail(413,'Файл или запрос слишком большой.');const buffers=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('Файл или запрос слишком большой.'),{status:413});buffers.push(chunk)}return Buffer.concat(buffers)}
async function jsonBody(req){const b=await readBody(req);let value;try{value=b.length?JSON.parse(b):{};}catch{throw fail(400,'Некорректный JSON запроса.');}if(!value||typeof value!=='object'||Array.isArray(value))throw fail(400,'Ожидался объект JSON.');return value}
function requestDevice(deviceId,type,payload={},timeout=65000,signal,requestId=id(),maintenanceLeaseId=null){
 signal?.throwIfAborted();const lease=importMaintenance(deviceId);if(lease&&!(type==='run-state'&&maintenanceLeaseId===lease.id))throw fail(409,'Этот Mac обновляет перенос сессий. Подожди несколько секунд.');const ws=bridges.get(deviceId);if(!ws||ws.readyState!==1)throw fail(503,'Этот компьютер отключён. Дождись восстановления связи и повтори действие.');
 return new Promise((resolve,reject)=>{
  let timer,settled=false;const started=Date.now();const finish=(error,value)=>{if(settled)return;settled=true;if(error&&type.startsWith('workspace-'))console.warn(JSON.stringify({event:'workspace-failed',type,requestId,deviceId,elapsedMs:Date.now()-started,status:error.status||null,connected:ws.readyState===1,bufferedBytes:ws.bufferedAmount}));clearTimeout(timer);requests.delete(requestId);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
  const abort=()=>finish(fail(409,'Сессия остановлена.'));timer=setTimeout(()=>finish(fail(504,'Компьютер не подтвердил действие вовремя. Дождись восстановления связи и повтори.')),timeout);
  const packet={type,...payload,requestId},serialized=JSON.stringify(packet);const sentAt=Date.now();if(type.startsWith('workspace-'))console.log(JSON.stringify({event:'workspace-request',type,requestId,deviceId,fileCount:payload.files?.length,bytes:Buffer.byteLength(serialized),bufferedBytes:ws.bufferedAmount}));requests.set(requestId,{resolve:value=>{if(type.startsWith('workspace-'))console.log(JSON.stringify({event:'workspace-confirmed',type,requestId,deviceId,elapsedMs:Date.now()-sentAt}));finish(null,value)},reject:error=>finish(error),timer,deviceId,packet,serialized,sentAt});signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)return abort();if(!out(ws,packet,serialized))finish(fail(503,'Этот компьютер отключён. Повтори действие после восстановления связи.'));
 });
}
// Reconcile delivery by run ID. An accepted job is never automatically executed again.
function acceptRemote(record){if(!record.remoteAccepted)console.log(JSON.stringify({event:'run-accepted',runId:record.id,deviceId:record.deviceId,startDelayMs:record.dispatchedAt?Date.now()-record.dispatchedAt:null}));record.remoteAccepted=true;record.workerSeen=Date.now();record.missingHeartbeats=0;if(data.pendingRemote[record.id])data.pendingRemote[record.id].runAccepted=true;delete record.remotePacket;delete record.remotePacketSerialized;
 // Legacy inline contents are confirmed only once the Mac accepts the packet.
 // Progress is advisory and must never fail an already accepted native turn.
 if(record.transferInline){delete record.transferInline;const chat=data.conversations.find(chat=>chat.id===record.chatId);if(chat?.run?.id===record.id&&record.transferLedger?.direction==='download')try{for(const file of record.transferLedger.files?.values()||[])acknowledgeTransferFile(chat,record,file,file.size);finalizeTransferProgress(chat,record);}catch{console.warn(JSON.stringify({event:'transfer-progress-unavailable',runId:record.id}));}}
}
function restoreWorker(record){if(bridges.get(record.deviceId)?.runRecoveryVersion!==1){record.needsSnapshot=false;if(record.message){record.message.remoteSeq=record.lastSeq||record.message.remoteSeq||0;delete record.message.remoteEventSeqs;}}const chat=data.conversations.find(c=>c.id===record.chatId);if(chat?.run?.connectionLost){delete chat.run.connectionLost;if(bridges.get(record.deviceId)?.runRecoveryVersion!==1&&record.activity?.phase==='reconnecting'){record.activity={phase:'running',text:'Продолжает работу…'};delete chat.run.recovering;}refreshRunActivity(chat,record);delete record.textBeforeDisconnect;changed(chat);}}
function reconcileWorker(device,ws,msg){
 const running=new Set(msg.running||[]),results=new Set(msg.results||[]);ws.pendingResultIds=results;
 if(ws.protocolVersion>=5){
  ws.cancelledMissing||=new Map();
  const failedRuns=new Set();
  for(const [runId,pending]of Object.entries(data.pendingRemote))if(pending.deviceId===device.id){
   const chat=data.conversations.find(c=>c.id===pending.chatId),message=chat?.messages.find(m=>m.id===pending.messageId),record=chat&&active.get(chat.id);
   if(message&&['failed','interrupted'].includes(message.status)&&(!record||record.id!==runId||record.restored))failedRuns.add(runId);
  }
  for(const runId of cancelledRunsMissing(data.pendingRemote,device.id,running,results,ws.cancelledMissing,failedRuns)){
   const pending=data.pendingRemote[runId],chat=data.conversations.find(c=>c.id===pending?.chatId),message=chat?.messages.find(m=>m.id===pending?.messageId);
   if(!pending||!chat||!message)continue;
   // Preserve already received text/files. Absence is not permission to rerun tools.
   void serialRemote(runId,()=>recoverRemoteResult(device,ws,{type:'turn-result',workerAbsent:true,runId,text:message.text||'',error:pending.cancelRequested?'Остановка подтверждена компьютером. Уже полученные ответы и файлы сохранены.':'Компьютер подтвердил отсутствие прежнего запуска и очереди результатов. Можно продолжить сессию.',changes:{changed:[],deleted:[]}})).catch(console.error);
  }
 }
 const transfers=new Map((Array.isArray(msg.resultTransfers)?msg.resultTransfers:[]).filter(t=>t&&typeof t.runId==='string'&&Number.isSafeInteger(t.bytes)&&Number.isSafeInteger(t.total)&&t.bytes>=0&&t.total>=t.bytes).map(t=>[t.runId,t]));
 for(const [runId,pending]of Object.entries(data.pendingRemote))if(pending.deviceId===device.id&&pending.cancelRequested&&running.has(runId))out(ws,{type:'abort',runId});
 for(const record of active.values())if(record.deviceId===device.id&&!record.closing){
  restoreWorker(record);
  if(running.has(record.id)||results.has(record.id)){
   acceptRemote(record);if(record.needsSnapshot)void restoreRunSnapshot(device,ws,record);
   const transfer=transfers.get(record.id),chat=data.conversations.find(c=>c.id===record.chatId);
   if(transfer&&chat&&record.transferLedger?.direction!=='upload')startTransferProgress(chat,record,'upload');
  }
  else if((record.remoteAccepted&&record.remoteResolve||record.restored)&&ws.protocolVersion>=5){
   if(++record.missingHeartbeats>=3&&!data.pendingRemote[record.id]?.cancelRequested&&!['failed','interrupted'].includes(record.message?.status))record.remoteReject?.(new Error('Компьютер переподключился, но выполняющаяся задача не найдена. Уже сохранённые ответы и файлы доступны; продолжи работу из чата.'));
  }else if(record.remotePacket&&!record.controller.signal.aborted&&Date.now()-(record.lastDispatch||0)>30000&&ws.bufferedAmount<2*1024*1024){out(ws,record.remotePacket,record.remotePacketSerialized);record.lastDispatch=Date.now();}
 }
}
function readyWorker(device,ws){
 if(ws.skillsSyncVersion===1&&ws.skillsSentRevision!==skillStore.data.revision){out(ws,{type:'skills-sync',snapshot:skillStore.snapshot()});ws.skillsSentRevision=skillStore.data.revision;}
 if(ws.mcpSyncVersion===1&&ws.mcpSentRevision!==mcpVault.data.revision){out(ws,{type:'mcp-sync',snapshot:mcpVault.snapshot()});ws.mcpSentRevision=mcpVault.data.revision;}
 if(ws.initialized)return;ws.initialized=true;
 for(const request of requests.values())if(request.deviceId===device.id&&(['catalog','workspace-status','workspace-stage','workspace-transfer-status','workspace-file-chunk','workspace-file-batch','native-list','native-read','run-state'].includes(request.packet.type)||request.packet.type==='approval'&&ws.approvalAckVersion===1))out(ws,request.packet,request.serialized);
 for(const record of active.values())if(record.deviceId===device.id){restoreWorker(record);if(record.needsSnapshot)void restoreRunSnapshot(device,ws,record);}
 changed();
}
const catalogKey=(deviceId,provider,profile='')=>deviceId+':'+provider+(profile?':'+profile:'');
function selectedAccount(deviceId,provider,value){const profile=accountId(value);if(!profile)return '';if(deviceId===localId){accounts.record(provider,profile);return profile;}const ws=bridges.get(deviceId);if(ws?.accountsVersion!==1)throw fail(426,'Обнови Team Room на выбранном Mac и подключение в «Этот Mac», чтобы добавить аккаунты.');if(!ws.accounts?.some(a=>a.id===profile&&a.provider===provider))throw fail(404,'Аккаунт не найден на этом компьютере. Выбери другой.');return profile;}
const catalogInFlight=new Map(),catalogGenerations=new Map();
const catalogGeneration=key=>catalogGenerations.get(key)||0;
const catalogIdentity=auth=>JSON.stringify([auth?.connected,auth?.accountKey||null]);
const compatibleCatalog=(result,auth,sameGeneration)=>Boolean(result&&auth&&(result.accountKey||null)===(auth.accountKey||null)&&(result.accountKey||sameGeneration));
function clearCatalogLimits(key){
 let removed=quotaCache.delete(key);if(Object.hasOwn(data.providerLimits,key)){delete data.providerLimits[key];removed=true;}
 const cached=catalogs.get(key);if(cached){delete cached.result.limits;delete cached.result.limitsUpdatedAt;}return removed;
}
function invalidateCatalog(deviceId,provider,{dropCache=false,forgetAuth=false,dropLimits=false,accountId:profile}={}){
 let limitsChanged=false;
 for(const slot of [{provider:'claude',id:''},{provider:'codex',id:''},...(deviceId===localId?accounts.list():bridges.get(deviceId)?.accounts||[])]){const name=slot.provider;if(provider&&provider!==name||profile!==undefined&&slot.id!==profile)continue;const key=catalogKey(deviceId,name,slot.id);catalogGenerations.set(key,catalogGeneration(key)+1);catalogInFlight.delete(key);if(dropCache)catalogs.delete(key);
  if(dropLimits)limitsChanged=clearCatalogLimits(key)||limitsChanged;
  if(forgetAuth){if(deviceId===localId)accounts.get(name,slot.id).authByProvider?.delete(name);else{const ws=bridges.get(deviceId);if(slot.id){if(ws?.accounts)ws.accounts=ws.accounts.map(a=>a.id===slot.id?{...a,status:null}:a);}else if(ws?.status)ws.status={...ws.status,[name]:undefined};}}
 }
 if(limitsChanged)void persist().catch(console.error);
}
function catalogAuthChanged(deviceId,status,profiles=[]){
 // A periodic status with the same identity must keep the warm catalog and
 // its shared request. Only an actual login/account change invalidates it.
 for(const slot of [{provider:'claude',id:'',status:status?.claude},{provider:'codex',id:'',status:status?.codex},...profiles]){const previous=freshCatalogAuth(deviceId,slot.provider,slot.id),next=slot.status;if(previous&&catalogIdentity(previous)!==catalogIdentity(next))invalidateCatalog(deviceId,slot.provider,{accountId:slot.id,dropCache:true,dropLimits:(previous.accountKey||null)!==(next?.accountKey||null)});}
}
function freshCatalogAuth(deviceId,provider,profile=''){
 if(deviceId==='local'){const entry=accounts.get(provider,profile).authByProvider?.get(provider);return entry&&Date.now()-entry.at<30000?entry.value:null;}
 const ws=bridges.get(deviceId);if(ws?.readyState!==1||importMaintenance(deviceId))return null;
 const key=catalogKey(deviceId,provider,profile),cached=catalogs.get(key);
 // A successful metadata RPC checked subscription auth as well. Reuse that
 // check only in the same connection/account generation, never after a wake.
 const checked=cached?.generation===catalogGeneration(key)&&cached.at>=(ws.statusAt||0)?{at:cached.at,value:cached.result}:{at:ws.statusAt,value:profile?ws.accounts?.find(a=>a.id===profile)?.status:ws.status?.[provider]};
 const age=Date.now()-checked.at;return checked.at&&age>=-5000&&age<120000&&typeof checked.value?.connected==='boolean'?checked.value:null;
}
function catalogWhileRefreshing(deviceId,provider,cached,profile=''){
 const auth=freshCatalogAuth(deviceId,provider,profile);if(!auth)return null;
 if(!auth.connected)return {...auth,models:[]};
 const known=compatibleCatalog(cached?.result,auth,cached?.generation===catalogGeneration(catalogKey(deviceId,provider,profile)))&&cached.result.connected&&cached.result.models?.length?cached.result:null;
 return {...(known||{}),...auth,models:known?.models||[],cached:Boolean(known),refreshPending:true,catalogUpdatedAt:known?new Date(cached.at).toISOString():null,detail:'Подключение подтверждено. Обновляю список моделей…'};
}
async function catalog(deviceId,provider,force=false,profile=''){
 profile=selectedAccount(deviceId,provider,profile);
 if(hubOnly&&deviceId==='local')return {connected:false,models:[],detail:'Подключи компьютер и выбери его для выполнения.'};
 if(deviceId!==localId&&(bridges.get(deviceId)?.readyState!==1||importMaintenance(deviceId)))throw fail(503,'Компьютер отключён. Список моделей обновится после восстановления связи.');
 const key=catalogKey(deviceId,provider,profile),cached=catalogs.get(key),auth=freshCatalogAuth(deviceId,provider,profile);
 if(!force&&auth?.connected===false)return {...auth,models:[]};
 if(!force&&cached&&auth&&compatibleCatalog(cached.result,auth,cached.generation===catalogGeneration(key))&&cached.result.connected===auth.connected&&Date.now()-cached.at<60000)return {...cached.result,...auth};
 let pending=catalogInFlight.get(key);
 if(!pending){pending={generation:catalogGeneration(key)};pending.promise=readCatalog(deviceId,provider,force,pending.generation,profile).finally(()=>{if(catalogInFlight.get(key)===pending)catalogInFlight.delete(key)});catalogInFlight.set(key,pending);void pending.promise.catch(()=>{});}
 const fallback=catalogWhileRefreshing(deviceId,provider,cached,profile);if(!force&&cached&&fallback)return fallback;
 let timer;
 try{
  const result=await Promise.race([pending.promise,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),8000);timer.unref?.();})]),current=freshCatalogAuth(deviceId,provider,profile);
  const verified=catalogs.get(key);
  if(result&&verified?.result===result&&verified.generation===catalogGeneration(key)&&current&&catalogIdentity(result)===catalogIdentity(current))return {...result,...current};
  return catalogWhileRefreshing(deviceId,provider,catalogs.get(key),profile)||Promise.reject(fail(503,'Список моделей ещё загружается. Подключение проверяется отдельно; повтори обновление через несколько секунд.'));
 }
 catch(error){const current=catalogWhileRefreshing(deviceId,provider,catalogs.get(key),profile);if(current)return current;throw error;}
 finally{clearTimeout(timer);}
}
async function readCatalog(deviceId,provider,force=false,generation=catalogGeneration(catalogKey(deviceId,provider)),profile=''){const key=catalogKey(deviceId,provider,profile);
 if(force&&deviceId===localId){const selected=accounts.get(provider,profile);selected.invalidateAuth();selected.claudeCatalog=null}
 const initial=freshCatalogAuth(deviceId,provider,profile),previous=catalogs.get(key)?.result,socket=deviceId===localId?null:bridges.get(deviceId);
 const result=deviceId===localId?await accounts.get(provider,profile).catalog(provider):await requestDevice(deviceId,'catalog',{provider,force,accountId:profile});
 const current=freshCatalogAuth(deviceId,provider,profile);
 if(generation!==catalogGeneration(key)||deviceId!==localId&&(bridges.get(deviceId)!==socket||socket?.readyState!==1||importMaintenance(deviceId))||initial&&current&&catalogIdentity(initial)!==catalogIdentity(current)||!initial&&current&&catalogIdentity(result)!==catalogIdentity(current))throw fail(409,'Вход или подключение изменились во время проверки. Обновляю список для текущего аккаунта.');
 if(typeof result?.connected!=='boolean')throw fail(503,'Компьютер не подтвердил состояние подписки. Повтори проверку.');
 const previousAccount=initial?.accountKey||previous?.accountKey;if(previousAccount&&previousAccount!==(result.accountKey||null)){invalidateCatalog(deviceId,provider,{accountId:profile,dropCache:true,dropLimits:true});generation=catalogGeneration(key);}
 if(!result.limits&&data.providerLimits[key]){result.limits=data.providerLimits[key].limits;result.limitsUpdatedAt=data.providerLimits[key].updatedAt;}else if(result.limits){result.limitsUpdatedAt=now();quotaCache.set(key,result.limits);data.providerLimits[key]={limits:result.limits,updatedAt:result.limitsUpdatedAt};void persist().catch(console.error);}result.catalogUpdatedAt=now();catalogs.set(key,{at:Date.now(),generation,result});changed();return result;
}
function approvalPublic(a){const {reply,inflight,answer,deliveryId,...value}=a;return value}
function refreshRunActivity(chat,record){
 const run=chat.run;if(!run||run.id!==record.id)return;
 if(record.controller.signal.aborted&&!record.closing){run.phase='stopping';delete run.waitingFor;delete run.waitingSince;run.text=run.connectionLost?'Остановка запрошена. Отправлю команду после восстановления связи с компьютером.':'Останавливает работу на компьютере и сохраняет файлы…';return;}
 if(record.approvals.size){
  const question=[...record.approvals.values()].some(a=>a.tool==='AskUserQuestion'||Array.isArray(a.details?.questions));
  run.phase='waiting';run.waitingFor=question?'question':'permission';run.waitingSince||=now();
  run.text=question?'Ждёт твоего ответа на вопрос':'Ждёт разрешения на действие';
 }else{
  delete run.waitingFor;delete run.waitingSince;
  const activity=record.activity||{};run.phase=activity.phase||'running';
  run.text=activity.text||record.textBeforeDisconnect||'Продолжает работу…';
 }
 if(run.connectionLost)run.text='Связь с компьютером потеряна. Автоматически переподключаюсь…';
}
function clearTransferProgress(chat,record){clearTimeout(record.transferTimer);record.transferTimer=null;delete record.transferLedger;if(chat?.run?.id===record.id)delete chat.run.transfer;}
function setRunActivity(chat,record,phase,text){if(phase==='running'||phase==='starting'&&record.transferLedger?.stage==='finalizing')clearTransferProgress(chat,record);record.activity={phase,text};refreshRunActivity(chat,record);}
// Send a small run update instead of reloading the complete chat/project for
// every acknowledged chunk. Totals and ETA reflect only confirmed file bytes.
function publishTransferProgress(chat,record,force=false){
 const ledger=record.transferLedger;if(!ledger||chat?.run?.id!==record.id)return;
 const at=Date.now(),wait=500-(at-(record.transferSentAt||0));
 if(!force&&wait>0){if(!record.transferTimer){record.transferTimer=setTimeout(()=>{record.transferTimer=null;publishTransferProgress(chat,record,true)},wait);record.transferTimer.unref?.();}return;}
 clearTimeout(record.transferTimer);record.transferTimer=null;record.transferSentAt=at;
 const current=ledger.files?.get(ledger.currentFile),first=ledger.samples[0],last=ledger.samples.at(-1),elapsed=last&&first?(last.at-first.at)/1000:0;
 const speed=ledger.ackCount>=2&&elapsed>=1&&at-last.at<15000&&(last.bytes-first.bytes)>0?(last.bytes-first.bytes)/elapsed:null;
 const offset=current?ledger.offsets.get(current.path)||0:null;
 const remaining=ledger.totalBytes===null?null:Math.max(0,ledger.totalBytes-ledger.transferredBytes);
 record.transferUpdatedMs=Math.max(at,(record.transferUpdatedMs||0)+1);
 chat.run.transfer={direction:ledger.direction,stage:ledger.stage,totalFiles:ledger.files?.size??null,completedFiles:ledger.completedFiles,totalBytes:ledger.totalBytes,transferredBytes:ledger.transferredBytes,currentFile:ledger.currentFile||null,currentFileBytes:current?.size??null,currentFileTransferredBytes:offset,recentFiles:[...ledger.recentFiles],speedBytesPerSecond:speed,etaSeconds:ledger.stage==='transferring'&&speed&&remaining>0?Math.ceil(remaining/speed):null,updatedAt:new Date(record.transferUpdatedMs).toISOString()};
 chat.revision=(chat.revision||0)+1;
 broadcast({type:'run-progress',chatId:chat.id,runId:record.id,run:chat.run,revision:chat.revision});
}
function startTransferProgress(chat,record,direction,files=null,states=[]){
 clearTransferProgress(chat,record);const at=Date.now(),portable=files===null?null:portableFiles(files),stateMap=new Map(states.map(file=>[file.path,file])),offsets=new Map();let transferredBytes=0,completedFiles=0;
 for(const file of portable||[]){const state=stateMap.get(file.path);if(state&&state.hash===file.hash&&state.size===file.size&&Number.isSafeInteger(state.offset)&&state.offset>=0&&state.offset<=file.size){offsets.set(file.path,state.offset);transferredBytes+=state.offset;if(state.offset===file.size)completedFiles++;}}
 record.transferLedger={direction,stage:portable===null?'preparing':'transferring',files:portable===null?null:new Map(portable.map(file=>[file.path,file])),offsets,totalBytes:portable===null?null:portable.reduce((total,file)=>total+file.size,0),transferredBytes,completedFiles,recentFiles:[],currentFile:null,samples:[{at,bytes:transferredBytes}],ackCount:0};
 setRunActivity(chat,record,direction==='download'?'syncing-files':'saving',direction==='download'?'Проверяю рабочие файлы на выбранном Mac…':'Сохраняет рабочие файлы в общем пространстве…');publishTransferProgress(chat,record,true);
}
function currentTransferFile(chat,record,file){const ledger=record.transferLedger;if(!ledger?.files?.has(file.path))return;ledger.currentFile=file.path;setRunActivity(chat,record,ledger.direction==='download'?'syncing-files':'saving',ledger.direction==='download'?`Передаю файлы на ${chat.run.deviceName}`:'Сохраняет рабочие файлы в общем пространстве…');publishTransferProgress(chat,record);}
function acknowledgeTransferFile(chat,record,file,offset){
 const ledger=record.transferLedger;if(!ledger?.files?.has(file.path))return;
 const previous=ledger.offsets.get(file.path),old=previous||0;if(!Number.isSafeInteger(offset)||offset<old||offset>file.size)throw new Error('Некорректное подтверждение передачи файла.');
 ledger.offsets.set(file.path,offset);ledger.transferredBytes+=offset-old;
 if(offset===file.size&&previous!==file.size){ledger.completedFiles++;ledger.recentFiles.push(file.path);ledger.recentFiles=ledger.recentFiles.slice(-6);}
 if(offset>old){const at=Date.now();ledger.ackCount++;ledger.samples.push({at,bytes:ledger.transferredBytes});while(ledger.samples.length>2&&ledger.samples[1].at<at-15000)ledger.samples.shift();if(ledger.samples.length>100)ledger.samples.splice(1,ledger.samples.length-100);}
 publishTransferProgress(chat,record);
}
function finalizeTransferProgress(chat,record){const ledger=record.transferLedger;if(!ledger||ledger.stage==='finalizing')return;ledger.stage='finalizing';ledger.currentFile=null;setRunActivity(chat,record,ledger.direction==='download'?'syncing-files':'saving',ledger.direction==='download'?'Проверяю переданные файлы перед запуском…':'Файлы переданы. Сохраняет результат…');publishTransferProgress(chat,record,true);}
function transferBatches(files,target=1024*1024){return fileBatches(files,target).flatMap(batch=>{const parts=[];for(let i=0;i<batch.length;i+=128)parts.push(batch.slice(i,i+128));return parts;});}
const isLimit=isUsageLimit;
const quotaCache=new Map(Object.entries(data.providerLimits).map(([k,v])=>[k,v.limits]));
const memoryJobs=new Map();
function captureLimitsScope(options){const key=catalogKey(options.deviceId,options.provider,options.accountId);return {key,generation:catalogGeneration(key),accountKey:freshCatalogAuth(options.deviceId,options.provider,options.accountId)?.accountKey||null};}
function observeLimits(options,limits,scope){
 const key=catalogKey(options.deviceId,options.provider,options.accountId),current=freshCatalogAuth(options.deviceId,options.provider,options.accountId);
 if(!scope||scope.key!==key||scope.generation!==catalogGeneration(key)||scope.accountKey&&current?.accountKey&&scope.accountKey!==current.accountKey)return false;
 quotaCache.set(key,limits);data.providerLimits[key]={limits,updatedAt:now()};const cached=catalogs.get(key);if(cached){cached.result.limits=limits;cached.result.limitsUpdatedAt=data.providerLimits[key].updatedAt;}void persist().catch(console.error);broadcast({type:'limits',provider:options.provider,deviceId:options.deviceId,accountId:options.accountId||'',limits,updatedAt:data.providerLimits[key].updatedAt});return true;
}
async function applyRemote(project,delta,before,runId,accepted={}){return projectFiles.run(project.id,()=>mergeChanges(workspace(project),delta,portableFiles(before),runId,accepted));}
async function localChanges(dir,before){const delta=await changes(dir,before,{contents:false});for(const file of delta.changed){const full=await filePath(dir,file.path);file.source=()=>createReadStream(full);}return delta;}
async function applyRemoteResult(project,result,before,runId,accepted={}){
 if(result.fileTransfer?.version!==1)return applyRemote(project,result.changes,before,runId,accepted);
 const pending=data.pendingRemote[runId],record=pending&&active.get(pending.chatId),chat=pending&&data.conversations.find(chat=>chat.id===pending.chatId);
 if(record?.id===runId&&record.transferLedger?.direction==='upload')finalizeTransferProgress(chat,record);
 return projectFiles.run(project.id,async()=>{
  const dir=workspace(project),current=new Map((await snapshot(dir)).map(f=>[f.path,f.hash]));
  const portableBefore=portableFiles(before);
  const parts=await incomingResults.apply(runId,result.changes,delta=>mergeChanges(dir,delta,portableBefore,runId,accepted,current),{stream:true});
  return {conflicts:parts.flatMap(p=>p.conflicts),overrides:Object.assign({},...parts.map(p=>p.overrides)),changedPaths:parts.flatMap(p=>p.changedPaths)};
 });
}
function remoteFinalizationFailure(runId,stage,error,{record,chat,message,retry=false}={}){
 const detail='Не удалось завершить сохранение результата: '+error.message+'. Ответ и файлы остаются на компьютере; сохранение будет повторено автоматически.';
 console.warn(JSON.stringify({event:'run-finalization-retry',runId,stage,deviceId:record?.deviceId,code:error.code||null,message:error.message}));
 if(message){message.finalizationSyncError=detail;message.syncWarning=detail;}
 if(record){
  record.syncError=error.message;
  if(retry){record.remoteResultReceived=false;record.needsSnapshot=true;record.closing=false;delete record.remoteFinalizationOwner;}
  if(chat?.run?.id===runId){delete chat.run.connectionLost;setRunActivity(chat,record,'saving',detail);}
 }
 if(chat)changed(chat);
}
async function localCheckpoint(chat,record){
 if(record.readOnly||record.localSync||!record.localDir||!record.before||record.closing)return record.localSync;
 record.localSync=(async()=>{const delta=await localChanges(record.localDir,record.before),result=await applyRemote(projectById(chat.projectId),delta,record.before,record.id,record.accepted);syncNotice(chat,chat.messages.find(m=>m.runId===record.id),result);await saveCheckpoint(chat,'local-checkpoint',true);changed(chat);})();
 try{await record.localSync}catch(error){record.syncError=error.message;}finally{record.localSync=null}
}
async function alternative(options,visited=new Set(),forMemory=false){
 // A provider/subscription fallback must keep the session on its chosen Mac.
 const ordered=[options.deviceId];
 for(const deviceId of ordered){const candidates=forMemory?[options.provider,options.provider==='claude'?'codex':'claude']:[options.provider==='claude'?'codex':'claude',options.provider];
  for(const provider of candidates){const profiles=[...(deviceId===options.deviceId&&provider===options.provider?[options.accountId||'']:[]),'',...(devices().find(d=>d.id===deviceId)?.accounts||[]).filter(a=>a.provider===provider&&a.status?.connected).map(a=>a.id)];for(const profile of new Set(profiles)){if(visited.has(sessionKey({deviceId,provider,accountId:profile})))continue;try{const c=await catalog(deviceId,provider,false,profile);const q=quotaState(quotaCache.get(catalogKey(deviceId,provider,profile))||c.limits);if(!c.connected||q.exhausted||forMemory&&q.near||bridges.get(deviceId)?.protocolVersion===1)continue;const picked=forMemory?memoryModel(c,provider):safeModel(c,provider,options.preferences?.[provider]);if(picked)return {...picked,deviceId,accountId:profile};}catch{}}}
 }return null;
}
async function memoryRun(options,prompt,project){
 const limitsScope=captureLimitsScope(options),controller=new AbortController();const timer=setTimeout(()=>controller.abort(),110000);timer.unref();
 try{if(options.deviceId==='local'){return await accounts.get(options.provider,options.accountId).run({...options,cwd:workspace(project),prompt,readOnly:true},e=>{if(e.type==='approval')e.reply(false);if(e.type==='limits')observeLimits(options,e.limits,limitsScope)},controller.signal)}
 const result=await requestDevice(options.deviceId,'memory',{options,prompt,projectId:project.id},120000);if(result.limits)observeLimits(options,result.limits,limitsScope);return result;
 }finally{clearTimeout(timer)}
}
// Naming waits for this Mac's ordinary work to be idle and uses its subscription.
// The empty metadata workspace avoids loading project files for this request.
const titleWorkspace={id:data.titleWorkspaceId,name:'Названия сессий'};
const titleQueue=new TitleQueue({
 chats:()=>data.conversations,project:projectById,
 idle:(chat,selection)=>{if(shuttingDown||updateMaintenance)return false;if(!chat)return true;if(projectDeleting.has(chat.projectId)||!data.projects.some(p=>p.id===chat.projectId)||deletingChats.has(chat.id))return false;const deviceId=selection?.deviceId||chatExecutionDevice(chat);return Boolean(deviceId)&&!chatLocks.has(chat.id)&&!memoryJobs.size&&![...active.values()].some(r=>r.deviceId===deviceId)&&![...dispatchDevices.values()].includes(deviceId)&&!data.conversations.some(c=>c.run?.deviceId===deviceId);},
 choose:chat=>alternative({...chat.route,provider:chat.route?.provider||chat.provider||'claude',deviceId:chatExecutionDevice(chat)},new Set(),true),
 run:async(options,prompt)=>{if(options.deviceId===localId)await fs.mkdir(workspace(titleWorkspace),{recursive:true});return memoryRun(options,prompt,titleWorkspace);},
 persist,changed:chat=>{changed(chat);console.log(JSON.stringify({event:'session-title-updated',ready:data.conversations.filter(c=>c.titleSource==='auto'&&c.titleMeta?.version>=1).length,pending:data.conversations.filter(c=>c.titleSource==='auto'&&c.titleMeta?.version<1&&c.titleMeta?.status!=='waiting').length}));}
});
function refreshMemory(chat){
 if(chat.kind==='side')throw fail(409,'Боковой вопрос не изменяет общую память проекта.');
 // Additional inference is requested explicitly by the user, never per ordinary turn.
 if(deletingChats.has(chat.id)||!data.conversations.includes(chat)||!chat.messages.length)return;
 const running=memoryJobs.get(chat.id);if(running){running.again=true;return;}
 const job={again:false};memoryJobs.set(chat.id,job);
 void (async()=>{
  try{do{job.again=false;const {batches,records}=summaryBatches(chat);if(!batches.length)break;
    chat.memory={...chat.memory,status:'updating',error:null};await persist();changed(chat);
    const base=chat.route||{provider:chat.provider||'claude',deviceId:'local'};const choice=await alternative(base,new Set(),true);if(!choice)throw new Error('Нет доступного провайдера для сводки. Полная история и контрольная точка сохранены.');
    // Never summarize an active source message; each batch is an immutable saved snapshot.
    const temporary={...chat,memory:structuredClone(chat.memory)};const allRecords=structuredClone(chat.messages.filter(m=>m.status!=='running'));
    for(const batch of batches){const r=await memoryRun(choice,memoryPrompt(temporary,batch),projectById(chat.projectId));const content=parseMemory(r.text,allRecords);temporary.memory={...temporary.memory,content};}
    storeMemory(data,chat,temporary.memory.content,{provider:choice.provider,sourceKeys:records.map(r=>r.key)});
    checkpoint(chat,chat.files,'memory');await persist();if(!chatLocks.has(chat.id))await writeHandoff(workspace(projectById(chat.projectId)),chat,data.memories.filter(m=>m.projectId===chat.projectId),data.tasks.filter(t=>t.projectId===chat.projectId),contextChats(chat));changed(chat);
  }while(job.again)}catch(error){chat.memory={...chat.memory,status:'pending',error:error.message};await persist().catch(console.error);changed(chat)}finally{memoryJobs.delete(chat.id)}
 })();
}
async function saveCheckpoint(chat,reason='progress',refreshFiles=false){
 if(refreshFiles)chat.files=await projectFiles.run(chat.projectId,()=>snapshot(workspace(projectById(chat.projectId))));
 checkpoint(chat,chat.files,reason);
 if(['progress','action'].includes(reason)&&chat.run){const message=chat.messages.find(m=>m.runId===chat.run.id&&m.role==='assistant');if(message)return runProgress.save(chat,message);}
 await persist();
}
function applyFollowupDelivery(chat,messageId,status,detail,{runId,message,replyOffset}={}){
 if(!['queued','received','delivered','uncertain'].includes(status))status='uncertain';
 const m=chat.messages.find(m=>m.id===messageId&&m.followup);
 // Receipts stay bound to their originating native turn. A delayed result from
 // an old turn must not acknowledge the same user message after a retry.
 if(!m||!runId||m.afterRunId!==runId||m.delivery==='cancelled')return;
 let boundaryChanged=false;
 if(status==='delivered'&&message?.role==='assistant'&&message.runId===runId&&Number.isSafeInteger(replyOffset)&&replyOffset>=0&&chat.messages.indexOf(message)>=0&&chat.messages.indexOf(message)<chat.messages.indexOf(m)){
  message.replyBoundaries||=[];
  if(!message.replyBoundaries.some(b=>b.messageId===messageId)){
   // Preserve the provider's raw UTF-16 offset even if its delivery receipt
   // overtakes a text snapshot. Rendering can clamp; persistence must not.
   message.replyBoundaries.push({messageId,offset:replyOffset});boundaryChanged=true;
  }
 }
 const deliveryChanged=m.delivery!=='delivered'&&!(m.delivery==='received'&&['queued','sending'].includes(status));
 if(!deliveryChanged&&!boundaryChanged)return;
 if(deliveryChanged){m.delivery=status;m.deliveryDetail=detail||null;m.status=status==='delivered'?'completed':['received','uncertain'].includes(status)?'pending':'queued';if(status==='delivered')m.deliveredAt=now();}
 if(boundaryChanged){const record=active.get(chat.id);if(record?.id===runId){record.deltaPending=true;flushReplyDelta(chat,record,message);}void runProgress.save(chat,message).catch(console.error);}
 void persist().catch(console.error);changed(chat);
}
function pumpFollowups(chat,record){
 if(queueMutations.get(chat.id))return record.followupPump;
 if(record.closing||record.controller.signal.aborted)return record.followupPump;
 if(!['codex','claude'].includes(chat.run?.provider))return;
 const remote=record.deviceId!==localId,ws=bridges.get(record.deviceId);
 if(remote?(!record.remoteResolve&&!record.restored||!record.canSteer||ws?.readyState!==1||ws.protocolVersion<4):!record.steer)return;
 record.followupController||=new AbortController();record.followupRequests||=new Map();
 // Delivery acknowledgements belong to each message. Waiting for one native
 // acknowledgement must not hold newer keyboard input behind it.
 for(const m of chat.messages.filter(m=>m.followup&&m.afterRunId===record.id&&['queued','sending'].includes(m.delivery)&&m.rejectedRunId!==record.id&&!record.followupRequests.has(m.id))){
  const pending=(async()=>{
   let result;
   try{
    // Persist the delivery intent before contacting the native run, without
    // putting this keyboard input behind a full database rewrite.
    await messageJournal.commit({type:'message-sending',chatId:chat.id,projectId:chat.projectId,messageId:m.id,runId:record.id},entry=>applyMessageOperation(entry));
    if(record.closing||record.controller.signal.aborted||record.followupController.signal.aborted)return applyFollowupDelivery(chat,m.id,'queued',null,{runId:record.id,message:record.message});
    if(m.delivery!=='sending')return;
    changed(chat);const receipt=remote?requestDevice(record.deviceId,'steer',{runId:record.id,message:m},45000,record.followupController.signal):record.steer(m);scheduleMessageSnapshot();result=await receipt;
   }catch(error){result={status:'uncertain',detail:error.message};}
   if(result.status==='queued')m.rejectedRunId=record.id;
   applyFollowupDelivery(chat,m.id,result.status||'uncertain',result.detail,{runId:record.id,message:record.message,replyOffset:result.replyOffset});
  })().finally(()=>record.followupRequests.delete(m.id));
  record.followupRequests.set(m.id,pending);
 }
 record.followupPump=Promise.allSettled([...record.followupRequests.values()]);
 return record.followupPump;
}
async function enqueueFollowup(chat,user,input,res){
 const started=Date.now();
 if(shuttingDown)throw fail(503,'Приложение перезапускается. Повтори отправку через несколько секунд.');
 if(active.get(chat.id)?.controller.signal.aborted)return send(res,409,{error:'Сессия останавливается на компьютере и сохраняет файлы. Дождись подтверждения остановки.'});
 const text=String(input.text||'').trim();if(!text)return send(res,400,{error:'Напиши дополнение.'});
 if((input.attachments||[]).length)return send(res,409,{error:'Во время работы можно отправлять текст и ссылки. Файлы добавь после ответа.'});
 if(chat.messages.filter(m=>m.followup&&['queued','sending','received','uncertain'].includes(m.delivery)).length+pendingMessageCount(chat.id)>=20)return send(res,409,{error:'Уже сохранено 20 дополнений. Дождись их обработки.'});
 const record=active.get(chat.id);if(!record)return send(res,409,{error:'Ответ уже завершён. Отправь сообщение ещё раз.'});
 const message={id:input.messageId||id(),role:'user',text,attachments:[],owner:user.name,createdAt:now(),status:'queued',followup:true,delivery:'queued',afterRunId:record.id};
 const committed=await commitAcceptedMessage(chat,{type:'message-accept',chatId:chat.id,projectId:chat.projectId,userId:user.id,message});
 if(!chat.messages.some(m=>m.id===message.id))throw fail(409,'Сессия изменилась во время сохранения дополнения.');
 send(res,202,{ok:true,queued:true});
 console.log(JSON.stringify({event:'message-accepted',kind:'followup',elapsedMs:Date.now()-started,journalBytes:committed.bytes}));changed(chat);
 setImmediate(()=>{scheduleMessageSnapshot();if(shuttingDown)return;if(active.get(chat.id)===record)void pumpFollowups(chat,record)?.catch(console.error);else if(!active.has(chat.id))startQueuedFollowups(chat,user);});
}
function startQueuedFollowups(chat,user){
 if(shuttingDown||!user||chat.archivedAt||deletingChats.has(chat.id)||!data.conversations.includes(chat)||active.has(chat.id)||chatLocks.has(chat.id))return;
 if(queueMutations.get(chat.id)){queueResumes.set(chat.id,user);return;}
 queueResumes.delete(chat.id);
 const queued=chat.messages.filter(m=>m.followup&&m.delivery==='queued');if(!queued.length)return;
 const options={...chat.route};
 if(!devices().some(d=>d.id===options.deviceId&&d.online)){chat.queueNotice='Дополнения сохранены. Подключи компьютер и продолжи очередь.';changed(chat);return;}
 if(options.provider==='claude'&&/fable/i.test(options.model||'')&&!options.allowUsageCredits){chat.queueNotice='Дополнения сохранены. Для Fable требуется подтверждение usage credits.';changed(chat);return;}
 if(legacyBusy(chat,options.deviceId)){chat.queueNotice='Для параллельной работы на этом компьютере обнови Team Room Community Connect.';changed(chat);return;}chatLocks.add(chat.id);dispatchDevices.set(chat.id,options.deviceId);delete chat.queueNotice;
 options.queuedMessageIds=queued.map(m=>m.id);
 for(const m of queued){m.delivery='dispatching';m.status='completed';m.deliveryDetail=null;delete m.rejectedRunId;}
 const launch={};void runChat(chat,user,options,launch).catch(async error=>{
  if(chatLaunches.get(chat.id)===launch){chatLaunches.delete(chat.id);chatLocks.delete(chat.id);dispatchDevices.delete(chat.id);chat.run=null;active.delete(chat.id);}
  const last=launch.message;if(last?.status==='running'){last.status='failed';last.error=error.message;}
  await persist().catch(console.error);changed(chat);console.error(error);
 });
}
function flushReplyDelta(chat,record,message){
 clearTimeout(record.deltaTimer);record.deltaTimer=null;
 if(!record.deltaPending)return;
 record.deltaPending=false;record.lastDeltaSent=Date.now();
 broadcast({type:'delta',chatId:chat.id,messageId:message.id,runId:record.id,streamRevision:record.streamRevision=(record.streamRevision||0)+1,text:message.text,replyBoundaries:message.replyBoundaries||[]});
}
function queueReplyDelta(chat,record,message){
 if(record.closing)return;record.deltaPending=true;
 const delay=75-(Date.now()-(record.lastDeltaSent||0));
 if(delay<=0){flushReplyDelta(chat,record,message);return;}
 if(!record.deltaTimer){record.deltaTimer=setTimeout(()=>{record.deltaTimer=null;if(!record.closing)flushReplyDelta(chat,record,message)},delay);record.deltaTimer.unref?.();}
}
function broadcastAgent(chat,message,runId,agent){
 const envelope={type:'agent-progress',chatId:chat.id,messageId:message.id,runId};
 const summary=JSON.stringify({...envelope,agent:agentSummary(agent)});let details;
 for(const ws of events)if(validBrowserSession(ws)&&ws.readyState===1){const watch=ws.agentWatch;sendBrowserPacket(ws,watch?.chatId===chat.id&&watch?.messageId===message.id&&watch?.agentId===agent.id?(details||=JSON.stringify({...envelope,agent})):summary);}
}
function flushAgentUpdates(chat,record,message){
 clearTimeout(record.agentTimer);record.agentTimer=null;
 for(const agentId of record.agentUpdates||[]){const agent=message.agents?.find(a=>a.id===agentId);if(agent)broadcastAgent(chat,message,record.id,agent);}
 record.agentUpdates?.clear();
}
function queueAgentUpdate(chat,record,message,agent){
 record.agentUpdates||=new Set();record.agentUpdates.add(agent.id);
 if(!record.agentTimer){record.agentTimer=setTimeout(()=>flushAgentUpdates(chat,record,message),500);record.agentTimer.unref?.();}
}
function applyPlanEvent(message,event){
 const itemId=String(event.itemId||'').slice(0,160),previous=message.plan?.itemId===itemId?message.plan.text||'':'';
 message.plan={itemId,text:typeof event.text==='string'?event.text.slice(0,100000):(previous+String(event.delta||'')).slice(0,100000),status:event.status==='completed'?'completed':'running'};
}
function attachRunEvents(chat,record,message,options){
 const controller=record.controller,routeKey=sessionKey(options),limitsScope=captureLimitsScope(options);let lastPartialSave=0;
  const emit=event=>{
    if(event.type==='agent-control'){record.agentControl=event.control;}
    else if(event.type==='agent'){const agent=applyAgentEvent(message,event);if(agent){chat.updatedAt=now();queueAgentUpdate(chat,record,message,agent);if(Date.now()-lastPartialSave>3000){lastPartialSave=Date.now();void runProgress.save(chat,message).catch(console.error);}}}
    else if(event.type==='control'){record.steer=event.steer;void pumpFollowups(chat,record)?.catch(console.error);}
    else if(event.type==='steer-ready'){record.canSteer=true;void pumpFollowups(chat,record)?.catch(console.error);}
    else if(event.type==='followup-delivery'){applyFollowupDelivery(chat,event.messageId,event.status,event.detail,{runId:record.id,message,replyOffset:event.replyOffset});if(['received','delivered'].includes(event.status))void pumpFollowups(chat,record)?.catch(console.error);}
    else if(event.type==='delta'){message.text+=event.text;chat.updatedAt=now();queueReplyDelta(chat,record,message);if(Date.now()-lastPartialSave>3000){lastPartialSave=Date.now();void saveCheckpoint(chat).catch(console.error)}}
    else if(event.type==='phase'){setRunActivity(chat,record,event.phase,event.text);changed(chat)}
    else if(event.type==='plan'){
     applyPlanEvent(message,event);
     if(event.status==='completed'||Date.now()-lastPartialSave>3000){lastPartialSave=Date.now();void runProgress.save(chat,message).catch(console.error);}
     if(event.status==='completed'||Date.now()-(record.planPaintAt||0)>=1000){record.planPaintAt=Date.now();changed(chat);}
    }
    else if(event.type==='execution-mode'){message.nativeExecutionMode=event.native===true;changed(chat);}
    else if(event.type==='model'){message.model=event.model;changed(chat)}
    else if(event.type==='session'){chat.providerSessions[routeKey]=event.session;if(!event.contextOnly&&event.session.inputAccepted)for(const messageId of options.queuedMessageIds||[])applyFollowupDelivery(chat,messageId,'delivered',null,{runId:record.id,message});void persist().catch(console.error);changed(chat);}
    else if(event.type==='context'){chat.context={...event,updatedAt:now()};message.context={mode:event.mode,promptChars:event.promptChars};changed(chat);}
    else if(event.type==='tool'||event.type==='tool-result'){message.actions.push({tool:event.type==='tool-result'?'Результат действия':event.tool,toolId:event.toolId,status:event.type==='tool-result'?(event.success?'completed':'failed'):'started',details:event.details,at:now()});setRunActivity(chat,record,'running',event.type==='tool-result'?'Продолжает работу…':`Выполняет: ${event.tool}`);if(Date.now()-lastPartialSave>3000){lastPartialSave=Date.now();void saveCheckpoint(chat,'action').catch(console.error);}if(event.type==='tool-result'&&options.deviceId===localId)void localCheckpoint(chat,record);changed(chat)}
    else if(event.type==='approval-cancelled'){for(const [key,a]of record.approvals)if(a.requestId===event.requestId)record.approvals.delete(key);chat.approvals=[...record.approvals.values()].map(approvalPublic);refreshRunActivity(chat,record);void persist().catch(console.error);changed(chat);}
    else if(event.type==='approval'){if([...record.approvals.values()].some(a=>a.requestId===event.requestId))return;const approval={id:id(),requestId:event.requestId,tool:event.tool,details:event.details,reply:event.reply};record.approvals.set(approval.id,approval);chat.approvals=[...record.approvals.values()].map(approvalPublic);refreshRunActivity(chat,record);void persist().catch(console.error);changed(chat);notifyChat(chat,'questions',message,{approvalId:approval.id})}
    else if(event.type==='usage'){message.usage=event.usage;message.permissionDenials=event.permissionDenials;}
    else if(event.type==='limits'){message.limits=event.limits;observeLimits(options,event.limits,limitsScope);}
    else if(event.type==='notice'){message.actions.push({tool:'Сообщение',details:event.message,at:now()});changed(chat)}
  };
  record.remoteEmit=event=>{
   if(event.type==='session'&&event.sessionPatch===true){
    const current=chat.providerSessions?.[routeKey];
    if(event.contextOnly!==true||!current?.sessionId||event.session?.sessionId!==current.sessionId)return;
    // Context usage patches cannot replace the native session inventory or
    // initialize a different session. Its full final result is authoritative.
    event={...event,session:{...current,...(Object.hasOwn(event.session,'contextUsage')?{contextUsage:event.session.contextUsage}:{})}};
   }
   if(event.type==='approval')event={...event,reply:async(allow,answers,deliveryId)=>{
   const ws=bridges.get(record.deviceId);if(ws?.readyState!==1)throw fail(503,'Компьютер отключён. Ответ сохранён в форме; повтори после восстановления связи.');
   if(ws.approvalAckVersion===1)return requestDevice(record.deviceId,'approval',{runId:record.id,approvalRequestId:event.requestId,allow,answers},15000,controller.signal,deliveryId);
   if(!out(ws,{type:'approval',runId:record.id,requestId:event.requestId,allow,answers}))throw fail(503,'Не удалось передать ответ. Повтори после восстановления связи.');
   return {ok:true,legacy:true};
  }};emit(event)};
 return emit;
}
function receiveRunEvent(record,packet,{backfill=false}={}){
 const seq=Number.isSafeInteger(packet.seq)?packet.seq:0;
 if(record.remoteResultReceived||!record.remoteEmit)return;
 // Coverage belongs to the applied message, including events observed while
 // reconnecting. A final replay must not emit those actions a second time.
 if(seq&&(seq<=(record.message?.remoteSeq||0)||record.message?.remoteEventSeqs?.includes(seq)))return;
 if(backfill){
  if(!seq||seq<=(record.message?.remoteSeq||0)||packet.event?.type==='delta'||record.message?.remoteEventSeqs?.includes(seq))return;
 }else if(seq&&seq<=(record.lastSeq||0))return;
 record.lastSeq=Math.max(seq,record.lastSeq||0);
 if(record.message){
  if(record.needsSnapshot){if(seq&&packet.event?.type!=='delta'){record.message.remoteEventSeqs||=[];record.message.remoteEventSeqs.push(seq);}}
  else record.message.remoteSeq=record.lastSeq;
 }
 record.remoteEmit(packet.event);
}
async function restoreRunSnapshot(device,ws,record){
 if(ws.runRecoveryVersion!==1||record.restoreRequest||record.closing||record.remoteResultReceived)return;
 record.restoreRequest=(async()=>{
  const snapshot=await requestDevice(device.id,'run-state',{runId:record.id,afterSeq:record.message?.remoteSeq||0},30000);
  if(bridges.get(device.id)!==ws||active.get(record.chatId)!==record||record.closing||record.remoteResultReceived)return;
  if(!snapshot||snapshot.runId!==record.id||snapshot.state==='missing')return;
  acceptRemote(record);
  if(['result-saving','result-pending'].includes(snapshot.state)){
   const chat=data.conversations.find(c=>c.id===record.chatId);if(chat?.run?.id!==record.id)return;
   const code=snapshot.finalizationRetry?.code,text=['ENOSPC','EDQUOT'].includes(code)?'Ответ готов. На Mac закончилось место; сохранение продолжится после освобождения места.':code==='EXTERNAL_STORAGE_UNAVAILABLE'?'Ответ готов. Подключи внешний диск, чтобы завершить сохранение.':snapshot.state==='result-pending'?'Ответ готов. Передаёт сохранённый результат и файлы…':'Ответ готов. Сохраняет рабочие файлы…';
   const different=record.activity?.phase!=='saving'||record.activity?.text!==text||chat.run.connectionLost||chat.run.recovering||record.approvals.size||chat.approvals?.length;
   record.canSteer=false;record.needsSnapshot=true;record.approvals.clear();chat.approvals=[];delete chat.run.connectionLost;delete chat.run.recovering;setRunActivity(chat,record,'saving',text);if(different)changed(chat);return;
  }
  if(snapshot.state!=='running'||!Number.isSafeInteger(snapshot.seq)||typeof snapshot.text!=='string')return;
  const chat=data.conversations.find(c=>c.id===record.chatId),message=record.message;if(!chat||!message)return;
  const liveActivity=record.activity;
  for(const packet of Array.isArray(snapshot.events)?snapshot.events:[])receiveRunEvent(record,packet,{backfill:true});
  // New live frames can overtake this RPC. An older snapshot must never undo
  // their text or resurrect an approval already answered/cancelled.
  if(snapshot.seq<(record.lastSeq||0)){record.activity=liveActivity;record.needsSnapshot=true;return;}
  if(Array.isArray(snapshot.agents)){replaceAgents(message,snapshot.agents);for(const agent of message.agents)queueAgentUpdate(chat,record,message,agent);}
  if(snapshot.plan&&typeof snapshot.plan.text==='string')applyPlanEvent(message,snapshot.plan);if(typeof snapshot.nativeExecutionMode==='boolean')message.nativeExecutionMode=snapshot.nativeExecutionMode;
  message.text=snapshot.text;record.lastSeq=snapshot.seq;message.remoteSeq=snapshot.seq;delete message.remoteEventSeqs;
  if(snapshot.session)record.remoteEmit({type:'session',session:snapshot.session});
  const approvals=Array.isArray(snapshot.approvals)?snapshot.approvals:[],keys=new Set(approvals.map(a=>a.requestId));
  for(const [key,a]of record.approvals)if(!keys.has(a.requestId))record.approvals.delete(key);
  chat.approvals=[...record.approvals.values()].map(approvalPublic);
  for(const approval of approvals)record.remoteEmit({...approval,type:'approval'});
  for(const followup of snapshot.followups||[])applyFollowupDelivery(chat,followup.messageId,followup.status,followup.detail,{runId:record.id,message,replyOffset:followup.replyOffset});
  record.canSteer=Boolean(snapshot.canSteer);record.needsSnapshot=false;
  if(chat.run?.id===record.id){delete chat.run.connectionLost;delete chat.run.recovering;}
  if(snapshot.preparing)setRunActivity(chat,record,'starting','Подготавливает файлы и подключённые инструменты…');
  else if(snapshot.finishing)setRunActivity(chat,record,'saving','Сохраняет ответ и файлы…');
  else if(record.activity?.phase==='reconnecting')setRunActivity(chat,record,'running','Продолжает работу…');
  refreshRunActivity(chat,record);record.deltaPending=true;flushReplyDelta(chat,record,message);await persist();changed(chat);
  void pumpFollowups(chat,record)?.catch(console.error);
 })().catch(error=>{record.needsSnapshot=true;console.warn(JSON.stringify({event:'run-reattach-retry',runId:record.id,deviceId:device.id,message:error.message}));}).finally(()=>{record.restoreRequest=null;});
 return record.restoreRequest;
}
async function failRestoredRun(record,error){
 if(record.closing||active.get(record.chatId)!==record)return;
 record.closing=true;clearInterval(record.recoveryTimer);clearTimeout(record.deltaTimer);record.followupController?.abort();
 const chat=data.conversations.find(c=>c.id===record.chatId),message=record.message;
 clearTransferProgress(chat,record);
 if(message){message.status=record.controller.signal.aborted?'interrupted':'failed';message.error=error.message;finishAgents(message,message.status);if(chat){for(const agent of message.agents||[])queueAgentUpdate(chat,record,message,agent);flushAgentUpdates(chat,record,message);}}
 if(chat?.run?.id===record.id){chat.run=null;chat.approvals=[];}
 active.delete(record.chatId);chatLocks.delete(record.chatId);dispatchDevices.delete(record.chatId);
 await persist();if(chat){changed(chat);if(message)notifyChat(chat,'failed',message);}
}
function restoreRemoteRuns(){
 for(const chat of data.conversations){
  if(!chat.run?.recovering)continue;
  const runId=chat.run.id,pending=data.pendingRemote[runId],message=chat.messages.find(m=>m.id===pending?.messageId);
  if(!pending||!message)continue;
  const options={...chat.route,...pending.options,provider:pending.provider,deviceId:pending.deviceId,accountId:pending.accountId||'',workspaceMode:pending.workspaceMode};
  const controller=new AbortController(),record={id:runId,chatId:chat.id,deviceId:pending.deviceId,controller,approvals:new Map(),message,restored:true,needsSnapshot:true,workerSeen:Date.now(),lastSeq:message.remoteSeq||0,streamRevision:Date.now(),remoteAccepted:Boolean(pending.runAccepted),before:pending.before,activity:{phase:'reconnecting',text:'Восстанавливаю связь с выполняющейся задачей…'}};
  active.set(chat.id,record);chatLocks.add(chat.id);dispatchDevices.set(chat.id,record.deviceId);attachRunEvents(chat,record,message,options);
  for(const approval of [...(chat.approvals||[])])record.remoteEmit({...approval,type:'approval'});
  record.remoteReject=error=>void failRestoredRun(record,error).catch(console.error);
  controller.signal.addEventListener('abort',()=>{pending.cancelRequested=true;out(bridges.get(record.deviceId),{type:'abort',runId});setRunActivity(chat,record,'stopping','Останавливает работу на компьютере…');void persist().catch(console.error);changed(chat);},{once:true});
  record.recoveryTimer=setInterval(()=>{
   if(record.closing)return;
   if(Date.now()-record.workerSeen>1200000)record.remoteReject(new Error('Компьютер не подтвердил восстановление связи за 20 минут. Результат останется на нём и загрузится после подключения.'));
   else{const device=data.devices.find(d=>d.id===record.deviceId),ws=bridges.get(record.deviceId);if(device&&ws?.readyState===1&&record.needsSnapshot)void restoreRunSnapshot(device,ws,record);}
  },15000);record.recoveryTimer.unref();
  if(pending.cancelRequested)controller.abort();
 }
}
async function runChat(chat,user,initial,launch={}){
 chatLaunches.set(chat.id,launch);
 chat.notificationUsers=[...new Set([...(chat.notificationUsers||[]),user.id])];
 const project=projectById(chat.projectId),dir=workspace(project);const controller=new AbortController();const visited=new Set();let options={...initial},record,message,lastPartialSave=0,persistTimer,successful=false;
 chatLocks.add(chat.id);
 // Deletion invalidates future native context without touching an in-flight turn.
 if(chat.providerSessionsResetPending){chat.providerSessions={};delete chat.providerSessionsResetPending;}
 try{await fs.mkdir(dir,{recursive:true});for(let attempt=0;attempt<3;attempt++){
  options.accountId=selectedAccount(options.deviceId,options.provider,options.accountId);
  options.workspaceMode=parallelReady(options.deviceId)?'chat-v1':'project';const routeKey=sessionKey(options);visited.add(routeKey);chat.providerSessions||={};options.executionMode=executionMode(options.deviceId,options.executionMode||'build');options.readOnly=chat.kind==='side';options.autoMemory=data.settings.autoMemory&&!options.readOnly&&options.executionMode!=='plan';
  const runId=id(),limitsScope=captureLimitsScope(options);message={id:id(),runId,role:'assistant',provider:options.provider,executionMode:options.executionMode,text:'',status:'running',actions:[],createdAt:now(),automatic:attempt>0};launch.message=message;chat.messages.push(message);
  for(const messageId of options.queuedMessageIds||[]){const queued=chat.messages.find(m=>m.id===messageId&&m.followup&&m.delivery==='dispatching');if(queued)queued.afterRunId=runId;}
  record={id:runId,controller,readOnly:options.readOnly,approvals:new Map(),message,chatId:chat.id,deviceId:options.deviceId,activity:{phase:'starting',text:'Подготавливаю общий контекст…'}};chat.approvals=[];active.set(chat.id,record);
  chat.run={id:runId,provider:options.provider,executionMode:options.executionMode,accountId:options.accountId||'',deviceId:options.deviceId,deviceName:devices().find(d=>d.id===options.deviceId)?.name||options.deviceId,accountName:options.accountId?(devices().find(d=>d.id===options.deviceId)?.accounts||[]).find(a=>a.id===options.accountId)?.name||'Аккаунт подписки':'Основной аккаунт',owner:user.name,phase:'starting',text:attempt?'Продолжаю сохранённую работу другим провайдером…':'Подготавливаю общий контекст…',startedAt:now()};chat.provider=options.provider;chat.deviceName=chat.run.deviceName;chat.route={...options};
  delete chat.pendingSubmission;await saveCheckpoint(chat,attempt?'auto-switch':'starting');changed(chat);
  const emit=attachRunEvents(chat,record,message,options);
  try{
    if(options.deviceId!==localId)startTransferProgress(chat,record,'download');
    const memory=data.memories.filter(m=>m.projectId===project.id),tasks=data.tasks.filter(t=>t.projectId===project.id);const transportContext=options.deviceId===localId?null:await projectFiles.run(project.id,()=>prepareRemoteContext(dir,chat,contextChats(chat),{sessionKey:routeKey}));const before=await projectFiles.run(project.id,async()=>{const files=options.deviceId===localId?await syncWorkspace(dir,sessionWorkspace(chat)):await snapshot(dir);await captureFileReview('captureBefore',dir,chat.id,runId,files);return files;});record.before=before;record.accepted={};
    let agentNotes;
    if(options.deviceId===localId){record.localDir=sessionWorkspace(chat);const result=await continueConversation({providers:accounts.get(options.provider,options.accountId),cwd:record.localDir,chat,project,memories:memory,tasks,relatedChats:contextChats(chat),options,session:chat.providerSessions[routeKey]},emit,controller.signal);message.model||=result.model;agentNotes=await readAgentNotes(record.localDir,chat);}
    else{
      data.pendingRemote[runId]={chatId:chat.id,projectId:project.id,deviceId:options.deviceId,messageId:message.id,provider:options.provider,accountId:options.accountId||'',workspaceMode:options.workspaceMode,options:{...options},userId:user.id,before};await persist();
      let transferFiles,fileTransfer;
      if(bridges.get(options.deviceId)?.protocolVersion>=3){
        if(before.length>(bridges.get(options.deviceId)?.workspaceFileLimit||10000))throw fail(426,'Для проекта с более чем 10 000 рабочими файлами обнови подключение выбранного Mac. Новое подключение поддерживает 100 000 файлов; повторно устанавливать подписки не нужно.');
        const status=await requestDevice(options.deviceId,'workspace-status',{runId,projectId:project.id,chatId:chat.id,workspaceMode:options.workspaceMode,files:before},120000,controller.signal);
        if(!Array.isArray(status.needed))throw new Error('Компьютер вернул некорректный список рабочих файлов.');
        const needed=new Set(status.needed.filter(name=>!isIgnoredPortablePath(name)));
        // Freeze one inventory for this turn. Each content read and the target
        // checksum still verify it; there is no full project walk per chunk.
        transferFiles=before;const inventory=new Set(transferFiles.map(file=>file.path));
        if([...needed].some(name=>!inventory.has(name)))throw new Error('Компьютер запросил файл, которого нет в списке передачи.');
        const selected=transferFiles.filter(file=>needed.has(file.path)),scope={runId,projectId:project.id,chatId:chat.id,workspaceMode:options.workspaceMode};
        startTransferProgress(chat,record,'download',selected);
        const envelope={type:'run',runId,chat:transportContext.chat,project,memories:memory,tasks,relatedChats:transportContext.relatedChats.filter(c=>c.id!==chat.id),options,files:transferFiles};
        if(Buffer.byteLength(JSON.stringify({...envelope,fileTransfer:{version:2,paths:selected.map(file=>file.path)}}))>(bridges.get(options.deviceId)?.workspaceFileLimit===MAX_WORKSPACE_FILES?96:16)*1024*1024)throw new Error('Служебные данные проекта слишком велики для запуска. История сохранена; файлы ещё не передавались.');
        const stageBatch=async batchFiles=>{
         controller.signal.throwIfAborted();if(batchFiles[0])currentTransferFile(chat,record,batchFiles[0]);
         const batch=await projectFiles.run(project.id,()=>readFileBatch(dir,batchFiles));
         const ack=await requestDevice(options.deviceId,'workspace-stage',{...scope,files:batch},120000,controller.signal);
         if(!Array.isArray(ack.paths)||ack.paths.length!==batch.length){throw new Error('Компьютер не подтвердил передачу файлов. Повтори продолжение.');}
         const paths=new Set(ack.paths);if(paths.size!==batch.length||batch.some(file=>!paths.has(file.path)))throw new Error('Компьютер не подтвердил передачу файлов. Повтори продолжение.');
         for(const file of batchFiles)acknowledgeTransferFile(chat,record,file,file.size);
        };
        if(status.largeFilesVersion===1){
         fileTransfer={version:2,paths:selected.map(file=>file.path)};
         const staged=await requestDevice(options.deviceId,'workspace-transfer-status',{...scope,files:selected},120000,controller.signal);
         if(!Array.isArray(staged.files)||staged.files.length!==selected.length)throw new Error('Компьютер вернул некорректное состояние передачи.');
         const remoteFiles=new Map(staged.files.map(file=>[file.path,file]));if(remoteFiles.size!==selected.length)throw new Error('Компьютер вернул повторяющиеся файлы передачи.');
         for(const file of selected){const remote=remoteFiles.get(file.path),offset=remote?.offset;
          if(!remote||remote.hash!==file.hash||remote.size!==file.size||!Number.isSafeInteger(offset)||offset<0||offset>file.size)throw new Error('Компьютер вернул некорректное состояние передачи.');
         }
         startTransferProgress(chat,record,'download',selected,staged.files);
         // Batch only complete, fresh tiny files. Their acknowledgments use
         // the same immutable v2 manifest as large/resumed file chunks.
         const small=status.workspaceBatchVersion===1?selected.filter(file=>file.size>0&&file.size<=256*1024&&remoteFiles.get(file.path).offset===0):[],smallPaths=new Set(small.map(file=>file.path)),chunked=selected.filter(file=>!smallPaths.has(file.path));
         for(const batchFiles of transferBatches(small)){
          controller.signal.throwIfAborted();currentTransferFile(chat,record,batchFiles[0]);
          const batch=await projectFiles.run(project.id,()=>readFileBatch(dir,batchFiles));
          const ack=await requestDevice(options.deviceId,'workspace-file-batch',{...scope,chunks:batch.map(file=>({path:file.path,hash:file.hash,offset:0,content:file.content}))},120000,controller.signal);
          if(!Array.isArray(ack.files)||ack.files.length!==batchFiles.length)throw new Error('Компьютер не подтвердил пакет рабочих файлов.');
          const confirmations=new Map(ack.files.map(file=>[file.path,file]));if(confirmations.size!==batchFiles.length)throw new Error('Компьютер вернул повторяющееся подтверждение файла.');
          for(const file of batchFiles){const confirmation=confirmations.get(file.path);if(confirmation?.offset!==file.size||confirmation.complete!==true)throw new Error('Компьютер не подтвердил целый файл.');acknowledgeTransferFile(chat,record,file,file.size);}
         }
         for(const file of chunked){let offset=remoteFiles.get(file.path).offset;currentTransferFile(chat,record,file);
          while(offset<file.size){controller.signal.throwIfAborted();
           const chunk=await projectFiles.run(project.id,()=>workspaceChunk(dir,file,offset));const ack=await requestDevice(options.deviceId,'workspace-file-chunk',{...scope,...chunk},120000,controller.signal);
           if(!Number.isSafeInteger(ack.offset)||ack.offset<offset+Buffer.byteLength(chunk.content,'base64')||ack.offset>file.size)throw new Error('Компьютер не подтвердил часть файла.');offset=ack.offset;acknowledgeTransferFile(chat,record,file,offset);
          }
         }
        }else if(selected.some(f=>f.size>100*1024*1024)||transferFiles.reduce((n,f)=>n+f.size,0)>1024*1024*1024){throw new Error('Для файлов больше 100 МБ обнови Team Room на выбранном Mac. После обновления программы подключение обновится автоматически.');}
        else if(status.fileTransferVersion===1){
         fileTransfer={version:1,paths:selected.map(file=>file.path)};
         for(const batch of transferBatches(selected))await stageBatch(batch);
        }else{
         if(selected.reduce((n,f)=>n+f.size,0)>MAX_TRANSFER)throw new Error('Для этого проекта нужно обновить подключение на выбранном Mac: Team Room → Этот Mac → Обновить подключение. Затем продолжи сессию.');
         const content=new Map((await projectFiles.run(project.id,()=>readFileBatch(dir,selected))).map(f=>[f.path,f]));transferFiles=transferFiles.map(f=>content.get(f.path)||f);
        }
      }else{transferFiles=await projectFiles.run(project.id,()=>readFileBatch(dir,before));startTransferProgress(chat,record,'download',before);}
      if(fileTransfer)finalizeTransferProgress(chat,record);
      else record.transferInline=true;
      controller.signal.throwIfAborted();
      // Pin this turn to the actual shared snapshot sent to its working copy.
      record.before=transferFiles.map(({content,...f})=>f);
      // Preparation uses the frozen inventory already saved in pendingRemote.
      // Only a genuinely changed manifest needs another full durable snapshot.
      const savedBefore=data.pendingRemote[runId].before;
      if(savedBefore.length!==record.before.length||savedBefore.some((file,index)=>{const next=record.before[index];return file.path!==next.path||file.hash!==next.hash||file.size!==next.size||file.updatedAt!==next.updatedAt;})){data.pendingRemote[runId].before=record.before;await persist();}
      // Legacy connectors also receive portable migration metadata. Add the
      // pointer only when creating a native session; never alter saved messages.
      let transportChat=transportContext.chat;
      if(chat.fileAliases?.file&&!chat.providerSessions[routeKey]?.sessionId){
       const latest=chat.messages.findLast(m=>m.role==='user'&&!['queued','sending','received','uncertain','cancelled'].includes(m.delivery));
       if(latest)transportChat={...transportChat,messages:transportChat.messages.map(m=>m.id===latest.id?{...m,text:m.text+`\n\nWorkspace move: earlier file paths may be outdated. See ${chat.fileAliases.file}; match fileAliasGroup in .team-room/project-chats.json to the current paths.`}:m)};
      }
      const payload={runId,chat:transportChat,project,memories:memory,tasks,relatedChats:transportContext.relatedChats.filter(c=>c.id!==chat.id),options,files:transferFiles,...(fileTransfer?{fileTransfer}:{})};
      const result=await new Promise((resolve,reject)=>{const ws=bridges.get(options.deviceId);if(importMaintenance(options.deviceId))return reject(fail(409,'Этот Mac обновляет перенос сессий. Подожди несколько секунд.'));if(!ws||ws.readyState!==1)return reject(new Error('Выбранный компьютер отключён.'));if(ws.protocolVersion===1)return reject(new Error('Обнови Team Room Community Connect в разделе «Компьютеры»: старая версия повторно передаёт историю.'));record.remoteResolve=resolve;record.remoteReject=reject;const abort=()=>{if(data.pendingRemote[runId])data.pendingRemote[runId].cancelRequested=true;out(bridges.get(options.deviceId)||{readyState:0},{type:'abort',runId});setRunActivity(chat,record,'stopping','Останавливает работу на компьютере и сохраняет файлы…');record.followupController?.abort();void persist().catch(console.error);changed(chat);};controller.signal.addEventListener('abort',abort,{once:true});record.abort=abort;record.workerSeen=Date.now();record.remotePacket={type:'run',...payload};record.remotePacketSerialized=JSON.stringify(record.remotePacket);const payloadBytes=Buffer.byteLength(record.remotePacketSerialized);if(payloadBytes>(ws.workspaceFileLimit===MAX_WORKSPACE_FILES?96:16)*1024*1024)return reject(new Error('Служебный пакет запуска слишком большой. История сохранена; передача требует дополнительного разбиения.'));record.remoteDispatched=true;record.dispatchedAt=Date.now();console.log(JSON.stringify({event:'run-dispatch',runId,deviceId:options.deviceId,provider:options.provider,payloadBytes,archivedMessages:transportContext.archivedMessages,archivedHistories:transportContext.archivedHistories}));persistTimer=setInterval(()=>{if(!record.remoteAccepted&&Date.now()-record.dispatchedAt>90000){reject(new Error('Компьютер не подтвердил запуск задачи за 90 секунд. История и файлы сохранены.'));return;}if(Date.now()-record.workerSeen>1200000)reject(new Error('Компьютер не подтверждал выполнение 20 минут. Последний ответ и файлы сохранены.'))},30000);out(ws,record.remotePacket,record.remotePacketSerialized);record.lastDispatch=Date.now();});
      // The result's final text is authoritative after a reconnect, even if some deltas were missed.
      if(typeof result.text==='string')message.text=result.text;if(Array.isArray(result.agents))replaceAgents(message,result.agents);if(result.plan&&typeof result.plan.text==='string')applyPlanEvent(message,result.plan);if(typeof result.nativeExecutionMode==='boolean')message.nativeExecutionMode=result.nativeExecutionMode;
      for(const f of result.followups||[])applyFollowupDelivery(chat,f.messageId,f.status,f.detail,{runId,message,replyOffset:f.replyOffset});
      if(result.session)chat.providerSessions[routeKey]=result.session;
      record.remoteFinalizationStage='files';const pending=data.pendingRemote[runId];if(pending)pending.accepted||=record.accepted;
      const merged=options.readOnly?noFileChanges():await applyRemoteResult(project,result,record.before,runId,pending?.accepted||record.accepted);syncNotice(chat,message,merged);record.nativeFiles=resultFiles(record.before,result.changes);record.remoteResult=true;agentNotes=result.agentNotes;
      if(controller.signal.aborted)throw new Error('Сессия остановлена. Ответ и файлы сохранены.');
      if(result.error)throw new Error(result.error);
    }
    if(options.autoMemory&&agentNotes)try{storeMemory(data,chat,parseMemory(JSON.stringify(agentNotes),chat.messages),{provider:options.provider,origin:'agent-checkpoint'});}catch{}
    message.status='completed';successful=true;
  }catch(error){message.status=controller.signal.aborted?'interrupted':'failed';message.error=error.message;const syncFailed=record.remoteFinalizationOwner==='live'&&!record.remoteResult;message.limitReached=!syncFailed&&isLimit(error.message);if(syncFailed)remoteFinalizationFailure(runId,record.remoteFinalizationStage||'files',error,{record,chat,message});}
  finally{record.closing=true;clearTimeout(record.transferTimer);record.transferTimer=null;finishAgents(message,message.status);for(const agent of message.agents||[])queueAgentUpdate(chat,record,message,agent);flushAgentUpdates(chat,record,message);record.deltaPending=true;flushReplyDelta(chat,record,message);record.followupController?.abort();record.approvals.clear();chat.approvals=[];setRunActivity(chat,record,'saving','Сохраняет ответ и файлы…');changed(chat);await record.localSync?.catch(()=>{});if(record.localDir&&!record.readOnly)try{const merged=await applyRemote(project,await localChanges(record.localDir,record.before),record.before,runId,record.accepted);record.nativeFiles=await snapshot(record.localDir);syncNotice(chat,message,merged);}catch(error){message.status='failed';message.error='Работа сохранена в копии сессии, перенос не завершён: '+error.message;successful=false;}await record.followupPump?.catch(console.error);clearTimeout(persistTimer);if(record.abort)controller.signal.removeEventListener('abort',record.abort);record.approvals.clear();chat.approvals=[];record.remoteResolve=null;record.remoteReject=null;
    try{
     record.remoteFinalizationStage='snapshot';chat.files=await projectFiles.run(project.id,async()=>{const files=await snapshot(dir);await captureFileReview('captureAfter',dir,chat.id,runId,files);return files;});finishSession(chat,routeKey,record.nativeFiles||chat.providerSessions[routeKey]?.files);checkpoint(chat,chat.files,'turn-end');recordCompletion(chat,message,runId);if(record.remoteResult||options.deviceId!==localId&&!record.remoteDispatched){delete data.pendingRemote[runId];data.completedRuns.push(runId);data.completedRuns=data.completedRuns.slice(-2000)}record.remoteFinalizationStage='persist';await persist();broadcast({type:'reply-complete',chatId:chat.id,messageId:message.id,runId,text:message.text,replyBoundaries:message.replyBoundaries||[],status:message.status,error:message.error||null,revision:chat.revision||0});await runProgress.clear(runId).catch(()=>console.error('Не удалось очистить промежуточный ответ; основная история сохранена.'));if(record.remoteResult){await acknowledgeRemoteResult(bridges.get(record.deviceId)||{readyState:0},runId);await incomingResults.cleanup(runId).catch(console.error);}
    }catch(error){if(record.remoteFinalizationOwner==='live')remoteFinalizationFailure(runId,record.remoteFinalizationStage,error,{record,chat,message});throw error;}
  }
  if(message.limitReached&&data.settings.autoSwitch&&!controller.signal.aborted&&attempt<2){const next=await alternative(options,visited);if(next){chat.switches||=[];chat.switches.push({at:now(),from:options,to:next,reason:'limit',checkpointAt:chat.checkpoint.updatedAt});options={...next,permissionMode:(next.deviceId===localId||bridges.get(next.deviceId)?.permissionsVersion===1)?initial.permissionMode:'manual',preferences:initial.preferences,executionMode:initial.executionMode||'build'};broadcast({type:'route',chatId:chat.id,options,reason:'limit'});continue}}
  break;
 }}finally{
  chat.updatedAt=now();checkpoint(chat,chat.files,'saved');try{await writeHandoff(dir,chat,data.memories.filter(m=>m.projectId===project.id),data.tasks.filter(t=>t.projectId===project.id),contextChats(chat));}catch(error){console.warn(JSON.stringify({event:'handoff-unavailable',chatId:chat.id,runId:record?.id,code:error.code||null,message:error.message}));}changed(chat);
  // Approaching a quota only shows a reminder; keep the user's selected route.
  // A manual selection can arrive while catalog/persistence is awaiting I/O.
  // Apply the newest pending selection before dispatching saved followups.
  try{while(chat.pendingRoute&&(!active.has(chat.id)||active.get(chat.id)===record)){chat.route=chat.pendingRoute;chat.executionDeviceId=chat.route.deviceId;delete chat.pendingRoute;await persist();broadcast({type:'route',chatId:chat.id,options:chat.route,reason:'manual'});}}
  finally{
   if(record){delete record.remoteFinalizationOwner;record.remoteResultReceived=false;record.needsSnapshot=true;}
   if(chatLaunches.get(chat.id)===launch)chatLaunches.delete(chat.id);
   if(active.get(chat.id)===record)active.delete(chat.id);
   if(chat.run?.id===record?.id)chat.run=null;
   if(!active.has(chat.id)&&!chatLaunches.has(chat.id)&&!chat.run){chatLocks.delete(chat.id);dispatchDevices.delete(chat.id);}
   changed(chat);
  }
  for(const m of chat.messages)if(m.afterRunId===record?.id&&m.delivery==='dispatching'){m.delivery='queued';m.status='queued';}
  await persist();changed(chat);
  if(message&&!controller.signal.aborted){if(!successful)notifyChat(chat,'failed',message);else if(!chat.messages.some(m=>m.followup&&m.delivery==='queued'))notifyChat(chat,responseNeedsAnswer(message.text)?'questions':'completed',message);}
  if(successful&&!controller.signal.aborted)startQueuedFollowups(chat,user);titleQueue.enqueue(chat);
 }
}
const remoteWrites=new Map();
async function serialRemote(runId,fn){const next=(remoteWrites.get(runId)||Promise.resolve()).catch(()=>{}).then(fn);remoteWrites.set(runId,next);try{return await next}finally{if(remoteWrites.get(runId)===next)remoteWrites.delete(runId)}}
async function acknowledgeRemoteResult(ws,runId){
 if(!durableCompletedRuns.has(runId)||!out(ws,{type:'result-ack',runId}))return false;
 // The immutable envelope is retained through verification, merge and fsync.
 // Only an ACK for the durable completed result permits removing this spool.
 await incomingResultEnvelopes.cleanup(runId).catch(error=>console.warn(JSON.stringify({event:'result-envelope-cleanup-unavailable',runId,code:error.code||null,message:error.message})));
 return true;
}
async function completedRunSaved(runId){
 if(!data.completedRuns.includes(runId))return false;
 // In-memory completion may precede a failed disk write. The Mac must retain
 // its outbox until the result is part of a successful durable snapshot.
 if(!durableCompletedRuns.has(runId))await persist();
 if(!durableCompletedRuns.has(runId))return false;
 // A previous save may have succeeded before a handoff/cleanup error. Release
 // only this finished run; a late receipt must never unlock a newer one.
 const released=[];
 for(const chat of data.conversations){
  const record=active.get(chat.id),sameRecord=record?.id===runId,sameRun=chat.run?.id===runId;
  const message=chat.messages.find(m=>m.runId===runId&&m.role==='assistant');
  if(!sameRecord&&!sameRun&&!message?.finalizationSyncError)continue;
  if(sameRecord){record.closing=true;clearInterval(record.recoveryTimer);clearTimeout(record.deltaTimer);clearTransferProgress(chat,record);record.followupController?.abort();record.approvals.clear();record.remoteResolve=null;record.remoteReject=null;delete record.remoteFinalizationOwner;active.delete(chat.id);}
  if(sameRun){chat.run=null;chat.approvals=[];}
  if(chatLaunches.get(chat.id)?.message?.runId===runId)chatLaunches.delete(chat.id);
  if((sameRecord||sameRun)&&!active.has(chat.id)&&!chat.run&&!chatLaunches.has(chat.id)){chatLocks.delete(chat.id);dispatchDevices.delete(chat.id);}
  if(message?.finalizationSyncError){if(message.syncWarning===message.finalizationSyncError)delete message.syncWarning;delete message.finalizationSyncError;}
  for(const m of chat.messages)if(m.afterRunId===runId&&m.delivery==='dispatching'){m.delivery='queued';m.status='queued';}
  released.push({chat,message});
 }
 if(released.length){await persist();for(const {chat,message}of released){changed(chat);if(message)broadcast({type:'reply-complete',chatId:chat.id,messageId:message.id,runId,text:message.text,replyBoundaries:message.replyBoundaries||[],status:message.status,error:message.error||null,revision:chat.revision||0});}}
 await runProgress.clear(runId).catch(console.error);await incomingResults.cleanup(runId).catch(console.error);
 return true;
}
async function checkpointRunSaved(runId,revision){
 if(!Number.isSafeInteger(revision)||revision<1||(data.pendingRemote[runId]?.revision||0)<revision)return false;
 if((durableCheckpointRevisions.get(runId)||0)<revision)await persist();
 return true;
}
const recovering=new Set();
async function recoverRemoteResult(device,ws,msg){
 let stage='durability',chat,restored,message;
 try{if(await completedRunSaved(msg.runId))return acknowledgeRemoteResult(ws,msg.runId);}catch(error){remoteFinalizationFailure(msg.runId,stage,error);return out(ws,{type:'error',message:'Результат сохранён на устройстве, восстановление не завершено: '+error.message});}
 const pending=data.pendingRemote[msg.runId];
 if(!pending||pending.deviceId!==device.id)return out(ws,{type:'result-unknown',runId:msg.runId});
 if(deletingChats.has(pending.chatId)||recovering.has(msg.runId))return;
 recovering.add(msg.runId);
 try{
  stage='context';const project=projectById(pending.projectId);chat=data.conversations.find(c=>c.id===pending.chatId);if(!chat)throw new Error('Исходный чат не найден.');
  restored=active.get(chat.id)?.id===msg.runId?active.get(chat.id):null;
  if(restored?.remoteFinalizationOwner==='live')return;
  if(restored){restored.remoteFinalizationOwner='recovery';restored.remoteResultReceived=true;restored.followupController?.abort();}
  message=chat.messages.find(m=>m.id===pending.messageId);
  stage='files';pending.accepted||={};const merged=chat.kind==='side'||pending.options?.readOnly?noFileChanges():await applyRemoteResult(project,msg,pending.before,msg.runId,pending.accepted);
  if(message){
   if(typeof msg.text==='string')message.text=msg.text;if(Array.isArray(msg.agents))replaceAgents(message,msg.agents);if(msg.plan&&typeof msg.plan.text==='string')applyPlanEvent(message,msg.plan);if(typeof msg.nativeExecutionMode==='boolean')message.nativeExecutionMode=msg.nativeExecutionMode;
   message.status=pending.cancelRequested?'interrupted':msg.error?'failed':'completed';message.error=pending.cancelRequested?'Сессия остановлена. Ответ и файлы сохранены.':msg.error||null;finishAgents(message,message.status);if(message.syncWarning===message.finalizationSyncError)delete message.syncWarning;delete message.finalizationSyncError;syncNotice(chat,message,merged);message.actions||=[];
   if(!message.actions.some(a=>a.tool==='Восстановление'&&a.runId===msg.runId))message.actions.push({tool:'Восстановление',runId:msg.runId,details:msg.workerAbsent?'Компьютер подтвердил отсутствие процесса и очереди результатов. Старый запуск освобождён; уже полученные файлы сохранены.':'Результат и файлы восстановлены после разрыва связи.',at:now()});
  }
  if(data.settings.autoMemory&&chat.kind!=='side'&&pending.options?.autoMemory!==false&&!pending.options?.readOnly&&msg.agentNotes)try{storeMemory(data,chat,parseMemory(JSON.stringify(msg.agentNotes),chat.messages),{provider:pending.provider,origin:'agent-checkpoint'})}catch{}
  if(Array.isArray(msg.events)&&message){
   const known=new Set((message.actions||[]).filter(a=>a.toolId).map(a=>`${a.toolId}:${a.status||'started'}`));
   for(const packet of msg.events){
    const e=packet.event,status=e?.type==='tool-result'?(e.success?'completed':'failed'):'started',key=e?.toolId?`${e.toolId}:${status}`:null;
    if(['tool','tool-result'].includes(e?.type)&&(!key||!known.has(key))){if(key)known.add(key);message.actions.push({tool:e.type==='tool-result'?'Результат действия':e.tool,toolId:e.toolId,status,details:e.details,at:now()});}
   }
  }
  for(const packet of msg.events||[]){const e=packet.event;if(e?.type==='followup-delivery')applyFollowupDelivery(chat,e.messageId,e.status,e.detail,{runId:msg.runId,message,replyOffset:e.replyOffset});else if(message&&e?.type==='plan'&&typeof e.text==='string')applyPlanEvent(message,e);}
  for(const f of msg.followups||[])applyFollowupDelivery(chat,f.messageId,f.status,f.detail,{runId:msg.runId,message,replyOffset:f.replyOffset});
  // A late result must not replace the native context of a newer turn.
  const newer=message&&chat.messages.slice(chat.messages.indexOf(message)+1).some(m=>m.role==='assistant'&&m.runId!==msg.runId);
  if(msg.session&&!newer){chat.providerSessions||={};chat.providerSessions[sessionKey(pending)]=msg.session;finishSession(chat,sessionKey(pending),resultFiles(pending.before,msg.changes));}
  stage='snapshot';chat.updatedAt=now();chat.files=await projectFiles.run(project.id,async()=>{const dir=workspace(project),files=await snapshot(dir);await captureFileReview('captureAfter',dir,chat.id,msg.runId,files);return files;});checkpoint(chat,chat.files,'recovery');
  if(restored){
   restored.closing=true;flushAgentUpdates(chat,restored,message);clearTimeout(restored.deltaTimer);restored.approvals.clear();
   if(chat.pendingRoute){chat.route=chat.pendingRoute;delete chat.pendingRoute;broadcast({type:'route',chatId:chat.id,options:chat.route,reason:'manual'});}
  }
  if(message&&!newer)recordCompletion(chat,message,msg.runId);
  delete data.pendingRemote[msg.runId];data.completedRuns.push(msg.runId);data.completedRuns=data.completedRuns.slice(-2000);
  stage='persist';await persist();stage='release';if(!await completedRunSaved(msg.runId))throw new Error('Сохранение результата ещё не подтверждено.');await acknowledgeRemoteResult(ws,msg.runId);changed(chat);
  if(message)broadcast({type:'reply-complete',chatId:chat.id,messageId:message.id,runId:msg.runId,text:message.text,replyBoundaries:message.replyBoundaries||[],status:message.status,error:message.error||null,revision:chat.revision||0});
  await runProgress.clear(msg.runId).catch(console.error);await incomingResults.cleanup(msg.runId).catch(console.error);
  if(message&&message.status!=='interrupted'&&!msg.workerAbsent)notifyChat(chat,msg.error?'failed':responseNeedsAnswer(message.text)?'questions':'completed',message);
  if(restored&&!msg.error&&!pending.cancelRequested)startQueuedFollowups(chat,data.users.find(u=>u.id===pending.userId)||data.users.find(u=>u.name===chat.owner));titleQueue.enqueue(chat);
 }catch(error){remoteFinalizationFailure(msg.runId,stage,error,{record:restored,chat,message,retry:true});out(ws,{type:'error',message:'Результат сохранён на устройстве, восстановление не завершено: '+error.message})}finally{if(restored?.remoteFinalizationOwner==='recovery')delete restored.remoteFinalizationOwner;recovering.delete(msg.runId)}
}
async function receiveCheckpoint(device,ws,msg){
 const pending=data.pendingRemote[msg.runId];if(!pending||pending.deviceId!==device.id||deletingChats.has(pending.chatId))return;
 const record=[...active.values()].find(r=>r.id===msg.runId&&r.deviceId===device.id);
 if(record?.remoteResultReceived)return out(ws,{type:'checkpoint-ack',runId:msg.runId,revision:msg.revision});
 if(!Number.isSafeInteger(msg.revision)||msg.revision<1)throw fail(400,'Некорректная контрольная точка.');
 if(await checkpointRunSaved(msg.runId,msg.revision))return out(ws,{type:'checkpoint-ack',runId:msg.runId,revision:msg.revision});
 const chat=data.conversations.find(c=>c.id===pending.chatId);if(!chat)return;const project=projectById(pending.projectId);
 pending.accepted||={};const merged=chat.kind==='side'||pending.options?.readOnly?noFileChanges():await applyRemote(project,msg.changes,pending.before,msg.runId,pending.accepted);
 const m=chat.messages.find(m=>m.id===pending.messageId);syncNotice(chat,m,merged);if(m&&typeof msg.text==='string'&&msg.text.length>=m.text.length)m.text=msg.text;
 for(const f of msg.followups||[])applyFollowupDelivery(chat,f.messageId,f.status,f.detail,{runId:msg.runId,message:m,replyOffset:f.replyOffset});
 if(data.settings.autoMemory&&chat.kind!=='side'&&pending.options?.autoMemory!==false&&!pending.options?.readOnly&&msg.agentNotes)try{storeMemory(data,chat,parseMemory(JSON.stringify(msg.agentNotes),chat.messages),{provider:pending.provider,origin:'agent-checkpoint'})}catch{}
 pending.revision=msg.revision;chat.files=await projectFiles.run(project.id,()=>snapshot(workspace(project)));checkpoint(chat,chat.files,'device-checkpoint');await persist();out(ws,{type:'checkpoint-ack',runId:msg.runId,revision:msg.revision});changed(chat);
}
const importLocks=new Set(),importingChats=new Set(),deletingProjects=new Set(),deletingChats=new Set(),projectDeleting=new Set();
function assertChatDeletable(chat){
 if(queueMutations.get(chat.id))throw fail(409,'Сохраняется изменение очереди. Повтори через несколько секунд.');
 if(pendingForkSources.get(chat.id))throw fail(409,'Сохраняется ответвление чата. Повтори через несколько секунд.');
 if(pendingMessageCount(chat.id))throw fail(409,'Сохраняется новое сообщение. Повтори через несколько секунд.');
 if(chat.run||active.has(chat.id)||chatLocks.has(chat.id))throw fail(409,'Эта сессия ещё работает. Дождись её завершения или останови её.');
 if(importingChats.has(chat.id))throw fail(409,'Обновляется перенос этой сессии. Подожди его завершения.');
 if(memoryJobs.has(chat.id)||Object.entries(data.pendingRemote).some(([runId,p])=>p.chatId===chat.id&&recovering.has(runId)))throw fail(409,'Сохраняются результаты этой сессии. Повтори через несколько секунд.');
}
function assertChatMovable(chat){
 assertChatDeletable(chat);
 if(Object.values(data.pendingRemote).some(p=>p.chatId===chat.id))throw fail(409,'У сессии есть несинхронизированный результат. Дождись сохранения перед переносом.');
}
function assertProjectIdle(project){
 if(pendingChatCreates.get(project.id))throw fail(409,'В проекте создаётся новый чат. Повтори через несколько секунд.');
 if(importLocks.has(project.id))throw fail(409,'В этот проект переносится сессия. Дождись завершения переноса.');
 for(const c of data.conversations.filter(c=>c.projectId===project.id)){try{assertChatDeletable(c)}catch(error){throw fail(409,'Сессия «'+c.title+'»: '+error.message)}}
}
function deletionFileProtection(chat,related){
 const paths=new Set();
 for(const c of related){
  if(c.id===chat.id||!(c.run||active.has(c.id)||chatLocks.has(c.id)))continue;
  const record=active.get(c.id);
  const pending=Object.values(data.pendingRemote).filter(p=>p.chatId===c.id);
  for(const files of [c.files,record?.before,...pending.map(p=>p.before),...Object.values(c.providerSessions||{}).map(s=>s.files)])for(const f of files||[])paths.add(f.path);
 }
 return paths;
}
const deviceImportMaintenance=new Map();
async function connectorProgramNames(){
 const entries=await fs.readdir(path.join(root,'lib'),{withFileTypes:true});
 return ['bridge.mjs','teamroom.mjs','install-integration.mjs','install-background.mjs',...entries.filter(e=>e.isFile()&&/^[a-zA-Z0-9_-]+\.mjs$/.test(e.name)).map(e=>'lib/'+e.name).sort(),'lib/voice-worker.py'];
}
function importMaintenance(deviceId){const lease=deviceImportMaintenance.get(deviceId);if(lease&&lease.until>Date.now())return lease;if(lease)deviceImportMaintenance.delete(deviceId);return null;}
async function acquireConnectorMaintenance(deviceId,input){
 const saved=input.savedResults===true,runIds=new Set(saved&&Array.isArray(input.runIds)?input.runIds:[]);
 if(saved&&(!runIds.size||runIds.size>256||runIds.size!==input.runIds.length||[...runIds].some(value=>typeof value!=='string'||!/^[-_a-zA-Z0-9]{8,240}$/.test(value))))throw fail(400,'Некорректный список сохранённых результатов.');
 const ws=bridges.get(deviceId),busy=()=>bridges.get(deviceId)?.loginBusy||bridges.get(deviceId)?.accounts?.some(a=>a.loginBusy)||[...dispatchDevices].some(([chatId,target])=>target===deviceId&&(!saved||!runIds.has(active.get(chatId)?.id)))||[...requests.values()].some(r=>r.deviceId===deviceId);
 const live=()=>[...active.values()].filter(r=>r.deviceId===deviceId);
 if(busy()||live().some(r=>!saved||!runIds.has(r.id)))throw fail(409,'Этот Mac занят. Дождись завершения работы и повтори обновление.');
 const lease={id:id(),until:Date.now()+600000};deviceImportMaintenance.set(deviceId,lease);
 try{
  if(saved&&ws?.readyState===1){
   // The helper proves durable nativeFinished journals locally; independently
   // confirm that the old connector has no live provider task for those IDs.
   const probes=new AbortController(),deadline=AbortSignal.any([probes.signal,AbortSignal.timeout(10000)]),queue=[...runIds];
   try{await Promise.all(Array.from({length:Math.min(4,queue.length)},async()=>{while(queue.length){deadline.throwIfAborted();const runId=queue.shift();const state=await requestDevice(deviceId,'run-state',{runId,afterSeq:Number.MAX_SAFE_INTEGER},8000,deadline,id(),lease.id);
    if(state?.runId!==runId||!(['result-saving','result-pending','missing'].includes(state.state)||state.state==='running'&&state.finishing===true&&state.preparing!==true))throw fail(409,'Модель ещё работает на этом Mac. Обновление дождётся завершения задачи.');
   }}));}finally{probes.abort();}
   if(bridges.get(deviceId)!==ws)throw fail(409,'Подключение изменилось во время проверки. Повторю безопасное обновление.');
  }else if(saved&&live().length)throw fail(409,'Сначала дождись восстановления связи с этим Mac.');
  if(busy()||live().some(r=>!saved||!runIds.has(r.id)))throw fail(409,'На Mac началась другая задача. Обновление отложено.');
  changed();return lease;
 }catch(error){if(deviceImportMaintenance.get(deviceId)===lease)deviceImportMaintenance.delete(deviceId);throw error;}
}
function nativeImportError(error){const code=String(error.message||'');const messages={IMPORT_SOURCE_TOO_LARGE:'Исходная история больше 8 ГБ. Раздели её на несколько сессий перед импортом.',IMPORT_SOURCE_CHANGED:'История изменилась во время чтения. Заверши запись в исходном приложении и повтори импорт.',IMPORT_RECORD_TOO_LARGE:'Одна запись истории больше 128 МБ. Уменьши крупное вложение в исходной сессии.',IMPORT_CONTENT_TOO_LARGE:'Сохранённая переписка и действия превышают 96 МБ или 50 000 записей. Нужен перенос отдельными частями; история не обрезалась.',IMPORT_TRANSFER_TOO_LARGE:'Переписка с вложениями превышает 160 МБ. Выбери перенос без файлов и перенеси файлы отдельно.'};if(messages[code])return fail(413,messages[code]);if(code==='IMPORT_BUSY')return fail(409,'На этом Mac уже читается другая сессия. Дождись окончания проверки и повтори.');if(code==='IMPORT_READ_TIMEOUT')return fail(408,'Чтение истории заняло больше 150 секунд. Повтори после окончания работы исходной сессии.');if(/^IMPORT_INVALID_RECORD:\d+$/.test(code))return fail(422,'В исходной истории повреждена запись № '+code.split(':')[1]+'. Импорт остановлен, чтобы не потерять сообщения.');if(code==='Сессия больше 128 МБ. Экспортируй её средствами исходного приложения.')return fail(409,'На этом Mac ещё старый компонент импорта с пределом 128 МБ. Обнови Team Room, затем открой «Этот Mac → Обновить перенос сессий».');if(['Сессия не найдена на выбранном компьютере.','В сессии пока нет сохранённых сообщений.','Компьютер не ответил вовремя.'].includes(code))return fail(409,code);return error;}
async function ensureLocalClient(){
 if(!data.users.length||hubOnly)return;const filename=path.join(storage,'local-client.json');let config;try{config=JSON.parse(await fs.readFile(filename,'utf8'))}catch{}
 if(config?.token&&data.integrationTokens.some(t=>t.tokenHash===tokenHash(config.token)))return;
 const token=crypto.randomBytes(32).toString('hex');data.integrationTokens=data.integrationTokens.filter(t=>t.kind!=='local-import');data.integrationTokens.push({kind:'local-import',tokenHash:tokenHash(token),userId:data.users[0].id,createdAt:now()});await persist();await fs.writeFile(filename,JSON.stringify({hubUrl:`http://127.0.0.1:${port}`,token,deviceId:'local',name:localName},null,2),{mode:0o600});
}
function importUser(req,url){
 if(!['/api/native-sessions','/api/import-session','/api/import-projects','/api/device-import-maintenance','/api/workspace-cleanup-plans'].includes(url.pathname)&&!/^\/api\/skills\/blobs\/[a-f0-9]{64}$/.test(url.pathname))return null;
 const token=String(req.headers.authorization||'').replace(/^Bearer /,'');if(!token)return null;
 const local=data.integrationTokens.find(t=>t.tokenHash===tokenHash(token));if(local)return data.users.find(u=>u.id===local.userId);
 const device=data.devices.find(d=>d.tokenHash===tokenHash(token));if(device)return data.users.find(u=>u.name===device.owner);
 return null;
}
function importDevice(req){const token=String(req.headers.authorization||'').replace(/^Bearer /,'');if(!token)return null;const d=data.devices.find(d=>d.tokenHash===tokenHash(token));if(d)return d.id;if(data.integrationTokens.some(t=>t.tokenHash===tokenHash(token)))return 'local';return null;}
async function nativeRead(deviceId,provider,sessionId,files,profile=''){profile=selectedAccount(deviceId,provider,profile);try{return await (deviceId==='local'?accounts.native(provider,profile).read(provider,sessionId,{files}):requestDevice(deviceId,'native-read',{provider,sessionId,files,accountId:profile},180000));}catch(error){throw nativeImportError(error)}}
const nativePreviewCache=new Map();
async function nativeSessionPreview(deviceId,provider,sessionId,profile=''){
 const key=[deviceId,provider,...(profile?[profile]:[]),sessionId].join(':');const cached=nativePreviewCache.get(key);if(cached&&cached.expiresAt>Date.now())return cached.promise;
 for(const [id,item]of nativePreviewCache)if(item.expiresAt<=Date.now())nativePreviewCache.delete(id);if(nativePreviewCache.size>=100)nativePreviewCache.delete(nativePreviewCache.keys().next().value);
 const entry={expiresAt:Date.now()+60000};entry.promise=(async()=>{const source=await nativeRead(deviceId,provider,sessionId,'none',profile);if(source.sessionId!==sessionId||!Array.isArray(source.messages))throw fail(409,'Источник вернул другую сессию. Обнови список.');const messages=source.messages;return {sessionId:source.sessionId,provider,title:source.title,cwd:source.cwd,messageCount:messages.length,textMessageCount:messages.filter(m=>m.text?.trim()).length,userMessageCount:messages.filter(m=>m.role==='user').length,firstAt:messages[0]?.createdAt||null,lastAt:messages.at(-1)?.createdAt||source.updatedAt||null,active:Boolean(source.active),warnings:source.warnings||[]};})();nativePreviewCache.set(key,entry);
 try{return await entry.promise}catch(error){if(nativePreviewCache.get(key)===entry)nativePreviewCache.delete(key);throw error;}
}
async function importSession(input,user,forcedDevice=null,loadedSource=null){
 const deviceId=forcedDevice||input.deviceId||'local',provider=input.provider,profile=selectedAccount(deviceId,provider,input.accountId);
 if(!['claude','codex'].includes(provider))throw new Error('Выбери Claude Code или Codex.');
 if(!devices().some(d=>d.id===deviceId&&d.online))throw new Error('Компьютер с исходной сессией отключён.');
 let project=input.projectId&&data.projects.find(p=>p.id===input.projectId);
 if(!project&&input.projectName){project=data.projects.find(p=>p.name===String(input.projectName).trim());if(!project){project={id:id(),name:String(input.projectName).trim().slice(0,80),executionDeviceId:deviceId,createdAt:now()};data.projects.push(project);await persist();}}
 if(!project)throw new Error('Выбери проект для переноса.');
 if(deletingProjects.has(project.id))throw fail(409,'В проекте удаляется сессия. Повтори через несколько секунд.');
 if(importLocks.has(project.id))throw new Error('Другой перенос в этот проект ещё выполняется.');
 const key=[deviceId,provider,...(profile?[profile]:[]),input.sessionId].join(':');let chat=data.conversations.find(c=>c.projectId===project.id&&c.importSource?.key===key);
 if(chat?.archivedAt)throw fail(409,'Эта сессия уже есть в архиве проекта. Восстанови её вместо повторного импорта.');
 importLocks.add(project.id);const importedChatId=chat?.id;if(importedChatId)importingChats.add(importedChatId);
 try{const source=loadedSource||await nativeRead(deviceId,provider,input.sessionId,['none','referenced','all'].includes(input.files)?input.files:'referenced',profile);
  return await projectFiles.run(project.id,async()=>{if(chat&&chatLocks.has(chat.id))throw new Error('Этот чат сейчас работает. Дождись ответа перед обновлением его импорта.');
  if(source.messages.length>50000)throw new Error('Слишком много сообщений для одного переноса.');
  if(!chat){chat={id:id(),projectId:project.id,title:source.title,owner:user.name,ownerId:user.id,provider,messages:[],createdAt:now(),updatedAt:now()};data.conversations.unshift(chat)}
  const previousHashes=chat.importSource?.fileHashes||{};const dir=workspace(project),conflicts=[],mapping={},fileHashes={...previousHashes};
  for(const f of source.files||[]){let relative=portablePath(f.path),bytes=Buffer.from(f.content||'','base64');if(bytes.length>MAX_FILE||digest(bytes)!==f.hash)throw new Error('Повреждённый файл переноса.');const full=await filePath(dir,relative,{mkdir:true});let current;try{current=digest(await fs.readFile(full))}catch(e){if(e.code!=='ENOENT')throw e}
   if(current&&current!==f.hash&&current!==previousHashes[relative]){conflicts.push(relative);relative=portablePath(`_imports/${source.sessionId}/${relative}`)}await atomicProjectWrite(dir,relative,bytes);fileHashes[relative]=f.hash;mapping[f.path]=relative;
  }
  const existingMessages=new Map(chat.messages.map(m=>[m.id,m]));const nativeIds=new Set();for(const incoming of source.messages){nativeIds.add(incoming.id);const item={...incoming,owner:incoming.role==='user'?user.name:undefined,attachments:(incoming.attachments||[]).map(a=>({...a,path:mapping[a.path]||a.path})),sourceSessionId:source.sessionId};const found=existingMessages.get(item.id);if(found)Object.assign(found,item);else{chat.messages.push(item);existingMessages.set(item.id,item)}}
  // Native import is a snapshot. Once work continues here, automatic source refresh stops.
  chat.importSource={key,provider,accountId:profile,sessionId:source.sessionId,deviceId,cwd:source.cwd,fingerprint:source.sourceFingerprint,fileFingerprint:source.fileFingerprint,updatedAt:source.updatedAt,importedAt:now(),watch:input.watch!==false,files:input.files||'referenced',fileHashes,active:source.active,warnings:source.warnings||[],conflicts,mapping};
  initializeTitle(chat);chat.route||={provider,deviceId,accountId:profile,model:'',effort:''};chat.executionDeviceId||=chat.pendingRoute?.deviceId||chat.route.deviceId;chat.updatedAt=now();chat.files=await snapshot(dir);checkpoint(chat,chat.files,'import');
  const archivePath=`imports/${provider}/${source.sessionId}/conversation.json`;await fs.writeFile(await filePath(dir,archivePath,{mkdir:true}),JSON.stringify({source:{provider,sessionId:source.sessionId,cwd:source.cwd,warnings:source.warnings},messages:source.messages}));
  await fs.writeFile(await filePath(dir,`imports/${provider}/${source.sessionId}/path-map.json`,{mkdir:true}),JSON.stringify({originalRoot:source.cwd,managedRoot:dir,files:mapping,missingFiles:source.warnings},null,2));
  await persist();changed(chat);titleQueue.enqueue(chat);
  return {chatId:chat.id,projectId:project.id,messageCount:source.messages.length,fileCount:(source.files||[]).length,warnings:source.warnings,conflicts,url:`/?project=${project.id}&chat=${chat.id}&device=${chatExecutionDevice(chat)||deviceId}`};
 });}finally{importLocks.delete(project.id);if(importedChatId)importingChats.delete(importedChatId)}
}
let importRefreshBusy=false;
const sourceRefresh=setInterval(async()=>{if(importRefreshBusy||updateMaintenance||shuttingDown)return;importRefreshBusy=true;try{for(const chat of data.conversations.filter(c=>!c.archivedAt&&c.importSource?.watch)){const src=chat.importSource;if(chatLocks.has(chat.id)||!devices().some(d=>d.id===src.deviceId&&d.online))continue;try{const current=await nativeRead(src.deviceId,src.provider,src.sessionId,src.files,src.accountId);if(chat.archivedAt||!chat.importSource?.watch)continue;if(current.sourceFingerprint===src.fingerprint&&current.fileFingerprint===src.fileFingerprint){if(src.active!==current.active||src.lastError){src.active=current.active;src.lastError=null;await persist();changed(chat);}continue;}await importSession({provider:src.provider,deviceId:src.deviceId,accountId:src.accountId,sessionId:src.sessionId,projectId:chat.projectId,files:src.files,watch:true},data.users.find(u=>u.name===chat.owner)||data.users[0],null,current);}catch(e){if(src.lastError!==e.message){src.lastError=e.message;await persist();changed(chat);}}}}finally{importRefreshBusy=false}},60000);sourceRefresh.unref();
function authCookie(result){return secureCookie('trc_challenge',result.nonce,300,secureSite);}
function closeBrowserSessions(tokenHashToClose){for(const ws of events)if(!tokenHashToClose||ws.sessionHash===tokenHashToClose)ws.close(4001,'Вход завершён');}
function validBrowserSession(ws){return data.authSessions.some(s=>s.tokenHash===ws.sessionHash&&s.expiresAt>Date.now());}
const server=http.createServer(async(req,res)=>{
 const writing=!['GET','HEAD','OPTIONS'].includes(req.method);if(writing){writeRequests++;let finished=false;const finish=()=>{if(!finished){finished=true;writeRequests--;}};res.once('finish',finish);res.once('close',finish);}
 try{
   const url=new URL(req.url,'http://localhost');
   securityHeaders(res,secureSite,{microphone:['/','/room','/room/','/index.html','/room/pane'].includes(url.pathname)});
   if(url.pathname==='/room/pane'&&!currentUser(req))return send(res,401,{error:'Войди в Team Room в основном окне.'});
   if(req.url.length>4096)throw fail(414,'Слишком длинный адрес.');
   if(url.pathname.startsWith('/desktop/releases/'))return await serveMacRelease(req,res,url.pathname,path.join(storage,'mac-releases'));
   if(url.pathname.startsWith('/open/'))return await fileOpenLinks.serve(req,res,url.pathname.slice(6));
   if(req.method==='GET'&&['/','/room'].includes(url.pathname)){res.writeHead(302,{'location':'/room/'+url.search,'cache-control':'no-store'});return res.end();}
   if(req.method==='POST'&&url.pathname==='/telegram/webhook'){if(!telegramAuth.validWebhook(req.headers['x-telegram-bot-api-secret-token']))throw fail(403,'Недопустимый запрос.');await telegramAuth.receiveTelegram(await jsonBody(req));return send(res,200,{ok:true});}
   if(req.method==='GET'&&url.pathname==='/health')return send(res,200,{ok:true,version:appVersion});
   if(req.method==='GET'&&url.pathname==='/favicon.ico')return res.writeHead(204).end();
   if(url.pathname.startsWith('/api/')){
     if(writing&&updateMaintenance)throw fail(503,'Устанавливаю обновление. Дождись перезапуска сервера; история и файлы сохранены.');
     if(!sameOrigin(req,canonicalOrigin))throw fail(403,'Запрос пришёл с другого сайта.');
     if(req.method==='GET'&&url.pathname==='/api/bootstrap')return send(res,200,{setupRequired:!data.users.length,setupTokenRequired:!data.users.length,...telegramAuth.status()});
     if(req.method==='POST'&&['/api/setup','/api/join','/api/login'].includes(url.pathname)){
       const key=clientAddress(req);securityLimits.take('auth:'+key,15,60000);securityLimits.take('auth-all',300,60000);
       const input=await jsonBody(req);if(url.pathname==='/api/setup'){const expected=process.env.TEAM_ROOM_SETUP_TOKEN||'',supplied=String(input.setupToken||'');if(expected.length<24)throw fail(503,'Владелец сервера должен задать TEAM_ROOM_SETUP_TOKEN длиной от 24 символов.');if(!crypto.timingSafeEqual(crypto.createHash('sha256').update(supplied).digest(),crypto.createHash('sha256').update(expected).digest()))throw fail(403,'Неверный код первоначальной настройки.');}const name=String(input.name||'').trim().slice(0,50),password=String(input.password||'');let user,invite;
       if(!name)throw fail(400,'Укажи имя аккаунта.');if(password.length>1024)throw fail(400,'Слишком длинный пароль.');
       if(telegramAuth.status().telegramEnabled){
        let pendingUser;
        if(url.pathname==='/api/login')user=findAccount(name);
        else {if(url.pathname==='/api/setup')throw fail(409,'Пространство уже настроено.');if(!name||Boolean(findAccount(name)))throw fail(400,'Выбери другое имя аккаунта.');if(!await validInvite(String(input.invite||'').trim().toUpperCase()))throw fail(403,'Код приглашения не подошёл.');pendingUser={id:id(),name,joinedAt:now()};}
        const result=await telegramAuth.request({name,userId:user?.id,pendingUser,config:telegramAuth.deliveryConfig(user?.id,user?.name||name),binding:key});return send(res,202,{telegramRequired:true,challengeId:result.id,expiresAt:result.expiresAt,botUsername:telegramAuth.status().botUsername},{'set-cookie':authCookie(result)});
       }
       if(url.pathname==='/api/login'){user=findAccount(name);if(!user||!await matches(password,user.password))return send(res,401,{error:'Имя или пароль неверны.'})}
       else{
         if(!name||password.length<10)return send(res,400,{error:'Укажи имя и пароль от 10 символов.'});
         if(Boolean(findAccount(name)))return send(res,409,{error:'Это имя уже занято. Выбери другое.'});
         if(url.pathname==='/api/setup'&&data.users.length)return send(res,409,{error:'Пространство уже создано. Войди в него.'});
         if(url.pathname==='/api/join'&&!await validInvite(String(input.invite||'').trim().toUpperCase()))return send(res,403,{error:'Код приглашения не подошёл.'});
         const passwordHash=await hash(password);if(Boolean(findAccount(name))||(url.pathname==='/api/setup'&&data.users.length))throw fail(409,'Аккаунт уже создан. Войди или выбери другое имя.');user={id:id(),name,password:passwordHash,joinedAt:now()};data.users.push(user);
         if(url.pathname==='/api/setup'){invite=crypto.randomBytes(6).toString('hex').toUpperCase();data.inviteHash=await hash(invite);data.inviteExpiresAt=Date.now()+7*86400000}
       }
       const cookie=await issueSession(user);await ensureLocalClient();changed();return send(res,200,{...safeState(user),...(invite?{inviteCode:invite}:{})},{'set-cookie':cookie});
     }
     if(req.method==='POST'&&url.pathname==='/api/auth/verify'){
       // Railway requests can share a proxy address. Keep the long limit per
       // browser challenge; retain a short network limit against request floods.
       securityLimits.take('verify-network:'+clientAddress(req),120,60000);
       const challengeCookie=cookieValue(req,'trc_challenge');
       securityLimits.take('verify-browser:'+tokenHash(challengeCookie||'anonymous:'+clientAddress(req)),20,900000);
       const input=await jsonBody(req);
       const record=telegramAuth.consume(input.challengeId,input.code,cookieValue(req,'trc_challenge'),'login');
       let user=data.users.find(u=>u.id===record.userId);
       if(record.pendingUser){if(Boolean(findAccount(record.pendingUser.name)))throw fail(409,'Это имя уже занято.');user=record.pendingUser;data.users.push(user);}
       if(!user)throw fail(401,'Вход не подтверждён.');await telegramAuth.bindAccount(user);const cookie=await issueSession(user);await ensureLocalClient();
       return send(res,200,safeState(user),{'set-cookie':[cookie,secureCookie('trc_challenge','',0,secureSite)]});
     }
     const user=currentUser(req)||importUser(req,url);if(!user)return send(res,401,{error:'Войди в Team Room.'});
     if(req.method==='GET'&&url.pathname==='/api/updates'){await hubUpdates.refreshResult();if(url.searchParams.get('check')==='1'){requireOwner(user);securityLimits.take('release-check:'+user.id,10,3600000);await hubUpdates.check({force:true});}return send(res,200,hubUpdates.status());}
     if(req.method==='PATCH'&&url.pathname==='/api/updates'){requireOwner(user);return send(res,200,await hubUpdates.settings((await jsonBody(req)).enabled));}
     if(req.method==='POST'&&url.pathname==='/api/updates/prepare'){requireOwner(user);securityLimits.take('release-prepare:'+user.id,5,3600000);return send(res,200,await hubUpdates.prepare((await jsonBody(req)).version));}
     if(req.method==='POST'&&url.pathname==='/api/updates/apply'){requireOwner(user);const id=hubUpdates.apply((await jsonBody(req)).version);updateMaintenance=true;send(res,202,{restarting:true});setTimeout(()=>process.send?.({type:'community-update-apply',id}),150);return;}
     if(req.method==='POST'&&url.pathname==='/api/logout'){const digest=tokenHash(cookieValue(req,'trc_session'));data.authSessions=data.authSessions.filter(s=>s.tokenHash!==digest);fileOpenLinks.revoke(user.id);await notifications.revokeSession(digest);closeBrowserSessions(digest);await persist();return send(res,200,{ok:true},{'set-cookie':[secureCookie('trc_session','',0,secureSite),secureCookie('trc_challenge','',0,secureSite)]})}
     const sessionHash=tokenHash(cookieValue(req,'trc_session')||'');
     if(url.pathname.startsWith('/api/notifications')||url.pathname.startsWith('/api/voice/')){if(!currentUser(req))throw fail(403,'Для этого действия войди в Team Room в браузере.');}
     if(req.method==='GET'&&url.pathname==='/api/notifications')return send(res,200,notifications.config(user.id,sessionHash));
     if(req.method==='POST'&&url.pathname==='/api/notifications/subscribe'){securityLimits.take('push-subscribe:'+user.id,20,60000);return send(res,201,await notifications.subscribe(user.id,sessionHash,await jsonBody(req)));}
     if(req.method==='POST'&&url.pathname==='/api/notifications/unsubscribe'){const input=await jsonBody(req);return send(res,200,await notifications.unsubscribe(user.id,String(input.id||'')));}
     if(req.method==='POST'&&url.pathname==='/api/notifications/demo'){securityLimits.take('push-demo:'+user.id,2,60000);const input=await jsonBody(req);const chat=data.conversations.find(c=>c.id===input.chatId);if(!chat)throw fail(404,'Выбери существующий чат для проверки уведомления.');await notifications.enqueue({id:'demo:'+id(),kind:'completed',chatId:chat.id,projectId:chat.projectId,messageId:chat.messages.at(-1)?.id,title:'Проверка уведомлений',provider:chat.provider,userIds:[user.id],at:now(),demoUser:user.id});return send(res,202,{ok:true});}
     if(req.method==='GET'&&url.pathname==='/api/voice/status'){const device=url.searchParams.get('device')||localId;if(device===localId&&localVoice)return send(res,200,{...await localVoice.info(),error:localVoice.error||null});if(bridges.get(device)?.readyState!==1)throw fail(409,'Выбранный компьютер отключён. Выбери компьютер в сети.');if(!bridges.get(device)?.voiceVersion)throw fail(426,'Обнови Team Room Community Connect на выбранном компьютере для голосового режима.');return send(res,200,await requestDevice(device,'voice-status',{},15000));}
     if(req.method==='POST'&&url.pathname==='/api/voice/prepare'){securityLimits.take('voice-prepare:'+user.id,3,3600000);const input=await jsonBody(req);if(input.deviceId===localId&&localVoice)return send(res,202,await localVoice.prepare());if(bridges.get(input.deviceId)?.readyState!==1)throw fail(409,'Выбранный компьютер отключён. Выбери компьютер в сети.');if(!bridges.get(input.deviceId)?.voiceVersion)throw fail(426,'Обнови Team Room Community Connect на выбранном компьютере для голосового режима.');return send(res,202,await requestDevice(input.deviceId,'voice-prepare',{},15000));}
     if(req.method==='POST'&&url.pathname==='/api/voice/transcribe'){securityLimits.take('voice:'+user.id,15,60000);const device=url.searchParams.get('device'),language=url.searchParams.get('language');if(!['ru','uk'].includes(language))throw fail(400,'Выбери язык записи.');if(!/^audio\/(mp4|webm|ogg|wav)(?:;.*)?$/i.test(req.headers['content-type']||''))throw fail(400,'Неподдерживаемый формат записи.');if(device!==localId&&bridges.get(device)?.readyState!==1)throw fail(409,'Выбранный компьютер отключён. Выбери компьютер в сети.');if(device!==localId&&!bridges.get(device)?.voiceVersion)throw fail(426,'Обнови Team Room Community Connect на выбранном компьютере для голосового режима.');if(device===localId&&!localVoice)throw fail(400,'Выбери активный компьютер.');if(voiceRequests.has(device))throw fail(409,'Компьютер уже распознаёт другую запись. Повтори через несколько секунд.');voiceRequests.add(device);let body;try{body=await readBody(req,6*1024*1024);if(body.length<100)throw fail(400,'Запись пустая.');const input={audio:body.toString('base64'),language};const result=device===localId?await localVoice.transcribe(input):await requestDevice(device,'voice-transcribe',input,190000);return send(res,200,result);}finally{body?.fill(0);voiceRequests.delete(device);}}
     if(req.method==='POST'&&url.pathname==='/api/security/telegram/prepare'){
       requireOwner(user);securityLimits.take('enroll:'+user.id,3,3600000);
       if(telegramAuth.status().telegramEnabled)throw fail(409,'Telegram уже подключён. Смена получателя требует отдельного подтверждения.');
       const input=await jsonBody(req);if(typeof input.password!=='string'||input.password.length>1024||!await matches(input.password,user.password))throw fail(401,'Введи текущий пароль владельца.');
       const config=await telegramAuth.botConfig(String(input.token||'').trim(),String(input.chatId||'').trim());
       const result=await telegramAuth.request({name:user.name,userId:user.id,config,purpose:'enroll',binding:user.id});
       return send(res,202,{challengeId:result.id,expiresAt:result.expiresAt,botUsername:config.username},{'set-cookie':authCookie(result)});
     }
     if(req.method==='POST'&&url.pathname==='/api/security/telegram/confirm'){
       requireOwner(user);securityLimits.take('enroll-verify:'+user.id,20,900000);const input=await jsonBody(req);
       if(telegramAuth.status().telegramEnabled)throw fail(409,'Telegram уже подключён.');const record=telegramAuth.consume(input.challengeId,input.code,cookieValue(req,'trc_challenge'),'enroll');
       if(record.userId!==user.id)throw fail(403,'Подтверждение относится к другому аккаунту.');await telegramAuth.save(record.config);void setupTelegramWebhook();data.telegramRequired=true;await persist();
       return send(res,200,telegramAuth.status(),{'set-cookie':secureCookie('trc_challenge','',0,secureSite)});
     }
     if(req.method==='GET'&&url.pathname==='/api/security/telegram/recipients'){requireOwner(user);return send(res,200,telegramAuth.recipients());}
     if(req.method==='POST'&&url.pathname==='/api/security/telegram/recipients/prepare'){
       requireOwner(user);securityLimits.take('recipient-admin:'+user.id,10,3600000);const action=telegramAuth.recipientAction(await jsonBody(req),data.users);
       if(action.operation==='invite'&&!telegramAuth.webhookReady)await telegramAuth.ensureWebhook(canonicalOrigin);
       const result=await telegramAuth.request({name:user.name,userId:user.id,config:telegramAuth.deliveryConfig(user.id,user.name),purpose:'recipients',binding:user.id,action});return send(res,202,{challengeId:result.id,expiresAt:result.expiresAt,botUsername:telegramAuth.status().botUsername},{'set-cookie':authCookie(result)});
     }
     if(req.method==='POST'&&url.pathname==='/api/security/telegram/recipients/confirm'){
       requireOwner(user);securityLimits.take('recipient-admin-verify:'+user.id,20,900000);const input=await jsonBody(req),record=telegramAuth.consume(input.challengeId,input.code,cookieValue(req,'trc_challenge'),'recipients');
       if(record.userId!==user.id||!record.action)throw fail(403,'Изменение не подтверждено.');const result=await telegramAuth.applyRecipientAction(record.action);
       const removedUser=result.removed?.state==='active'&&findAccount(result.removed.accountName);
       if(removedUser&&!isOwner(removedUser)){const revoked=data.authSessions.filter(s=>s.userId===removedUser.id).map(s=>s.tokenHash);data.authSessions=data.authSessions.filter(s=>s.userId!==removedUser.id);for(const digest of revoked){await notifications.revokeSession(digest);closeBrowserSessions(digest);}fileOpenLinks.revoke(removedUser.id);await persist();}

       return send(res,200,result.info,{'set-cookie':secureCookie('trc_challenge','',0,secureSite)});
     }
     if(req.method==='POST'&&url.pathname==='/api/security/revoke-sessions'){requireOwner(user);const current=tokenHash(cookieValue(req,'trc_session'));data.authSessions=data.authSessions.filter(s=>s.tokenHash===current);for(const ws of events)if(ws.sessionHash!==current)ws.close(4001,'Вход завершён');await persist();return send(res,200,{ok:true});}

     if(req.method==='GET'&&url.pathname==='/api/import-projects')return send(res,200,{projects:data.projects});
     if(req.method==='GET'&&url.pathname==='/api/native-sessions'){const deviceId=importDevice(req)||url.searchParams.get('device')||'local';const provider=url.searchParams.get('provider');if(!['claude','codex'].includes(provider))return send(res,400,{error:'Выбери провайдер.'});const cursor=url.searchParams.get('cursor'),profile=selectedAccount(deviceId,provider,url.searchParams.get('account')||'');return send(res,200,deviceId==='local'?await accounts.native(provider,profile).list(provider,cursor):await requestDevice(deviceId,'native-list',{provider,cursor,accountId:profile}));}
     if(req.method==='GET'&&url.pathname==='/api/native-session-preview'){
       securityLimits.take('native-preview:'+user.id,20,60000);const deviceId=url.searchParams.get('device')||'local',provider=url.searchParams.get('provider'),sessionId=url.searchParams.get('session');
       if(!['claude','codex'].includes(provider)||typeof sessionId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(sessionId))throw fail(400,'Выбери сохранённую сессию.');if(!devices().some(d=>d.id===deviceId&&d.online))throw fail(409,'Компьютер с исходной сессией отключён.');
       return send(res,200,await nativeSessionPreview(deviceId,provider,sessionId,selectedAccount(deviceId,provider,url.searchParams.get('account')||'')));
     }
     if(req.method==='POST'&&url.pathname==='/api/import-session')return send(res,201,await importSession(await jsonBody(req),user,importDevice(req)));
     if(req.method==='PATCH'&&url.pathname==='/api/settings'){const input=await jsonBody(req);for(const key of ['autoMemory','autoSwitch'])if(typeof input[key]==='boolean')data.settings[key]=input[key];await persist();changed();return send(res,200,data.settings);}
     const skillBlob=url.pathname.match(/^\/api\/skills\/blobs\/([a-f0-9]{64})$/);if(req.method==='GET'&&skillBlob){const digest=skillBlob[1];if(!Object.values(skillStore.data.skills).some(s=>!s.deleted&&s.files.some(f=>f.hash===digest)))throw fail(404,'Файл скилла не найден.');const bytes=await skillStore.blob(digest);res.writeHead(200,{'content-type':'application/octet-stream','content-length':bytes.length,'cache-control':'no-store'});return res.end(bytes);}
     if(req.method==='POST'&&url.pathname==='/api/skills/import'){requireOwner(user);securityLimits.take('skills-import:'+user.id,10,3600000);let input;try{input=JSON.parse((await readBody(req,35*1024*1024)).toString());}catch(e){if(e.status)throw e;throw fail(400,'Некорректный комплект скилла.');}if(!input||!Array.isArray(input.files)||input.files.length>1500)throw fail(400,'Некорректная папка скилла.');const contents=new Map();let bytes=0;const descriptors=input.files.map(f=>{const relative=skillPath(f.path);if(typeof f.content!=='string'||f.content.length>23*1024*1024)throw fail(400,'Некорректный файл скилла.');const content=Buffer.from(f.content,'base64');bytes+=content.length;if(bytes>24*1024*1024||contents.has(relative))throw fail(400,'Скилл слишком большой или содержит повторяющиеся файлы.');contents.set(relative,content);return {path:relative,size:content.length,hash:digest(content),text:/\.(md|txt|json|yaml|yml|toml|py|js|mjs|ts|sh|bash|ps1|css|html|xml|svg|csv)$/i.test(relative),executable:/\.(sh|bash|py|js|mjs|ps1)$/i.test(relative)};});const readme=contents.get('SKILL.md')?.toString();if(!readme)throw fail(400,'Выбери папку с файлом SKILL.md.');const meta=skillMetadata(readme,input.name||'skill'),name=meta.name;const id=skillId(String(name).toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+/,'').slice(0,55)||'skill-'+digest(Buffer.from(name)).slice(0,12));const description=meta.description;await skillStore.put({id,name,description,files:descriptors},contents);pushSkills();changed();return send(res,201,skillStore.public());}
     const skillReadme=url.pathname.match(/^\/api\/skills\/([a-z0-9_-]+)\/readme$/);if(req.method==='GET'&&skillReadme){const row=skillStore.data.skills[skillId(skillReadme[1])];if(!row||row.deleted)throw fail(404,'Скилл не найден.');const file=row.files.find(f=>f.path==='SKILL.md');return send(res,200,{name:row.name,text:(await skillStore.blob(file.hash)).toString()});}
     if(req.method==='GET'&&url.pathname==='/api/skills')return send(res,200,{...skillStore.public(),devices:devices()});
     if(req.method==='POST'&&url.pathname==='/api/skills/scan'){requireOwner(user);securityLimits.take('skills-scan:'+user.id,5,60000);const input=await jsonBody(req);if(input.deviceId==='local'&&!hubOnly)await scanLocalSkills();else await requestDevice(input.deviceId,'skills-scan',{},90000);return send(res,200,{ok:true});}
     if(req.method==='PATCH'&&url.pathname==='/api/skills'){requireOwner(user);const input=await jsonBody(req);if(typeof input.auto!=='boolean')throw fail(400,'Укажи режим переноса скиллов.');await skillStore.automatic(input.auto);pushSkills();changed();return send(res,200,skillStore.public());}
     const skillMatch=url.pathname.match(/^\/api\/skills\/([a-z0-9_-]+)$/);if(skillMatch&&['PATCH','DELETE'].includes(req.method)){requireOwner(user);const id=skillId(skillMatch[1]);if(req.method==='DELETE')await skillStore.remove(id);else{const input=await jsonBody(req);if(typeof input.enabled!=='boolean')throw fail(400,'Укажи состояние скилла.');await skillStore.enabled(id,input.enabled);}pushSkills();changed();return send(res,200,skillStore.public());}
     if(req.method==='GET'&&url.pathname==='/api/mcp')return send(res,200,{...mcpVault.public(),devices:devices()});
     if(url.pathname==='/api/mcp/scan'&&req.method==='POST'){requireOwner(user);securityLimits.take('mcp-scan:'+user.id,10,60000);const input=await jsonBody(req);if(input.deviceId==='local'&&!hubOnly)await scanLocalMcp();else await requestDevice(input.deviceId,'mcp-scan',{},30000);return send(res,200,{ok:true});}
     if(url.pathname==='/api/mcp'&&req.method==='PATCH'){requireOwner(user);const input=await jsonBody(req);if(typeof input.auto!=='boolean')throw fail(400,'Укажи режим переноса MCP.');await mcpVault.automatic(input.auto);pushMcp();changed();return send(res,200,mcpVault.public());}
     if(url.pathname==='/api/mcp'&&req.method==='POST'){requireOwner(user);securityLimits.take('mcp-write:'+user.id,30,60000);const input=await jsonBody(req);await mcpVault.put(input.name,input.config,{sourceProvider:'teamroom',label:String(input.label||input.name).slice(0,150)});pushMcp();changed();return send(res,201,mcpVault.public());}
     const mcpMatch=url.pathname.match(/^\/api\/mcp\/([a-zA-Z0-9_-]+)$/);if(mcpMatch&&['PATCH','DELETE'].includes(req.method)){requireOwner(user);const name=mcpName(mcpMatch[1]);if(req.method==='DELETE')await mcpVault.remove(name);else{const input=await jsonBody(req);if(typeof input.enabled!=='boolean')throw fail(400,'Укажи состояние MCP.');await mcpVault.enable(name,input.enabled);}pushMcp();changed();return send(res,200,mcpVault.public());}
     if(req.method==='GET'&&url.pathname==='/api/state')return send(res,200,safeState(user));
     if(url.pathname==='/api/board'||url.pathname.startsWith('/api/board/')){
      if(!currentUser(req))throw fail(403,'Для личной доски войди в Team Room.');
      if(!sessionBoardStore)throw fail(503,'Личная доска временно недоступна. Остальные чаты продолжают работать.');
      if(req.method==='GET'&&url.pathname==='/api/board'){
       securityLimits.take('board-read:'+user.id,90,60000);
       return send(res,200,boardList(data,user,sessionBoardStore,{scope:url.searchParams.get('scope')||'active',cursor:url.searchParams.get('cursor'),limit:url.searchParams.get('limit'),devices:devices(),isArchiveBlocked:chat=>{try{assertChatDeletable(chat);return false;}catch{return true;}}}));
      }
      if(req.method==='PATCH'&&url.pathname==='/api/board/settings'){
       securityLimits.take('board-write:'+user.id,60,60000);const value=await sessionBoardStore.settings(user.id,await jsonBody(req));boardChanged(user.id);return send(res,200,{settings:value.settings});
      }
      const match=url.pathname.match(/^\/api\/board\/chats\/([a-zA-Z0-9_-]{1,160})$/);
      if(req.method==='PATCH'&&match){
       securityLimits.take('board-write:'+user.id,60,60000);
       const chat=data.conversations.find(c=>c.id===match[1]);if(!chat||!ownsBoardChat(chat,user))throw fail(404,'Сессия не найдена на твоей доске.');
       if(deletingChats.has(chat.id)||projectDeleting.has(chat.projectId))throw fail(409,'Сессия сейчас меняется. Повтори через несколько секунд.');
       await sessionBoardStore.patch(user,chat,await jsonBody(req));boardChanged(user.id);return send(res,200,{ok:true});
      }
      throw fail(404,'Действие доски не найдено.');
     }
     if(req.method==='GET'&&url.pathname==='/api/search'){
      securityLimits.take('chat-search:'+user.id,60,60000);
      const projectId=url.searchParams.get('projectId')||undefined,chatId=url.searchParams.get('chatId')||undefined;
      if(projectId)projectById(projectId);if(chatId){const scoped=data.conversations.find(c=>c.id===chatId);if(!scoped)throw fail(404,'Чат не найден.');if(projectId&&scoped.projectId!==projectId)throw fail(400,'Чат находится в другом проекте.');}
      return send(res,200,await searchChats(data.conversations,data.projects,{q:url.searchParams.get('q'),projectId,chatId,includeArchived:url.searchParams.get('includeArchived')==='1',limit:url.searchParams.get('limit'),cursor:url.searchParams.get('cursor')}));
     }
     if(req.method==='GET'&&url.pathname==='/api/devices')return send(res,200,{devices:devices(),addresses:Object.values(os.networkInterfaces()).flat().filter(a=>a?.family==='IPv4'&&!a.internal).map(a=>`http://${a.address}:${port}`),localOnly:host==='127.0.0.1'});
     if(req.method==='GET'&&url.pathname==='/api/catalog'){const provider=url.searchParams.get('provider');if(!['claude','codex'].includes(provider))return send(res,400,{error:'Неизвестный провайдер'});return send(res,200,await catalog(url.searchParams.get('device')||localId,provider,url.searchParams.get('refresh')==='1',url.searchParams.get('account')||''))}
     if(['GET','POST'].includes(req.method)&&url.pathname==='/api/provider-accounts'){
       const input=req.method==='POST'?await jsonBody(req):{},device=input.deviceId||url.searchParams.get('device')||localId;
       if(!devices().some(d=>d.id===device&&d.online))throw fail(503,'Выбери подключённый компьютер.');
       if(req.method==='POST'){securityLimits.take('account-create:'+user.id,10,60000);if(!['claude','codex'].includes(input.provider))throw fail(400,'Выбери провайдера.');}
       let result;if(device===localId){const record=req.method==='POST'?await accounts.create(input.provider,input.name):null;result={accounts:accounts.list(),accountsError:accounts.error||null,record};}
       else{const ws=bridges.get(device);if(ws?.accountsVersion!==1)throw fail(426,'Обнови Team Room на выбранном Mac, затем «Этот Mac → Обновить подключение».');result=await requestDevice(device,'accounts',{action:req.method==='POST'?'create':'list',provider:input.provider,name:input.name});ws.accounts=result.accounts;ws.accountsError=result.accountsError||null;}
       changed();return send(res,req.method==='POST'?201:200,result);
     }
     if(req.method==='POST'&&url.pathname==='/api/login-provider'){
       const input=await jsonBody(req);if(!['claude','codex'].includes(input.provider))throw fail(400,'Неизвестный провайдер');const device=input.deviceId||localId,profile=selectedAccount(device,input.provider,input.accountId);
       securityLimits.take('account-login:'+user.id,10,60000);
       if([...active.values()].some(r=>r.deviceId===device&&data.conversations.find(c=>c.id===r.chatId)?.run?.provider===input.provider&&(data.conversations.find(c=>c.id===r.chatId)?.route?.accountId||'')===profile))throw fail(409,'Этот аккаунт выполняет задачу. Дождись завершения перед входом.');
       if(device!==localId){const ws=bridges.get(device);await requestDevice(device,'login',{provider:input.provider,accountId:profile});if(ws&&bridges.get(device)===ws)ws.loginBusy=true;return send(res,200,{ok:true});}
       const result=accounts.startLogin(input.provider,profile,event=>{broadcast({...event,deviceId:device});if(event.type==='login-complete'){invalidateCatalog(device,input.provider,{accountId:profile,dropCache:true,dropLimits:true,forgetAuth:true});changed();}});return send(res,200,result);
     }
     if(req.method==='POST'&&url.pathname==='/api/invite'){requireOwner(user);const invite=crypto.randomBytes(6).toString('hex').toUpperCase();data.inviteHash=await hash(invite);data.inviteExpiresAt=Date.now()+7*86400000;await persist();return send(res,200,{inviteCode:invite})}
     if(req.method==='POST'&&url.pathname==='/api/projects/reorder'){
      const input=await jsonBody(req),order=moveProject(data.projects,user.projectOrder,input.projectId,input.targetId,input.placement);
      if(!order)throw fail(409,'Проект или место переноса изменились. Обнови список и повтори.');
      const previous=user.projectOrder;user.projectOrder=order;
      try{await persist()}catch(error){user.projectOrder=previous;throw error;}
      changed();return send(res,200,{projects:orderedProjects(data.projects,order)});
     }
     if(req.method==='POST'&&url.pathname==='/api/projects'){const input=await jsonBody(req);const project={id:id(),name:String(input.name||'Новый проект').slice(0,80),description:String(input.description||'').slice(0,500),executionDeviceId:knownExecutionDevice(input.deviceId)||(!hubOnly?localId:null),createdAt:now()};data.projects.push(project);await persist();changed();return send(res,201,project)}
     const projectArchive=url.pathname.match(/^\/api\/projects\/([^/]+)\/archive$/);
     if(req.method==='POST'&&projectArchive){
      requireOwner(user);const project=projectById(projectArchive[1]),input=await jsonBody(req);
      if(typeof input.archived!=='boolean')throw fail(400,'Укажи архивирование или восстановление проекта.');
      if(projectDeleting.has(project.id)||deletingProjects.has(project.id))throw fail(409,'Проект сейчас меняется.');
      if(input.archived)assertProjectIdle(project);
      const previous=project.archivedAt;if(input.archived)project.archivedAt=now();else delete project.archivedAt;
      try{await persist()}catch(error){if(previous)project.archivedAt=previous;else delete project.archivedAt;throw error;}
      changed();return send(res,200,{ok:true,project});
     }
     const projectRename=url.pathname.match(/^\/api\/projects\/([^/]+)$/);
     if(req.method==='PATCH'&&projectRename){
      requireOwner(user);const input=await jsonBody(req),project=projectById(projectRename[1]);
      if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>80)throw fail(400,'Название проекта должно содержать от 1 до 80 символов.');
      if(projectDeleting.has(project.id)||deletingProjects.has(project.id))throw fail(409,'Проект сейчас меняется.');
      const previous=project.name;project.name=input.name.trim();
      try{await persist()}catch(error){if(project.name===input.name.trim())project.name=previous;throw error;}
      changed();return send(res,200,project);
     }
     const projectAction=url.pathname.match(/^\/api\/projects\/([^/]+)(?:\/(deletion-preview))?$/);
     if(projectAction&&((req.method==='GET'&&projectAction[2])||(req.method==='DELETE'&&!projectAction[2]))){
      requireOwner(user);const project=projectById(projectAction[1]);assertProjectIdle(project);
      if(req.method==='GET'){const preview=await projectFiles.run(project.id,()=>projectDeletionPreview(workspace(project),project,data.conversations,data.memories,data.tasks));assertProjectIdle(project);return send(res,200,preview);}
      const input=await jsonBody(req);if(!data.projects.includes(project))throw fail(404,'Проект уже удалён.');assertProjectIdle(project);
      if(input.confirmation!==project.id||input.name!==project.name)throw fail(400,'Для удаления введи точное название проекта.');
      if(deletingProjects.has(project.id))throw fail(409,'Проект сейчас меняется. Повтори через несколько секунд.');
      projectDeleting.add(project.id);deletingProjects.add(project.id);
      try{return await projectFiles.run(project.id,async()=>{
       assertProjectIdle(project);
       const preview=await projectDeletionPreview(workspace(project),project,data.conversations,data.memories,data.tasks);assertProjectIdle(project);
       if(input.previewToken!==preview.token)throw fail(409,'Проект изменился. Открой удаление ещё раз.');
       const chats=data.conversations.filter(c=>c.projectId===project.id),chatIds=new Set(chats.map(c=>c.id)),memories=data.memories.filter(m=>m.projectId===project.id),tasks=data.tasks.filter(t=>t.projectId===project.id),pending=Object.fromEntries(Object.entries(data.pendingRemote).filter(([,p])=>p.projectId===project.id)),index=data.projects.indexOf(project);
       for(const c of chats)deletingChats.add(c.id);
       const staged=await stageProjectRemoval(storage,workspace(project),project.id);
       data.projects.splice(index,1);data.conversations=data.conversations.filter(c=>!chatIds.has(c.id));data.memories=data.memories.filter(m=>m.projectId!==project.id);data.tasks=data.tasks.filter(t=>t.projectId!==project.id);
       for(const key of Object.keys(pending))delete data.pendingRemote[key];
       const replacement=!data.projects.length?{id:id(),name:'Мой проект',description:'',createdAt:now()}:null;if(replacement)data.projects.push(replacement);
       try{await persist()}catch(error){if(replacement)data.projects=data.projects.filter(p=>p!==replacement);data.projects.splice(index,0,project);data.conversations.push(...chats);data.memories.push(...memories);data.tasks.push(...tasks);Object.assign(data.pendingRemote,pending);await staged.rollback();throw error;}
       await staged.commit().catch(e=>console.error('Очистка удалённого проекта:',e.message));for(const c of chats)await fileReviews.remove(c.id).catch(()=>console.warn('Просмотр удалённого проекта будет очищен позже.'));
       for(const [runId,p]of Object.entries(pending))out(bridges.get(p.deviceId)||{readyState:0},{type:'abort',runId});
       changed();return send(res,200,{ok:true,projectId:project.id,replacementProjectId:replacement?.id||data.projects[0].id});
      });}finally{projectDeleting.delete(project.id);deletingProjects.delete(project.id);for(const c of data.conversations.filter(c=>c.projectId===project.id))deletingChats.delete(c.id);for(const key of [...deletingChats])if(!data.conversations.some(c=>c.id===key))deletingChats.delete(key);}
     }
     if(req.method==='POST'&&url.pathname==='/api/chats'){
      const started=Date.now();if(shuttingDown)throw fail(503,'Приложение перезапускается. Повтори создание чата через несколько секунд.');
      const input=await jsonBody(req),project=projectById(input.projectId),deviceId=knownExecutionDevice(input.deviceId)||knownExecutionDevice(project.executionDeviceId)||(!hubOnly?localId:null),provider=input.provider==='claude'?'claude':'codex';
      if(project.archivedAt)throw fail(409,'Проект в архиве. Сначала восстанови его.');
      if(projectDeleting.has(project.id)||deletingProjects.has(project.id))throw fail(409,'Проект сейчас меняется. Повтори создание чата.');
      const chat={id:id(),title:'Новый чат',titleSource:'auto',titleMeta:{version:0,status:'waiting',origin:'automatic'},projectId:project.id,executionDeviceId:deviceId,owner:user.name,ownerId:user.id,provider,messages:[],createdAt:now(),updatedAt:now()};
      if(deviceId)chat.route={provider,deviceId,accountId:executionAccount(deviceId,provider,input.accountId),permissionMode:permissionMode(input.permissionMode),executionMode:selectedExecutionMode(deviceId,input),model:String(input.model||'').slice(0,100),effort:String(input.effort||'').slice(0,20)};
      pendingChatCreates.set(project.id,(pendingChatCreates.get(project.id)||0)+1);
      try{
       const committed=await messageJournal.commit({type:'chat-create',chat},entry=>applyMessageOperation(entry));
       const saved=data.conversations.find(c=>c.id===chat.id);if(!saved)throw fail(409,'Проект изменился во время создания чата.');
       send(res,201,saved);console.log(JSON.stringify({event:'message-accepted',kind:'new-chat',elapsedMs:Date.now()-started,journalBytes:committed.bytes}));changed(saved);scheduleMessageSnapshot();return;
      }finally{const count=(pendingChatCreates.get(project.id)||1)-1;if(count)pendingChatCreates.set(project.id,count);else pendingChatCreates.delete(project.id);}
     }
     const agentMatch=url.pathname.match(/^\/api\/chats\/([^/]+)\/agents\/([^/]+)$/);
     if(agentMatch&&['GET','POST'].includes(req.method)){
      const chat=data.conversations.find(c=>c.id===agentMatch[1]);if(!chat)throw fail(404,'Чат не найден.');
      let agentId;try{agentId=decodeURIComponent(agentMatch[2]);}catch{throw fail(400,'Некорректный агент.');}if(!validAgentId(agentId))throw fail(400,'Некорректный агент.');
      if(req.method==='GET'){const messageId=url.searchParams.get('messageId'),message=messageId?chat.messages.find(m=>m.id===messageId):chat.messages.findLast(m=>m.agents?.some(a=>a.id===agentId));const agent=message?.agents?.find(a=>a.id===agentId);if(!agent)throw fail(404,'Агент не найден в этой сессии.');return send(res,200,{messageId:message.id,agent});}
      if(!isOwner(user)&&user.name!==chat.owner)throw fail(403,'Управлять агентами может автор чата или владелец пространства.');
      securityLimits.take('agent-control:'+user.id,30,60000);const input=await jsonBody(req),record=active.get(chat.id);
      if(!['stop','resume'].includes(input.action))throw fail(400,'Выбери остановку или продолжение.');
      if(!record||record.id!==input.runId||chat.run?.id!==input.runId||record.closing||record.controller.signal.aborted)throw fail(409,'Эта работа уже завершилась. Обнови панель агентов.');
      if(projectDeleting.has(chat.projectId)||deletingChats.has(chat.id))throw fail(409,'Сессия сейчас меняется.');
      const agent=record.message?.agents?.find(a=>a.id===agentId);if(!agent?.capabilities?.[input.action])throw fail(409,'Это действие сейчас недоступно для выбранного агента.');
      record.agentRequests||=new Set();if(record.agentRequests.has(agentId))throw fail(409,'Предыдущее действие ещё выполняется.');record.agentRequests.add(agentId);
      try{let result;if(record.deviceId===localId){if(!record.agentControl)throw fail(409,'Управление агентом ещё не готово.');result=await record.agentControl(agentId,input.action);}else{if(bridges.get(record.deviceId)?.agentMonitorVersion!==1)throw fail(426,'Обнови подключение на выбранном Mac для управления агентами.');result=await requestDevice(record.deviceId,'agent-control',{runId:record.id,chatId:chat.id,agentId,action:input.action},20000,record.controller.signal);}
       if(active.get(chat.id)!==record||record.closing)throw fail(409,'Работа завершилась во время выполнения действия.');return send(res,200,{ok:true,result});
      }finally{record.agentRequests.delete(agentId);}
     }
     const chatMatch=url.pathname.match(/^\/api\/chats\/([^/]+)(?:\/(send|stop|approval|export|switch|memory|detach-source|resume-queue|cancel-followup|retry-followup|edit-followup|reorder-followups|fork|review|deletion-preview|move-preview|move|archive|read))?$/);
     if(chatMatch){const chat=data.conversations.find(c=>c.id===chatMatch[1]);if(!chat)return send(res,404,{error:'Чат не найден.'});const action=chatMatch[2],originProjectId=chat.projectId;if(projectDeleting.has(chat.projectId))throw fail(409,'Проект удаляется. Подожди несколько секунд.');if(deletingChats.has(chat.id))throw fail(409,'Эта сессия удаляется. Подожди несколько секунд.');
       if(req.method==='POST'&&action==='read'){
        const input=await jsonBody(req),alreadyRead=chat.completionReads?.[user.id]===input.token;
        const read=readCompletion(chat,user.id,input.token);
        if(read&&!alreadyRead){await persist();changed();}
        return send(res,200,{read,...completionState(chat,user.id)});
       }
       if(req.method==='GET'&&action==='review'){const project=projectById(chat.projectId);return send(res,200,await projectFiles.run(project.id,()=>{if(!data.projects.includes(project)||!data.conversations.includes(chat)||chat.projectId!==project.id||projectDeleting.has(project.id)||deletingProjects.has(project.id)||deletingChats.has(chat.id))throw fail(409,'Сессия или проект сейчас меняется. Повтори через несколько секунд.');return fileReviews.view(workspace(project),chat.id,url.searchParams.get('path'));}));}
       if(req.method==='POST'&&action==='fork'){
        securityLimits.take('chat-fork:'+user.id,20,60000);const saved=await createFork(chat,await jsonBody(req),user);
        return send(res,201,{ok:true,chatId:saved.id,projectId:saved.projectId,chat:compactChat(saved,{limit:80})});
       }
       if(req.method==='POST'&&['edit-followup','reorder-followups'].includes(action)){
        securityLimits.take('queue-mutate:'+user.id,60,60000);const input=await jsonBody(req);
        if(chat.archivedAt||!data.conversations.includes(chat)||chat.projectId!==originProjectId||deletingChats.has(chat.id)||projectDeleting.has(chat.projectId))throw fail(409,'Сессия сейчас меняется.');
        const operation=prepareFollowupOperation(chat,input,{name:user.name,canEditAny:isOwner(user)},action==='edit-followup'?'edit':'reorder');let applied=false;
        queueMutations.set(chat.id,(queueMutations.get(chat.id)||0)+1);
        try{await messageJournal.commit(operation,entry=>{applied=applyMessageOperation(entry);});if(!applied)throw fail(409,'Дополнение уже передаётся или очередь изменилась. Обнови её.');
         changed(chat);scheduleMessageSnapshot();return send(res,200,{ok:true,messages:queuedFollowups(chat).map(m=>({...m,canEdit:isOwner(user)||m.owner===user.name})),queueOrder:queuedFollowups(chat).map(m=>m.id)});
        }finally{const count=(queueMutations.get(chat.id)||1)-1;if(count)queueMutations.set(chat.id,count);else{queueMutations.delete(chat.id);const record=active.get(chat.id);if(record)void pumpFollowups(chat,record)?.catch(console.error);else if(queueResumes.has(chat.id)){const resumeUser=queueResumes.get(chat.id);queueResumes.delete(chat.id);startQueuedFollowups(chat,resumeUser);}}}
       }
       if(req.method==='POST'&&action==='archive'){
        if(!isOwner(user)&&user.name!==chat.owner)throw fail(403,'Архивировать и восстановить сессию может её автор или владелец пространства.');
        const input=await jsonBody(req);if(typeof input.archived!=='boolean')throw fail(400,'Выбери архивирование или восстановление.');
        if(!data.conversations.includes(chat))throw fail(404,'Сессия уже удалена.');
        if(chat.projectId!==originProjectId||projectDeleting.has(chat.projectId)||deletingProjects.has(chat.projectId)||deletingChats.has(chat.id))throw fail(409,'Сессия сейчас меняется. Повтори через несколько секунд.');
        if(Boolean(chat.archivedAt)===input.archived)return send(res,200,{ok:true,chatId:chat.id,projectId:chat.projectId,archivedAt:chat.archivedAt||null});
        assertChatDeletable(chat);deletingChats.add(chat.id);const previous=chat.archivedAt;
        try{
         if(!input.archived&&sessionBoardStore&&ownsBoardChat(chat,user))await sessionBoardStore.patch(user,chat,{hidden:false});
         if(input.archived)chat.archivedAt=now();else delete chat.archivedAt;
         try{await persist()}catch(error){if(previous)chat.archivedAt=previous;else delete chat.archivedAt;throw error;}
         changed(chat);return send(res,200,{ok:true,chatId:chat.id,projectId:chat.projectId,archivedAt:chat.archivedAt||null});
        }finally{deletingChats.delete(chat.id)}
       }
       if(req.method==='POST'&&projectById(chat.projectId).archivedAt&&['send','switch','resume-queue','retry-followup','fork','memory','detach-source'].includes(action))throw fail(409,'Проект в архиве. Сначала восстанови его.');
       if(req.method==='POST'&&chat.archivedAt&&['send','switch','resume-queue','retry-followup','memory','detach-source'].includes(action))throw fail(409,'Сессия в архиве. Сначала восстанови её для продолжения.');
       if((req.method==='GET'&&action==='deletion-preview')||(req.method==='DELETE'&&!action)){
         if(!isOwner(user)&&user.name!==chat.owner)throw fail(403,'Удалить сессию может её автор или владелец пространства.');
         let related=data.conversations.filter(c=>c.projectId===chat.projectId);
         assertChatDeletable(chat);
         if(req.method==='GET'){const preview=await projectFiles.run(chat.projectId,()=>deletionPreview(workspace(projectById(chat.projectId)),chat,related,data.memories,{protectedPaths:deletionFileProtection(chat,related)}));if(!data.conversations.includes(chat))throw fail(404,'Сессия уже удалена.');assertChatDeletable(chat);delete preview.inventory;return send(res,200,preview);}
         const input=await jsonBody(req);if(!data.conversations.includes(chat))throw fail(404,'Сессия уже удалена.');related=data.conversations.filter(c=>c.projectId===chat.projectId);if(input.confirmation!==chat.id||input.revision!==(chat.revision||0))throw fail(409,'Сессия изменилась. Открой удаление ещё раз.');
         if(deletingProjects.has(chat.projectId))throw fail(409,'В проекте удаляется другая сессия. Повтори через несколько секунд.');assertChatDeletable(chat);
         deletingProjects.add(chat.projectId);deletingChats.add(chat.id);
         try{return await projectFiles.run(chat.projectId,async()=>{
          assertChatDeletable(chat);related=data.conversations.filter(c=>c.projectId===chat.projectId);
          const dir=workspace(projectById(chat.projectId)),preview=await deletionPreview(dir,chat,related,data.memories,{protectedPaths:deletionFileProtection(chat,related)});
          assertChatDeletable(chat);
          if(input.previewToken!==preview.token)throw fail(409,'Файлы или память изменились. Открой удаление ещё раз.');
          const sourceWatch=chat.importSource?.watch;if(chat.importSource)chat.importSource.watch=false;
          let staged;try{staged=await stageDeletion(dir,input.files===true?preview.files:[])}catch(e){if(chat.importSource)chat.importSource.watch=sourceWatch;throw e;}const removedMemories=data.memories.filter(m=>m.sourceChatId===chat.id),removedTasks=data.tasks.filter(t=>t.sourceChatId===chat.id);
          const resetId=id(),oldResets=new Map(related.map(c=>[c,c.providerSessionsResetPending])),oldPending=Object.fromEntries(Object.entries(data.pendingRemote).filter(([,p])=>p.chatId===chat.id)),index=data.conversations.indexOf(chat);
          data.conversations.splice(index,1);data.memories=data.memories.filter(m=>m.sourceChatId!==chat.id);data.tasks=data.tasks.filter(t=>t.sourceChatId!==chat.id);
          for(const key of Object.keys(oldPending))delete data.pendingRemote[key];
          for(const c of related)if(c!==chat)c.providerSessionsResetPending=resetId;
          try{await persist()}catch(error){data.conversations.splice(index,0,chat);data.memories.push(...removedMemories);data.tasks.push(...removedTasks);Object.assign(data.pendingRemote,oldPending);for(const [c,reset]of oldResets)if(c.providerSessionsResetPending===resetId){if(reset)c.providerSessionsResetPending=reset;else delete c.providerSessionsResetPending;}if(chat.importSource)chat.importSource.watch=sourceWatch;await staged.rollback();throw error;}
          await staged.commit().catch(e=>console.error('Очистка удалённых файлов:',e.message));await fileReviews.remove(chat.id).catch(()=>console.warn('Просмотр удалённой сессии будет очищен позже.'));
          // Local managed archives are also cleaned on the next context preparation.
          for(const c of related)if(c!==chat)changed(c);changed();return send(res,200,{ok:true,files:input.files===true?preview.files.length:0,memories:removedMemories.length});
         });}finally{deletingProjects.delete(chat.projectId);deletingChats.delete(chat.id)}
       }
       if((req.method==='GET'&&action==='move-preview')||(req.method==='POST'&&action==='move')){
        if(!isOwner(user)&&user.name!==chat.owner)throw fail(403,'Перенести сессию может её автор или владелец пространства.');
        assertChatMovable(chat);const input=req.method==='POST'?await jsonBody(req):{projectId:url.searchParams.get('project')};
        if(!data.conversations.includes(chat))throw fail(404,'Сессия уже удалена.');assertChatMovable(chat);
        if(!input.projectId)throw fail(400,'Выбери проект назначения.');const source=projectById(chat.projectId),target=projectById(input.projectId);if(source===target)throw fail(400,'Выбери другой проект.');
        if(data.conversations.some(c=>c!==chat&&c.projectId===target.id&&c.importSource?.key&&c.importSource.key===chat.importSource?.key))throw fail(409,'Эта исходная сессия уже импортирована в выбранный проект.');
        const ids=[source.id,target.id].sort();
        const paired=fn=>projectFiles.run(ids[0],()=>projectFiles.run(ids[1],fn));
        if(req.method==='GET'){const preview=await paired(()=>movePreview(workspace(source),workspace(target),chat,target,data.memories,data.tasks));assertChatMovable(chat);const {source:files,additions,mapping,...view}=preview;return send(res,200,view);}
        if(input.confirmation!==chat.id||input.revision!==(chat.revision||0))throw fail(409,'Сессия изменилась. Открой перенос ещё раз.');
        if(ids.some(key=>deletingProjects.has(key)))throw fail(409,'Один из проектов сейчас меняется. Повтори через несколько секунд.');
        for(const key of ids)deletingProjects.add(key);deletingChats.add(chat.id);
        try{return await paired(async()=>{
         assertChatMovable(chat);const preview=await movePreview(workspace(source),workspace(target),chat,target,data.memories,data.tasks);assertChatMovable(chat);
         if(input.previewToken!==preview.token)throw fail(409,'Файлы, память или проект изменились. Открой перенос ещё раз.');
         const map=name=>preview.mapping[name]||name,aliasGroup=id();
         const aliases={roots:[...new Set([...(chat.fileAliases?.roots||[]),...Object.values(chat.providerSessions||{}).map(s=>s.cwd),chat.importSource?.cwd].filter(Boolean))],projectIds:[...new Set([...(chat.fileAliases?.projectIds||[]),source.id])],groups:{...Object.fromEntries(Object.entries(chat.fileAliases?.groups||{}).map(([key,mapping])=>[key,Object.fromEntries(Object.entries(mapping).map(([name,value])=>[name,map(value)]))])),[aliasGroup]:preview.mapping},originalPaths:Object.fromEntries(Object.entries(chat.importSource?.mapping||{}).map(([name,value])=>[name,map(value)])),file:`imports/team-room/${chat.id}/move-${aliasGroup}.json`};
         const staged=await stageMoveFiles(workspace(source),workspace(target),preview);
         let targetFiles;try{await staged.addFile(aliases.file,Buffer.from(JSON.stringify(aliases)));targetFiles=await snapshot(workspace(target))}catch(error){await staged.rollback();throw error;}
         const notes=data.memories.filter(m=>m.sourceChatId===chat.id),tasks=data.tasks.filter(t=>t.sourceChatId===chat.id),old={projectId:chat.projectId,messages:chat.messages,files:chat.files,fileAliases:chat.fileAliases,providerSessions:chat.providerSessions,providerSessionsResetPending:chat.providerSessionsResetPending,importSource:chat.importSource,updatedAt:chat.updatedAt};
         const others=data.conversations.filter(c=>c!==chat&&c.projectId===source.id),oldResets=new Map(others.map(c=>[c,c.providerSessionsResetPending])),reset=id();
         chat.fileAliases=aliases;
         chat.messages=chat.messages.map(m=>({...m,fileAliasGroup:m.fileAliasGroup||aliasGroup,attachments:(m.attachments||[]).map(a=>({...a,path:map(a.path)})),...(m.fileOverrides?{fileOverrides:Object.fromEntries(Object.entries(m.fileOverrides).map(([name,value])=>[name,map(value)]))}:{})}));
         if(chat.importSource)chat.importSource={...chat.importSource,watch:false,mapping:Object.fromEntries(Object.entries(chat.importSource.mapping||{}).map(([name,value])=>[name,map(value)])),fileHashes:Object.fromEntries(Object.entries(chat.importSource.fileHashes||{}).map(([name,value])=>[map(name),value]))};
         chat.projectId=target.id;chat.providerSessions={};delete chat.providerSessionsResetPending;chat.files=targetFiles;chat.updatedAt=now();for(const m of [...notes,...tasks])m.projectId=target.id;for(const c of others)c.providerSessionsResetPending=reset;
         try{await persist()}catch(error){Object.assign(chat,old);for(const m of [...notes,...tasks])m.projectId=source.id;for(const [c,value]of oldResets)if(c.providerSessionsResetPending===reset){if(value)c.providerSessionsResetPending=value;else delete c.providerSessionsResetPending;}await staged.rollback();throw error;}
         await staged.commit().catch(e=>console.error('Очистка переноса:',e.message));for(const c of others)changed(c);changed(chat);changed();return send(res,200,{ok:true,chatId:chat.id,projectId:target.id,files:preview.files,memories:notes.length,tasks:tasks.length,conflicts:preview.conflicts,mapping:preview.mapping});
        });}finally{for(const key of ids)deletingProjects.delete(key);deletingChats.delete(chat.id);}
       }
       if(req.method==='GET'&&!action){const view=url.searchParams.get('view');if(view==='queue')return send(res,200,{messages:queuedFollowups(chat).map(m=>({...m,canEdit:isOwner(user)||m.owner===user.name})),queueOrder:queuedFollowups(chat).map(m=>m.id)});if(view==='progress'){
        const requested=url.searchParams.get('message'),message=requested?chat.messages.find(m=>m.id===requested&&m.role==='assistant'):chat.messages.findLast(m=>m.role==='assistant'&&(chat.run?m.runId===chat.run.id:true));
        const messages=message?[{...message,...(message.agents?{agents:message.agents.map(agentSummary)}:{}),actions:(message.actions||[]).map(a=>({tool:a.tool,status:a.status})),actionsDeferred:Boolean(message.actions?.length)}]:[];
        return send(res,200,{id:chat.id,revision:chat.revision||0,updatedAt:chat.updatedAt,messageCount:chat.messages.length,streamRevision:active.get(chat.id)?.streamRevision||0,run:chat.run||null,approvals:chat.approvals||[],executionDeviceId:chatExecutionDevice(chat),route:chat.route,pendingRoute:chat.pendingRoute||null,messages});
       }if(view==='actions'){const details=actionView(chat,url.searchParams.get('message'));return send(res,details?200:404,details||{error:'Сообщение не найдено.'});}return send(res,200,view==='compact'?compactChat(chat,{limit:url.searchParams.has('limit')?Math.max(1,Math.min(160,Number(url.searchParams.get('limit'))||80)):undefined,before:url.searchParams.has('before')?Math.max(0,Number(url.searchParams.get('before'))||0):undefined,around:url.searchParams.get('around')||undefined}):chat);}
       if(req.method==='PATCH'&&!action){const input=await jsonBody(req);if(!data.conversations.includes(chat)||deletingChats.has(chat.id)||projectDeleting.has(chat.projectId))throw fail(409,'Сессия сейчас меняется. Повтори действие.');if(input.title!==undefined){const title=String(input.title).trim().slice(0,100);if(!title)throw fail(400,'Добавь название сессии.');chat.title=title;chat.titleSource='manual';chat.titleMeta={...chat.titleMeta,status:'manual',origin:'user',updatedAt:now()};}await persist();changed(chat);return send(res,200,compactChat(chat,{limit:80}))}
       if(req.method==='GET'&&action==='export'){const project=projectById(chat.projectId);const context=await prepareContext(workspace(project),chat,project,data.memories.filter(x=>x.projectId===project.id),data.tasks.filter(x=>x.projectId===project.id),contextChats(chat));res.writeHead(200,{'content-type':'text/markdown; charset=utf-8','content-disposition':`attachment; filename="team-room-chat.md"`});return res.end(context.context)}
       if(req.method==='POST'&&action==='send'){
         const started=Date.now();if(shuttingDown)throw fail(503,'Приложение перезапускается. Текст сохранён в поле ввода; повтори отправку через несколько секунд.');
         const input=await jsonBody(req);if(input.attachments!==undefined&&(!Array.isArray(input.attachments)||input.attachments.some(f=>!f||typeof f.path!=='string')))throw fail(400,'Некорректные вложения.');if(input.messageId!==undefined&&!validMessageId(input.messageId))throw fail(400,'Недопустимый ID сообщения.');const text=String(input.text||'').trim();if(text.length>100000)return send(res,400,{error:'Сообщение слишком длинное. Прикрепи текст файлом.'});
         if(await acceptedMessageExists(chat,input.messageId))return send(res,200,{ok:true,duplicate:true});
         if(active.has(chat.id))return await enqueueFollowup(chat,user,input,res);
         if(Object.values(data.pendingRemote).some(p=>p.chatId===chat.id))return send(res,409,{error:'Предыдущая работа ещё завершается на компьютере. Дождись сохранения файлов; команда «Стоп» повторно отправит остановку.'});
         const provider=input.provider==='claude'?'claude':'codex';if(provider==='claude'&&/fable/i.test(input.model||'')&&input.allowUsageCredits!==true)return send(res,409,{error:'Fable может использовать usage credits. Подтверди это перед отправкой запроса.'});const boundDeviceId=chatExecutionDevice(chat),deviceId=knownExecutionDevice(input.deviceId)||boundDeviceId;
         if(!deviceId)return send(res,409,{error:'Выбери компьютер для этой сессии. Он останется закреплён за ней.'});
         if(boundDeviceId&&deviceId!==boundDeviceId)return send(res,409,{error:'Компьютер этой сессии изменился. Выбери нужный Mac вверху ещё раз перед отправкой.'});
         if(!devices().some(d=>d.id===deviceId&&d.online))return send(res,409,{error:'Выбранный компьютер отключён.'});
         const permissions=checkPermissions(deviceId,input.permissionMode??chat.route?.permissionMode),profile=selectedAccount(deviceId,provider,input.accountId);
         if(deviceId!==localId&&bridges.get(deviceId)?.protocolVersion===1)return send(res,426,{error:'На этом компьютере старая версия Team Room Community Connect, которая повторно передаёт историю. Скачай новый архив в «Компьютеры» и замени подключение перед продолжением.'});
         if(await acceptedMessageExists(chat,input.messageId))return send(res,200,{ok:true,duplicate:true});
         if(chat.importSource?.active)return send(res,409,{error:'Исходная сессия ещё выполняет работу. Дождись её завершения и обновления переноса.'});
         if(active.has(chat.id))return await enqueueFollowup(chat,user,input,res);
         if(Object.values(data.pendingRemote).some(p=>p.chatId===chat.id))return send(res,409,{error:'Предыдущая работа ещё завершается на компьютере. Дождись сохранения файлов; команда «Стоп» повторно отправит остановку.'});
         if(chatLocks.has(chat.id))return send(res,409,{error:'Этот чат уже подготавливает запрос.'});if(legacyBusy(chat,deviceId))return send(res,426,{error:'Для параллельных сессий на этом компьютере обнови Team Room Community Connect в разделе «Компьютеры».'});
         const attachments=[];for(const f of (input.attachments||[]).slice(0,20)){const full=await filePath(workspace(projectById(chat.projectId)),f.path);await fs.access(full);attachments.push({path:portablePath(f.path),name:String(f.name||path.basename(f.path)).slice(0,180),mimeType:String(f.mimeType||'application/octet-stream').slice(0,100)})}
         if(!text&&!attachments.length)return send(res,400,{error:'Напиши сообщение или прикрепи файл.'});
         // Attachment checks await disk I/O: another request may have reserved this chat.
         if(chat.archivedAt||chat.projectId!==originProjectId||chatLocks.has(chat.id)||deletingChats.has(chat.id)||!data.conversations.includes(chat))return send(res,409,{error:'Этот чат сейчас меняется. Повтори отправку.'});
         if(chatExecutionDevice(chat)&&chatExecutionDevice(chat)!==deviceId)return send(res,409,{error:'Компьютер сессии изменился во время подготовки сообщения. Повтори отправку на выбранном Mac.'});
         if(await acceptedMessageExists(chat,input.messageId))return send(res,200,{ok:true,duplicate:true});
         if(chat.archivedAt||chat.projectId!==originProjectId||projectDeleting.has(chat.projectId)||deletingChats.has(chat.id)||!data.conversations.includes(chat))throw fail(409,'Сессия изменилась во время подготовки сообщения. Повтори отправку.');
         if(chatExecutionDevice(chat)&&chatExecutionDevice(chat)!==deviceId)throw fail(409,'Компьютер сессии изменился во время подготовки сообщения.');
         if(active.has(chat.id))return await enqueueFollowup(chat,user,input,res);
         if(chatLocks.has(chat.id))return send(res,409,{error:'Этот чат уже подготавливает запрос.'});
         if(shuttingDown)throw fail(503,'Приложение перезапускается. Повтори отправку через несколько секунд.');
         const mode=selectedExecutionMode(deviceId,input,chat.pendingRoute?.executionMode||chat.route?.executionMode);chatLocks.add(chat.id);dispatchDevices.set(chat.id,deviceId);const acceptedMessage={id:input.messageId||id(),role:'user',text:text||'Проанализируй прикреплённые файлы.',attachments,owner:user.name,createdAt:now(),status:'completed'};
         let options={provider,deviceId,accountId:profile,permissionMode:permissions,executionMode:mode,model:String(input.model||'').slice(0,100),effort:String(input.effort||'').slice(0,20),preferences:input.preferences||{},allowUsageCredits:input.allowUsageCredits===true};
         const queued=chat.messages.filter(m=>m.followup&&m.delivery==='queued');options.queuedMessageIds=queued.map(m=>m.id);
         // Accept promptly; native limit errors are handled by runChat's existing failover.
         // Catalog and quota refreshes must not block saving the user's message.
         options.queuedMessageIds=queued.map(m=>m.id);
         // Acknowledgement depends only on this small durable record. The full
         // state and native run authority are saved separately before dispatch.
         let committed;try{committed=await commitAcceptedMessage(chat,{type:'message-accept',chatId:chat.id,projectId:chat.projectId,userId:user.id,message:acceptedMessage,options});}catch(error){chatLocks.delete(chat.id);dispatchDevices.delete(chat.id);throw error;}
         if(!chat.messages.some(m=>m.id===acceptedMessage.id)){chatLocks.delete(chat.id);dispatchDevices.delete(chat.id);throw fail(409,'Сессия изменилась во время сохранения сообщения.');}
         initializeTitle(chat);send(res,202,{ok:true});console.log(JSON.stringify({event:'message-accepted',kind:'message',elapsedMs:Date.now()-started,journalBytes:committed.bytes}));changed(chat);
         setImmediate(()=>{
          scheduleMessageSnapshot();if(shuttingDown)return;
          const launch={};void runChat(chat,user,options,launch).catch(async error=>{
           // A late save failure from an earlier launch must not stop its successor.
           if(chatLaunches.get(chat.id)===launch){chatLaunches.delete(chat.id);chatLocks.delete(chat.id);dispatchDevices.delete(chat.id);chat.run=null;active.delete(chat.id);}
           const last=launch.message;
           if(last?.status==='running'){last.status='failed';last.error=error.message;}else if(chat.pendingSubmission?.messageId===acceptedMessage.id)chat.messages.push({id:id(),role:'assistant',provider,text:'',status:'failed',error:error.message,createdAt:now()});
           if(chat.pendingSubmission?.messageId===acceptedMessage.id)delete chat.pendingSubmission;await persist().catch(console.error);changed(chat);console.error(error);
          });
         });return;
       }
       if(req.method==='POST'&&action==='switch'){
        const input=await jsonBody(req),deviceId=knownExecutionDevice(input.deviceId)||chatExecutionDevice(chat);
        if(!['claude','codex'].includes(input.provider)||!deviceId)throw fail(409,'Выбери провайдера и компьютер.');
        const mode=input.permissionMode??chat.pendingRoute?.permissionMode??chat.route?.permissionMode;
        const route={provider:input.provider,deviceId,executionMode:selectedExecutionMode(deviceId,input,chat.pendingRoute?.executionMode||chat.route?.executionMode),accountId:executionAccount(deviceId,input.provider,input.accountId),permissionMode:devices().some(d=>d.id===deviceId&&d.online)?checkPermissions(deviceId,mode):permissionMode(mode),model:String(input.model||'').slice(0,100),effort:String(input.effort||'').slice(0,20)};
        const queued=active.has(chat.id)||chatLocks.has(chat.id),key=queued?'pendingRoute':'route',previous=chat[key],previousDeviceId=chat.executionDeviceId;
        if(JSON.stringify(previous)!==JSON.stringify(route)||previousDeviceId!==deviceId){
         chat[key]=route;chat.executionDeviceId=deviceId;
         // Context files are regenerated before the next turn. Saving settings
         // needs only one durable state write, without re-exporting the history.
         try{await persist()}catch(error){if(chat[key]===route){if(previous)chat[key]=previous;else delete chat[key];chat.executionDeviceId=previousDeviceId;}throw error;}
         changed(chat);
        }
        return send(res,200,{ok:true,checkpointAt:chat.checkpoint?.updatedAt||null,queued,executionDeviceId:chat.executionDeviceId,route:chat.route,pendingRoute:chat.pendingRoute||null});
       }
       if(req.method==='POST'&&action==='detach-source'){if(chat.importSource){chat.importSource.watch=false;chat.importSource.active=false;await saveCheckpoint(chat,'source-detached');changed(chat);}return send(res,200,{ok:true});}
       if(req.method==='POST'&&action==='memory'){refreshMemory(chat);return send(res,202,{ok:true});}
       if(req.method==='POST'&&action==='stop'){
        active.get(chat.id)?.controller.abort();
        for(const [runId,pending]of Object.entries(data.pendingRemote))if(pending.chatId===chat.id){pending.cancelRequested=true;out(bridges.get(pending.deviceId)||{readyState:0},{type:'abort',runId});}
        await persist();changed(chat);return send(res,200,{ok:true});
       }
       if(req.method==='POST'&&action==='resume-queue'){
         if(active.has(chat.id))return send(res,409,{error:'Ответ ещё выполняется. Дополнения сохраняются в очереди.'});
         const input=await jsonBody(req);if(input.provider&&['claude','codex'].includes(input.provider)){const boundDeviceId=chatExecutionDevice(chat),deviceId=knownExecutionDevice(input.deviceId)||boundDeviceId;if(!deviceId)throw fail(409,'Выбери компьютер для продолжения сессии.');if(boundDeviceId&&deviceId!==boundDeviceId)throw fail(409,'Компьютер сессии изменился. Выбери нужный Mac вверху перед продолжением очереди.');chat.route={...chat.route,executionMode:selectedExecutionMode(deviceId,input,chat.route?.executionMode),permissionMode:checkPermissions(deviceId,input.permissionMode??chat.route?.permissionMode),provider:input.provider,deviceId,accountId:selectedAccount(deviceId,input.provider,input.accountId),model:String(input.model||'').slice(0,100),effort:String(input.effort||'').slice(0,20),allowUsageCredits:input.allowUsageCredits===true};chat.executionDeviceId=deviceId;}
         startQueuedFollowups(chat,user);await persist();changed(chat);return send(res,202,{ok:true,notice:chat.queueNotice||null});
       }
       if(req.method==='POST'&&action==='cancel-followup'){
         const input=await jsonBody(req),m=chat.messages.find(m=>m.id===input.messageId&&m.followup&&m.owner===user.name);
         if(!m||!['queued','uncertain'].includes(m.delivery))return send(res,409,{error:'Дополнение уже отправляется или передано провайдеру.'});
         m.delivery='cancelled';m.status='cancelled';await persist();changed(chat);return send(res,200,{ok:true});
       }
       if(req.method==='POST'&&action==='retry-followup'){
         const input=await jsonBody(req),m=chat.messages.find(m=>m.id===input.messageId&&m.followup&&m.owner===user.name);
         if(!m||m.delivery!=='uncertain')return send(res,409,{error:'Сообщение уже обработано или находится в очереди.'});
         const record=active.get(chat.id);m.delivery='queued';m.status='queued';m.deliveryDetail=null;delete m.rejectedRunId;if(record)m.afterRunId=record.id;
         await persist();changed(chat);if(record)void pumpFollowups(chat,record)?.catch(console.error);else startQueuedFollowups(chat,user);
         return send(res,202,{ok:true});
       }
       if(req.method==='POST'&&action==='approval'){
        const input=await jsonBody(req),record=active.get(chat.id),approval=record?.approvals.get(input.id);
        if(!approval)throw fail(409,'Запрос уже закрыт.');
        if(approval.inflight)throw fail(409,'Ответ уже передаётся. Дождись подтверждения.');
        const answer={allow:input.allow===true,answers:input.answers};
        if(approval.answer&&JSON.stringify(approval.answer)!==JSON.stringify(answer))throw fail(409,'Предыдущий ответ мог быть принят. Повтори тот же ответ, чтобы подтвердить доставку.');
        approval.answer=answer;approval.deliveryId||=id();
        const pending=Promise.resolve().then(()=>approval.reply(answer.allow,answer.answers,approval.deliveryId));approval.inflight=pending;
        try{
         const reply=await pending;
         if(reply?.accepted===false||reply?.ok===false)throw fail(409,'Этот запрос уже завершён на компьютере. Обнови чат.');
         if(active.get(chat.id)!==record||record.closing)return send(res,200,{ok:true,closed:true});
         if(record.approvals.get(input.id)===approval)record.approvals.delete(input.id);
         chat.approvals=[...record.approvals.values()].map(approvalPublic);refreshRunActivity(chat,record);
         await persist();changed(chat);return send(res,200,{ok:true});
        }finally{if(approval.inflight===pending)delete approval.inflight;}
       }
     }
     const fileOpenMatch=url.pathname.match(/^\/api\/projects\/([^/]+)\/file-open$/);
     if(req.method==='POST'&&fileOpenMatch){
       const project=data.projects.find(p=>p.id===fileOpenMatch[1]);if(!project)throw fail(404,'Проект не найден.');
       securityLimits.take('file-open:'+user.id,80,60000);const input=await jsonBody(req);
       return send(res,201,await fileOpenLinks.issue(workspace(project),input.path,user.id));
     }
     const uploadMatch=url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads(?:\/([^/]+))?(\/commit)?$/);
     if(uploadMatch){
      securityLimits.take('upload-requests:'+user.id,3000,60000);
      const project=projectById(uploadMatch[1]),uploadId=uploadMatch[2],dir=workspace(project);
      if(req.method==='POST'&&!uploadId){const input=await jsonBody(req);securityLimits.take('upload-start:'+user.id,60,60000);const result=await projectFiles.run(project.id,async()=>{const current=await snapshot(dir);const existing=current.find(f=>f.path===input.path)?.size||0;if(current.reduce((n,f)=>n+f.size,0)-existing+input.size>MAX_PROJECT)throw fail(413,'Проект превышает 50 ГБ.');await ensureVolumeSpace(storage,input.size);return fileUploads.create(project.id,input.id,user.id,input)});return send(res,201,result);}
      if(req.method==='GET'&&uploadId&&!uploadMatch[3])return send(res,200,await fileUploads.status(project.id,uploadId,user.id));
      if(req.method==='PATCH'&&uploadId&&!uploadMatch[3]){const bytes=await readBody(req,UPLOAD_CHUNK);return send(res,200,await fileUploads.chunk(project.id,uploadId,user.id,Number(url.searchParams.get('offset')),bytes));}
      if(req.method==='POST'&&uploadId&&uploadMatch[3]){const result=await projectFiles.run(project.id,async()=>{projectById(project.id);const upload=await fileUploads.status(project.id,uploadId,user.id),current=await snapshot(dir);if(current.reduce((n,f)=>n+f.size,0)-(current.find(f=>f.path===upload.path)?.size||0)+upload.size>MAX_PROJECT)throw fail(413,'Проект превышает 50 ГБ.');return fileUploads.commit(project.id,uploadId,user.id,dir)});changed();return send(res,200,result);}
      throw fail(405,'Действие загрузки не поддерживается.');
     }
     const fileMatch=url.pathname.match(/^\/api\/projects\/([^/]+)\/files$/);
     if(fileMatch){const project=data.projects.find(p=>p.id===fileMatch[1]);if(!project)return send(res,404,{error:'Проект не найден.'});if(projectDeleting.has(project.id))throw fail(409,'Проект удаляется.');const dir=workspace(project);const name=url.searchParams.get('path');
       if(req.method==='GET'&&!name)return send(res,200,{files:await projectFiles.run(project.id,()=>{if(projectDeleting.has(project.id)||!data.projects.includes(project))throw fail(404,'Проект удалён или удаляется.');return snapshot(dir)})});
       if(['GET','HEAD'].includes(req.method)&&name)return await serveSharedFile(req,res,dir,name,url.searchParams.get('preview')==='1',url.searchParams.get('annotation')||'');
       if(req.method==='POST'&&name){if(Number(req.headers['content-length'])>MAX_FILE)throw fail(413,'Файл превышает 5 ГБ.');securityLimits.take('upload:'+user.id,60,60000);const relative=portablePath(name);const size=await projectFiles.run(project.id,()=>{if(projectDeleting.has(project.id)||!data.projects.includes(project))throw fail(409,'Проект удалён или удаляется.');const declared=Number(req.headers['content-length'])||0;return (async()=>{await ensureVolumeSpace(storage,declared);const current=await snapshot(dir);if(current.reduce((n,f)=>n+f.size,0)-(current.find(f=>f.path===relative)?.size||0)+declared>MAX_PROJECT)throw fail(413,'Проект превышает 50 ГБ.');if(current.length>=MAX_WORKSPACE_FILES&&!current.some(f=>f.path===relative))throw fail(413,'В проекте уже '+MAX_WORKSPACE_FILES.toLocaleString('ru-RU')+' рабочих файлов.');return atomicProjectWrite(dir,relative,req);})()});changed();return send(res,201,{path:relative,name:path.basename(relative),size,mimeType:req.headers['content-type']||'application/octet-stream'})}
     }
     if(req.method==='POST'&&url.pathname==='/api/memories'){const input=await jsonBody(req);if(!String(input.text||'').trim())return send(res,400,{error:'Добавь текст записи.'});const memory={id:id(),projectId:projectById(input.projectId).id,text:String(input.text).trim().slice(0,10000),author:user.name,createdAt:now()};data.memories.unshift(memory);await persist();changed();return send(res,201,memory)}
     const memoryMatch=url.pathname.match(/^\/api\/memories\/([^/]+)$/);if(req.method==='DELETE'&&memoryMatch){const removed=data.memories.find(m=>m.id===memoryMatch[1]);if(removed&&projectDeleting.has(removed.projectId))throw fail(409,'Проект удаляется.');if(removed?.autoKey)data.suppressedMemoryKeys.push(removed.autoKey);data.memories=data.memories.filter(m=>m.id!==memoryMatch[1]);await persist();changed();return send(res,200,{ok:true})}
     if(req.method==='POST'&&url.pathname==='/api/tasks'){const input=await jsonBody(req);const task={id:id(),projectId:projectById(input.projectId).id,title:String(input.title||'Задача').slice(0,200),details:String(input.details||'').slice(0,5000),status:'inbox',owner:user.name,updatedAt:now()};data.tasks.unshift(task);await persist();changed();return send(res,201,task)}
     const taskMatch=url.pathname.match(/^\/api\/tasks\/([^/]+)$/);if(req.method==='PATCH'&&taskMatch){const task=data.tasks.find(t=>t.id===taskMatch[1]);if(!task)return send(res,404,{error:'Задача не найдена'});if(projectDeleting.has(task.projectId))throw fail(409,'Проект удаляется.');const input=await jsonBody(req);if(projectDeleting.has(task.projectId)||!data.tasks.includes(task))throw fail(409,'Задача или проект удаляются.');if(['inbox','doing','review','blocked','done'].includes(input.status))task.status=input.status;task.updatedAt=now();await persist();changed();return send(res,200,task)}
     if(req.method==='GET'&&url.pathname==='/api/connect-update'){
       const names=await connectorProgramNames();
       const entries=await Promise.all(names.map(async name=>({name,content:await fs.readFile(path.join(root,name))})));
       entries.push({name:'package.json',content:JSON.stringify({name:'team-room-community-connect',private:true,type:'module',dependencies:{'@modelcontextprotocol/sdk':'1.31.0',ws:'^8.18.0','@openai/codex':'latest','@anthropic-ai/claude-code':'latest'}})},
        {name:'Обновить Mac.command',executable:true,content:'#!/bin/zsh\ncd "${0:A:h}"\nexport PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\nnode install-background.mjs\nread\n'},
        {name:'Обновить Windows.cmd',content:'@echo off\r\ncd /d "%~dp0"\r\ncall npm install --omit=dev\r\nif errorlevel 1 (pause & exit /b 1)\r\nnode bridge.mjs\r\npause\r\n'},
        {name:'Обновление.txt',content:'Дождись завершения задач. Распакуй обновление в ту же папку, где лежит прежний device-config.json, с заменой файлов программы. Не удаляй device-config.json, рабочие папки и журналы. На Mac открой Обновить Mac.command; Windows: закрой старое подключение и открой Обновить Windows.cmd. После обновления MCP синхронизируются автоматически. Архив не содержит ключей устройства или подписки.'});
       res.writeHead(200,{'content-type':'application/zip','content-disposition':'attachment; filename="Team-Room-Connect-Update.zip"','cache-control':'no-store'});return res.end(zip(entries));
     }
     if(req.method==='GET'&&url.pathname==='/api/workspace-cleanup-plans'){
       const deviceId=importDevice(req);if(!deviceId||deviceId==='local')throw fail(403,'Нужно подключение этого компьютера.');
       securityLimits.take('workspace-cleanup:'+deviceId,6,60000);
       const plans=[];let count=0;
       for(const project of data.projects.slice(0,100)){const approved=await readWorkspaceCleanupPlans(workspace(project),project.id);for(const plan of approved){count+=plan.entries.length;if(count>10000||plans.length>=100)throw fail(413,'Слишком много записей восстановления.');plans.push(plan);}}
       return send(res,200,{version:1,plans});
     }
     if(url.pathname==='/api/device-import-maintenance'&&['POST','DELETE'].includes(req.method)){
       const deviceId=importDevice(req);if(!deviceId||deviceId==='local')throw fail(403,'Нужно собственное подключение этого Mac.');const input=await jsonBody(req);
       if(req.method==='DELETE'){const lease=importMaintenance(deviceId);if(lease&&lease.id!==input.leaseId)throw fail(409,'Обновление принадлежит другому процессу.');deviceImportMaintenance.delete(deviceId);changed();return send(res,200,{ok:true});}
       securityLimits.take('import-maintenance:'+deviceId,10,60000);
       if(input.renew===true){const lease=importMaintenance(deviceId);if(!lease||lease.id!==input.leaseId)throw fail(409,'Обслуживание этого Mac истекло или принадлежит другому процессу.');lease.until=Date.now()+600000;return send(res,200,{leaseId:lease.id,expiresAt:lease.until});}
       if(importMaintenance(deviceId))throw fail(409,'Обновление этого Mac уже выполняется.');
       const lease=await acquireConnectorMaintenance(deviceId,input);if(res.destroyed||req.aborted){if(deviceImportMaintenance.get(deviceId)===lease)deviceImportMaintenance.delete(deviceId);return;}return send(res,200,{leaseId:lease.id,expiresAt:lease.until});
     }
     if(req.method==='POST'&&url.pathname==='/api/native-device-pair'){
       if(!currentUser(req))throw fail(403,'Войди в Team Room в приложении.');
       securityLimits.take('native-pair:'+user.id,12,3600000);
       if(!secureSite||!canonicalOrigin)throw fail(503,'Подключение Mac требует постоянного HTTPS адреса.');
       const input=await jsonBody(req),name=String(input.name||'').trim().normalize('NFC');
       if(!name||name.length>80||/[\x00-\x1f\x7f]/.test(name)||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.deviceId)||!/^[a-f0-9]{64}$/.test(input.token))throw fail(400,'Укажи имя Mac и корректное подключение.');
       const existing=data.devices.find(d=>d.id===input.deviceId);
       if(existing){if(existing.owner!==user.name||existing.tokenHash!==tokenHash(input.token))throw fail(409,'Это подключение относится к другой регистрации.');await persist();return send(res,200,{deviceId:existing.id,name:existing.name,hubUrl:canonicalOrigin});}
       if(data.devices.length>=100)throw fail(409,'Слишком много компьютеров. Удали неиспользуемые подключения.');
       const device={id:input.deviceId,name,owner:user.name,tokenHash:tokenHash(input.token),createdAt:now()};data.devices.push(device);await persist();changed();return send(res,201,{deviceId:device.id,name:device.name,hubUrl:canonicalOrigin});
     }
     if(req.method==='POST'&&url.pathname==='/api/device-package'){
       const input=await jsonBody(req);const target=new URL(input.hubUrl||canonicalOrigin||`http://${req.headers.host}`);if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw fail(400,'Укажи HTTP или HTTPS адрес пространства.');if(secureSite&&target.origin!==canonicalOrigin)throw fail(400,'Для подключения используй HTTPS адрес этого пространства.');
       const token=crypto.randomBytes(32).toString('hex');const device={id:id(),name:String(input.name||'Другой компьютер').slice(0,80),owner:user.name,tokenHash:tokenHash(token),createdAt:now()};data.devices.push(device);await persist();changed();
       const names=await connectorProgramNames();const entries=await Promise.all(names.map(async name=>({name,content:await fs.readFile(path.join(root,name))})));
       entries.push({name:'device-config.json',content:JSON.stringify({hubUrl:target.origin,deviceId:device.id,token,name:device.name,projectId:input.projectId||data.projects[0].id},null,2)},{name:'package.json',content:JSON.stringify({name:'team-room-community-connect',private:true,type:'module',dependencies:{'@modelcontextprotocol/sdk':'1.31.0',ws:'^8.18.0','@openai/codex':'latest','@anthropic-ai/claude-code':'latest'}})},{name:'Запуск Mac.command',executable:true,content:'#!/bin/zsh\ncd "${0:A:h}"\nexport PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\nif ! command -v node >/dev/null; then echo "Установи Node.js LTS с https://nodejs.org и открой этот файл снова"; read; exit 1; fi\nif [ ! -d node_modules ]; then npm install || exit 1; fi\nnode install-integration.mjs\nnode bridge.mjs\nread\n'},{name:'Запуск Windows.cmd',content:'@echo off\r\ncd /d "%~dp0"\r\nwhere node >nul 2>nul || (echo Install Node.js LTS from https://nodejs.org & pause & exit /b 1)\r\nif not exist node_modules call npm install\r\nnode install-integration.mjs\r\nnode bridge.mjs\r\npause\r\n'},{name:'Открой меня.txt',content:'1. Распакуй архив на нужном компьютере.\n2. Нужны Node.js LTS, Claude Code и Codex CLI.\n3. Открой Запуск Mac.command или Запуск Windows.cmd.\n4. Открой общий адрес '+target.origin+' в браузере и войди в Team Room.\n5. Выбери этот компьютер справа вверху. Если нужен вход по подписке, открой Компьютеры → Войти.\nКоманды переноса установятся при запуске: Claude /teamroom-community Название проекта; Codex $teamroom-community с названием проекта.\nВсе диалоги, память и файлы принадлежат общему пространству. Не запускай отдельное пространство на каждом компьютере.\nПространство должно быть доступно по сети; 127.0.0.1 указывает только на текущий компьютер. Для разных сетей используй постоянный HTTPS адрес или частную сеть.\nФайл device-config.json даёт доступ этому компьютеру: не пересылай его посторонним. Доступ можно отозвать в Компьютерах.'});
       entries.push({name:'Установить автозапуск Mac.command',executable:true,content:'#!/bin/zsh\ncd "${0:A:h}"\nexport PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"\nif ! command -v node >/dev/null; then echo "Установи Node.js LTS с https://nodejs.org и открой этот файл снова"; read; exit 1; fi\nnode install-background.mjs\necho "Нажми Enter, чтобы закрыть окно"\nread\n'});
       entries.find(e=>e.name==='Открой меня.txt').content+='\nАвтозапуск на Mac:\n1. После завершения задач закрой старое окно подключения.\n2. Открой Установить автозапуск Mac.command из этого архива.\n3. Дождись сообщения Автозапуск установлен. Теперь окно можно закрыть.\nПосле входа в macOS и пробуждения связь восстановится автоматически. Пока компьютер спит, он не выполняет запросы.\nWindows: текущий файл Запуск Windows.cmd пока работает с открытым окном.\n';
       const bytes=zip(entries);res.writeHead(200,{'content-type':'application/zip','content-disposition':'attachment; filename="Team-Room-Connect.zip"','cache-control':'no-store'});return res.end(bytes);
     }
     const deviceMatch=url.pathname.match(/^\/api\/devices\/([^/]+)$/);if(req.method==='DELETE'&&deviceMatch){const target=data.devices.find(d=>d.id===deviceMatch[1]);if(target&&target.owner!==user.name&&!isOwner(user))throw fail(403,'Это устройство другого аккаунта.');data.devices=data.devices.filter(d=>d.id!==deviceMatch[1]);bridges.get(deviceMatch[1])?.close();await persist();changed();return send(res,200,{ok:true})}
     return send(res,404,{error:'Действие не найдено.'});
   }
   const relative=['/room/','/room/pane'].includes(url.pathname)?'index.html':decodeURIComponent(url.pathname.slice(1));const full=path.resolve(root,'public',relative);if(!full.startsWith(path.join(root,'public')+path.sep))return send(res,403,{error:'Недопустимый путь'});const actual=await fs.realpath(full);if(!actual.startsWith(await fs.realpath(path.join(root,'public'))+path.sep))throw fail(403,'Недопустимый файл.');let bytes=await fs.readFile(actual);const ext=path.extname(full);if(relative==='index.html')bytes=await versionUiDocument(bytes,path.join(root,'public'));if(ext==='.html')res.setHeader('Content-Security-Policy',url.pathname==='/room/pane'?appCsp.replace("frame-ancestors 'none'","frame-ancestors 'self'"):appCsp);const compressed=ext!=='.woff2'&&bytes.length>=1024&&acceptsGzip(req);const output=compressed?await compress(bytes):bytes;res.writeHead(200,{'vary':'Accept-Encoding','content-length':output.length,...(compressed?{'content-encoding':'gzip'}:{}),'content-type':ext==='.html'?'text/html; charset=utf-8':ext==='.js'?'text/javascript; charset=utf-8':ext==='.css'?'text/css; charset=utf-8':ext==='.svg'?'image/svg+xml':ext==='.png'?'image/png':ext==='.woff2'?'font/woff2':ext==='.webmanifest'?'application/manifest+json; charset=utf-8':'application/octet-stream','cache-control':relative.startsWith('fonts/')&&/^[a-z-]+-[a-f0-9]{12}\.woff2$/.test(path.basename(relative))?'public, max-age=31536000, immutable':'no-store','x-content-type-options':'nosniff'});res.end(output);
 }catch(error){const status=error.status|| (error.code==='ENOENT'?404:error instanceof SyntaxError?400:500);if(status===500)console.error(error.message);if(!res.headersSent)send(res,status,{error:status===500?'Не удалось выполнить действие. Попробуй снова.':error.message||'Не удалось выполнить действие.'});else if(!res.destroyed)res.destroy();}
});
const wsServer=new WebSocketServer({noServer:true,maxPayload:192*1024*1024,perMessageDeflate:{threshold:1024,serverNoContextTakeover:true,clientNoContextTakeover:true,zlibDeflateOptions:{level:3}}});
const browserWsServer=new WebSocketServer({noServer:true,maxPayload:4096});
server.on('upgrade',(req,socket,head)=>{
 try{const url=new URL(req.url,`http://${req.headers.host}`);
 if(url.pathname==='/events'){if(!currentUser(req)||!req.headers.origin||!sameOrigin(req,canonicalOrigin))return socket.destroy();browserWsServer.handleUpgrade(req,socket,head,ws=>{events.add(ws);ws.securityLimiter=new RateLimiter({maxKeys:1});ws.sessionHash=tokenHash(cookieValue(req,'trc_session'));ws.on('error',()=>{});ws.lastReceived=Date.now();ws.on('pong',()=>{ws.lastReceived=Date.now()});ws.on('message',raw=>{try{ws.securityLimiter.take('messages',60,10000)}catch{ws.close(1008,'Слишком много сообщений');return;}if(!validBrowserSession(ws)){ws.close(4001,'Вход завершён');return;}ws.lastReceived=Date.now();try{const msg=JSON.parse(raw.toString());if(msg.type==='ping')out(ws,{type:'pong',at:msg.at});else if(msg.type==='capabilities'){ws.replyDeltas=msg.replyDeltas===1?1:0;ws.replyRevisions?.clear();}else if(msg.type==='watch-agent'){if(validAgentId(msg.agentId)&&typeof msg.chatId==='string'&&typeof msg.messageId==='string'&&data.conversations.some(c=>c.id===msg.chatId&&c.messages.some(m=>m.id===msg.messageId&&m.agents?.some(a=>a.id===msg.agentId))))ws.agentWatch={chatId:msg.chatId,messageId:msg.messageId,agentId:msg.agentId};else ws.agentWatch=null;}}catch{}});ws.on('close',()=>events.delete(ws));out(ws,{type:'connected'});});return;}
 if(url.pathname==='/bridge'){const token=String(req.headers.authorization||'').replace(/^Bearer /,'');const device=data.devices.find(d=>d.tokenHash===tokenHash(token));if(!token||!device)return socket.destroy();wsServer.handleUpgrade(req,socket,head,ws=>{
   ws.on('error',error=>{
    console.warn(JSON.stringify({event:'connector-frame-error',deviceId:device.id,code:error.code||null,message:String(error.message||'WebSocket error').slice(0,160)}));
    if(error.code!=='WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'||ws.resultEnvelopeVersion===1)return;
    for(const runId of ws.pendingResultIds||[]){
     const pending=data.pendingRemote[runId];if(pending?.deviceId!==device.id||oversizedRemoteResults.has(runId))continue;
     oversizedRemoteResults.set(runId,device.id);while(oversizedRemoteResults.size>256)oversizedRemoteResults.delete(oversizedRemoteResults.keys().next().value);
     const chat=data.conversations.find(chat=>chat.id===pending.chatId),message=chat?.messages.find(message=>message.id===pending.messageId);
     if(message){message.finalizationSyncError='Большой итоговый журнал сохранён на Mac. Обнови Team Room на этом компьютере — передача продолжится автоматически.';message.syncWarning=message.finalizationSyncError;}
     changed(chat);void persist().catch(console.error);
    }
   });const previous=bridges.get(device.id),connectedAt=Date.now();
   // Two Connect processes can share an installed device token. Keep the live
   // worker until its application traffic stops, so reconnects cannot evict a
   // healthy result transfer every time the duplicate process retries.
   if(previous?.readyState===1&&connectedAt-(previous.lastApplicationReceived||previous.lastReceived||0)<45000){
    if(!previous.duplicateLoggedAt||connectedAt-previous.duplicateLoggedAt>=60000){previous.duplicateLoggedAt=connectedAt;console.warn(JSON.stringify({event:'connector-duplicate',deviceId:device.id,connectorVersion:previous.connectorVersion||null,trafficAgeMs:connectedAt-(previous.lastApplicationReceived||previous.lastReceived||0)}));}
    ws.close(4009,'Другое подключение этого устройства уже активно.');return;
   }
   bridges.set(device.id,ws);invalidateCatalog(device.id);previous?.close();ws.lastReceived=connectedAt;ws.lastApplicationReceived=connectedAt;device.lastSeen=now();ws.on('pong',()=>{if(bridges.get(device.id)===ws){ws.lastReceived=Date.now();device.lastSeen=now();}});changed();
   ws.on('message',async raw=>{if(shuttingDown||bridges.get(device.id)!==ws)return;try{const msg=JSON.parse(raw.toString());ws.lastReceived=Date.now();ws.lastApplicationReceived=ws.lastReceived;device.lastSeen=now();
     if(msg.type==='heartbeat'){if(ws.connectorVersion!==msg.connectorVersion)console.log(JSON.stringify({event:'connector-state',deviceId:device.id,connectorVersion:msg.connectorVersion,protocolVersion:msg.protocolVersion,running:(msg.running||[]).length,results:(msg.results||[]).length}));ws.protocolVersion=msg.protocolVersion||5;ws.resultEnvelopeVersion=msg.resultEnvelopeVersion===1?1:0;ws.connectorVersion=msg.connectorVersion;ws.fileTransferVersion=msg.fileTransferVersion===1?1:0;ws.workspaceFileLimit=msg.workspaceFileLimit===MAX_WORKSPACE_FILES?MAX_WORKSPACE_FILES:10000;ws.largeFilesVersion=msg.largeFilesVersion===1?1:0;ws.agentMonitorVersion=msg.agentMonitorVersion===1?1:0;ws.runRecoveryVersion=msg.runRecoveryVersion===1?1:0;if(typeof msg.loginBusy==='boolean')ws.loginBusy=msg.loginBusy;ws.liveInputVersion=msg.liveInputVersion===1?1:0;ws.approvalAckVersion=msg.approvalAckVersion===1?1:0;ws.permissionsVersion=msg.permissionsVersion===1?1:0;ws.executionModeVersion=msg.executionModeVersion===1?1:0;ws.accountsVersion=msg.accountsVersion===1?1:0;ws.voiceVersion=msg.voiceVersion===1?1:0;ws.mcpSyncVersion=msg.mcpSyncVersion||0;ws.skillsSyncVersion=msg.skillsSyncVersion||0;if(ws.skillsSyncVersion===1&&msg.skillsRevision!==skillStore.data.revision)ws.skillsSentRevision=null;if(ws.mcpSyncVersion===1&&msg.mcpRevision!==mcpVault.data.revision)ws.mcpSentRevision=null;out(ws,{type:'heartbeat-ack',at:now(),resultTransferVersion:1,resultEnvelopeVersion:1});readyWorker(device,ws);reconcileWorker(device,ws,msg);}
     else if(msg.type==='skills-report'){ws.skillsSyncVersion=1;ws.securityLimiter||=new RateLimiter();ws.securityLimiter.take('skills-report',5,60000);ws.skills={...ws.skills,importing:true};changed();try{if(await skillStore.publish(device.id,msg.report,(id,hash,paths)=>requestDevice(device.id,'skills-export',{id,hash,paths},120000))){pushSkills();changed();}}finally{if(ws.skills)ws.skills.importing=false;changed();}}
     else if(msg.type==='skills-applied'){if(msg.info&&Number.isSafeInteger(msg.info.revision)&&msg.info.revision<=skillStore.data.revision){if(msg.info.error)ws.skillsSentRevision=null;ws.skills={revision:msg.info.revision,count:Number.isSafeInteger(msg.info.count)?msg.info.count:0,error:Boolean(msg.info.error)};changed();}}
     else if(msg.type==='mcp-report'){ws.mcpSyncVersion=1;ws.securityLimiter||=new RateLimiter();ws.securityLimiter.take('mcp-report',10,60000);if(await mcpVault.publish(device.id,msg.report)){pushMcp();changed();}}
     else if(msg.type==='mcp-applied'){const info=msg.info;if(info&&Number.isSafeInteger(info.revision)&&info.revision<=mcpVault.data.revision){if(info.error)ws.mcpSentRevision=null;ws.mcp={revision:info.revision,error:Boolean(info.error),servers:Array.isArray(info.servers)?info.servers.slice(0,100).filter(r=>mcpVault.data.servers[r.name]).map(r=>({name:r.name,state:r.state==='configured'?'configured':'attention',detail:r.state==='configured'?null:'Проверь программу, папку, переменные или вход в сервис'})):[]};changed();}}
     else if(msg.type==='run-accepted'){const record=[...active.values()].find(r=>r.id===msg.runId&&r.deviceId===device.id);if(record){acceptRemote(record);restoreWorker(record);}}
     else if(msg.type==='status'){ws.protocolVersion=msg.protocolVersion||1;ws.connectorVersion=msg.connectorVersion;ws.fileTransferVersion=msg.fileTransferVersion===1?1:0;ws.workspaceFileLimit=msg.workspaceFileLimit===MAX_WORKSPACE_FILES?MAX_WORKSPACE_FILES:10000;ws.largeFilesVersion=msg.largeFilesVersion===1?1:0;ws.agentMonitorVersion=msg.agentMonitorVersion===1?1:0;ws.runRecoveryVersion=msg.runRecoveryVersion===1?1:0;if(typeof msg.loginBusy==='boolean')ws.loginBusy=msg.loginBusy;ws.liveInputVersion=msg.liveInputVersion===1?1:0;ws.approvalAckVersion=msg.approvalAckVersion===1?1:0;ws.permissionsVersion=msg.permissionsVersion===1?1:0;ws.executionModeVersion=msg.executionModeVersion===1?1:0;ws.accountsVersion=msg.accountsVersion===1?1:0;ws.voiceVersion=msg.voiceVersion===1?1:0;ws.mcpSyncVersion=msg.mcpSyncVersion||0;ws.skillsSyncVersion=msg.skillsSyncVersion||0;catalogAuthChanged(device.id,msg.status,msg.accounts||[]);ws.accounts=Array.isArray(msg.accounts)?msg.accounts.slice(0,20).filter(a=>a&&/^[a-f0-9-]{36}$/.test(a.id)&&['claude','codex'].includes(a.provider)&&typeof a.name==='string').map(a=>({id:a.id,provider:a.provider,name:a.name.slice(0,60),status:a.status,loginBusy:Boolean(a.loginBusy)})):[];ws.accountsError=typeof msg.accountsError==='string'?msg.accountsError.slice(0,300):null;device.accounts=ws.accounts.map(a=>({id:a.id,provider:a.provider,name:a.name}));ws.status=msg.status;ws.statusAt=Date.now();readyWorker(device,ws);changed()}
     else if(msg.type==='response'){const r=requests.get(msg.requestId);if(r&&r.deviceId===device.id){clearTimeout(r.timer);requests.delete(msg.requestId);msg.error?r.reject(fail(msg.status===409?409:503,msg.error)):r.resolve(msg.result)}}
     else if(msg.type==='result-envelope-status'||msg.type==='result-envelope-chunk'){
      await serialRemote(msg.runId,async()=>{try{
       const pending=data.pendingRemote[msg.runId];
       if(pending&&pending.deviceId!==device.id)throw fail(409,'Этот результат больше не ожидается на выбранном компьютере.');
       if(!pending){if(await completedRunSaved(msg.runId)){out(ws,{type:'response',requestId:msg.requestId,result:{completed:true}});await acknowledgeRemoteResult(ws,msg.runId);return;}throw fail(409,'Этот результат больше не ожидается в пространстве.');}
       if(deletingChats.has(pending.chatId))throw fail(409,'Этот результат больше не ожидается в пространстве.');
       if(importMaintenance(device.id))throw fail(409,'Обновляется подключение этого Mac. Результат сохранён и будет передан после обновления.');
       const result=msg.type==='result-envelope-status'?await incomingResultEnvelopes.status(msg.runId,msg.envelope||msg.resultEnvelope):await incomingResultEnvelopes.chunk(msg.runId,msg);
       if(msg.type==='result-envelope-status')result.eventCoverage=savedRemoteEventCoverage(msg.runId);
       out(ws,{type:'response',requestId:msg.requestId,result});
       const record=active.get(pending.chatId),chat=data.conversations.find(c=>c.id===pending.chatId);
       if(record?.id===msg.runId&&chat?.run?.id===msg.runId){acceptRemote(record);if(msg.type==='result-envelope-status'){setRunActivity(chat,record,'saving','Файлы переданы. Сохраняет итоговый ответ…');changed(chat);}}
      }catch(error){console.warn(JSON.stringify({event:'result-envelope-transfer-retry',runId:msg.runId,deviceId:device.id,code:error.code||null,message:error.message}));out(ws,{type:'response',requestId:msg.requestId,error:error.message,status:error.status||500});}});
     }
     else if(msg.type==='result-transfer-status'||msg.type==='result-file-chunk'){
      await serialRemote(msg.runId,async()=>{try{
       if(await completedRunSaved(msg.runId)){out(ws,{type:'response',requestId:msg.requestId,result:{completed:true}});await acknowledgeRemoteResult(ws,msg.runId);return;}
       const pending=data.pendingRemote[msg.runId];if(!pending||pending.deviceId!==device.id||deletingChats.has(pending.chatId))throw fail(409,'Этот результат больше не ожидается в пространстве.');
       if(importMaintenance(device.id))throw fail(409,'Обновляется подключение этого Mac. Результат сохранён и будет передан после обновления.');
       if(oversizedRemoteResults.get(msg.runId)===device.id&&ws.resultEnvelopeVersion!==1)throw fail(426,'Обнови Team Room на этом Mac до 1.0.25 или новее. Большой итоговый журнал сохранён и продолжит передачу после обновления.');
       const result=msg.type==='result-transfer-status'?await incomingResults.status(msg.runId,msg.files):await incomingResults.chunk(msg.runId,msg);
       if(msg.type==='result-transfer-status')result.eventCoverage=savedRemoteEventCoverage(msg.runId);
       // Acknowledge saved bytes before publishing UI progress. Browser profile
       // rows from old clients are handled by IncomingResults and never counted.
       out(ws,{type:'response',requestId:msg.requestId,result});
       const record=active.get(pending.chatId),chat=data.conversations.find(c=>c.id===pending.chatId);
       if(record?.id===msg.runId&&chat?.run?.id===record.id)try{
        acceptRemote(record);
        if(msg.type==='result-transfer-status')startTransferProgress(chat,record,'upload',portableFiles(result.files),result.files);
        else{
         if(record.transferLedger?.direction!=='upload'||!record.transferLedger.files){const manifest=await incomingResults.read(msg.runId),status=await incomingResults.status(msg.runId,manifest.files);startTransferProgress(chat,record,'upload',portableFiles(status.files),status.files);}
         const file=record.transferLedger.files.get(msg.path);if(file){currentTransferFile(chat,record,file);acknowledgeTransferFile(chat,record,file,result.offset);}
        }
        if(record.transferLedger?.files&&record.transferLedger.completedFiles===record.transferLedger.files.size)finalizeTransferProgress(chat,record);
       }catch{console.warn(JSON.stringify({event:'transfer-progress-unavailable',runId:msg.runId}));}
      }catch(error){out(ws,{type:'response',requestId:msg.requestId,error:error.message,status:error.status||500});}});
     }
     else if(msg.type==='turn-agent'){const record=[...active.values()].find(r=>r.id===msg.runId&&r.deviceId===device.id);if(record&&!record.remoteResultReceived&&msg.agent){acceptRemote(record);restoreWorker(record);record.remoteEmit?.({type:'agent',agent:msg.agent,replace:true});}}
     else if(msg.type==='turn-event'){const record=[...active.values()].find(r=>r.id===msg.runId&&r.deviceId===device.id);if(record&&!record.remoteResultReceived){acceptRemote(record);restoreWorker(record);receiveRunEvent(record,msg)}}
     else if(msg.type==='turn-checkpoint'){const record=[...active.values()].find(r=>r.id===msg.runId&&r.deviceId===device.id);if(record&&!record.remoteResultReceived){acceptRemote(record);restoreWorker(record);}await serialRemote(msg.runId,()=>receiveCheckpoint(device,ws,msg));}
     else if(msg.type==='turn-result'){await serialRemote(msg.runId,async()=>{const record=[...active.values()].find(r=>r.id===msg.runId&&r.deviceId===device.id);
      if(record?.remoteFinalizationOwner==='live'){
       acceptRemote(record);if(!record.remoteResultDuplicateSeen){record.remoteResultDuplicateSeen=true;console.log(JSON.stringify({event:'run-result-already-finalizing',runId:msg.runId,deviceId:device.id,stage:record.remoteFinalizationStage}));}
       return;
      }
      let result=msg;
      if(msg.resultEnvelope){
       const pending=data.pendingRemote[msg.runId];if(pending&&pending.deviceId!==device.id){out(ws,{type:'result-unknown',runId:msg.runId});return;}
       if(await completedRunSaved(msg.runId)){await acknowledgeRemoteResult(ws,msg.runId);return;}
       if(!pending||deletingChats.has(pending.chatId)){out(ws,{type:'result-unknown',runId:msg.runId});return;}
       try{
        result=await incomingResultEnvelopes.load(msg.runId,msg.resultEnvelope);
        if(result.resultEnvelope||result.chatId&&result.chatId!==pending.chatId||result.projectId&&result.projectId!==pending.projectId)throw fail(409,'Метаданные результата не соответствуют ожидаемой сессии.');
       }catch(error){const chat=data.conversations.find(c=>c.id===pending.chatId);remoteFinalizationFailure(msg.runId,'envelope-load',error,{record,chat,message:record?.message||chat?.messages.find(message=>message.id===pending.messageId),retry:true});throw error;}
      }
      if(record?.remoteResolve){
       for(const packet of Array.isArray(result.events)?result.events:[]){if(!Number.isSafeInteger(packet.seq)||packet.seq<1)continue;if(['delta','model','session','context','tool','tool-result','usage','limits','notice','followup-delivery','plan'].includes(packet.event?.type))receiveRunEvent(record,packet,{backfill:Boolean(record.needsSnapshot)});}
       const resolve=record.remoteResolve;record.remoteResolve=null;record.remoteReject=null;record.remoteFinalizationOwner='live';record.remoteFinalizationStage='received';record.remoteResultReceived=true;acceptRemote(record);resolve(result);
      }else await recoverRemoteResult(device,ws,result);});}
     else if(msg.type==='login-log'||msg.type==='login-complete'){broadcast({...msg,deviceId:device.id});if(msg.type==='login-complete'){ws.loginBusy=false;invalidateCatalog(device.id,msg.provider,{accountId:msg.accountId||'',dropCache:true,forgetAuth:true,dropLimits:true});changed()}}
   }catch(error){out(ws,{type:'error',message:error.message})}});
   ws.on('close',code=>{console.log(JSON.stringify({event:'connector-closed',deviceId:device.id,connectorVersion:ws.connectorVersion,code}));if(bridges.get(device.id)===ws){bridges.delete(device.id);for(const record of active.values())if(record.deviceId===device.id){const chat=data.conversations.find(c=>c.id===record.chatId);if(chat?.run){record.needsSnapshot=true;if(!chat.run.connectionLost)record.textBeforeDisconnect=chat.run.text;chat.run.connectionLost=true;chat.run.text='Связь с компьютером потеряна. Автоматически переподключаюсь…'}}changed()}});
   out(ws,{type:'welcome',deviceId:device.id,resultTransferVersion:1,resultEnvelopeVersion:1});
 });return;}socket.destroy();}catch{socket.destroy()}
});
const connectionWatchdog=setInterval(()=>{
 for(const ws of [...bridges.values(),...events]){
  if(ws.readyState!==1)continue;
  if(events.has(ws)&&!validBrowserSession(ws)){ws.close(4001,'Вход завершён');continue;}
  if(Date.now()-(ws.lastReceived||0)>75000){ws.terminate();continue;}
  try{ws.ping();out(ws,{type:'ping',at:Date.now()})}catch{ws.terminate()}
 }
},20000);connectionWatchdog.unref();
server.requestTimeout=120000;server.headersTimeout=15000;server.maxHeadersCount=80;
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Порт ${port} занят. Останови старый Team Room, затем запусти снова.`:error.message);process.exitCode=1;accounts.close()});
restoreRemoteRuns();
let adminDiagnostics=null;
async function diagnosticSessions({signal}){
 const rows=[...active.values()].slice(0,12),result=[];
 let cursor=0;
 await Promise.all(Array.from({length:Math.min(4,rows.length)},async()=>{while(cursor<rows.length){
  signal.throwIfAborted();const record=rows[cursor++],chat=data.conversations.find(c=>c.id===record.chatId),message=record.message;
  const lastAction=message?.actions?.at(-1),ws=bridges.get(record.deviceId);
  const item={chatId:record.chatId,title:String(chat?.title||'').slice(0,120),runId:record.id,provider:chat?.run?.provider||chat?.provider,deviceId:record.deviceId,connected:ws?.readyState===1,connectorVersion:ws?.connectorVersion||null,restored:Boolean(record.restored),phase:record.activity?.phase||chat?.run?.phase||null,startedAt:chat?.run?.startedAt||null,status:message?.status,textChars:message?.text?.length||0,lastSeq:record.lastSeq||message?.remoteSeq||0,approvalCount:record.approvals?.size||0,lastAction:lastAction?{tool:String(lastAction.tool||'').slice(0,100),status:lastAction.status||null,at:lastAction.at||null}:null};
  if(item.connected&&record.deviceId!==localId)try{
   const probe=await requestDevice(record.deviceId,'run-state',{runId:record.id,afterSeq:Number.MAX_SAFE_INTEGER},8000,signal);
   item.native={state:['running','missing','result-saving','result-pending'].includes(probe?.state)?probe.state:'unknown',seq:Number.isSafeInteger(probe?.seq)?probe.seq:null,textChars:typeof probe?.text==='string'?probe.text.length:null,preparing:probe?.preparing===true,finishing:probe?.finishing===true,nativeFinished:probe?.nativeFinished===true,canSteer:probe?.canSteer===true,approvals:Array.isArray(probe?.approvals)?probe.approvals.length:0,agents:Array.isArray(probe?.agents)?probe.agents.length:0,...(probe?.finalizationRetry?{finalizationRetry:{attempts:Number.isSafeInteger(probe.finalizationRetry.attempts)?probe.finalizationRetry.attempts:0,retryAt:Number.isSafeInteger(probe.finalizationRetry.retryAt)?probe.finalizationRetry.retryAt:null,code:/^[A-Z_]{1,80}$/.test(probe.finalizationRetry.code||'')?probe.finalizationRetry.code:null}}:{})};
  }catch(error){item.native={state:'probe-failed',status:error.status||null};}
  result.push(item);
 }}));
 return {at:now(),version:appVersion,memory:{heapUsedBytes:process.memoryUsage().heapUsed,heapLimitBytes:getHeapStatistics().heap_size_limit,rssBytes:process.memoryUsage().rss},activeCount:active.size,pendingCount:Object.keys(data.pendingRemote).length,devices:[...bridges.entries()].slice(0,50).map(([deviceId,ws])=>({deviceId,connected:ws.readyState===1,lastReceivedAt:ws.lastReceived?new Date(ws.lastReceived).toISOString():null,connectorVersion:ws.connectorVersion||null})),sessions:result};
}
if(hubOnly)try{adminDiagnostics=await createAdminDiagnostics({storage,sessions:diagnosticSessions});}catch{console.warn(JSON.stringify({event:'admin-diagnostics-unavailable'}));}
server.listen(port,host,()=>{process.send?.({type:'community-hub-ready',version:appVersion});setTimeout(()=>{void ensureLocalClient();for(const chat of data.conversations)titleQueue.enqueue(chat);console.log(JSON.stringify({event:'session-title-migration',pending:data.conversations.filter(c=>c.titleSource==='auto'&&c.titleMeta?.version<1&&c.titleMeta?.status!=='waiting').length,manual:data.conversations.filter(c=>c.titleSource==='manual').length}));},3000).unref();console.log(`Team Room: http://127.0.0.1:${port}\nОбщие чаты, память и файлы. Адрес постоянный. ${host==='127.0.0.1'?'Сейчас доступен на этом компьютере.':'Доступен в локальной сети с входом по паролю.'}`)});
async function shutdown(){
 if(shuttingDown)return;shuttingDown=true;
 await adminDiagnostics?.close().catch(()=>{});
 titleQueue.close();notifications.close();localVoice?.close();clearInterval(connectionWatchdog);clearInterval(updateTimer);clearTimeout(messageSaveTimer);messageSaveTimer=null;
 // Only local provider children belong to this process. Remote workers keep
 // their durable run and reconnect after the hub has restarted.
 for(const record of active.values()){
  clearInterval(record.recoveryTimer);
  if(record.deviceId===localId)record.controller.abort();
 }
 accounts.close();for(const p of loginProcesses.values())p.kill();
 for(const ws of events)ws.close();for(const ws of bridges.values())ws.close();server.close();
 try{
  await messageJournal.drain();
  await Promise.allSettled([...remoteWrites.values()]);
  await Promise.all([...active.values()].filter(r=>r.message?.status==='running').map(r=>{const chat=data.conversations.find(c=>c.id===r.chatId);return chat?runProgress.save(chat,r.message):null}));
  await persist();process.exit(0);
 }catch(error){console.error('Не удалось завершить сохранение перед перезапуском:',error.message);process.exit(1);}
}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);if(process.env.TEAM_ROOM_MANAGED_UPDATES==='1')process.once('disconnect',()=>void shutdown());

async function setupTelegramWebhook(){try{await telegramAuth.ensureWebhook(canonicalOrigin);}catch(error){telegramAuth.webhookReady=false;telegramAuth.webhookError=error.message;console.error('Telegram: подключение получателей не готово:',error.message);}}
if(hubOnly&&canonicalOrigin&&telegramAuth.status().telegramEnabled)void setupTelegramWebhook();
