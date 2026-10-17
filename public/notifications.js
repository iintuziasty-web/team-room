const base64Bytes=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
export class PhoneNotifications {
 constructor({api,user,notice}){Object.assign(this,{api,user,notice});this.registration=null;this.account=null;this.generation=0;this.tail=Promise.resolve();}
 get supported(){return window.isSecureContext&&'serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;}
 get installed(){return navigator.standalone===true||matchMedia('(display-mode:standalone)').matches;}
 get needsInstall(){return /iPhone|iPod|iPad/.test(navigator.userAgent)&&!this.installed;}
 get key(){return 'roomNotifications:'+this.user()?.id;}
 preferences(key=this.key){try{return JSON.parse(localStorage.getItem(key))||{questions:true,completed:true,failed:true,scope:'all',preview:false}}catch{return {questions:true,completed:true,failed:true,scope:'all',preview:false};}}
 token(){const account=this.user()?.id;if(!account)return null;if(this.account!==account){this.account=account;this.generation++;}return {account,generation:this.generation,key:'roomNotifications:'+account};}
 current(token){return Boolean(token&&this.account===token.account&&this.user()?.id===token.account&&this.generation===token.generation);}
 exclusive(operation){const pending=this.tail.catch(()=>{}).then(operation);this.tail=pending.catch(()=>{});return pending;}
 ensureReady(){
  if(!this.ready){const pending=navigator.serviceWorker.register('/room-sw.js',{scope:'/room/',updateViaCache:'none'}).then(async registration=>{await navigator.serviceWorker.ready;this.registration=registration;return registration;});this.ready=pending;void pending.catch(()=>{if(this.ready===pending)this.ready=null;});}
  return this.ready;
 }
 async init(){
  if(!this.supported||this.needsInstall||!this.user())return;
  const token=this.token(),ready=this.ensureReady();
  try{await this.exclusive(async()=>{
   await ready;if(!this.current(token))return;
   let subscription=await this.registration.pushManager.getSubscription();if(!this.current(token))return;
   const wanted=localStorage.getItem(token.key+':wanted')==='true';
   if(subscription&&!wanted){await subscription.unsubscribe();subscription=null;if(!this.current(token))return;}
   if(Notification.permission!=='granted'||!wanted)return;
   if(!subscription){const config=await this.api('/notifications');if(!this.current(token))return;subscription=await this.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:base64Bytes(config.publicKey)});}
   if(!this.current(token))return;
   const result=await this.api('/notifications/subscribe','POST',{subscription:subscription.toJSON(),preferences:this.preferences(token.key)});
   if(this.current(token))this.id=result.id;
  });}
  catch{/* Notification delivery must never block opening a chat. */}
 }
 async status(){
  if(this.needsInstall)return {reason:'На iPhone открой Team Room через значок на главном экране. В Safari: «Поделиться» → «На экран Домой».'};if(!this.supported)return {reason:'Уведомления недоступны в этом браузере.'};
  const token=this.token();if(!token)return {cancelled:true};const ready=this.ensureReady();
  return this.exclusive(async()=>{await ready;if(!this.current(token))return {cancelled:true};const subscription=await this.registration.pushManager.getSubscription();if(!this.current(token))return {cancelled:true};let enabled=false;
   if(subscription&&Notification.permission==='granted'){const config=await this.api('/notifications');if(!this.current(token))return {cancelled:true};const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(subscription.endpoint));if(!this.current(token))return {cancelled:true};const id=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');enabled=Boolean(config.subscriptions?.some(s=>s.id===id));}
   return {enabled,denied:Notification.permission==='denied',preferences:this.preferences(token.key)};
  });
 }
 async enable(preferences){
  if(!this.supported||this.needsInstall)throw new Error('Открой установленный на главный экран Team Room.');
  const token=this.token();if(!token)return {enabled:false,cancelled:true};
  // Invoke within the button's user gesture before any network await.
  const permission=await Notification.requestPermission();if(!this.current(token))return {enabled:false,cancelled:true};if(permission!=='granted')throw new Error('Уведомления не разрешены. Разреши их для Team Room в настройках телефона.');
  const ready=this.ensureReady();
  return this.exclusive(async()=>{
   const cancelled={enabled:false,cancelled:true};await ready;if(!this.current(token))return cancelled;
   const config=await this.api('/notifications');if(!this.current(token))return cancelled;
   let subscription=await this.registration.pushManager.getSubscription();if(!this.current(token))return cancelled;
   if(subscription&&subscription.options.applicationServerKey&&Array.from(new Uint8Array(subscription.options.applicationServerKey)).join(',')!==Array.from(base64Bytes(config.publicKey)).join(',')){await subscription.unsubscribe();subscription=null;if(!this.current(token))return cancelled;}
   subscription||=await this.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:base64Bytes(config.publicKey)});
   if(!this.current(token))return cancelled;
   const result=await this.api('/notifications/subscribe','POST',{subscription:subscription.toJSON(),preferences});if(!this.current(token))return cancelled;
   this.id=result.id;localStorage.setItem(token.key,JSON.stringify(preferences));localStorage.setItem(token.key+':wanted','true');return {enabled:true};
  });
 }
 async disable(){
  const token=this.token();if(!token)return {cancelled:true};const ready=this.ensureReady();
  return this.exclusive(async()=>{await ready;if(!this.current(token))return {cancelled:true};const subscription=await this.registration.pushManager.getSubscription();if(!this.current(token))return {cancelled:true};
   if(subscription){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(subscription.endpoint));if(!this.current(token))return {cancelled:true};const id=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');await this.api('/notifications/unsubscribe','POST',{id});if(!this.current(token))return {cancelled:true};await subscription.unsubscribe();if(!this.current(token))return {cancelled:true};}
   this.id=null;localStorage.setItem(token.key+':wanted','false');return {enabled:false};
  });
 }
 async clear(){this.account=null;this.generation++;this.id=null;const ready=this.ready;
  // Cleanup stays ahead of a newly queued account init. A late unsubscribe
  // must never invalidate the subscription that a new login just installed.
  try{await this.exclusive(async()=>{await ready?.catch(()=>{});const subscription=await this.registration?.pushManager.getSubscription();await subscription?.unsubscribe();});}catch{}
 }
}
