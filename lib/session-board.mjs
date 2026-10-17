import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const error=(status,message)=>Object.assign(new Error(message),{status});
const stamp=value=>Date.parse(value||'')||0;
const validKey=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(value)&&!['__proto__','constructor','prototype'].includes(value);
export function ownsBoardChat(chat,user){return Boolean(user?.id&&(chat.ownerId?chat.ownerId===user.id:chat.owner===user.name));}
function text(value,max=300){
 return String(value||'').slice(0,20000).replace(/```[\s\S]*?(?:```|$)/g,' ').replace(/\uE200visualize[\s\S]*?(?:\uE201|$)/g,' ')
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/<[^>]*>/g,' ').replace(/[\u0000-\u001f]/g,' ')
  .replace(/\b(?:ntn_|sk-ant-|sk-|ghp_)[A-Za-z0-9_-]{15,}\b/g,'[секрет скрыт]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[секрет скрыт]')
  .replace(/(?:token|password|secret|api[_ -]?key)\s*[:=]\s*\S+/gi,'[секрет скрыт]').replace(/^[\s#>*\-\d.)]+/,'').replace(/\s+/g,' ').trim().slice(0,max);
}
function brief(value,max=260){const clean=text(value,3000);if(clean.length<=max)return clean;const sentence=clean.slice(0,max+1).match(/^([\s\S]*[.!?])(?:\s|$)/)?.[1];return sentence||clean.slice(0,max-1).replace(/\s+\S*$/,'')+'…';}
function tail(chat){let user,taskUser,assistant;const assistants=[];let inspected=0;for(let i=(chat.messages?.length||0)-1;i>=0&&inspected<160;i--,inspected++){const m=chat.messages[i];if(m.role==='user'&&!['queued','sending','dispatching','uncertain','cancelled'].includes(m.delivery)){user||=m;const value=text(m.text,600);if(!taskUser&&value.length>28&&!/^(?:продолжи последнюю незаверш[её]нную задачу|continue the (?:interrupted|last))/i.test(value)&&! /^(?:да|ну|окей|ок|готово|делай|сделай|продолжай|спасибо)[!.,\s]*$/i.test(value))taskUser=m;}if(m.role==='assistant'&&assistants.length<8){assistants.push(m);assistant||=m;}if(user&&taskUser&&assistants.length===8)break;}return {user,taskUser:taskUser||user,assistant,assistants};}
// A finished answer is not a blocking question merely because it contains a
// question mark or a word such as «подтвердил». Keep notification heuristics
// separate: the board needs an explicit request addressed to the user.
function answerRequest(value){
 const lines=String(value||'').replace(/```[\s\S]*?(?:```|$)/g,'').trim().slice(-1600).split('\n').map(line=>line.replace(/^[\s#>*\-\d.)]+/,'').replace(/\*\*/g,'').trim()).filter(Boolean).slice(-5);
 for(const line of lines.reverse()){
  if(/(?:если (?:хочешь|хотите|понадобится|будет нужно)|при желании|могу (?:ещ[её]|также|следующим шагом)|if you (?:want|wish|would like))/i.test(line))continue;
  const direct=/^(?:(?:пожалуйста|теперь|для продолжения)[,:]?\s+)?(?:ответь(?:те)?|уточни(?:те)?|подтверди(?:те)?|пришли(?:те)?|выбери(?:те)?|напиши(?:те)?|скажи(?:те)?|дай(?:те)? доступ|разреши(?:те)?)(?=$|[\s,:.!?])/iu.test(line);
  const blocked=/^(?:мне|для продолжения|чтобы продолжить|перед продолжением)(?=$|[\s,:.!?]).{0,100}(?:нуж(?:ен|на|но|ны)|требуется).{0,100}(?:твой|тво[её]|тво[яи]|ваш|ответ|подтверждени|разрешени|доступ)/iu.test(line);
  const waiting=/^(?:я\s+)?жду\s+(?:(?:тво(?:его|ей|их)|ваш(?:его|ей|их))\s+)?(?:ответа|подтверждения|разрешения|выбора|доступа)/iu.test(line);
  const choice=/^(?:как продолжим|что выбираешь|какой вариант (?:выбираешь|выбрать|использовать)|разрешаешь|подтверждаешь)(?=$|[\s,:.!?]).{0,180}\?\s*$/iu.test(line);
  const english=/^(?:please\s+)?(?:send me|confirm (?:whether|that|the)|choose (?:a|the)|provide (?:the|your)|I need your (?:answer|confirmation|permission)|waiting for your (?:answer|confirmation))\b/i.test(line);
  if(direct||blocked||waiting||choice||english)return line;
 }
 return '';
}
function pendingQuestion(chat,last){return Boolean(chat.approvals?.length||!chat.run&&last?.status==='completed'&&answerRequest(last.text));}
function evidence(chat,items){const rows=[],seen=new Set();for(const row of (chat.memory?.content?.done||[]).slice(-80).reverse()){if(row.status!=='confirmed')continue;const value=brief(row.text,280);if(value&&!seen.has(value)){seen.add(value);rows.push({text:value,source:'memory'});}if(rows.length===12)break;}
 if(rows.length<12)for(const m of items){if(m.status!=='completed'||m.error)continue;const source=(m.text||'').slice(-12000).replace(/```[\s\S]*?(?:```|$)/g,'');for(const line of source.split('\n')){if(!/(?:сделал[аио]?|готов[аоы]?|добав(?:ил[аио]?|лен[аоы]?)|исправ(?:ил[аио]?|лен[аоы]?)|настро(?:ил[аио]?|ен[аоы]?)|созда(?:л[аио]?|н[аоы]?)|реализова(?:л[аио]?|н[аоы]?)|сохранил[аио]?|сохран[её]н[аоы]?|внедр(?:ил[аио]?|[её]н[аоы]?)|подготов(?:ил[аио]?|лен[аоы]?)|updated|implemented|fixed|created|added|saved)(?:\s|[.,:;!?]|$)/i.test(line)||/(?:^|[\s:—-])(?:не\s|план|предлага|нужно|буду|will\s|not\s|failed|ошибк)/i.test(line))continue;const value=brief(line,280);if(value.length>12&&!seen.has(value)){seen.add(value);rows.push({text:value,source:'reply',messageId:m.id});}if(rows.length===12)break;}if(rows.length===12)break;}return rows;
}
// Reuse the model's existing session memory. A task overview must not be
// replaced with the last user message or an isolated item from the next list.
function assistantOverview(items){
 for(const message of items){
  if(message.status!=='completed'||message.error)continue;
  const source=String(message.text||'').slice(0,16000).replace(/```[\s\S]*?(?:```|$)/g,'');
  const found={};const lines=source.split('\n');let section='';
  for(const line of lines){
   const heading=line.match(/^\s*(?:#{1,4}\s+|\*\*)(Суть задачи|Текущая задача|Задача|Цель|Контекст задачи|Контекст сессии|Контекст|Что делаем)(?::?\*\*|\*\*:?)?\s*[:—-]?\s*(.*)$/iu);
   if(heading){section=/цель/i.test(heading[1])?'goal':/контекст/i.test(heading[1])?'context':'task';found[section]||=[];if(heading[2])found[section].push(heading[2]);continue;}
   if(/^\s*(?:#{1,4}\s+|\*\*[^*]{3,90}\*\*\s*[:—-]?\s*$)/.test(line)){section='';continue;}
   if(section&&found[section].join(' ').length<2000)found[section].push(line);
  }
  const goal=brief(found.goal?.join('\n'),260),context=brief(found.context?.join('\n')||found.task?.join('\n'),1800);
  if(goal||context)return {goal,context,source:'assistant',updatedAt:message.createdAt};
 }
 return null;
}
function taskOverview(chat,latest){
 const memory=chat.memory,content=memory?.content;
 const goals=(content?.goals||[]).filter(row=>row.status!=='superseded'&&row.text);
 const goal=brief(goals.findLast(row=>row.status==='confirmed')?.text||goals.at(-1)?.text,260);
 const context=brief(content?.summary,1800);
 const source=context?{goal,context,source:'memory',updatedAt:memory.updatedAt}:assistantOverview(latest.assistants);
 if(!source)return {description:'Описание задачи пока не сформировано в памяти сессии.',context:'',source:'pending',updatedAt:null,stale:false};
 // Keep the goal and the surrounding context together, without duplicating an
 // identical goal already present at the beginning of the saved overview.
 const folded=value=>String(value||'').toLocaleLowerCase().replace(/[\s\p{P}]+/gu,'');
 const shortContext=brief(source.context,540),duplicate=source.goal&&folded(source.context).includes(folded(source.goal));
 const description=brief([!duplicate&&source.goal,shortContext].filter(Boolean).join(' '),650)||source.goal;
 return {...source,description,stale:stamp(source.updatedAt)<stamp(latest.taskUser?.createdAt)};
}
const summaries=new WeakMap();
function summary(chat,latest){const m=chat.memory,key=[latest.user?.id,latest.taskUser?.id,latest.taskUser?.text?.slice(0,400),latest.assistant?.id,latest.assistant?.status,latest.assistant?.text?.length,m?.updatedAt,chat.title].join(':');const cached=summaries.get(chat);if(cached?.key===key)return cached.value;
 const fresh=stamp(m?.updatedAt)>=stamp(latest.taskUser?.createdAt),content=m?.content,task=taskOverview(chat,latest);
 const next=(content?.next||[]).find(r=>r.status!=='superseded');
 const done=(content?.done||[]).findLast(r=>r.status==='confirmed');
 const value={topic:brief(chat.title,110),request:brief(latest.taskUser?.text,320),current:task.description,taskContext:task.context,taskSource:task.source,taskUpdatedAt:task.updatedAt,taskStale:task.stale,nextStep:fresh?brief(next?.text,300):'',result:fresh?brief(done?.text,340):'',done:evidence(chat,latest.assistants),summaryUpdatedAt:m?.updatedAt||latest.assistant?.createdAt||latest.user?.createdAt||chat.createdAt};
 summaries.set(chat,{key,value});return value;
}
export function boardActivity(chat,latest=tail(chat)){
 const a=chat.approvals?.map(v=>v.requestId||v.id).sort().join(',')||'';
 const run=chat.run?.id||latest.assistant?.runId||chat.completion?.runId||latest.user?.id||chat.createdAt;
 return `${run}:${a||pendingQuestion(chat,latest.assistant)&&latest.assistant?.id||''}`;
}
export function boardRow(chat,user,prefs,settings,{devices=[],project,now=Date.now(),includeSummary=true}={}){
 if(!ownsBoardChat(chat,user))return null;
 const latest=tail(chat),last=latest.assistant,run=chat.run,question=pendingQuestion(chat,last);
 const pending=Boolean(chat.pendingSubmission||chat.messages?.at(-1)?.delivery==='dispatching');
 const busy=Boolean(run||pending||chat.importSource?.active);
 const workerId=run?.deviceId||chat.executionDeviceId||chat.route?.deviceId,worker=devices.find(d=>d.id===workerId);
 let state='done',detail='',reason='';
 if(run?.connectionLost||run&&worker?.online===false){state='waiting';reason='offline';detail='Связь с компьютером потеряна. Ожидает переподключения.';}
 else if(chat.approvals?.length){state='waiting';reason='question';detail=chat.approvals.some(a=>a.tool==='AskUserQuestion'||a.tool==='item/tool/requestUserInput')?'Есть вопрос к тебе':'Нужно подтвердить действие';}
 else if(run?.phase==='waiting'){state='waiting';reason='question';detail=text(run.text||'Нужен твой ответ или разрешение на действие',220);}
 else if(run?.phase==='saving'&&/На Mac закончилось место|Подключи внешний диск/i.test(run.text||'')){state='waiting';reason='storage';detail=text(run.text,220);}
 else if(run?.phase==='saving'&&last?.status==='completed'&&last.text){state='done';detail=text(run.text||'Ответ готов. Сохраняет файлы…',200);}
 else if(run||pending||chat.importSource?.active){state='running';detail=text(run?.text||'Работа продолжается',200);}
 else if(last?.limitReached||last?.error||['error','failed','stopped','interrupted'].includes(last?.status)){state='waiting';reason=last?.limitReached?'limit':'error';const label=last?.limitReached?'Лимит подписки исчерпан.':['interrupted','stopped'].includes(last?.status)?'Последний запуск остановлен.':'Последний запуск завершился с ошибкой.';detail=brief(label+' '+(last?.error||'Открой чат для продолжения.'),260);}
 else if(question){state='waiting';reason='question';detail=brief(answerRequest(last?.text),240);}
 const activity=boardActivity(chat,latest),lastActivityAt=run?.startedAt||latest.user?.createdAt||chat.createdAt;
 const completedAt=chat.completion?.completedAt||chat.completion?.at||chat.completion?.createdAt||chat.updatedAt||last?.createdAt||chat.createdAt;
 // Hiding is a projection. No automatic archiving, deletion, writes, or model calls.
 const manuallyHidden=Boolean(prefs.hidden&&(prefs.hiddenFor===activity||activity.endsWith(':')&&last?.id&&prefs.hiddenFor===activity+last.id));
 const autoHidden=state==='done'&&!busy&&!prefs.pinned&&settings.autoHideHours>0&&now-Math.max(stamp(lastActivityAt),stamp(completedAt),stamp(prefs.shownAt))>=settings.autoHideHours*3600000;
 const archived=Boolean(chat.archivedAt);
 const hidden=!archived&&(manuallyHidden||autoHidden||Boolean(project?.archivedAt));
 return {id:chat.id,projectId:chat.projectId,projectName:project?.name||'Проект',projectArchived:Boolean(project?.archivedAt),title:chat.title,ownerId:user.id,...(includeSummary?summary(chat,latest):{}),state,reason,detail,busy,activityKey:activity,archivedAt:chat.archivedAt||null,pinned:Boolean(prefs.pinned),note:typeof prefs.note==='string'?prefs.note:'',hidden,hiddenReason:manuallyHidden?'manual':autoHidden?'inactive':project?.archivedAt?'project':null,canArchive:!busy,deviceId:workerId,deviceName:worker?.name||chat.deviceName||workerId||'Компьютер не выбран',provider:run?.provider||chat.provider,updatedAt:(run&&last?.actions?.at(-1)?.at)||chat.updatedAt||chat.createdAt,completedAt,lastActivityAt};
}

// Small private sidecar: editing a note never rewrites the conversation database.
export class SessionBoardStore{
 constructor(storage){this.file=path.join(storage,'session-board.json');this.data={version:1,users:{}};this.queue=Promise.resolve();}
 async init(){try{const stat=await fs.lstat(this.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>8*1024*1024)throw new Error('Недопустимый файл настроек доски.');const value=JSON.parse(await fs.readFile(this.file,'utf8'));if(value?.version!==1||!value.users||typeof value.users!=='object'||Array.isArray(value.users))throw new Error('Не удалось прочитать настройки доски.');this.data=value;}catch(e){if(e.code!=='ENOENT')throw e;}return this;}
 user(id){if(!validKey(id))throw error(400,'Некорректный аккаунт.');const v=Object.hasOwn(this.data.users,id)?this.data.users[id]:null;return {settings:{autoHideHours:[0,1,3,6,12,24].includes(v?.settings?.autoHideHours)?v.settings.autoHideHours:3},chats:v?.chats&&typeof v.chats==='object'&&!Array.isArray(v.chats)?v.chats:{}};}
 mutate(userId,operation){const job=this.queue.then(async()=>{const current=this.user(userId),next=structuredClone(current);operation(next);const data={...this.data,users:{...this.data.users,[userId]:next}};const bytes=JSON.stringify(data);if(Buffer.byteLength(bytes)>8*1024*1024)throw error(413,'Слишком много настроек доски.');const temporary=this.file+'.'+crypto.randomUUID()+'.tmp';try{const f=await fs.open(temporary,'wx',0o600);try{await f.writeFile(bytes);await f.sync();}finally{await f.close();}await fs.rename(temporary,this.file);this.data=data;const dir=await fs.open(path.dirname(this.file),'r');try{await dir.sync();}finally{await dir.close();}this.data=data;}finally{await fs.rm(temporary,{force:true}).catch(()=>{});}return next;});this.queue=job.catch(()=>{});return job;}
 settings(userId,input){if(!input||Object.keys(input).some(k=>k!=='autoHideHours')||![0,1,3,6,12,24].includes(input.autoHideHours))throw error(400,'Выбери срок скрытия готовых сессий.');return this.mutate(userId,v=>{v.settings.autoHideHours=input.autoHideHours;});}
 patch(user,chat,input){if(!ownsBoardChat(chat,user))throw error(404,'Сессия не найдена на твоей доске.');if(!validKey(chat.id))throw error(400,'Некорректная сессия.');if(!input||Object.keys(input).some(k=>!['pinned','hidden','note'].includes(k))||!Object.keys(input).length)throw error(400,'Некорректная настройка карточки.');for(const key of ['pinned','hidden'])if(Object.hasOwn(input,key)&&typeof input[key]!=='boolean')throw error(400,'Некорректная настройка карточки.');if(Object.hasOwn(input,'note')&&(typeof input.note!=='string'||input.note.length>280))throw error(400,'Пометка должна быть не длиннее 280 символов.');return this.mutate(user.id,v=>{const pref={...(v.chats[chat.id]||{})};if(Object.hasOwn(input,'note'))pref.note=input.note.trim();if(Object.hasOwn(input,'pinned')){pref.pinned=input.pinned;if(input.pinned){pref.hidden=false;pref.shownAt=new Date().toISOString();}}if(Object.hasOwn(input,'hidden')){pref.hidden=input.hidden;pref.hiddenFor=boardActivity(chat);if(!input.hidden)pref.shownAt=new Date().toISOString();}v.chats[chat.id]=pref;});}
}

export function boardList(data,user,store,{scope='active',cursor=0,limit=120,devices=[],isArchiveBlocked=()=>false}={}){
 if(!['active','hidden','archived'].includes(scope))throw error(400,'Неизвестный список доски.');
 const profile=store.user(user.id),projects=new Map(data.projects.map(p=>[p.id,p]));
 // Ownership is checked before any message or memory is inspected.
 const own=data.conversations.filter(c=>ownsBoardChat(c,user)),byId=new Map(own.map(c=>[c.id,c])),counts={running:0,waiting:0,done:0,hidden:0,archived:0};
 const result=[];
 for(const chat of own){const row=boardRow(chat,user,profile.chats[chat.id]||{},profile.settings,{devices,project:projects.get(chat.projectId),includeSummary:false});if(row.canArchive&&isArchiveBlocked(chat)){row.canArchive=false;row.detail||='Сохраняются результаты сессии…';}if(row.archivedAt)counts.archived++;else if(row.hidden)counts.hidden++;else counts[row.state]++;if(scope==='archived'?row.archivedAt:scope==='hidden'?!row.archivedAt&&row.hidden:!row.archivedAt&&!row.hidden)result.push(row);}
 const order={running:0,waiting:1,done:2};
 result.sort((a,b)=>order[a.state]-order[b.state]||Number(b.pinned)-Number(a.pinned)||stamp(b.lastActivityAt)-stamp(a.lastActivityAt)||a.id.localeCompare(b.id));
 const start=Math.max(0,Math.floor(Number(cursor)||0)),size=Math.max(1,Math.min(200,Math.floor(Number(limit)||120)));
 const rows=result.slice(start,start+size).map(row=>{const chat=byId.get(row.id);return {...row,...summary(chat,tail(chat))};});
 return {settings:profile.settings,counts,rows,nextCursor:start+size<result.length?start+size:null,total:result.length,at:new Date().toISOString()};
}
