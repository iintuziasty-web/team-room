// Native subagent observations only. Reading/subscribing never starts a model
// turn, and private thinking blocks are deliberately excluded from the panel.
const bounded=(value,max=1000)=>typeof value==='string'?value.slice(0,max):'';
const nativeId=value=>typeof value==='string'&&value.length>0&&value.length<=256?value:null;
const terminal=new Set(['completed','failed','stopped','unknown']);
const MAX_AGENTS=32;
const state=value=>({pendingInit:'queued',pending:'queued',inProgress:'running',running:'running',interrupted:'stopped',completed:'completed',errored:'failed',failed:'failed',shutdown:'stopped',killed:'stopped',stopped:'stopped',notFound:'unknown'}[value]||'unknown');
const contentText=value=>typeof value==='string'?bounded(value,16000):Array.isArray(value)?value.filter(x=>x?.type==='text').map(x=>bounded(x.text,16000)).join('\n').slice(0,16000):'';
const toolLabel=(name,input)=>bounded([name,input?.description||input?.file_path||input?.path||input?.command||input?.query].filter(x=>typeof x==='string'&&x).join(' · '),1000);

class AgentEvents {
  constructor(emit){this.emit=emit;this.agents=new Map();this.closed=false;}
  update(id,patch={},extra={}){
    if(this.closed||!id||!this.agents.has(id)&&this.agents.size>=MAX_AGENTS)return null;
    const previous=this.agents.get(id)||{id,name:'Агент',status:'queued',capabilities:{stop:false,resume:false}};
    const next={...previous,...patch,id};this.agents.set(id,next);
    if('status'in patch&&'capabilities'in patch&&typeof this.capabilities==='function'){next.capabilities=this.capabilities(id);patch={...patch,capabilities:next.capabilities};}
    this.emit({type:'agent',agent:{id,...patch},...extra});return next;
  }
  action(id,kind,text,patch={}){return this.update(id,patch,{action:{kind,text:bounded(text,16000),at:new Date().toISOString()}});}
  dispose(){
    if(this.closed)return;
    for(const [id,agent]of this.agents)this.update(id,{capabilities:{stop:false,resume:false},...(!terminal.has(agent.status)?{status:'unknown',activity:'Подключение к этой работе завершено.'}:{})});
    this.closed=true;
  }
}

