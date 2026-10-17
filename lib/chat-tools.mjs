import crypto from 'node:crypto';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {messageKey} from './memory.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const uuid=()=>crypto.randomUUID();
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,240}$/.test(value);
const pending=new Set(['queued','sending','received','dispatching','uncertain','cancelled']);
export const queuedFollowups=chat=>chat.messages.filter(m=>m.role==='user'&&m.followup&&m.delivery==='queued');
const permitted=(message,actor)=>actor.canEditAny||message.owner===actor.name;
const same=(a,b)=>a.length===b.length&&a.every((value,index)=>value===b[index]);

export function prepareFollowupOperation(chat,input,actor,kind){
 if(!actor?.name)throw fail(403,'Войди в Team Room.');
 if(kind==='edit'){
  if(!validId(input.messageId)||typeof input.text!=='string')throw fail(400,'Некорректное дополнение.');
  const text=input.text.trim();if(!text||text.length>100000)throw fail(400,'Дополнение должно содержать от 1 до 100 000 символов.');
  const message=queuedFollowups(chat).find(m=>m.id===input.messageId);if(!message)throw fail(409,'Дополнение уже передаётся. Его нельзя изменить.');
  if(!permitted(message,actor))throw fail(403,'Изменить дополнение может его автор или владелец пространства.');
  if(input.expectedText!==undefined&&input.expectedText!==message.text)throw fail(409,'Дополнение изменилось. Открой редактирование ещё раз.');
  return {type:'followup-edit',chatId:chat.id,projectId:chat.projectId,messageId:message.id,text,expectedText:message.text,actorName:actor.name,canEditAny:actor.canEditAny===true,at:new Date().toISOString()};
 }
 const queued=queuedFollowups(chat),current=queued.map(m=>m.id),order=input.messageIds;
 if(!Array.isArray(order)||order.some(id=>!validId(id))||new Set(order).size!==order.length||order.length!==current.length||order.some(id=>!current.includes(id)))throw fail(409,'Очередь изменилась. Обнови её и повтори перемещение.');
 if(queued.some(m=>!permitted(m,actor)))throw fail(403,'Порядок дополнений может менять их автор или владелец пространства.');
 if(input.expectedOrder!==undefined&&(!Array.isArray(input.expectedOrder)||!same(input.expectedOrder,current)))throw fail(409,'Очередь изменилась. Обнови её и повтори перемещение.');
 return {type:'followup-reorder',chatId:chat.id,projectId:chat.projectId,messageIds:order.slice(),expectedOrder:current,actorName:actor.name,canEditAny:actor.canEditAny===true,at:new Date().toISOString()};
}

// Called synchronously at the durable journal's linearization point. A send
// intent or competing edit that wins the race makes the mutation a safe no-op.
export function applyFollowupOperation(chat,operation){
 if(!['followup-edit','followup-reorder'].includes(operation.type)||typeof operation.actorName!=='string'||typeof operation.canEditAny!=='boolean')throw new Error('Некорректное изменение очереди в журнале.');
 const actor={name:operation.actorName,canEditAny:operation.canEditAny};
 if(operation.type==='followup-edit'){
  if(!validId(operation.messageId)||typeof operation.text!=='string'||!operation.text.trim()||operation.text.length>100000||typeof operation.expectedText!=='string')throw new Error('Некорректное дополнение в журнале.');
  const message=queuedFollowups(chat).find(m=>m.id===operation.messageId);
  if(!message||!permitted(message,actor)||message.text!==operation.expectedText)return false;
  message.text=operation.text;message.editedAt=operation.at;message.queueRevision=(message.queueRevision||0)+1;chat.updatedAt=operation.at;return true;
 }
 const queued=queuedFollowups(chat),current=queued.map(m=>m.id),order=operation.messageIds;
 if(!Array.isArray(order)||!Array.isArray(operation.expectedOrder)||order.some(id=>!validId(id))||new Set(order).size!==order.length)throw new Error('Некорректный порядок дополнений в журнале.');
 if(!same(current,operation.expectedOrder)||order.length!==current.length||order.some(id=>!current.includes(id))||queued.some(m=>!permitted(m,actor)))return false;
 const byId=new Map(queued.map(m=>[m.id,m]));let index=0;
 chat.messages=chat.messages.map(m=>m.role==='user'&&m.followup&&m.delivery==='queued'?byId.get(order[index++]):m);chat.updatedAt=operation.at;return true;
}

