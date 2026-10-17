/* Keeps desktop tools and projects independently scrollable without replacing sidebar nodes. */
export class SidebarSections {
 constructor({storage}={}) {
  this.storage=storage;
  this.media=window.matchMedia('(min-width: 1001px)');
  this.onMedia=()=>this.sync();
  this.onResize=()=>this.layout();
  this.onWindowBlur=()=>this.finishResize();
  this.onWindowKey=event=>{
   if(this.drag&&event.key==='Escape'){
    event.preventDefault();event.stopPropagation();
    const ratio=this.drag.ratio;this.finishResize(false);this.ratio=ratio;this.layout();
   }
  };
 }

 attach(sidebar,{userId,embedded=false}={}) {
  this.detach();
  if(!sidebar||!userId||embedded)return this;
  this.sidebar=sidebar;this.userId=String(userId);this.key='roomSidebarSections:'+this.userId;
  this.ratio=null;
  try{
   const saved=JSON.parse(this.storage?.getItem(this.key)||'null');
   if(saved?.version===1&&Number.isFinite(saved.ratio)&&saved.ratio>0&&saved.ratio<1)this.ratio=saved.ratio;
  }catch{}
  this.media.addEventListener('change',this.onMedia);
  window.addEventListener('resize',this.onResize);
  window.addEventListener('blur',this.onWindowBlur);
  window.addEventListener('keydown',this.onWindowKey,true);
  if(window.ResizeObserver){this.observer=new ResizeObserver(this.onResize);this.observer.observe(sidebar);}
  document.fonts?.ready.then(()=>{if(this.sidebar===sidebar)this.layout();});
  this.sync();return this;
 }

 sync() {
  if(!this.sidebar)return;
  if(this.media.matches&&!document.documentElement.classList.contains('phone-web-client'))this.mount();
  else this.unmount();
  this.layout();
 }

 mount() {
  if(this.tools)return;
  const tools=this.sidebar.querySelector(':scope > .side-links');
  const search=this.sidebar.querySelector(':scope > #chat-search');
  const heading=this.sidebar.querySelector(':scope > .project-list-heading');
  const list=this.sidebar.querySelector(':scope > #chat-list');
  if(!tools||!search||!heading||!list)return;
  const focused=document.activeElement;
  this.originalNodes=Array.from(this.sidebar.childNodes);
  this.tools=document.createElement('section');this.tools.className='sidebar-tools-section';
  this.tools.id='sidebar-tools-section';this.tools.setAttribute('aria-label','Инструменты проекта');
  this.projects=document.createElement('section');this.projects.className='sidebar-projects-section';
  this.projects.id='sidebar-projects-section';this.projects.setAttribute('aria-label','Проекты и сессии');
  this.divider=document.createElement('div');this.divider.className='sidebar-section-divider';
  this.divider.tabIndex=0;this.divider.setAttribute('role','separator');
  this.divider.setAttribute('aria-orientation','horizontal');
  this.divider.setAttribute('aria-label','Размер секций инструментов и чатов');
  this.divider.setAttribute('aria-controls','sidebar-tools-section sidebar-projects-section');
  this.divider.title='Потяни вверх или вниз · двойной клик — исходный размер';
  this.divider.innerHTML='<span class="sidebar-divider-line" aria-hidden="true"></span><span class="sidebar-divider-grip" aria-hidden="true"></span><span class="sidebar-divider-line" aria-hidden="true"></span>';
  this.sidebar.insertBefore(this.tools,tools);this.tools.append(tools);
  this.tools.after(this.divider);
  const picker=this.sidebar.querySelector(':scope > #project-picker');
  this.sidebar.insertBefore(this.projects,picker||search);
  this.projects.append(...[picker,search,heading,list].filter(Boolean));
  this.sidebar.classList.add('has-resizable-sections');
  this.divider.addEventListener('pointerdown',event=>this.startResize(event));
  this.divider.addEventListener('pointermove',event=>this.moveResize(event));
  this.divider.addEventListener('pointerup',()=>this.finishResize());
  this.divider.addEventListener('pointercancel',()=>this.finishResize());
  this.divider.addEventListener('lostpointercapture',()=>this.finishResize());
  this.divider.addEventListener('keydown',event=>this.resizeWithKeys(event));
  this.divider.addEventListener('dblclick',event=>{event.preventDefault();this.reset();});
  if(focused&&this.sidebar.contains(focused)&&focused!==document.activeElement)focused.focus({preventScroll:true});
 }

