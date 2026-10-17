import {TITLE_VERSION,initializeTitle,hasTitleContext,titlePrompt,normalizeTitle,applyAutomaticTitle} from './chat-titles.mjs';

// One small naming request per new conversation; never replays its native session.
export class TitleQueue {
 constructor({chats,project,choose,run,idle,persist,changed}) {
  Object.assign(this,{chats,project,choose,run,idle,persist,changed});
  this.queue=new Set();this.busy=false;this.closed=false;this.retryAt=0;
  this.timer=setInterval(()=>void this.drain(),15000);this.timer.unref();
 }
 enqueue(chat) {
  if(this.closed||!chat)return;
  initializeTitle(chat);
  if(chat.titleSource!=='auto'||chat.titleMeta.version>=TITLE_VERSION||!hasTitleContext(chat))return;
  if((chat.titleMeta.attempts||0)>=3)return;
  this.queue.add(chat.id);void this.drain();
 }
 async drain() {
  if(this.closed||this.busy||!this.queue.size||Date.now()<this.retryAt||!this.idle())return;
  const byId=new Map(this.chats().map(chat=>[chat.id,chat]));
  for(const chatId of this.queue){const current=byId.get(chatId);if(!current||current.titleSource!=='auto'||current.titleMeta?.version>=TITLE_VERSION||(current.titleMeta?.attempts||0)>=3)this.queue.delete(chatId);}
  const chat=[...this.queue].map(id=>byId.get(id)).find(c=>c&&!c.run&&!c.importSource?.active&&this.idle(c));
  if(!chat)return;
  this.busy=true;
  try {
   if(chat.titleSource!=='auto'||chat.titleMeta?.version>=TITLE_VERSION){this.queue.delete(chat.id);return;}
   const expectedTitle=chat.title,selection=await this.choose(chat);
   if(!selection){this.queue.delete(chat.id);this.queue.add(chat.id);this.retryAt=Date.now()+15000;return;}
   if(this.closed||!this.idle(chat,selection)||!this.chats().includes(chat)||chat.titleSource!=='auto'||chat.title!==expectedTitle)return;
   const attempts=chat.titleMeta.attempts||0;
   chat.titleMeta={...chat.titleMeta,status:'generating',attempts:attempts+1};
   await this.persist();
   // Disk persistence can yield while the user starts work, renames/removes
   // the chat or closes the queue. Never spend a naming request in that race.
   if(this.closed||!this.chats().includes(chat)||chat.titleSource!=='auto'||chat.title!==expectedTitle||chat.run||chat.importSource?.active||!this.idle(chat,selection)){
    if(this.chats().includes(chat)&&chat.titleSource==='auto'&&chat.titleMeta?.version<TITLE_VERSION){chat.titleMeta={...chat.titleMeta,status:'pending',attempts};await this.persist();}
    return;
   }
   // Only compact conversation samples go to a fresh, read-only metadata task.
   const response=await this.run(selection,titlePrompt(chat,this.project(chat.projectId)));
   if(this.closed||!this.chats().includes(chat))return;
   const raw=String(response?.text||'').trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');
   const first=raw.indexOf('{'),last=raw.lastIndexOf('}');
   const value=first>=0&&last>=first?JSON.parse(raw.slice(first,last+1)).title:raw;
   const title=normalizeTitle(value);
   if(!title)throw new Error('Название пока не удалось определить.');
   if(applyAutomaticTitle(chat,title,{expectedTitle,origin:'model'})){
    this.queue.delete(chat.id);await this.persist();this.changed(chat);
   }else this.queue.delete(chat.id);
  }catch {
   if(!this.closed&&this.chats().includes(chat)&&chat.titleSource==='auto'&&chat.titleMeta?.version<TITLE_VERSION){
    chat.titleMeta={...chat.titleMeta,status:'pending'};
    if((chat.titleMeta.attempts||0)>=3)this.queue.delete(chat.id);
    this.retryAt=Date.now()+120000;
    await this.persist().catch(()=>{});
   }
  }finally{this.busy=false;if(!this.closed&&this.queue.size&&Date.now()>=this.retryAt){const timer=setTimeout(()=>void this.drain(),2500);timer.unref();}}
 }
 close(){this.closed=true;clearInterval(this.timer);this.queue.clear();}
}