export function forkChat(source,{throughMessageId,title,sideQuestion=false}={},user,files){
 if(typeof sideQuestion!=='boolean'||title!==undefined&&typeof title!=='string'||throughMessageId!==undefined&&!validId(throughMessageId))throw fail(400,'Некорректные параметры ответвления.');
 const cut=throughMessageId===undefined?source.messages.length-1:source.messages.findIndex(m=>m.id===throughMessageId);
 if(throughMessageId!==undefined&&cut<0)throw fail(404,'Сообщение для ответвления не найдено.');
 const history=structuredClone(source.messages.slice(0,cut+1)),ids=new Map(history.map(m=>[m.id,uuid()])),runs=new Map(history.filter(m=>m.runId).map(m=>[m.runId,uuid()]));
 for(const message of history){
  message.id=ids.get(message.id);if(message.runId)message.runId=runs.get(message.runId);
  if(message.afterRunId){if(runs.has(message.afterRunId))message.afterRunId=runs.get(message.afterRunId);else delete message.afterRunId;}
  if(message.replyBoundaries)message.replyBoundaries=message.replyBoundaries.filter(b=>ids.has(b.messageId)).map(b=>({...b,messageId:ids.get(b.messageId)}));
  if(message.status==='running'){message.status='interrupted';message.snapshotIncomplete=true;delete message.error;}
  if(pending.has(message.delivery)){message.delivery='cancelled';message.status='cancelled';message.historyOnly=true;}
  for(const key of ['agents','remoteSeq','remoteEventSeqs','progressRevision','deliveryDetail','rejectedRunId','permissionDenials'])delete message[key];
 }
 const at=new Date().toISOString(),kind=sideQuestion||source.kind==='side'?'side':'branch';
 const chat={id:uuid(),projectId:source.projectId,title:(title?.trim()||`${kind==='side'?'Боковой вопрос':'Ответвление'}: ${source.title||'Чат'}`).slice(0,100),titleSource:'manual',titleMeta:{version:1,status:'ready',origin:'branch'},owner:user.name,provider:source.provider,executionDeviceId:source.executionDeviceId||source.route?.deviceId||null,messages:history,providerSessions:{},files:structuredClone(files||[]),kind,fork:{chatId:source.id,messageId:throughMessageId||source.messages.at(-1)?.id||null,title:source.title,createdAt:at,sourceWasRunning:Boolean(source.run),fileSnapshotAt:at},createdAt:at,updatedAt:at};
 if(source.route){const allowed=['provider','deviceId','accountId','permissionMode','model','effort','preferences','allowUsageCredits','executionMode'];chat.route=structuredClone(Object.fromEntries(allowed.filter(key=>source.route[key]!==undefined).map(key=>[key,source.route[key]])));}
 if(kind==='side')chat.route={...chat.route,readOnly:true,autoMemory:false};
 if(source.fileAliases)chat.fileAliases=structuredClone(source.fileAliases);
 if(source.memory?.content&&cut===source.messages.length-1){chat.memory=structuredClone(source.memory);chat.memory.sourceKeys=history.filter(m=>m.status!=='running'&&!pending.has(m.delivery)).map(messageKey);for(const rows of Object.values(chat.memory.content))if(Array.isArray(rows))for(const row of rows)if(Array.isArray(row?.evidence))row.evidence=row.evidence.filter(id=>ids.has(id)).map(id=>ids.get(id));}
 return chat;
}

export function forkRequest(source,input,user){
 if(input.requestId!==undefined&&(typeof input.requestId!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.requestId)))throw fail(400,'Некорректный идентификатор ответвления.');
 if(!input.requestId)return null;
 return {requestId:input.requestId,userId:user.id,key:crypto.createHash('sha256').update(JSON.stringify([source.id,input.throughMessageId||null,input.title||null,input.sideQuestion===true])).digest('hex')};
}