export class ClaudeAgents extends AgentEvents {
  constructor(emit,{request,isOpen}){super(emit);this.request=request;this.isOpen=isOpen;this.tools=new Map();this.tasks=new Map();this.messages=new Set();this.partial=new Map();}
  ensure(toolId,patch={}){
    const key=nativeId(toolId);if(!key)return null;
    const id=this.tools.get(key)||`claude:${key}`;
    if(!this.agents.has(id)){if(!this.update(id,{name:'Агент Claude',status:'running',capabilities:{stop:false,resume:false},...patch}))return null;}
    else if(Object.keys(patch).length)this.update(id,patch);
    this.tools.set(key,id);
    return id;
  }
  task(packet){
    const taskId=nativeId(packet.task_id);if(!taskId)return null;
    let id=this.tasks.get(taskId)||this.tools.get(packet.tool_use_id);
    if(!id){if(!['local_agent','remote_agent'].includes(packet.task_type)&&!packet.subagent_type)return null;id=this.ensure(packet.tool_use_id||taskId);}
    const agent=this.agents.get(id);if(!agent)return null;
    this.tasks.set(taskId,id);if(packet.tool_use_id)this.tools.set(packet.tool_use_id,id);
    agent.nativeTaskId=taskId;return id;
  }
  capabilities(id){const a=this.agents.get(id);return {stop:Boolean(a?.nativeTaskId&&a.background&&['running','waiting'].includes(a.status)&&this.isOpen()),resume:false};}
  observe(packet){
    if(this.closed)return;
    if(packet.type==='system'){
      if(packet.subtype==='task_started'){
        if(packet.ambient)return;const id=this.task(packet);if(!id)return;
        this.agents.get(id).background=packet.is_backgrounded===true;
        this.update(id,{name:bounded(packet.subagent_type||packet.description,160)||'Агент Claude',task:bounded(packet.prompt||packet.description,4000),status:'running',activity:'Начал работу'});
        this.update(id,{capabilities:this.capabilities(id)});this.action(id,'started',packet.description||'Агент запущен');
      }else if(packet.subtype==='background_tasks_changed'){
        // This level frame can precede task_started and has no tool-use ID.
        // Wait for that bookend to avoid creating a second card for one agent.
        for(const task of packet.tasks||[]){if(task.ambient||!['local_agent','remote_agent'].includes(task.task_type))continue;const id=this.tasks.get(task.task_id);if(!id)continue;this.agents.get(id).background=true;this.update(id,{status:'running',activity:'Работает в фоне',capabilities:this.capabilities(id)});}
      }else if(packet.subtype==='task_progress'){
        const id=this.task(packet);if(!id)return;
        const activity=bounded(packet.summary||packet.last_tool_name||packet.description,1000);
        this.update(id,{status:'running',activity,...(packet.subagent_type?{name:bounded(packet.subagent_type,160)}:{}),capabilities:this.capabilities(id)});
        if(activity&&activity!==this.agents.get(id).lastProgress){this.agents.get(id).lastProgress=activity;this.action(id,'progress',activity);}
      }else if(packet.subtype==='task_updated'){
        const id=this.tasks.get(packet.task_id);if(!id)return;const patch=packet.patch||{},agent=this.agents.get(id);
        if(typeof patch.is_backgrounded==='boolean')agent.background=patch.is_backgrounded;
        if(patch.status)agent.status=state(patch.status);
        this.update(id,{...(patch.status?{status:agent.status}:{}),...(patch.description?{task:bounded(patch.description,4000)}:{}),...(patch.error?{activity:bounded(patch.error,1000)}:{}),capabilities:this.capabilities(id)});
      }else if(packet.subtype==='task_notification'){
        const id=this.tasks.get(packet.task_id)||this.tools.get(packet.tool_use_id);if(!id)return;
        this.action(id,'result',packet.summary||'Работа завершена',{status:state(packet.status),activity:bounded(packet.summary,1000),capabilities:{stop:false,resume:false}});
      }
      return;
    }
    const parent=nativeId(packet.parent_tool_use_id);
    if(packet.type==='assistant'){
      const owner=parent?this.ensure(parent):null;
      if(owner&&packet.message?.model)this.update(owner,{model:bounded(packet.message.model,120)});
      for(const block of packet.message?.content||[]){
        if(block.type==='tool_use'){
          if(['Agent','Task'].includes(block.name)){
            const id=this.ensure(block.id,{name:bounded(block.input?.name||block.input?.description||block.input?.subagent_type,160)||'Агент Claude',task:bounded(block.input?.prompt,4000),parentId:owner,status:'running',...(block.input?.model?{model:bounded(block.input.model,120)}:{})});
            if(id)this.action(id,'started',block.input?.description||'Запускаю агента');
          }else if(owner)this.action(owner,'tool',toolLabel(block.name,block.input),{status:'running',activity:toolLabel(block.name,block.input)});
        }else if(block.type==='text'&&owner){
          const key=`${packet.uuid||packet.message?.id||''}:${bounded(block.text,16000)}`;
          if(this.messages.has(key))continue;this.messages.add(key);if(this.messages.size>1000)this.messages.delete(this.messages.values().next().value);
          const text=bounded(block.text,16000),partial=this.partial.get(owner)||'';
          this.partial.delete(owner);const delta=text.startsWith(partial)?text.slice(partial.length):text;
          if(delta)this.update(owner,{status:'running',activity:'Пишет ответ'},{textDelta:delta+(text.endsWith('\n')?'':'\n')});
        }
      }
    }else if(packet.type==='stream_event'&&parent){
      // Current SDK only streams main-session tokens, but keep the attribution
      // guard for CLI versions that also forward explicitly tagged child tokens.
      const id=this.ensure(parent),delta=packet.event?.delta;if(!id)return;
      if(delta?.type==='text_delta'){const value=bounded(delta.text,16000);this.partial.set(id,((this.partial.get(id)||'')+value).slice(-16000));this.update(id,{status:'running',activity:'Пишет ответ'},{textDelta:value});}
    }else if(packet.type==='user'){
      const owner=parent?this.ensure(parent):null;
      for(const block of Array.isArray(packet.message?.content)?packet.message.content:[]){
        if(block.type!=='tool_result')continue;
        const child=this.tools.get(block.tool_use_id),summary=contentText(block.content);
        if(child){
          const a=this.agents.get(child),background=a?.background||/agentId:|task_id|running in the background/i.test(summary);
          if(!background)this.action(child,'result',summary||'Работа завершена',{status:block.is_error?'failed':'completed',activity:block.is_error?'Ошибка':'Завершил работу',capabilities:{stop:false,resume:false}});
        }
        if(owner)this.action(owner,'tool-result',summary||'Действие завершено',{activity:block.is_error?'Ошибка действия':'Действие завершено'});
      }
    }else if(packet.type==='tool_progress'&&parent){
      const id=this.ensure(parent),retry=packet.subagent_retry;if(!id)return;
      this.update(id,{status:retry?'waiting':'running',activity:retry?'Восстанавливает связь…':bounded(packet.tool_name,200)||'Выполняет действие',capabilities:this.capabilities(id)});
    }
  }
  async control(id,action){
    const agent=this.agents.get(id);if(!agent||!this.isOpen()||this.closed)throw new Error('Этот агент сейчас недоступен.');
    if(action!=='stop'||!this.capabilities(id).stop)throw new Error(action==='resume'?'Claude Code не предоставляет прямое продолжение этого агента.':'Агент уже завершён или не поддерживает отдельную остановку.');
    await this.request('stop_task',{task_id:agent.nativeTaskId},30000);
    this.action(id,'control','Остановлен пользователем',{status:'stopped',activity:'Остановлен',capabilities:{stop:false,resume:false}});
    return {accepted:true,status:'stopped'};
  }
}

