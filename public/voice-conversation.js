import {DraftRecording} from './voice-recording.js';
// Push-to-talk voice conversation. Independent recorded audio is transcribed on
// the chosen computer; speech synthesis on the phone speaks the existing reply.
export class VoiceConversation {
 constructor({context,transcribe,text,state,notice}){Object.assign(this,{context,transcribe,text,state,notice});this.mode='idle';this.generation=0;this.recording=null;this.textValue='';this.speechId=0;}
 get active(){return this.mode!=='idle';}
 get supported(){return window.isSecureContext&&Boolean(navigator.mediaDevices?.getUserMedia&&window.AudioContext&&window.AudioWorkletNode);}
 currentContext(generation,context){if(generation!==this.generation)return false;if(this.context()!==context){this.cancel();return false;}return true;}
 async start(){
  if(!this.supported)throw new Error('Диктовка недоступна. Открой Team Room в Safari через HTTPS.');
  this.cancel();this.outgoing=null;const generation=++this.generation,context=this.context();this.boundContext=context;this.mode='permission';this.state();
  const session={generation,context,committed:0,previewText:'',stopped:false,previewBusy:false};
  session.capture=new DraftRecording({data:()=>{if(session.generation===this.generation&&!session.stopped)void this.preview(session)},ended:()=>void this.finishRecording(session)});this.recording=session;
  try{await session.capture.start();if(!this.currentContext(generation,context)){session.capture.cancel();return;}if(!session.stopped){this.mode='recording';this.state();}}
  catch(error){if(!this.currentContext(generation,context))return;this.recording=null;this.mode='idle';this.state();throw new Error(error.name==='NotAllowedError'?'Разреши микрофон для Team Room в настройках Safari.':'Не удалось включить диктовку. Повтори попытку.');}
 }
 async preview(session){
  if(!this.currentContext(session.generation,session.context))return;
  if(session.previewBusy||session.stopped||Date.now()<(session.nextPreviewAt||0)||session.capture.length-session.committed<16000*8)return;
  session.previewBusy=true;session.nextPreviewAt=Date.now()+8000;const end=session.capture.length,blob=session.capture.wav(session.committed,end),abort=new AbortController();session.abort=abort;
  session.previewTask=(async()=>{
   try{const result=await this.transcribe(blob,session.context,abort.signal);if(!this.currentContext(session.generation,session.context))return;
    session.committed=end;if(result.text){session.previewText=(session.previewText+' '+result.text).trim();this.recognizedText=session.previewText;this.textValue=session.previewText;this.text(this.textValue,{partial:true});}
   }catch(error){if(this.currentContext(session.generation,session.context)&&error.name!=='AbortError'&&!session.previewNotice){session.nextPreviewAt=Date.now()+10000;session.previewNotice=true;this.notice('Промежуточное распознавание задерживается. Итоговый текст появится после остановки.');}}
   finally{session.previewBusy=false;}
  })();await session.previewTask;
 }
 stop(){const session=this.recording;if(this.mode!=='recording'||!session)return;this.mode='transcribing';this.state();session.capture.stop();}
 async finishRecording(session){
  if(session.stopped)return;session.stopped=true;session.capture.release();
  if(!this.currentContext(session.generation,session.context)){session.capture.cancel();return;}
  this.mode='transcribing';this.state();
  // Finish the in-flight preview before the final request: each Mac recognizes
  // only one recording at a time. Re-read the complete utterance for accurate
  // punctuation and words crossing preview boundaries; replace, never append it.
  await session.previewTask;
  if(!this.currentContext(session.generation,session.context)){session.capture.cancel();return;}
  this.recording=null;const blob=session.capture.wav();session.capture.cancel();
  if(blob.size<3244){this.mode=this.textValue?'review':'idle';this.state();this.notice('Запись слишком короткая. Попробуй ещё раз.');return;}
  await this.recognizeFinal(blob,session.context,session.generation);
 }
 async recognizeFinal(blob,context,generation){
  if(!this.currentContext(generation,context))return;
  this.audio=blob;this.abort=new AbortController();
  try{const result=await this.transcribe(blob,context,this.abort.signal);if(!this.currentContext(generation,context))return;this.audio=null;this.textValue=result.text||this.recognizedText||'';this.mode=this.textValue?'review':'idle';if(this.textValue)this.text(this.textValue,{partial:false});else this.notice('Речь не распознана. Попробуй говорить ближе к микрофону.');this.state();}
  catch(error){if(!this.currentContext(generation,context)||error.name==='AbortError')return;this.mode='retry';this.state();this.notice(error.message);}
 }
 async retry(){if(!this.audio)return;this.mode='transcribing';this.state();return this.recognizeFinal(this.audio,this.boundContext,this.generation);}
 wait(chatId,messageId){this.waiting={chatId,messageId};this.mode='waiting';this.state();}
 reply(chat){
  if(this.mode!=='waiting'||chat?.id!==this.waiting?.chatId)return;
  if(chat.approvals?.length){this.mode='review';this.state();this.notice('В чате вопрос или запрос разрешения. Ответь там, затем продолжи голосом.');return;}
  const index=chat.messages.findIndex(m=>m.id===this.waiting.messageId);if(index<0||chat.run)return;
  const message=chat.messages.slice(index+1).findLast(m=>m.role==='assistant');if(!message)return;
  if(message.status==='completed'&&message.text)this.speak(message.text);else if(['failed','interrupted'].includes(message.status)){this.mode='review';this.state();this.notice('Открой сообщение в чате: работа требует внимания.');}
 }
 speak(raw){
  if(!window.speechSynthesis){this.mode='review';this.state();this.notice('Озвучивание недоступно на этом телефоне. Ответ сохранён в чате.');return;}
  const speechId=++this.speechId;clearTimeout(this.speechTimer);this.speechTimer=null;speechSynthesis.cancel();this.mode='speaking';this.state();
  const text=String(raw).replace(/```[\s\S]*?```/g,' Код доступен в чате. ').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/https?:\/\/\S+/g,'ссылка в чате').replace(/[#*_`|]/g,' ').trim().slice(0,16000);
  const lang=this.language||'ru-RU',voices=speechSynthesis.getVoices(),preferred=voices.find(v=>v.name===this.voiceName&&v.lang.startsWith(lang.slice(0,2)))||voices.find(v=>v.lang.startsWith(lang.slice(0,2)));
  const chunks=text.match(/.{1,350}(?:[.!?]\s|$)|.{1,350}(?:\s|$)/g)||[text];let index=0;const generation=this.generation;
  const next=()=>{
   if(generation!==this.generation||speechId!==this.speechId||this.mode!=='speaking')return;
   if(index>=chunks.length){this.utterance=null;this.mode='review';this.state();return;}
   const utterance=new SpeechSynthesisUtterance(chunks[index++]);utterance.lang=lang;if(preferred)utterance.voice=preferred;utterance.rate=1;this.utterance=utterance;let timer;
   const current=()=>generation===this.generation&&speechId===this.speechId&&this.mode==='speaking'&&this.utterance===utterance;
   const clearOwnTimer=()=>{clearTimeout(timer);if(this.speechTimer===timer)this.speechTimer=null;timer=null;};
   const blocked=()=>{if(!current())return;clearOwnTimer();this.stopSpeaking();this.notice('Нажми «Озвучить», чтобы прослушать ответ.');};
   const armTimer=duration=>{clearOwnTimer();timer=setTimeout(blocked,duration);this.speechTimer=timer;};
   armTimer(4000);
   utterance.onstart=()=>{if(current())armTimer(60000);};
   utterance.onend=()=>{if(!current())return;clearOwnTimer();next();};
   utterance.onerror=()=>{if(!current())return;clearOwnTimer();blocked();};
   try{speechSynthesis.speak(utterance);}catch{blocked();}
  };next();
 }
 stopSpeaking(){this.speechId++;clearTimeout(this.speechTimer);this.speechTimer=null;this.utterance=null;if(this.mode==='speaking'){this.mode='review';this.state();}window.speechSynthesis?.cancel();}
 cancel(){this.generation++;this.speechId++;clearTimeout(this.speechTimer);this.speechTimer=null;this.utterance=null;this.abort?.abort();const session=this.recording;this.recording=null;if(session){session.abort?.abort();session.capture.cancel();}window.speechSynthesis?.cancel();this.audio=null;this.waiting=null;this.mode='idle';this.textValue='';this.recognizedText='';this.state();}
}