const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function snippet(text,index,length){const start=Math.max(0,index-75),end=Math.min(text.length,index+length+100);return {snippet:(start?'…':'')+text.slice(start,end).replace(/\s+/g,' ')+(end<text.length?'…':''),matchStart:index,matchEnd:index+length};}
export async function searchChats(chats,projects,{q,projectId,chatId,includeArchived=false,limit=40,cursor,maxCharacters=16*1024*1024}={}){
 if(typeof q!=='string'||q.trim().length<2||q.trim().length>200)throw fail(400,'Для поиска введи от 2 до 200 символов.');
 q=q.trim();limit=Math.max(1,Math.min(100,Number(limit)||40));
 const scope=crypto.createHash('sha256').update(JSON.stringify([q,projectId||null,chatId||null,includeArchived])).digest('hex').slice(0,20);
 const available=chats.filter(c=>(!projectId||c.projectId===projectId)&&(!chatId||c.id===chatId)&&(includeArchived||!c.archivedAt));
 let chatIndex=0,messageIndex=null,offset=null;
 if(cursor){let value;try{if(typeof cursor!=='string'||cursor.length>1200)throw new Error();value=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{throw fail(400,'Некорректная страница поиска.');}chatIndex=available.findIndex(c=>c.id===value.chatId);if(value.scope!==scope||chatIndex<0||!Number.isSafeInteger(value.messageIndex)||value.messageIndex< -1||!Number.isSafeInteger(value.offset)||value.offset<0)throw fail(409,'Поиск изменился. Запусти его ещё раз.');messageIndex=value.messageIndex;offset=value.offset;}
 const matches=[],regex=new RegExp(escape(q),'iu'),names=new Map(projects.map(p=>[p.id,p.name]));let scanned=0,sinceYield=0;
 const position=()=>chatIndex<available.length?Buffer.from(JSON.stringify({scope,chatId:available[chatIndex].id,messageIndex:messageIndex??available[chatIndex].messages.length,offset:offset??0})).toString('base64url'):null;
 while(chatIndex<available.length&&matches.length<limit&&scanned<maxCharacters){
  const chat=available[chatIndex];messageIndex??=chat.messages.length;
  if(messageIndex>chat.messages.length){messageIndex=chat.messages.length;offset=null;}
  if(messageIndex===chat.messages.length){const title=String(chat.title||''),match=regex.exec(title);scanned+=title.length;if(match)matches.push({chatId:chat.id,projectId:chat.projectId,projectName:names.get(chat.projectId)||'',title:chat.title,messageId:null,messageIndex:null,kind:'title',archived:Boolean(chat.archivedAt),...snippet(title,match.index,match[0].length)});messageIndex--;offset=null;continue;}
  if(messageIndex<0){chatIndex++;messageIndex=null;offset=null;continue;}
  const message=chat.messages[messageIndex],text=typeof message.text==='string'?message.text:'';offset??=0;
  if(offset>=text.length){messageIndex--;offset=null;continue;}
  const count=Math.min(256*1024,maxCharacters-scanned,text.length-offset),end=offset+count,chunk=text.slice(offset,Math.min(text.length,end+q.length)),match=regex.exec(chunk);scanned+=count;sinceYield+=count;
  if(match){matches.push({chatId:chat.id,projectId:chat.projectId,projectName:names.get(chat.projectId)||'',title:chat.title,messageId:message.id,messageIndex,role:message.role,provider:message.provider||null,kind:'message',archived:Boolean(chat.archivedAt),...snippet(text,offset+match.index,match[0].length)});messageIndex--;offset=null;}
  else if(end>=text.length){messageIndex--;offset=null;}else offset=end;
  if(sinceYield>=512*1024){sinceYield=0;await yieldTurn();}
 }
 while(chatIndex<available.length&&messageIndex!==null&&messageIndex<0){chatIndex++;messageIndex=null;offset=null;}
 const nextCursor=position();return {q,matches,cursor:nextCursor,hasMore:Boolean(nextCursor),truncated:scanned>=maxCharacters,scannedCharacters:scanned};
}
