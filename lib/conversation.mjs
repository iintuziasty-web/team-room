import crypto from 'node:crypto';
import {prepareContext,prepareImages} from './workspace.mjs';
import {messageKey} from './memory.mjs';
import {executionMode} from './permission-policy.mjs';
import {mergeContextUsage} from './session-context.mjs';
export const sessionKey=options=>`${options.deviceId||'local'}:${options.provider}${options.accountId?':'+options.accountId:''}`;
export const coverage=messages=>Object.fromEntries(messages.filter(m=>!['queued','sending','received','dispatching','uncertain','cancelled'].includes(m.delivery)&&(m.status!=='running'||m.text||m.actions?.length)).map(m=>[m.id,messageKey(m)]));
export const fingerprint=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function finishSession(chat,key,files=chat.files||[]){const session=chat.providerSessions?.[key];if(session?.inputAccepted){session.inputAccepted=false;session.covered=coverage(chat.messages);session.files=(files||[]).map(f=>({path:f.path,hash:f.hash}));session.updatedAt=new Date().toISOString();}}
export function missingSession(error){return error?.code==='SESSION_NOT_FOUND'||/(?:no (?:conversation|session|thread)|no rollout found|(?:session|thread|conversation|rollout).{0,80}(?:not found|does not exist|not exist|cannot find|could not find)|(?:unable to|failed to) (?:find|load) (?:session|thread|rollout))/i.test(error?.message||'');}
// Resume only Team Room's own native sessions, scoped to the executing device/account/workspace.
export async function continueConversation({providers,cwd,chat,project,memories,tasks,relatedChats=[],options,session},emit,signal){
 if(signal?.aborted)throw new Error('Сессия остановлена.');
 const mode=executionMode(options.executionMode),autoMemory=options.autoMemory!==false&&mode!=='plan';
 const accountKey=await providers.identity(options.provider);
 let current=accountKey&&session?.sessionId&&session.accountKey===accountKey&&session.cwd===cwd?session:null;
 for(let attempt=0;attempt<2;attempt++){
  if(signal?.aborted)throw new Error('Сессия остановлена.');
  const context=await prepareContext(cwd,chat,project,memories,tasks,relatedChats,{session:current,provider:options.provider,autoMemory});
  emit({type:'context',mode:context.mode,promptChars:context.prompt.length,historyCount:context.historyCount,inlineTruncated:context.inlineTruncated,fileCount:context.files.length});
  const draft={...current,filePresentationVersion:2,provider:options.provider,deviceId:options.deviceId||'local',accountId:options.accountId||'',accountKey,cwd,executionMode:mode,autoMemory,covered:current?.covered||{},externalKey:context.externalKey,files:context.files.map(f=>({path:f.path,hash:f.hash})),updatedAt:new Date().toISOString(),inputAccepted:false};
  let started=false;
  const forward=event=>{
   if(event.type==='session'){if(draft.sessionId&&draft.sessionId!==event.sessionId)delete draft.contextUsage;draft.sessionId=event.sessionId;emit({type:'session',session:{...draft}});}
   else if(event.type==='context-usage'){
    draft.contextUsage=mergeContextUsage(draft.contextUsage,event.context);
    // Carry the snapshot in existing durable session events: offline results,
    // journal recovery and Hub acknowledgements already preserve these.
    emit({type:'session',contextOnly:true,session:{...draft}});
   }
   else if(event.type==='input-accepted'){started=true;draft.inputAccepted=true;draft.covered=context.covered;emit({type:'session',session:{...draft}});}
   else {if(event.type==='model'){if(draft.model&&draft.model!==event.model)delete draft.contextUsage;draft.model=event.model;}emit(event);}
  };
  const attachments=chat.messages.filter(m=>m.role==='user'&&!['queued','sending','received','uncertain','cancelled'].includes(m.delivery)).at(-1)?.attachments||[];
  const images=await prepareImages(cwd,attachments,emit);
  if(signal?.aborted)throw new Error('Сессия остановлена.');
  try{return {...await providers.run({...options,cwd,prompt:context.prompt,images,sessionId:current?.sessionId},forward,signal),session:draft};}
  catch(error){if(!current||started||attempt||!missingSession(error))throw error;current=null;emit({type:'notice',message:'Родная сессия недоступна. Восстанавливаю её из сохранённой памяти и истории.'});}
 }
}
