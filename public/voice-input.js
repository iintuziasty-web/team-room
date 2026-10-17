// Dictation adds editable text only. It never sends a model request or audio
// through Team Room; the browser selects its platform recognition service.
export class Dictation {
 constructor({input,context,change,state,notice}){Object.assign(this,{input,context,change,state,notice});this.session=null;}
 get active(){return Boolean(this.session);}
 get finishing(){return Boolean(this.session?.finishing);}
 get supported(){return Boolean(window.SpeechRecognition||window.webkitSpeechRecognition);}
 start(language='ru-RU'){
  if(this.active)return this.finish();
  const Constructor=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!Constructor){this.notice('Голосовой ввод здесь недоступен. Используй микрофон на клавиатуре телефона.');return;}
  const input=this.input();if(!input)return;
  const start=input.selectionStart??input.value.length,end=input.selectionEnd??start;
  const recognition=new Constructor(),session={recognition,input,context:this.context(),before:input.value.slice(0,start),after:input.value.slice(end),value:input.value,parts:new Map(),language,finishing:false};
  session.done=new Promise(resolve=>session.resolve=resolve);this.session=session;
  recognition.lang=language;recognition.continuous=true;recognition.interimResults=true;recognition.maxAlternatives=1;
  recognition.onresult=event=>{
   if(this.session!==session)return;
   if(this.input()!==input||this.context()!==session.context||input.value!==session.value){this.cancel();return;}
   for(let i=event.resultIndex;i<event.results.length;i++)session.parts.set(i,event.results[i][0].transcript);
   const words=[...session.parts.entries()].sort((a,b)=>a[0]-b[0]).map(([,text])=>text.trim()).filter(Boolean).join(' ');
   const left=words&&session.before&&!/\s$/.test(session.before)?' ':'';
   const right=words&&session.after&&!/^\s/.test(session.after)?' ':'';
   input.value=session.value=session.before+left+words+right+session.after;
   this.change(input.value);
  };
  recognition.onerror=event=>{
   if(this.session!==session)return;
   const messages={'not-allowed':'Разреши доступ к микрофону для Team Room в настройках Safari.','service-not-allowed':'Распознавание речи недоступно. Проверь, включена ли «Диктовка» или Siri на телефоне.','language-not-supported':'Этот язык недоступен для голосового ввода на устройстве. Выбери другой в настройках.','audio-capture':'Не удалось включить микрофон. Проверь, не использует ли его другое приложение.','network':'Нет связи со службой распознавания. Уже записанный текст сохранён.','no-speech':'Не услышал речь. Нажми микрофон и попробуй снова.'};
   if(event.error!=='aborted')this.notice(messages[event.error]||'Не удалось распознать речь. Текст в поле сохранён.');
   this.cancel();
  };
  recognition.onend=()=>this.complete(session);
  this.state();
  try{recognition.start();session.timer=setTimeout(()=>this.finish(),120000);}catch{this.cancel();this.notice('Не удалось начать голосовой ввод. Попробуй микрофон клавиатуры телефона.');}
 }
 complete(session){
  clearTimeout(session.timer);clearTimeout(session.settle);session.resolve();
  if(this.session===session){this.session=null;this.state();}
 }
 finish(){
  const session=this.session;if(!session)return Promise.resolve();
  if(!session.finishing){session.finishing=true;clearTimeout(session.timer);this.state();session.settle=setTimeout(()=>{if(this.session===session)this.cancel();},2000);try{session.recognition.stop();}catch{this.cancel();}}
  return session.done;
 }
 cancel(){const session=this.session;if(!session)return;this.session=null;try{session.recognition.abort();}catch{}this.complete(session);this.state();}
}
