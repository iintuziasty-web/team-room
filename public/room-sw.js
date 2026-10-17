// No fetch interception or asset cache: updates and authenticated data stay live.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
const safeNotificationUrl=value=>{try{const url=new URL(value||'/room/',self.location.origin);if(url.origin===self.location.origin&&url.pathname==='/room/')return url.href;}catch{}return self.location.origin+'/room/';};
const isRoomWindow=client=>{if(client.frameType&&client.frameType!=='top-level')return false;try{const url=new URL(client.url);return url.origin===self.location.origin&&['/room/','/room','/'].includes(url.pathname);}catch{return false;}};
self.addEventListener('push',event=>{
 let data;try{data=event.data?.json()}catch{}
 const safe=safeNotificationUrl(data?.url);
 event.waitUntil(self.registration.showNotification(String(data?.title||'Team Room').slice(0,100),{body:String(data?.body||'В чате есть обновление.').slice(0,200),icon:'/icons/team-room-180.png',badge:'/icons/team-room-180.png',tag:String(data?.tag||'team-room').slice(0,200),data:{url:safe}}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();event.waitUntil((async()=>{
  const safe=safeNotificationUrl(event.notification.data?.url);
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  const target=windows.find(w=>isRoomWindow(w)&&w.url===safe)||windows.find(isRoomWindow);
  if(target){try{
   // Route inside the existing app so its unsent draft and attachments survive.
   if(target.url!==safe)target.postMessage({type:'teamroom-notification-open',url:safe});
   return await target.focus();
  }catch{/* The window may have closed after matchAll. */}}
  return self.clients.openWindow(safe);
 })());
});
