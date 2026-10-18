import {SessionBoard} from './session-board.js?v=0.4.78';
import {ChatTools} from './chat-tools.js';
import {attachPreview} from './preview-annotations.js';
import {Dictation} from './voice-input.js';
import {PhoneNotifications} from './notifications.js';
import {VoiceConversation} from './voice-conversation.js';
import {UsagePopover,usageMeterState,weeklyQuotaState,formatUsagePercent} from './usage-popover.js';
import {contextMeter} from './session-context.js';
import {CommunityUpdates} from './community-updates.js';
import {renderProfileMenu} from './profile-menu.js';
import {SidebarSections} from './sidebar-layout.js';
import {SidebarHover} from './sidebar-hover.js';
import {SplitWorkspace} from './split-workspace.js';
import {SplitSessionPicker} from './split-session-picker.js';
import {isEmbeddedPane,isPaneVisible,setPaneAccount,roomLocalStorage,roomSessionStorage,announcePaneView,announcePaneAuthExpired} from './pane-runtime.js';
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const jsArg=value=>esc(JSON.stringify(String(value)));
// The phone is a viewer and controller; only computers registered by Connect execute work.
const isPhoneClient=/TeamRoom-iOS\/|iPhone|iPod/i.test(navigator.userAgent);
const compactScreen=matchMedia('(max-width:760px), (hover:none) and (pointer:coarse)');
function uiBackground(){return document.hidden||isEmbeddedPane&&!isPaneVisible;}
document.documentElement.classList.toggle('phone-client',isPhoneClient);
const isPhoneWebClient=/iPhone|iPod|Android.*Mobile/i.test(navigator.userAgent)&&!/TeamRoom-iOS\//i.test(navigator.userAgent);
document.documentElement.classList.toggle('phone-web-client',isPhoneWebClient);
if(isPhoneWebClient)document.querySelector('meta[name=theme-color]')?.setAttribute('content','#151515');
// Standalone WebKit can reserve a system strip while 100vh still reports the
// physical screen. Never expand the app past the browser's drawable viewport.
const phoneStandalone=isPhoneWebClient&&(navigator.standalone===true||matchMedia('(display-mode:standalone)').matches);
document.documentElement.classList.toggle('phone-standalone',phoneStandalone);
const phoneViewportProbe=isPhoneWebClient?document.createElement('div'):null;
if(phoneViewportProbe){phoneViewportProbe.className='phone-viewport-probe';phoneViewportProbe.setAttribute('aria-hidden','true');document.body.append(phoneViewportProbe);}

const phoneIconPaths={search:'M21 21l-6-6M17 9a8 8 0 1 1-16 0 8 8 0 0 1 16 0',branch:'M6 3v12a6 6 0 0 0 6 6M6 9h6a6 6 0 0 0 6-6M3 3h6M15 3h6M9 21h6',mic:'M9 4a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0zM5 10v1a7 7 0 0 0 14 0v-1M12 18v4M8 22h8',menu:'M4 7h16M4 12h12M4 17h16',close:'m6 6 12 12M18 6 6 18',back:'m14 6-6 6 6 6',more:'M5 12h.01M12 12h.01M19 12h.01',plus:'M12 5v14M5 12h14',computer:'M4 4h16v12H4zM2 20h20',file:'M6 3h8l4 4v14H6zM14 3v5h4',memory:'M8 4H6a2 2 0 0 0-2 2v14l4-3h10a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2M8 8h8M8 12h5',task:'m5 12 4 4L19 6',limits:'M5 19v-5M12 19V5M19 19V9',tools:'M9 3v6H3M15 21v-6h6M3 9l6-6M21 15l-6 6',skill:'m12 3 3 6 6 3-6 3-3 6-3-6-6-3 6-3z',import:'M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4',account:'M8 7a4 4 0 1 0 8 0 4 4 0 1 0-8 0M4 21v-2a8 8 0 0 1 16 0v2',chevron:'m9 5 7 7-7 7'};
function phoneIcon(name){return `<svg class="phone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${phoneIconPaths[name]||phoneIconPaths.more}"/></svg>`}
const sessionIconPaths={rename:'m15 4 5 5M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L3 16l-1 5z',move:'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 7v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5M10 13h11m-4-4 4 4-4 4',archive:'M3 3h18v5H3zM5 8v13h14V8M9 12h6',restore:'M3 3h18v5H3zM5 8v13h14V8m-4 8-3-3-3 3M12 12v7',trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',download:'M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4',open:'M8 3H4v18h16v-4M12 3h9v9M21 3l-10 10'};
function sessionMenuIcon(name){return sessionIconPaths[name]?`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${sessionIconPaths[name]}"/></svg>`:phoneIcon(name)}
function sessionMenuAction(icon,label,action,{href,danger=false,disabled=false}={}){
 const content=`<span class="session-action-icon">${sessionMenuIcon(icon)}</span><span>${esc(label)}</span>`;
 return href?`<a class="session-action" href="${esc(href)}">${content}</a>`:`<button type="button" class="session-action ${danger?'session-action-danger':''}" onclick="${action}" ${disabled?'disabled':''}>${content}</button>`;
}
function sessionMenuDialog(title,subtitle,body){
 phoneSettingsChild=false;dialog(title,`<div class="session-menu-content">${subtitle?`<p class="session-menu-subtitle">${esc(subtitle)}</p>`:''}${body}</div>`,isPhoneWebClient);
 const el=$('#dialog');el.classList.add('session-menu-dialog');el.querySelector('.modal-head>button:last-child').innerHTML=phoneIcon('close');
 const heading=$('#dialog-title');heading.tabIndex=-1;heading.focus({preventScroll:true});
}
let phoneSettingsChild=false;
function renderPhoneContext(){const el=$('#phone-context-picker');if(!el)return;const device=state?.devices.find(d=>d.id===deviceId);el.innerHTML=`<strong>${esc($('#chat-title')?.textContent||'Новый чат')}</strong><small><span class="status-dot ${networkReady&&device?.online?'ready':'error'}"></span>${esc(device?.name||'Выбрать компьютер')}<span aria-hidden="true">⌄</span></small>`;el.setAttribute('aria-label',`${device?.name||'Компьютер не выбран'}. Выбрать компьютер`)}

let viewportFrame=0,sidebarReturnFocus,viewportBaseline=0,viewportWidth=0,viewportSettleTimers=[];
const composerSizeCache=new WeakMap();
// Keep a reader's touch and momentum scrolling independent of live replies.
const readingStates=new WeakMap(),messageHtmlCache=new WeakMap();
let paintingMessages=false,lastViewportGeometry='';
function readingState(pane){
 let value=readingStates.get(pane);
 if(!value){value={chatId:'',generation:0,touching:false,until:0,timer:0,pending:false};readingStates.set(pane,value);}
 if(value.chatId!==selectedId||value.generation!==chatOpenGeneration){clearTimeout(value.timer);Object.assign(value,{chatId:selectedId,generation:chatOpenGeneration,touching:false,until:0,timer:0,pending:false});}
 return value;
}
function readerBusy(pane=$('#messages')){if(!pane||!compactScreen.matches)return false;const value=readingState(pane);return value.touching||performance.now()<value.until;}
function queueReadingPaint(pane){
 const value=readingState(pane);value.pending=true;clearTimeout(value.timer);
 value.timer=setTimeout(()=>{value.timer=0;if($('#messages')!==pane||value.chatId!==selectedId||value.generation!==chatOpenGeneration)return;if(readerBusy(pane)){queueReadingPaint(pane);return;}value.pending=false;renderMessages();},Math.max(180,value.until-performance.now()+20));
}
function bindReadingGestures(pane){
 const begin=()=>{if(!compactScreen.matches)return;const value=readingState(pane);value.touching=true;clearTimeout(value.timer);};
 const move=()=>{if(!compactScreen.matches)return;const value=readingState(pane);value.until=performance.now()+200;pendingScrollRestore=null;if(value.pending)queueReadingPaint(pane);};
 const end=event=>{if(!compactScreen.matches)return;const value=readingState(pane);value.touching=Boolean(event.touches?.length);value.until=performance.now()+200;if(value.pending)queueReadingPaint(pane);};
 pane.addEventListener('touchstart',begin,{passive:true});pane.addEventListener('touchmove',move,{passive:true});pane.addEventListener('touchend',end,{passive:true});pane.addEventListener('touchcancel',end,{passive:true});
 pane.addEventListener('wheel',move,{passive:true});
 pane.addEventListener('scroll',()=>{if(readerBusy(pane))move();saveScroll();},{passive:true});
}
const readingBlockSelector='.actions-log summary,.actions-log pre,.message-text p,.message-text li,.message-text pre,.message-text h1,.message-text h2,.message-text h3,.message-text h4,.artifact-card';
function captureReadingPosition(pane){
 const top=pane.scrollTop,bottom=pane.scrollHeight-pane.clientHeight-top<40,edge=pane.getBoundingClientRect().top;
 const article=[...pane.querySelectorAll('[data-message]')].find(node=>node.getBoundingClientRect().bottom>edge+2);
 if(!article)return {top,bottom};
 const blocks=[...article.querySelectorAll(readingBlockSelector)],index=blocks.findIndex(node=>node.getBoundingClientRect().bottom>edge+2),node=index<0?article:blocks[index];
 return {top,bottom,node,id:article.dataset.message,index,offset:node.getBoundingClientRect().top-edge};
}
function restoreReadingPosition(pane,position){
 if(!position||readerBusy(pane))return;let top=position.top;
 if(position.bottom)top=pane.scrollHeight-pane.clientHeight;
 else if(position.id){const article=pane.querySelector('[data-message="'+CSS.escape(position.id)+'"]'),node=position.node?.isConnected&&pane.contains(position.node)?position.node:position.index<0?article:article?.querySelectorAll(readingBlockSelector)[position.index]||article;if(node)top=pane.scrollTop+node.getBoundingClientRect().top-pane.getBoundingClientRect().top-position.offset;}
 top=Math.max(0,Math.min(top,pane.scrollHeight-pane.clientHeight));if(Math.abs(pane.scrollTop-top)>1)pane.scrollTop=top;
}
function reconcileMessages(pane,html){
 const template=document.createElement('template');template.innerHTML=html;
 const key=node=>node.nodeType===1?(node.dataset.message?'message:'+node.dataset.message:node.dataset.approvalId?'approval:'+node.dataset.approvalId:node.classList.contains('history-navigation')?'history':node.classList.contains('source-banner')?'source':node.classList.contains('empty')?'empty':''):'';
 const existing=new Map([...pane.children].map(node=>[key(node),node]).filter(([id])=>id)),wanted=[];
 for(const incoming of [...template.content.childNodes]){
  const id=key(incoming),old=id&&existing.get(id),source=incoming.nodeType===1?incoming.outerHTML:incoming.textContent;let node=incoming;
  if(old&&messageHtmlCache.get(old)===source)node=old;
  else if(old&&old.matches('[data-message]')){
   // Preserve expanded action details while their next page is being fetched.
   const actions=old.querySelector('.actions-log'),nextActions=incoming.querySelector('.actions-log');
   if(actions?.open&&nextActions){actions.querySelector('summary').textContent=nextActions.querySelector('summary').textContent;nextActions.replaceWith(actions);}
   for(const selector of ['.message-text','.message-agents']){const previous=old.querySelector(selector),next=incoming.querySelector(selector);if(previous&&next&&(selector==='.message-agents'||previous.innerHTML===next.innerHTML))next.replaceWith(previous);}
   old.dataset.sourceMessage=incoming.dataset.sourceMessage||incoming.dataset.message;
   old.replaceChildren(...incoming.childNodes);node=old;
  }
  messageHtmlCache.set(node,source);wanted.push(node);
 }
 let cursor=pane.firstChild;
 for(const node of wanted){if(node===cursor)cursor=cursor.nextSibling;else pane.insertBefore(node,cursor);}
 const keep=new Set(wanted);for(const node of [...pane.childNodes])if(!keep.has(node))node.remove();
}
function resizeComposerInput(){
 const input=$('#message-input');if(!input)return;
 const style=getComputedStyle(input),minimum=parseFloat(style.minHeight)||44,maximum=parseFloat(style.maxHeight)||240,width=input.clientWidth,cached=composerSizeCache.get(input);
 if(cached?.value===input.value&&cached.width===width&&cached.minimum===minimum&&cached.maximum===maximum)return;
 const pane=$('#messages'),atBottom=pane&&!readerBusy(pane)&&pane.scrollHeight-pane.clientHeight-pane.scrollTop<40;
 input.style.height='0px';
 const height=Math.max(minimum,Math.min(input.scrollHeight,maximum));input.style.height=height+'px';input.style.overflowY=input.scrollHeight>height+1?'auto':'hidden';
 composerSizeCache.set(input,{value:input.value,width,minimum,maximum});
 if(atBottom&&pane)pane.scrollTop=pane.scrollHeight;
}
function syncViewport(){
 cancelAnimationFrame(viewportFrame);viewportFrame=requestAnimationFrame(()=>{
  const compact=compactScreen.matches,viewport=window.visualViewport,nativeScale=!viewport||Math.abs(viewport.scale-1)<.05;
  const visualHeight=nativeScale?(viewport?.height||innerHeight):innerHeight,width=innerWidth,pane=$('#messages');
  const cssHeight=phoneViewportProbe?.getBoundingClientRect().height||innerHeight;
  // visualViewport is the drawable area. innerHeight/dvh can remain stale
  // after iOS keyboard dismissal and must not cap its recovered height.
  const closedHeight=nativeScale&&viewport?visualHeight:isPhoneWebClient?cssHeight:visualHeight;
  const position=pane&&!readerBusy(pane)?captureReadingPosition(pane):null;
  if(Math.abs(width-viewportWidth)>60){viewportWidth=width;viewportBaseline=Math.max(innerHeight,closedHeight);}
  const editing=Boolean(document.activeElement?.matches('textarea,input:not([type=checkbox]):not([type=radio]):not([type=file]),[contenteditable=true]'));
  if(nativeScale&&!editing)viewportBaseline=Math.max(viewportBaseline,closedHeight);
  const shrunk=viewportBaseline-visualHeight>120||closedHeight-visualHeight>120;
  const keyboard=nativeScale&&shrunk&&(editing||document.documentElement.classList.contains('keyboard-open'));
  const height=isPhoneWebClient&&!keyboard?closedHeight:visualHeight;
  const geometry=[compact,width,height,keyboard?viewport?.offsetTop||0:0,keyboard].join(':');const geometryChanged=geometry!==lastViewportGeometry;lastViewportGeometry=geometry;
  const sidebar=$('#sidebar');if(sidebar)sidebar.inert=compact&&!$('.app')?.classList.contains('sidebar-open');
  document.documentElement.classList.toggle('compact-client',compact);document.documentElement.classList.toggle('short-viewport',compact&&nativeScale&&height<420);document.documentElement.classList.toggle('tight-viewport',compact&&nativeScale&&height<300);
  if(compact){
   document.documentElement.style.setProperty('--app-height',height+'px');
   document.documentElement.style.setProperty('--viewport-top',(keyboard?viewport?.offsetTop||0:0)+'px');
   document.documentElement.classList.toggle('keyboard-open',keyboard);
  }else{
   document.documentElement.style.removeProperty('--app-height');document.documentElement.style.removeProperty('--viewport-top');
   document.documentElement.classList.remove('keyboard-open');if($('.app')?.classList.contains('sidebar-open'))closeSidebar(false);sidebarHover.sync();
  }
  // The document itself never scrolls in phone chat; only #messages does.
  // WebKit can leave its page scrolled after focusing/dismissing a textarea.
  if(isPhoneWebClient&&compact&&nativeScale&&!editing&&!keyboard&&(window.scrollY||document.documentElement.scrollTop||document.body.scrollTop))window.scrollTo({top:0,left:0,behavior:'instant'});
  resizeComposerInput();if(geometryChanged&&pane)restoreReadingPosition(pane,position);
 });
}
function settleViewport(){syncViewport();for(const timer of viewportSettleTimers)clearTimeout(timer);viewportSettleTimers=[120,350,700].map(delay=>setTimeout(syncViewport,delay));}
document.addEventListener('focusin',settleViewport);document.addEventListener('focusout',settleViewport);
window.addEventListener('pageshow',settleViewport);document.addEventListener('visibilitychange',()=>{if(!document.hidden)settleViewport()});
window.visualViewport?.addEventListener('resize',settleViewport,{passive:true});
window.visualViewport?.addEventListener('scroll',syncViewport,{passive:true});
window.addEventListener('resize',settleViewport,{passive:true});
window.addEventListener('orientationchange',settleViewport,{passive:true});
if(phoneViewportProbe&&typeof ResizeObserver!=='undefined')new ResizeObserver(settleViewport).observe(phoneViewportProbe);
compactScreen.addEventListener('change',syncViewport);syncViewport();
let authTelegram=false,loginChallenge=null,enrollmentChallenge=null;
let usageCreditsConsent=false,sendingMessage=false,resuming=false,pendingCreditSend;
let state,chat=null,projectId=new URLSearchParams(location.search).get('project')||roomLocalStorage.getItem('roomProject')||'',selectedId=new URLSearchParams(location.search).has('chat')?(new URLSearchParams(location.search).get('chat')||''):(roomLocalStorage.getItem('roomChat')||''),provider=roomLocalStorage.getItem('teamProvider')||'claude',deviceId=new URLSearchParams(location.search).get('device')||roomLocalStorage.getItem('roomDevice')||'local',draft='',attachments=[],files=[],catalogData={},catalogBusy=false,selectedModel='',effort='',requestGeneration=0,pendingMessageId=null,socket,eventRetryTimer,eventConnectStartedAt=0,eventLastReceived=Date.now(),eventLastTick=Date.now(),eventProbeUntil=0,networkReady=true,filePanel=false,refreshing=false,refreshAgain=false,toastTimer,authMode='login';
const sessionBoard=new SessionBoard({api,embedded:isEmbeddedPane,context:()=>({account:state?.me.id,chatId:selectedId}),openChat:id=>window.openChat(id),closeSidebar:()=>closeSidebar(false),dialog,close:()=>window.closeDialog(),toast,changed:()=>void refreshState(),unauthorized:()=>{clearAuthView();renderAuth();}});
window.showSessionBoard=()=>sessionBoard.show();
let newChatDeviceExplicit=false,executionMode='build',executionModeSaving=false,previewCleanup=null;
const routeSwitchRequests=new Map();
function localExecutionDeviceId(){
 const id=window.teamRoomNativeMac?window.teamRoomLocalDeviceId:null;
 return typeof id==='string'&&state?.devices.some(device=>device.id===id)?id:'';
}
function newChatExecutionDeviceId(){
 if(newChatDeviceExplicit&&state?.devices.some(device=>device.id===deviceId))return deviceId;
 // A native Mac never falls back to an unrelated computer while identifying itself.
 if(window.teamRoomNativeMac)return localExecutionDeviceId();
 const projectDevice=state?.projects.find(project=>project.id===projectId)?.executionDeviceId;
 return state?.devices.some(device=>device.id===projectDevice)?projectDevice:state?.devices.some(device=>device.id===deviceId)?deviceId:state?.devices.find(device=>device.online)?.id||state?.devices[0]?.id||'';
}
function resetNewChatDevice(){
 newChatDeviceExplicit=false;deviceId=newChatExecutionDeviceId();
 if(deviceId)roomLocalStorage.setItem('roomDevice',deviceId);
}
function missingExecutionDeviceText(){
 if(!window.teamRoomNativeMac)return 'Выбери компьютер для выполнения.';
 if(window.teamRoomLocalDeviceReady===undefined)return 'Обнови Team Room через меню «Проверить обновления», чтобы новые чаты выбирали этот Mac автоматически. Сейчас можно выбрать компьютер вручную.';
 return window.teamRoomLocalDeviceReady===false?'Определяю этот Mac. Подожди немного или выбери компьютер вручную.':'Этот Mac ещё не подключён к этому пространству. Открой «Этот Mac» в верхнем меню приложения и подключи его. Можно также выбрать компьютер вручную.';
}
async function switchChatRoute(id,options){
 const previous=routeSwitchRequests.get(id);
 const request=Promise.resolve(previous).catch(()=>{}).then(()=>api('/chats/'+id+'/switch','POST',options));
 routeSwitchRequests.set(id,request);
 try{
  const result=await request;
  if(routeSwitchRequests.get(id)===request){
   for(const value of new Set([chat?.id===id?chat:null,chatCache.get(id)]))if(value){value.route=result.route;value.pendingRoute=result.pendingRoute||null;value.executionDeviceId=result.executionDeviceId||options.deviceId;}
  }
  return result;
 }finally{if(routeSwitchRequests.get(id)===request)routeSwitchRequests.delete(id);}
}
window.addEventListener('teamroom:local-device',()=>{
 if(!state||selectedId||chat||newChatDeviceExplicit||sendingMessage)return;
 const previous=deviceId;deviceId=newChatExecutionDeviceId();
 if(deviceId)roomLocalStorage.setItem('roomDevice',deviceId);
 renderDevicesPicker();renderStatus();if(previous!==deviceId)void loadCatalog();
});
const effortNames={none:'Без размышлений',minimal:'Минимальная',low:'Low',medium:'Medium',high:'High',xhigh:'Extra High',max:'Max',ultra:'Ultra',ultracode:'Ultracode'};
const dictation=new Dictation({input:()=>$('#message-input'),context:()=>projectId+':'+selectedId,change:value=>{draft=value;pendingMessageId=null;renderComposer()},state:()=>renderVoiceInput(),notice:message=>toast(message)});
const voiceLanguage=()=>roomLocalStorage.getItem('roomVoiceLanguage')==='uk-UA'?'uk-UA':'ru-RU';
const phoneNotifications=new PhoneNotifications({api,user:()=>state?.me,notice:message=>toast(message)});
let voiceStatusTimer,voiceDraftAtStart='';
const voiceConversation=new VoiceConversation({context:()=>state?.me.id+':'+projectId+':'+selectedId,transcribe:async(blob,context,signal)=>{const chosen=voiceConversation.deviceId,request=requestSignal(signal,200000);try{const response=await fetch('/api/voice/transcribe?device='+encodeURIComponent(chosen)+'&language='+voiceLanguage().slice(0,2),{method:'POST',headers:{'Content-Type':blob.type||'audio/mp4'},body:blob,signal:request.signal});let result;try{result=await response.json()}catch(error){if(request.signal.aborted)throw request.signal.reason;throw new Error('Не удалось прочитать ответ распознавания. Запись можно повторить.');}if(!response.ok)throw new Error(result.error||'Не удалось распознать речь.');return result;}catch(error){if(request.signal.aborted&&request.signal.reason?.name==='TimeoutError')throw new Error('Распознавание задержалось. Запись сохранена — нажми «Повторить».');throw error;}finally{request.dispose();}},text:value=>{
 const input=$('#message-input');if(!input)return;
 draft=voiceDraftAtStart.trim()?voiceDraftAtStart+'\n'+value:value;input.value=draft;pendingMessageId=null;voiceConversation.textValue=draft;renderComposer();
 input.scrollTop=input.scrollHeight;
},state:()=>renderVoiceConversation(),notice:message=>toast(message)});
function renderVoiceConversation(){renderComposer()}
function renderVoiceInput(){
 const button=$('#voice-button'),status=$('#voice-status');if(!button||!status)return;
 const mode=voiceConversation.mode,recording=mode==='recording',busy=['permission','transcribing'].includes(mode),listening=recording||dictation.active;
 const input=$('#message-input');if(input){input.readOnly=recording||busy;input.setAttribute('aria-readonly',String(input.readOnly));}
 button.classList.toggle('listening',listening);button.setAttribute('aria-pressed',String(listening));button.setAttribute('aria-busy',String(busy));
 const label=dictation.active?'Закончить диктовку':recording?'Закончить запись':busy?'Распознаю речь':'Записать голосовое сообщение';
 button.setAttribute('aria-label',label);button.title=label;button.disabled=chatLoading||sendingMessage||dictation.finishing||busy;
 const icon=busy?'busy':recording?'recording':'mic';if(button.dataset.voiceIcon!==icon){button.dataset.voiceIcon=icon;button.innerHTML=busy?'<span class="send-spinner" aria-hidden="true"></span>':recording?phoneIcon('task'):phoneIcon('mic');}
 const labels={permission:'Разреши микрофон',recording:'Слушаю… Нажми микрофон, чтобы закончить',transcribing:'Завершаю диктовку…',review:voiceConversation.textValue?'Текст готов — можно изменить и отправить':'Ответ готов',waiting:chat?.approvals?.length?'Нужен твой ответ в чате':'Ответ будет озвучен',speaking:'Озвучиваю ответ',retry:'Не удалось распознать запись'};
 const answer=chat?.messages.findLast(m=>m.role==='assistant'&&m.status==='completed'),review=mode==='review';
 const text=dictation.active?(dictation.finishing?'Завершаю диктовку…':'Слушаю…'):labels[mode]||'';
 status.hidden=!text;status.dataset.mode=mode;
 status.innerHTML=text?`<span class="voice-status-copy">${esc(text)}</span><span class="voice-inline-actions">${mode==='retry'?'<button onclick="retryVoiceTurn()">Повторить</button><button onclick="showVoiceSettings()" aria-label="Настройки голоса">'+phoneIcon('tools')+'</button>':''}${mode==='speaking'?'<button onclick="stopVoiceSpeaking()" aria-label="Остановить озвучивание">'+phoneIcon('close')+'</button>':''}${review&&answer&&!voiceConversation.textValue?'<button onclick="playVoiceReply()">Озвучить</button>':''}${['permission','recording','transcribing','retry','waiting'].includes(mode)?'<button onclick="cancelVoiceTurn()" aria-label="Отменить голосовой режим">'+phoneIcon('close')+'</button>':''}</span>`:'';
}
window.openVoiceConversation=()=>{if($('#dialog').open)closeDialog();return toggleVoiceInput()};
window.cancelVoiceTurn=()=>{voiceConversation.cancel();dictation.cancel();renderComposer()};
window.recordVoiceTurn=async()=>{
 try{
  if(voiceConversation.mode==='recording'){if(window.speechSynthesis&&window.SpeechSynthesisUtterance)window.speechSynthesis.speak(new SpeechSynthesisUtterance(' '));voiceConversation.stop();return;}
  if(!networkReady)return toast('Нет связи с пространством.');
  if(!state?.devices.find(d=>d.id===deviceId)?.online)return toast('Выбери подключённый компьютер.');
  dictation.cancel();voiceDraftAtStart=$('#message-input').value;$('#message-input').blur();voiceConversation.deviceId=deviceId;voiceConversation.language=voiceLanguage();voiceConversation.voiceName=roomLocalStorage.getItem('roomSpeechVoice')||'';
  // Request the microphone directly from the button gesture; recording stays in the composer.
  await voiceConversation.start();
 }catch(error){toast(error.message,'error')}finally{renderComposer()}
};
window.retryVoiceTurn=()=>voiceConversation.retry();
window.stopVoiceSpeaking=()=>{voiceConversation.stopSpeaking();renderComposer()};
window.playVoiceReply=()=>{const answer=chat?.messages.findLast(m=>m.role==='assistant'&&m.status==='completed');if(answer){voiceConversation.language=voiceLanguage();voiceConversation.voiceName=roomLocalStorage.getItem('roomSpeechVoice')||'';voiceConversation.speak(answer.text)}};
window.sendVoiceTurn=async()=>{
 const input=$('#message-input');if(!input||!input.value.trim()||sendingMessage)return;
 const text=input.value.trim(),generation=voiceConversation.generation;voiceConversation.stopSpeaking();
 if(voiceConversation.outgoing?.text!==text)voiceConversation.outgoing={text,id:crypto.randomUUID()};
 await sendMessage({text,attachments:[...attachments],messageId:voiceConversation.outgoing.id,voiceGeneration:generation});renderVoiceConversation();
};
window.toggleVoiceInput=()=>{if(!isPhoneWebClient||chatLoading||sendingMessage||['permission','transcribing'].includes(voiceConversation.mode))return;if(dictation.active){void dictation.finish();return;}void recordVoiceTurn()};
window.useSystemDictation=()=>{voiceConversation.cancel();closeDialog();dictation.start(voiceLanguage());renderVoiceInput()};
window.showVoiceSettings=async()=>{
 dictation.cancel();voiceConversation.cancel();clearTimeout(voiceStatusTimer);
 const chosen=deviceId;dialog('Голосовой режим',`<p>Записывай реплики, получай ответ в той же сессии и слушай его на телефоне.</p><div class="form-row"><label for="voice-language">Язык</label><select id="voice-language"><option value="ru-RU">Русский</option><option value="uk-UA">Українська</option></select></div><div class="form-row"><label for="speech-voice">Голос ответа</label><select id="speech-voice"></select></div><p>Во время диктовки текст появляется в поле ввода с задержкой. После остановки проверь его и нажми стрелку отправки.</p><p>Распознавание: ${esc(state.devices.find(d=>d.id===chosen)?.name||'Выбери компьютер')}. Запись передаётся через Team Room на этот компьютер, распознаётся локально и не сохраняется в файлы проекта.</p><p id="voice-engine-status" role="status">Проверяю движок…</p><button id="voice-prepare" class="primary-button" hidden>Подготовить голос на компьютере</button><p class="muted">Первая подготовка скачивает бесплатный движок Whisper и модель. Требуется Python 3.9+ на выбранном компьютере. Отдельный API не нужен. Озвучивание использует доступные голоса телефона.</p><button onclick="useSystemDictation()">Обычная диктовка телефона</button><button onclick="openVoiceConversation()">Начать голосовой разговор</button>`);
 const voiceSettingsToken=crypto.randomUUID();$('#dialog').dataset.voiceSettingsToken=voiceSettingsToken;
 const fillVoices=()=>{const select=$('#speech-voice');if(!select)return;const list=window.speechSynthesis?.getVoices().filter(v=>v.lang.startsWith(voiceLanguage().slice(0,2)))||[];select.innerHTML='<option value="">Голос телефона по умолчанию</option>'+list.map(v=>`<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('');select.value=roomLocalStorage.getItem('roomSpeechVoice')||'';select.onchange=e=>roomLocalStorage.setItem('roomSpeechVoice',e.target.value)};
 $('#voice-language').value=voiceLanguage();$('#voice-language').onchange=e=>{roomLocalStorage.setItem('roomVoiceLanguage',e.target.value);fillVoices()};fillVoices();window.speechSynthesis?.addEventListener('voiceschanged',fillVoices,{once:true});
 const update=async()=>{if(!$('#voice-engine-status')||$('#dialog').dataset.voiceSettingsToken!==voiceSettingsToken||chosen!==deviceId)return;try{const status=await api('/voice/status?device='+encodeURIComponent(chosen));if(!$('#voice-engine-status')||$('#dialog').dataset.voiceSettingsToken!==voiceSettingsToken||chosen!==deviceId)return;$('#voice-engine-status').textContent=status.state==='ready'?'Whisper готов. Можно говорить.':status.state==='preparing'?'Подготавливаю движок и скачиваю модель…':status.error||'Движок ещё не подготовлен.';$('#voice-prepare').hidden=status.state==='ready';$('#voice-prepare').disabled=status.state==='preparing';if(status.state==='preparing')voiceStatusTimer=setTimeout(update,5000);}catch(error){if($('#dialog').dataset.voiceSettingsToken===voiceSettingsToken&&$('#voice-engine-status'))$('#voice-engine-status').textContent=error.message;}};
 $('#voice-prepare').onclick=async()=>{const button=$('#voice-prepare');button.disabled=true;try{await api('/voice/prepare','POST',{deviceId:chosen});await update()}catch(error){toast(error.message,'error');button.disabled=false}};void update();
};
document.addEventListener('visibilitychange',()=>{if(document.hidden){dictation.cancel();voiceConversation.cancel();}});window.addEventListener('pagehide',()=>{dictation.cancel();voiceConversation.cancel();});
const providerName=p=>/claude/i.test(p||'')?'Claude':'Codex';
const streamedRuns=new Map(),pendingSends=new Map();
let chatLoading=false,chatLoadError='',chatOpenGeneration=0,pendingScrollRestore=null;
let appliedRouteSelection='';
const chatCache=new Map(),chatLoads=new Map(),actionLoads=new Map(),actionCache=new Map();
let recoveryErrors=new Set(),lastStateReadAt=0;
function rememberView(){
 const view={projectId,chatId:selectedId};
 try{const key='roomView:'+state.me.id;roomSessionStorage.setItem(key,JSON.stringify(view));roomLocalStorage.setItem(key,JSON.stringify(view));roomLocalStorage.setItem('roomProject',projectId);roomLocalStorage.setItem('roomChat',selectedId);}catch{}
 const url=new URL(location.href);url.searchParams.set('project',projectId);url.searchParams.set('chat',selectedId);history.replaceState(history.state,'',url);announcePaneView(projectId,selectedId);splitWorkspace?.update();
}
let scrollSaveAt=0;function saveScroll(){if(Date.now()-scrollSaveAt<250)return;scrollSaveAt=Date.now();const pane=$('#messages');if(!pane||!chat||chat.id!==selectedId||chatLoading)return;try{roomSessionStorage.setItem('roomScroll:'+state.me.id+':'+chat.id,JSON.stringify({top:pane.scrollTop,bottom:pane.scrollHeight-pane.clientHeight-pane.scrollTop<110}));}catch{}}
function readScroll(chatId){try{return JSON.parse(roomSessionStorage.getItem('roomScroll:'+state.me.id+':'+chatId)||'null')}catch{return null}}
let previewTimer,composerFrame,streamFrame,historyBefore=null;
const dirtyChats=new Set();
const sidebarSections=new SidebarSections({storage:roomLocalStorage});
const sidebarHover=new SidebarHover({onChange:()=>{syncSidebarToggleLabels();sidebarSections.layout();}});
const workspaceContext=()=>({userId:state?.me.id,projectId,chatId:selectedId,projects:state?.projects||[],chats:state?.chats||[],sidebarCollapsed:$('.app')?.classList.contains('sidebar-collapsed')||false});
const splitWorkspace=isEmbeddedPane?null:new SplitWorkspace({getContext:workspaceContext,chooseChat:()=>sessionPicker.open('right'),notice:message=>toast(message),onNeedsRefresh:()=>void refreshState(),onAuthExpired:()=>{clearAuthView();renderAuth();}});
const sessionPicker=new SplitSessionPicker({getData:workspaceContext,showDialog:(title,body)=>dialog(title,body),closeDialog:()=>closeDialog(),onSelect:(target,destination)=>{if(destination==='right')splitWorkspace?.open(target);else if(target.chatId)void openChat(target.chatId);else void selectProject(target.projectId);}});
function contextSessionRows(){
 const chats=(state?.chats||[]).filter(c=>!c.archivedAt);
 if(chat?.id){const index=chats.findIndex(c=>c.id===chat.id);if(index>=0)chats[index]={...chats[index],...chat};else chats.unshift(chat);}
 const rows=chats.flatMap(c=>{
  const sessions=c.sessionContexts?.length?c.sessionContexts:[{key:'pending',provider:c.provider||'codex',deviceId:c.executionDeviceId,accountId:'',context:null}];
  return sessions.map(session=>{const device=state?.devices.find(d=>d.id===session.deviceId),account=device?.accounts?.find(a=>a.id===session.accountId&&a.provider===session.provider);
   return {...session,chatId:c.id,title:c.title||'Новая сессия',projectName:state?.projects.find(p=>p.id===c.projectId)?.title||state?.projects.find(p=>p.id===c.projectId)?.name||'',deviceName:device?.name||session.deviceId||'',accountName:account?.name||account?.label||(session.accountId?'Дополнительный аккаунт':'Основной аккаунт'),selected:c.id===selectedId&&session.provider===provider&&(!session.deviceId||session.deviceId===deviceId)&&(session.accountId||'')===selectedAccountId()};});
 });
 return rows.sort((a,b)=>Number(b.selected)-Number(a.selected));
}
const usagePopover=new UsagePopover({getData:()=>{const catalog=catalogData[subscriptionKey()],model=catalog?.models?.find(m=>m.model===selectedModel);return {catalog,sessions:contextSessionRows(),route:{chatId:selectedId,deviceId,deviceName:state?.devices.find(d=>d.id===deviceId)?.name,provider,accountId:selectedAccountId(),accountName:subscriptionName(),model:selectedModel,modelName:model?modelLabel(model):selectedModel},online:networkReady&&state?.devices.find(d=>d.id===deviceId)?.online,busy:catalogBusy};},getAnchor:()=>$('#usage-button'),onRefresh:()=>loadCatalog(true),onDetails:()=>showProviderDetails()});
const chatTools=new ChatTools({
 context:()=>({account:state?.me.id,chatId:chat?.id,projectId,title:chat?.title,projects:state?.projects||[],messages:chat?.messages||[],name:state?.me.name,owner:state?.me.owner}),
 api,dialog:(title,body)=>dialog(title,body,isPhoneWebClient),feedback:dialogFeedback,close:()=>closeDialog(),notice:message=>toast(message),storage:roomLocalStorage,
 openMatch:match=>openSearchMatch(match),openBranch:(result,question)=>openChatBranch(result,question),queueChanged:(result,id)=>applyQueueMutation(result,id),compose:(text,id)=>composeReview(text,id),
 new:()=>{const text=$('#message-input')?.value||draft,saved=[...attachments];newChat();draft=text;attachments=saved;if($('#message-input'))$('#message-input').value=text;renderAttachments();},focus:()=>$('#message-input')?.focus(),sidebar:()=>toggleSidebar(),send:()=>{if(!$('#send-button')?.disabled)void sendMessage();}
});
window.showSearch=()=>chatTools.search();window.findInChat=()=>chatTools.search(true);window.showShortcuts=()=>chatTools.help();window.forkChat=id=>chatTools.fork(id||'');window.askSideQuestion=id=>chatTools.fork(id||'',true);window.showQueueTools=id=>chatTools.queue(id||'');window.showFileReview=path=>chatTools.review(path||'');
function composeReview(text,id=chat?.id){
 if(id&&chat?.id!==id)return toast('Открой исходный чат, чтобы добавить замечание.');
 const input=$('#message-input');if(!input)return;draft=[input.value.trimEnd(),text].filter(Boolean).join('\n\n');input.value=draft;pendingMessageId=null;renderComposer();input.focus({preventScroll:true});
}
async function openSearchMatch(match){
 const account=state?.me.id,started=chatOpenGeneration;if(!account)return;
 try{
  if(!state.chats.some(c=>c.id===match.chatId)){const latest=await api('/state');if(state?.me.id!==account||chatOpenGeneration!==started)return;state=latest;renderChatList();}
  await openChat(match.chatId);if(state?.me.id!==account||chat?.id!==match.chatId)return;
  const generation=chatOpenGeneration,before=historyBefore;
  if(match.messageId&&!chat.messages.some(m=>m.id===match.messageId)){
   const result=await api('/chats/'+encodeURIComponent(match.chatId)+'?view=compact&limit=80&around='+encodeURIComponent(match.messageId),'GET',undefined,{timeoutMs:12000});
   if(state?.me.id!==account||generation!==chatOpenGeneration||before!==historyBefore||chat?.id!==match.chatId)return;
   chat=cacheChat(protectLiveReplies(result));historyBefore=chat.history?.hasLater?chat.history.end:null;pendingScrollRestore=null;renderMessages();
  }
  const article=$('#messages')?.querySelector('[data-source-message="'+CSS.escape(match.messageId||'')+'"]')||$('#messages')?.querySelector('[data-message="'+CSS.escape(match.messageId||'')+'"]');
  if(article){article.classList.add('search-match');article.scrollIntoView({block:'center',behavior:'auto'});saveScroll();}
 }catch(error){if(state?.me.id===account)toast(error.message,'error');}
}
async function openChatBranch(result,question=''){
 const account=state?.me.id,id=result.chatId||result.chat?.id;if(!account||!id)return;
 if(result.chat){cacheChat(result.chat);if(!state.chats.some(c=>c.id===id))state.chats.unshift({id,projectId:result.projectId||result.chat.projectId,title:result.chat.title,owner:result.chat.owner,messageCount:result.chat.messageCount||result.chat.history?.total||result.chat.messages?.length||0});}
 renderChatList();await openChat(id);if(state?.me.id!==account||chat?.id!==id||chatLoading||chatLoadError)return;
 if(question){const input=$('#message-input');draft=question;input.value=question;renderComposer();await sendMessage({text:question,attachments:[]});}
 else toast('Ответвление создано. История исходного чата сохранена.');
}
function applyQueueMutation(result,id){
 if(!state)return;const updated=result?.chat||(result?.messages?{messages:result.messages}:null);
 if(chat?.id===id&&updated){const incoming=new Map((updated.messages||[]).map(m=>[m.id,m]));for(const m of chat.messages)if(m.followup&&incoming.has(m.id))Object.assign(m,incoming.get(m.id));if(Number.isFinite(updated.revision))chat.revision=Math.max(chat.revision||0,updated.revision);renderMessages();}
 dirtyChats.add(id);scheduleStateRefresh();
}
window.toggleSplitWorkspace=()=>{if(splitWorkspace?.enabled)splitWorkspace.close();else sessionPicker.open('right');};
window.openSessionRight=id=>{if(isEmbeddedPane)return;const item=state?.chats.find(c=>c.id===id);if(item){closeDialog();splitWorkspace.open({chatId:id,projectId:item.projectId});}};
window.choosePaneSession=()=>sessionPicker.open('self');
window.toggleUsagePopover=()=>{if($('#dialog')?.open)closeDialog();usagePopover.toggle();};
window.showWeeklyQuota=()=>{if($('#dialog')?.open)closeDialog();usagePopover.toggle($('#weekly-quota-notice'));};
function renderWeeklyQuotaNotice(){
 const button=$('#weekly-quota-notice');if(!button)return;
 const catalog=catalogData[subscriptionKey()],online=networkReady&&navigator.onLine!==false&&Boolean(state?.devices.find(device=>device.id===deviceId)?.online);
 const quota=weeklyQuotaState(catalog,{provider,model:selectedModel,online});
 if(!quota.warning){button.hidden=true;button.removeAttribute('title');return;}
 const label=`${quota.window.windowType&&quota.window.windowType!=='seven_day'?quota.window.label:'Неделя'} · осталось ${formatUsagePercent(quota.remainingPercent)} · использовано ${formatUsagePercent(quota.usedPercent)}`;
 const scope=[providerName(provider),subscriptionName(),quota.window.group].filter(Boolean).join(' · '),condition=quota.saved?'Сохранённые данные':'';
 const html=`<svg class="weekly-quota-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 5.5v5m0 3h.01" stroke-linecap="round"/></svg><span class="weekly-quota-copy"><strong>${esc(label)}</strong>${condition?`<small class="weekly-quota-saved">${condition}</small>`:''}</span><span class="weekly-quota-chevron" aria-hidden="true">›</span>`;
 button.hidden=false;button.dataset.saved=String(quota.saved);button.dataset.level=quota.usedPercent>=100?'exhausted':'warning';
 button.title=[label,scope,condition,quota.updatedAt?`Получено: ${new Date(quota.updatedAt).toLocaleString('ru-RU')}`:'Время получения неизвестно'].filter(Boolean).join('\n');
 button.setAttribute('aria-label',[label,scope,condition,'Открыть лимиты подписки'].filter(Boolean).join('. '));
 if(button.innerHTML!==html)button.innerHTML=html;
}
function renderUsageTrigger(){
 renderWeeklyQuotaNotice();
 const button=$('#usage-button');if(!button)return;const meter=usageMeterState(catalogData[subscriptionKey()]),known=meter.known&&meter.usedPercent!==null,value=known?meter.usedPercent:0;
 button.dataset.level=known&&value>=95?'danger':known&&value>=80?'warning':'normal';button.dataset.stale=String(meter.stale);
 button.setAttribute('aria-label','Лимиты '+providerName(provider)+(known?' · использовано '+Math.round(value)+'%':''));button.title=button.getAttribute('aria-label');
 const currentContext=contextSessionRows().find(row=>row.selected)?.context,m=contextMeter(currentContext);
 if(m.known){const label=`Контекст сессии: ${m.usedTokens.toLocaleString('ru-RU')} / ${m.budgetTokens.toLocaleString('ru-RU')} токенов · ${Math.round(m.percent)}%`;button.title+=' · '+label;button.setAttribute('aria-label',button.title);}
 const html=`<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="6.5" stroke="currentColor" stroke-opacity=".25" stroke-width="2.5"/><circle cx="10" cy="10" r="6.5" stroke="currentColor" stroke-width="2.5" pathLength="100" stroke-dasharray="${value} 100" transform="rotate(-90 10 10)"/>${known?'':'<path d="M10 6v4m0 3h.01" stroke="currentColor" stroke-linecap="round"/>'}</svg><span class="usage-context-label">${currentContext?.compacting?'Сжимаю…':m.known?Math.round(m.percent)+'%':'—'}</span>`;
 if(button.innerHTML!==html)button.innerHTML=html;usagePopover.update();
}
function sidebarIcon(){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/></svg>';}
function syncSidebarToggleLabels(){
 const app=$('.app');if(!app)return;const peek=!compactScreen.matches&&app.classList.contains('sidebar-peek');
 const expanded=compactScreen.matches?app.classList.contains('sidebar-open'):!app.classList.contains('sidebar-collapsed')||peek;
 for(const button of document.querySelectorAll('[data-sidebar-toggle]')){button.setAttribute('aria-expanded',String(expanded));button.setAttribute('aria-label',peek?'Закрепить список сессий':expanded?'Скрыть список сессий':'Показать список сессий');}
}
function syncWorkspaceControls({restore=false}={}){
 const app=$('.app');if(!app||!state)return;
 if(restore&&!isEmbeddedPane&&!compactScreen.matches){let collapsed=false;try{collapsed=roomLocalStorage.getItem('roomSidebar:'+state.me.id)==='hidden';}catch{}app.classList.toggle('sidebar-collapsed',collapsed);}
 sidebarHover.sync();syncSidebarToggleLabels();
 if(splitWorkspace){splitWorkspace.mount();splitWorkspace.update();}
 renderUsageTrigger();
}
compactScreen.addEventListener('change',()=>syncWorkspaceControls({restore:true}));
function cacheChat(value){
 chatCache.delete(value.id);chatCache.set(value.id,value);if(chatCache.size>5)chatCache.delete(chatCache.keys().next().value);
 clearTimeout(previewTimer);const account=state?.me.id;
 previewTimer=setTimeout(()=>{const save=()=>{if(!account||state?.me.id!==account)return;try{
  const preview={...value,messages:value.messages.slice(-80)};
  const saved=JSON.stringify({at:Date.now(),chat:preview});if(saved.length<800000)roomSessionStorage.setItem('roomPreview:'+account,saved);
 }catch{}};if(window.requestIdleCallback)requestIdleCallback(save,{timeout:2000});else setTimeout(save,0)},350);
 return value;
}
function scheduleComposer(){if(composerFrame)return;composerFrame=requestAnimationFrame(()=>{composerFrame=0;renderComposer()})}
const liveReplies=new Map(),completedReplyReads=new Map();
let renderedChatView=null,replyWatchdogRequest=null,replyWatchdogLastAt=0,replyProgressUnsupported=false;
const replyKey=(chatId,messageId)=>chatId+':'+messageId;
function rememberLiveReply(key,value){liveReplies.delete(key);liveReplies.set(key,value);if(liveReplies.size>40)liveReplies.delete(liveReplies.keys().next().value);return value;}
const replyMessages=value=>[...(value?.messages||[]),...(value?.replyReferences||[])];
function replyBoundaries(value){return Array.isArray(value?.replyBoundaries)?value.replyBoundaries.map(b=>({messageId:b.messageId,offset:b.offset})):[];}
function acceptReplyDelta(event){
 if(!event.messageId||typeof event.text!=='string'&&!event.delta)return null;
 const key=replyKey(event.chatId,event.messageId),previous=liveReplies.get(key),message=chat?.id===event.chatId?replyMessages(chat).find(m=>m.id===event.messageId):null;
 if(previous?.final||message&&(message.role!=='assistant'||message.status!=='running'))return null;
 if(event.runId&&chat?.id===event.chatId&&chat.run?.id&&chat.run.id!==event.runId)return null;
 if(previous?.runId&&event.runId&&previous.runId!==event.runId)return null;
 if(Number.isFinite(event.streamRevision)&&Number.isFinite(previous?.streamRevision)&&event.streamRevision<=previous.streamRevision)return null;
 const current=previous?.text||message?.text||'';
 let text=event.text;
 if(event.delta){
  const patch=event.delta;
  if(!Number.isSafeInteger(patch.offset)||patch.offset<0||typeof patch.text!=='string'||!Number.isFinite(patch.baseRevision)||current.length!==patch.offset||previous?.streamRevision!==patch.baseRevision){requestReplyRecovery(event);return null;}
  text=current+patch.text;
 }
 // Legacy deltas are cumulative. Ignore an older prefix received after a read.
 if(text.length<current.length&&current.startsWith(text))return null;
 return rememberLiveReply(key,{runId:event.runId||previous?.runId||chat?.run?.id||null,streamRevision:event.streamRevision??previous?.streamRevision,knownRevision:Math.max(previous?.knownRevision||0,chat?.id===event.chatId?chat.revision||0:0),text,replyBoundaries:replyBoundaries(Array.isArray(event.replyBoundaries)?event:previous||message),at:Date.now(),final:false});
}
let replyRecoveryAt=0;
function requestReplyRecovery(event){
 if(chat?.id!==event.chatId||selectedId!==event.chatId||event.runId&&chat.run?.id!==event.runId)return;
 const stamp=Date.now();if(replyRecoveryAt&&stamp-replyRecoveryAt<2000)return;replyRecoveryAt=stamp;
 void reconcileActiveReply({force:true});
}
function protectLiveReplies(value,{readStartedAt}={}){
 const incomingRevision=value.revision,serverRead=Number.isFinite(readStartedAt);
 if(chat?.id===value.id&&Number.isFinite(incomingRevision)&&Number.isFinite(chat.revision)&&incomingRevision<chat.revision){for(const field of ['revision','updatedAt','run','approvals','route','pendingRoute','executionDeviceId'])value[field]=chat[field];}
 for(const message of replyMessages(value)){
  if(message.role!=='assistant')continue;
  const key=replyKey(value.id,message.id),live=liveReplies.get(key);if(!live)continue;
  if(live.final){
   const knownRevision=Number.isFinite(live.revision)?live.revision:live.knownRevision;
   const newerTerminalRead=serverRead&&message.status&&message.status!=='running'&&Number.isFinite(incomingRevision)&&Number.isFinite(knownRevision)&&incomingRevision>knownRevision&&readStartedAt>=(live.finalBoundaryAt||live.at||0);
   if(newerTerminalRead){rememberLiveReply(key,{...live,text:message.text||'',replyBoundaries:replyBoundaries(message),status:message.status,error:message.error||null,revision:incomingRevision,knownRevision:incomingRevision,at:Date.now(),finalBoundaryAt:readStartedAt});continue;}
   message.text=live.text;message.replyBoundaries=replyBoundaries(live);message.status=live.status||'completed';if(live.error)message.error=live.error;else delete message.error;continue;
  }
  if(serverRead&&message.status&&message.status!=='running'){
   // The original server revision, before merging newer metadata, orders final reads.
   rememberLiveReply(key,{...live,text:message.text||'',replyBoundaries:replyBoundaries(message),status:message.status,error:message.error||null,revision:incomingRevision,knownRevision:Number.isFinite(incomingRevision)?incomingRevision:live.knownRevision,final:true,at:Date.now(),finalBoundaryAt:readStartedAt});continue;
  }
  if(live.runId&&value.run?.id&&value.run.id!==live.runId)continue;
  const text=message.text||'',knownRevision=Number.isFinite(incomingRevision)?Math.max(incomingRevision,live.knownRevision||0):live.knownRevision;
  // A cumulative reply may be corrected, not only appended. An HTTP snapshot
  // already in flight, or an older progress sequence, must not undo that correction.
  const staleStream=Number.isFinite(value.streamRevision)&&Number.isFinite(live.streamRevision)&&value.streamRevision<live.streamRevision;
  if(staleStream||serverRead&&readStartedAt<(live.at||0)){message.text=live.text;message.replyBoundaries=replyBoundaries(live);rememberLiveReply(key,{...live,knownRevision});continue;}
  if(live.text.length>text.length&&live.text.startsWith(text)){message.text=live.text;message.replyBoundaries=replyBoundaries(live);rememberLiveReply(key,{...live,knownRevision});}
  else rememberLiveReply(key,{...live,text,replyBoundaries:replyBoundaries(message),knownRevision,at:live.at});
 }
 return value;
}

let streamPaintTimer,streamPaintAt=0,pendingStreamPaint=null;
function cancelStreamPaint(){clearTimeout(streamPaintTimer);streamPaintTimer=null;if(streamFrame)cancelAnimationFrame(streamFrame);streamFrame=0;pendingStreamPaint=null;}
function scheduleStream(message){
 if(uiBackground())return;
 const chatId=chat?.id;if(!chatId)return;
 pendingStreamPaint={chatId,messageId:message.id,account:state?.me.id,generation:chatOpenGeneration,before:historyBefore};
 if(streamPaintTimer||streamFrame)return;
 // Parsing the growing reply every display frame blocks typing in long chats.
 const queueFrame=()=>{streamPaintTimer=null;streamFrame=requestAnimationFrame(()=>{
  streamFrame=0;const pending=pendingStreamPaint;pendingStreamPaint=null;
  if(!pending||state?.me.id!==pending.account||chatOpenGeneration!==pending.generation||historyBefore!==pending.before||chat?.id!==pending.chatId||selectedId!==pending.chatId)return;
  const pane=$('#messages'),current=replyMessages(chat).find(m=>m.id===pending.messageId);if(!pane||!current)return;
  const painted=renderedChatView?.id===chat.id&&[...renderedChatView.messages,...renderedChatView.replyReferences].find(m=>m.id===current.id),boundaries=JSON.stringify(replyBoundaries(current));
  if(painted?.text===current.text&&painted.replyBoundaries===boundaries)return;
  if(readerBusy(pane)){queueReadingPaint(pane);return;}
  const rows=displayMessages().filter(m=>(m._sourceMessageId||m.id)===current.id),nodes=[...pane.querySelectorAll('[data-source-message="'+CSS.escape(current.id)+'"]')];
  if(painted?.replyBoundaries!==boundaries||rows.length!==nodes.length||rows.some((row,index)=>row.id!==nodes[index]?.dataset.message)){renderMessages();streamPaintAt=performance.now();return;}
  const position=captureReadingPosition(pane);
  for(let index=0;index<rows.length;index++){const target=nodes[index].querySelector('.message-text');if(target){target.innerHTML=assistantText(rows[index])||(rows[index].status==='running'?'<span class="muted">'+esc(pendingResponseText())+'</span>':'');messageHtmlCache.delete(nodes[index]);}}
  markRenderedReply(current);streamPaintAt=performance.now();renderRunActivity();restoreReadingPosition(pane,position);
 });};
 const delay=Math.max(0,90-(performance.now()-streamPaintAt));if(delay)streamPaintTimer=setTimeout(queueFrame,delay);else queueFrame();
}

function readChatPreview(chatId){try{const saved=JSON.parse(roomSessionStorage.getItem('roomPreview:'+state.me.id)||'null');if(saved?.chat.id===chatId&&Date.now()-saved.at<8*60*60*1000)return {...saved.chat,run:null,approvals:[]};}catch{}return null;}
const chatReadOrders=new Map(),acceptedChatReads=new Map();
const chatReadControllers=new Map();
function cancelChatReads(chatId='',before=null){
 const keep=chatId?chatId+':'+(before??'latest'):'';
 for(const [key,controller]of chatReadControllers)if(key!==keep){controller.abort();chatReadControllers.delete(key);chatLoads.delete(key);}
}
async function fetchChat(chatId,before=historyBefore,{fresh=false}={}){
 if(chatId===selectedId)cancelChatReads(chatId,before);
 const key=chatId+':'+(before??'latest');if(!fresh&&chatLoads.has(key))return chatLoads.get(key);
 const account=state?.me.id,readStartedAt=Date.now(),order=(chatReadOrders.get(key)||0)+1;chatReadOrders.set(key,order);
 const controller=new AbortController();if(fresh)chatReadControllers.get(key)?.abort();chatReadControllers.set(key,controller);
 const request=api('/chats/'+chatId+'?view=compact&limit=80'+(before==null?'':'&before='+before),'GET',undefined,{signal:controller.signal}).then(value=>{
  if(state?.me.id!==account)return value;
  if(order<chatReadOrders.get(key)){const newer=chatLoads.get(key);if(newer&&newer!==request)return newer;const accepted=acceptedChatReads.get(key);if(accepted&&accepted.order>order)return accepted.value;}
  if(!value.history){const total=value.messages.length,start=Math.max(0,total-80);value.messages=value.messages.slice(start);value.history={start,end:total,total,hasEarlier:start>0,hasLater:false};}
  const result=cacheChat(protectLiveReplies(value,{readStartedAt}));acceptedChatReads.delete(key);acceptedChatReads.set(key,{order,value:result});if(acceptedChatReads.size>10)acceptedChatReads.delete(acceptedChatReads.keys().next().value);return result;
 }).catch(error=>{const newer=chatLoads.get(key);if(controller.signal.aborted&&state?.me.id===account&&newer&&newer!==request&&order<chatReadOrders.get(key))return newer;throw error;}).finally(()=>{if(chatLoads.get(key)===request)chatLoads.delete(key);if(chatReadControllers.get(key)===controller)chatReadControllers.delete(key)});
 chatLoads.set(key,request);return request;
}

window.historyPage=async before=>{if(chatLoading||!chat)return;cancelStreamPaint();const id=selectedId,generation=chatOpenGeneration;chatLoading=true;historyBefore=before;renderComposer();try{const value=await fetchChat(id,before);if(selectedId!==id||chatOpenGeneration!==generation)return;chat=value;pendingScrollRestore={bottom:before==null,top:0};}catch(e){toast(e.message,'error')}finally{if(selectedId===id&&chatOpenGeneration===generation){chatLoading=false;renderMessages()}}};
const permissionNames={manual:'Ручной режим',auto:'Одобрять за меня',full:'Полный доступ'};
function executionPreference(){return roomLocalStorage.getItem('roomExecutionMode:'+state?.me.id)==='plan'?'plan':'build';}
function chosenExecutionMode(){return chat?.kind==='side'?'build':chat?.pendingRoute?.executionMode||chat?.route?.executionMode||executionMode||'build';}
function renderExecutionMode(){const button=$('#execution-mode-button');if(button){button.textContent=chat?.kind==='side'?'Вопрос отдельно':chosenExecutionMode()==='plan'?'План':'Работа';button.dataset.mode=chosenExecutionMode();button.disabled=executionModeSaving||chatLoading||chat?.kind==='side';button.title=chosenExecutionMode()==='plan'?'Планирование без изменения файлов':'Работа с проектом';}}
window.showExecutionMode=()=>{const side=chat?.kind==='side';dialog('Режим работы',`<p>Планирование разбирает задачу и составляет план без изменения файлов. Работа выполняет изменения с выбранными разрешениями.</p>${chat?.run?'<p>Текущий ответ продолжится в прежнем режиме. Новый режим применяется со следующего запроса.</p>':''}<div class="execution-mode-choices" id="execution-mode-choices"><button onclick="chooseExecutionMode('plan')" aria-pressed="${chosenExecutionMode()==='plan'}" ${side?'disabled':''}><strong>План</strong><span>Изучить проект и предложить шаги</span></button><button onclick="chooseExecutionMode('build')" aria-pressed="${chosenExecutionMode()==='build'}" ${side?'disabled':''}><strong>Работа</strong><span>Выполнять задачу и менять файлы</span></button></div>${side?'<p>Отдельный вопрос всегда работает с доступом только для чтения.</p>':''}`);};
window.chooseExecutionMode=async value=>{
 if(!['plan','build'].includes(value)||executionModeSaving||chat?.kind==='side')return;
 const id=chat?.id,account=state?.me.id,generation=chatOpenGeneration,panel=$('#execution-mode-choices'),own=()=>state?.me.id===account&&panel?.isConnected&&$('#execution-mode-choices')===panel;
 executionModeSaving=true;renderExecutionMode();panel?.querySelectorAll('button').forEach(button=>button.disabled=true);if(own())dialogFeedback('Сохраняю режим работы…');
 try{if(id)await switchChatRoute(id,{executionMode:value});if(state?.me.id!==account)return;roomLocalStorage.setItem('roomExecutionMode:'+account,value);if(generation===chatOpenGeneration&&(chat?.id||'')===(id||''))executionMode=value;const close=own();if(close)closeDialog();renderComposer();if(close)toast(chat?.run?'Режим сохранён для следующего запроса.':value==='plan'?'Планирование включено.':'Режим работы включён.');}
 catch(error){if(own())dialogFeedback(error.message,'error');else if(state?.me.id===account&&chat?.id===id&&!$('#dialog').open)toast(error.message,'error');}
 finally{executionModeSaving=false;if(state)renderExecutionMode();if(own())panel.querySelectorAll('button').forEach(button=>button.disabled=false);}
};
window.implementPlan=async id=>{if(!chat||chat.run||sendingMessage||chatLoading||chat.kind==='side')return;const target=chat.id,account=state?.me.id,generation=chatOpenGeneration;await chooseExecutionMode('build');if(state?.me.id===account&&generation===chatOpenGeneration&&chat?.id===target&&chosenExecutionMode()==='build')await sendMessage({text:'План согласован. Начни реализацию плана из ответа '+id+'. Проверь актуальные файлы и выполни шаги.',attachments:[]});};
function chosenPermission(){return chat?.pendingRoute?.permissionMode||chat?.route?.permissionMode||roomLocalStorage.getItem('roomPermissions:'+state?.me.id+':'+provider)||'manual'}
function applyChatRoute(value){
 if(!value||routeSwitchRequests.has(value.id))return;
 const previousScope=subscriptionKey();
 const route=value.pendingRoute||value.route;executionMode=route?.executionMode||'build';const chosen=value.pendingRoute?.deviceId||value.executionDeviceId||route?.deviceId||value.run?.deviceId||value.importSource?.deviceId;
 if(route?.provider)provider=route.provider;else if(value.provider)provider=value.provider;
 if(chosen)deviceId=chosen;else if(window.teamRoomNativeMac)deviceId=localExecutionDeviceId();
 if(route)rememberAccount(route.accountId,deviceId,provider);
 roomLocalStorage.setItem('teamProvider',provider);if(deviceId)roomLocalStorage.setItem('roomDevice',deviceId);
 const scope=subscriptionKey(),selection=JSON.stringify([value.id,scope,route?.model||'',route?.effort||'',route?.executionMode||'build']),changed=selection!==appliedRouteSelection;
 if(changed&&route?.model&&modelFitsProvider(route.model,provider)){roomLocalStorage.setItem(modelKey(),route.model);roomLocalStorage.setItem('roomEffort_'+deviceId+'_'+provider+'_'+route.model+(selectedAccountId()?'_'+selectedAccountId():''),route.effort||'');}
 appliedRouteSelection=selection;
 // A cached conversation may have a different provider/account than the previous
 // composer. Replace its choices immediately; a slow read must not show Opus on Codex.
 if(previousScope!==scope){requestGeneration++;catalogBusy=false;}
 if($('#model-picker')&&(previousScope!==scope||changed&&route?.model))renderCatalogChoices(catalogData[scope],{pending:!catalogData[scope]?.models?.length||Boolean(catalogData[scope]?.refreshPending)});
 if($('#provider-picker'))$('#provider-picker').value=provider;renderDevicesPicker();
}
window.addEventListener('pagehide',saveScroll);

let stateRefreshTimer;
function scheduleStateRefresh(){if(uiBackground()||stateRefreshTimer)return;stateRefreshTimer=setTimeout(()=>{stateRefreshTimer=null;if(!uiBackground())void refreshState()},150)}
const transferDetailView={runId:'',open:false};
const runFilePhase=run=>Boolean(run&&(['preparing-files','syncing-files','saving'].includes(run.phase)||run.phase==='starting'&&run.transfer));
function runStageLabel(run){
 if(!run)return '';
 if(run.phase==='starting')return 'запускается';
 if(run.phase==='preparing-files'||run.phase==='syncing-files')return 'передача файлов';
 if(run.phase==='saving')return 'сохранение результатов';
 if(run.phase==='waiting')return 'ожидает';
 if(run.phase==='reconnecting'||run.recovering||run.connectionLost)return 'восстанавливает связь';
 return 'работает';
}
function pendingResponseText(){
 const run=chat?.run;
 if(runFilePhase(run))return run.phase==='saving'?'Сохраняю результаты…':'Подготавливаю файлы для запуска '+providerName(run.provider)+'…';
 if(run?.phase==='starting')return 'Запускаю '+providerName(run.provider)+'…';
 return run?.text||'Подготавливаю ответ…';
}
function transferEta(seconds){
 if(!Number.isFinite(seconds)||seconds<0)return '';
 if(seconds<60)return '≈ '+Math.max(10,Math.ceil(seconds/10)*10)+' с';
 if(seconds<3600)return '≈ '+Math.ceil(seconds/60)+' мин';
 return '≈ '+Math.ceil(seconds/3600*10)/10+' ч';
}
function runTransfer(run){
 if(!runFilePhase(run))return null;
 const source=run.transfer&&typeof run.transfer==='object'?run.transfer:{};
 const value=key=>Number.isFinite(source[key])&&source[key]>=0?source[key]:null;
 const totalFiles=value('totalFiles'),totalBytes=value('totalBytes');
 const completedFiles=value('completedFiles'),transferredBytes=value('transferredBytes');
 const doneFiles=completedFiles===null?null:Math.min(completedFiles,totalFiles??completedFiles);
 const doneBytes=transferredBytes===null?null:Math.min(transferredBytes,totalBytes??transferredBytes);
 const saving=run.phase==='saving'||source.direction==='upload';
 const preparing=source.stage==='preparing'||run.phase==='preparing-files';
 const finalizing=source.stage==='finalizing';
 const title=preparing?'Подготавливаю файлы':finalizing?(saving?'Завершаю сохранение':'Проверяю переданные файлы'):saving?'Сохраняю результаты':'Передаю файлы';
 const parts=[];
 if(totalFiles!==null)parts.push(doneFiles!==null?doneFiles+' из '+totalFiles+' файлов':totalFiles+' файлов');
 if(totalBytes!==null)parts.push(doneBytes!==null?fmtBytes(doneBytes)+' / '+fmtBytes(totalBytes):fmtBytes(totalBytes));
 const stamp=Date.parse(source.updatedAt||''),fresh=!Number.isFinite(stamp)||Date.now()-stamp<45000;
 const eta=fresh&&source.stage==='transferring'?transferEta(value('etaSeconds')):'';
 if(eta)parts.push(eta);
 if(!parts.length)parts.push(preparing?'Проверяю, какие файлы нужно перенести':'Объём передачи уточняется');
 const recent=(Array.isArray(source.recentFiles)?source.recentFiles:[]).slice(-12).map(file=>{
  if(typeof file==='string')return {path:file.slice(0,1000),status:'completed'};
  if(!file||typeof file.path!=='string')return null;
  return {path:file.path.slice(0,1000),size:Number.isFinite(file.size)&&file.size>=0?file.size:null,status:file.status==='current'?'current':'completed'};
 }).filter(Boolean);
 const currentFile=typeof source.currentFile==='string'?source.currentFile.slice(0,1000):'';
 if(currentFile&&!recent.some(file=>file.path===currentFile))recent.push({path:currentFile,status:'current'});
 return {title,detail:parts.join(' · '),currentFile,recent:recent.slice(-12),percent:totalBytes>0&&doneBytes!==null?Math.min(100,Math.max(0,doneBytes/totalBytes*100)):null,direction:saving?'upload':'download',deviceName:run.deviceName||state?.devices.find(device=>device.id===run.deviceId)?.name||'выбранный компьютер',totalFiles,totalBytes,doneFiles,doneBytes,speed:fresh?value('speedBytesPerSecond'):null,eta,stage:preparing?'preparing':finalizing?'finalizing':source.stage||'transferring'};
}
function transferActivityHtml(activity){
 const transfer=activity.transfer,open=transferDetailView.runId===chat.run.id&&transferDetailView.open;
 const timing=transfer.eta||'Время пока не оценено';
 const files=transfer.recent.length?`<ul class="transfer-file-list">${transfer.recent.map(file=>`<li><span class="transfer-file-mark" aria-hidden="true">${file.status==='current'?'→':'✓'}</span><span class="transfer-file-name">${esc(file.path)}</span>${file.size!==null&&file.size!==undefined?`<small>${esc(fmtBytes(file.size))}</small>`:''}</li>`).join('')}</ul>`:'<p class="transfer-detail-note">Список появится после проверки файлов.</p>';
 return `<div class="transfer-progress"><div class="transfer-progress-row"><div class="activity-copy"><strong>${esc(activity.title)}</strong><span>${esc(activity.detail)}</span></div><button class="transfer-details-toggle" type="button" onclick="toggleTransferDetails()" aria-expanded="${open}" aria-controls="transfer-details" aria-label="${open?'Скрыть':'Показать'} детали передачи">Детали <span aria-hidden="true">${open?'⌃':'⌄'}</span></button><span class="activity-elapsed" aria-hidden="true"></span></div>${transfer.currentFile?`<div class="transfer-current-file" title="${esc(transfer.currentFile)}">Сейчас: ${esc(transfer.currentFile)}</div>`:''}${transfer.percent!==null?`<div class="transfer-track" role="progressbar" aria-label="Передача файлов" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.floor(transfer.percent)}"><span style="width:${transfer.percent.toFixed(2)}%"></span></div>`:''}<div id="transfer-details" class="transfer-details" ${open?'':'hidden'}><div class="transfer-detail-summary"><strong>${transfer.direction==='upload'?'С компьютера':'На компьютер'}: ${esc(transfer.deviceName)}</strong><span>${esc(timing)}${transfer.speed>0?' · '+esc(fmtBytes(Math.round(transfer.speed)))+'/с':''}</span></div><p class="transfer-detail-note">${transfer.direction==='upload'?'Ответ готов. Сохраняю рабочие файлы в общем пространстве.':'Модель запустится после подготовки файлов на этом компьютере.'}</p><h4>Текущий и последние переданные файлы</h4>${files}</div></div>`;
}
window.toggleTransferDetails=()=>{if(!chat?.run||!runTransfer(chat.run))return;if(transferDetailView.runId!==chat.run.id){transferDetailView.runId=chat.run.id;transferDetailView.open=false;}transferDetailView.open=!transferDetailView.open;$('#run-activity')?.removeAttribute('data-activity-key');renderRunActivity();};
function runActivity(){
 const run=chat?.run;if(!run)return null;
 const name=providerName(run.provider)+(run.accountId&&run.accountName?' · '+run.accountName:''),worker=state?.devices.find(d=>d.id===run.deviceId);
 if(!networkReady)return {name,title:'Связь с пространством прервана',detail:'Восстанавливаем соединение. Новые действия пока не видны.',mode:'offline'};
 if(run.phase==='reconnecting'||run.recovering)return {name,title:'Восстанавливаю связь с задачей',detail:run.text||'Проверяю состояние работы на выполняющем компьютере…',mode:'waiting'};
 if(run.connectionLost||worker&&!worker.online)return {name,title:'Нет связи с выполняющим компьютером',detail:'Ждём подключения. Сохранённые ответы и файлы остаются доступны.',mode:'offline'};
 if(run.phase==='waiting'&&!chat.approvals?.length)return {name,title:name+' ожидает',detail:run.text||'Ожидает завершения текущего действия. Можно добавить сообщение.',mode:'waiting'};
 if(chat.approvals?.length){
  const questions=run.waitingFor==='question'||chat.approvals?.some(a=>a.tool==='AskUserQuestion'||a.details?.questions?.length);
  return {name,title:name+(questions?' ждёт ответа':' ждёт разрешения'),detail:questions?'Работа продолжится после твоего ответа.':'Подтверди или отклони действие в чате.',mode:'waiting',action:chat.approvals?.length?(questions?'Ответить':'Подтвердить'):''};
 }
 const transfer=runTransfer(run);if(transfer)return {name,title:transfer.title,detail:transfer.detail,mode:'transfer',transfer};
 if(run.phase==='starting')return {name,title:name+' запускается',detail:run.text||'Подготавливает контекст и запускает модель…',mode:'preparing'};
 const text=run.text||'';
 const labels={Read:'Читает файл',Glob:'Ищет файлы',Grep:'Ищет в файлах',Edit:'Редактирует файл',MultiEdit:'Редактирует файлы',Write:'Сохраняет файл',Bash:'Выполняет команду',WebSearch:'Ищет информацию',WebFetch:'Открывает страницу',commandExecution:'Выполняет команду',fileChange:'Изменяет файлы',webSearch:'Ищет информацию',agentMessage:'Готовит ответ',reasoning:'Работает над ответом',contextCompaction:'Сжимает контекст',mcpToolCall:'Работает с подключённым инструментом'};
 const tool=text.match(/^Выполняет:\s*(.+)$/)?.[1];
 let detail=tool?(labels[tool]||'Выполняет действие: '+tool):text.replace(/^(Claude|Codex) работает…$/,'Работает над ответом…');
 if(Date.now()-(streamedRuns.get(run.id)||0)<5000)detail='Пишет ответ…';
 return {name,title:name+' работает',detail:detail||'Работает над ответом…',mode:'working'};
}
function renderRunActivity(){
 const el=$('#run-activity');if(!el)return;const activity=runActivity();
 if(readerBusy()&&el.hidden!==!activity){queueReadingPaint($('#messages'));return;}
 el.hidden=!activity;if(!activity){el.dataset.activityKey='';el.classList.remove('is-transferring');transferDetailView.runId='';transferDetailView.open=false;$('#messages')?.removeAttribute('aria-busy');return;}
 el.classList.toggle('is-transferring',Boolean(activity.transfer));
 if(activity.transfer&&transferDetailView.runId!==chat.run.id){transferDetailView.runId=chat.run.id;transferDetailView.open=false;}
 $('#messages')?.setAttribute('aria-busy',activity.mode==='working'?'true':'false');
 const key=JSON.stringify(activity);if(el.dataset.activityKey!==key){const focused=el.querySelector('.transfer-details-toggle')===document.activeElement,scroll=el.querySelector('.transfer-file-list')?.scrollTop||0;el.dataset.activityKey=key;el.dataset.mode=activity.mode;el.dataset.provider=/claude/i.test(chat.run.provider)?'claude':'codex';el.innerHTML=activity.transfer?transferActivityHtml(activity):`<span class="activity-mark" aria-hidden="true"></span><div class="activity-copy"><strong>${esc(activity.title)}</strong><span>${esc(activity.detail)}</span></div>${activity.action?`<button class="activity-answer" type="button" onclick="showPendingApproval()">${esc(activity.action)}</button>`:''}<span class="activity-elapsed" aria-hidden="true"></span>`;const list=el.querySelector('.transfer-file-list');if(list)list.scrollTop=scroll;if(focused)el.querySelector('.transfer-details-toggle')?.focus({preventScroll:true});}
 const started=Date.parse(chat.run.startedAt),elapsed=Number.isFinite(started)?Math.max(0,Math.floor((Date.now()-started)/1000)):0;
 const timer=el.querySelector('.activity-elapsed');timer.textContent=elapsed<60?elapsed+' с':Math.floor(elapsed/60)+' мин '+String(elapsed%60).padStart(2,'0')+' с';timer.title='Время с начала запроса';
}
// Agent progress has its own small view: streaming updates never replace the composer.
const agentStatusNames={queued:'В очереди',running:'Работает',waiting:'Ожидает',completed:'Готово',failed:'Ошибка',stopped:'Остановлен',unknown:'Статус не подтверждён'};
const agentHtmlCache=new WeakMap();
const agentDetailCache=new Map(),agentDetailLoads=new Map(),agentDetailErrors=new Map(),agentActionErrors=new Map(),agentActionPending=new Map();
const agentProgressCache=new Map(),agentClockCache=new Map();
let agentWatchSocket,agentWatchKey='';
let agentPanelChatId='',agentPanelSelection='',agentPanelMessageId='',agentPanelReturnFocus,agentPaintFrame=0;
const agentKey=(chatId,messageId,id)=>JSON.stringify([state?.me.id||'',chatId,String(messageId),String(id)]);
const agentUpdated=value=>Date.parse(value?.updatedAt||value?.startedAt||'')||0;
const agentIsNewer=(value,other)=>Number.isSafeInteger(value?.revision)&&Number.isSafeInteger(other?.revision)&&value.revision!==other.revision?value.revision>other.revision:agentUpdated(value)>agentUpdated(other);
const agentText=(value,maximum=1200)=>String(value??'').slice(0,maximum);
function rememberAgentProgress(key,agent){
 const prior=agentProgressCache.get(key);if(prior&&agentIsNewer(prior,agent))return prior;
 const {text,events,...summary}=agent;agentProgressCache.delete(key);agentProgressCache.set(key,summary);
 const started=Date.parse(agent.startedAt),priorClock=agentClockCache.get(key),terminal=['completed','failed','stopped','unknown'].includes(agent.status);
 agentClockCache.set(key,{start:Number.isFinite(started)?started:priorClock?.start||0,end:terminal?(priorClock?.end||Date.parse(agent.updatedAt)||Date.now()):0});
 if(agentProgressCache.size>200){const oldest=agentProgressCache.keys().next().value;agentProgressCache.delete(oldest);agentClockCache.delete(oldest);}return summary;
}
function rememberAgentDetails(key,agent){
 const prior=agentDetailCache.get(key);if(prior&&agentIsNewer(prior,agent))return prior;
 rememberAgentProgress(key,agent);
 agentDetailCache.delete(key);agentDetailCache.set(key,{...agent,detailsDeferred:false});
 if(agentDetailCache.size>100)agentDetailCache.delete(agentDetailCache.keys().next().value);return agentDetailCache.get(key);
}
function agentEntries(messageId=''){
 if(!chat||chat.id!==selectedId||!chat.run)return [];
 const entries=[];
 for(const message of replyMessages(chat).slice(-80).reverse()){
  if(message.role!=='assistant'||!agentWorkflowIsCurrent({message})||messageId&&String(message.id)!==messageId)continue;
  for(const source of (Array.isArray(message.agents)?message.agents:[]).slice(0,100)){
   if(source?.id==null)continue;const key=agentKey(chat.id,message.id,source.id),progress=rememberAgentProgress(key,source),summary=agentIsNewer(progress,source)?{...source,...progress}:source,cached=agentDetailCache.get(key);
   const agent=cached?(agentIsNewer(cached,summary)?{...summary,...cached}:{...cached,...summary,text:cached.text||'',events:cached.events||[],detailsDeferred:summary.detailsDeferred&&agentIsNewer(summary,cached)}):summary;
   entries.push({key,message,summary,agent});if(entries.length>=120)return entries;
  }
 }
 return entries;
}
function agentWorkflowIsCurrent(entry){
 const run=chat?.run;if(!run||!entry)return false;
 return entry.message.runId?entry.message.runId===run.id:entry.message.status==='running'&&entry.message.id===chat.messages.findLast(m=>m.role==='assistant'&&m.status==='running')?.id;
}
function agentRunIsCurrent(entry){
 const run=chat?.run;if(!run||!entry||entry.message.status!=='running')return false;
 return entry.message.runId?entry.message.runId===run.id:entry.message.id===chat.messages.findLast(m=>m.role==='assistant'&&m.status==='running')?.id;
}
function agentControlDisabled(entry){
 const run=chat?.run,worker=state?.devices.find(device=>device.id===run?.deviceId);
 return !agentRunIsCurrent(entry)||!networkReady||worker?.online===false||run?.recovering||run?.connectionLost||['starting','reconnecting','saving'].includes(run?.phase)||chatLoading||sendingMessage||resuming||Boolean(chat?.archivedAt)||movingChats.has(selectedId)||archivingChats.has(selectedId)||agentActionPending.has(entry?.key);
}
function agentsIcon(){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v5M5 19v-5h14v5M12 14v5M8 9h8v5H8z"/><circle cx="12" cy="3" r="2"/><circle cx="5" cy="21" r="2"/><circle cx="12" cy="21" r="2"/><circle cx="19" cy="21" r="2"/></svg>';}
function agentCountCopy(entries){
 const count=status=>entries.filter(entry=>entry.agent.status===status).length,parts=[];
 const working=count('running'),waiting=count('waiting')+count('queued'),completed=count('completed'),attention=count('failed')+count('stopped')+count('unknown');
 if(working)parts.push(working+(working===1?' работает':' работают'));if(waiting)parts.push(waiting+(waiting===1?' ожидает':' ожидают'));if(completed)parts.push(completed+(completed===1?' готов':' готовы'));if(attention)parts.push(attention+' требуют внимания');return parts.join(' · ')||'Нет агентов';
}
const agentWorkflowGroups=[
 {id:'working',name:'Работают',statuses:['running']},
 {id:'waiting',name:'Ожидают',statuses:['waiting','queued']},
 {id:'completed',name:'Завершены',statuses:['completed']},
 {id:'attention',name:'Требуют внимания',statuses:['failed','stopped','unknown']}
];
const agentGroupOpen=new Map();
function agentClockText(start,end=Date.now()){
 if(!start)return '—';const seconds=Math.max(0,Math.floor((end-start)/1000)),minutes=Math.floor(seconds/60);
 return minutes<1?seconds+' с':minutes<60?minutes+'м '+String(seconds%60).padStart(2,'0')+'с':Math.floor(minutes/60)+'ч '+String(minutes%60).padStart(2,'0')+'м';
}
function agentClockHtml(entry){
 const clock=agentClockCache.get(entry.key)||{},start=clock.start||Date.parse(entry.agent.startedAt)||0,end=clock.end||0;
 return `<time class="agent-cell-time" data-agent-clock data-clock-start="${start}" data-clock-end="${end}" title="Время по событиям провайдера">${esc(agentClockText(start,end||Date.now()))}</time>`;
}
function updateAgentClocks(){
 const panel=$('#agent-panel');if(!panel?.open)return;
 for(const clock of panel.querySelectorAll('[data-agent-clock]')){const text=agentClockText(Number(clock.dataset.clockStart),Number(clock.dataset.clockEnd)||Date.now());if(clock.textContent!==text)clock.textContent=text;}
}
function agentTableMark(status){
 if(status==='completed')return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>';
 if(status==='failed')return '<span aria-hidden="true">!</span>';
 if(status==='stopped')return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M5 3v10M11 3v10"/></svg>';
 if(status==='unknown')return '<span aria-hidden="true">?</span>';
 return '<span class="agent-table-dot" aria-hidden="true"></span>';
}
function agentWorkflowHtml(entries){
 const message=entries[0].message,run=chat.run,clockStart=Date.parse(run.startedAt||message.createdAt)||0,source=chat.messages||[],index=source.findIndex(value=>value.id===message.id),request=index>=0?source.slice(0,index).findLast(value=>value.role==='user'):null;
 const task=agentText(request?.text||run.text||'',260),activity=runActivity(),recovering=activity?.mode==='offline'||run.phase==='reconnecting'||run.recovering,questions=run.waitingFor==='question'||chat.approvals?.some(a=>a.tool==='AskUserQuestion'||a.details?.questions?.length);
 const status=run.phase==='saving'?'Сохраняет результаты':recovering?'Восстанавливает связь':chat.approvals?.length?(questions?'Ожидает ответа':'Ожидает разрешения'):activity?.mode==='waiting'?'Ожидает завершения действий':run.phase==='starting'?'Запускается':'Работает';
 const stopDisabled=!networkReady||chatLoading||sendingMessage||resuming||run.phase==='saving';
 const groups=agentWorkflowGroups.map(group=>{
  const own=entries.filter(entry=>group.statuses.includes(agentStatusNames[entry.agent.status]?entry.agent.status:'unknown'));if(!own.length)return '';
  const groupKey=JSON.stringify([run.id,message.id,group.id]),open=agentGroupOpen.get(groupKey)!==false;
  const rows=own.map(entry=>{const agent=entry.agent,status=agentStatusNames[agent.status]?agent.status:'unknown',name=agentText(agent.name||'Агент',120),model=agentText(agent.model||'',80);
   return `<button type="button" class="agent-table-row" data-agent-action="select" data-agent-key="${esc(entry.key)}" data-status="${status}" aria-label="${esc(name+' — '+agentStatusNames[status])}"><span class="agent-cell-name"><span class="agent-table-mark" data-status="${status}">${agentTableMark(status)}</span><span class="agent-table-name"><strong title="${esc(name)}">${esc(name)}</strong><small>${esc(agentStatusNames[status])}</small></span></span><span class="agent-cell-model" title="${esc(model||'Провайдер не передал модель агента')}">${esc(model||'—')}</span>${agentClockHtml(entry)}</button>`;
  }).join('');
  return `<details class="agent-workflow-group" data-group="${esc(groupKey)}"${open?' open':''}><summary><span class="agent-group-heading"><strong>${group.name}</strong><span class="agent-group-count">${group.id==='completed'?own.length+'/'+entries.length:own.length}</span>${phoneIcon('chevron')}</span><span class="agent-group-track" aria-hidden="true">${own.map(entry=>`<span data-status="${esc(agentStatusNames[entry.agent.status]?entry.agent.status:'unknown')}"></span>`).join('')}</span></summary><div class="agent-workflow-table"><div class="agent-table-head" aria-hidden="true"><span class="agent-cell-name">Агент</span><span class="agent-cell-model">Модель</span><span class="agent-cell-time">Время</span></div>${rows}</div></details>`;
 }).join('');
 return `<section class="agent-workflow"><header class="agent-workflow-head"><div><h3>${esc(agentText(chat.title||'Текущая работа',120))}</h3><div class="agent-workflow-meta"><span>${esc(providerName(run.provider||message.provider))}</span><span data-workflow-status="${activity?.mode==='offline'?'offline':activity?.mode==='waiting'?'waiting':'running'}">${esc(status)}</span><time data-agent-clock data-clock-start="${clockStart}" data-clock-end="0" title="Время с начала запроса">${esc(agentClockText(clockStart))}</time><span>${entries.length} ${entries.length===1?'агент':entries.length<5?'агента':'агентов'}</span></div></div><button type="button" class="agent-workflow-stop" data-agent-action="stop-workflow" aria-label="Остановить текущую работу" title="Остановить текущую работу"${stopDisabled?' disabled':''}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="1"/></svg></button></header>${task?`<p class="agent-workflow-task">${esc(task)}</p>`:''}<div class="agent-workflow-groups">${groups}</div></section>`;
}
function pruneAgentViewCache(){
 if(!chat)return;const current=new Set(replyMessages(chat).filter(message=>agentWorkflowIsCurrent({message})).map(message=>String(message.id)));
 for(const key of agentGroupOpen.keys()){try{if(JSON.parse(key)[0]!==chat.run?.id)agentGroupOpen.delete(key);}catch{agentGroupOpen.delete(key);}}
 for(const cache of [agentProgressCache,agentClockCache,agentDetailCache,agentDetailErrors,agentActionErrors])for(const key of cache.keys()){let parts;try{parts=JSON.parse(key)}catch{continue;}if(parts[1]===chat.id&&!current.has(parts[2]))cache.delete(key);}
}
function renderAgents(){
 const pane=$('#messages'),busy=readerBusy(pane),position=pane&&!busy&&!paintingMessages?captureReadingPosition(pane):null,height=pane?.scrollHeight,clientHeight=pane?.clientHeight;
 pruneAgentViewCache();const entries=agentEntries(),count=entries.length,active=entries.some(entry=>agentRunIsCurrent(entry)&&['running','waiting'].includes(entry.agent.status));
 for(const id of ['agents-button','agents-progress']){const button=$('#'+id);if(!button)continue;if(busy&&id==='agents-progress'&&button.hidden!==!count){queueReadingPaint(pane);continue;}button.hidden=!count;button.setAttribute('aria-expanded',String(Boolean($('#agent-panel')?.open)));button.dataset.active=String(active);const html=id==='agents-button'?`${agentsIcon()}<span>Агенты</span><span class="agents-count">${count}</span>`:`${agentsIcon()}<span>Агенты</span><span class="agents-progress-copy">${esc(agentCountCopy(entries))}</span><span class="agents-progress-arrow" aria-hidden="true">⌄</span>`;if(agentHtmlCache.get(button)!==html){button.innerHTML=html;agentHtmlCache.set(button,html);}}
 const byMessage=new Map();for(const entry of entries){const id=String(entry.message.id);if(!byMessage.has(id))byMessage.set(id,[]);byMessage.get(id).push(entry);}
 for(const row of document.querySelectorAll('[data-agent-message]')){const own=byMessage.get(row.dataset.agentMessage)||[],html=own.length?`<button type="button" onclick="openAgents(${jsArg(row.dataset.agentMessage)})" aria-haspopup="dialog" aria-controls="agent-panel">${agentsIcon()}<span>Агенты · ${own.length}</span><span class="agent-message-status">${esc(agentCountCopy(own))}</span></button>`:'';if(busy){if(row.hidden===Boolean(own.length)||agentHtmlCache.get(row)!==html)queueReadingPaint(pane);continue;}row.hidden=!own.length;if(agentHtmlCache.get(row)!==html){row.innerHTML=html;agentHtmlCache.set(row,html);}}
 renderAgentPanel();syncAgentWatch();
 if(pane&&(height!==pane.scrollHeight||clientHeight!==pane.clientHeight))restoreReadingPosition(pane,position);
}
function syncAgentWatch(force=false){
 const entry=$('#agent-panel')?.open&&chat?.id===agentPanelChatId?agentEntries().find(value=>value.key===agentPanelSelection):null;
 const frame=entry?{type:'watch-agent',chatId:chat.id,messageId:entry.message.id,agentId:String(entry.agent.id)}:{type:'watch-agent'},key=JSON.stringify(frame);
 if(force||socket!==agentWatchSocket||key!==agentWatchKey){if(socket&&sendEventFrame(socket,frame)){agentWatchSocket=socket;agentWatchKey=key;}}
}
function scheduleAgents(){if(agentPaintFrame)return;agentPaintFrame=requestAnimationFrame(()=>{agentPaintFrame=0;renderAgents()});}
function receiveAgentProgress(event){
 if(!state||event.chatId!==selectedId||chat?.id!==event.chatId||event.agent?.id==null)return;
 const message=replyMessages(chat).find(value=>value.id===event.messageId);if(!message){dirtyChats.add(event.chatId);scheduleStateRefresh();return;}
 if(message.role!=='assistant'||event.runId&&message.runId&&message.runId!==event.runId||event.runId&&message.status==='running'&&chat.run?.id&&chat.run.id!==event.runId)return;
 const key=agentKey(chat.id,message.id,event.agent.id),prior=message.agents?.find(agent=>String(agent.id)===String(event.agent.id));
 if(prior&&agentIsNewer(prior,event.agent))return;
 rememberAgentProgress(key,event.agent);
 const agent=event.agent.detailsDeferred?{...event.agent}:rememberAgentDetails(key,event.agent);if(!agent.detailsDeferred)agentDetailErrors.delete(key);message.agents=Array.isArray(message.agents)?message.agents:[];
 const index=message.agents.findIndex(value=>String(value.id)===String(agent.id));if(index<0){if(message.agents.length>=100)return;message.agents.push(agent);}else message.agents[index]=agent;
 scheduleAgents();
}
function ensureAgentPanel(){
 let panel=$('#agent-panel');if(panel)return panel;
 panel=document.createElement('dialog');panel.id='agent-panel';panel.className='agent-panel';panel.setAttribute('aria-labelledby','agent-panel-title');
 panel.innerHTML=`<div class="agent-panel-head"><button type="button" data-agent-action="back" class="agent-panel-back" aria-label="К списку агентов" hidden>${phoneIcon('back')}</button><div><h2 id="agent-panel-title">Агенты</h2><p id="agent-panel-caption"></p></div><button type="button" data-agent-action="close" class="agent-panel-close" aria-label="Закрыть агентов">${phoneIcon('close')}</button></div><div id="agent-panel-body" class="agent-panel-body"></div><footer id="agent-panel-footer" class="agent-panel-footer" hidden><div id="agent-detail-feedback"></div><div id="agent-detail-controls"></div></footer>`;
 panel.onclick=event=>{const target=event.target.closest('button[data-agent-action]');if(!target)return;const action=target.dataset.agentAction;if(action==='close')closeAgents();else if(action==='back'){agentPanelSelection='';agentPanelMessageId='';renderAgents();$('#agent-panel-title')?.focus({preventScroll:true});}else if(action==='select'){agentPanelSelection=target.dataset.agentKey;syncAgentWatch();renderAgentPanel();void loadAgentDetails(agentPanelSelection);$('#agent-panel-title')?.focus({preventScroll:true});}else if(action==='stop-workflow'){if(chat?.id===agentPanelChatId&&!target.disabled)void stopResponse();}else if(action==='retry'){agentDetailErrors.delete(agentPanelSelection);void loadAgentDetails(agentPanelSelection,true);}else if(action==='stop'||action==='resume')void controlAgent(action);};
 panel.addEventListener('toggle',event=>{const group=event.target;if(group.isConnected&&group.matches?.('details.agent-workflow-group'))agentGroupOpen.set(group.dataset.group,group.open);},true);
 panel.addEventListener('cancel',event=>{event.preventDefault();closeAgents();});
 panel.addEventListener('pointerdown',event=>{if(event.target!==panel)return;const box=panel.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)closeAgents();});
 panel.addEventListener('close',()=>{agentPanelSelection='';agentPanelMessageId='';const body=$('#agent-panel-body');if(body){body.replaceChildren();body.dataset.selection='';agentHtmlCache.delete(body);}renderAgents();const focus=agentPanelReturnFocus;agentPanelReturnFocus=null;if(focus?.isConnected)focus.focus({preventScroll:true});});
 document.body.append(panel);$('#agent-panel-title').tabIndex=-1;return panel;
}
window.openAgents=(messageId='')=>{
 if(!chat||chatLoading||!agentEntries(messageId).length)return;agentPanelReturnFocus=document.activeElement;closeSidebar(false);if($('#dialog')?.open)closeDialog();
 const panel=ensureAgentPanel();agentPanelChatId=chat.id;agentPanelSelection='';agentPanelMessageId=String(messageId||'');
 if(!panel.open)panel.showModal();renderAgents();$('#agent-panel-title').focus({preventScroll:true});
};
window.closeAgents=()=>{$('#agent-panel')?.close();};
async function loadAgentDetails(key,force=false){
 const entry=agentEntries().find(value=>value.key===key);if(!entry||!force&&!entry.agent.detailsDeferred||agentDetailLoads.has(key))return;
 const account=state?.me.id,id=chat.id,runId=chat.run?.id,messageId=entry.message.id,agentId=String(entry.agent.id);agentDetailErrors.delete(key);
 const current=()=>state?.me.id===account&&chat?.id===id&&chat.run?.id===runId&&agentEntries().some(value=>value.key===key);
 const request=api('/chats/'+encodeURIComponent(id)+'/agents/'+encodeURIComponent(agentId)+'?messageId='+encodeURIComponent(messageId)).then(result=>{if(!current()||result.agent?.id==null)return;rememberAgentDetails(key,result.agent);}).catch(error=>{if(current())agentDetailErrors.set(key,error.message);}).finally(()=>{if(agentDetailLoads.get(key)===request)agentDetailLoads.delete(key);if(state?.me.id===account&&chat?.id===id)scheduleAgents();});
 agentDetailLoads.set(key,request);scheduleAgents();await request;
}
function updateAgentSection(element,html){if(!element||agentHtmlCache.get(element)===html)return;const focused=document.activeElement?.closest('[data-agent-action]'),action=element.contains(focused)?focused?.dataset.agentAction:null,output=element.querySelector('.agent-output'),scroll=output||element;const top=scroll.scrollTop,atBottom=Boolean(output)&&scroll.scrollHeight-scroll.clientHeight-top<40;element.innerHTML=html;agentHtmlCache.set(element,html);const next=element.querySelector('.agent-output')||element;next.scrollTop=atBottom?next.scrollHeight:top;if(action)element.querySelector('[data-agent-action="'+CSS.escape(action)+'"]')?.focus({preventScroll:true});}
function renderAgentPanel(){
 const panel=$('#agent-panel');if(!panel?.open)return;
 if(!chat||chat.id!==agentPanelChatId||chat.id!==selectedId){if(panel.open)panel.close();return;}
 const all=agentEntries(),entries=agentPanelMessageId?all.filter(entry=>String(entry.message.id)===agentPanelMessageId):all;
 if(!entries.length){panel.close();return;}
 if(agentPanelSelection&&!entries.some(entry=>entry.key===agentPanelSelection))agentPanelSelection='';
 const selected=entries.find(entry=>entry.key===agentPanelSelection),body=$('#agent-panel-body'),heading=$('#agent-panel-title'),caption=$('#agent-panel-caption'),back=panel.querySelector('[data-agent-action=back]');
 back.hidden=!agentPanelSelection&&!agentPanelMessageId;
 if(!selected){
  $('#agent-panel-footer').hidden=true;const returning=Boolean(body.dataset.selection);body.dataset.selection='';heading.textContent='Агенты';caption.textContent=agentCountCopy(entries);const focused=body.querySelector(':focus'),focusKey=focused?.dataset.agentKey,focusGroup=focused?.tagName==='SUMMARY'?focused.closest('details')?.dataset.group:null;
  const html=agentWorkflowHtml(entries);
  updateAgentSection(body,'<div class="agent-workflow-list">'+html+'</div>');if(returning)body.scrollTop=0;if(focusKey)body.querySelector('[data-agent-key="'+CSS.escape(focusKey)+'"]')?.focus({preventScroll:true});else if(focusGroup)body.querySelector('[data-group="'+CSS.escape(focusGroup)+'"]>summary')?.focus({preventScroll:true});return;
 }
 const agent=selected.agent,status=agentStatusNames[agent.status]?agent.status:'unknown',deferred=agent.detailsDeferred,loading=agentDetailLoads.has(selected.key),error=agentDetailErrors.get(selected.key);
 heading.textContent=agentText(agent.name||'Агент',100);caption.textContent=providerName(selected.message.provider)+(agent.model?' · '+agentText(agent.model,80):'');
 if(body.dataset.selection!==selected.key){body.dataset.selection=selected.key;agentHtmlCache.delete(body);body.innerHTML='<div class="agent-detail"><div id="agent-detail-state"></div><section class="agent-detail-section" id="agent-detail-task"></section><section class="agent-detail-section" id="agent-detail-activity"></section><section class="agent-detail-section" id="agent-detail-output"></section><section class="agent-detail-section" id="agent-detail-events"></section></div>';body.scrollTop=0;}
 updateAgentSection($('#agent-detail-state'),`<span class="agent-detail-status" data-status="${status}"><span class="agent-state-mark" data-status="${status}" aria-hidden="true"></span>${agentStatusNames[status]}</span>${agent.parentId?'<span class="agent-parent-note">Вложенный агент</span>':''}`);
 updateAgentSection($('#agent-detail-task'),agent.task?`<h3>Задача</h3><p>${esc(agentText(agent.task,6000))}</p>`:'');
 updateAgentSection($('#agent-detail-activity'),`<h3>Сейчас</h3><p role="status" aria-live="polite">${esc(agentText(agent.activity||({completed:'Работа завершена.',stopped:'Работа остановлена.',failed:'Работа прервана.',waiting:'Ожидает следующего действия.',unknown:'Провайдер не подтвердил итоговое состояние.'}[status])||'Работает над задачей.',2400))}</p>`);
 const text=String(agent.text||''),output=text.slice(-60000);updateAgentSection($('#agent-detail-output'),text?`<h3>Ответ агента</h3>${text.length>60000||agent.textTruncated?'<p class="agent-detail-note">Показана последняя часть ответа.</p>':''}<pre class="agent-output">${esc(output)}</pre>`:'');
 const events=Array.isArray(agent.events)?agent.events.slice(-80):[];updateAgentSection($('#agent-detail-events'),events.length?`<h3>Последние действия</h3><ol class="agent-events">${events.map(event=>{const date=new Date(event.at),time=Number.isFinite(date.getTime())?date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'';return `<li><span class="agent-event-mark" aria-hidden="true"></span><div><p>${esc(agentText(event.text||'Действие',2000))}</p>${time?`<time>${esc(time)}</time>`:''}</div></li>`;}).join('')}</ol>`:'');
 $('#agent-panel-footer').hidden=false;const feedback=agentActionErrors.get(selected.key)||error|| (loading?'Загружаю подробности…':deferred?'Подробности ещё не загружены.':'');updateAgentSection($('#agent-detail-feedback'),feedback?`<div class="agent-feedback" data-kind="${error||agentActionErrors.has(selected.key)?'error':'notice'}" role="${error||agentActionErrors.has(selected.key)?'alert':'status'}">${esc(feedback)}${error||deferred&&!loading?'<button type="button" data-agent-action="retry">Обновить</button>':''}</div>`:'');
 const capabilities=agent.capabilities||{},current=agentRunIsCurrent(selected),disabled=agentControlDisabled(selected),pending=agentActionPending.get(selected.key);
 const controls=current&&(capabilities.stop===true||capabilities.resume===true)?`${capabilities.stop===true?`<button type="button" data-agent-action="stop" ${disabled?'disabled':''}>${pending==='stop'?'Останавливаю…':'Остановить'}</button>`:''}${capabilities.resume===true?`<button type="button" data-agent-action="resume" class="agent-resume" ${disabled?'disabled':''}>${pending==='resume'?'Продолжаю…':'Продолжить'}</button>`:''}`:'';
 const note=!networkReady?'Нет связи с пространством. Управление станет доступно после подключения.':chat?.run?.phase==='saving'?'Сохраняются результаты.':!current?'Сохранённый результат этого запроса.':'';
 updateAgentSection($('#agent-detail-controls'),`${controls?`<div class="agent-control-buttons">${controls}</div>`:''}${note?`<p class="agent-detail-note">${esc(note)}</p>`:''}`);
 $('#agent-panel-footer').hidden=!(feedback||controls||note);
}
async function controlAgent(action){
 const entry=agentEntries().find(value=>value.key===agentPanelSelection);if(!entry||agentControlDisabled(entry)||entry.agent.capabilities?.[action]!==true)return;
 const key=entry.key,id=chat.id,runId=chat.run.id,account=state?.me.id;agentActionErrors.delete(key);agentActionPending.set(key,action);renderAgents();
 try{const result=await api('/chats/'+encodeURIComponent(id)+'/agents/'+encodeURIComponent(String(entry.agent.id)),'POST',{action,runId},{timeoutMs:20000});if(state?.me.id!==account)return;if(result.agent)receiveAgentProgress({chatId:id,messageId:entry.message.id,runId,agent:result.agent});else{dirtyChats.add(id);scheduleStateRefresh();}}
 catch(error){if(state?.me.id===account)agentActionErrors.set(key,error.name==='TimeoutError'||error.name==='AbortError'?'Ответ задержался. Проверь состояние агента перед повторным нажатием.':error.message);}
 finally{agentActionPending.delete(key);if(state?.me.id===account)scheduleAgents();}
}
function clearAgentView(){if(agentPaintFrame)cancelAnimationFrame(agentPaintFrame);agentPaintFrame=0;agentPanelReturnFocus=null;$('#agent-panel')?.close();$('#agent-panel')?.remove();agentPanelChatId='';agentPanelSelection='';agentPanelMessageId='';agentDetailCache.clear();agentProgressCache.clear();agentClockCache.clear();agentGroupOpen.clear();agentDetailLoads.clear();agentDetailErrors.clear();agentActionErrors.clear();agentActionPending.clear();agentWatchSocket=null;agentWatchKey='';}

window.showPendingApproval=()=>{const preferred=chat?.approvals.find(a=>a.tool==='AskUserQuestion'||a.details?.questions?.length),card=preferred?$('#messages')?.querySelector(`[data-approval-id="${CSS.escape(preferred.id)}"]`):$('#messages .approval');if(!card)return;card.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});(card.querySelector('input:not([disabled]),button:not([disabled])')||card).focus({preventScroll:true});};
let expandedProjectId=projectId;
const currentProject=()=>state?.projects.find(p=>p.id===projectId)||state?.projects[0];
let filesProjectId='';
const fileUrl=(p,project=projectId,preview=false)=>`/api/projects/${encodeURIComponent(project)}/files?path=${encodeURIComponent(p)}${preview?'&preview=1':''}`;
const fmtBytes=n=>n>=1024*1024*1024?`${(n/1024/1024/1024).toFixed(1)} ГБ`:n>1024*1024?`${(n/1024/1024).toFixed(1)} МБ`:n>1024?`${Math.round(n/1024)} КБ`:`${n} Б`;
function requestSignal(signal,timeout){
 const controller=new AbortController(),abort=()=>controller.abort(signal.reason);let timer;
 if(signal){if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});}
 if(timeout&&!controller.signal.aborted)timer=setTimeout(()=>controller.abort(new DOMException('Пространство не ответило вовремя. Повтори проверку.','TimeoutError')),timeout);
 return {signal:controller.signal,dispose(){clearTimeout(timer);signal?.removeEventListener('abort',abort);}};
}
async function api(url,method='GET',input,options={}){
 const timeout=options.timeoutMs||(method==='GET'?(url.startsWith('/native-session-preview')?185000:url==='/state'||url.startsWith('/chats/')?15000:70000):0),request=requestSignal(options.signal,timeout);
 try{
  const res=await fetch('/api'+url,{method,...(method==='GET'?{cache:'no-store'}:{}),headers:input===undefined?{}:{'content-type':'application/json'},body:input===undefined?undefined:JSON.stringify(input),signal:request.signal});let data;
  try{data=await res.json()}catch(error){if(error.name==='TimeoutError'||error.name==='AbortError')throw error;throw new Error('Не удалось прочитать ответ пространства.');}
  if(!res.ok)throw Object.assign(new Error(data.error||'Не удалось выполнить действие.'),{status:res.status});return data;
 }finally{request.dispose();}
}
let dialogRead=null;
function cancelDialogRead(){dialogRead?.controller.abort();dialogRead=null;}
function beginDialogRead(title){
 dialog(title,'<p class="dialog-loading" role="status">Загружаю…</p>');
 const read={account:state?.me.id,controller:new AbortController()};dialogRead=read;return read;
}
function currentDialogRead(read){return dialogRead===read&&state?.me.id===read.account&&$('#dialog')?.open&&!read.controller.signal.aborted;}
function dialogFeedback(text,kind='notice'){const modal=$('#dialog');if(!modal?.open)return false;let feedback=modal.querySelector('#dialog-feedback');if(!feedback){feedback=document.createElement('div');feedback.id='dialog-feedback';feedback.className='dialog-feedback';const body=modal.querySelector('.phone-modal-body');if(body)body.prepend(feedback);else modal.querySelector('.modal-head')?.after(feedback);}feedback.dataset.kind=kind;feedback.setAttribute('role',kind==='error'?'alert':'status');feedback.textContent=text;feedback.hidden=!text;if(text)feedback.scrollIntoView({block:'nearest'});return true;}
function toast(text,kind='notice'){clearTimeout(toastTimer);const el=$('#toast');if(dialogFeedback(text,kind)){if(el)el.style.display='none';return;}if(!el)return;el.setAttribute('role',kind==='error'?'alert':'status');el.textContent=text;el.style.display='block';toastTimer=setTimeout(()=>el.style.display='none',6500)}
function clearPreviewTools(){previewCleanup?.();previewCleanup=null;}
function dialog(title,body,mobileSheet=false){clearPreviewTools();chatTools.cancelRead();cancelDialogRead();usagePopover.close({restoreFocus:false});closeSidebar(false);if(['permission','recording','transcribing','retry','speaking'].includes(voiceConversation.mode))voiceConversation.cancel();const el=$('#dialog');delete el.dataset.mobileModels;el.classList.remove('artifact-dialog','session-menu-dialog','split-picker-dialog');el.classList.toggle('mobile-sheet',mobileSheet||isPhoneWebClient);el.onclose=()=>{if(el.open)return;clearPreviewTools();chatTools.cancelRead();cancelDialogRead();phoneSettingsChild=false;if(isPhoneWebClient&&$('#project-picker')?.value==='new')$('#project-picker').value=projectId;el.querySelectorAll('input[type=password]').forEach(input=>input.value='');if(el.classList.contains('artifact-dialog')){el.innerHTML='';el.classList.remove('artifact-dialog');}};el.innerHTML=`<div class="modal-head">${isPhoneWebClient&&phoneSettingsChild?`<button onclick="showMobileSettings()" aria-label="Назад к настройкам">${phoneIcon('back')}</button>`:''}<h2 id="dialog-title">${esc(title)}</h2><button onclick="closeDialog()" aria-label="Закрыть">${isPhoneWebClient?phoneIcon('close'):'×'}</button></div>${isPhoneWebClient?`<div class="phone-modal-body">${body}</div>`:body}`;el.setAttribute('aria-labelledby','dialog-title');if(!el.open)el.showModal();if(isPhoneWebClient)el.querySelector('.modal-head button')?.focus({preventScroll:true})}
window.closeDialog=()=>{clearPreviewTools();chatTools.cancelRead();cancelDialogRead();if(isPhoneWebClient&&$('#project-picker')?.value==='new')$('#project-picker').value=projectId;$('#dialog').close()};
function inline(text){return text.replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')}
function markdown(text){const chunks=String(text||'').split(/```/);return chunks.map((chunk,i)=>{if(i%2){const code=chunk.replace(/^[^\n]*\n/,'');return `<pre><code>${esc(code)}</code></pre>`}const lines=esc(chunk).split('\n');let html='',para=[],list=null;const flush=()=>{if(para.length){html+=`<p>${inline(para.join('<br>'))}</p>`;para=[]}if(list){html+=`</${list}>`;list=null}};for(const line of lines){if(!line.trim()){flush();continue}let m;if((m=line.match(/^(#{1,3}) (.+)/))){flush();html+=`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`}else if((m=line.match(/^\s*([-*]|\d+\.) (.+)/))){if(para.length){html+=`<p>${inline(para.join('<br>'))}</p>`;para=[]}const type=/\d/.test(m[1])?'ol':'ul';if(list!==type){if(list)html+=`</${list}>`;list=type;html+=`<${type}>`}html+=`<li>${inline(m[2])}</li>`}else if(line.startsWith('&gt; ')){flush();html+=`<blockquote>${inline(line.slice(5))}</blockquote>`}else{if(list){html+=`</${list}>`;list=null}para.push(line)}}flush();return html}).join('')}
const emptySharedFiles=[],sharedFileMaps=new WeakMap();
function sharedFileLookup(){
 const chatFiles=chat?.files||emptySharedFiles,projectFiles=filesProjectId===projectId?files:emptySharedFiles;
 let projectMaps=sharedFileMaps.get(chatFiles);if(!projectMaps){projectMaps=new WeakMap();sharedFileMaps.set(chatFiles,projectMaps);}
 let cached=projectMaps.get(projectFiles);
 if(!cached||cached.chatLength!==chatFiles.length||cached.projectLength!==projectFiles.length){
  const known=new Map();for(const file of chatFiles)known.set(file.path,file);for(const file of projectFiles)known.set(file.path,file);
  cached={known,chatLength:chatFiles.length,projectLength:projectFiles.length};projectMaps.set(projectFiles,cached);
 }
 return cached.known;
}
function normalizeReference(value){
 let name=String(value||'').trim().replace(/\\([() ])/g,'$1');
 if(/^file:\/\//i.test(name)){try{const url=new URL(name);if(url.hostname&&url.hostname!=='localhost')return '';name=url.pathname;}catch{return '';}}
 try{name=decodeURIComponent(name);}catch{}
 return name.replace(/\\/g,'/').replace(/^\.\//,'');
}
function resolveFileReference(value,message){
 const name=normalizeReference(value);if(!name||name.includes('\0'))return null;
 const known=sharedFileLookup();
 const variants=[name,name.replace(/(?::\d+(?::\d+)?|#(?:L\d+(?:-L?\d+)?|.*))$/,'')];
 const source=chat?.importSource;
 for(const candidate of variants){
  let relative=candidate;
  if(/^(?:\/|[A-Za-z]:\/)/.test(candidate)){
   // Only roots belonging to this chat or its exact managed project may be mapped.
   const roots=[...Object.values(chat?.providerSessions||{}).map(s=>s.cwd),...(chat?.fileAliases?.roots||[]),source?.cwd].filter(Boolean).map(normalizeReference);
   const root=roots.find(r=>candidate.startsWith(r.replace(/\/$/,'')+'/'));
   if(root)relative=candidate.slice(root.replace(/\/$/,'').length+1);
   else{
    const markers=[chat?.projectId,...(chat?.fileAliases?.projectIds||[])].flatMap(id=>['/session-workspaces/'+id+'/'+chat?.id+'/','/workspaces/'+id+'/']);const marker=markers.find(m=>candidate.includes(m));if(!marker)continue;relative=candidate.slice(candidate.indexOf(marker)+marker.length);
   }
  }
  const sourceMapped=message?.sourceSessionId===source?.sessionId&&source?.mapping?.[relative];
  if(sourceMapped)relative=sourceMapped;
  const overridden=message?.fileOverrides?.[relative];if(overridden)relative=overridden;
  if(!sourceMapped&&!overridden&&!message?.attachments?.some(a=>a.path===relative))relative=chat?.fileAliases?.groups?.[message?.fileAliasGroup]?.[relative]||relative;
  if(known.has(relative))return known.get(relative);
 }
 return null;
}
function previewKind(name){const ext=name.split('.').at(-1)?.toLowerCase();return ['html','htm'].includes(ext)?'html':['png','jpg','jpeg','webp','gif','avif'].includes(ext)?'image':['mp4','webm','mov'].includes(ext)?'video':['mp3','wav','ogg'].includes(ext)?'audio':['pdf','txt','md','csv','json'].includes(ext)?'document':'';}
const browserLinks=new Map();let browserLinksTimer;
async function prepareBrowserLink(name,project){
 const account=state?.me.id;if(!account)throw new Error('Войди в Team Room, чтобы открыть файл.');
 const key=JSON.stringify([account,project,name]),existing=browserLinks.get(key);
 if(existing?.expiresAt>Date.now()+15000)return existing;if(existing?.pending)return existing.pending;
 if(browserLinks.size>150){for(const [k,v]of browserLinks)if(!v.pending&&v.expiresAt<=Date.now()+15000)browserLinks.delete(k);}
 const pending=api('/projects/'+encodeURIComponent(project)+'/file-open','POST',{path:name}).then(link=>{
  if(state?.me.id!==account)throw new Error('Вход изменился. Открой файл из текущего аккаунта.');
  if(!/^\/open\/[A-Za-z0-9_-]{43}$/.test(link.url)||!Number.isFinite(link.expiresAt))throw new Error('Не удалось подготовить ссылку.');
  browserLinks.set(key,link);return link;
 }).catch(error=>{browserLinks.delete(key);throw error});browserLinks.set(key,{pending});return pending;
}
function browserFileLink(name,project=projectId){return `<a class="artifact-browser-link" data-file="${esc(name)}" data-project="${esc(project)}" href="${fileUrl(name,project,true)}" onclick="openBrowserFile(event,this)" target="_blank" rel="noopener noreferrer" title="Открыть файл в браузере">В браузере ↗</a>`;}
window.openBrowserFile=(event,element)=>{
 const key=JSON.stringify([state?.me.id,element.dataset.project,element.dataset.file]),link=browserLinks.get(key);
 if(link?.expiresAt>Date.now()+15000){element.href=link.url;return;}
 event.preventDefault();element.setAttribute('aria-busy','true');
 void prepareBrowserLink(element.dataset.file,element.dataset.project).then(link=>{element.href=link.url;dialog('Файл готов',`<p>Открой файл в отдельном окне браузера.</p><div class="modal-buttons"><a class="primary-button browser-open-ready" href="${esc(link.url)}" target="_blank" rel="noopener noreferrer" onclick="closeDialog()">Открыть в браузере ↗</a></div>`)}).catch(error=>toast(error.message,'error')).finally(()=>element.removeAttribute('aria-busy'));
};
const pendingBrowserLinks=new Set();
function queueBrowserLinks(records){
 for(const record of records)for(const node of record.addedNodes){
  if(node.nodeType!==1)continue;
  const links=node.matches('.artifact-browser-link')?[node]:node.childElementCount?node.querySelectorAll('.artifact-browser-link'):[];
  for(const link of links){pendingBrowserLinks.add(link);if(pendingBrowserLinks.size>128)pendingBrowserLinks.delete(pendingBrowserLinks.values().next().value);}
 }
 if(!pendingBrowserLinks.size)return;clearTimeout(browserLinksTimer);browserLinksTimer=setTimeout(()=>{
  const candidates=[...pendingBrowserLinks].filter(element=>element.isConnected).slice(-16);pendingBrowserLinks.clear();
  for(const element of candidates)void prepareBrowserLink(element.dataset.file,element.dataset.project).then(link=>{if(element.isConnected)element.href=link.url}).catch(()=>{});
 },150);
}
new MutationObserver(queueBrowserLinks).observe(document.body,{subtree:true,childList:true});
function fileCard(reference,title='',message){
 const file=resolveFileReference(reference,message),name=normalizeReference(reference).split('/').at(-1)||'Файл',project=chat?.projectId||projectId;
 const label=String(title||name).slice(0,240),kind=file?previewKind(file.path):'';
 const data=file?`data-file="${esc(file.path)}" data-project="${esc(project)}"`:'';
 return `<div class="artifact-card"><span class="artifact-icon" aria-hidden="true">▧</span><div class="artifact-copy"><strong>${esc(label)}</strong><small>${esc(file?file.path:name)}${file?' · '+fmtBytes(file.size):' · '+(message?.status==='running'?'Ещё сохраняется в проект':'Пока нет в общих файлах')}</small></div><div class="artifact-actions">${file?`${kind==='html'?browserFileLink(file.path,project):''}${kind?`<button ${data} onclick="openFilePreview(this.dataset.file,this.dataset.project)">${kind==='html'?'Превью':'Открыть'}</button>`:''}<a href="${fileUrl(file.path,project)}" download>Скачать</a>`:'<button onclick="refreshSharedFiles()">Обновить</button>'}</div></div>`;
}
function assistantText(message){
 const cards=[],seen=new Set();
 const add=(reference,title)=>{
  const key=resolveFileReference(reference,message)?.path||normalizeReference(reference);
  if(seen.has(key))return '';seen.add(key);
  const token='\uE100file-card-'+cards.length+'\uE101';cards.push(fileCard(reference,title,message));return '\n\n'+token+'\n\n';
 };
 const text=String(message.text||'').split(/```/).map((chunk,index)=>{
  if(index%2)return chunk;
  chunk=chunk.replace(/\uE200visualize\uE202([\s\S]*?)\uE201/g,(raw,json)=>{
   try{const item=JSON.parse(json);if(typeof item.path==='string')return add(item.path,item.title);}catch{}
   return '\n\nНе удалось прочитать ссылку на предпросмотр. Открой «Файлы проекта».\n\n';
  });
  // A streamed directive is not complete until its closing marker arrives.
  const pending=chunk.indexOf('\uE200visualize');
  if(pending>=0)chunk=chunk.slice(0,pending)+(message.status==='running'?'\n\nГотовит файл…':'\n\nПредпросмотр не завершён. Проверь «Файлы проекта».');
  return chunk.split(/(`[^`\n]*`)/).map((part,i)=>i%2?part:part.replace(/!?\[([^\]\n]+)\]\((?:<([^>\n]+)>|((?:[^()\n]|\([^()\n]*\))+))\)/g,(raw,label,angled,target)=>{
   const reference=angled||target;
   if(/^(?:https?:|mailto:|data:|javascript:|#)/i.test(reference))return raw;
   if(resolveFileReference(reference,message)||/^(?:file:\/\/|\/|[A-Za-z]:[\\/]|\.\/)/i.test(reference)||/\.[a-z0-9]{1,10}(?::\d+(?::\d+)?)?(?:#.*)?$/i.test(reference))return add(reference,label);
   return raw;
  })).join('');
 }).join('```');
 let html=markdown(text);
 cards.forEach((card,i)=>{const token='\uE100file-card-'+i+'\uE101';html=html.replace('<p>'+token+'</p>',card).replace(token,card);});
 return html;
}
window.refreshSharedFiles=async()=>{await refreshFiles();};
window.openFilePreview=async(name,project=projectId)=>{
 const kind=previewKind(name);if(!kind)return;
 const src=esc(fileUrl(name,project,true)),account=state?.me.id,sourceChat=chat?.id||'';
 let content;
 if(kind==='image')content=`<img class="artifact-image" src="${src}" alt="${esc(name)}">`;
 else if(kind==='video'||kind==='audio')content=`<${kind} class="artifact-media" src="${src}" controls ${kind==='video'?'playsinline':''} preload="metadata"></${kind}>`;
 else content=`<iframe class="artifact-frame" src="${src}" title="${esc(name)}" sandbox="${kind==='html'?'allow-scripts':''}" referrerpolicy="no-referrer"></iframe>`;
 dialog(name.split('/').at(-1),`<div class="artifact-toolbar">${kind==='html'?browserFileLink(name,project):''}<a href="${fileUrl(name,project)}" download>Скачать файл</a>${kind==='html'?'<span>Интерактивный HTML · без доступа к сети</span>':''}</div><div class="artifact-preview"><p class="muted">Открываю файл…</p></div>`);
 const el=$('#dialog'),request=crypto.randomUUID();el.classList.add('artifact-dialog');el.dataset.previewRequest=request;
 try{
  const response=await fetch(fileUrl(name,project,true),{method:'HEAD',signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error(response.status===401?'Войди в Team Room, чтобы открыть файл.':response.status===404?'Файл пока не доступен в общей папке. Обнови файлы проекта.':'Не удалось открыть файл. Попробуй ещё раз.');
  if(el.open&&el.dataset.previewRequest===request&&el.classList.contains('artifact-dialog')){const root=el.querySelector('.artifact-preview');root.innerHTML=content;previewCleanup=attachPreview({root:el,projectId:project,path:name,chatId:sourceChat,onCompose:text=>{if(state?.me.id!==account||projectId!==project||(chat?.id||'')!==sourceChat||!el.open||el.dataset.previewRequest!==request)return toast('Разговор изменился. Открой превью заново, чтобы добавить правку.','error');closeDialog();composeReview(text,sourceChat);}});}
 }catch(error){
  if(el.open&&el.dataset.previewRequest===request&&el.classList.contains('artifact-dialog'))el.querySelector('.artifact-preview').innerHTML=`<p class="muted">${esc(error.name==='TimeoutError'?'Не удалось связаться с пространством. Попробуй ещё раз.':error.message)}</p>`;
 }
};
function renderAuth(){
 if(isEmbeddedPane){announcePaneAuthExpired();$('#app').innerHTML='<div class="boot">Войди в основном окне Team Room.</div>';return;}
 const code=Boolean(loginChallenge);
 $('#app').innerHTML=`<div class="auth"><form class="auth-card" id="auth-form"><img class="teamroom-mark" src="/teamroom-mark.svg" alt="Team Room Community" width="60" height="48"><h1>${code?'Код из Telegram':authMode==='setup'?'Создай своё пространство':authMode==='join'?'Подключись к пространству':'С возвращением'}</h1><p>${code?'Код придёт, если имя совпадает с зарегистрированным аккаунтом. Он действует 5 минут. Компьютер включать не нужно.':authTelegram?'Вход подтверждается кодом в Telegram. Обновление страницы не требует нового входа.':'Один чат, общая память и файлы.'}</p>${code?`<p>Аккаунт: ${esc(loginChallenge.name)}</p>${loginChallenge.botUsername?`<a href="https://t.me/${encodeURIComponent(loginChallenge.botUsername)}" target="_blank" rel="noopener noreferrer">Открыть бота в Telegram</a>`:''}<p class="muted">Если кода нет, проверь имя аккаунта и нажми Start в боте. Код приходит в Telegram, выбранный владельцем для этого аккаунта.</p><label for="auth-code">Код входа</label><input id="auth-code" name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" autofocus>`:`<label for="auth-name">Имя аккаунта</label><input id="auth-name" name="name" required maxlength="50" autocomplete="username">${!authTelegram?`<label for="auth-password">Пароль Team Room</label><input id="auth-password" name="password" type="password" required minlength="10" maxlength="1024" autocomplete="${authMode==='login'?'current-password':'new-password'}">`:''}${authMode==='setup'?'<label for="auth-setup-token">Код первоначальной настройки</label><input id="auth-setup-token" name="setupToken" type="password" required autocomplete="off"><p class="muted">Код из настроек собственного сервера.</p>':''}${authMode==='join'?'<label for="auth-invite">Код приглашения</label><input id="auth-invite" name="invite" required maxlength="40">':''}`}<button class="primary-button" type="submit">${code?'Подтвердить вход':authTelegram?'Получить код в Telegram':authMode==='setup'?'Создать пространство':authMode==='join'?'Подключиться':'Войти'}</button><div class="auth-error" id="auth-error" role="alert"></div>${code?'<button type="button" class="auth-switch" onclick="resetLoginCode()">Запросить новый код</button>':authMode!=='setup'?`<button type="button" class="auth-switch" onclick="switchAuth()">${authMode==='login'?'У меня есть код приглашения':'У меня уже есть аккаунт'}</button>`:''}</form></div>`;
 $('#auth-form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('[type=submit]');button.disabled=true;try{
  const values=Object.fromEntries(new FormData(e.target));const result=await api(code?'/auth/verify':'/'+authMode,'POST',code?{...values,challengeId:loginChallenge.id}:values);
  if(result.telegramRequired){authTelegram=true;loginChallenge={id:result.challengeId,name:values.name,botUsername:result.botUsername};renderAuth();return;}
  state=result;authTelegram=Boolean(state.security?.telegramEnabled);loginChallenge=null;initRoom();if(state.inviteCode)showInvite(state.inviteCode);
 }catch(error){const target=$('#auth-error');if(target)target.textContent=error.message;}finally{button.disabled=false}};
}
window.resetLoginCode=()=>{loginChallenge=null;renderAuth()};
window.switchAuth=()=>{authMode=authMode==='join'?'login':'join';loginChallenge=null;renderAuth()};
function initRoom(){
 const restoreBoard=sessionBoard.wantsRestore();
 setPaneAccount(state.me.id);if(isEmbeddedPane){subscriptionSelections={};try{const saved=JSON.parse(roomLocalStorage.getItem('roomSubscriptionAccounts')||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))subscriptionSelections=saved;}catch{}provider=roomLocalStorage.getItem('teamProvider')||provider;deviceId=new URLSearchParams(location.search).get('device')||roomLocalStorage.getItem('roomDevice')||deviceId;}
 authTelegram=Boolean(state.security?.telegramEnabled);const url=new URL(location.href);let saved;try{const key='roomView:'+state.me.id;saved=JSON.parse(roomSessionStorage.getItem(key)||roomLocalStorage.getItem(key)||'null')}catch{}
 if(!url.searchParams.has('chat')&&saved){selectedId=saved.chatId||'';projectId=saved.projectId||projectId;}
 const target=state.chats.find(c=>c.id===selectedId);if(target)projectId=target.projectId;
 if(!state.projects.some(p=>p.id===projectId))projectId=state.projects[0].id;
 if(!state.chats.some(c=>c.id===selectedId&&c.projectId===projectId))selectedId='';
 if(!selectedId)resetNewChatDevice();else if(target)applyChatRoute(target);
 expandedProjectId=projectId;chatLoading=Boolean(selectedId);rememberView();renderShell();connectEvents();if(isPhoneWebClient&&!isEmbeddedPane)void phoneNotifications.init();const initialOpen=openChat(selectedId),initialGeneration=chatOpenGeneration;void initialOpen.then(()=>{if(restoreBoard&&state&&initialGeneration===chatOpenGeneration)sessionBoard.show();});if(!selectedId)void loadCatalog();
}
function renderShell(){if(!chat)executionMode=executionPreference();
 sidebarHover.detach();
 sidebarSections.detach();
 if(chatDrag||chatTouch)clearChatDrag();
 voiceConversation.cancel();dictation.cancel();
 $('#app').innerHTML=`<div class="app"><button class="sidebar-backdrop" onclick="closeSidebar()" aria-label="Закрыть меню" tabindex="-1"></button><aside class="sidebar" id="sidebar" aria-label="Проекты и чаты"><div class="brand"><button type="button" class="sidebar-toggle" data-sidebar-toggle onclick="toggleSidebar()" aria-controls="sidebar" aria-expanded="true" aria-label="Скрыть список сессий">${isPhoneWebClient?phoneIcon('close'):sidebarIcon()}</button><img class="teamroom-mark" src="/teamroom-mark.svg" alt="Team Room Community" width="30" height="24">Team Room</div><button class="sidebar-full-search" onclick="showSearch()" aria-label="Поиск по всем сообщениям"><span aria-hidden="true">${phoneIcon('search')}</span><span>Поиск сообщений</span><kbd>${/Mac/.test(navigator.platform||navigator.userAgent)?'⌘ K':'Ctrl K'}</kbd></button><button class="new-chat" onclick="newSidebarChat()"><span class="icon">＋</span>Новый чат</button><div class="side-links"><button onclick="showMemory()">◉ <span>Память проекта</span></button><button onclick="toggleFiles()">▧ <span>Файлы проекта</span></button><button onclick="showTasks()">☑ <span>Задачи</span></button><button onclick="showDevices()">▱ <span>Компьютеры</span></button><button onclick="showMcp()"><span>⌘</span> MCP</button><button onclick="showSkills()">◈ <span>Скиллы</span></button><button onclick="showImport()">↓ <span>Импортировать чат</span></button></div><select class="project-select" id="project-picker" hidden aria-label="Проект" onchange="selectProject(this.value)">${state.projects.map(p=>`<option value="${p.id}" ${p.id===projectId?'selected':''}>${esc(p.name)}</option>`).join('')}<option value="new">＋ Новый проект</option></select><input class="search" id="chat-search" placeholder="Найти чат…" aria-label="Поиск чатов" oninput="renderChatList()"><div class="project-list-heading"><span>Проекты</span><button onclick="selectProject('new')" aria-label="Создать проект" title="Создать проект">＋</button></div><div class="chat-list" id="chat-list"></div><div class="side-footer"><button class="mobile-settings-trigger" onclick="showMobileSettings()" aria-label="Настройки и инструменты"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 3-1 3-3 1 1 3-2 2 2 2-1 3 3 1 1 3h6l1-3 3-1-1-3 2-2-2-2 1-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></svg><span>Настройки</span></button><button class="profile-button" onclick="showProfile()"><span class="avatar">${esc(state.me.name.slice(0,1))}</span><span class="account">${esc(state.me.name)}<small>Общее пространство</small></span></button></div></aside><main class="main"><div class="topbar"><button class="mobile-menu" data-sidebar-toggle onclick="toggleSidebar()" aria-controls="sidebar" aria-expanded="false" aria-label="Открыть проекты и чаты">${isPhoneWebClient?phoneIcon('menu'):sidebarIcon()}</button><button class="chat-title" id="chat-title" onclick="renameChat()">Новый чат</button>${isPhoneWebClient?'<button id="phone-context-picker" class="phone-context-picker" onclick="showDevices()" aria-haspopup="dialog"></button>':''}<div class="right"><span class="network-badge" id="network-badge"></span><select class="device-picker" id="device-picker" onchange="selectDevice(this.value)" aria-label="Компьютер для выполнения"></select><button type="button" id="agents-button" class="agents-button" onclick="openAgents()" aria-haspopup="dialog" aria-controls="agent-panel" aria-expanded="false" hidden></button><button type="button" class="split-toggle" onclick="toggleSplitWorkspace()" aria-label="Открыть вторую сессию" aria-pressed="false"></button><button onclick="toggleFiles()" class="topbar-files" aria-label="Файлы проекта" title="Общие файлы">▧</button><button onclick="chatMenu()" aria-label="Действия с чатом" title="Действия с чатом">${isPhoneWebClient?phoneIcon('more'):'•••'}</button></div></div><button class="execution-route" id="execution-route" onclick="showDevices()" hidden></button><div class="conversation is-empty" id="conversation"><div class="messages" id="messages"></div><div class="composer-zone"><div class="composer-progress"><div id="run-activity" class="run-activity" role="status" aria-live="polite" aria-atomic="true" hidden></div><button class="mobile-stop" id="mobile-stop-button" onclick="stopResponse()" aria-label="Остановить ответ" hidden><span aria-hidden="true">■</span> Стоп</button></div><button type="button" id="agents-progress" class="agents-progress" onclick="openAgents()" aria-haspopup="dialog" aria-controls="agent-panel" aria-expanded="false" hidden></button><div id="followup-queue" class="followup-queue" hidden></div><div class="composer"><button type="button" id="weekly-quota-notice" class="weekly-quota-notice" onclick="showWeeklyQuota()" aria-haspopup="dialog" aria-live="polite" aria-atomic="true" hidden></button><div class="draft-files" id="draft-files"></div>${isPhoneWebClient?'<div id="voice-status" class="voice-status" role="status" aria-live="polite" hidden></div>':''}<textarea id="message-input" placeholder="Чем займёмся?" aria-label="Сообщение" rows="2" autocapitalize="sentences" enterkeyhint="enter"></textarea><div class="composer-bottom"><button class="attach-button" onclick="pickFiles()" aria-label="Прикрепить фото, видео или файл" title="Прикрепить файлы">${isPhoneWebClient?phoneIcon('plus'):'＋'}</button><button class="skill-picker" onclick="showSkills()" title="Выбрать скилл" aria-label="Выбрать скилл">◈</button><button class="mobile-model-picker" id="mobile-model-picker" onclick="showMobileModels()" aria-label="Выбрать провайдера и модель" aria-haspopup="dialog"></button>${isPhoneWebClient?`<button id="voice-button" class="voice-button" onclick="toggleVoiceInput()" aria-label="Голосовой ввод" title="Голосовой ввод" aria-pressed="false">${phoneIcon('mic')}</button>`:''}<button class="account-picker" id="account-picker" onclick="showProviderAccounts()" aria-label="Аккаунт подписки" aria-haspopup="dialog">Основной аккаунт ⌄</button><select class="provider-picker" id="provider-picker" onchange="selectProvider(this.value)" aria-label="Провайдер"><option value="claude">Claude</option><option value="codex">Codex</option></select><select class="model-picker" id="model-picker" onchange="selectModel(this.value)" aria-label="Модель"><option>Загружаю модели…</option></select><select class="effort-picker" id="effort-picker" onchange="selectEffort(this.value)" aria-label="Мощность"><option value="">По умолчанию</option></select><button class="execution-mode-button" id="execution-mode-button" onclick="showExecutionMode()" aria-haspopup="dialog" aria-label="Режим работы">Работа</button><button class="permission-button" onclick="showPermissions()" title="Режим разрешений" aria-label="Режим разрешений">Разрешения</button><button type="button" id="usage-button" class="usage-trigger" onclick="toggleUsagePopover()" aria-label="Лимиты подписки" aria-haspopup="dialog" aria-expanded="false"></button><button class="stop-response" id="stop-button" onclick="stopResponse()" title="Остановить ответ" aria-label="Остановить ответ" hidden>■</button><button class="send" id="send-button" onclick="sendMessage()" title="Отправить">↑</button></div></div><div class="compose-meta"><button class="status" id="provider-status" onclick="showProviderInfo()"><span class="status-dot"></span><span>Проверяю подписку…</span></button><button class="context-note" id="context-note" onclick="showMemory()" title="Общая память и сохранение контекста">История и файлы общие для Claude и Codex</button></div><div class="welcome-hints" id="welcome-hints">${isPhoneClient?'<button onclick="showDevices()">Выбрать активный компьютер</button>':'<button onclick="pickFolder()">Добавить папку проекта</button><button onclick="showDevices()">Подключить другой компьютер</button>'}</div></div></div><div id="file-panel-root"></div><input type="file" id="file-picker" multiple hidden><input type="file" id="folder-picker" webkitdirectory multiple hidden></main></div>`;
 $('#provider-picker').value=provider;$('#message-input').value=draft;
 $('#message-input').oninput=e=>{if(dictation.active)dictation.cancel();if(voiceConversation.mode==='retry')voiceConversation.cancel();draft=e.target.value;if(voiceConversation.textValue)voiceConversation.textValue=draft;pendingMessageId=null;scheduleComposer()};
 $('#message-input').onkeydown=e=>{if(e.key==='Enter'&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&!e.shiftKey&&!e.isComposing&&!isPhoneClient&&(!compactScreen.matches||isEmbeddedPane)){e.preventDefault();void sendMessage()}};
 $('#send-button').onpointerdown=e=>{if(compactScreen.matches&&document.activeElement===$('#message-input'))e.preventDefault()};
 $('#message-input').onpaste=e=>{const list=Array.from(e.clipboardData.files);if(list.length){e.preventDefault();void uploadFiles(list,false)}};
 $('#file-picker').onchange=e=>{void uploadFiles(Array.from(e.target.files),false);e.target.value=''};
 $('#folder-picker').onchange=e=>{void uploadFiles(Array.from(e.target.files),true);e.target.value=''};
 communityUpdates.badge();sessionBoard.attach();syncWorkspaceControls({restore:true});sidebarSections.attach($('#sidebar'),{userId:state.me.id,embedded:isEmbeddedPane});sidebarHover.attach($('.app'),{embedded:isEmbeddedPane});bindReadingGestures($('#messages'));bindSidebarGestures($('#sidebar'));$('.sidebar').addEventListener('click',event=>{if(event.target.closest('.side-links button,.profile-button'))closeSidebar(false)});syncViewport();renderChatList();renderDevicesPicker();renderMessages();renderAttachments();if(filePanel)void renderFiles();
}
function closeSidebar(restoreFocus=true){
 sidebarHover.hide();
 const app=$('.app');if(!app)return;const wasOpen=app.classList.contains('sidebar-open');app.classList.remove('sidebar-open');
 const sidebar=$('#sidebar');sidebar?.removeAttribute('role');sidebar?.removeAttribute('aria-modal');if(sidebar&&compactScreen.matches)sidebar.inert=true;
 if($('.main'))$('.main').inert=false;$('.mobile-menu')?.setAttribute('aria-expanded','false');
 if(wasOpen&&restoreFocus)sidebarReturnFocus?.focus({preventScroll:true});
}
window.closeSidebar=closeSidebar;
window.toggleSidebar=()=>{
 if(isEmbeddedPane)return;
 const app=$('.app');if(!app)return;if(!compactScreen.matches){sidebarHover.hide();app.classList.toggle('sidebar-collapsed');try{roomLocalStorage.setItem('roomSidebar:'+state.me.id,app.classList.contains('sidebar-collapsed')?'hidden':'visible');}catch{}syncWorkspaceControls();return;}
 if(app.classList.contains('sidebar-open')){closeSidebar();return;}
 sidebarReturnFocus=document.activeElement;app.classList.add('sidebar-open');const sidebar=$('#sidebar');sidebar.inert=false;sidebar.setAttribute('role','dialog');sidebar.setAttribute('aria-modal','true');$('.main').inert=true;$('.mobile-menu').setAttribute('aria-expanded','true');sidebar.querySelector('button')?.focus({preventScroll:true});
};
// Phone web edge swipe. Vertical reading, horizontal code and form controls keep their gestures.
if(isPhoneWebClient){
 let gesture=null,suppressSwipeClickUntil=0;
 document.addEventListener('touchstart',event=>{
  suppressSwipeClickUntil=0;
  gesture=null;
  if(!compactScreen.matches||event.touches.length!==1||!$('.app')||$('#dialog')?.open||$('.workspace-panel'))return;
  if((window.visualViewport?.scale||1)>1.05||window.getSelection()?.toString())return;
  const target=event.target instanceof Element?event.target:null;
  if(!target||target.closest('input,textarea,select,button,a,pre,table,iframe,video,audio,[contenteditable=true]'))return;
  const touch=event.touches[0],open=$('.app').classList.contains('sidebar-open');
  // Leave the outermost 16px to Safari's native back gesture.
  if(!open&&(touch.clientX<16||touch.clientX>96))return;
  if(open&&!target.closest('#sidebar'))return;
  gesture={id:touch.identifier,x:touch.clientX,y:touch.clientY,dx:0,dy:0,open,locked:false,at:performance.now()};
 },{passive:true});
 document.addEventListener('touchmove',event=>{
  if(!gesture)return;
  if(event.touches.length!==1){gesture=null;return;}
  const touch=[...event.touches].find(t=>t.identifier===gesture.id);if(!touch){gesture=null;return;}
  gesture.dx=touch.clientX-gesture.x;gesture.dy=touch.clientY-gesture.y;
  const forward=gesture.open?-gesture.dx:gesture.dx,vertical=Math.abs(gesture.dy);
  if(!gesture.locked){
   if(vertical>12&&vertical>=Math.abs(gesture.dx)||forward< -12){gesture=null;return;}
   if(forward>14&&forward>vertical*1.5)gesture.locked=true;
  }
  if(gesture?.locked&&event.cancelable)event.preventDefault();
 },{passive:false});
 document.addEventListener('touchend',event=>{
  const g=gesture;gesture=null;if(!g)return;
  const touch=[...event.changedTouches].find(t=>t.identifier===g.id);if(!touch)return;
  const dx=touch.clientX-g.x,dy=Math.abs(touch.clientY-g.y),forward=g.open?-dx:dx;
  if(!g.locked||forward<64||forward<dy*1.5||performance.now()-g.at>1000||$('#dialog')?.open)return;
  suppressSwipeClickUntil=performance.now()+450;
  const open=$('.app')?.classList.contains('sidebar-open');
  if(g.open&&open)closeSidebar();
  else if(!g.open&&!open){window.toggleSidebar();sidebarReturnFocus=$('.mobile-menu');}
 },{passive:true});
 document.addEventListener('touchcancel',()=>{gesture=null},{passive:true});
 document.addEventListener('click',event=>{if(event.isTrusted&&performance.now()<suppressSwipeClickUntil){event.preventDefault();event.stopImmediatePropagation();}},true);
}
document.addEventListener('keydown',event=>{
 if(!$('.app')?.classList.contains('sidebar-open'))return;
 if(event.key==='Escape'){event.preventDefault();closeSidebar();return;}
 if(event.key==='Tab'){
  const items=[...$('#sidebar').querySelectorAll('button,input,select,a[href]')].filter(el=>!el.disabled&&el.getClientRects().length),first=items[0],last=items.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
 }
});
// Freeze sidebar nodes during a drag so live updates cannot remove its source.
const movingChats=new Map(),archivingChats=new Set();
let archiveProjectId="",showArchivedProjects=false;
let chatDrag=null,chatTouch=null,dragClickUntil=0,dragScrollFrame=0;
let projectDrag=null,projectPress=null,projectOrderSaving=false,projectScrollFrame=0;
const sidebarHtmlCache=new WeakMap();
let sidebarInteraction={element:null,touching:false,until:0,timer:0};
function sidebarBusy(){return sidebarInteraction.element===$('#sidebar')&&(sidebarInteraction.touching||performance.now()<sidebarInteraction.until);}
function queueSidebarPaint(){clearTimeout(sidebarInteraction.timer);sidebarInteraction.timer=setTimeout(()=>{sidebarInteraction.timer=0;if(sidebarBusy()||chatTouch||chatDrag||projectPress||projectDrag){queueSidebarPaint();return;}window.renderChatList?.();},Math.max(120,sidebarInteraction.until-performance.now()+20));}
function bindSidebarGestures(sidebar){
 clearTimeout(sidebarInteraction.timer);sidebarInteraction={element:sidebar,touching:false,until:0,timer:0};
 sidebar.addEventListener('touchstart',()=>{dragClickUntil=0;sidebarInteraction.touching=true;sidebarInteraction.until=0;clearTimeout(sidebarInteraction.timer);},{passive:true,capture:true});
 const release=event=>{sidebarInteraction.touching=Boolean(event.touches?.length);sidebarInteraction.until=performance.now()+200;queueSidebarPaint();};
 sidebar.addEventListener('touchend',release,{passive:true});sidebar.addEventListener('touchcancel',release,{passive:true});
 const scroll=()=>{if(sidebarBusy()){sidebarInteraction.until=performance.now()+200;queueSidebarPaint();}};
 sidebar.addEventListener('scroll',scroll,{passive:true});sidebar.querySelector('#chat-list')?.addEventListener('scroll',scroll,{passive:true});
 sidebar.addEventListener('click',()=>{sidebarInteraction.touching=false;sidebarInteraction.until=0;clearTimeout(sidebarInteraction.timer);sidebarInteraction.timer=setTimeout(()=>{sidebarInteraction.timer=0;window.renderChatList?.();},0);});
}
function releaseInterruptedGestures(){
 sidebarInteraction.touching=false;sidebarInteraction.until=0;clearTimeout(sidebarInteraction.timer);sidebarInteraction.timer=0;
 const pane=$('#messages');if(pane){const value=readingState(pane);value.touching=false;value.until=0;clearTimeout(value.timer);value.timer=0;if(value.pending)queueReadingPaint(pane);}
 if(chatTouch||chatDrag)clearChatDrag();
}
window.addEventListener('blur',releaseInterruptedGestures);
document.addEventListener('visibilitychange',()=>{if(document.hidden)releaseInterruptedGestures();});
function clearProjectDrag(){
 clearTimeout(projectPress?.timer);projectPress=null;
 if(projectDrag)dragClickUntil=performance.now()+650;
 projectDrag=null;cancelAnimationFrame(projectScrollFrame);projectScrollFrame=0;
 document.body.classList.remove('moving-project-gesture');
 document.querySelectorAll('.project-drag-source,.project-drop-before,.project-drop-after').forEach(el=>el.classList.remove('project-drag-source','project-drop-before','project-drop-after'));
 queueSidebarPaint();
}
function projectDropAt(x,y){
 const section=document.elementFromPoint(x,y)?.closest('#chat-list .project-group');
 document.querySelectorAll('.project-drop-before,.project-drop-after').forEach(el=>el.classList.remove('project-drop-before','project-drop-after'));
 if(!projectDrag||!section||section.dataset.projectId===projectDrag.id){if(projectDrag)projectDrag.target=null;return false;}
 const head=section.querySelector('.project-group-head'),rect=head.getBoundingClientRect(),placement=y<rect.top+rect.height/2?'before':'after';
 section.classList.add('project-drop-'+placement);projectDrag.target={targetId:section.dataset.projectId,placement};return true;
}
async function saveProjectDrop(id,target){
 if(!target||projectOrderSaving||!state)return;
 const account=state.me.id;projectOrderSaving=true;
 try{const result=await api('/projects/reorder','POST',{projectId:id,...target});if(state?.me.id!==account)return;state.projects=result.projects;renderChatList();}
 catch(error){if(state?.me.id===account){toast(error.message,'error');void refreshState();}}
 finally{projectOrderSaving=false;queueSidebarPaint();}
}
function scrollProjectDrag(){
 if(!projectDrag||projectDrag.kind!=='touch')return;
 const list=compactScreen.matches?$('#sidebar'):$('#chat-list'),r=list?.getBoundingClientRect();
 if(r&&projectDrag.x>=r.left&&projectDrag.x<=r.right){const dy=projectDrag.y<r.top+36?-7:projectDrag.y>r.bottom-36?7:0;if(dy){list.scrollTop+=dy;projectDropAt(projectDrag.x,projectDrag.y);}}
 projectScrollFrame=requestAnimationFrame(scrollProjectDrag);
}
document.addEventListener('dragstart',event=>{
 const button=event.target.closest?.('#chat-list .project-toggle');if(!button)return;
 if(projectOrderSaving||chatDrag||projectDrag?.kind==='touch'){event.preventDefault();return;}
 clearTimeout(projectPress?.timer);projectPress=null;
 projectDrag={id:button.dataset.projectToggle,kind:'mouse',target:null};button.closest('.project-group').classList.add('project-drag-source');
 event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-teamroom-project',projectDrag.id);
});
document.addEventListener('dragover',event=>{if(projectDrag?.kind!=='mouse')return;event.preventDefault();event.dataTransfer.dropEffect=projectDropAt(event.clientX,event.clientY)?'move':'none';});
document.addEventListener('drop',event=>{if(projectDrag?.kind!=='mouse')return;event.preventDefault();projectDropAt(event.clientX,event.clientY);const {id,target}=projectDrag;clearProjectDrag();void saveProjectDrop(id,target);},true);
document.addEventListener('dragend',()=>{if(projectDrag?.kind==='mouse')clearProjectDrag();});
document.addEventListener('touchstart',event=>{
 if(event.touches.length!==1){if(projectPress||projectDrag)clearProjectDrag();return;}
 const button=event.target.closest?.('#chat-list .project-toggle');
 if(!button||projectOrderSaving||chatDrag||$('#dialog')?.open)return;
 clearProjectDrag();const touch=event.touches[0],press={identifier:touch.identifier,x:touch.clientX,y:touch.clientY,button};projectPress=press;
 press.timer=setTimeout(()=>{if(projectPress!==press||!button.isConnected)return;projectDrag={id:button.dataset.projectToggle,kind:'touch',target:null,x:press.x,y:press.y};button.closest('.project-group').classList.add('project-drag-source');document.body.classList.add('moving-project-gesture');projectScrollFrame=requestAnimationFrame(scrollProjectDrag);},450);
},{passive:true});
document.addEventListener('touchmove',event=>{
 if(!projectPress)return;const touch=[...event.touches].find(t=>t.identifier===projectPress.identifier);
 if(!touch||event.touches.length!==1){clearProjectDrag();return;}
 if(!projectDrag){if(Math.hypot(touch.clientX-projectPress.x,touch.clientY-projectPress.y)>9)clearProjectDrag();return;}
 if(event.cancelable)event.preventDefault();projectDrag.x=touch.clientX;projectDrag.y=touch.clientY;projectDropAt(touch.clientX,touch.clientY);
},{passive:false});
document.addEventListener('touchend',event=>{
 if(!projectPress)return;const touch=[...event.changedTouches].find(t=>t.identifier===projectPress.identifier);if(!touch)return;
 if(projectDrag){projectDropAt(touch.clientX,touch.clientY);if(event.cancelable)event.preventDefault();}const id=projectDrag?.id,target=projectDrag?.target;clearProjectDrag();if(id)void saveProjectDrop(id,target);
},{passive:false});
document.addEventListener('touchcancel',()=>{if(projectPress||projectDrag)clearProjectDrag();},{passive:true});
document.addEventListener('contextmenu',event=>{if(projectPress||projectDrag)event.preventDefault();});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&(projectPress||projectDrag))clearProjectDrag();});
window.addEventListener('blur',()=>{if(projectPress||projectDrag)clearProjectDrag();});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&(projectPress||projectDrag))clearProjectDrag();});
function movableChat(id){const c=state?.chats.find(c=>c.id===id);return c&&!c.run&&!movingChats.has(id)&&!archivingChats.has(id)&&!pendingChatSubmission(id)&&(state.me.owner||c.owner===state.me.name)?c:null;}
// Opening another pane is allowed while a chat runs; moving its project still uses movableChat.
function draggableChat(id){const c=state?.chats.find(c=>c.id===id);return c&&!c.archivedAt&&!movingChats.has(id)&&!archivingChats.has(id)&&!isEmbeddedPane&&innerWidth>1000?c:movableChat(id);}
function pendingChatSubmission(id){return (sendingMessage&&selectedId===id)||[...pendingSends.values()].some(p=>p.chatId===id&&p.message?.clientSending==='sending');}
function dragProjectAt(x,y){return document.elementFromPoint(x,y)?.closest('.project-group-head')?.closest('[data-project-id]')?.dataset.projectId||'';}
function highlightChatDrop(id){
 const allowed=chatDrag&&movableChat(chatDrag.id)&&id!==chatDrag.sourceProject&&state?.projects.some(p=>p.id===id);if(chatDrag)chatDrag.target=allowed?id:'';
 document.querySelectorAll('.project-drop-target').forEach(el=>el.classList.remove('project-drop-target'));
 if(allowed)document.querySelector(`[data-project-id="${CSS.escape(id)}"]`)?.classList.add('project-drop-target');
 return Boolean(allowed);
}
function clearChatDrag({render=true}={}){
 if(chatTouch)clearTimeout(chatTouch.timer);chatTouch=null;
 cancelAnimationFrame(dragScrollFrame);dragScrollFrame=0;
 if(chatDrag)dragClickUntil=performance.now()+650;chatDrag=null;splitWorkspace?.endSessionDrag();
 document.querySelectorAll('.chat-dragging,.project-drop-target').forEach(el=>el.classList.remove('chat-dragging','project-drop-target'));
 $('.chat-drag-ghost')?.remove();document.body.classList.remove('moving-chat-gesture');
 if(render)window.renderChatList?.();
}
function touchDragScroll(){
 if(chatDrag?.kind!=='touch')return;
 const list=compactScreen.matches?$('#sidebar'):$('#chat-list'),r=list?.getBoundingClientRect();
 if(r&&chatDrag.x>=r.left&&chatDrag.x<=r.right){
  const dy=chatDrag.y<r.top+36?-7:chatDrag.y>r.bottom-36?7:0;
  if(dy){list.scrollTop+=dy;highlightChatDrop(dragProjectAt(chatDrag.x,chatDrag.y));}
 }
 dragScrollFrame=requestAnimationFrame(touchDragScroll);
}
document.addEventListener('dragstart',event=>{
 const row=event.target.closest?.('#chat-list .chat-row');if(!row)return;
 const c=draggableChat(row.dataset.chatId);
 if(!c||chatDrag?.kind==='touch'){event.preventDefault();return;}
 if(chatTouch)clearTimeout(chatTouch.timer);chatTouch=null;
 chatDrag={id:c.id,sourceProject:c.projectId,target:'',kind:'mouse'};row.classList.add('chat-dragging');
 const canOpen=!isEmbeddedPane&&innerWidth>1000;event.dataTransfer.effectAllowed=canOpen?(movableChat(c.id)?'copyMove':'copy'):'move';event.dataTransfer.setData('application/x-teamroom-chat',c.id);event.dataTransfer.setData('text/plain',c.title);if(canOpen)splitWorkspace?.beginSessionDrag(c.id);
});
document.addEventListener('dragover',event=>{
 if(chatDrag?.kind!=='mouse')return;
 const id=event.target.closest?.('.project-group-head')?.closest('[data-project-id]')?.dataset.projectId||'';
 event.preventDefault();const openRight=Boolean(splitWorkspace?.updateSessionDrag(event.clientX,event.clientY));event.dataTransfer.dropEffect=openRight?'copy':highlightChatDrop(id)?'move':'none';if(openRight)highlightChatDrop('');
});
document.addEventListener('drop',event=>{
 if(chatDrag?.kind!=='mouse')return;
 event.preventDefault();event.stopPropagation();
 const id=event.target.closest?.('.project-group-head')?.closest('[data-project-id]')?.dataset.projectId||'';
 const c=chatDrag.id,openRight=Boolean(splitWorkspace?.updateSessionDrag(event.clientX,event.clientY)),allowed=!openRight&&highlightChatDrop(id);clearChatDrag();if(openRight)splitWorkspace?.openDroppedSession(c);else if(allowed)void dropChatInProject(c,id);
},true);
document.addEventListener('dragend',()=>{if(chatDrag?.kind==='mouse')clearChatDrag();});
document.addEventListener('touchstart',event=>{
 if(event.touches.length!==1&&(chatTouch||chatDrag?.kind==='touch'))clearChatDrag();
 const row=event.target.closest?.('#chat-list .chat-row');if(!row||event.touches.length!==1||$('#dialog')?.open)return;
 const c=movableChat(row.dataset.chatId);if(!c)return;clearChatDrag({render:false});
 const t=event.touches[0],pending={id:t.identifier,x:t.clientX,y:t.clientY,row,chatId:c.id,sourceProject:c.projectId};chatTouch=pending;
 pending.timer=setTimeout(()=>{
  if(chatTouch!==pending)return;if(!row.isConnected||!movableChat(c.id)){clearChatDrag();return;}
  chatDrag={id:c.id,sourceProject:c.projectId,target:'',kind:'touch',x:pending.x,y:pending.y};row.classList.add('chat-dragging');document.body.classList.add('moving-chat-gesture');
  const ghost=document.createElement('div');ghost.className='chat-drag-ghost';ghost.textContent=c.title;ghost.style.left=pending.x+'px';ghost.style.top=(pending.y-44)+'px';document.body.append(ghost);
  dragScrollFrame=requestAnimationFrame(touchDragScroll);
 },450);
},{passive:true});
document.addEventListener('touchmove',event=>{
 if(!chatTouch)return;
 const t=[...event.touches].find(t=>t.identifier===chatTouch.id);
 if(!t||event.touches.length!==1){clearChatDrag();return;}
 if(chatDrag?.kind!=='touch'){
  if(Math.hypot(t.clientX-chatTouch.x,t.clientY-chatTouch.y)>9)clearChatDrag();return;
 }
 if(event.cancelable)event.preventDefault();chatDrag.x=t.clientX;chatDrag.y=t.clientY;
 const ghost=$('.chat-drag-ghost');if(ghost){ghost.style.left=t.clientX+'px';ghost.style.top=(t.clientY-44)+'px';}
 highlightChatDrop(dragProjectAt(t.clientX,t.clientY));
},{passive:false});
document.addEventListener('touchend',event=>{
 if(!chatTouch)return;const t=[...event.changedTouches].find(t=>t.identifier===chatTouch.id);if(!t)return;
 const active=chatDrag?.kind==='touch',id=chatDrag?.id,target=active?dragProjectAt(t.clientX,t.clientY):'',allowed=active&&highlightChatDrop(target);
 if(active&&event.cancelable)event.preventDefault();clearChatDrag();if(allowed)void dropChatInProject(id,target);
},{passive:false});
document.addEventListener('touchcancel',()=>{if(chatTouch)clearChatDrag();},{passive:true});
document.addEventListener('contextmenu',event=>{if(chatTouch||chatDrag?.kind==='touch')event.preventDefault();});
document.addEventListener('click',event=>{if(performance.now()<dragClickUntil&&event.target.closest?.('#chat-list')){event.preventDefault();event.stopImmediatePropagation();}},true);
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&(chatDrag||chatTouch)){event.preventDefault();event.stopImmediatePropagation();clearChatDrag();}},true);
document.addEventListener('visibilitychange',()=>{if(document.hidden&&(chatDrag||chatTouch))clearChatDrag();});
window.addEventListener('blur',()=>{if(chatDrag||chatTouch)clearChatDrag();});
const completionReadRequests=new Map();
function acknowledgeVisibleCompletion(){
 if(!state||!chat||chat.id!==selectedId||chatLoading||chatLoadError||uiBackground()||chat.history?.hasLater||$('#dialog')?.open)return;
 const completion=chat.completion,summary=state.chats.find(c=>c.id===chat.id);
 if(!completion?.token||summary?.completion?.token!==completion.token||!summary.unreadCompletion)return;
 const message=replyMessages(chat).find(m=>m.id===completion.messageId);
 if(!message||message.status==='running')return;
 const account=state.me.id,id=chat.id,token=completion.token,key=account+':'+id+':'+token;
 if((completionReadRequests.get(key)||0)>Date.now())return;
 completionReadRequests.set(key,Infinity);
 void api('/chats/'+encodeURIComponent(id)+'/read','POST',{token}).then(result=>{
  if(state?.me.id!==account)return;
  const summary=state.chats.find(c=>c.id===id);
  if(result.read&&result.completion?.token===token&&summary?.completion?.token===token){summary.unreadCompletion=false;renderChatList();}
 }).catch(()=>{completionReadRequests.set(key,Date.now()+15000);setTimeout(()=>completionReadRequests.delete(key),15000);}).finally(()=>{if(completionReadRequests.get(key)===Infinity)completionReadRequests.delete(key);});
}
function sessionSidebarRow(c,titleCounts){
 const moving=movingChats.has(c.id),archiving=archivingChats.has(c.id),owned=state.me.owner||c.owner===state.me.name;
 const meta=moving?'Переношу…':archiving?'Сохраняю…':c.id===selectedId&&chatLoading?'Открываю…':`${titleCounts.get(c.title)>1?(c.messageCount||0)+' записей · ':''}${c.owner||''}${c.deviceName?' · '+c.deviceName:''}${c.run?' · '+runStageLabel(c.run)+' · '+providerName(c.run.provider):''}`;
 return `<div class="chat-row-wrap ${c.archivedAt?'archived':''}"><button class="chat-row ${c.id===selectedId?'active':''} ${c.id===selectedId&&chatLoading?'loading':''} ${moving||archiving?'chat-moving':''} ${c.unreadCompletion?'session-unread':''}" data-chat-id="${esc(c.id)}" draggable="${Boolean(draggableChat(c.id))}" title="${esc(c.title)}${!isEmbeddedPane&&innerWidth>1000?' · Перетащи вправо, чтобы открыть рядом':owned&&!c.run?' · Перетащи на название другого проекта':''}" aria-current="${c.id===selectedId?'true':'false'}" aria-busy="${Boolean(moving||archiving||c.id===selectedId&&chatLoading)}" onclick="openChat(${jsArg(c.id)})"><span class="chat-name">${c.run?'<i class="live-dot"></i>':''}${c.unreadCompletion?'<i class="completion-dot" role="img" aria-label="Новый завершённый ответ" title="Новый завершённый ответ"></i>':''}${esc(c.title)}</span><span class="chat-meta">${esc(meta)}</span></button>${owned?`<button class="chat-row-menu" onclick="showSessionMenu(${jsArg(c.id)})" aria-label="Действия с сессией ${esc(c.title)}" title="Действия с сессией" ${moving||archiving?'disabled':''}>•••</button>`:''}</div>`;
}
window.toggleProjectArchive=id=>{archiveProjectId=archiveProjectId===id?'':id;renderChatList();};
window.renderChatList=()=>{
 sessionBoard.stateChanged();
 if(chatDrag||chatTouch||projectDrag||projectPress||sidebarBusy()){queueSidebarPaint();return;}
 const q=$('#chat-search')?.value.toLowerCase().trim()||'',el=$('#chat-list');if(!el||!state)return;
 if(expandedProjectId&&!state.projects.some(p=>p.id===expandedProjectId))expandedProjectId=projectId;
 const archivedProjects=state.projects.filter(p=>p.archivedAt),projects=state.projects.filter(p=>!p.archivedAt||(showArchivedProjects||p.id===projectId));
 const html=projects.map(project=>{
  const expanded=expandedProjectId===project.id,all=state.chats.filter(c=>c.projectId===project.id),matches=all.filter(c=>c.title.toLowerCase().includes(q)||project.name.toLowerCase().includes(q)),visible=matches.filter(c=>!c.archivedAt),archived=matches.filter(c=>c.archivedAt),titleCounts=new Map();for(const c of all)titleCounts.set(c.title,(titleCounts.get(c.title)||0)+1);
  const archiveOpen=archiveProjectId===project.id||Boolean(q);
  const activeSessions=all.filter(c=>c.run),waitingSessions=activeSessions.filter(c=>c.run.phase==='waiting'||c.run.phase==='reconnecting'||c.run.recovering||c.run.connectionLost||state.devices?.find(d=>d.id===(c.run.deviceId||c.executionDeviceId))?.online===false);
  const activityState=activeSessions.length?(waitingSessions.length===activeSessions.length?'waiting':'working'):'';
  const activityLabel=activeSessions.length?`${activityState==='waiting'?'Ожидают':'В работе'}: ${activeSessions.length}`:'';
  const unreadSessions=all.filter(c=>c.unreadCompletion),unreadLabel=unreadSessions.length?`Новых ответов: ${unreadSessions.length}`:'';
  const activityTitle=activeSessions.map(c=>`${c.title} · ${runStageLabel(c.run)} · ${providerName(c.run.provider||c.provider)}`).join('\n');
  const activity=activeSessions.length?`<small class="project-activity" data-activity="${activityState}" title="${esc(activityTitle)}"><i class="project-activity-dot" aria-hidden="true"></i>${activityLabel}</small>`:'';
  return `<section class="project-group ${expanded?'expanded':''} ${project.archivedAt?'project-archived':''}" ${activityState?`data-activity="${activityState}"`: ''} data-project-id="${esc(project.id)}"><div class="project-group-head"><button class="project-toggle" draggable="${!projectOrderSaving}" title="Перетащи, чтобы изменить порядок проектов" data-project-toggle="${esc(project.id)}" aria-expanded="${expanded}" aria-controls="project-chats-${esc(project.id)}" onclick="toggleProject(${jsArg(project.id)})"><svg class="project-chevron" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m5 3 5 5-5 5"/></svg><span>${esc(project.name)}</span>${project.archivedAt?'<small>Архив</small>':''}${activity}${unreadSessions.length?`<small class="project-unread" title="${esc(unreadLabel+'\n'+unreadSessions.map(c=>c.title).join('\n'))}" aria-label="${esc(unreadLabel)}"><i class="completion-dot" aria-hidden="true"></i>${unreadSessions.length}</small>`:''}<small title="Сессий в списке">${visible.length}</small></button><button class="project-menu-button" onclick="showProjectMenu(${jsArg(project.id)})" aria-label="Действия с проектом ${esc(project.name)}" title="Действия с проектом">•••</button></div><div class="project-chats" id="project-chats-${esc(project.id)}" ${expanded?'':'hidden'}>${expanded?visible.map(c=>sessionSidebarRow(c,titleCounts)).join('')||`<p class="project-empty">${q?'Сессии не найдены':'В этом проекте пока нет чатов'}</p>`:''}${expanded&&archived.length?`<button class="project-archive-toggle" aria-expanded="${archiveOpen}" aria-controls="project-archive-${esc(project.id)}" onclick="toggleProjectArchive(${jsArg(project.id)})"><span aria-hidden="true">${archiveOpen?'⌄':'›'}</span> Архив <small>${archived.length}</small></button><div id="project-archive-${esc(project.id)}" ${archiveOpen?'':'hidden'}>${archiveOpen?archived.map(c=>sessionSidebarRow(c,titleCounts)).join(''):''}</div>`:''}</div></section>`;
 }).join('')+(archivedProjects.length?`<button class="archived-projects-toggle" aria-expanded="${showArchivedProjects}" onclick="toggleArchivedProjects()">${showArchivedProjects?'Скрыть архив проектов':'Архив проектов'} · ${archivedProjects.length}</button>`:'');
 if(sidebarHtmlCache.get(el)===html)return;const scrollContainer=compactScreen.matches?$('#sidebar'):el,top=scrollContainer.scrollTop,focusedChat=document.activeElement?.dataset.chatId,focusedProject=document.activeElement?.dataset.projectToggle;el.innerHTML=html;sidebarHtmlCache.set(el,html);scrollContainer.scrollTop=top;if(focusedChat)el.querySelector(`[data-chat-id="${CSS.escape(focusedChat)}"]`)?.focus({preventScroll:true});else if(focusedProject)el.querySelector(`[data-project-toggle="${CSS.escape(focusedProject)}"]`)?.focus({preventScroll:true});
};
function renderDevicesPicker(){
 const select=$('#device-picker');if(!select)return;
 const local=localExecutionDeviceId();
 select.innerHTML=(!state.devices.some(d=>d.id===deviceId)?`<option value="" selected disabled>${window.teamRoomNativeMac&&window.teamRoomLocalDeviceReady===false?'Определяю этот Mac…':'Выбрать компьютер'}</option>`:'')+state.devices.map(d=>`<option value="${esc(d.id)}" ${d.id===deviceId?'selected':''} ${isPhoneClient&&!d.online&&d.id!==deviceId?'disabled':''}>${d.online?'🟢':'🔴'} ${esc(d.name)}${d.id===local?' · этот Mac':''}${isPhoneClient&&!d.online?' · отключён':''}</option>`).join('');
 renderAccountPicker();renderPhoneContext();select.title='Запрос выполняет: '+(state.devices.find(d=>d.id===deviceId)?.name||'выбери компьютер');renderExecutionRoute();
}
function renderExecutionRoute(){
 const el=$('#execution-route');if(!el||!state)return;const chosen=state.devices.find(d=>d.id===deviceId),running=chat?.run,active=state.devices.find(d=>d.id===running?.deviceId);
 el.hidden=(!isPhoneClient&&!compactScreen.matches)||Boolean(networkReady&&chosen?.online&&(!running||running.deviceId===deviceId));if(el.hidden)return;
 const next=chosen?.name||'Компьютер не выбран',current=active?.name||'Выполняющий компьютер';
 el.dataset.offline=String(!networkReady||!chosen?.online);el.innerHTML=`<span class="status-dot ${networkReady&&chosen?.online?'ready':'error'}"></span><span>${esc(!networkReady?'Нет связи с пространством · '+next:running&&running.deviceId!==deviceId?'Работает '+current+' · следующий запрос: '+next:chosen?.online?'Выполняет: '+next:next+' отключён · выбери активный компьютер')}</span><span aria-hidden="true">⌄</span>`;
 el.title=el.textContent;el.setAttribute('aria-label',el.textContent+'. Выбрать компьютер');
}
window.selectProject=async value=>{sessionBoard.hide();cancelChatReads();cancelProjectFileReads();voiceConversation.cancel();dictation.cancel();if(value==='new'){if(isPhoneWebClient)closeSidebar(false);dialog('Новый проект','<p>У каждого проекта свои общие файлы, чаты и память.</p><form id="project-form"><div class="form-row"><label>Название</label><input name="name" required maxlength="80"></div><button class="primary-button">Создать проект</button></form>');$('#project-form').onsubmit=async e=>{e.preventDefault();try{const chosen=window.teamRoomNativeMac&&!newChatDeviceExplicit?localExecutionDeviceId():deviceId;if(!chosen)throw new Error(missingExecutionDeviceText());const p=await api('/projects','POST',{...Object.fromEntries(new FormData(e.target)),deviceId:chosen});state=await api('/state');saveScroll();chatOpenGeneration++;chatLoading=false;chatLoadError='';pendingScrollRestore=null;projectId=p.id;expandedProjectId=p.id;selectedId='';chat=null;deviceId=chosen;newChatDeviceExplicit=Boolean(window.teamRoomNativeMac&&chosen!==localExecutionDeviceId());roomLocalStorage.setItem('roomDevice',chosen);rememberView();closeDialog();renderShell();void loadCatalog()}catch(error){toast(error.message,'error')}};return}saveScroll();chatOpenGeneration++;chatLoading=false;chatLoadError='';pendingScrollRestore=null;projectId=value;expandedProjectId=value;selectedId='';chat=null;appliedRouteSelection='';files=[];attachments=[];resetNewChatDevice();rememberView();renderShell();void loadCatalog()};
window.openChat=async value=>{sessionBoard.hide();if(value!==selectedId){voiceConversation.cancel();dictation.cancel();}
 if(value===selectedId&&chatLoading&&chatLoads.has(value+':'+(historyBefore??'latest')))return;
 const changing=chat?.id!==value;cancelStreamPaint();saveScroll();const generation=++chatOpenGeneration;
 selectedId=value||'';chatLoadError='';chatLoading=Boolean(value);pendingScrollRestore=value?(readScroll(value)||{bottom:true,top:0}):null;
 const summary=state.chats.find(c=>c.id===value);if(summary){if(summary.projectId!==projectId){attachments=[];renderAttachments();}projectId=summary.projectId;expandedProjectId=projectId;$('#project-picker').value=projectId;}
 rememberView();closeSidebar(false);renderChatList();
 if(!value){chat=null;chatLoading=false;renderMessages();return;}
 if(changing){newChatDeviceExplicit=false;historyBefore=null;requestGeneration++;catalogBusy=false;chat=chatCache.get(value)||readChatPreview(value);files=[];filesProjectId=null;applyChatRoute(chat);}
 if(changing||!chat||visibleMessagesChanged(chat,chat))renderMessages();else{renderComposer();renderStatus();}
 try{
  const result=await fetchChat(value);if(generation!==chatOpenGeneration||value!==selectedId)return;
  const redraw=visibleMessagesChanged(chat,result),previousRoute=subscriptionKey();
  chat=result;chatLoading=false;applyChatRoute(chat);renderChatList();
  if(redraw)renderMessages();else{pendingScrollRestore=null;renderComposer();renderStatus();}
  if(changing||previousRoute!==subscriptionKey())void loadCatalog();void refreshFiles();
 }catch(error){if(generation!==chatOpenGeneration||value!==selectedId)return;chatLoading=false;chatLoadError=error.message;if(error.status===401){clearAuthView();renderAuth();return;}renderChatList();renderMessages();toast(error.message,'error')}
};
window.detachSource=async()=>{try{await api('/chats/'+chat.id+'/detach-source','POST',{});await openChat(chat.id);toast('Сохранённый контекст готов. Дальше работай в этом чате; исходная сессия остаётся отдельно.');}catch(e){toast(e.message,'error')}};
window.newChat=()=>{sessionBoard.hide();executionMode=executionPreference();cancelChatReads();voiceConversation.cancel();dictation.cancel();saveScroll();chatOpenGeneration++;chatLoading=false;chatLoadError='';pendingScrollRestore=null;selectedId='';chat=null;appliedRouteSelection='';resetNewChatDevice();historyBefore=null;draft='';attachments=[];pendingMessageId=null;$('#message-input').value='';rememberView();renderDevicesPicker();renderMessages();renderChatList();renderAttachments();void loadCatalog();closeSidebar(false);if(!isPhoneClient&&!compactScreen.matches)$('#message-input').focus()};
// Display parts are derived from one native answer. Never insert them into the
// canonical history: resuming, compaction and provider switching use that once.
function replyDisplayCuts(text,boundaries){
 const spans=[];
 for(const [open,close]of [['```','```'],['\uE200visualize','\uE201']]){let at=0,start;while((start=text.indexOf(open,at))>=0){const end=text.indexOf(close,start+open.length);at=end<0?text.length:end+close.length;spans.push([start,at]);if(end<0)break;}}
 // A native steer can be acknowledged in the middle of a streamed link/code.
 // Keep the complete construct together; persisted provider offsets stay raw.
 for(const match of text.matchAll(/!?\[([^\]\n]+)\]\((?:<([^>\n]+)>|((?:[^()\n]|\([^()\n]*\))+))\)|`[^`\n]*`|`[^`\n]*$|!?\[[^\]\n]*(?:\]\([^\n]*)?$/g))spans.push([match.index,match.index+match[0].length]);
 return boundaries.map(b=>{let offset=Math.min(b.offset,text.length),changed;do{changed=false;for(const [start,end]of spans)if(start<offset&&offset<end){offset=end;changed=true;}}while(changed);return {...b,offset};});
}
function displayMessages(messages=chat?.messages||[],references=chat?.replyReferences||[]){
 const visible=new Map(messages.map(m=>[m.id,m])),sources=new Map(messages.filter(m=>m.role==='assistant').map(m=>[m.id,m]));
 for(const m of references)if(m.role==='assistant'&&!sources.has(m.id))sources.set(m.id,m);
 const atSource=new Map(),afterUser=new Map();
 for(const m of sources.values()){
  const seen=new Set(),boundaries=replyBoundaries(m).filter(b=>typeof b.messageId==='string'&&Number.isSafeInteger(b.offset)&&b.offset>=0&&!seen.has(b.messageId)&&seen.add(b.messageId)).sort((a,b)=>a.offset-b.offset);
  if(!boundaries.length){if(visible.has(m.id))atSource.set(m.id,[m]);continue;}
  const text=m.text||'',cuts=replyDisplayCuts(text,boundaries),parts=[{id:m.id,start:0,end:cuts[0].offset},...cuts.map((b,index)=>({id:m.id+':reply:'+b.messageId,anchor:b.messageId,start:b.offset,end:cuts[index+1]?.offset??text.length}))];
  const included=parts.filter(p=>(visible.has(m.id)||visible.get(p.anchor)?.role==='user')&&(text.slice(p.start,p.end)||p===parts.at(-1)));
  const copyOwner=included.findLast(p=>text.slice(p.start,p.end));let precedingAnchor;
  for(const p of parts){
   if(visible.get(p.anchor)?.role==='user')precedingAnchor=p.anchor;
   if(!included.includes(p))continue;
   const row={...m,id:p.id,text:text.slice(p.start,p.end),_sourceMessageId:m.id,_replyOwner:p===included.at(-1),_replyCopyOwner:p===copyOwner};
   if(!row._replyOwner)row.status='completed';
   const target=precedingAnchor?afterUser:atSource,key=precedingAnchor||m.id;
   const rows=target.get(key)||[];rows.push(row);target.set(key,rows);
  }
 }
 const result=[];
 for(const m of messages){result.push(...(m.role==='assistant'?atSource.get(m.id)||[]:[m]));result.push(...(afterUser.get(m.id)||[]));}
 return result;
}
function renderMessages(){
 cancelStreamPaint();const pane=$('#messages');if(!pane)return;
 if(chatLoadError&&!chat&&selectedId){$('#conversation').classList.remove('is-empty');$('#welcome-hints').style.display='none';$('#chat-title').textContent=state.chats.find(c=>c.id===selectedId)?.title||'Разговор';pane.innerHTML=('<div class="chat-load-error" role="alert"><h2>Не удалось открыть историю</h2><p>'+esc(chatLoadError)+'</p><button onclick="openChat('+jsArg(selectedId)+')">Попробовать снова</button></div>');renderComposer();renderStatus();return;}
 if(chatLoading&&!chat){$('#conversation').classList.remove('is-empty');$('#welcome-hints').style.display='none';$('#chat-title').textContent=state.chats.find(c=>c.id===selectedId)?.title||'Открываю разговор…';pane.setAttribute('aria-busy','true');pane.innerHTML='<div class="chat-loading" role="status"><span class="chat-loading-dot" aria-hidden="true"></span>Открываю разговор…</div>';renderComposer();renderStatus();return;}
 const reading=readingState(pane);
 if(chat?.id===selectedId&&readerBusy(pane)){queueReadingPaint(pane);renderComposer();renderStatus();return;}
 clearTimeout(reading.timer);reading.timer=0;reading.pending=false;pane.removeAttribute('aria-busy');
 const position=captureReadingPosition(pane),focusedApproval=document.activeElement?.closest?.('[data-approval-id]'),focusedQuestion=focusedApproval&&document.activeElement.dataset.question,focusedSelection=focusedQuestion?{start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd}:null;
 for(const input of pane.querySelectorAll('.approval [data-question]'))rememberApprovalInput(input);
 const messages=[...(chat?.messages||[])],openedActions=new Set(Array.from(pane.querySelectorAll('.actions-log[open]')).map(el=>el.dataset.actions));
 for(const [id,pending]of pendingSends){if(messages.some(m=>m.id===id)){pendingSends.delete(id);continue;}if(pending.chatId===chat?.id&&pending.projectId===projectId)messages.push(pending.message);}
 const rows=displayMessages(messages),acceptedIndex=rows.findLastIndex(m=>m.role==='user'&&(m.clientSending==='accepted'||m.status==='completed'&&!['queued','sending','uncertain','cancelled'].includes(m.delivery)));
 recoveryErrors=new Set(rows.filter((m,index)=>m.error&&m._replyOwner!==false&&index>acceptedIndex).map(m=>m._sourceMessageId||m.id));
 $('#conversation').classList.toggle('is-empty',!messages.length);$('#welcome-hints').style.display=messages.length?'none':'flex';$('#chat-title').textContent=chat?.title||'Новый чат';
 let html=messages.length?(chat?.history?.hasEarlier||chat?.history?.hasLater?'<div class="history-navigation">'+(chat.history.hasEarlier?'<button onclick="historyPage('+chat.history.start+')">Предыдущие сообщения</button>':'')+(chat.history.hasLater?'<button onclick="historyPage('+Math.min(chat.history.total,chat.history.end+80)+')">Следующие сообщения</button><button onclick="historyPage(null)">К последним</button>':'')+'<small>'+(chat.history.start+1)+'–'+chat.history.end+' из '+chat.history.total+'</small></div>':'')+rows.map(m=>messageHtml(m)).join(''):'<div class="empty"><img class="clawd-mascot" src="'+(isPhoneWebClient?'/provider-mark.svg':'/assistant-mark.svg')+'" alt="'+(isPhoneWebClient?'Claude':'Clawd — персонаж Claude Code')+'" width="96" height="68"><h1>'+(isPhoneWebClient?'Чем займёмся?':'Чем займёмся, '+esc(state.me.name)+'?')+'</h1><p>Продолжай один разговор с Claude или Codex.<br>История, память и файлы остаются с тобой.</p></div>';
 if(chat?.importSource?.watch)html+='<div class="source-banner">'+(chat.importSource.active?'Исходный чат ещё работает. Новые сообщения подтягиваются автоматически; продолжить здесь можно после завершения.':'Импорт связан с исходным чатом. До первого сообщения здесь новые ответы источника подтягиваются автоматически.')+(chat.importSource.lastError?'<br>Последнее обновление не удалось: '+esc(chat.importSource.lastError):'')+(chat.importSource.active||chat.importSource.lastError?'<br><button onclick="detachSource()">Продолжить здесь из сохранённого контекста</button>':'')+'</div>';
 if(chat?.approvals?.length)html+=chat.approvals.map(approvalHtml).join('');
 paintingMessages=true;
 try{
  reconcileMessages(pane,html);
  if(focusedApproval?.dataset.approvalChat===chat?.id&&focusedQuestion){const card=pane.querySelector('[data-approval-id="'+CSS.escape(focusedApproval.dataset.approvalId)+'"]'),input=card?.querySelector('[data-question="'+CSS.escape(focusedQuestion)+'"]');if(input&&!input.disabled){input.focus({preventScroll:true});if(focusedSelection)input.setSelectionRange(focusedSelection.start,focusedSelection.end);}}
  for(const el of pane.querySelectorAll('.actions-log'))if(openedActions.has(el.dataset.actions)){el.open=true;renderActionDetails(el);}
  renderedChatView=chatRenderSnapshot(chat);chatTools.syncQueue();renderComposer();renderStatus();
  // Restore only after agents, approvals and composer have their final heights.
  if(pendingScrollRestore){const saved=pendingScrollRestore;pendingScrollRestore=null;restoreReadingPosition(pane,saved);}else restoreReadingPosition(pane,position);
 }finally{paintingMessages=false;}
}

function messageHtml(m){const user=m.role==='user',source=m._sourceMessageId||m.id,owner=m._replyOwner!==false;return `<article class="message ${user?'user':'assistant'}" data-message="${esc(m.id)}" data-source-message="${esc(source)}">${user?'':`<div class="message-label"><span class="star">${/claude/i.test(m.provider||'')?'<img class="claude-spark" src="/provider-mark.svg" alt="" width="18" height="18">':'✳'}</span>${providerName(m.provider)} ${m.model?'· '+esc(m.model):''}${m.status==='running'?' · '+esc(m.runId&&m.runId!==chat?.run?.id?'работает':runStageLabel(chat?.run)||'работает'):''}</div>`}${!user&&owner&&m.actions?.length?`<details class="actions-log" data-actions="${esc(source)}" ontoggle="renderActionDetails(this)"><summary>${m.actions.length} ${m.actions.length===1?'действие':'действий'}</summary><div class="action-details"></div></details>`:''}${!user&&owner?`<div class="message-agents" data-agent-message="${esc(source)}" hidden></div>`:''}<div class="message-text">${user?esc(m.text).replace(/\n/g,'<br>'):assistantText(m)|| (m.status==='running'?'<span class="muted">'+esc(pendingResponseText())+'</span>':'')}</div>${(owner?m.attachments||[]:[]).map(a=>`<span class="attachment"><a href="${fileUrl(a.path||a.name)}" target="_blank">${esc(a.name)}</a></span>`).join('')}${user&&m.followup?followupHtml(m):''}${m.clientSending?sendStateHtml(m):''}${owner&&m.syncWarning?`<p class="sync-warning">${esc(m.syncWarning)}</p>`:''}${owner&&m.error&&recoveryErrors.has(source)?`<div class="error-box">${esc(m.error)}<br>История и уже сохранённые файлы доступны для продолжения.<br>${recoveryActions(m)}</div>`:''}${!user&&(m._replyCopyOwner??owner)&&m.status!=='running'&&m.text?`<div class="message-actions"><button onclick="copyMessage(${jsArg(source)},${jsArg(m.id)})">Копировать</button><button onclick="rememberMessage(${jsArg(source)},${jsArg(m.id)})">В память проекта</button>${owner?`<button onclick="forkChat(${jsArg(source)})">Ответвить</button><button onclick="askSideQuestion(${jsArg(source)})">Отдельный вопрос</button>${m.executionMode==='plan'?`<button class="implement-plan" onclick="implementPlan(${jsArg(source)})" ${chat?.run||chat?.kind==='side'?'disabled':''}>Начать реализацию</button>`:''}`:''}</div>`:''}</article>`}
function recoveryActions(message){
 const same=/claude/i.test(message.provider)?'claude':'codex',other=same==='claude'?'codex':'claude';
 const disabled=resuming||chatLoading||sendingMessage||Boolean(chat?.run)||Boolean(chat?.importSource?.active);
 return `<div class="recovery-actions"><button class="recovery-continue" data-resume-provider="${same}" ${disabled?'disabled':''} onclick="continueWith(${jsArg(same)})">Продолжить с ${providerName(same)}</button><button class="recovery-switch" data-resume-provider="${other}" ${disabled?'disabled':''} onclick="continueWith(${jsArg(other)})">Перейти на ${providerName(other)}</button></div>`;
}
function renderRecoveryButtons(){for(const button of document.querySelectorAll('[data-resume-provider]'))button.disabled=Boolean(chat?.archivedAt)||archivingChats.has(selectedId)||movingChats.has(selectedId)||resuming||chatLoading||sendingMessage||Boolean(chat?.run)||Boolean(chat?.importSource?.active);}
const approvalDrafts=new Map(),approvalInFlight=new Map(),approvalErrors=new Map();
const approvalKey=(chatId,id)=>chatId+':'+id;
function rememberApprovalInput(input){const card=input.closest('[data-approval-id]');if(!card)return;const key=approvalKey(card.dataset.approvalChat,card.dataset.approvalId),answers=approvalDrafts.get(key)||Object.create(null);answers[input.dataset.question]=input.value;approvalDrafts.set(key,answers);if(approvalDrafts.size>100)approvalDrafts.delete(approvalDrafts.keys().next().value);}
document.addEventListener('input',event=>{if(event.target.matches?.('.approval [data-question]'))rememberApprovalInput(event.target);});
function approvalHtml(a){
 const questions=a.details?.questions,key=approvalKey(chat.id,a.id),answers=approvalDrafts.get(key)||Object.create(null),busy=approvalInFlight.has(key),error=approvalErrors.get(key);
 return `<div class="approval" data-approval-id="${esc(a.id)}" data-approval-chat="${esc(chat.id)}" tabindex="-1" aria-busy="${busy}"><h4>${questions?'Нужен твой ответ':'Разрешить действие?'}</h4>${questions?questions.map((q,index)=>{const name=q.id||q.question||q.header,list='approval-options-'+a.id+'-'+index;return `<label>${esc(q.question||q.header||q.id)}<input data-question="${esc(name)}" value="${esc(answers[name]||'')}" placeholder="Твой ответ" ${busy?'disabled':''} ${q.options?.length?'list="'+esc(list)+'"':''}></label>${q.options?.length?`<datalist id="${esc(list)}">${q.options.map(o=>`<option value="${esc(o.label)}">${esc(o.description||'')}</option>`).join('')}</datalist>`:''}`;}).join(''):`<p>${esc(a.tool)}</p><pre>${esc(JSON.stringify(a.details,null,2))}</pre>`}<div class="form-feedback" data-kind="${error?'error':'notice'}" role="${error?'alert':'status'}" aria-live="polite" ${!busy&&!error?'hidden':''}>${esc(error||'Передаю твой ответ на выполняющий компьютер…')}</div><div class="approval-actions"><button type="button" class="primary" onclick="answerApproval(${jsArg(a.id)},true)" ${busy?'disabled':''}>${busy?'Отправляю…':questions?'Отправить ответ':'Разрешить'}</button><button type="button" onclick="answerApproval(${jsArg(a.id)},false)" ${busy?'disabled':''}>Отклонить</button></div></div>`;
}
window.answerApproval=async(id,allow)=>{
 const targetChat=chat?.id,account=state?.me.id,key=approvalKey(targetChat,id);if(!targetChat||approvalInFlight.has(key))return;
 const card=$('#messages')?.querySelector(`[data-approval-id="${CSS.escape(id)}"]`);if(!card)return;
 const answers=Object.fromEntries(Array.from(card.querySelectorAll('[data-question]')).map(input=>[input.dataset.question,input.value]));approvalDrafts.set(key,answers);approvalErrors.delete(key);approvalInFlight.set(key,true);renderMessages();
 try{
  await api('/chats/'+targetChat+'/approval','POST',{id,allow,answers},{timeoutMs:20000});if(state?.me.id!==account)return;approvalDrafts.delete(key);approvalErrors.delete(key);
  if(chat?.id===targetChat){chat.approvals=chat.approvals.filter(a=>a.id!==id);if(chat.run&&!chat.approvals.length&&chat.run.phase==='waiting'){chat.run.phase='running';chat.run.waitingFor=null;chat.run.text='Продолжает работу…';}}
  dirtyChats.add(targetChat);scheduleStateRefresh();
 }catch(error){
  // Approval replies are acknowledged by the worker; keep the card on delivery failure.
  if(state?.me.id!==account)return;approvalErrors.set(key,error.name==='TimeoutError'||error.name==='AbortError'?'Ответ пока не подтверждён. Он мог быть получен. Повтори отправку после восстановления связи.':error.message);
  if(chat?.id!==targetChat)toast('Не удалось подтвердить ответ в другом чате. Открой его и повтори отправку.');
 }finally{approvalInFlight.delete(key);if(chat?.id===targetChat)renderMessages();}
};

let subscriptionSelections={};try{const saved=JSON.parse(roomLocalStorage.getItem('roomSubscriptionAccounts')||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))subscriptionSelections=saved;}catch{}
function selectedAccountId(device=deviceId,p=provider){return subscriptionSelections[device+':'+p]||'';}
function rememberAccount(value,device=deviceId,p=provider){subscriptionSelections[device+':'+p]=value||'';roomLocalStorage.setItem('roomSubscriptionAccounts',JSON.stringify(subscriptionSelections));}
function subscriptionKey(device=deviceId,p=provider,id=selectedAccountId(device,p)){return device+':'+p+(id?':'+id:'');}
function subscriptionName(device=deviceId,p=provider,id=selectedAccountId(device,p)){return id?state?.devices.find(d=>d.id===device)?.accounts?.find(a=>a.id===id&&a.provider===p)?.name||'Выбранный аккаунт':'Основной аккаунт';}
function renderAccountPicker(){const button=$('#account-picker');if(button){button.textContent=subscriptionName()+' ⌄';button.title=providerName(provider)+' · '+subscriptionName()+'. Выбрать аккаунт подписки';}}
window.showProviderAccounts=async(p=provider)=>{
 const device=deviceId,owner=state?.me.id,chosen=state.devices.find(d=>d.id===device);if(!chosen?.online)return toast('Выбери подключённый компьютер.');
 const render=records=>{
  const list=[{id:'',name:'Основной аккаунт',provider:p,status:chosen.status?.[p]},...records.filter(a=>a.provider===p)];
  dialog('Аккаунты '+providerName(p),`<div class="subscription-description"><strong>${esc(chosen.name)}</strong><p>Входы хранятся на этом компьютере. История, память и файлы чата общие для всех аккаунтов.</p></div><div class="subscription-accounts">${list.map(a=>`<div class="subscription-account ${selectedAccountId(device,p)===a.id?'selected':''}"><button class="subscription-select" onclick="chooseSubscription(${jsArg(device)},${jsArg(p)},${jsArg(a.id)})"><span class="status-dot ${a.status?.connected?'ready':a.status?.connected===false?'error':''}"></span><span><strong>${esc(a.name)}</strong><small>${a.loginBusy?'Ожидает завершения входа':a.status?.connected?'Подписка подключена'+(a.status.email?' · '+esc(a.status.email):''):a.status?.detail||'Вход ещё не проверен'}</small></span><span aria-hidden="true">${selectedAccountId(device,p)===a.id?'✓':'→'}</span></button>${!isPhoneClient?`<button class="subscription-login" onclick="loginSubscription(${jsArg(device)},${jsArg(p)},${jsArg(a.id)})">${a.status?.connected?'Повторить вход':'Войти'}</button>`:''}</div>`).join('')}</div>${chosen.accountsVersion===1&&!chosen.accountsError?`<form id="subscription-add" class="subscription-add"><label for="subscription-name">Новый аккаунт</label><div><input id="subscription-name" name="name" placeholder="Например: Личный или Работа" maxlength="60" required><button type="submit" class="primary-button">Добавить</button></div><p id="subscription-error" role="alert" class="auth-error"></p></form>`:`<p class="auth-error" role="alert">${esc(chosen.accountsError||'Для нескольких аккаунтов обнови Team Room на этом Mac, затем «Этот Mac → Обновить подключение».')}</p>`}${isPhoneClient?'<p class="muted">Новый вход заверши на выбранном Mac. После этого аккаунт будет доступен с телефона.</p>':''}<p class="muted">Повторный вход в одну подписку использует те же лимиты. Подключение отдельного аккаунта требует его собственной подписки.</p>`,true);
  $('#dialog').dataset.subscriptionDevice=device;$('#dialog').dataset.subscriptionProvider=p;
  const form=$('#subscription-add');if(form)form.onsubmit=async event=>{
   event.preventDefault();const button=form.querySelector('button');button.disabled=true;$('#subscription-error').textContent='';
   try{const result=await api('/provider-accounts','POST',{deviceId:device,provider:p,name:new FormData(form).get('name')});if(state?.me.id!==owner)return;chosen.accounts=result.accounts;render(result.accounts);if(!isPhoneClient)await loginSubscription(device,p,result.record.id);else toast('Аккаунт добавлен. Заверши вход на '+chosen.name);}
   catch(error){if(form.isConnected){$('#subscription-error').textContent=error.message;button.disabled=false;}else toast(error.message,'error');}
  };
 };
 render(chosen.accounts||[]);if(chosen.accountsVersion!==1)return;
 try{const result=await api('/provider-accounts?device='+encodeURIComponent(device));if(state?.me.id!==owner)return;chosen.accounts=result.accounts;chosen.accountsError=result.accountsError||null;if($('#dialog').open&&$('#dialog').dataset.subscriptionDevice===device&&$('#dialog').dataset.subscriptionProvider===p&&$('#subscription-add')&&!$('#subscription-name')?.value)render(result.accounts);}
 catch(error){if($('#subscription-error'))$('#subscription-error').textContent=error.message;else toast(error.message,'error');}
};
window.chooseSubscription=async(device,p,id)=>{
 const previous=selectedAccountId(device,p),oldProvider=provider,oldDevice=deviceId,targetChat=chat?.id;
 try{if(targetChat)await switchChatRoute(targetChat,{provider:p,deviceId:device,accountId:id});
  voiceConversation.cancel();dictation.cancel();rememberAccount(id,device,p);provider=p;deviceId=device;roomLocalStorage.setItem('teamProvider',p);roomLocalStorage.setItem('roomDevice',device);$('#provider-picker').value=p;usageCreditsConsent=false;closeDialog();renderDevicesPicker();void loadCatalog();toast(chat?.run?'Текущий ответ завершится на прежнем аккаунте. Следующий запрос: '+subscriptionName():'Выбран '+subscriptionName());
 }catch(error){rememberAccount(previous,device,p);provider=oldProvider;deviceId=oldDevice;toast(error.message,'error');}
};
window.loginSubscription=async(device,p,id)=>{
 if(isPhoneClient)return toast('Заверши вход на выбранном Mac.');
 dialog('Вход в '+providerName(p),`<p>${esc(subscriptionName(device,p,id))} · ${esc(state.devices.find(d=>d.id===device)?.name||'Mac')}</p><p>Заверши официальный вход в браузере на выбранном компьютере. Проверь, что выбран нужный аккаунт подписки.</p><div id="subscription-login-links"></div><pre id="login-output" class="subscription-login-output" role="status">Открываю вход…\n</pre><p id="subscription-login-error" class="auth-error" role="alert"></p><button onclick="showProviderAccounts(${jsArg(p)})">Вернуться к аккаунтам</button>`,true);
 delete $('#dialog').dataset.subscriptionDevice;delete $('#dialog').dataset.subscriptionProvider;$('#dialog').dataset.loginDevice=device;$('#dialog').dataset.loginProvider=p;$('#dialog').dataset.loginAccount=id;
 try{await api('/login-provider','POST',{deviceId:device,provider:p,accountId:id});}
 catch(error){const el=$('#subscription-login-error');if(el)el.textContent=error.message;else toast(error.message,'error');}
};
function receiveAccountLogin(msg){
 const dialog=$('#dialog');if(!dialog?.open||dialog.dataset.loginDevice!==msg.deviceId||dialog.dataset.loginProvider!==msg.provider||dialog.dataset.loginAccount!==(msg.accountId||''))return;
 const output=$('#login-output');if(output){output.textContent=(output.textContent+(msg.type==='login-complete'?(msg.code===0?'\nВход завершён. Вернись к аккаунтам и выбери его.': '\n'+(msg.error||'Вход не завершён. Повтори попытку.')):msg.text||'')).slice(-16000);}
 const links=$('#subscription-login-links');if(!links||msg.type!=='login-log')return;
 for(const raw of (msg.text||'').match(/https:\/\/[^\s<>"\u001b]+/g)||[]){try{const url=new URL(raw);if(!['claude.ai','auth.openai.com','chatgpt.com'].includes(url.hostname)||url.username||url.password)continue;if([...links.querySelectorAll('a')].some(a=>a.href===url.href))continue;const link=document.createElement('a');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.className='primary-button';link.textContent='Открыть официальный вход';links.append(link);}catch{}}
}
function modelKey(){return 'roomModel_'+deviceId+'_'+provider+(selectedAccountId()?'_'+selectedAccountId():'')}function effortKey(){return 'roomEffort_'+deviceId+'_'+provider+'_'+selectedModel+(selectedAccountId()?'_'+selectedAccountId():'')}
function modelFitsProvider(value,p){
 const model=String(value||'').toLowerCase();
 if(/^(?:claude(?:-|$)|opus(?:\[|$)|sonnet(?:\[|$)|haiku(?:\[|$)|fable(?:\[|$))/.test(model))return p==='claude';
 if(/^(?:gpt-|codex(?:-|$)|o\d(?:-|$))/.test(model))return p==='codex';
 return true;
}
function renderMobileModelButton(){
 const button=$('#mobile-model-picker');if(!button)return;
 const data=catalogData[subscriptionKey()],model=data?.models?.find(m=>m.model===selectedModel);
 const name=model?modelLabel(model):selectedModel||'Выбрать модель';
 const online=state?.devices.some(d=>d.id===deviceId&&d.online),working=chat?.run?.provider===provider&&chat?.run?.deviceId===deviceId&&!runFilePhase(chat.run)&&chat.run.phase!=='starting';
 const status=!networkReady||!online?'error':working?'running':data?.connected?'ready':catalogBusy||data?.refreshPending&&data.connected!==false?'':'error';
 button.innerHTML=`<span class="status-dot ${status}" aria-hidden="true"></span><span class="mobile-model-copy"><small class="mobile-model-provider">${providerName(provider)}${effort?' · '+esc(effortNames[effort]||effort):''}</small><strong class="mobile-model-name">${esc(name)}${isPhoneWebClient&&effort?` <span class="mobile-model-power-inline">${esc(effortNames[effort]||effort)}</span>`:''}</strong></span><span class="mobile-model-caret" aria-hidden="true">⌄</span>`;
 button.title=providerName(provider)+' · '+name;button.setAttribute('aria-label',button.title+'. Выбрать провайдера и модель');
}
function mobileModelContent(p,data){
 const models=data?.models||[],current=p===provider,model=current?models.find(m=>m.model===selectedModel):null;
 const levels=model?.efforts||[];
 return `<div class="mobile-model-tabs" aria-label="Провайдер">${['claude','codex'].map(x=>`<button aria-pressed="${x===p}" onclick="showMobileModels(${jsArg(x)})">${providerName(x)}</button>`).join('')}</div>${data?.refreshPending&&models.length?'<p class="muted">Показан сохранённый список. Обновление моделей задержалось.</p>':''}<button class="subscription-sheet-button" onclick="showProviderAccounts(${jsArg(p)})"><span>Аккаунт</span><strong>${esc(subscriptionName(deviceId,p))} ⌄</strong></button><div class="mobile-model-list">${models.map(m=>`<button class="model-choice" aria-pressed="${current&&selectedModel===m.model}" onclick="chooseMobileModel(${jsArg(p)},${jsArg(m.model)})"><span>${esc(modelLabel(m,p))}</span><span aria-hidden="true">${current&&selectedModel===m.model?'✓':''}</span></button>`).join('')||`<p class="muted">${esc(data?.detail||'Загружаю доступные модели…')}</p>`}</div>${current&&levels.length?`<div class="mobile-model-power"><label for="mobile-effort-choice">Мощность</label><select id="mobile-effort-choice" aria-label="Мощность выбранной модели" onchange="selectEffort(this.value)"><option value="" ${!effort?'selected':''}>Авто</option>${levels.map(x=>`<option value="${esc(x)}" ${x===effort?'selected':''}>${esc(effortNames[x]||x)}</option>`).join('')}</select></div>`:''}<div class="mobile-model-footer">${current?'<button onclick="showExecutionMode()">Режим: '+(chosenExecutionMode()==='plan'?'План':'Работа')+'</button>':''}<button onclick="chooseMobileModel(${jsArg(p)},'custom')">Свой ID модели</button>${current?'<button onclick="showPermissions()">Разрешения</button><button onclick="showProviderInfo()">Лимиты подписки</button>':''}</div>`;
}
window.showMobileModels=async(p=provider)=>{
 const selectedDevice=deviceId,key=subscriptionKey(selectedDevice,p);dialog('Модель',mobileModelContent(p,catalogData[key]),true);
 const token=crypto.randomUUID(),el=$('#dialog');el.dataset.mobileModels=token;
 if(catalogData[key]?.models?.length)return;
 const account=state?.me.id;
 try{const result=await api('/catalog?provider='+p+'&device='+encodeURIComponent(selectedDevice)+'&account='+encodeURIComponent(selectedAccountId(selectedDevice,p)),'GET',undefined,{timeoutMs:12000});if(state?.me.id!==account)return;const data=mergeCatalogResult(result,catalogData[key]);catalogData[key]=data;
  if(el.open&&el.dataset.mobileModels===token&&deviceId===selectedDevice){dialog('Модель',mobileModelContent(p,data),true);$('#dialog').dataset.mobileModels=token;}
 }catch(error){if(state?.me.id!==account)return;if(error.status===401){clearAuthView();renderAuth();return;}const data=catalogFailure(selectedDevice,p,error);catalogData[key]=data;if(el.open&&el.dataset.mobileModels===token&&deviceId===selectedDevice)dialog('Модель',mobileModelContent(p,data),true);}
};
window.chooseMobileModel=(p,value)=>{
 closeDialog();if(value!=='custom')roomLocalStorage.setItem('roomModel_'+deviceId+'_'+p+(selectedAccountId(deviceId,p)?'_'+selectedAccountId(deviceId,p):''),value);
 if(p!==provider)void window.selectProvider(p);
 if(value==='custom'){window.selectModel(value);return;}
 if(![...$('#model-picker').options].some(x=>x.value===value))$('#model-picker').add(new Option(value,value));
 $('#model-picker').value=value;window.selectModel(value);renderStatus();
};
function modelLabel(x,p=provider){let name=x.name||x.model;if(p==='claude'){const version=x.description?.match(/(Opus|Sonnet|Haiku|Fable)\s+\d+(?:\.\d+)?/i)?.[0];if(version)name=version;if(x.model==='default')name+=' · по умолчанию';if(x.model.includes('[1m]'))name+=' · 1M'}return name}
function freshDeviceAuth(device,p){const value=state?.devices.find(d=>d.id===device),age=Date.now()-value?.statusCheckedAt,auth=selectedAccountId(device,p)?value?.accounts?.find(a=>a.id===selectedAccountId(device,p))?.status:value?.status?.[p];return value?.online&&Number.isFinite(value.statusCheckedAt)&&age>=-5000&&age<120000&&typeof auth?.connected==='boolean'?auth:null;}
function compatibleUiCatalog(previous,next){
 if(!previous||!next)return false;const before=previous.accountKey||null,after=next.accountKey||null;
 if(before||after)return Boolean(before&&after&&before===after);
 // Only the server can confirm continuity when a provider hides its account identity.
 return next.cached===true;
}
function mergeCatalogResult(result,previous){const reuse=result.cached!==false&&compatibleUiCatalog(previous,result),merged=result.refreshPending&&!result.models?.length&&previous?.models?.length&&reuse?{...previous,...result,models:previous.models,cached:true}:result;return {...merged,lastReadAt:Date.now()};}
function catalogFailure(device,p,error){
 const previous=catalogData[subscriptionKey(device,p)],auth=freshDeviceAuth(device,p),reuse=auth?.connected===true&&compatibleUiCatalog(previous,auth),models=reuse?previous.models||[]:[];
 return {...(reuse?previous:{}),...auth,models,connected:auth?.connected,refreshPending:true,cached:Boolean(models.length),lastReadAt:Date.now(),catalogError:error.message,detail:auth?.connected?'Подключение подтверждено. Обновление моделей задержалось. '+(models.length?'Показан сохранённый список.':'Повтори проверку через несколько секунд.'):auth?.connected===false?auth.detail||'Нужен вход по подписке':'Проверка подключения задержалась. Повтори проверку через несколько секунд.'};
}
function renderCatalogChoices(data,{pending=false}={}){
 const models=data?.models||[];selectedModel=roomLocalStorage.getItem(modelKey())||'';
 if(!modelFitsProvider(selectedModel,provider)){selectedModel='';roomLocalStorage.removeItem(modelKey());}
 if(provider==='claude'&&['opus','opus[1m]','sonnet','fable'].includes(selectedModel)){const family=selectedModel.split('[')[0];selectedModel=models.find(m=>m.model.startsWith('claude-'+family+'-'))?.model||selectedModel;}
 const unknown=selectedModel&&!models.some(m=>m.model===selectedModel),preserve=unknown&&(pending||data?.refreshPending);
 if(!preserve&&!models.some(m=>m.model===selectedModel))selectedModel=models.find(m=>m.isDefault)?.model||models[0]?.model||'';
 const picker=$('#model-picker');picker.innerHTML=models.map(m=>`<option value="${esc(m.model)}" title="${esc(m.description||m.model)}">${esc(modelLabel(m))}</option>`).join('')+(preserve?`<option value="${esc(selectedModel)}">${esc(selectedModel)}</option>`:'')+(models.length||preserve?'<option value="custom">Свой ID модели…</option>':`<option value="">${pending?'Загружаю модели…':'Модель после входа'}</option>`);picker.value=selectedModel;picker.disabled=pending&&!models.length&&!preserve;loadEfforts();
}
async function loadCatalog(force=false){
 if(!state?.devices.some(device=>device.id===deviceId)){requestGeneration++;catalogBusy=false;selectedModel='';renderCatalogChoices({models:[]});renderStatus();return;}
 const gen=++requestGeneration,account=state?.me.id,device=deviceId,p=provider,key=subscriptionKey(device,p);catalogBusy=true;
 renderCatalogChoices(catalogData[key],{pending:true});renderStatus();
 try{
  const result=await api(`/catalog?provider=${p}&device=${encodeURIComponent(device)}&account=${encodeURIComponent(selectedAccountId(device,p))}${force?'&refresh=1':''}`,'GET',undefined,{timeoutMs:12000});
  if(state?.me.id!==account||gen!==requestGeneration)return;catalogData[key]=mergeCatalogResult(result,catalogData[key]);renderCatalogChoices(catalogData[key]);
 }catch(error){
  if(state?.me.id!==account||gen!==requestGeneration)return;
  if(error.status===401){clearAuthView();renderAuth();return;}catalogData[key]=catalogFailure(device,p,error);renderCatalogChoices(catalogData[key]);
 }finally{if(state?.me.id===account&&gen===requestGeneration){catalogBusy=false;renderStatus();}}
}
function loadEfforts(){const data=catalogData[subscriptionKey()];const model=data?.models?.find(m=>m.model===selectedModel);const levels=model?.efforts||[];effort=roomLocalStorage.getItem(effortKey())||model?.defaultEffort||'';if(!levels.includes(effort))effort='';$('#effort-picker').innerHTML='<option value="">'+(compactScreen.matches?'Авто':'По умолчанию')+'</option>'+levels.map(level=>`<option value="${esc(level)}">${esc(compactScreen.matches?({xhigh:'XHigh',minimal:'Min',none:'Off'}[level]||effortNames[level]||level):(effortNames[level]||level))}</option>`).join('');$('#effort-picker').value=effort;$('#effort-picker').disabled=!levels.length;renderMobileModelButton()}
window.selectProvider=async value=>{usageCreditsConsent=false;provider=value;roomLocalStorage.setItem('teamProvider',value);$('#provider-picker').value=provider;void loadCatalog();renderStatus();if(chat&&networkReady)try{const r=await switchChatRoute(chat.id,{provider,deviceId,accountId:selectedAccountId()});toast(r.queued?'Контекст сохранён. Переключение применится после текущего ответа.':'Контекст сохранён для '+providerName(provider));}catch(e){toast(e.message,'error')}};
window.selectModel=value=>{usageCreditsConsent=false;if(value==='custom'){dialog('Модель по ID','<p>Введи точное имя модели. Доступность проверяется провайдером при запросе.</p><form id="custom-model"><div class="form-row"><input name="model" required placeholder="Например: claude-sonnet-5-5" maxlength="100"></div><button class="primary-button">Выбрать</button></form>');$('#custom-model').onsubmit=e=>{e.preventDefault();selectedModel=new FormData(e.target).get('model');$('#model-picker').add(new Option(selectedModel,selectedModel));$('#model-picker').value=selectedModel;roomLocalStorage.setItem(modelKey(),selectedModel);loadEfforts();closeDialog()};return}selectedModel=value;roomLocalStorage.setItem(modelKey(),value);loadEfforts()};
window.selectEffort=value=>{effort=value;roomLocalStorage.setItem(effortKey(),value);for(const selector of ['#effort-picker','#mobile-effort-choice']){const picker=$(selector);if(picker)picker.value=value;}renderMobileModelButton();};
window.selectDevice=async value=>{voiceConversation.cancel();
 const chosen=state.devices.find(d=>d.id===value);if(!chosen)return;if(isPhoneClient&&!chosen.online)return toast('Этот компьютер отключён. Выбери компьютер в сети.');
 const previous=deviceId,targetChat=chat?.id,account=state.me.id;newChatDeviceExplicit=!targetChat;
 usageCreditsConsent=false;deviceId=value;roomLocalStorage.setItem('roomDevice',value);renderDevicesPicker();void loadCatalog();
 if(targetChat){
  if(!networkReady){deviceId=previous;renderDevicesPicker();void loadCatalog();return toast('Нет связи с пространством. Компьютер сессии не изменён.');}
  try{const result=await switchChatRoute(targetChat,{provider,deviceId:value,accountId:selectedAccountId(value,provider)});if(state?.me.id!==account||chat?.id!==targetChat||deviceId!==value)return;if(isPhoneClient||compactScreen.matches)toast(result.queued?'Текущий ответ завершится на прежнем компьютере. Следующий запрос: '+chosen.name:'Продолжаешь на '+chosen.name+' с общей историей и файлами');}
  catch(e){if(state?.me.id===account&&chat?.id===targetChat&&deviceId===value){deviceId=previous;roomLocalStorage.setItem('roomDevice',previous);renderDevicesPicker();void loadCatalog();}toast(e.message,'error');}
 }
};
window.useExecutionDevice=value=>{closeDialog();void selectDevice(value)};
function liveLimit(w){return !w.resetsAt||w.resetsAt*1000>Date.now()}
function limitSummary(data){const limits=data?.limits;const r=limits?.rateLimits||limits?.rate_limits;const windows=[r?.primary,r?.secondary].filter(x=>x&&x.usedPercent!=null&&liveLimit(x));if(windows.length)return windows.map(x=>`${Math.max(0,100-x.usedPercent).toFixed(0)}% ${x.windowDurationMins>=10080?'за неделю':x.windowDurationMins>=1440?'за день':'в окне'}`).join(' · ');const unified=Object.entries(limits?.unifiedWindows||{}).filter(([_,w])=>Number.isFinite(w.utilization)&&liveLimit(w));if(unified.length)return unified.map(([k,w])=>`${Math.max(0,100-w.utilization*100).toFixed(0)}% ${k==='seven_day'?'за неделю':k==='five_hour'?'за 5 ч':k}`).join(' · ');if(Number.isFinite(limits?.utilization)&&liveLimit(limits))return `${Math.max(0,100-limits.utilization*100).toFixed(0)}% осталось`;if(limits?.status&&liveLimit(limits))return limits.status==='allowed'?'Лимит доступен':limits.status;return ''}
function renderStatus(){acknowledgeVisibleCompletion();renderUsageTrigger();splitWorkspace?.update();renderAgents();renderAccountPicker();renderPhoneContext();renderMobileModelButton();renderRunActivity();renderExecutionRoute();const el=$('#provider-status');if(!el)return;const d=catalogData[subscriptionKey()];const online=state.devices.find(d=>d.id===deviceId)?.online;const running=chat?.run;let label,cls='';if(!networkReady){label='Нет связи с пространством';cls='error'}else if(running){const activity=runActivity();label=activity.title;cls=activity.mode==='offline'?'error':activity.mode==='waiting'?'waiting':activity.mode==='working'?'running':'preparing'}else if(!online){label=deviceId?'Компьютер отключён':window.teamRoomNativeMac&&window.teamRoomLocalDeviceReady===false?'Определяю этот Mac…':'Выбери компьютер';cls='error'}else if(d?.connected){label=providerName(provider)+' подключён'+(selectedAccountId()?' · '+subscriptionName():'');cls='ready';const limits=limitSummary(d);if(limits)label+=' · '+limits;if(catalogBusy||d.refreshPending)label+=' · '+(d.cached?'модели сохранены':'проверяю модели')}else if(catalogBusy){label='Проверяю '+providerName(provider)+'…'}else if(d?.refreshPending&&d.connected!==false){label=d.detail||'Проверка подключения задержалась'}else{label=d?.detail||'Нужен вход по подписке';cls='error'}el.innerHTML=`<span class="status-dot ${cls}"></span><span>${esc(label)}</span>`;el.title=label;const count=chat?.messages.length||0;$('#context-note').textContent=count?`${count} сообщений · ${chat?.memory?.status==='ready'?'автопамять обновлена':chat?.memory?.status==='updating'?'обновляю автопамять':'история сохранена'}${chat?.context?.mode==='continuation'?' · родная сессия':chat?.context?.mode==='handoff'||chat?.context?.mode==='bootstrap'?' · передан недостающий контекст':''}${chat?.context?.inlineTruncated?' · полный архив сохранён':''}`:'История и файлы общие для Claude и Codex';}
window.showProviderDetails=()=>{const d=catalogData[subscriptionKey()];const model=d?.models?.find(m=>m.model===selectedModel);const r=d?.limits?.rateLimits;const unified=d?.limits?.unifiedWindows;dialog(providerName(provider)+' · подписка',`<p>${esc(d?.detail||'Проверяю подключение…')}</p><p>Компьютер: <strong>${esc(state.devices.find(d=>d.id===deviceId)?.name||deviceId)}</strong></p><p>Аккаунт: <strong>${esc(subscriptionName())}</strong> <button onclick="showProviderAccounts()">Сменить</button></p><p>Модель: <strong>${esc(model?modelLabel(model):selectedModel||'По умолчанию')}</strong><br>ID: ${esc(selectedModel)}<br>Мощность: ${esc(effortNames[effort]||'По умолчанию')}</p>${unified&&Object.values(unified).some(liveLimit)?Object.entries(unified).filter(([_,w])=>Number.isFinite(w.utilization)&&liveLimit(w)).map(([key,w])=>`<div class="limit-line"><span>${key==='seven_day'?'Недельное окно':key==='five_hour'?'Окно 5 ч':esc(key)}</span><span>Осталось ${Math.max(0,100-w.utilization*100).toFixed(0)}%</span></div><p>Обновится: ${new Date(w.resetsAt*1000).toLocaleString()}</p>`).join(''):r&&[r.primary,r.secondary].some(w=>w&&liveLimit(w))?['primary','secondary'].map(key=>r[key]&&liveLimit(r[key])?`<div class="limit-line"><span>${r[key].windowDurationMins>=10080?'Недельное окно':'Окно '+Math.round(r[key].windowDurationMins/60)+' ч'}</span><span>Осталось ${Math.max(0,100-r[key].usedPercent).toFixed(0)}%</span></div><div class="limit-track"><span style="width:${Math.max(0,100-r[key].usedPercent)}%"></span></div><p>Обновится: ${new Date(r[key].resetsAt*1000).toLocaleString()}</p>`:'').join(''):`<p>${provider==='claude'?'Claude передаёт остатки во время запросов. До первого полученного события точные проценты здесь недоступны.':'Провайдер пока не передал данные об остатке лимита.'}</p>`}${d?.limitsUpdatedAt?`<p class="muted">Последние данные: ${new Date(d.limitsUpdatedAt).toLocaleString()}. Claude обновляет их во время своих запросов.</p>`:''}<p><label><input type="checkbox" ${state.settings?.autoSwitch?'checked':''} onchange="setAutomation('autoSwitch',this.checked)"> Автоматически продолжать другим провайдером или аккаунтом после исчерпания лимита</label></p><p class="muted">При остатке недельного лимита 10% и меньше появится предупреждение. Провайдер и модель сохраняются. Автоматический переход выполняется только после фактического исчерпания лимита, если включён этот режим. Fable автоматически не выбирается.</p><div class="modal-buttons"><button onclick="refreshProvider()">Обновить</button>${d?.connected===false&&!isPhoneClient?'<button class="primary-button" onclick="loginProvider()">Войти по подписке</button>':''}${d?.connected===false&&isPhoneClient?'<p class="muted">Войди в подписку на выбранном Mac. На телефоне используется уже подключённый аккаунт этого компьютера.</p>':''}</div>`)};
window.showProviderInfo=()=>toggleUsagePopover();
window.refreshProvider=()=>{closeDialog();void loadCatalog(true)};
window.loginProvider=async(p=provider,d=deviceId)=>loginSubscription(d,p,selectedAccountId(d,p));
window.pickFiles=()=>{if(!compactScreen.matches)return $('#file-picker').click();dialog('Добавить в чат',`<div class="mobile-add-actions"><button onclick="chooseChatFiles()">${isPhoneWebClient?phoneIcon('file'):''}Фото, видео или файл</button><button onclick="showSkills()">${isPhoneWebClient?phoneIcon('skill'):''}Выбрать скилл</button><button onclick="showMemory()">${isPhoneWebClient?phoneIcon('memory'):''}Память проекта</button></div>`,true)};window.chooseChatFiles=()=>{closeDialog();$('#file-picker').click()};window.pickFolder=()=>{if(isPhoneClient)return toast('Папку проекта добавляй на Mac. Здесь можно прикрепить фото, видео и отдельные файлы.');$('#folder-picker').click()};
async function uploadRequest(url,method,body,timeout=120000){
 const response=await fetch(url,{method,headers:body instanceof Blob?{'content-type':'application/octet-stream'}:{'content-type':'application/json'},body:body instanceof Blob?body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
 const result=await response.json();if(!response.ok){const error=new Error(result.error||'Не удалось загрузить файл.');error.status=response.status;throw error;}return result;
}
async function uploadFiles(list,folder){
 if(chat?.run)return toast('Дождись завершения ответа перед добавлением файлов.');
 const targetProject=projectId,account=state.me.id,generation=chatOpenGeneration;let uploaded=0,skipped=0;
 for(const file of list){
  if(!state||state.me.id!==account)break;
  const raw=folder?file.webkitRelativePath.split('/').slice(1).join('/'):file.name;
  if(raw.split('/').some(p=>['node_modules','.git','.env','.claude','.codex','.aws','.ssh','.next','.DS_Store','__pycache__','.venv'].includes(p)||/^\.env\./.test(p))){skipped++;continue;}
  if(file.size>5*1024*1024*1024){toast(`${file.name}: максимальный размер — 5 ГБ.`);continue;}
  const key='teamUpload:'+JSON.stringify([account,targetProject,raw,file.size,file.lastModified]);let saved;
  try{saved=JSON.parse(roomLocalStorage.getItem(key));if(!saved||Date.now()-saved.at>86400000)saved=null;}catch{}
  const target=saved?.path||(folder?raw:'attachments/'+crypto.randomUUID()+'_'+file.name.replace(/[\\/]/g,'_'));
  const uploadId=saved?.id||crypto.randomUUID(),base=`/api/projects/${targetProject}/uploads`,url=base+'/'+uploadId;
  const item={name:file.name,path:target,mimeType:file.type||'application/octet-stream',uploading:true,progress:0};
  if(!folder&&projectId===targetProject&&generation===chatOpenGeneration)attachments.push(item);renderAttachments();
  try{
   roomLocalStorage.setItem(key,JSON.stringify({id:uploadId,path:target,at:Date.now()}));
   let status=await uploadRequest(base,'POST',{id:uploadId,path:target,size:file.size});let offset=status.offset;
   while(offset<file.size&&!status.completed){
    if(!state||state.me.id!==account)throw new Error('Вход изменился. Повтори загрузку после входа.');
    const end=Math.min(offset+4*1024*1024,file.size);let delivered=false;
    for(let retry=0;retry<4&&!delivered;retry++){
     try{status=await uploadRequest(url+'?offset='+offset,'PATCH',file.slice(offset,end));if(!Number.isSafeInteger(status.offset)||status.offset<end||status.offset>file.size)throw new Error('Сервер не подтвердил часть файла.');offset=status.offset;delivered=true;}
     catch(error){if(error.status&&error.status!==409&&error.status<500||retry===3)throw error;await new Promise(resolve=>setTimeout(resolve,1000*(retry+1)));status=await uploadRequest(url,'GET');if(!Number.isSafeInteger(status.offset)||status.offset<0||status.offset>file.size)throw new Error('Некорректное состояние загрузки.');if(status.offset>=end){offset=status.offset;delivered=true;}}
    }
    item.progress=Math.floor(offset/file.size*100);renderAttachments();
   }
   await uploadRequest(url+'/commit','POST',{});item.uploading=false;delete item.progress;roomLocalStorage.removeItem(key);uploaded++;
  }catch(error){attachments=attachments.filter(a=>a!==item);toast(error.message+' Повторно выбери этот файл, чтобы продолжить загрузку.','error');}
  renderAttachments();
 }
 if(projectId===targetProject&&state?.me.id===account)await refreshFiles();
 if(folder)toast(`Добавлено ${uploaded} файлов.${skipped?' Служебные папки и файлы секретов пропущены.':''}`);
}
function renderAttachments(){if(!$('#draft-files'))return;$('#draft-files').innerHTML=attachments.map((a,i)=>`<span class="attachment">${esc(a.name)}${a.uploading?' · '+(a.progress||0)+'%':''}<button onclick="removeAttachment(${i})" aria-label="Убрать файл">×</button></span>`).join('');renderComposer()}
window.removeAttachment=i=>{attachments.splice(i,1);renderAttachments()};
window.renderActionDetails=async el=>{
 const target=el.querySelector('.action-details');if(!target)return;
 if(!el.open){target.innerHTML='';delete target.dataset.detailsKey;return;}
 const message=replyMessages(chat).find(m=>m.id===el.dataset.actions);if(!message)return;
 const keyFor=current=>current?chat.id+':'+current.id+':'+current.actions?.length+':'+current.status+':'+Boolean(current.actionsDeferred):'';
 const detailsKey=keyFor(message),chatIdAtStart=chat.id,generation=chatOpenGeneration,account=state?.me.id;
 const isCurrent=()=>state?.me.id===account&&selectedId===chatIdAtStart&&chat?.id===chatIdAtStart&&chatOpenGeneration===generation&&el.isConnected&&el.open&&keyFor(replyMessages(chat).find(value=>value.id===message.id))===detailsKey;
 if(target.dataset.detailsKey===detailsKey)return;
 let actions=message.actions||[];
 if(message.actionsDeferred){
  const chatId=chat.id,key=detailsKey;
  try{
   let details=actionCache.get(key);
   if(!details){if(!target.childNodes.length&&!readerBusy())target.innerHTML='<p class="muted">Загружаю подробности действий…</p>';let request=actionLoads.get(key);if(!request){request=api('/chats/'+chatId+'?view=actions&message='+encodeURIComponent(message.id)).finally(()=>actionLoads.delete(key));actionLoads.set(key,request);}details=await request;if(!isCurrent())return;
    actionCache.set(key,details);if(actionCache.size>20)actionCache.delete(actionCache.keys().next().value);
   }
   if(!isCurrent())return;
   actions=details.actions||details.messages?.find(m=>m.id===message.id)?.actions||[];
  }catch(error){if(isCurrent()){const pane=$('#messages');if(readerBusy(pane)){queueReadingPaint(pane);return;}const position=!paintingMessages&&pane?captureReadingPosition(pane):null;target.innerHTML='<p class="muted">'+esc(error.message)+'</p><button onclick="renderActionDetails(this.closest(\'details\'))">Попробовать снова</button>';if(pane)restoreReadingPosition(pane,position);}return;}
 }
 if(!isCurrent())return;
 const pane=$('#messages');if(readerBusy(pane)){queueReadingPaint(pane);return;}const position=!paintingMessages&&pane?captureReadingPosition(pane):null;
 target.innerHTML=actions.map(a=>`<div>${esc(a.tool)}</div><pre>${esc(typeof a.details==='string'?a.details:JSON.stringify(a.details,null,2))}</pre>`).join('');
 target.dataset.detailsKey=detailsKey;if(pane)restoreReadingPosition(pane,position);
};
function sendFailureText(error){return !error.status&&(error.name==='TimeoutError'||error.name==='AbortError'||error.name==='TypeError')?'Ответ о доставке задержался. Сообщение сохранено на экране; проверяю, получил ли его сервер.':error.message;}
function sendStateHtml(m){return `<div class="followup-meta" role="status">${m.clientSending==='sending'?'Отправляю…':m.clientSending==='accepted'?'Сообщение сохранено':'Отправка не подтверждена'}${m.clientSending==='failed'?` <button data-retry-send="${esc(m.id)}" onclick="retrySend(this.dataset.retrySend)">Повторить</button>`:''}</div>`;}
window.retrySend=async messageId=>{
 const pending=pendingSends.get(messageId),account=state?.me.id;if(!pending||sendingMessage)return;
 sendingMessage=true;pending.message.clientSending='sending';renderMessages();renderComposer();
 try{await api('/chats/'+pending.chatId+'/send','POST',pending.payload,{timeoutMs:20000});if(state?.me.id!==account)return;pending.message.clientSending='accepted';if(pending.voiceGeneration===voiceConversation.generation&&selectedId===pending.chatId){voiceConversation.boundContext=voiceConversation.context();voiceConversation.textValue='';voiceConversation.wait(pending.chatId,messageId);}void refreshState();}
 catch(error){if(state?.me.id!==account)return;pending.message.clientSending='failed';dirtyChats.add(pending.chatId);scheduleStateRefresh();toast(sendFailureText(error),'error');}
 finally{if(state?.me.id===account){sendingMessage=false;renderMessages();renderComposer();}}
};
function renderArchiveNotice(){
 const zone=$('.composer-zone');if(!zone)return;let el=$('#archive-notice');
 if(!chat?.archivedAt){el?.remove();return;}
 if(!el){el=document.createElement('div');el.id='archive-notice';el.className='archive-notice';zone.prepend(el);}
 const owned=state.me.owner||state.me.name===chat.owner;
 const html=`<span>Сессия в архиве. История и файлы сохранены.</span>${owned?`<button onclick="setSessionArchived(${jsArg(chat.id)},false)" ${archivingChats.has(chat.id)?'disabled':''}>Восстановить</button>`:''}`;
 if(el.innerHTML!==html)el.innerHTML=html;
}
function renderComposer(){
 renderExecutionMode();renderAgents();
 const permissions=$('.permission-button');if(permissions)permissions.textContent=permissionNames[chosenPermission()];
 renderRecoveryButtons();resizeComposerInput();renderVoiceInput();
 const running=Boolean(chat?.run),send=$('#send-button');if(!send)return;
 $('.composer-zone').classList.toggle('has-running-response',running);send.classList.remove('stop');const icon=sendingMessage?'busy':'send';if(send.dataset.icon!==icon){send.innerHTML=sendingMessage?'<span class="send-spinner" aria-hidden="true"></span>':'<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>';send.dataset.icon=icon;}send.title=sendingMessage?'Отправляю…':running?'Отправить дополнение':'Отправить сообщение';send.setAttribute('aria-label',send.title);send.setAttribute('aria-busy',String(sendingMessage));
 send.disabled=Boolean(chat?.archivedAt)||archivingChats.has(selectedId)||movingChats.has(selectedId)||['permission','recording','transcribing'].includes(voiceConversation.mode)||resuming||chatLoading||Boolean(chatLoadError)||sendingMessage||attachments.some(a=>a.uploading)||Boolean(chat?.importSource?.active)||(!$('#message-input').value.trim()&&!attachments.length);
 $('#stop-button').hidden=chatLoading||!running;$('#mobile-stop-button').hidden=chatLoading||!running;$('#message-input').placeholder=chat?.archivedAt?'Сессия в архиве — восстанови её для продолжения':chatLoading?'Открываю разговор…':running?'Добавить сообщение…':'Напиши сообщение…';
 const queued=(chat?.messages||[]).filter(m=>m.followup&&m.delivery==='queued'),el=$('#followup-queue');
 renderArchiveNotice();el.hidden=Boolean(chat?.archivedAt)||!queued.length;
 el.innerHTML=el.hidden?'':`<span>${esc(chat.queueNotice||'Сохранённых дополнений: '+queued.length)}</span><div><button onclick="showQueueTools()">Изменить очередь</button>${!running?'<button onclick="resumeQueue()">Продолжить очередь</button>':''}</div>`;
}
function followupHtml(m){
 const labels={queued:'Дополнение сохранено · ожидает передачи',sending:'Передаю в текущую работу…',received:'Получено · ожидает ближайшего шага модели',dispatching:'Запускаю дополнение…',delivered:'Учтено в текущей работе',uncertain:'Доставка не подтверждена',cancelled:'Дополнение отменено'};
 const mine=m.owner===state.me.name;
 const currentDevice=state.devices.find(d=>d.id===chat?.run?.deviceId);if(m.delivery==='queued'&&chat?.run?.provider==='claude'&&!currentDevice?.local&&currentDevice?.liveInputVersion!==1)labels.queued='В очереди · обнови подключение для дополнений во время работы';
 return `<div class="followup-meta" role="status" title="${esc(m.deliveryDetail||'')}">${esc(labels[m.delivery]||'Дополнение сохранено')}${mine&&m.delivery==='queued'?` <button onclick="showQueueTools(${jsArg(m.id)})">Изменить</button><button onclick="cancelFollowup(${jsArg(m.id)})">Убрать из очереди</button>`:''}${mine&&m.delivery==='uncertain'?` <button onclick="retryFollowup(${jsArg(m.id)})">Повторить</button>`:''}</div>`;
}
window.stopResponse=async()=>{if(!chat?.run)return;const id=chat.id;try{await api('/chats/'+id+'/stop','POST',{},{timeoutMs:20000});await refreshState();toast('Остановка запрошена. Жду завершения процесса и сохранения файлов на компьютере.')}catch(error){dirtyChats.add(id);scheduleStateRefresh();toast(error.status?error.message:'Остановка пока не подтверждена. Проверяю состояние задачи.','error')}};
window.cancelFollowup=async messageId=>{try{await api('/chats/'+chat.id+'/cancel-followup','POST',{messageId});await refreshState()}catch(error){toast(error.message,'error')}};
window.retryFollowup=messageId=>{dialog('Повторить дополнение?','<p>При обрыве связи провайдер мог уже получить это сообщение. Повторная отправка может дублировать работу.</p><div class="modal-buttons"><button onclick="closeDialog()">Отмена</button><button class="primary-button" id="retry-followup-confirm">Повторить</button></div>');$('#retry-followup-confirm').onclick=async()=>{try{await api('/chats/'+chat.id+'/retry-followup','POST',{messageId});closeDialog();await refreshState()}catch(error){toast(error.message,'error')}}};
window.resumeQueue=async()=>{
 if(provider==='claude'&&/fable/i.test(selectedModel)&&!usageCreditsConsent){dialog('Fable · usage credits','<p>Продолжение очереди на Fable может расходовать usage credits. Разрешить?</p><div class="modal-buttons"><button onclick="closeDialog()">Отмена</button><button id="queue-fable-confirm" class="primary-button">Разрешить</button></div>');$('#queue-fable-confirm').onclick=()=>{usageCreditsConsent=true;closeDialog();void resumeQueue()};return;}
 try{const r=await api('/chats/'+chat.id+'/resume-queue','POST',{provider,deviceId,accountId:selectedAccountId(),permissionMode:chosenPermission(),executionMode:chosenExecutionMode(),model:selectedModel,effort,allowUsageCredits:usageCreditsConsent});if(r.notice)toast(r.notice);await refreshState()}catch(error){toast(error.message,'error')}
};
window.sendMessage=async inputOverride=>{
 if(chat?.archivedAt||archivingChats.has(selectedId)||movingChats.has(selectedId)||sendingMessage||chatLoading||chatLoadError||resuming&&!inputOverride||['permission','recording','transcribing'].includes(voiceConversation.mode))return;
 if(!inputOverride&&voiceConversation.mode==='review'&&voiceConversation.textValue)return sendVoiceTurn();
 if(dictation.active&&!inputOverride){const context=projectId+':'+selectedId;await dictation.finish();if(context!==projectId+':'+selectedId||sendingMessage||chatLoading)return;}
 const running=Boolean(chat?.run),input=$('#message-input'),raw=inputOverride?.text??input.value,text=raw.trim(),submittedFiles=inputOverride?[...(inputOverride.attachments||[])]:[...attachments];if(!text&&!submittedFiles.length)return;
 if(submittedFiles.some(a=>a.uploading))return toast('Дождись загрузки файлов.');
 if(running&&submittedFiles.length)return toast('Пока идёт ответ, отправляй текст и ссылки. Файлы добавь после ответа.');
 if(!networkReady)return toast('Пространство недоступно. Текст остаётся в поле ввода.');
 if(!running&&chat?.id&&routeSwitchRequests.has(chat.id)){
  const id=chat.id,generation=chatOpenGeneration;
  try{while(routeSwitchRequests.has(id)){await routeSwitchRequests.get(id);if(chat?.id!==id||chatOpenGeneration!==generation||sendingMessage)return;}}
  catch(error){return toast(error.message,'error');}
 }
 if(!running&&!state.devices.some(device=>device.id===deviceId))return toast(missingExecutionDeviceText());
 if(!running){
  if(catalogBusy&&!selectedModel)return toast('Загружаю модели для первого запроса. Текст сохраняется.');
  const d=catalogData[subscriptionKey()];if(!catalogBusy&&d?.connected===false){showProviderInfo();return}
  if(provider==='claude'&&/fable/i.test(selectedModel)&&!usageCreditsConsent){pendingCreditSend={input:inputOverride,chatId:chat?.id,projectId,provider,deviceId,model:selectedModel};dialog('Fable · usage credits','<p>На некоторых подписках Fable расходует usage credits вместо включённых лимитов. Claude Code в этом режиме может списывать их без отдельного запроса. Разрешить запрос на выбранной модели?</p><div class="modal-buttons"><button onclick="closeDialog()">Отмена</button><button class="primary-button" onclick="allowFable()">Разрешить и отправить</button></div>');return}
 }
 const target={projectId,provider,deviceId,accountId:selectedAccountId(),permissionMode:chosenPermission(),executionMode:chosenExecutionMode(),model:selectedModel,effort,consent:usageCreditsConsent,preferences:providerPreferences(),generation:chatOpenGeneration,owner:state.me.name,userId:state.me.id};let submittingChat=chat;
 sendingMessage=true;renderComposer();let submittedChatId,pending;
 try{
  if(!submittingChat){submittingChat=await api('/chats','POST',{projectId:target.projectId,provider:target.provider,deviceId:target.deviceId,accountId:target.accountId,model:target.model,effort:target.effort,permissionMode:target.permissionMode,executionMode:target.executionMode},{timeoutMs:20000});if(state?.me.id!==target.userId)return;cacheChat(submittingChat);if(target.generation===chatOpenGeneration&&projectId===target.projectId){chat=submittingChat;selectedId=chat.id;rememberView();renderChatList()}}
  submittedChatId=submittingChat.id;if(selectedId===submittedChatId)historyBefore=null;dirtyChats.add(submittedChatId);const messageId=inputOverride?.messageId||(pendingMessageId||=crypto.randomUUID());
  const payload={text,attachments:submittedFiles,provider:target.provider,deviceId:target.deviceId,accountId:target.accountId,permissionMode:target.permissionMode,executionMode:target.executionMode,model:target.model,effort:target.effort,messageId,allowUsageCredits:target.consent,preferences:target.preferences};
  pending={chatId:submittedChatId,projectId:target.projectId,payload,voiceGeneration:inputOverride?.voiceGeneration,message:{id:messageId,role:'user',text:text||'Проанализируй прикреплённые файлы.',attachments:submittedFiles,owner:target.owner,createdAt:new Date().toISOString(),status:'pending',clientSending:'sending'}};
  pendingSends.set(messageId,pending);
  if(selectedId===submittedChatId){
   if($('#message-input').value===raw){draft='';$('#message-input').value='';$('#message-input').style.height='auto'}
   attachments=attachments.filter(a=>!submittedFiles.includes(a));if(pendingMessageId===messageId)pendingMessageId=null;renderAttachments();renderMessages();$('#messages').scrollTop=$('#messages').scrollHeight;
  }
  await api('/chats/'+submittedChatId+'/send','POST',payload,{timeoutMs:20000});if(state?.me.id!==target.userId)return;
  pending.message.clientSending='accepted';if(inputOverride?.voiceGeneration!==undefined&&inputOverride.voiceGeneration===voiceConversation.generation&&selectedId===submittedChatId){voiceConversation.boundContext=voiceConversation.context();voiceConversation.textValue='';voiceConversation.wait(submittedChatId,messageId);}if(selectedId===submittedChatId)renderMessages();void refreshState();
 }catch(error){if(state?.me.id!==target.userId)return;if(pending){pending.message.clientSending='failed';dirtyChats.add(submittedChatId);scheduleStateRefresh();if(selectedId===submittedChatId)renderMessages();}toast(sendFailureText(error),'error')}finally{if(state?.me.id===target.userId){sendingMessage=false;renderComposer()}}
};
window.allowFable=()=>{const pending=pendingCreditSend;pendingCreditSend=undefined;closeDialog();if(pending&&(pending.chatId!==chat?.id||pending.projectId!==projectId||pending.provider!==provider||pending.deviceId!==deviceId||pending.model!==selectedModel))return toast('Разговор или модель изменились. Нажми продолжение ещё раз.');usageCreditsConsent=true;void sendMessage(pending?.input)};
window.continueWith=async p=>{
 if(resuming||sendingMessage||chatLoading)return;
 if(!chat)return;
 if(chat.run)return toast('Этот разговор уже выполняется.');
 if(!networkReady)return toast('Жду восстановления связи. История сохранена.');
 const targetChat=chat.id,targetDevice=deviceId,generation=chatOpenGeneration,changedProvider=p!==provider;
 resuming=true;renderComposer();
 try{
  if(changedProvider){usageCreditsConsent=false;provider=p;roomLocalStorage.setItem('teamProvider',p);$('#provider-picker').value=p;renderStatus();await switchChatRoute(targetChat,{provider:p,deviceId:targetDevice,accountId:selectedAccountId(targetDevice,p)});}
  if(changedProvider||catalogBusy||!selectedModel||!catalogData[subscriptionKey(targetDevice,p)]?.connected)await loadCatalog();
  if(chat?.id!==targetChat||deviceId!==targetDevice||provider!==p||chatOpenGeneration!==generation)return;
  if(chat.run)return toast('Этот разговор уже выполняется.');
  if(!catalogData[subscriptionKey(targetDevice,p)]?.connected){showProviderInfo();return;}
  await sendMessage({text:'Продолжи последнюю незавершённую задачу. Используй всю общую историю и файлы, проверь уже выполненные действия.',attachments:[],messageId:crypto.randomUUID()});
 }catch(error){toast(error.message,'error')}finally{resuming=false;renderComposer()}
};
function visibleReplyText(id,partId){return displayMessages().find(m=>m.id===partId&&(m._sourceMessageId||m.id)===id)?.text??replyMessages(chat).find(m=>m.id===id)?.text??'';}
window.copyMessage=async(id,partId)=>{try{await navigator.clipboard.writeText(visibleReplyText(id,partId));toast('Ответ скопирован')}catch{toast('Не удалось скопировать ответ')}};
window.rememberMessage=(id,partId)=>showMemory(visibleReplyText(id,partId));
window.renameChat=()=>{if(!chat)return;const targetChat=chat.id,generation=chatOpenGeneration;dialog('Название чата',`<form id="rename-form"><div class="form-row"><input name="title" required maxlength="100" value="${esc(chat.title)}"></div><button class="primary-button">Сохранить</button></form>`);$('#rename-form').onsubmit=async e=>{e.preventDefault();try{const renamed=await api('/chats/'+targetChat,'PATCH',Object.fromEntries(new FormData(e.target)));closeDialog();if(generation===chatOpenGeneration&&selectedId===targetChat){chat=renamed;renderMessages();}await refreshState()}catch(error){toast(error.message,'error')}}};
window.chatMenu=()=>{
 const c=chat,busy=Boolean(c?.run||movingChats.has(c?.id)||archivingChats.has(c?.id)),owned=c&&(state.me.owner||c.owner===state.me.name);
 const actions=c?`<div class="session-action-grid">
 ${sessionMenuAction('search','Найти в чате','findInChat()')}
 ${sessionMenuAction('branch','Ответвить чат','forkChat()')}
 ${sessionMenuAction('memory','Отдельный вопрос','askSideQuestion()')}
 ${sessionMenuAction('file','Изменения файлов','showFileReview()')}
 ${sessionMenuAction('rename','Переименовать','renameChat()')}
 ${sessionMenuAction('move','Перенести','showMoveChat()',{disabled:busy||!owned})}
 ${sessionMenuAction(c.archivedAt?'restore':'archive',c.archivedAt?'Восстановить':'В архив',`setSessionArchived(${jsArg(c.id)},${!c.archivedAt})`,{disabled:busy||!owned})}
 ${sessionMenuAction('download','Скачать историю','',{href:'/api/chats/'+encodeURIComponent(c.id)+'/export'})}
 </div>`:`<div class="session-action-grid session-action-grid-single">${sessionMenuAction('plus','Новый чат','closeDialog();newChat()')}</div>`;
 const tools=`<details class="session-menu-tools"><summary><span class="session-action-icon">${phoneIcon('tools')}</span><span>Инструменты и настройки</span><span class="session-tools-chevron">${phoneIcon('chevron')}</span></summary><div class="session-action-grid session-tools-grid">
 ${sessionMenuAction('file','Файлы','closeDialog();toggleFiles()')}
 ${sessionMenuAction('memory','Память','showMemory()')}
 ${sessionMenuAction('computer','Компьютер','showDevices()')}
 ${sessionMenuAction('tools','Режим работы','showExecutionMode()')}
 ${sessionMenuAction('task','Очередь дополнений','showQueueTools()')}
 ${sessionMenuAction('tools','Разрешения','showPermissions()')}
 ${sessionMenuAction('limits','Лимиты','showProviderInfo()')}
 ${sessionMenuAction('tools','Горячие клавиши','showShortcuts()')}
 </div></details>`;
 const footer=c?`<div class="session-menu-footer">${sessionMenuAction('trash','Удалить сессию','showDeleteChat()',{danger:true,disabled:busy||!owned})}</div>`:'';
 sessionMenuDialog('Управление чатом',c?.title||'',actions+tools+footer);
};
window.openPhoneFiles=()=>{closeDialog();filePanel=false;toggleFiles()};
window.toggleFiles=()=>{closeSidebar(false);filePanel=!filePanel;void renderFiles()};
const projectFileReads=new Map();
const filePanelViews=new WeakMap();
function cancelProjectFileReads(){for(const read of projectFileReads.values())read.controller.abort();projectFileReads.clear();}
function readProjectFiles(project=projectId){
 const account=state?.me.id,key=account+':'+project;
 for(const [other,read]of projectFileReads)if(other!==key){read.controller.abort();projectFileReads.delete(other);}
 if(projectFileReads.has(key))return projectFileReads.get(key).request;
 const controller=new AbortController(),read={controller};
 read.request=api('/projects/'+project+'/files','GET',undefined,{timeoutMs:12000,signal:controller.signal}).finally(()=>{if(projectFileReads.get(key)===read)projectFileReads.delete(key);});
 projectFileReads.set(key,read);return read.request;
}
async function refreshFiles(){
 const project=projectId,account=state?.me.id;
 try{const result=await readProjectFiles(project);if(project!==projectId||state?.me.id!==account)return;
  const changed=filesProjectId!==project||JSON.stringify(files)!==JSON.stringify(result.files);files=result.files;filesProjectId=project;
  if(filePanel){renderFilePanel();const feedback=$('#project-files-feedback');if(feedback){feedback.hidden=true;feedback.textContent='';}}if(changed)renderMessages();
 }catch(error){if(project!==projectId||state?.me.id!==account||error.name==='AbortError')return;const el=$('#project-files-feedback');if(el){el.hidden=false;el.textContent=error.message;}}
}
async function renderFiles(refresh=true){
 if(!filePanel){$('#file-panel-root').innerHTML='';return;}
 renderFilePanel();if(refresh)await refreshFiles();
}
function renderFilePanel(){
 const root=$('#file-panel-root');if(!filePanel||!root)return;
 const html=`<section class="workspace-panel"><div class="panel-head"><h3>Файлы проекта</h3><button onclick="toggleFiles()" title="Закрыть" aria-label="Закрыть файлы">${isPhoneWebClient?phoneIcon('close'):'×'}</button></div><p class="muted">Эти файлы доступны Claude, Codex и подключённым компьютерам.</p><div class="panel-actions">${chat?.id?'<button onclick="showFileReview()">Изменения файлов</button>':''}<button class="primary-button" onclick="pickFiles()">＋ Файлы</button>${!isPhoneClient?'<button onclick="pickFolder()">＋ Папка</button>':''}</div><p id="project-files-feedback" class="form-feedback" role="alert" hidden></p><div class="panel-files">${(filesProjectId===projectId?files:[]).map(f=>`<div class="file-row"><div><a href="${fileUrl(f.path)}" download>${esc(f.path)}</a><small>${fmtBytes(f.size)}</small></div>${previewKind(f.path)==='html'?browserFileLink(f.path,projectId):''}${previewKind(f.path)?`<button data-file="${esc(f.path)}" data-project="${esc(projectId)}" onclick="openFilePreview(this.dataset.file,this.dataset.project)">${previewKind(f.path)==='html'?'Превью':'Открыть'}</button>`:''}</div>`).join('')||`<p class="muted">${isPhoneClient?'Прикрепи фото, видео или документы.':'Прикрепи документы или добавь папку проекта.'} Результаты помощников тоже появятся здесь.</p>`}</div><p class="muted">До 5 ГБ на файл. Служебные папки, ключи и .env не переносятся.</p></section>`
 const painted=filePanelViews.get(root);if(painted?.project===projectId&&painted.html===html&&root.firstElementChild)return;
 const list=root.querySelector('.panel-files'),top=list?.scrollTop||0;root.innerHTML=html;filePanelViews.set(root,{project:projectId,html});
 const next=root.querySelector('.panel-files');if(next)next.scrollTop=top;
}
function memoryRows(){return state.memories.filter(m=>m.projectId===projectId).map(m=>`<div class="note-row"><button onclick="deleteMemory(${jsArg(m.id)})" title="Удалить">×</button><p>${esc(m.text)}</p><small>${esc(m.author)}${m.status?' · '+esc({confirmed:'подтверждено',proposed:'предложение',superseded:'устарело',blocked:'ограничение'}[m.status]||m.status):''} · ${new Date(m.updatedAt||m.createdAt).toLocaleString()}${m.sourceChatId?` · <button onclick="closeDialog();openChat(${jsArg(m.sourceChatId)})">Исходный чат</button>`:''}</small></div>`).join('')}
function memorySummary(){const c=chat?.memory;return `<p>${c?.status==='ready'?'✓ Сводка обновлена автоматически':c?.status==='updating'?'Обновляю сводку в фоне…':'Полная история и контрольные точки сохраняются; сводка ожидает обновления.'}</p>${c?.error?`<p class="muted">${esc(c.error)}</p>`:''}${c?.content?`<div class="memory-summary">${markdown(c.content.summary)}${[['done','Выполнено'],['next','Следующие шаги'],['risks','Ограничения']].map(([k,title])=>c.content[k]?.length?`<h3>${title}</h3>${c.content[k].map(r=>`<p>• ${esc(r.text)}</p>`).join('')}`:'').join('')}</div>`:''}`}
window.showMemory=(prefill='')=>{dialog('Память проекта',`<p>Claude и Codex сами сохраняют решения, причины, выполненные и следующие шаги. История и контрольные точки сохраняются независимо от готовности сводки.</p><label><input type="checkbox" ${state.settings?.autoMemory?'checked':''} onchange="setAutomation('autoMemory',this.checked)"> Автоматически обновлять память</label><p class="muted">Память сохраняется в ходе основной работы. Фоновых запросов для сводки нет. Кнопка ниже запускает отдельный запрос через подписку; это расходует лимит. История и файлы сохраняются без обращения к модели.</p><div id="auto-memory-state">${memorySummary()}</div>${chat?'<button onclick="refreshMemory()">Обновить сводку этого чата</button>':''}<h3>Общие решения и правила</h3><div id="memory-rows">${memoryRows()}</div><h3>Добавить свою запись</h3><form id="memory-form"><div class="form-row"><textarea name="text" required maxlength="10000" placeholder="Важное решение, цель или правило проекта">${esc(typeof prefill==='string'?prefill:'')}</textarea></div><button class="primary-button">Сохранить в общую память</button></form>`);$('#memory-form').onsubmit=async e=>{e.preventDefault();try{await api('/memories','POST',{projectId,...Object.fromEntries(new FormData(e.target))});await refreshState();showMemory();toast('Память обновлена у всех компьютеров')}catch(error){toast(error.message,'error')}}};
window.setAutomation=async(key,value)=>{try{await api('/settings','PATCH',{[key]:value});await refreshState();toast(value?'Автоматизация включена':'Автоматизация выключена')}catch(e){toast(e.message,'error')}};
window.refreshMemory=async()=>{if(!chat)return;try{await api('/chats/'+chat.id+'/memory','POST',{});toast('Сводка обновляется в фоне. Можно продолжать работу.')}catch(e){toast(e.message,'error')}};
function providerPreferences(){const out={};for(const p of ['claude','codex']){const model=roomLocalStorage.getItem('roomModel_'+deviceId+'_'+p);out[p]={model:model||'',effort:roomLocalStorage.getItem('roomEffort_'+deviceId+'_'+p+'_'+model)||''};}return out;}
let nativeImport,nativeSearchTimer;
function nativeImportVisible(target){return nativeImport===target&&$('#dialog')?.open&&Boolean($('#native-list'))}
function nativeQuery(){return ($('#native-search')?.value||'').trim().normalize('NFC').toLocaleLowerCase()}

window.showImport=()=>{nativeImport={provider:'claude',deviceId,accountId:selectedAccountId(deviceId,'claude'),projectId,sessionId:'',files:'referenced',preview:null,previewBusy:false,previewError:'',previewNonce:'',sessions:[],cursor:null,loading:false,error:'',seenCursors:new Set()};dialog('Перенести чат из Claude Code или Codex',`<p>Выбери сохранённую сессию на нужном компьютере. Переписка, действия и выбранные файлы будут доступны обоим провайдерам в проекте Team Room.</p><label class="native-search-label" for="native-search">Поиск сессий</label><input id="native-search" type="search" class="search native-search" placeholder="Название, папка или ID сессии…" aria-describedby="native-search-status" oninput="searchNativeSessions()"><p id="native-search-status" class="muted native-search-status" role="status" aria-live="polite"></p><div class="import-controls"><label>Источник<select id="native-provider" onchange="changeImportSource()"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><label>Компьютер<select id="native-device" onchange="changeImportSource()">${state.devices.map(d=>`<option value="${d.id}" ${d.id===deviceId?'selected':''}>${d.online?'🟢':'🔴'} ${esc(d.name)}${d.online?'':' · отключён'}</option>`).join('')}</select></label><label>Аккаунт<select id="native-account" onchange="changeImportAccount()"></select></label><label>Проект назначения<select id="native-project">${state.projects.map(p=>`<option value="${p.id}" ${p.id===projectId?'selected':''}>${esc(p.name)}</option>`).join('')}</select></label><label>Файлы<select id="native-files"><option value="referenced">Упомянутые в сессии</option><option value="all">Вся рабочая папка проекта</option><option value="none">Только переписка</option></select></label></div><div id="native-list" class="native-list">Читаю сохранённые сессии…</div><button id="native-more" onclick="loadNativeSessions(true)" hidden>Показать ещё</button><div id="native-preview" class="native-preview" role="status" aria-live="polite" hidden></div><p class="muted">Исходная сессия сохраняется. Новые ответы подтягиваются до первого запроса в Team Room. Закрытые внутренние рассуждения провайдеров не переносятся.</p><div class="modal-buttons"><button onclick="closeDialog()">Отмена</button><button id="native-import" class="primary-button" onclick="performImport()" disabled>Перенести в проект</button></div><p class="muted">Также доступны команды /teamroom в Claude Code и $teamroom в Codex после подключения интеграции.</p>`);renderImportAccounts();void loadNativeSessions();};
function renderImportAccounts(){const picker=$('#native-account');if(!picker||!nativeImport)return;const records=state.devices.find(d=>d.id===nativeImport.deviceId)?.accounts||[];picker.innerHTML='<option value="">Основной аккаунт</option>'+records.filter(a=>a.provider===nativeImport.provider).map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');picker.value=nativeImport.accountId||'';}
window.changeImportAccount=()=>window.changeImportSource($('#native-account').value);
window.changeImportSource=profile=>{clearTimeout(nativeSearchTimer);nativeImport={...nativeImport,provider:$('#native-provider').value,deviceId:$('#native-device').value,accountId:typeof profile==='string'?profile:selectedAccountId($('#native-device').value,$('#native-provider').value),sessionId:'',preview:null,previewBusy:false,previewError:'',previewNonce:'',sessions:[],cursor:null,loading:false,error:'',seenCursors:new Set()};$('#native-import').disabled=true;renderImportAccounts();renderNativePreview();void loadNativeSessions()};
window.searchNativeSessions=()=>{clearTimeout(nativeSearchTimer);const target=nativeImport;target.sessionId='';target.preview=null;target.previewBusy=false;target.previewError='';target.previewNonce='';renderNativePreview();renderNativeSessions();if(nativeQuery())nativeSearchTimer=setTimeout(()=>{if(nativeImportVisible(target)&&nativeQuery()&&target.cursor&&!target.loading)void loadNativeSessions(true)},300)};
window.loadNativeSessions=async more=>{
 const target=nativeImport;if(!nativeImportVisible(target)||target.loading)return;const p=target.provider,d=target.deviceId,cursor=more?target.cursor:null;if(more&&!cursor)return;
 target.loading=true;target.error='';if(!more)target.seenCursors.clear();renderNativeSessions();
 try{const r=await api(`/native-sessions?provider=${p}&device=${encodeURIComponent(d)}&account=${encodeURIComponent(target.accountId||'')}${cursor?'&cursor='+encodeURIComponent(cursor):''}`);if(!nativeImportVisible(target))return;
  const rows=more?[...target.sessions,...r.sessions]:r.sessions;target.sessions=[...new Map(rows.map(x=>[x.sessionId,x])).values()];if(cursor)target.seenCursors.add(cursor);target.cursor=r.nextCursor||null;if(target.cursor&&target.seenCursors.has(target.cursor)){target.cursor=null;target.error='Источник повторил страницу. Измени источник, чтобы обновить список.';}
 }catch(e){if(nativeImportVisible(target))target.error=e.message}
 finally{target.loading=false;if(nativeImportVisible(target)){renderNativeSessions();if(nativeQuery()&&target.cursor&&!target.error)nativeSearchTimer=setTimeout(()=>{if(nativeImportVisible(target)&&nativeQuery())void loadNativeSessions(true)},150)}}
};
window.renderNativeSessions=()=>{
 const target=nativeImport;if(!nativeImportVisible(target))return;const q=nativeQuery(),words=q.split(/\s+/).filter(Boolean),matches=target.sessions.filter(x=>{const text=[x.title,x.cwd,x.sessionId].filter(Boolean).join(' ').normalize('NFC').toLocaleLowerCase();return words.every(word=>text.includes(word))});
 $('#native-list').innerHTML=matches.map(x=>`<button class="native-row ${x.sessionId===target.sessionId?'selected':''}" onclick="pickNativeSession(${jsArg(x.sessionId)})"><strong>${esc(x.title)}</strong><small>${esc(x.cwd||'Без рабочей папки')}</small><small>Файл обновлён: ${new Date(x.updatedAt).toLocaleString()}${x.active?' · ещё выполняется':''}</small><small class="native-session-id">ID: ${esc(x.sessionId)}</small></button>`).join('')||`<p class="muted">${target.loading?'Читаю сохранённые сессии…':q&&target.cursor&&!target.error?'Ищу в остальных сессиях…':target.error?'Не удалось прочитать список сессий.':q?'По этому запросу сессий не найдено.':'Сохранённых сессий не найдено.'}</p>`;
 $('#native-search-status').textContent=target.error||(target.loading?(q?`Найдено: ${matches.length} · ищу дальше…`:'Читаю сохранённые сессии…'):q?`Найдено: ${matches.length}${target.cursor?' · поиск продолжается':''}`:`Загружено: ${target.sessions.length}${target.cursor?' · поиск проверит остальные страницы':''}`);
 const more=$('#native-more');more.hidden=!target.cursor&&!target.error;more.disabled=target.loading;more.textContent=target.loading?'Загружаю…':target.error?'Повторить загрузку':'Показать ещё';more.onclick=()=>loadNativeSessions(Boolean(target.cursor));
};
function renderNativePreview(){
 const target=nativeImport;if(!nativeImportVisible(target))return;const el=$('#native-preview'),button=$('#native-import');el.hidden=!target.sessionId;button.disabled=target.previewBusy||!target.preview||!target.preview.messageCount;button.textContent='Перенести в проект';if(!target.sessionId){el.textContent='';return;}
 if(target.previewBusy){el.textContent='Проверяю выбранную сессию: читаю историю на исходном компьютере…';return;}
 if(target.previewError){el.innerHTML=`<p>${esc(target.previewError)}</p><button onclick="pickNativeSession(${jsArg(target.sessionId)})">Повторить проверку</button>`;return;}
 const p=target.preview;if(!p)return;const stamp=value=>{const date=new Date(value);return value&&Number.isFinite(date.getTime())?date.toLocaleString():'Дата не указана'};
 el.innerHTML=`<strong>Выбрана: ${esc(p.title)}</strong><p>В истории ${p.messageCount} записей — сообщения и действия. Из них ${p.textMessageCount} с текстом.</p><p>Первое сообщение: ${esc(stamp(p.firstAt))}<br>Последнее сообщение: ${esc(stamp(p.lastAt))}</p><small>ID: ${esc(p.sessionId)}</small>${p.messageCount<=3?'<p class="muted">Это короткая исходная сессия. Если ожидаешь длинную переписку, выбери другой вариант с тем же названием.</p>':''}${p.active?'<p class="muted">Исходная сессия ещё работает. После переноса её новые сообщения будут подтягиваться до начала работы в Team Room.</p>':''}${p.warnings?.length?`<p class="muted">${p.warnings.map(esc).join('<br>')}</p>`:''}`;
 button.textContent=`Перенести историю · ${p.messageCount}`;
}
window.pickNativeSession=async id=>{
 const target=nativeImport;if(!nativeImportVisible(target))return;const nonce=crypto.randomUUID();Object.assign(target,{sessionId:id,preview:null,previewBusy:true,previewError:'',previewNonce:nonce});renderNativeSessions();renderNativePreview();
 try{const p=await api(`/native-session-preview?provider=${target.provider}&device=${encodeURIComponent(target.deviceId)}&session=${encodeURIComponent(id)}&account=${encodeURIComponent(target.accountId||'')}`);if(!nativeImportVisible(target)||target.previewNonce!==nonce)return;target.preview=p;}
 catch(error){if(!nativeImportVisible(target)||target.previewNonce!==nonce)return;target.previewError=error.message;}
 finally{if(nativeImportVisible(target)&&target.previewNonce===nonce){target.previewBusy=false;renderNativePreview();}}
};
window.performImport=async()=>{if(!nativeImport.preview||nativeImport.previewBusy||nativeImport.preview.sessionId!==nativeImport.sessionId)return;const b=$('#native-import');b.disabled=true;b.textContent='Переношу историю и файлы…';try{const result=await api('/import-session','POST',{provider:nativeImport.provider,deviceId:nativeImport.deviceId,accountId:nativeImport.accountId||'',sessionId:nativeImport.sessionId,projectId:$('#native-project').value,files:$('#native-files').value,watch:true});projectId=result.projectId;selectedId=result.chatId;roomLocalStorage.setItem('roomProject',projectId);roomLocalStorage.setItem('roomChat',selectedId);state=await api('/state');closeDialog();renderShell();await openChat(selectedId);await loadCatalog();toast(`Перенесено ${result.messageCount} сообщений и ${result.fileCount} файлов.${result.conflicts?.length?' Конфликтующие версии сохранены отдельно.':''}${result.warnings?.length?' '+result.warnings.join(' '):''}`);}catch(e){toast(e.message,'error');b.disabled=false;b.textContent='Перенести в проект'}};
window.deleteMemory=async id=>{try{await api('/memories/'+id,'DELETE');await refreshState();showMemory()}catch(error){toast(error.message,'error')}};
window.showTasks=()=>{dialog('Задачи проекта',`<form id="task-form"><div class="form-row"><input name="title" required placeholder="Что нужно сделать?"></div><button class="primary-button">Добавить задачу</button></form>${state.tasks.filter(t=>t.projectId===projectId).map(t=>`<div class="task-row"><span>${esc(t.title)}</span><select onchange="updateTask(${jsArg(t.id)},this.value)">${[['inbox','Запланировано'],['doing','В работе'],['review','На проверке'],['blocked','Заблокировано'],['done','Готово']].map(([id,name])=>`<option value="${id}" ${id===t.status?'selected':''}>${name}</option>`).join('')}</select></div>`).join('')}`);$('#task-form').onsubmit=async e=>{e.preventDefault();try{await api('/tasks','POST',{projectId,...Object.fromEntries(new FormData(e.target))});await refreshState();showTasks()}catch(error){toast(error.message,'error')}}};
window.updateTask=async(id,status)=>{try{await api('/tasks/'+id,'PATCH',{status});await refreshState()}catch(error){toast(error.message,'error')}};
window.showDevices=async()=>{const read=beginDialogRead(isPhoneClient||isPhoneWebClient?'Выбрать компьютер':'Компьютеры');try{const info=await api('/devices','GET',undefined,{timeoutMs:12000,signal:read.controller.signal});if(!currentDialogRead(read))return;state.devices=info.devices;renderDevicesPicker();
 if(isPhoneClient||isPhoneWebClient){
  const run=chat?.run;
  dialog('Выбрать компьютер',`<p>Телефон открывает общие чаты, память и файлы. Claude и Codex работают на выбранном компьютере через его подписки.</p>${run?'<p class="muted">Текущий ответ завершится на компьютере, где был запущен. Новый выбор применяется к следующему запросу.</p>':''}<div class="execution-devices">${state.devices.map(d=>`<button class="device-card execution-device ${d.id===deviceId?'selected':''}" ${d.online?'':'disabled'} onclick="useExecutionDevice(${jsArg(d.id)})" aria-pressed="${d.id===deviceId?'true':'false'}"><span class="status-dot ${d.online?'ready':'error'}"></span><span><strong>${esc(d.name)}</strong><small>${esc(d.owner||'')} · ${d.online?'в сети':'отключён'}${d.id===deviceId?' · выбран':''}${run?.deviceId===d.id?' · выполняет текущий ответ':''}</small></span>${d.id===deviceId?'<span aria-hidden="true">✓</span>':''}</button>`).join('')||'<p>Нет подключённых компьютеров.</p>'}</div><p class="muted">Компьютер должен быть включён и подключён к интернету. Подключение новых компьютеров и вход в подписки выполняются на Mac.</p>`);
  return;
 }
 dialog('Компьютеры',`<p>Выбранный справа вверху компьютер выполняет запрос через свои подписки. Любой аккаунт этого пространства видит общую историю и файлы.</p><div id="device-cards">${state.devices.map(d=>`<div class="device-card"><h3><span class="status-dot ${d.online?'ready':'error'}" style="display:inline-block"></span> ${esc(d.name)} ${d.local?'· этот сервер':''}</h3><small>${esc(d.owner)} · ${d.online?'в сети':'отключён'}</small><div id="device-${d.id}">${d.online?'Проверяю подписки…':''}</div>${!d.local?`<button onclick="revokeDevice(${jsArg(d.id)})">Отключить устройство</button>`:''}</div>`).join('')}</div><p>Чтобы продолжить на другом компьютере, подключи его к <strong>этому же</strong> пространству и открой существующий чат.</p><form id="device-form"><div class="form-row"><label>Имя другого компьютера</label><input name="name" required placeholder="Например: Рабочий компьютер" maxlength="80"></div><div class="form-row"><label>Адрес общего пространства, доступный с другого компьютера</label><input name="hubUrl" required value="${esc(location.protocol==='https:'?location.origin:info.addresses?.[0]||location.origin)}"></div><p>${info.localOnly?'Сервер пока доступен только локально. Для второго компьютера нужен запуск в локальной сети или размещение на постоянном адресе.':'В одной сети можно использовать адрес выше. Для разных сетей нужен постоянный HTTPS адрес или частная сеть.'}</p><button class="primary-button">Скачать подключение для Mac и Windows</button></form><p class="muted">На Mac открой «Установить автозапуск Mac.command»: после сообщения «Автозапуск установлен» окно можно закрыть. На Windows используй «Запуск Windows.cmd» и оставь окно открытым. Нужен Node.js LTS. Затем войди в подписки кнопками выше; работа происходит в окне чата.</p><pre id="login-output" class="login-output"></pre>`);
 if(window.teamRoomNativeMac){const form=$('#device-form');form.hidden=true;const hint=form.nextElementSibling;if(hint)hint.textContent='На этом Mac открой верхнее меню macOS «Team Room → Этот Mac…» → «Подключить этот Mac». Приложение само зарегистрирует компьютер и настроит фоновую работу. Архивы и терминал не нужны.';}
 $('#device-form').onsubmit=async e=>{e.preventDefault();const button=e.target.querySelector('button');button.disabled=true;try{const r=await fetch('/api/device-package',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...Object.fromEntries(new FormData(e.target)),projectId})});if(!r.ok)throw new Error((await r.json()).error);const blob=await r.blob(),url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='Team-Room-Connect.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Распакуй архив. На Mac открой «Установить автозапуск Mac.command», на Windows — «Запуск Windows.cmd».')}catch(error){toast(error.message,'error')}finally{button.disabled=false}};
 for(const d of state.devices.filter(d=>d.online)){const account=state.me.id,card=$('#device-'+d.id);void Promise.all(['claude','codex'].map(async p=>{const key=subscriptionKey(d.id,p);try{const result=await api(`/catalog?device=${encodeURIComponent(d.id)}&provider=${p}&account=${encodeURIComponent(selectedAccountId(d.id,p))}`,'GET',undefined,{timeoutMs:12000});if(state?.me.id!==account)return {p};catalogData[key]=mergeCatalogResult(result,catalogData[key]);return {p,...catalogData[key]}}catch(error){if(state?.me.id!==account)return {p};return {p,...catalogFailure(d.id,p,error)}}})).then(results=>{if(state?.me.id!==account||!card?.isConnected||$('#device-'+d.id)!==card)return;card.innerHTML=results.map(r=>`<div class="provider-status"><span class="status-dot ${r.connected?'ready':r.connected===false?'error':''}"></span>${providerName(r.p)} · ${r.connected?'подписка подключена'+(r.refreshPending?' · модели сохранены':''):esc(r.detail)}${typeof r.connected==='boolean'?`<button onclick="loginProvider(${jsArg(r.p)},${jsArg(d.id)})">${r.connected?'Другой вход':'Войти'}</button>`:''}</div>`).join('')})}
 }catch(error){if(currentDialogRead(read))dialogFeedback(error.message,'error')}};
window.revokeDevice=async id=>{try{await api('/devices/'+id,'DELETE');await refreshState();showDevices()}catch(error){toast(error.message,'error')}};
window.openMobileSetting=method=>{phoneSettingsChild=true;const actions={memory:()=>showMemory(),files:()=>{openPhoneFiles()},tasks:()=>showTasks(),devices:()=>showDevices(),limits:()=>showProviderInfo(),mcp:()=>showMcp(),skills:()=>showSkills(),import:()=>showImport(),account:()=>showProfile(),voice:()=>showVoiceSettings(),notifications:()=>showNotifications(),shortcuts:()=>showShortcuts()};actions[method]?.()};
window.showMobileSettings=()=>{phoneSettingsChild=false;closeSidebar(false);const groups=[['Проект',[['memory','memory','Память проекта'],['files','file','Файлы проекта'],['tasks','task','Задачи']]],['Рабочее пространство',[['devices','computer','Компьютеры'],['limits','limits','Лимиты подписки'],['mcp','tools','Подключения MCP'],['skills','skill','Скиллы'],['import','import','Импортировать чат']]],['Аккаунт',[['voice','mic','Голосовой режим'],['notifications','limits','Уведомления'],['shortcuts','tools','Горячие клавиши'],['account','account',state.me.name]]]];dialog('Настройки',groups.map(([title,rows])=>`<section class="phone-settings-group"><h3>${esc(title)}</h3><div class="mobile-settings-list">${rows.map(([action,icon,label])=>`<button onclick="openMobileSetting('${action}')">${phoneIcon(icon)}<span>${esc(label)}</span>${phoneIcon('chevron')}</button>`).join('')}</div></section>`).join(''),true)};

window.showNotifications=async()=>{
 if(!phoneNotifications.ready)void phoneNotifications.init();
 dialog('Уведомления',`<p>Team Room сообщит, когда нужен твой ответ и когда работа завершена. Нажатие на уведомление откроет нужную сессию.</p><p id="push-state" role="status">Проверяю уведомления…</p><div id="push-options" hidden><label class="voice-setting-check"><input id="push-questions" type="checkbox"> Вопросы и запросы разрешения</label><label class="voice-setting-check"><input id="push-completed" type="checkbox"> Работа завершена</label><label class="voice-setting-check"><input id="push-failed" type="checkbox"> Ошибка, нужно внимание</label><div class="form-row"><label for="push-scope">Какие чаты</label><select id="push-scope"><option value="all">Все чаты пространства</option><option value="mine">Чаты, в которых я работаю</option></select></div><label class="voice-setting-check"><input id="push-preview" type="checkbox"> Показывать название чата на экране блокировки</label><div class="voice-actions"><button id="push-enable" class="primary-button">Включить уведомления</button><button id="push-disable" hidden>Отключить на этом устройстве</button><button id="push-demo" hidden>Проверить уведомление</button></div></div><p class="muted">Разрешение запрашивается один раз. После выхода из аккаунта уведомления этого входа отключаются; после повторного входа подключение восстановится, если разрешение осталось. На iPhone Team Room должен быть добавлен на главный экран.</p>`);
 const token=crypto.randomUUID(),account=state?.me.id;$('#dialog').dataset.pushToken=token;const current=()=>state?.me.id===account&&$('#dialog')?.open&&$('#dialog').dataset.pushToken===token&&Boolean($('#push-state'));
 try{
  const status=await phoneNotifications.status();if(!current())return;
  $('#push-state').textContent=status.reason|| (status.denied?'Уведомления запрещены. Разреши их для Team Room в настройках телефона.':status.enabled?'Уведомления включены на этом устройстве.':'Уведомления пока выключены.');
  if(status.reason)return;$('#push-options').hidden=false;
  for(const key of ['questions','completed','failed','preview'])$('#push-'+key).checked=status.preferences[key];$('#push-scope').value=status.preferences.scope;
  $('#push-enable').textContent=status.enabled?'Сохранить настройки':'Включить уведомления';$('#push-disable').hidden=!status.enabled;$('#push-demo').hidden=!status.enabled||!selectedId;
  $('#push-enable').onclick=async()=>{const button=$('#push-enable');button.disabled=true;try{const preferences=Object.fromEntries(['questions','completed','failed','preview'].map(key=>[key,$('#push-'+key).checked]));preferences.scope=$('#push-scope').value;const result=await phoneNotifications.enable(preferences);if(!current()||result?.cancelled)return;toast('Уведомления включены');void showNotifications();}catch(error){if(current())toast(error.message,'error');if(button.isConnected)button.disabled=false}};
  $('#push-disable').onclick=async()=>{try{const result=await phoneNotifications.disable();if(!current()||result?.cancelled)return;toast('Уведомления выключены на этом устройстве');void showNotifications()}catch(error){if(current())toast(error.message,'error')}};
  $('#push-demo').onclick=async()=>{try{await api('/notifications/demo','POST',{chatId:selectedId},{timeoutMs:10000});if(current())toast('Проверочное уведомление отправлено')}catch(error){if(current())toast(error.message,'error')}};
 }catch(error){if(current())$('#push-state').textContent=error.message;}
};
const communityUpdates=new CommunityUpdates({api,dialog,esc,state:()=>state});
window.showCommunityUpdates=()=>communityUpdates.show(false);
window.showProfile=()=>dialog(state.me.name,renderProfileMenu(state,esc));
window.showInvite=async code=>{try{const invite=typeof code==='string'?code:(await api('/invite','POST',{})).inviteCode;dialog('Подключить другой аккаунт',`<p>Открой этот же адрес пространства на другом компьютере, выбери «У меня есть код приглашения» и задай другое имя.</p><div class="code-copy">${esc(invite)}</div><p>Этот код действует 7 дней и даёт доступ к общим чатам, памяти и файлам. Новый код отменяет предыдущий.</p>`)}catch(error){toast(error.message,'error')}};
function clearAuthDialog(){clearPreviewTools();chatTools.clear();
 cancelDialogRead();
 const modal=$('#dialog');phoneSettingsChild=false;
 if(modal){modal.onclose=null;if(modal.open)modal.close();modal.innerHTML='';for(const key of Object.keys(modal.dataset))delete modal.dataset[key];modal.classList.remove('artifact-dialog','session-menu-dialog','mobile-sheet');modal.removeAttribute('aria-labelledby');}
 clearTimeout(toastTimer);const notice=$('#toast');if(notice){notice.textContent='';notice.style.display='none';}
}
function clearAuthView(){sessionBoard.clear();executionMode='build';executionModeSaving=false;cancelChatReads();cancelProjectFileReads();sidebarHover.detach();sidebarSections.detach();clearChatDrag({render:false});usagePopover.close({restoreFocus:false});splitWorkspace?.destroy();if(isEmbeddedPane)announcePaneAuthExpired();clearAgentView();clearAuthDialog();voiceConversation.cancel();if(!isEmbeddedPane)void phoneNotifications.clear();dictation.cancel();browserLinks.clear();pendingBrowserLinks.clear();clearTimeout(browserLinksTimer);const account=state?.me.id;try{if(account)roomSessionStorage.removeItem('roomPreview:'+account)}catch{}socket?.close();clearTimeout(eventRetryTimer);clearTimeout(stateRefreshTimer);stateRefreshTimer=null;chat=null;state=null;chatOpenGeneration++;requestGeneration++;chatLoading=false;chatLoadError='';appliedRouteSelection='';chatCache.clear();chatLoads.clear();chatReadOrders.clear();acceptedChatReads.clear();liveReplies.clear();streamedRuns.clear();completedReplyReads.clear();renderedChatView=null;replyWatchdogLastAt=0;replyRecoveryAt=0;replyProgressUnsupported=false;cancelStreamPaint();streamPaintAt=0;actionCache.clear();actionLoads.clear();pendingSends.clear();approvalDrafts.clear();approvalErrors.clear();approvalInFlight.clear();catalogData={};attachments=[];draft='';sendingMessage=false;resuming=false;pendingCreditSend=undefined;usageCreditsConsent=false;loginChallenge=null;authMode='login';}
window.logout=async()=>{try{await api('/logout','POST',{});clearAuthView();renderAuth()}catch(error){toast(error.message,'error')}};
const replyRenderFields=['id','role','text','status','provider','model','error','syncWarning','clientSending','delivery','deliveryDetail','followup','owner','actionsDeferred','fileAliasGroup','sourceSessionId','executionMode','queueOrder'];
function messageRenderSnapshot(message){const row={};for(const field of replyRenderFields)row[field]=message[field];row.actions=JSON.stringify(message.actions||[]);row.attachments=JSON.stringify(message.attachments||[]);row.fileOverrides=JSON.stringify(message.fileOverrides||{});row.replyBoundaries=JSON.stringify(replyBoundaries(message));return row;}
function fileRenderSnapshot(value){return JSON.stringify({files:(value.files||[]).map(file=>[file.path,file.size]),aliases:value.fileAliases,roots:Object.values(value.providerSessions||{}).map(session=>session.cwd)});}
function chatRenderSnapshot(value){return value?{id:value.id,projectId:value.projectId,title:value.title,runStage:runStageLabel(value.run),messages:value.messages.map(messageRenderSnapshot),replyReferences:(value.replyReferences||[]).map(messageRenderSnapshot),approvals:JSON.stringify(value.approvals||[]),history:JSON.stringify(value.history),importSource:JSON.stringify(value.importSource),fileReferences:fileRenderSnapshot(value)}:null;}
function markRenderedReply(message){const rendered=renderedChatView?.id===chat?.id&&[...renderedChatView.messages,...renderedChatView.replyReferences].find(m=>m.id===message.id);if(rendered){rendered.text=message.text;rendered.replyBoundaries=JSON.stringify(replyBoundaries(message));}}
function visibleMessagesChanged(previous,next){
 // Compare against what was painted, rather than the mutable streaming chat object.
 const painted=renderedChatView;if(!painted||painted.id!==next.id||painted.projectId!==next.projectId||painted.title!==next.title||painted.runStage!==runStageLabel(next.run)||painted.messages.length!==next.messages.length)return true;
 for(let index=0;index<next.messages.length;index++){const current=messageRenderSnapshot(next.messages[index]),rendered=painted.messages[index];if(Object.keys(current).some(key=>current[key]!==rendered[key]))return true;}
 const references=(next.replyReferences||[]).map(messageRenderSnapshot);if(references.length!==painted.replyReferences.length||references.some((row,index)=>Object.keys(row).some(key=>row[key]!==painted.replyReferences[index][key])))return true;
 return painted.approvals!==JSON.stringify(next.approvals||[])||painted.history!==JSON.stringify(next.history)||painted.importSource!==JSON.stringify(next.importSource)||painted.fileReferences!==fileRenderSnapshot(next);
}

async function refreshState(){if(!state)return;if(refreshing){refreshAgain=true;return}refreshing=true;try{const account=state.me.id;const latest=await api('/state');if(!state||state.me.id!==account)return;lastStateReadAt=Date.now();const previousSummary=state.chats.find(c=>c.id===selectedId);const wasOnline=state?.devices.find(d=>d.id===deviceId)?.online,recoveredNetwork=!networkReady;state=latest;if(!state.projects.some(p=>p.id===projectId)){projectId=state.projects[0].id;expandedProjectId=projectId;selectedId='';chat=null;files=[];filesProjectId=null;attachments=[];chatOpenGeneration++;chatLoading=false;resetNewChatDevice();rememberView();renderShell();}else{const moved=state.chats.find(c=>c.id===selectedId);if(moved&&moved.projectId!==projectId){projectId=moved.projectId;expandedProjectId=projectId;files=[];filesProjectId=null;if(!movingChats.has(selectedId))attachments=[];rememberView();}const picker=$('#project-picker');if(picker)picker.innerHTML=state.projects.map(p=>`<option value="${p.id}" ${p.id===projectId?'selected':''}>${esc(p.name)}</option>`).join('')+'<option value="new">＋ Новый проект</option>';}networkReady=true;const badge=$('#network-badge');if(badge)badge.textContent='';if(state.devices.find(d=>d.id===deviceId)?.online&&(!wasOnline||recoveredNetwork||!catalogBusy&&(!catalogData[subscriptionKey()]?.connected||catalogData[subscriptionKey()]?.refreshPending&&Date.now()-(catalogData[subscriptionKey()].lastReadAt||0)>=15000)))void loadCatalog();renderChatList();renderDevicesPicker();const currentSummary=state.chats.find(c=>c.id===selectedId);if(selectedId&&!currentSummary){if(sessionBoard.visible){selectedId='';chat=null;rememberView();}else newChat();}if(!sessionBoard.visible&&selectedId&&(!chat||chatLoadError||dirtyChats.has(selectedId)||Number.isFinite(currentSummary?.revision)&&currentSummary.revision>(chat.revision||0)||JSON.stringify(previousSummary)!==JSON.stringify(currentSummary))){const id=selectedId,generation=chatOpenGeneration,before=historyBefore;dirtyChats.delete(id);let latestChat;try{latestChat=await fetchChat(id,before);}catch(error){if(state?.me.id===account)dirtyChats.add(id);throw error;}if(state?.me.id===account&&generation===chatOpenGeneration&&before===historyBefore&&id===selectedId&&!chatLoading){chatLoadError='';const redraw=visibleMessagesChanged(chat,latestChat);chat=latestChat;const previousRoute=subscriptionKey();applyChatRoute(chat);if(previousRoute!==subscriptionKey())void loadCatalog();if(redraw)renderMessages();else renderComposer();voiceConversation.reply(chat)}}renderStatus();if($('#auto-memory-state'))$('#auto-memory-state').innerHTML=memorySummary();if($('#memory-rows'))$('#memory-rows').innerHTML=memoryRows();}catch(error){if(error.status===401){clearAuthView();renderAuth()}else{networkReady=socket?.readyState===WebSocket.OPEN&&Date.now()-eventLastReceived<45000;renderStatus()}}finally{refreshing=false;if(refreshAgain){refreshAgain=false;void refreshState()}}}
function receiveCompletedReply(event){
 if(!event.messageId||typeof event.text!=='string')return;
 if(event.chatId!==selectedId&&!chatCache.has(event.chatId)){dirtyChats.add(event.chatId);return;}
 const key=replyKey(event.chatId,event.messageId),previous=liveReplies.get(key),current=chat?.id===event.chatId?chat:chatCache.get(event.chatId),message=replyMessages(current).find(m=>m.id===event.messageId);
 if(Number.isFinite(previous?.revision)&&Number.isFinite(event.revision)&&event.revision<previous.revision)return;
 if(previous?.final&&Number.isFinite(previous.revision)&&!Number.isFinite(event.revision))return;
 // A later terminal GET may already contain moved file links or a recovered result.
 // Running messages still accept their final event when other chat changes raised the revision.
 if(message?.status&&message.status!=='running'&&Number.isFinite(current.revision)&&Number.isFinite(event.revision)&&event.revision<current.revision)return;
 rememberLiveReply(key,{runId:event.runId||previous?.runId||null,streamRevision:previous?.streamRevision,revision:event.revision,knownRevision:Math.max(previous?.knownRevision||0,previous?.revision||0,chat?.id===event.chatId?chat.revision||0:chatCache.get(event.chatId)?.revision||0),text:event.text,replyBoundaries:replyBoundaries(Array.isArray(event.replyBoundaries)?event:previous||message),status:event.status||'completed',error:event.error||null,at:Date.now(),finalBoundaryAt:Date.now(),final:true});
 const cached=chatCache.get(event.chatId);
 for(const value of new Set([current,cached]))if(value){if(Number.isFinite(event.revision))value.revision=Math.max(value.revision||0,event.revision);protectLiveReplies(value);}
 if(chat?.id!==event.chatId||selectedId!==event.chatId)return;
 if(uiBackground()){dirtyChats.add(event.chatId);return;}
 cancelStreamPaint();protectLiveReplies(chat);
 if(chat.run?.id===event.runId){chat.run.phase='saving';chat.run.waitingFor=null;chat.run.text='Сохраняет результат…';chat.approvals=[];}
 renderMessages();void readCompletedReply(event);
}
async function readCompletedReply(event){
 const key=replyKey(event.chatId,event.messageId);if(completedReplyReads.has(key))return completedReplyReads.get(key);
 const account=state?.me.id,generation=chatOpenGeneration,before=historyBefore;
 const request=fetchChat(event.chatId,before,{fresh:true}).then(value=>{
  if(state?.me.id!==account||chatOpenGeneration!==generation||before!==historyBefore||selectedId!==event.chatId||chatLoading)return;
  chat=value;chatLoadError='';renderMessages();voiceConversation.reply(chat);dirtyChats.add(event.chatId);scheduleStateRefresh();
 }).catch(error=>{if(state?.me.id===account&&chatOpenGeneration===generation&&before===historyBefore&&selectedId===event.chatId){dirtyChats.add(event.chatId);scheduleStateRefresh();if(error.status===401){clearAuthView();renderAuth();}}}).finally(()=>{if(completedReplyReads.get(key)===request)completedReplyReads.delete(key);});
 completedReplyReads.set(key,request);return request;
}
async function reconcileActiveReply({force=false}={}){
 if(!state||!chat||chat.id!==selectedId||chatLoading||uiBackground()||!networkReady||replyWatchdogRequest||replyProgressUnsupported)return;
 const summary=state.chats.find(c=>c.id===selectedId),run=chat.run||summary?.run;if(!run)return;
 const stamp=Date.now(),lastDelta=streamedRuns.get(run.id)||Date.parse(run.startedAt)||0;
 if(!force&&(stamp-lastDelta<4000||stamp-replyWatchdogLastAt<8000))return;
 const id=chat.id,account=state.me.id,generation=chatOpenGeneration,before=historyBefore,startingRunId=run.id,known=replyMessages(chat).findLast(m=>m.role==='assistant'&&m.status==='running')||chat.messages.findLast(m=>m.role==='assistant');replyWatchdogLastAt=stamp;
 const request=api('/chats/'+id+'?view=progress'+(known?'&message='+encodeURIComponent(known.id):''),'GET',undefined,{timeoutMs:8000}).then(value=>{
  if(state?.me.id!==account||chatOpenGeneration!==generation||before!==historyBefore||selectedId!==id||chatLoading)return;
  // Old hubs ignore unknown views and return the entire history. Do not poll that payload.
  if(value.history||!Number.isFinite(value.messageCount)||!Array.isArray(value.messages)||value.messages.length>1){replyProgressUnsupported=true;return;}
  if(chat.run?.id&&chat.run.id!==startingRunId)return;
  if(Number.isFinite(value.revision)&&Number.isFinite(chat.revision)&&value.revision<chat.revision)return;
  protectLiveReplies(value,{readStartedAt:stamp});
  const oldRunId=chat.run?.id;
  for(const incoming of value.messages){
   const existing=replyMessages(chat).find(m=>m.id===incoming.id);if(!existing){dirtyChats.add(id);scheduleStateRefresh();continue;}
   Object.assign(existing,incoming);
   if(incoming.role==='assistant'&&incoming.status==='running'){
    const key=replyKey(id,incoming.id),live=liveReplies.get(key);
    if(!live?.final)rememberLiveReply(key,{runId:value.run?.id||live?.runId||startingRunId,streamRevision:Math.max(Number.isFinite(value.streamRevision)?value.streamRevision:0,Number.isFinite(live?.streamRevision)?live.streamRevision:0),knownRevision:Number.isFinite(value.revision)?Math.max(value.revision,live?.knownRevision||0):live?.knownRevision,text:incoming.text||'',replyBoundaries:replyBoundaries(incoming),at:live?.at||stamp,final:false});
   }
  }
  for(const field of ['revision','updatedAt','run','approvals','route','pendingRoute','executionDeviceId'])if(Object.hasOwn(value,field))chat[field]=value[field];
  if(chat.history&&value.messageCount!==chat.history.total){dirtyChats.add(id);scheduleStateRefresh();}
  if(visibleMessagesChanged(chat,chat))renderMessages();else{renderComposer();renderStatus();}
  voiceConversation.reply(chat);
  // Finalization must reconcile files and deferred actions, even when the text is unchanged.
  if(oldRunId&&!chat.run){const last=value.messages[0];if(last)void readCompletedReply({chatId:id,messageId:last.id,runId:oldRunId});else{dirtyChats.add(id);scheduleStateRefresh();}}
 }).catch(error=>{if(state?.me.id!==account||chatOpenGeneration!==generation)return;if(error.status===404)replyProgressUnsupported=true;else if(error.status===401){clearAuthView();renderAuth();}}).finally(()=>{if(replyWatchdogRequest===request)replyWatchdogRequest=null;});
 replyWatchdogRequest=request;return request;
}
function sendEventFrame(ws,value){if(ws!==socket||ws.readyState!==WebSocket.OPEN)return false;try{ws.send(JSON.stringify(value));return true;}catch{if(state)connectEvents();return false;}}
function receiveRunProgress(event){
 if(!event.run||!event.runId||event.run.id!==event.runId||!event.chatId)return;
 const current=chat?.id===event.chatId?chat:null,cached=chatCache.get(event.chatId),summary=state?.chats.find(value=>value.id===event.chatId);
 const values=[...new Set([current,cached,summary])].filter(value=>value?.run?.id===event.runId);
 const known=values[0];if(!known){if(event.chatId===selectedId){dirtyChats.add(event.chatId);scheduleStateRefresh();}return;}
 if(Number.isFinite(event.revision)&&Number.isFinite(known.revision)&&event.revision<known.revision)return;
 const previousStamp=Date.parse(known.run.transfer?.updatedAt||''),incomingStamp=Date.parse(event.run.transfer?.updatedAt||'');
 if(known.run.transfer?.direction===event.run.transfer?.direction&&Number.isFinite(previousStamp)&&Number.isFinite(incomingStamp)&&incomingStamp<previousStamp)return;
 const changedStage=known.run.phase!==event.run.phase||known.run.transfer?.direction!==event.run.transfer?.direction;
 for(const value of values){value.run={...event.run};if(Number.isFinite(event.revision))value.revision=Math.max(value.revision||0,event.revision);}
 if(changedStage)renderChatList();
 if(sessionBoard.visible){sessionBoard.stateChanged();return;}
 if(current?.run?.id!==event.runId||selectedId!==event.chatId)return;
 if(changedStage){renderMessages();renderStatus();}else renderRunActivity();
}
function connectEvents(){clearTimeout(eventRetryTimer);eventRetryTimer=null;socket?.close();eventConnectStartedAt=Date.now();const ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/events`);socket=ws;ws.onopen=()=>{if(socket!==ws)return;if(!sendEventFrame(ws,{type:'capabilities',replyDeltas:1}))return;eventLastReceived=Date.now();eventProbeUntil=0;networkReady=true;const badge=$('#network-badge');if(badge)badge.textContent='';if(selectedId)dirtyChats.add(selectedId);syncAgentWatch(true);if(agentPanelSelection)void loadAgentDetails(agentPanelSelection,true);void refreshState()};ws.onmessage=event=>{if(socket!==ws||!state)return;eventLastReceived=Date.now();eventProbeUntil=0;let msg;try{msg=JSON.parse(event.data)}catch{return}if(msg.type==='board-changed'){sessionBoard.stateChanged();return;}if(['state','run-progress','reply-complete'].includes(msg.type))sessionBoard.stateChanged();if(msg.type==='ping'){sendEventFrame(ws,{type:'pong',at:msg.at});return;}if(msg.type==='pong')return;if(msg.type==='run-progress'){receiveRunProgress(msg);}else if(msg.type==='agent-progress'){receiveAgentProgress(msg);}else if(msg.type==='reply-complete'){receiveCompletedReply(msg);}else if(msg.type==='delta'&&msg.chatId===selectedId){const live=acceptReplyDelta(msg);if(!live)return;const m=replyMessages(chat).find(m=>m.id===msg.messageId);if(m){m.text=live.text;m.replyBoundaries=replyBoundaries(live);if(live.runId)streamedRuns.set(live.runId,Date.now());if(!sessionBoard.visible)scheduleStream(m)}else if(!chat?.history?.hasLater){dirtyChats.add(selectedId);scheduleStateRefresh()}}else if(msg.type==='state'||msg.type==='connected'){if(msg.chatId)dirtyChats.add(msg.chatId);if(msg.type==='state'||Date.now()-lastStateReadAt>1500)scheduleStateRefresh();if(filePanel&&!sessionBoard.visible&&!uiBackground())void refreshFiles()}else if(msg.type==='route'&&msg.chatId===selectedId){if(chat?.id===msg.chatId){chat.route=msg.options;chat.executionDeviceId||=msg.options.deviceId;applyChatRoute(chat);}else applyChatRoute({id:msg.chatId,route:msg.options,executionDeviceId:msg.options.deviceId});void loadCatalog();toast(msg.reason==='limit'?'Лимит исчерпан. Продолжаю сохранённую работу с '+providerName(provider):'Контекст сохранён; переключение выполнено.');}else if(msg.type==='limits'){const d=catalogData[subscriptionKey(msg.deviceId,msg.provider,msg.accountId||'')];if(d){d.limits=msg.limits;d.limitsUpdatedAt=msg.updatedAt||new Date().toISOString();}renderStatus()}else if(msg.type==='login-log'){receiveAccountLogin(msg);}else if(msg.type==='login-complete'){receiveAccountLogin(msg);toast(msg.code===0?'Вход завершён. Проверяю подписку.':'Вход не завершён. Попробуй снова в «Компьютеры».');void loadCatalog(true);if($('#device-form'))void showDevices()}};ws.onclose=event=>{if(socket!==ws||!state)return;if(event.code===4001){clearAuthView();renderAuth();return;}networkReady=false;const badge=$('#network-badge');if(badge)badge.textContent='Восстанавливаю связь…';renderStatus();clearTimeout(eventRetryTimer);eventRetryTimer=setTimeout(()=>{if(state&&socket===ws&&!uiBackground())connectEvents()},2000)};ws.onerror=()=>{};}
function probeEvents(){
 if(!state||uiBackground())return;
 if(selectedId)dirtyChats.add(selectedId);void refreshState();
 if(socket?.readyState===WebSocket.OPEN){eventProbeUntil=Date.now()+20000;sendEventFrame(socket,{type:'ping',at:Date.now()});}
 else if(socket?.readyState!==WebSocket.CONNECTING||Date.now()-eventConnectStartedAt>20000)connectEvents();
}
window.addEventListener('online',probeEvents);
let notificationNavigation=0;
async function openNotificationSession(value){
 if(!state||typeof value!=='string'||value.length>4096)return;
 let url;try{url=new URL(value,location.origin);}catch{return;}
 if(url.origin!==location.origin||!['/','/room','/room/'].includes(url.pathname))return;
 const id=url.searchParams.get('chat'),project=url.searchParams.get('project');if(!id&&!project)return;
 const account=state.me.id,navigation=++notificationNavigation,generation=chatOpenGeneration;
 try{
  if(id&&!state.chats.some(c=>c.id===id)||project&&!state.projects.some(p=>p.id===project)){
   const latest=await api('/state','GET',undefined,{timeoutMs:8000});if(state?.me.id!==account||navigation!==notificationNavigation||generation!==chatOpenGeneration)return;state=latest;
  }
  if(state?.me.id!==account||navigation!==notificationNavigation||generation!==chatOpenGeneration)return;
  const target=state.chats.find(c=>c.id===id);if(id&&!target)return toast('Эта сессия больше недоступна.');
  closeDialog();usagePopover.close({restoreFocus:false});closeSidebar(false);
  if(id){await openChat(id);if(state?.me.id===account&&navigation===notificationNavigation&&chat?.id===id&&chat.approvals?.length)showPendingApproval();}
  else if(state.projects.some(p=>p.id===project)){const input=$('#message-input'),savedDraft=input?.value||draft;await selectProject(project);draft=savedDraft;if($('#message-input'))$('#message-input').value=savedDraft;renderAttachments();}
 }catch(error){if(state?.me.id===account&&navigation===notificationNavigation)toast(error.message,'error');}
}
navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='teamroom-notification-open')void openNotificationSession(event.data.url);});
window.addEventListener('teamroom:pane-visibility',event=>{if(event.detail?.visible)probeEvents();else cancelStreamPaint();});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){probeEvents();acknowledgeVisibleCompletion();}});
setInterval(()=>{
 const stamp=Date.now(),afterSleep=stamp-eventLastTick>45000;eventLastTick=stamp;
 if(!state||uiBackground())return;
 if(socket?.readyState===WebSocket.OPEN){
  if(afterSleep)eventProbeUntil=stamp+20000;
  if(eventProbeUntil?stamp>eventProbeUntil:stamp-eventLastReceived>60000){connectEvents();return;}
  sendEventFrame(socket,{type:'ping',at:stamp});
 }else if(socket?.readyState===WebSocket.CONNECTING){if(stamp-eventConnectStartedAt>20000)connectEvents();}
 else if(afterSleep||!eventRetryTimer)connectEvents();
},15000);
let dragCount=0;window.addEventListener('dragenter',e=>{if(!state||!e.dataTransfer.types.includes('Files'))return;e.preventDefault();dragCount++;if(!$('.drag-overlay')){const el=document.createElement('div');el.className='drag-overlay';el.textContent='Добавить файлы в общий проект';document.body.append(el)}});window.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault()});window.addEventListener('dragleave',()=>{dragCount=Math.max(0,dragCount-1);if(!dragCount)$('.drag-overlay')?.remove()});window.addEventListener('drop',e=>{if(!state)return;e.preventDefault();dragCount=0;$('.drag-overlay')?.remove();void uploadFiles(Array.from(e.dataTransfer.files),false)});
setInterval(()=>{if(state&&!uiBackground())void refreshState()},15000);
setInterval(()=>{if(state&&chat?.run&&!uiBackground()){renderRunActivity();updateAgentClocks();}},1000);
setInterval(()=>{void reconcileActiveReply()},2000);
try{const boot=window.teamRoomBoot;delete window.teamRoomBoot;if(boot){const response=await boot;if(!response.ok)throw Object.assign(new Error('Войди в Team Room.'),{status:response.status});state=await response.json();}else state=await api('/state');lastStateReadAt=Date.now();initRoom()}catch(error){if(isEmbeddedPane){if(error.status===401){announcePaneAuthExpired();$('#app').innerHTML='<div class="boot">Войди в основном окне Team Room.</div>';}else{$('#app').innerHTML='<div class="boot">Не удалось загрузить правую сессию. Проверь связь и попробуй снова.<button onclick="location.reload()">Попробовать снова</button></div>';}}else{try{const boot=await api('/bootstrap');authTelegram=Boolean(boot.telegramEnabled);authMode=boot.setupRequired?'setup':'login';renderAuth()}catch{$('#app').innerHTML=`<div class="boot">${isPhoneClient?'Не удалось подключиться к Team Room. Проверь интернет и попробуй снова.<button onclick="location.reload()">Попробовать снова</button>':'Team Room не запущен. Открой файл запуска приложения.'}</div>`}}}

window.showSecurity=()=>{
 if(!state.me.owner)return toast('Безопасностью входа управляет владелец.');
 const enabled=state.security?.telegramEnabled;
 dialog('Безопасность входа',`<p>${enabled?'✓ Вход подтверждается одноразовым кодом в Telegram.':'Подключи Telegram, чтобы новый вход был возможен только с одноразовым кодом.'}</p><p>Авторизация сохраняется 30 дней. Обновление страницы не требует кода; после выхода нужен новый код.</p>${enabled?`<p>Бот: ${esc(state.security.botUsername?'@'+state.security.botUsername:'подключён')}</p><button onclick="showTelegramRecipients()">Получатели кодов в Telegram</button>`:`<form id="telegram-security-form"><div class="form-row"><label>Текущий пароль владельца</label><input name="password" type="password" required autocomplete="current-password" maxlength="1024"></div><div class="form-row"><label>Токен Telegram-бота</label><input name="token" type="password" required autocomplete="off" maxlength="200"></div><div class="form-row"><label>Твой Telegram ID</label><input name="chatId" value="123456789" required inputmode="numeric" pattern="[0-9]{1,20}"></div><p class="muted">Создай бота через @BotFather и нажми Start в его чате. Токен останется на сервере в зашифрованном виде. После ввода кода вход по одному паролю отключится.</p><button class="primary-button" type="submit">Получить код подключения</button><p id="security-error" role="alert"></p></form>`}<hr><p>Если на другом устройстве остался открытый вход, можно завершить его. Выполняющиеся задачи сохранятся.</p><button onclick="revokeOtherSessions()">Завершить другие входы</button>`);
 const form=$('#telegram-security-form');if(form)form.onsubmit=async event=>{
  event.preventDefault();const input=Object.fromEntries(new FormData(form)),button=form.querySelector('button');button.disabled=true;form.querySelectorAll('input[type=password]').forEach(el=>el.value='');
  try{const result=await api('/security/telegram/prepare','POST',input);enrollmentChallenge={id:result.challengeId,userId:state.me.id};
   dialog('Подтвердить Telegram',`<p>Введи код из ${esc(result.botUsername?'@'+result.botUsername:'бота')}. Только после подтверждения изменится способ входа.</p><form id="telegram-confirm-form"><div class="form-row"><label>Одноразовый код</label><input name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}"></div><button class="primary-button" type="submit">Включить защищённый вход</button><p id="security-error" role="alert"></p></form>`);
   $('#telegram-confirm-form').onsubmit=async confirm=>{confirm.preventDefault();const button=confirm.target.querySelector('button');button.disabled=true;try{
    if(enrollmentChallenge?.userId!==state?.me.id)throw new Error('Аккаунт изменился. Начни подключение снова.');
    state.security=await api('/security/telegram/confirm','POST',{challengeId:enrollmentChallenge.id,...Object.fromEntries(new FormData(confirm.target))});authTelegram=true;enrollmentChallenge=null;showSecurity();toast('Telegram подключён. Текущий вход сохранён.');
   }catch(error){if($('#security-error'))$('#security-error').textContent=error.message;}finally{button.disabled=false}};
  }catch(error){if($('#security-error'))$('#security-error').textContent=error.message;}finally{button.disabled=false}
 };
};
let telegramRecipientInfo;
window.showTelegramRecipients=async()=>{
 if(!state?.me.owner)return toast('Получателей добавляет владелец.');
 try{
  const account=state.me.id,info=await api('/security/telegram/recipients');if(state?.me.id!==account)return;telegramRecipientInfo=info;
  dialog('Получатели кодов',`<p>Каждому аккаунту Team Room можно назначить свой Telegram. Если получатель не назначен, код приходит владельцу. Компьютеры для доставки кода не нужны.</p><p>По умолчанию: ${esc(info.defaultRecipient.label)} · ${esc(info.defaultRecipient.telegramId)}</p>${info.webhookError?`<p class="auth-error">${esc(info.webhookError)}</p>`:''}<div class="telegram-recipients">${info.recipients.map(r=>`<section class="telegram-recipient"><strong>${esc(r.label)}</strong><p>Аккаунт Team Room: ${esc(r.accountName)}</p><p class="muted">${r.state==='active'?'Подключён · Telegram '+esc(r.telegramId):r.link?'Ожидает подключения · ссылка действует 24 часа':'Приглашение истекло'}</p>${r.link?`<button onclick="copyTelegramInvitation(${jsArg(r.id)})">Копировать приглашение</button>`:''}<button onclick="removeTelegramRecipient(${jsArg(r.id)})">${r.state==='active'?'Отключить':'Отменить приглашение'}</button></section>`).join('')||'<p class="muted">Дополнительных получателей пока нет.</p>'}</div><form id="telegram-recipient-form"><h3>Добавить получателя</h3><div class="form-row"><label for="recipient-label">Имя для списка</label><input id="recipient-label" name="label" required maxlength="60" placeholder="Например, Андрей"></div><div class="form-row"><label for="recipient-account">Аккаунт Team Room</label><input id="recipient-account" name="accountName" required maxlength="50" list="recipient-accounts" placeholder="Выбери существующий или укажи имя нового"><datalist id="recipient-accounts">${state.members.map(m=>`<option value="${esc(m.name)}"></option>`).join('')}</datalist></div><p class="muted">Получатель откроет твою ссылку в Telegram и нажмёт Start. Для нового аккаунта отдельно дай ему код приглашения Team Room. Добавление подтверждается кодом в твоём Telegram.</p><button class="primary-button" type="submit">Создать приглашение</button><p id="recipient-error" role="alert"></p></form>`);
  $('#telegram-recipient-form').onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector('[type=submit]');button.disabled=true;try{await prepareTelegramRecipient({operation:'invite',...Object.fromEntries(new FormData(event.target))})}catch(error){if($('#recipient-error'))$('#recipient-error').textContent=error.message;}finally{button.disabled=false}};
 }catch(error){toast(error.message,'error')}
};
async function prepareTelegramRecipient(action){
 const account=state.me.id,result=await api('/security/telegram/recipients/prepare','POST',action);if(state?.me.id!==account)return;
 dialog('Подтвердить изменение',`<p>${action.operation==='invite'?'Создать приглашение для':'Отключить получателя'} ${esc(action.label||'')}?</p><p>Введи код, отправленный в Telegram владельца. Изменение произойдёт только после подтверждения.</p>${action.operation==='remove'?'<p class="muted">Если получатель уже подключён, его входы в Team Room завершатся. Выполняющаяся работа сохранится, а следующий код придёт владельцу.</p>':''}<form id="recipient-confirm-form"><div class="form-row"><label for="recipient-code">Код из Telegram</label><input id="recipient-code" name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}"></div><button class="primary-button" type="submit">Подтвердить</button><p id="recipient-error" role="alert"></p></form>`);
 $('#recipient-confirm-form').onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector('[type=submit]');button.disabled=true;try{if(state?.me.id!==account)throw new Error('Аккаунт изменился. Начни заново.');await api('/security/telegram/recipients/confirm','POST',{challengeId:result.challengeId,...Object.fromEntries(new FormData(event.target))});await showTelegramRecipients();toast(action.operation==='invite'?'Приглашение создано. Скопируй ссылку и передай получателю.':'Получатель отключён.')}catch(error){if($('#recipient-error'))$('#recipient-error').textContent=error.message;}finally{button.disabled=false}};
}
window.copyTelegramInvitation=async id=>{const row=telegramRecipientInfo?.recipients.find(r=>r.id===id);if(!row?.link)return toast('Ссылка уже недоступна. Обнови список.');try{await navigator.clipboard.writeText(row.link);toast('Ссылка скопирована. Получатель должен открыть её и нажать Start.')}catch{dialog('Приглашение в Telegram',`<p>Передай эту ссылку получателю:</p><input value="${esc(row.link)}" readonly onclick="this.select()">`)}};
window.removeTelegramRecipient=async id=>{const row=telegramRecipientInfo?.recipients.find(r=>r.id===id);if(!row)return;try{await prepareTelegramRecipient({operation:'remove',id,label:row.label})}catch(error){toast(error.message,'error')}};

window.revokeOtherSessions=async()=>{try{await api('/security/revoke-sessions','POST',{});toast('Другие входы завершены. Этот вход сохранён.');}catch(error){toast(error.message,'error')}};

window.showMcp=async()=>{const read=beginDialogRead('Общие MCP');try{
 const info=await api('/mcp','GET',undefined,{timeoutMs:12000,signal:read.controller.signal});if(!currentDialogRead(read))return;const owner=state.me.owner&&!isPhoneClient;
 dialog('Общие MCP',`<p>${isPhoneClient?'Подключённые на Mac MCP доступны и в разговоре с телефона. Настройки добавляй на компьютере.':'Добавь MCP один раз в Claude Code, Codex или здесь.'} Team Room обнаружит настройки и передаст их всем подключённым компьютерам — для обоих провайдеров.</p><p class="muted">Изменения применяются со следующего запроса. Ключи сервисов хранятся зашифрованно; входы в подписки остаются на своих компьютерах.</p>${owner?`<label><input type="checkbox" ${info.auto?'checked':''} onchange="setMcpAuto(this.checked)"> Автоматически находить новые MCP и изменения (новые команды включает владелец)</label>`:''}<h3>Подключения · ${info.servers.length}</h3><div class="mcp-list">${info.servers.length?info.servers.map(m=>`<div class="mcp-row"><div><strong>${esc(m.label)}</strong><small>${esc(m.type.toUpperCase())} · ${m.review?(m.review==='new'?'новый, ждёт одобрения владельца':'команда изменена, ждёт одобрения владельца'):m.enabled?'включён':'выключен'}${m.hasSecrets?' · ключи защищены':''} · ${esc(info.devices.find(d=>d.id===m.sourceDevice)?.name||'Team Room')}</small></div>${owner?`<div class="mcp-actions"><button onclick="toggleMcp(${jsArg(m.name)},${!m.enabled})">${m.enabled?'Выключить':'Включить'}</button><button onclick="deleteMcp(${jsArg(m.name)})" title="Убрать из общего списка">Удалить</button></div>`:''}</div>`).join(''):'<p class="muted">Ожидаю обнаружения MCP на подключённых компьютерах.</p>'}</div><h3>Перенос на компьютеры</h3>${info.devices.map(d=>`<div class="mcp-device"><strong>${esc(d.name)}</strong><small>${!d.online?'Компьютер отключён — получит настройки при подключении':d.mcpSyncVersion!==1?'Нужно один раз обновить Team Room Community Connect для автопереноса MCP':d.mcp?.error?'Не удалось применить настройки':d.mcp?.revision===info.revision?'Настройки синхронизированы · версия '+info.revision:'Передаю настройки…'}</small>${d.mcp?.servers?.filter(s=>s.state==='attention').map(s=>`<p class="muted">${esc(s.name)}: ${esc(s.detail||'Требуется дополнительная настройка сервиса')}</p>`).join('')||''}</div>`).join('')}<p class="muted">Сам MCP может требовать программу или локальный сервис на выбранном компьютере. OAuth-вход в сторонний сервис иногда нужно пройти отдельно. Статус выше подтверждает перенос настроек, а не доступность самого сервиса.</p><div class="modal-buttons"><button onclick="showMcp()">Обновить</button>${owner?`<button onclick="scanMcpDevice()">Найти MCP на выбранном компьютере</button>`:''}<button onclick="showDevices()">Компьютеры</button>${!isPhoneClient?'<a href="/api/connect-update">Скачать обновление подключения</a>':''}</div>${owner?`<details class="mcp-add"><summary>Добавить MCP вручную</summary><form id="mcp-form"><div class="form-row"><label>Имя<input name="name" required maxlength="80" pattern="[a-zA-Z0-9_-]+" placeholder="Например: my-service"></label></div><div class="form-row"><label>Настройки MCP в JSON<textarea name="config" required rows="6" spellcheck="false" placeholder='{"type":"http","url":"https://example.com/mcp","headers":{"Authorization":"Bearer ключ"}}'></textarea></label></div><p class="muted">Для stdio: command, args, env. Используй \${HOME} для домашней папки и \${PROJECT} для рабочей папки чата. Секреты не показываются после сохранения.</p><button class="primary-button">Сохранить для всех компьютеров</button></form></details>`:''}`);
 if(owner)$('#mcp-form').onsubmit=async e=>{e.preventDefault();const form=e.target;try{const fields=Object.fromEntries(new FormData(form));let config;try{config=JSON.parse(fields.config);}catch{throw new Error('Проверь JSON настроек MCP.');}await api('/mcp','POST',{name:fields.name,config});form.reset();await showMcp();toast('MCP передан подключённым компьютерам')}catch(error){toast(error.message,'error')}};
 }catch(error){if(currentDialogRead(read))dialogFeedback(error.message,'error')}};
window.setMcpAuto=async auto=>{try{await api('/mcp','PATCH',{auto});await showMcp()}catch(error){toast(error.message,'error')}};
window.toggleMcp=async(name,enabled)=>{try{await api('/mcp/'+encodeURIComponent(name),'PATCH',{enabled});await showMcp()}catch(error){toast(error.message,'error')}};
window.deleteMcp=async name=>{try{await api('/mcp/'+encodeURIComponent(name),'DELETE');await showMcp();toast('MCP убран из общего списка')}catch(error){toast(error.message,'error')}};
window.scanMcpDevice=async()=>{if(isPhoneClient)return;try{toast('Читаю MCP на выбранном компьютере…');await api('/mcp/scan','POST',{deviceId});await showMcp()}catch(error){toast(error.message,'error')}};

let sharedSkillList=[];
window.showSkills=async()=>{const read=beginDialogRead('Общие скиллы');try{
 const info=await api('/skills','GET',undefined,{timeoutMs:12000,signal:read.controller.signal});if(!currentDialogRead(read))return;sharedSkillList=info.skills;const manage=state.me.owner&&!isPhoneClient;
 dialog('Общие скиллы',`<p>Скиллы из Claude Code и Codex автоматически сохраняются вместе со скриптами, шаблонами и ресурсами и доступны на подключённых компьютерах.</p><p class="muted">В разговор подгружаются названия и описания; полные инструкции читаются при использовании нужного скилла. Изменения применяются со следующего запроса.</p>${manage?`<label><input type="checkbox" ${info.auto?'checked':''} onchange="setSkillsAuto(this.checked)"> Автоматически переносить новые скиллы и изменения</label>`:''}<input class="search" id="skill-search" placeholder="Найти скилл…" oninput="filterSharedSkills(this.value)"><h3>Скиллы · ${info.skills.length}</h3><div id="shared-skill-list"></div><h3>Компьютеры</h3>${info.devices.map(d=>`<div class="mcp-device"><strong>${esc(d.name)}</strong><small>${!d.online?'Отключён — получит скиллы при подключении':d.skillsSyncVersion!==1?'Нужно обновить Team Room Community Connect для переноса скиллов':d.skills?.error?'Не удалось перенести скиллы; повторю автоматически':d.skills?.importing?'Читаю локальные скиллы…':d.skills?.revision===info.revision?'Синхронизировано · '+(d.skills?.count||0)+' включённых скиллов':'Переношу файлы скиллов…'}</small></div>`).join('')}<p class="muted">Скилл может требовать установленную программу, MCP или функции исходного приложения. Перенос файлов сохраняет инструкции и ресурсы; доступность этих инструментов зависит от выбранного компьютера и провайдера.</p><div class="modal-buttons"><button onclick="showSkills()">Обновить</button>${manage?'<button onclick="scanSkillsDevice()">Найти скиллы на выбранном компьютере</button><button onclick="uploadSkillFolder()">Добавить папку скилла</button>':''}${!isPhoneClient?'<a href="/api/connect-update">Скачать обновление подключения</a>':''}</div>${!isPhoneClient?'<input type="file" id="skill-folder-picker" webkitdirectory multiple hidden>':''}`);
 filterSharedSkills('');
 }catch(error){if(currentDialogRead(read))dialogFeedback(error.message,'error')}};
window.filterSharedSkills=value=>{const manage=state.me.owner&&!isPhoneClient;const el=$('#shared-skill-list');if(!el)return;const q=value.toLowerCase();const rows=sharedSkillList.filter(s=>(s.name+' '+s.description).toLowerCase().includes(q));el.innerHTML=rows.length?rows.map(s=>`<div class="skill-row"><div><strong>${esc(s.name)}</strong><p>${esc(s.description)}</p><small>${s.fileCount} файлов · ${(s.bytes/1024).toFixed(0)} КБ · ${s.enabled?'включён':'выключен'}</small>${s.requirements?.length?`<details><summary>Что требуется</summary>${s.requirements.map(r=>`<p>${esc(r)}</p>`).join('')}</details>`:''}</div><div class="skill-actions"><button onclick="useSharedSkill(${jsArg(s.id)})" ${s.enabled?'':'disabled'}>Использовать</button><button onclick="readSharedSkill(${jsArg(s.id)})">Инструкции</button>${manage?`<button onclick="toggleSharedSkill(${jsArg(s.id)},${!s.enabled})">${s.enabled?'Выключить':'Включить'}</button><button onclick="deleteSharedSkill(${jsArg(s.id)})">Убрать</button>`:''}</div></div>`).join(''):'<p class="muted">Скиллы пока не найдены. Обновлённый Connect обнаружит их автоматически.</p>';};
window.useSharedSkill=id=>{const selected=state.devices.find(d=>d.id===deviceId);if(selected?.skillsSyncVersion!==1)return toast('Обнови Team Room Community Connect на выбранном компьютере, чтобы использовать общие скиллы.');const s=sharedSkillList.find(s=>s.id===id&&s.enabled);if(!s)return;closeDialog();const input=$('#message-input');if(!input)return;const command=(provider==='claude'?'/':'$')+s.command+' ';input.value=command+input.value;draft=input.value;input.focus();input.dispatchEvent(new Event('input',{bubbles:true}));toast('Скилл выбран. Добавь задачу и отправь сообщение');};
window.readSharedSkill=async id=>{const read=beginDialogRead('Инструкции скилла');try{const r=await api('/skills/'+encodeURIComponent(id)+'/readme','GET',undefined,{timeoutMs:12000,signal:read.controller.signal});if(!currentDialogRead(read))return;dialog(r.name,`<pre class="skill-readme">${esc(r.text)}</pre><button onclick="showSkills()">К списку скиллов</button>`)}catch(error){if(currentDialogRead(read))dialogFeedback(error.message,'error')}};
window.setSkillsAuto=async auto=>{try{await api('/skills','PATCH',{auto});await showSkills()}catch(error){toast(error.message,'error')}};
window.toggleSharedSkill=async(id,enabled)=>{try{await api('/skills/'+encodeURIComponent(id),'PATCH',{enabled});await showSkills()}catch(error){toast(error.message,'error')}};
window.deleteSharedSkill=async id=>{try{await api('/skills/'+encodeURIComponent(id),'DELETE');await showSkills();toast('Скилл убран из общего списка')}catch(error){toast(error.message,'error')}};
window.scanSkillsDevice=async()=>{if(isPhoneClient)return;try{toast('Читаю скиллы…');await api('/skills/scan','POST',{deviceId});await showSkills()}catch(error){toast(error.message,'error')}};
window.uploadSkillFolder=()=>{if(isPhoneClient)return toast('Добавляй новые скиллы на Mac; здесь доступен их выбор и использование.');const picker=$('#skill-folder-picker');if(!picker)return;picker.onchange=async()=>{const selected=[...picker.files];picker.value='';if(!selected.length)return;try{if(selected.length>1500||selected.reduce((n,f)=>n+f.size,0)>24*1024*1024)throw new Error('Папка скилла должна быть не больше 24 МБ и 1500 файлов.');const prefix=selected[0].webkitRelativePath.split('/')[0]+'/';if(!selected.some(f=>f.webkitRelativePath.slice(prefix.length)==='SKILL.md'))throw new Error('Выбери папку, в которой находится SKILL.md.');toast('Загружаю скилл вместе с ресурсами…');const files=[];for(const f of selected){const bytes=new Uint8Array(await f.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));files.push({path:f.webkitRelativePath.slice(prefix.length),content:btoa(binary)});}await api('/skills/import','POST',{name:prefix.slice(0,-1),files});await showSkills();toast('Скилл сохранён для обоих провайдеров и компьютеров');}catch(error){toast(error.message,'error')}};picker.click();};

window.showPermissions=()=>{
 const mode=chosenPermission(),id=chat?.id,p=provider,d=deviceId,subscription=selectedAccountId(d,p),model=selectedModel,power=effort,account=state.me.id;
 const device=state.devices.find(item=>item.id===d);
 dialog('Разрешения · '+providerName(p),`<p>Выбранный режим действует со следующего запроса в этом чате.</p><div class="permission-connection"><p id="permission-device-state" role="status"></p><button type="button" id="permission-refresh">Проверить подключение</button></div><form id="permission-form"><div class="form-row"><label for="permission-mode">Режим</label><select id="permission-mode" name="mode"><option value="manual" ${mode==='manual'?'selected':''}>Ручные подтверждения</option><option value="auto" ${mode==='auto'?'selected':''}>Одобрять за меня</option><option value="full" ${mode==='full'?'selected':''}>Полный доступ · Bypass permissions</option></select></div><p class="muted">«Одобрять за меня» использует проверку действий провайдером. Доступность авто режима Claude зависит от модели и настроек аккаунта.</p><p class="muted">Полный доступ разрешает команды и изменение файлов, в том числе вне проекта, без обычных запросов подтверждения. Вопросы по самой задаче остаются.</p><div id="permission-feedback" class="form-feedback" role="status" aria-live="polite" hidden></div><div class="modal-buttons"><button type="button" onclick="closeDialog()">Отмена</button><button type="submit" class="primary-button">Сохранить</button></div></form>`);
 const form=$('#permission-form'),hint=$('#permission-device-state'),refresh=$('#permission-refresh'),feedback=$('#permission-feedback'),button=form.querySelector('button.primary-button'),select=form.elements.mode;
 let deviceRead,saving=false,uncertain=false;
 const isCurrent=()=>$('#dialog').open&&$('#permission-form')===form&&state?.me.id===account;
 const report=(text,kind='notice')=>{if(!isCurrent())return;feedback.hidden=!text;feedback.dataset.kind=kind;feedback.setAttribute('role',kind==='error'?'alert':'status');feedback.textContent=text;if(text)feedback.scrollIntoView({block:'nearest'});};
 const describe=current=>!current?'Компьютер не найден. Выбери его в списке компьютеров.':current.maintenance?'Подключение '+current.name+' сейчас обновляется. Повтори проверку после завершения.':!current.online?'Компьютер '+current.name+' сейчас не в сети. Дождись подключения.':current.permissionsVersion===1?'На '+current.name+' режимы разрешений доступны'+(current.connectorVersion?' · подключение '+current.connectorVersion:'')+'.':'На '+current.name+' работает старое фоновое подключение'+(current.connectorVersion?' '+current.connectorVersion:'')+'. Именно на этом Mac открой «Этот Mac → Обновить подключение».';
 const readDevice=()=>{
  if(deviceRead)return deviceRead;
  deviceRead=api('/devices','GET',undefined,{timeoutMs:8000}).then(latest=>{
   if(!state||state.me.id!==account)throw new Error('Аккаунт изменился. Открой настройки разрешений заново.');
   state.devices=latest.devices;renderDevicesPicker();renderStatus();const current=latest.devices.find(item=>item.id===d);if(isCurrent())hint.textContent=describe(current);return current;
  }).finally(()=>{deviceRead=null});return deviceRead;
 };
 hint.textContent=describe(device);
 refresh.onclick=async()=>{refresh.disabled=true;hint.textContent='Проверяю подключение…';try{await readDevice()}catch(error){if(isCurrent())hint.textContent=error.name==='TimeoutError'||error.name==='AbortError'?'Не удалось быстро проверить подключение. Повтори проверку.':error.message}finally{if(isCurrent())refresh.disabled=saving}};
 select.onchange=()=>{if(!saving){uncertain=false;button.textContent='Сохранить';report('');}};
 const matches=(route,requested)=>route&&['provider','deviceId','accountId','permissionMode','model','effort'].every(key=>(route[key]||'')===(requested[key]||''));
 form.onsubmit=async e=>{
  e.preventDefault();if(saving||!isCurrent())return;
  const value=new FormData(form).get('mode'),requested={provider:p,deviceId:d,accountId:subscription,model,effort:power,permissionMode:value};saving=true;button.disabled=true;select.disabled=true;refresh.disabled=true;button.textContent=uncertain?'Проверяю сохранение…':'Сохраняю…';form.setAttribute('aria-busy','true');report(uncertain?'Проверяю, сохранился ли выбранный режим.':'Сохраняю выбранный режим…');
  let confirmed;
  try{
   // Reconcile uncertain saves before allowing another explicit submission.
   if(id&&uncertain){try{const latest=await api('/chats/'+id+'?view=compact&limit=1','GET',undefined,{timeoutMs:8000});if(matches(latest.pendingRoute||latest.route,requested))confirmed=latest;}catch{throw new Error('Сохранение пока не подтверждено. Проверь интернет и повтори проверку.');}}
   if(!confirmed){
    if(value!=='manual'){const current=await readDevice();if(!current?.online||current.maintenance||current.permissionsVersion!==1)throw new Error(describe(current));}
    if(!isCurrent())return;
    if(id){
     report('Сохраняю выбранный режим…');button.textContent='Сохраняю…';
     try{confirmed=await api('/chats/'+id+'/switch','POST',requested,{timeoutMs:15000});uncertain=false;}
     catch(error){
      if(error.status)throw error;
      uncertain=true;report('Ответ задерживается. Проверяю, сохранился ли режим…');button.textContent='Проверяю сохранение…';
      try{const latest=await api('/chats/'+id+'?view=compact&limit=1','GET',undefined,{timeoutMs:8000});if(matches(latest.pendingRoute||latest.route,requested)){confirmed=latest;uncertain=false;}}catch{}
      if(!confirmed)throw new Error('Не удалось подтвердить сохранение. Изменения могли сохраниться. Нажми «Проверить сохранение», когда связь восстановится.');
     }
    }
   }
   if(state?.me.id!==account)return;
   if(id&&chat?.id===id){if(confirmed?.route){chat.route=confirmed.route;chat.pendingRoute=confirmed.pendingRoute||null;}else if(chat.run)chat.pendingRoute={...chat.route,...requested};else chat.route={...chat.route,...requested};}
   roomLocalStorage.setItem('roomPermissions:'+account+':'+p,value);if(isCurrent())closeDialog();renderComposer();toast(chat?.id===id&&chat?.run?'Режим сохранён для следующего запроса. Текущая работа продолжается.':'Режим сохранён; применяется со следующего запроса.');
  }catch(error){report(error.name==='TimeoutError'||error.name==='AbortError'?'Проверка подключения заняла слишком много времени. Повтори попытку.':error.message,'error');}
  finally{saving=false;if(isCurrent()){button.disabled=false;select.disabled=false;refresh.disabled=Boolean(deviceRead);button.textContent=uncertain?'Проверить сохранение':'Сохранить';form.removeAttribute('aria-busy');}}
 };
 void refresh.onclick();
};

window.showDeleteChat=async()=>{
 if(!chat||!state)return;
 const id=chat.id,read=beginDialogRead('Удалить сессию?'),account=read.account;
 try{
  const preview=await api('/chats/'+id+'/deletion-preview','GET',undefined,{timeoutMs:12000,signal:read.controller.signal});if(!currentDialogRead(read))return;
  dialog('Удалить сессию?',`<p><strong>${esc(preview.title)}</strong></p><p>Будут удалены ${preview.messages} записей чата и ${preview.memories} связанных записей памяти. Исходная сессия в Claude/Codex сохранится.</p><label><input type="checkbox" id="delete-chat-files" checked> Удалить ${preview.files.length} файлов, относящихся только к этой сессии</label>${preview.files.length?`<details><summary>Какие файлы</summary>${preview.files.map(p=>`<p class="muted">${esc(p)}</p>`).join('')}</details>`:''}<p class="muted">Другие работающие чаты продолжат свои задачи. Их файлы, общие и изменённые файлы сохранятся. При следующем запросе контекст остальных чатов будет восстановлен без удалённой сессии.</p><div class="modal-buttons"><button onclick="closeDialog()">Отмена</button><button id="delete-chat-confirm" class="primary-button">Удалить сессию</button></div>`);
  const button=$('#delete-chat-confirm'),fileOption=$('#delete-chat-files'),isCurrent=()=>state?.me.id===account&&$('#dialog').open&&$('#delete-chat-confirm')===button;
  button.onclick=async()=>{
   if(!isCurrent()||button.disabled)return;button.disabled=true;button.textContent='Удаляю…';
   try{
    await api('/chats/'+id,'DELETE',{revision:preview.revision,previewToken:preview.token,files:fileOption.checked,confirmation:id});if(state?.me.id!==account)return;
    chatCache.delete(id);for(const key of chatLoads.keys())if(key.startsWith(id+':'))chatLoads.delete(key);dirtyChats.delete(id);for(const [key,value]of pendingSends)if(value.chatId===id)pendingSends.delete(key);try{roomSessionStorage.removeItem('roomPreview:'+account);roomSessionStorage.removeItem('roomScroll:'+account+':'+id)}catch{}
    const ownDialog=isCurrent();if(ownDialog)closeDialog();if(selectedId===id)newChat();void refreshState();if(ownDialog)toast('Сессия и связанная память удалены.');
   }catch(error){if(isCurrent()){dialogFeedback(error.message,'error');button.disabled=false;button.textContent='Удалить сессию';}}
  };
 }catch(error){if(currentDialogRead(read))dialogFeedback(error.message,'error');}
};

window.newSidebarChat=()=>{if(expandedProjectId&&expandedProjectId!==projectId)void selectProject(expandedProjectId);else newChat();};
window.toggleProject=async id=>{
 if(expandedProjectId===id){expandedProjectId='';renderChatList();return;}
 const keepSidebar=$('.app')?.classList.contains('sidebar-open');expandedProjectId=id;
 // Browsing another project's sessions must preserve the conversation being read or dragged beside it.
 if(!isEmbeddedPane&&innerWidth>1000){renderChatList();return;}
 if(projectId!==id){await selectProject(id);if(keepSidebar&&compactScreen.matches){toggleSidebar();sidebarReturnFocus=$('.mobile-menu');$('#sidebar')?.querySelector(`[data-project-toggle="${CSS.escape(id)}"]`)?.focus({preventScroll:true});}}else renderChatList();
};
window.toggleArchivedProjects=()=>{showArchivedProjects=!showArchivedProjects;renderChatList();};
window.setProjectArchived=async(id,archived)=>{
 try{await api('/projects/'+encodeURIComponent(id)+'/archive','POST',{archived});closeDialog();if(archived)showArchivedProjects=false;state=await api('/state');if(archived&&projectId===id){const next=state.projects.find(p=>!p.archivedAt);if(next)await selectProject(next.id);else showArchivedProjects=true;}else if(archived&&expandedProjectId===id)expandedProjectId='';renderChatList();renderStatus();toast(archived?'Проект перенесён в архив':'Проект восстановлен');}catch(error){dialogFeedback(error.message,'error');}
};
window.showRenameProject=id=>{
 const project=state?.projects.find(p=>p.id===id);if(!project||!state.me.owner)return;const account=state.me.id;
 dialog('Переименовать проект',`<form id="rename-project-form"><div class="form-row"><label for="rename-project-name">Название проекта</label><input id="rename-project-name" name="name" required maxlength="80" value="${esc(project.name)}"></div><div class="modal-buttons"><button type="button" onclick="closeDialog()">Отмена</button><button class="primary-button" type="submit">Сохранить</button></div></form>`);
 const form=$('#rename-project-form'),input=$('#rename-project-name'),button=form.querySelector('[type="submit"]');let saving=false;
 input.focus({preventScroll:true});input.select();
 form.onsubmit=async event=>{
  event.preventDefault();if(saving||!input.value.trim())return;saving=true;button.disabled=true;input.disabled=true;button.textContent='Сохраняю…';
  const isCurrent=()=>state?.me.id===account&&$('#dialog').open&&$('#rename-project-form')===form;
  try{await api('/projects/'+encodeURIComponent(id),'PATCH',{name:input.value});if(state?.me.id!==account)return;if(isCurrent())closeDialog();await refreshState();toast('Проект переименован');}
  catch(error){if(isCurrent())dialogFeedback(error.message,'error');}
  finally{saving=false;if(isCurrent()){button.disabled=false;input.disabled=false;button.textContent='Сохранить';}}
 };
};
window.showProjectMenu=id=>{const project=state.projects.find(p=>p.id===id);if(!project)return;dialog(project.name,`<p>${project.archivedAt?'Проект в архиве. Сессии, файлы и память сохранены.':'Чаты, память и файлы этого проекта доступны на всех подключённых компьютерах.'}</p><div class="modal-buttons"><button onclick="closeDialog();selectProject(${jsArg(id)})">Открыть проект</button>${state.me.owner?`<button onclick="showRenameProject(${jsArg(id)})">Переименовать проект</button><button onclick="setProjectArchived(${jsArg(id)},${!project.archivedAt})">${project.archivedAt?'Восстановить проект':'Архивировать проект'}</button><button class="danger-button" onclick="showDeleteProject(${jsArg(id)})">Удалить проект</button>`:''}</div>`)};
window.showDeleteProject=async id=>{
 if(!state)return;const read=beginDialogRead('Удалить проект?'),account=read.account;
 try{
  const preview=await api('/projects/'+id+'/deletion-preview','GET',undefined,{timeoutMs:12000,signal:read.controller.signal});if(!currentDialogRead(read))return;
  dialog('Удалить проект?',`<p><strong>${esc(preview.title)}</strong></p><p>Будут удалены ${preview.chats} сессий (${preview.messages} сообщений), ${preview.memories} записей памяти, ${preview.tasks} задач и ${preview.files} файлов (${fmtBytes(preview.bytes)}) из общего пространства.</p><p>Исходные сессии Claude/Codex и их исходные папки на компьютерах сохранятся. Удаление затронет всех участников пространства.</p>${state.projects.length===1?'<p>Вместо последнего проекта появится пустой «Мой проект».</p>':''}<form id="delete-project-form"><div class="form-row"><label for="delete-project-name">Введи название проекта для подтверждения</label><input id="delete-project-name" name="name" required autocomplete="off" placeholder="${esc(preview.title)}"></div><div class="modal-buttons"><button type="button" onclick="closeDialog()">Отмена</button><button id="delete-project-confirm" class="danger-button" disabled>Удалить проект</button></div></form>`);
  const form=$('#delete-project-form'),input=$('#delete-project-name'),button=$('#delete-project-confirm'),isCurrent=()=>state?.me.id===account&&$('#dialog').open&&$('#delete-project-form')===form;let committed=false,saving=false;
  input.oninput=()=>{if(!saving&&!committed)button.disabled=input.value!==preview.title};
  form.onsubmit=async event=>{
   event.preventDefault();if(!isCurrent()||saving||committed||input.value!==preview.title)return;saving=true;button.disabled=true;input.disabled=true;button.textContent='Удаляю…';
   try{
    const removedIds=state.chats.filter(c=>c.projectId===id).map(c=>c.id),name=input.value;
    const result=await api('/projects/'+id,'DELETE',{confirmation:id,name,previewToken:preview.token});committed=true;if(state?.me.id!==account)return;
    for(const chatId of removedIds){chatCache.delete(chatId);dirtyChats.delete(chatId);try{roomSessionStorage.removeItem('roomScroll:'+account+':'+chatId)}catch{}}
    for(const [key,value]of pendingSends)if(removedIds.includes(value.chatId))pendingSends.delete(key);try{roomSessionStorage.removeItem('roomPreview:'+account)}catch{}
    const latest=await api('/state','GET',undefined,{timeoutMs:12000});if(state?.me.id!==account)return;state=latest;
    const ownDialog=isCurrent();if(ownDialog)closeDialog();
    if(projectId===id){projectId=result.replacementProjectId;expandedProjectId=projectId;selectedId='';chat=null;chatOpenGeneration++;cancelChatReads();cancelProjectFileReads();chatLoading=false;files=[];filesProjectId=null;attachments=[];rememberView();renderShell();}else renderChatList();
    if(ownDialog)toast('Проект, его сессии, память и файлы удалены.');
   }catch(error){if(isCurrent()){dialogFeedback(committed?'Проект удалён. Не удалось обновить список: '+error.message:error.message,committed?'notice':'error');button.textContent=committed?'Проект удалён':'Удалить проект';button.disabled=committed||input.value!==preview.title;input.disabled=committed;}}
   finally{saving=false;}
  };
 }catch(error){if(currentDialogRead(read))dialogFeedback(error.message,'error');}
};

async function moveSession(id,targetProject,preview,fromDialog=false){
 if(movingChats.has(id)||archivingChats.has(id))return;
 const account=state.me.id,generation=chatOpenGeneration;let committed=false;
 movingChats.set(id,targetProject);renderChatList();renderComposer();
 try{
  preview||=await api('/chats/'+id+'/move-preview?project='+encodeURIComponent(targetProject));
  const result=await api('/chats/'+id+'/move','POST',{projectId:targetProject,revision:preview.revision,previewToken:preview.token,confirmation:id});committed=true;
  if(state?.me.id!==account)return;
  chatCache.delete(id);dirtyChats.add(id);for(const key of chatLoads.keys())if(key.startsWith(id+':'))chatLoads.delete(key);
  try{roomSessionStorage.removeItem('roomPreview:'+account)}catch{}
  const summary=state.chats.find(c=>c.id===id);if(summary)summary.projectId=result.projectId;
  if(fromDialog&&$('#move-chat-form')?.isConnected)closeDialog();
  if(selectedId===id&&generation===chatOpenGeneration)expandedProjectId=result.projectId;
  if(selectedId===id){
   projectId=result.projectId;files=[];filesProjectId=null;attachments=attachments.map(a=>({...a,path:result.mapping?.[a.path]||a.path}));
   if(chat?.id===id){chat.projectId=result.projectId;chat.providerSessions={};}
   chatOpenGeneration++;chatLoading=false;chatLoadError='';rememberView();const picker=$('#project-picker');if(picker)picker.value=projectId;renderAttachments();void refreshFiles();
  }
  toast('Сессия перенесена. История, память и файлы сохранены.');await refreshState();
 }catch(error){if(committed){toast('Перенос сохранён. Обнови список сессий, когда связь восстановится.');void refreshState();}else throw error;}
 finally{movingChats.delete(id);renderChatList();if(state)renderComposer();}
}
async function dropChatInProject(id,target){try{if(!movableChat(id))throw new Error('Эта сессия сейчас занята. Дождись завершения работы.');await moveSession(id,target);}catch(error){toast(error.message,'error');}}
window.showSessionMenu=id=>{
 const c=state?.chats.find(c=>c.id===id);if(!c)return;
 const busy=Boolean(c.run||movingChats.has(id)||archivingChats.has(id)),owned=state.me.owner||c.owner===state.me.name;
 const primary=`<div class="session-action-grid">
 ${sessionMenuAction('open','Открыть',`closeDialog();openChat(${jsArg(id)})`)}
 ${!isEmbeddedPane&&innerWidth>1000?sessionMenuAction('open','Открыть справа',`openSessionRight(${jsArg(id)})`):''}
 ${sessionMenuAction('move','Перенести',`openSessionMove(${jsArg(id)})`,{disabled:busy||!owned})}
 ${sessionMenuAction(c.archivedAt?'restore':'archive',c.archivedAt?'Восстановить':'В архив',`setSessionArchived(${jsArg(id)},${!c.archivedAt})`,{disabled:busy||!owned})}
 ${sessionMenuAction('download','Скачать историю','',{href:'/api/chats/'+encodeURIComponent(id)+'/export'})}
 </div>`;
 sessionMenuDialog('Действия с сессией',c.title,primary);
};
window.openSessionMove=async id=>{closeDialog();await openChat(id);if(chat?.id===id)showMoveChat();};
window.setSessionArchived=async(id,archived,confirmed=false)=>{
 if(archived&&!confirmed){const c=state?.chats.find(c=>c.id===id);if(!c)return;if(c.run){toast('Дождись завершения работы перед архивированием.');return;}dialog('Архивировать сессию?',`<p><strong>${esc(c.title)}</strong></p><p>Сессия исчезнет из обычного списка и с доски. История и файлы сохранятся; восстановление доступно в архиве.</p><div class="modal-buttons"><button onclick="closeDialog()">Отмена</button><button class="primary-button" onclick="setSessionArchived(${jsArg(id)},true,true)">Архивировать</button></div>`);return;}
 if(archivingChats.has(id)||movingChats.has(id))return;
 const account=state?.me.id;archivingChats.add(id);renderChatList();renderComposer();
 try{
  const result=await api('/chats/'+id+'/archive','POST',{archived});if(state?.me.id!==account)return;
  chatCache.delete(id);dirtyChats.add(id);for(const key of chatLoads.keys())if(key.startsWith(id+':'))chatLoads.delete(key);try{roomSessionStorage.removeItem('roomPreview:'+account)}catch{}
  const c=state.chats.find(c=>c.id===id);if(c)c.archivedAt=result.archivedAt;
  if(chat?.id===id)chat.archivedAt=result.archivedAt;
  if(archived){archiveProjectId=selectedId===id?result.projectId:'';}else if(selectedId===id){archiveProjectId=result.projectId;expandedProjectId=result.projectId;}
  closeDialog();renderChatList();renderComposer();toast(archived?'Сессия в архиве. Её можно восстановить.':'Сессия восстановлена.');await refreshState();
 }catch(error){toast(error.message,'error');}finally{archivingChats.delete(id);renderChatList();if(state)renderComposer();}
};
window.showMoveChat=()=>{
 if(!chat)return;const id=chat.id,sourceProject=chat.projectId,targets=state.projects.filter(p=>p.id!==sourceProject);
 if(!targets.length){dialog('Перенести сессию',`<p>Сначала создай ещё один проект.</p><button class="primary-button" onclick="closeDialog();selectProject('new')">Создать проект</button>`);return;}
 dialog('Перенести в другой проект',`<p><strong>${esc(chat.title)}</strong></p><p>История, память и задачи этой сессии перейдут в выбранный проект. Сохранённые рабочие файлы исходного проекта скопируются вместе, чтобы сохранить зависимости. Общие записи памяти других сессий останутся в исходном проекте.</p><form id="move-chat-form"><div class="form-row"><label for="move-chat-project">Проект назначения</label><select id="move-chat-project">${targets.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></div><p id="move-chat-details" role="status">Проверяю файлы…</p><div class="modal-buttons"><button type="button" onclick="closeDialog()">Отмена</button><button id="move-chat-confirm" class="primary-button" disabled>Перенести сессию</button></div></form>`);
 const form=$('#move-chat-form'),select=$('#move-chat-project'),button=$('#move-chat-confirm'),details=$('#move-chat-details');let preview=null,nonce=0;
 const update=async()=>{const n=++nonce;preview=null;button.disabled=true;details.textContent='Проверяю файлы…';try{const result=await api('/chats/'+id+'/move-preview?project='+encodeURIComponent(select.value));if(!form.isConnected||n!==nonce)return;preview={...result,projectId:select.value};details.textContent=`${result.files} файлов, ${result.memories} записей памяти и ${result.tasks} задач.${result.conflicts?' Есть совпадающие имена: обе версии сохранятся в отдельной папке.':''} Исходные файлы останутся на месте.`;button.disabled=false;}catch(error){if(form.isConnected&&n===nonce)details.textContent=error.message;}};
 select.onchange=update;void update();
 form.onsubmit=async event=>{event.preventDefault();if(!preview||preview.projectId!==select.value)return;button.disabled=true;select.disabled=true;button.textContent='Переношу…';try{
  await moveSession(id,select.value,preview,true);
 }catch(error){toast(error.message,'error');button.textContent='Перенести сессию';select.disabled=false;void update();}};
};