 geometry() {
  if(!this.tools||!this.sidebar?.isConnected||!this.sidebar.getClientRects().length)return null;
  // Use the container's real space: a non-shrinking tools section can otherwise
  // inflate the total in a short window before the first layout pass.
  const css=getComputedStyle(this.sidebar),number=value=>parseFloat(value)||0;
  const fixed=[...this.sidebar.children].filter(node=>node!==this.tools&&node!==this.projects).reduce((total,node)=>{
   if(!node.getClientRects().length)return total;
   const style=getComputedStyle(node);
   return total+node.getBoundingClientRect().height+number(style.marginTop)+number(style.marginBottom);
  },0);
  const available=Math.max(0,this.sidebar.clientHeight-number(css.paddingTop)-number(css.paddingBottom)-fixed);
  if(available<1)return null;
  const minTools=Math.min(64,available*.3);
  const minProjects=Math.min(160,available-minTools);
  const maxTools=Math.max(minTools,available-minProjects);
  const natural=(this.tools.firstElementChild?.scrollHeight||minTools)+6;
  return {available,minTools,maxTools,natural};
 }

 layout() {
  const geometry=this.geometry();if(!geometry)return;
  const {available,minTools,maxTools,natural}=geometry;
  const wanted=this.ratio===null?natural:available*this.ratio;
  const height=Math.min(maxTools,Math.max(minTools,wanted));
  this.tools.style.setProperty('--sidebar-tools-height',height+'px');
  const percentage=value=>Math.round(value/available*100);
  this.divider.setAttribute('aria-valuemin',percentage(minTools));
  this.divider.setAttribute('aria-valuemax',percentage(maxTools));
  this.divider.setAttribute('aria-valuenow',percentage(height));
  this.divider.setAttribute('aria-valuetext','Инструменты '+percentage(height)+'%, проекты и чаты '+(100-percentage(height))+'%');
 }

 setHeight(height) {
  const geometry=this.geometry();if(!geometry)return;
  this.ratio=Math.min(geometry.maxTools,Math.max(geometry.minTools,height))/geometry.available;
  this.layout();
 }

 startResize(event) {
  if(event.button!==0||event.isPrimary===false||!this.geometry())return;
  event.preventDefault();event.stopPropagation();
  this.drag={pointerId:event.pointerId,y:event.clientY,height:this.tools.getBoundingClientRect().height,ratio:this.ratio};
  this.divider.focus({preventScroll:true});
  this.divider.setPointerCapture?.(event.pointerId);
  this.sidebar.classList.add('sidebar-sections-resizing');
  document.documentElement.classList.add('sidebar-section-resizing');
 }

 moveResize(event) {
  if(!this.drag||event.pointerId!==this.drag.pointerId)return;
  event.preventDefault();this.setHeight(this.drag.height+event.clientY-this.drag.y);
 }

 finishResize(save=true) {
  if(!this.drag)return;
  const pointerId=this.drag.pointerId;this.drag=null;
  if(this.divider?.hasPointerCapture?.(pointerId))this.divider.releasePointerCapture(pointerId);
  this.sidebar?.classList.remove('sidebar-sections-resizing');
  document.documentElement.classList.remove('sidebar-section-resizing');
  if(save)this.save();
 }

 resizeWithKeys(event) {
  const geometry=this.geometry();if(!geometry)return;
  const current=this.tools.getBoundingClientRect().height;
  const step=event.shiftKey?40:12;
  let height;
  if(event.key==='ArrowUp')height=current-step;
  else if(event.key==='ArrowDown')height=current+step;
  else if(event.key==='Home')height=geometry.minTools;
  else if(event.key==='End')height=geometry.maxTools;
  else if(event.key==='Enter'){event.preventDefault();event.stopPropagation();this.reset();return;}
  else return;
  event.preventDefault();event.stopPropagation();this.setHeight(height);this.save();
 }

 reset() {
  this.finishResize(false);this.ratio=null;
  try{this.storage?.removeItem(this.key);}catch{}
  this.layout();
 }

 save() {
  if(this.ratio===null||!this.key)return;
  try{this.storage?.setItem(this.key,JSON.stringify({version:1,ratio:this.ratio}));}catch{}
 }

 unmount() {
  if(!this.tools)return;
  this.finishResize();
  const focused=document.activeElement,wasFocused=this.sidebar.contains(focused);
  // Put the exact original nodes back; mobile gesture handlers and keyed list rendering retain their references.
  for(const node of this.originalNodes||[])this.sidebar.append(node);
  this.tools.remove();this.divider.remove();this.projects.remove();
  this.sidebar.classList.remove('has-resizable-sections');
  this.tools=this.projects=this.divider=null;this.originalNodes=null;
  if(wasFocused&&focused.isConnected&&focused!==document.activeElement)focused.focus({preventScroll:true});
 }

 detach() {
  this.unmount();this.observer?.disconnect();this.observer=null;
  this.media.removeEventListener('change',this.onMedia);
  window.removeEventListener('resize',this.onResize);
  window.removeEventListener('blur',this.onWindowBlur);
  window.removeEventListener('keydown',this.onWindowKey,true);
  this.sidebar=null;this.userId='';this.key='';this.ratio=null;
 }
}
