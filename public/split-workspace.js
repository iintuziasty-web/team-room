const dividerIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>';
const closeIcon='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';

export class SplitWorkspace {
 constructor({getContext,chooseChat,notice,onAuthExpired,onNeedsRefresh}={}) {
  this.getContext=getContext||(()=>({}));this.chooseChat=chooseChat;this.notice=notice;this.onAuthExpired=onAuthExpired;this.onNeedsRefresh=onNeedsRefresh;
  this.enabled=false;this.ratio=.5;this.userId='';this.rightProjectId='';this.rightChatId='';this.sidebarCollapsed=false;
  this.handleResize=()=>{this.endSessionDrag();if(this.enabled&&!this.frame&&window.innerWidth>1000)this.update();else this.render();};this.handleMessage=event=>this.receiveMessage(event);
  this.handleDragCancel=event=>{if(event.type!=='keydown'||event.key==='Escape')this.endSessionDrag();};
 }
 mount() {
  if(this.root)return this.update();
  const app=document.getElementById('app');if(!app)return this;
  this.app=app;this.root=document.createElement('div');this.root.className='workspace-root';
  app.parentNode.insertBefore(this.root,app);this.root.append(app);
  this.divider=document.createElement('div');this.divider.className='split-divider';this.divider.tabIndex=0;
  this.divider.setAttribute('role','separator');this.divider.setAttribute('aria-orientation','vertical');this.divider.setAttribute('aria-label','Ширина сессий');
  this.divider.setAttribute('aria-controls','app split-right-pane');
  this.host=document.createElement('section');this.host.className='split-pane';this.host.id='split-right-pane';this.host.setAttribute('aria-label','Правая сессия');
  const head=document.createElement('div');head.className='split-pane-head';
  this.picker=document.createElement('button');this.picker.type='button';this.picker.className='split-pane-picker';this.picker.setAttribute('aria-haspopup','dialog');
  this.picker.onclick=()=>this.chooseChat?.();
  const close=document.createElement('button');close.type='button';close.className='split-pane-close';close.innerHTML=closeIcon;
  close.title='Закрыть правую панель';close.setAttribute('aria-label','Закрыть правую панель');close.onclick=()=>this.close();
  head.append(this.picker,close);this.host.append(head);this.root.append(this.divider,this.host);
  this.divider.addEventListener('pointerdown',event=>this.startResize(event));
  this.divider.addEventListener('pointermove',event=>this.moveResize(event));
  this.divider.addEventListener('pointerup',()=>this.stopResize());
  this.divider.addEventListener('pointercancel',()=>this.stopResize());
  this.divider.addEventListener('lostpointercapture',()=>this.stopResize());
  this.divider.addEventListener('keydown',event=>this.resizeWithKeys(event));
  window.addEventListener('resize',this.handleResize);window.addEventListener('message',this.handleMessage);
  window.addEventListener('blur',this.handleDragCancel);window.addEventListener('dragend',this.handleDragCancel);window.addEventListener('keydown',this.handleDragCancel);
  if(window.ResizeObserver){this.observer=new ResizeObserver(this.handleResize);this.observer.observe(this.root);}
  return this.update();
 }
 update() {
  if(!this.root)return this;
  const context=this.getContext()||{};
  if(!context.userId){this.close();return this;}
  if(this.userId!==context.userId){
   this.endSessionDrag();this.frame?.remove();this.frame=null;this.frameTarget=null;this.userId=context.userId;this.load();
  }
  this.sidebarCollapsed=Boolean(context.sidebarCollapsed);
  const projects=context.projects||[],chats=context.chats||[];
  if(this.pendingView&&this.knownView(this.pendingView,context))this.acceptView(this.pendingView);
  const selected=chats.find(chat=>chat.id===this.rightChatId);
  if(selected)this.rightProjectId=selected.projectId;
  else if(this.rightChatId&&!this.frame){this.rightChatId='';}
  if(this.enabled&&!this.frame&&!this.hasSavedView){const initial=this.defaultTarget(context);this.rightChatId=initial.chatId;this.rightProjectId=initial.projectId;}
  if(!this.frame&&!projects.some(project=>project.id===this.rightProjectId))this.rightProjectId=context.projectId||projects[0]?.id||'';
  if(this.enabled&&!this.frame&&window.innerWidth>1000){
   if(!this.rightChatId&&!this.rightProjectId){const target=this.defaultTarget(context);this.rightChatId=target.chatId;this.rightProjectId=target.projectId;}
   this.loadFrame();
  }
  this.render();return this;
 }
 toggle() {
  if(this.enabled){this.close();return;}
  this.open();
 }
 open(target) {
  if(!this.root)this.mount();
  const context=this.getContext()||{};if(!context.userId||!this.root)return;
  if(window.innerWidth<=1000){this.notice?.('Две сессии доступны в широком окне.');return;}
  if(context.userId!==this.userId)this.update();
  if(target){
   const selected=(context.chats||[]).find(chat=>chat.id===target.chatId);
   if(target.chatId&&!selected){this.notice?.('Эта сессия больше недоступна.');return;}
   const project=selected?.projectId||target.projectId||context.projectId;
   if(!(context.projects||[]).some(item=>item.id===project)){this.notice?.('Этот проект больше недоступен.');return;}
   this.pendingView=null;this.refreshRequested=false;this.rightChatId=selected?.id||'';this.rightProjectId=project;
  }else if(!this.frame&&!this.hasSavedView){
   const initial=this.defaultTarget(context);this.rightChatId=initial.chatId;this.rightProjectId=initial.projectId;
  }
  this.enabled=true;this.hasSavedView=true;this.loadFrame();this.save();this.render();
 }
 close() {
  this.endSessionDrag();this.enabled=false;this.stopResize();this.save();this.render();
 }
 setSidebarCollapsed(collapsed) {
  this.sidebarCollapsed=Boolean(collapsed);this.render();
 }
 destroy() {
  if(!this.root)return;
  this.endSessionDrag();this.stopResize();this.observer?.disconnect();window.removeEventListener('resize',this.handleResize);window.removeEventListener('message',this.handleMessage);
  window.removeEventListener('blur',this.handleDragCancel);window.removeEventListener('dragend',this.handleDragCancel);window.removeEventListener('keydown',this.handleDragCancel);
  this.root.parentNode?.insertBefore(this.app,this.root);this.root.remove();
  this.root=null;this.host=null;this.frame=null;this.frameTarget=null;this.divider=null;this.picker=null;this.userId='';this.pendingView=null;this.refreshRequested=false;
 }
 beginSessionDrag(chatId) {
  this.endSessionDrag();const context=this.getContext()||{};
  const chat=(context.chats||[]).find(item=>item.id===chatId);
  if(!this.root||window.innerWidth<=1000||!context.userId||context.userId!==this.userId||!chat||!(context.projects||[]).some(project=>project.id===chat.projectId))return false;
  this.draggedSessionId=chatId;this.dropOverlay=document.createElement('div');this.dropOverlay.className='split-session-drop';this.dropOverlay.setAttribute('aria-hidden','true');
  const caption=document.createElement('span');caption.textContent='Открыть справа';this.dropOverlay.append(caption);this.root.append(this.dropOverlay);
  return Boolean(this.paintSessionDrop());
 }
 paintSessionDrop() {
  if(!this.draggedSessionId||!this.root||!this.dropOverlay)return null;
  const context=this.getContext()||{};
  if(window.innerWidth<=1000||context.userId!==this.userId||!(context.chats||[]).some(chat=>chat.id===this.draggedSessionId)){this.endSessionDrag();return null;}
  const target=this.root.classList.contains('is-split')?this.host:this.app.querySelector('.main');
  if(!target){this.endSessionDrag();return null;}
  const root=this.root.getBoundingClientRect(),bounds=target.getBoundingClientRect(),split=this.root.classList.contains('is-split');
  const left=bounds.left+(split?0:bounds.width/2),width=split?bounds.width:bounds.width/2;
  if(width<=0||bounds.height<=0){this.endSessionDrag();return null;}
  this.dropBounds={left,right:left+width,top:bounds.top,bottom:bounds.bottom};
  Object.assign(this.dropOverlay.style,{left:(left-root.left)+'px',top:(bounds.top-root.top)+'px',width:width+'px',height:bounds.height+'px'});
  return this.dropBounds;
 }
 updateSessionDrag(clientX,clientY) {
  const bounds=this.paintSessionDrop(),inside=Boolean(bounds&&Number.isFinite(clientX)&&Number.isFinite(clientY)&&clientX>=bounds.left&&clientX<=bounds.right&&clientY>=bounds.top&&clientY<=bounds.bottom);
  this.dropOverlay?.classList.toggle('is-active',inside);return inside;
 }
 endSessionDrag() {
  this.dropOverlay?.remove();this.dropOverlay=null;this.dropBounds=null;this.draggedSessionId='';
 }
 openDroppedSession(chatId) {
  this.endSessionDrag();const context=this.getContext()||{},chat=(context.chats||[]).find(item=>item.id===chatId);
  if(window.innerWidth<=1000||!context.userId||!chat||!(context.projects||[]).some(project=>project.id===chat.projectId))return false;
  this.open({projectId:chat.projectId,chatId:chat.id});return this.enabled&&this.rightChatId===chat.id;
 }
 defaultTarget(context) {
  const candidates=(context.chats||[]).filter(chat=>chat.id!==context.chatId&&!chat.archivedAt);
  const selected=candidates.find(chat=>chat.projectId!==context.projectId)||candidates[0];
  const project=(context.projects||[]).find(item=>item.id!==context.projectId);
  return {chatId:selected?.id||'',projectId:selected?.projectId||project?.id||context.projectId||(context.projects||[])[0]?.id||''};
 }
 loadFrame() {
  if(!this.host)return;
  const view=this.pendingView||{projectId:this.rightProjectId,chatId:this.rightChatId},target=view.projectId+'\n'+view.chatId;
  if(this.frame&&this.frameTarget===target)return;
  if(!this.frame){
   this.frame=document.createElement('iframe');this.frame.className='split-pane-frame';this.frame.name='teamroom-right-pane';
   this.frame.title='Правая сессия';this.frame.referrerPolicy='same-origin';this.host.append(this.frame);
   this.frame.onload=()=>{this.frameVisibility=null;this.syncFrameVisibility();};
  }
  const url=new URL('/room/pane',location.origin);url.searchParams.set('pane','right');url.searchParams.set('project',view.projectId);url.searchParams.set('chat',view.chatId);
  this.frameTarget=target;this.frame.src=url.href;
 }
 receiveMessage(event) {
  if(event.origin!==location.origin||!this.frame||event.source!==this.frame.contentWindow)return;
  const data=event.data;if(!data||typeof data!=='object'||Array.isArray(data))return;
  if(data.type==='teamroom:pane-auth-expired'){
   this.close();this.frame.remove();this.frame=null;this.frameTarget=null;this.pendingView=null;this.refreshRequested=false;this.onAuthExpired?.();return;
  }
  if(data.type!=='teamroom:pane-view'||typeof data.projectId!=='string'||typeof data.chatId!=='string'||data.projectId.length>240||data.chatId.length>240)return;
  const context=this.getContext()||{};if(context.userId!==this.userId)return;
  if(!/^[a-zA-Z0-9_-]{1,240}$/.test(data.projectId)||data.chatId&&!/^[a-zA-Z0-9_-]{1,240}$/.test(data.chatId))return;
  const view={projectId:data.projectId,chatId:data.chatId};this.frameTarget=data.projectId+'\n'+data.chatId;
  if(this.knownView(view,context))this.acceptView(view);
  else{
   // New chats and projects may arrive before the parent's state event.
   this.pendingView=view;
   if(!this.refreshRequested&&this.onNeedsRefresh){this.refreshRequested=true;this.onNeedsRefresh();}
  }
  this.render();
 }
 knownView(view,context) {
  if(!(context.projects||[]).some(project=>project.id===view.projectId))return false;
  return !view.chatId||(context.chats||[]).some(chat=>chat.id===view.chatId&&chat.projectId===view.projectId);
 }
 acceptView(view) {
  this.rightProjectId=view.projectId;this.rightChatId=view.chatId;this.frameTarget=view.projectId+'\n'+view.chatId;this.hasSavedView=true;this.pendingView=null;this.refreshRequested=false;this.save();
 }
 load() {
  this.enabled=false;this.ratio=.5;this.rightChatId='';this.rightProjectId='';this.hasSavedView=false;this.pendingView=null;this.refreshRequested=false;
  try{
   const saved=JSON.parse(localStorage.getItem('roomSplit:'+this.userId)||'null');if(!saved||typeof saved!=='object')return;
   this.enabled=saved.enabled===true;this.ratio=typeof saved.ratio==='number'&&Number.isFinite(saved.ratio)?Math.min(.62,Math.max(.38,saved.ratio)):.5;
   this.rightChatId=typeof saved.rightChatId==='string'?saved.rightChatId:'';this.rightProjectId=typeof saved.rightProjectId==='string'?saved.rightProjectId:'';
   this.hasSavedView=Boolean(this.rightProjectId||this.rightChatId);
  }catch{}
 }
 save() {
  if(!this.userId)return;
  try{localStorage.setItem('roomSplit:'+this.userId,JSON.stringify({enabled:this.enabled,rightChatId:this.rightChatId,rightProjectId:this.rightProjectId,ratio:this.ratio}));}catch{}
 }
 geometry() {
  const bounds=this.root.getBoundingClientRect(),sidebar=this.sidebarCollapsed?0:248,available=bounds.width-sidebar-4;
  const min=Math.max(.38,340/Math.max(1,available)),max=Math.min(.62,1-340/Math.max(1,available));
  return {bounds,sidebar,available,min,max};
 }
 render() {
  if(!this.root)return;
  const context=this.getContext()||{},wide=window.innerWidth>1000,visible=this.enabled&&wide;
  this.root.classList.toggle('is-split',visible);this.root.classList.toggle('sidebar-is-collapsed',this.sidebarCollapsed);
  this.host.hidden=!visible;this.divider.hidden=!visible;this.host.inert=!visible;
  this.syncFrameVisibility(visible);
  const view=this.pendingView||{projectId:this.rightProjectId,chatId:this.rightChatId};
  const project=(context.projects||[]).find(item=>item.id===view.projectId),chat=(context.chats||[]).find(item=>item.id===view.chatId);
  this.picker.textContent=(project?.name?project.name+' · ':'')+(chat?.title||'Новый чат');this.picker.title='Выбрать правую сессию';this.picker.setAttribute('aria-label','Выбрать правую сессию: '+this.picker.textContent);
  this.picker.disabled=!this.chooseChat;
  for(const button of this.app.querySelectorAll('.split-toggle')){
   button.disabled=!wide;button.hidden=!wide;button.setAttribute('aria-pressed',String(this.enabled));button.title=this.enabled?'Закрыть правую панель':'Открыть вторую сессию';
   if(!button.childNodes.length)button.innerHTML=dividerIcon;
  }
  if(!visible){this.paintSessionDrop();return;}
  const {bounds,sidebar,available,min,max}=this.geometry(),ratio=Math.min(max,Math.max(min,this.ratio));
  this.root.style.setProperty('--split-left',(sidebar+available*ratio)+'px');
  this.divider.setAttribute('aria-valuemin',String(Math.round(min*100)));this.divider.setAttribute('aria-valuemax',String(Math.round(max*100)));
  this.divider.setAttribute('aria-valuenow',String(Math.round(ratio*100)));this.divider.setAttribute('aria-valuetext',Math.round(ratio*100)+'% слева');
  this.root.style.setProperty('--split-width',bounds.width+'px');
  this.paintSessionDrop();
 }
 syncFrameVisibility(visible=this.enabled&&window.innerWidth>1000) {
  if(!this.frame?.contentWindow||this.frameVisibility===visible)return;
  this.frameVisibility=visible;this.frame.contentWindow.postMessage({type:'teamroom:pane-visibility',visible},location.origin);
 }
 startResize(event) {
  if(event.button!==0||!this.root?.classList.contains('is-split'))return;
  event.preventDefault();this.dragPointer=event.pointerId;this.divider.setPointerCapture(event.pointerId);this.root.classList.add('split-resizing');
 }
 moveResize(event) {
  if(event.pointerId!==this.dragPointer||!this.root)return;
  const {bounds,sidebar,available,min,max}=this.geometry();this.ratio=Math.min(max,Math.max(min,(event.clientX-bounds.left-sidebar)/available));this.render();
 }
 stopResize() {
  const pointer=this.dragPointer;this.dragPointer=null;this.root?.classList.remove('split-resizing');
  if(pointer!=null){if(this.divider?.hasPointerCapture(pointer))this.divider.releasePointerCapture(pointer);this.save();}
 }
 resizeWithKeys(event) {
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||!this.root?.classList.contains('is-split'))return;
  event.preventDefault();const {min,max}=this.geometry(),current=Math.min(max,Math.max(min,this.ratio));
  this.ratio=event.key==='Home'?min:event.key==='End'?max:Math.min(max,Math.max(min,current+(event.key==='ArrowLeft'?-.02:.02)*(event.shiftKey?5:1)));
  this.save();this.render();
 }
}
