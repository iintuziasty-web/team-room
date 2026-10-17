// A second pane has an independent view, draft and route preferences.
// The login cookie remains the same; storage keys never contain credentials.
export const isEmbeddedPane=location.pathname==='/room/pane'&&new URLSearchParams(location.search).get('pane')==='right'&&window.parent!==window;
export let isPaneVisible=true;
let paneAccount='pending';
export function setPaneAccount(value){paneAccount=String(value||'pending');}
function scopedStorage(storage){
 const key=value=>isEmbeddedPane?'roomPane:right:'+paneAccount+':'+String(value):String(value);
 return {getItem:value=>storage.getItem(key(value)),setItem:(value,data)=>storage.setItem(key(value),data),removeItem:value=>storage.removeItem(key(value))};
}
export const roomLocalStorage=scopedStorage(window.localStorage);
export const roomSessionStorage=scopedStorage(window.sessionStorage);
export function announcePaneView(projectId,chatId){
 if(isEmbeddedPane)window.parent.postMessage({type:'teamroom:pane-view',projectId:String(projectId||''),chatId:String(chatId||'')},location.origin);
}
export function announcePaneAuthExpired(){
 if(isEmbeddedPane)window.parent.postMessage({type:'teamroom:pane-auth-expired'},location.origin);
}
if(isEmbeddedPane){
 document.documentElement.classList.add('split-embedded');
 window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==window.parent||event.data?.type!=='teamroom:pane-visibility'||typeof event.data.visible!=='boolean')return;
  if(isPaneVisible===event.data.visible)return;isPaneVisible=event.data.visible;
  window.dispatchEvent(new CustomEvent('teamroom:pane-visibility',{detail:{visible:isPaneVisible}}));
 });
 const inheritLocalDevice=()=>{try{if(window.parent.teamRoomNativeMac){window.teamRoomNativeMac=true;window.teamRoomLocalDeviceId=window.parent.teamRoomLocalDeviceId||null;window.teamRoomLocalDeviceReady=window.parent.teamRoomLocalDeviceReady;window.dispatchEvent(new CustomEvent('teamroom:local-device',{detail:{deviceId:window.teamRoomLocalDeviceId}}));}}catch{}};
 inheritLocalDevice();
 try{window.parent.addEventListener('teamroom:local-device',inheritLocalDevice);}catch{}
 window.addEventListener('pagehide',()=>{try{window.parent.removeEventListener('teamroom:local-device',inheritLocalDevice);}catch{}},{once:true});
}
