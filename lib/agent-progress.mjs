// Agent telemetry belongs to the UI. It is never part of a model prompt.
const MAX_AGENTS=32,MAX_TEXT=24000,MAX_EVENTS=80;
const statuses=new Set(['queued','running','waiting','completed','failed','stopped','unknown']);
const string=(value,max)=>typeof value==='string'?value.slice(0,max):'';
export const validAgentId=value=>typeof value==='string'&&/^[a-zA-Z0-9_.:-]{1,240}$/.test(value);
export function applyAgentEvent(message,event,at=new Date().toISOString()){
 const patch=event?.agent;if(!patch||!validAgentId(patch.id))return null;
 message.agents||=[];let agent=message.agents.find(a=>a.id===patch.id);
 if(!agent){if(message.agents.length>=MAX_AGENTS)return null;agent={id:patch.id,name:'Агент',task:'',status:'running',activity:'',text:'',events:[],startedAt:at,updatedAt:at,capabilities:{stop:false,resume:false}};message.agents.push(agent);}
 if(event.replace&&Number.isSafeInteger(patch.revision)&&patch.revision<(agent.revision||0))return null;
 for(const [key,max]of [['name',120],['task',4000],['model',120],['activity',600]])if(typeof patch[key]==='string')agent[key]=string(patch[key],max);
 if(validAgentId(patch.parentId))agent.parentId=patch.parentId;
 if(statuses.has(patch.status))agent.status=patch.status;
 if(patch.capabilities)agent.capabilities={stop:patch.capabilities.stop===true,resume:patch.capabilities.resume===true};
 const text=typeof event.text==='string'?event.text:typeof patch.text==='string'?patch.text:undefined;
 if(text!==undefined){agent.text=text.slice(-MAX_TEXT);if(text.length>MAX_TEXT)agent.textTruncated=true;}
 if(typeof event.textDelta==='string'){const combined=agent.text+event.textDelta;agent.text=combined.slice(-MAX_TEXT);if(combined.length>MAX_TEXT)agent.textTruncated=true;}
 if(event.replace&&Array.isArray(patch.events))agent.events=patch.events.filter(e=>e&&typeof e==='object').slice(-MAX_EVENTS).map(e=>({kind:string(e.kind,40),text:string(e.text,600),at:Number.isFinite(Date.parse(e.at))?e.at:at}));
 if(event.action&&typeof event.action.text==='string'){
  agent.events.push({kind:string(event.action.kind,40)||'activity',text:string(event.action.text,600),at:Number.isFinite(Date.parse(event.action.at))?event.action.at:at});
  if(agent.events.length>MAX_EVENTS){agent.events=agent.events.slice(-MAX_EVENTS);agent.eventsTruncated=true;}
 }
 if(patch.textTruncated)agent.textTruncated=true;if(patch.eventsTruncated)agent.eventsTruncated=true;
 if(event.replace&&Number.isFinite(Date.parse(patch.startedAt)))agent.startedAt=patch.startedAt;
 agent.revision=event.replace&&Number.isSafeInteger(patch.revision)?patch.revision:(agent.revision||0)+1;
 agent.updatedAt=event.replace&&Number.isFinite(Date.parse(patch.updatedAt))?patch.updatedAt:at;
 return agent;
}
export function replaceAgents(message,agents){
 if(!Array.isArray(agents))return;
 message.agents||=[];for(const agent of agents.slice(0,MAX_AGENTS))applyAgentEvent(message,{agent,replace:true});
}
export function agentSummary(agent){const {text,events,...summary}=agent;return {...summary,text:'',events:[],textChars:(text||'').length,eventCount:(events||[]).length,detailsDeferred:true};}
export function finishAgents(message,status){
 for(const agent of message.agents||[]){
  agent.capabilities={stop:false,resume:false};agent.revision=(agent.revision||0)+1;
  if(['queued','running','waiting'].includes(agent.status)){agent.status=status==='interrupted'?'stopped':'unknown';agent.activity=status==='interrupted'?'Основная сессия остановлена':'Сессия завершена; отдельный итог агента не получен';agent.updatedAt=new Date().toISOString();}
 }
}
