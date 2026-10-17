// A temporary desktop drawer preserves the user's saved collapsed layout.
export class SidebarHover {
 constructor({onChange}={}) {
  this.onChange=onChange;
  this.media=matchMedia('(min-width:761px) and (hover:hover) and (pointer:fine)');
 }
 attach(app,{embedded=false}={}) {
  this.detach();if(!app||embedded)return;
  this.app=app;this.sidebar=app.querySelector('#sidebar');if(!this.sidebar)return;
  this.controller=new AbortController();const signal=this.controller.signal;
  document.addEventListener('pointermove',event=>this.move(event),{passive:true,signal});
  document.addEventListener('pointerdown',event=>{this.keyboardFocus=false;if(this.sidebar.contains(event.target)){this.pressing=true;this.cancelClose();}else this.hide();},{capture:true,signal});
  document.addEventListener('pointerup',()=>{this.pressing=false;this.considerClose();},{signal});
  document.addEventListener('pointercancel',()=>{this.pressing=false;this.considerClose();},{signal});
  document.addEventListener('dragstart',event=>{if(this.sidebar.contains(event.target)){this.dragging=true;this.cancelClose();}},{capture:true,signal});
  document.addEventListener('dragend',()=>{this.dragging=false;this.considerClose();},{signal});
  document.addEventListener('drop',()=>{this.dragging=false;this.considerClose();},{signal});
  const leave=()=>{this.point=null;this.inside=false;this.cancelOpen();this.considerClose();};
  document.addEventListener('mouseleave',leave,{signal});
  this.sidebar.addEventListener('pointerleave',leave,{signal});
  document.addEventListener('keydown',event=>{if(event.key==='Tab'||this.sidebar.contains(document.activeElement))this.keyboardFocus=true;if(event.key==='Escape'&&this.isOpen()&&!document.querySelector('dialog[open]')){event.preventDefault();this.hide();}},{signal});
  this.sidebar.addEventListener('focusout',()=>{queueMicrotask(()=>this.considerClose());},{signal});
  window.addEventListener('blur',()=>this.hide(),{signal});
  this.media.addEventListener('change',()=>this.sync(),{signal});
  this.sync();
 }
 eligible() {
  return Boolean(this.app?.isConnected&&this.media.matches&&!document.documentElement.matches('.phone-client,.phone-web-client')&&this.app.classList.contains('sidebar-collapsed'));
 }
 isOpen(){return Boolean(this.app?.classList.contains('sidebar-peek'));}
 blocked(){return Boolean(document.querySelector('dialog[open],.workspace-root.split-resizing'));}
 focusHeld(){const active=document.activeElement;return Boolean(this.sidebar?.contains(active)&&(this.keyboardFocus||active.matches('input,select,textarea,[contenteditable=true]')));}
 interactionHeld(){return this.pressing||this.dragging||this.sidebar?.classList.contains('sidebar-sections-resizing')||this.focusHeld();}
 sync() {
  if(!this.eligible())this.hide();
  if(this.media.matches&&this.sidebar&&!document.documentElement.matches('.phone-client,.phone-web-client'))this.sidebar.inert=Boolean(this.app.classList.contains('sidebar-collapsed')&&!this.isOpen());
 }
 move(event) {
  if(event.pointerType!=='mouse'||!this.eligible())return;
  this.point={x:event.clientX,y:event.clientY};
  const bounds=(this.isOpen()?this.sidebar:this.app).getBoundingClientRect();
  this.inside=event.clientY>=bounds.top&&event.clientY<=bounds.bottom&&event.clientX>=bounds.left&&event.clientX<=bounds.left+(this.isOpen()?bounds.width+6:12);
  if(this.inside){
   this.cancelClose();
   if(!this.isOpen()&&!this.openTimer&&!event.buttons&&!this.blocked())this.openTimer=setTimeout(()=>{this.openTimer=null;if(this.inside&&this.eligible()&&!this.blocked())this.show();},110);
  }else{this.cancelOpen();this.considerClose();}
 }
 show() {
  if(!this.eligible()||this.isOpen())return;
  this.returnFocus=document.activeElement;this.app.classList.add('sidebar-peek');this.sidebar.inert=false;this.onChange?.();
 }
 considerClose() {
  if(!this.isOpen()||this.inside||this.interactionHeld())return;
  if(!this.closeTimer)this.closeTimer=setTimeout(()=>{this.closeTimer=null;const bounds=this.sidebar?.getBoundingClientRect(),point=this.point;if(bounds&&point)this.inside=point.y>=bounds.top&&point.y<=bounds.bottom&&point.x>=bounds.left&&point.x<=bounds.right+6;if(!this.inside&&!this.interactionHeld())this.hide();},240);
 }
 hide() {
  this.cancelOpen();this.cancelClose();if(!this.isOpen())return;
  const focused=this.sidebar.contains(document.activeElement);this.app.classList.remove('sidebar-peek');
  if(this.media.matches)this.sidebar.inert=this.app.classList.contains('sidebar-collapsed');
  if(focused){const target=this.returnFocus?.isConnected&&!this.sidebar.contains(this.returnFocus)?this.returnFocus:this.app.querySelector('.topbar [data-sidebar-toggle]');target?.focus({preventScroll:true});}
  this.onChange?.();
 }
 cancelOpen(){clearTimeout(this.openTimer);this.openTimer=null;}
 cancelClose(){clearTimeout(this.closeTimer);this.closeTimer=null;}
 detach() {
  this.controller?.abort();this.hide();this.cancelOpen();this.cancelClose();
  this.app=null;this.sidebar=null;this.returnFocus=null;this.controller=null;this.inside=false;this.pressing=false;this.dragging=false;this.keyboardFocus=false;this.point=null;
 }
}
