const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export class SplitSessionPicker{
 constructor({getData,showDialog,closeDialog,onSelect}){Object.assign(this,{getData,showDialog,closeDialog,onSelect});this.destination='right';}
 open(destination='right'){
  const data=this.getData();if(!data?.userId)return;this.destination=destination;
  this.showDialog(destination==='right'?'Открыть справа':'Выбрать сессию',`<div class="split-picker-controls"><label>Проект<select id="split-picker-project"><option value="">Все проекты</option>${data.projects.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label><input id="split-picker-search" type="search" placeholder="Найти сессию…" aria-label="Поиск сессий"></div><div id="split-picker-list" class="split-picker-list"></div><button id="split-picker-new" class="split-picker-new" type="button">＋ Новый чат в проекте</button>`);
  const root=document.querySelector('#dialog');root.classList.add('split-picker-dialog');
  this.root=root;root.querySelector('#split-picker-project').onchange=()=>this.render();root.querySelector('#split-picker-search').oninput=()=>this.render();
  root.querySelector('#split-picker-new').onclick=()=>{const fresh=this.getData(),projectId=root.querySelector('#split-picker-project').value||fresh.projectId;if(fresh.projects.some(p=>p.id===projectId))this.select({projectId,chatId:''});};
  this.render();root.querySelector('#split-picker-search').focus({preventScroll:true});
 }
 render(){
  if(!this.root?.open)return;const data=this.getData(),project=this.root.querySelector('#split-picker-project').value,query=this.root.querySelector('#split-picker-search').value.trim().toLocaleLowerCase();
  const projects=new Map(data.projects.map(p=>[p.id,p.name])),chats=data.chats.filter(c=>!c.archivedAt&&(!project||c.projectId===project)&&(!query||(c.title+' '+projects.get(c.projectId)).toLocaleLowerCase().includes(query)));
  const list=this.root.querySelector('#split-picker-list');list.replaceChildren();
  for(const chat of chats){
   const button=document.createElement('button');button.type='button';button.className='split-picker-session';button.dataset.chatId=chat.id;
   button.innerHTML=`<span class="split-picker-session-copy"><strong>${esc(chat.title||'Без названия')}</strong><small>${esc([projects.get(chat.projectId),chat.deviceName,chat.run?'Работает '+(chat.run.provider==='claude'?'Claude':'Codex'):''].filter(Boolean).join(' · '))}</small></span><span aria-hidden="true">›</span>`;
   button.onclick=()=>this.select({projectId:chat.projectId,chatId:chat.id});list.append(button);
  }
  if(!chats.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='Подходящих сессий нет.';list.append(empty);}
  const activeProject=data.projects.find(p=>p.id===(project||data.projectId));this.root.querySelector('#split-picker-new').textContent='＋ Новый чат'+(activeProject?' · '+activeProject.name:'');
 }
 select(target){this.closeDialog();this.onSelect(target,this.destination);}
}
