import {agentSummary} from './agent-progress.mjs';
import {sessionContexts} from './session-context.mjs';
const compactMessage=message=>({...message,...(message.agents?{agents:message.agents.map(agentSummary)}:{}),actions:(message.actions||[]).map(action=>({tool:action.tool,status:action.status})),actionsDeferred:Boolean(message.actions?.length)});
// UI projection only: the original messages, tool results and provider sessions
// remain authoritative for memory, exports and continuation.
export function compactChat(chat,{limit,before,around}={}){
 const fields=['id','revision','title','projectId','owner','provider','executionDeviceId','createdAt','updatedAt','archivedAt','route','pendingRoute','files','run','approvals','importSource','memory','context','queueNotice','syncWarning','fileAliases','kind','fork','completion'];
 const view=Object.fromEntries(fields.filter(k=>chat[k]!==undefined).map(k=>[k,chat[k]]));
 if(view.importSource){const {fileHashes,...source}=view.importSource;view.importSource=source;}
 if(view.memory){const {sourceKeys,...memory}=view.memory;view.memory=memory;}
 view.providerSessions=Object.fromEntries(Object.entries(chat.providerSessions||{}).map(([key,value])=>[key,{cwd:value.cwd}]));
 view.sessionContexts=sessionContexts(chat);
 const aroundIndex=around==null?-1:chat.messages.findIndex(m=>m.id===around);
 if(around!=null&&aroundIndex<0)throw Object.assign(new Error('Сообщение не найдено в этой сессии.'),{status:404});
 if(around!=null)limit=limit??80;
 const end=aroundIndex>=0?Math.min(chat.messages.length,Math.max(limit,aroundIndex+Math.ceil(limit/2))):before==null?chat.messages.length:Math.max(0,Math.min(chat.messages.length,before));
 const start=limit==null?0:Math.max(0,end-limit);
 if(limit!=null)view.history={start,end,total:chat.messages.length,hasEarlier:start>0,hasLater:end<chat.messages.length,...(aroundIndex>=0?{aroundMessageId:around,aroundIndex}:{})};
 const messages=chat.messages.slice(start,end);
 view.messages=messages.map(compactMessage);
 // A live native turn can outlast a history page. The aggregate assistant
 // remains in canonical history, while these view-only references let the UI
 // place its continuation below a followup whose anchor is on this page.
 const needed=new Set(messages.filter(m=>m.role==='user'&&m.followup&&m.afterRunId).map(m=>m.afterRunId));
 for(const m of messages)if(m.role==='assistant'&&m.runId)needed.delete(m.runId);
 view.replyReferences=[];
 for(let index=start-1;index>=0&&needed.size;index--){const message=chat.messages[index];if(message.role==='assistant'&&needed.has(message.runId)){view.replyReferences.push(compactMessage(message));needed.delete(message.runId);}}
 view.replyReferences.reverse();
 return view;
}

export function actionView(chat,messageId){
 const message=chat.messages.find(m=>m.id===messageId);
 return message?{messageId:message.id,actions:message.actions||[]}:null;
}