export class CodexAgents extends AgentEvents {
  constructor(emit,{transport,rootThreadId,isOpen,approval,onActivity}){super(emit);this.transport=transport;this.root=rootThreadId;this.isOpen=isOpen;this.approval=approval;this.onActivity=onActivity;this.subscriptions=new Map();this.messages=new Map();this.controlLocks=new Set();this.observer=packet=>{try{this.observe(packet);}catch{/* A malformed optional observation cannot stop the native parent turn. */}};transport.agentObservers||=new Set();transport.agentObservers.add(this.observer);}
  key(threadId){return nativeId(threadId)?`codex:${threadId}`:null;}
  known(threadId){return threadId===this.root||this.agents.has(this.key(threadId));}
  capabilities(id){const a=this.agents.get(id),live=this.isOpen()&&!this.closed;return {stop:Boolean(live&&a?.turnId&&['running','waiting'].includes(a.status)),resume:Boolean(live&&a?.directInput===true&&a.status==='stopped')};}
  ensure(threadId,patch={}){
    const id=this.key(threadId);if(!id||threadId===this.root)return null;
    const first=!this.agents.has(id);if(first){if(!this.update(id,{name:'Агент Codex',status:'queued',capabilities:{stop:false,resume:false},...patch}))return null;}else if(Object.keys(patch).length)this.update(id,patch);
    if(first)void this.subscribe(threadId);return id;
  }
  metadata(thread){
    const id=this.key(thread?.id);if(!this.agents.has(id))return;
    const a=this.agents.get(id);a.directInput=thread.canAcceptDirectInput===true;
    const parent=thread.parentThreadId||thread.source?.subAgent?.thread_spawn?.parent_thread_id;
    this.update(id,{...(thread.agentNickname||thread.name||thread.agentRole?{name:bounded(thread.agentNickname||thread.name||thread.agentRole,160)}:{}),...(thread.model?{model:bounded(thread.model,120)}:{}),...(parent?{parentId:parent===this.root?null:this.key(parent)}:{}),...(thread.preview&&!a.task?{task:bounded(thread.preview,4000)}:{}),capabilities:this.capabilities(id)});
    this.threadStatus(thread.id,thread.status);
  }
  async subscribe(threadId){
    if(this.subscriptions.has(threadId))return this.subscriptions.get(threadId);
    const pending=(async()=>{
      try{
        // Rejoin without history hydration or inference. Read one recent turn
        // to recover its ID if it started before our spawn notification arrived.
        const r=await this.transport.request('thread/resume',{threadId,excludeTurns:true,initialTurnsPage:{limit:1,itemsView:'summary'}},15000);
        if(this.closed||!this.isOpen())return;this.metadata(r.thread);
        const turns=r.initialTurnsPage?.data||r.thread?.turns||[];
        for(const turn of turns)if(turn.status==='inProgress'){const id=this.key(threadId),a=this.agents.get(id);if(!a||terminal.has(a.status))continue;a.turnId=turn.id;this.update(id,{status:'running',capabilities:this.capabilities(id)});}
        // A bounded recent page provides useful output already produced before
        // the panel subscribed. Dedupe it with live item/delta notifications.
        try{const page=await this.transport.request('thread/items/list',{threadId,limit:30,sortDirection:'desc'},15000);if(!this.closed)for(const entry of [...(page.data||[])].reverse())this.item(threadId,entry.item||entry,'completed');}catch{}
      }catch(error){if(!this.closed)this.update(this.key(threadId),{activity:bounded(`Прогресс пока недоступен: ${error.message}`,1000),capabilities:{stop:false,resume:false}});}
    })();this.subscriptions.set(threadId,pending);return pending;
  }
  collab(item){
    if(!this.known(item.senderThreadId))return;
    const parent=item.senderThreadId===this.root?null:this.key(item.senderThreadId);
    for(const threadId of new Set([...(item.receiverThreadIds||[]),...Object.keys(item.agentsStates||{})])){
      const id=this.ensure(threadId,{...(item.tool==='spawnAgent'?{parentId:parent,...(item.prompt?{task:bounded(item.prompt,4000)}:{}),...(item.model?{model:bounded(item.model,120)}:{})}:{} )});if(!id)continue;
      const reported=item.agentsStates?.[threadId];
      if(reported)this.update(id,{status:state(reported.status),...(reported.message?{activity:bounded(reported.message,1000)}:{})});
      else if(item.tool==='spawnAgent')this.update(id,{status:item.status==='failed'?'failed':item.status==='inProgress'?'queued':'running',activity:'Запущен родительским агентом'});
      this.update(id,{capabilities:this.capabilities(id)});
      if(item.status!=='inProgress'&&['sendInput','sendMessage','followupTask','interruptAgent','resumeAgent','closeAgent'].includes(item.tool))this.action(id,'coordination',item.prompt||item.tool);
      if(reported?.message&&!this.agents.get(id).hasText)this.message(id,`collab:${item.id}:${threadId}`,reported.message,true);
    }
  }
  threadStatus(threadId,status){
    const id=this.key(threadId),a=this.agents.get(id);if(!a||!status)return;
    const type=status.type;
    if(type==='active'&&!terminal.has(a.status)){const waiting=status.activeFlags?.some(x=>['waitingOnApproval','waitingOnUserInput'].includes(x));this.update(id,{status:waiting?'waiting':'running',activity:waiting?'Ждёт ответа или разрешения':'Работает'});}
    else if(type==='systemError')this.update(id,{status:'failed',activity:'Ошибка подключения'});
    else if(type==='notLoaded')this.update(id,{capabilities:{stop:false,resume:false}});
    // idle can be delivered between interruption and turn/completed; the turn
    // completion carries the authoritative stopped/completed distinction.
    this.update(id,{capabilities:this.capabilities(id)});
  }
  message(id,itemId,value,complete=false){
    const key=`${id}:${itemId}`,previous=this.messages.get(key)||'';let delta=bounded(value,16000);
    if(complete){if(delta.startsWith(previous))delta=delta.slice(previous.length);else if(previous)return;this.messages.set(key,bounded(value,16000));}
    else this.messages.set(key,(previous+delta).slice(0,16000));
    if(this.messages.size>2000)this.messages.delete(this.messages.keys().next().value);
    if(delta){const a=this.agents.get(id);if(!a)return;if(!a.hasText)a.hasText=true;this.update(id,{activity:'Пишет ответ'},{textDelta:delta});}
  }
  item(threadId,item,phase){
    if(item?.type==='collabAgentToolCall'){this.collab(item);return;}
    if(item?.type==='subAgentActivity'){
      const id=this.ensure(item.agentThreadId,{parentId:threadId===this.root?null:this.key(threadId),name:bounded(item.agentPath,160)||'Агент Codex'});if(id){const s={started:'running',interrupted:'stopped',completed:'completed'}[item.kind];this.update(id,{...(s?{status:s}:{}),activity:bounded(item.kind,100),capabilities:this.capabilities(id)});}return;
    }
    const id=this.key(threadId);if(!this.agents.has(id)||!item)return;
    if(item.type==='agentMessage'&&phase==='completed'){this.message(id,item.id,item.text||'',true);return;}
    if(!['commandExecution','mcpToolCall','dynamicToolCall','fileChange','webSearch','imageGeneration'].includes(item.type))return;
    const label=toolLabel(item.type,item.type==='commandExecution'?{command:item.command}:item.type==='mcpToolCall'?{description:`${item.server||''} ${item.tool||''}`}:{description:item.changes?.map(x=>x.path).filter(Boolean).join(', ')});
    const key=`tool:${id}:${item.id}:${phase}`;if(this.messages.has(key))return;this.messages.set(key,'seen');
    this.action(id,phase==='started'?'tool':'tool-result',label,{activity:phase==='started'?label:item.status==='failed'?'Ошибка действия':'Действие завершено'});
  }
  observe(packet){
    if(this.closed||!this.isOpen()||packet.type==='transport-error')return;
    const p=packet.params||{},threadId=p.threadId||p.thread?.id;
    if(packet.method==='thread/started'){
      const parent=p.thread?.parentThreadId||p.thread?.source?.subAgent?.thread_spawn?.parent_thread_id;
      if(parent&&this.known(parent)){const id=this.ensure(p.thread.id,{parentId:parent===this.root?null:this.key(parent)});if(id)this.metadata(p.thread);}return;
    }
    if(!this.known(threadId))return;
    if(threadId===this.root){if(['item/started','item/completed'].includes(packet.method))this.item(threadId,p.item,packet.method==='item/started'?'started':'completed');return;}
    this.onActivity?.();const id=this.key(threadId),a=this.agents.get(id);
    if(packet.method==='item/agentMessage/delta')this.message(id,p.itemId,p.delta||'');
    else if(['item/started','item/completed'].includes(packet.method))this.item(threadId,p.item,packet.method==='item/started'?'started':'completed');
    else if(packet.method==='thread/status/changed')this.threadStatus(threadId,p.status);
    else if(packet.method==='turn/started'){a.turnId=p.turn?.id||p.turnId;this.update(id,{status:'running',activity:'Работает',capabilities:this.capabilities(id)});}
    else if(packet.method==='turn/completed'){a.turnId=null;this.update(id,{status:state(p.turn?.status),activity:p.turn?.status==='completed'?'Завершил работу':bounded(p.turn?.error?.message,1000)||'Остановлен',capabilities:this.capabilities(id)});this.update(id,{capabilities:this.capabilities(id)});}
    else if(packet.method==='thread/closed')this.update(id,{status:'stopped',activity:'Агент закрыт',capabilities:{stop:false,resume:false}});
    else if(packet.method==='error')this.action(id,'error',p.error?.message||p.message||'Ошибка агента');
    else if(packet.id!==undefined&&packet.method){this.update(id,{status:'waiting',activity:'Ждёт ответа или разрешения'});this.approval(packet,id);}
  }
  async control(id,action){
    const a=this.agents.get(id);if(!a||!this.isOpen()||this.closed)throw new Error('Этот агент сейчас недоступен.');
    if(this.controlLocks.has(id))throw new Error('Действие с этим агентом уже выполняется.');
    if(!this.capabilities(id)[action]||!['stop','resume'].includes(action))throw new Error('Этот агент не поддерживает выбранное действие в текущем состоянии.');
    this.controlLocks.add(id);const threadId=id.slice('codex:'.length);
    try{
      if(action==='stop'){await this.transport.request('turn/interrupt',{threadId,turnId:a.turnId},15000);this.action(id,'control','Запрошена остановка агента',{activity:'Останавливается…',capabilities:{stop:false,resume:false}});return {accepted:true,status:'stopping'};}
      // Only this existing child receives the continuation. Settings and native
      // history stay intact; the parent's turn is not stopped or replayed.
      const r=await this.transport.request('thread/resume',{threadId,excludeTurns:true},15000);this.metadata(r.thread);
      if(!this.isOpen()||this.closed)throw new Error('Подключение к этой работе уже завершено.');
      if(r.thread?.canAcceptDirectInput!==true||r.thread?.status?.type==='active')throw new Error('Codex пока не разрешает прямое продолжение этого агента.');
      const turn=await this.transport.request('turn/start',{threadId,input:[{type:'text',text:'Продолжи свою ранее прерванную задачу с текущего места. Проверь уже выполненные действия и сохрани результат.'}]},30000);
      a.turnId=turn.turn.id;this.action(id,'control','Продолжен пользователем',{status:'running',activity:'Продолжает работу',capabilities:this.capabilities(id)});this.update(id,{capabilities:this.capabilities(id)});return {accepted:true,status:'running'};
    }finally{this.controlLocks.delete(id);}
  }
  dispose(){this.transport.agentObservers?.delete(this.observer);super.dispose();}
}
