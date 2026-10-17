'use strict';
const $=selector=>document.querySelector(selector),demo=$('#demo');
const motion=window.matchMedia('(prefers-reduced-motion: reduce)');
const phases=[{mode:'provider',second:false,label:'Claude готовит результат'},{mode:'provider',second:true,label:'Продолжаем с Codex'},{mode:'device',second:false,label:'Работа на выбранном Mac'},{mode:'device',second:true,label:'Продолжение на другом Mac'},{mode:'board',second:false,label:'Все задачи перед глазами'}];
const firstAnswer='Готов первый вариант. Сохранил структуру страницы, выбранный заголовок и заметки для продолжения.';
const nextAnswer='Продолжаю с сохранённой структуры. Сейчас адаптирую первый экран для телефона; готовые файлы остаются в этом проекте.';
const captions={provider:'Демонстрация на вымышленных данных. Нажмите на провайдера в поле ввода, чтобы сменить его.',device:'Тот же разговор, другой выполняющий компьютер. Файлы и сохранённые решения остаются с задачей.',board:'Личная доска показывает работу, вопросы и готовые результаты ваших сессий.'};
let current=0,generation=0,visible=false,paused=motion.matches;
const timers=new Set();
function later(fn,ms){const token=generation;const timer=setTimeout(()=>{timers.delete(timer);if(token===generation)fn();},ms);timers.add(timer);}
function cancel(){generation++;for(const timer of timers)clearTimeout(timer);timers.clear();demo.classList.remove('transferring','file-saved');$('#demo-answer').classList.remove('typing');$('#demo-switch').disabled=false;const bar=$('#sequence-progress');bar.style.transition='none';bar.style.transform='scaleX(0)';}
function active(){return visible&&!document.hidden&&!paused;}
function playback(){
 const running=active();document.body.classList.toggle('motion-paused',paused||document.hidden);
 const button=$('#motion-toggle');button.textContent=paused?'▶':'Ⅱ';button.setAttribute('aria-pressed',String(paused));button.setAttribute('aria-label',paused?'Включить демонстрацию':'Приостановить демонстрацию');
 $('#sequence-label').textContent=paused?'На паузе':phases[current].label;
 return running;
}
function type(text){
 const node=$('#demo-answer');if(motion.matches||!active()){node.textContent=text;return;}
 const characters=Array.from(text);let at=0;node.textContent='';node.classList.add('typing');
 function chunk(){at=Math.min(characters.length,at+3);node.textContent=characters.slice(0,at).join('');if(at<characters.length)later(chunk,30);else{node.classList.remove('typing');demo.classList.add('file-saved');}}
 chunk();
}
function render(animate=false){
 const phase=phases[current],{mode,second}=phase;demo.dataset.mode=mode;
 $('#messages').hidden=mode==='board';$('#demo-board').hidden=mode!=='board';
 for(const item of document.querySelectorAll('[data-scenario]')){const selected=item.dataset.scenario===mode;item.classList.toggle('selected',selected);item.setAttribute('aria-pressed',String(selected));}
 const codex=(second&&mode==='provider')||mode==='device';const provider=codex?'Codex':'Claude';
 $('#provider-name').textContent=provider;$('#provider-icon').textContent=codex?'↔':'C';$('#provider-icon').classList.toggle('codex',codex);
 $('#machine-name').textContent=second&&mode==='device'?'Домашний Mac':'Рабочий Mac';
 const modelLabel=mode==='device'?(second?'Домашний Mac':'Рабочий Mac'):provider;
 $('#demo-switch').replaceChildren(document.createTextNode(modelLabel+' '),Object.assign(document.createElement('span'),{textContent:'⌄'}));
 $('#demo-switch').setAttribute('aria-label',mode==='device'?'Демонстрация: сменить компьютер':'Демонстрация: сменить провайдера');
 $('#demo-caption').textContent=captions[mode];
 $('#demo-prompt').textContent=mode==='device'?'Продолжим здесь. Открой тот же проект…':'Продолжи с мобильной версией страницы…';
 $('#agent-task').textContent=second?'Мобильная адаптация':'Структура страницы';$('#agent-result').textContent=second?'Компоненты сохранены':'Тексты и компоненты';
 function finish(){
  demo.classList.remove('transferring');$('#demo-switch').disabled=false;
  $('#handoff-title').textContent=second?'Продолжение готово':'Контекст сохранён';$('#handoff-detail').textContent=second?'История, решения и рабочий файл доступны в этой сессии':'Задача, решения и файлы доступны для продолжения';
  $('#activity-text').textContent=mode==='board'?'1 задача в работе · 1 вопрос · 1 ответ готов':provider+' работает · '+(second?'адаптирует страницу':'сохраняет результат');
  if(mode!=='board'){const text=second?nextAnswer:firstAnswer;if(animate)type(text);else $('#demo-answer').textContent=text;}
 }
 if(animate&&second&&mode!=='board'&&!motion.matches){
  demo.classList.add('transferring');$('#demo-switch').disabled=true;$('#demo-answer').textContent=firstAnswer;
  $('#handoff-title').textContent=mode==='device'?'Передаём рабочие файлы':'Сохраняем контекст для продолжения';$('#handoff-detail').textContent='Задача, решения, история и файлы';$('#activity-text').textContent=mode==='device'?'Подготавливаем другой компьютер…':'Переключаем провайдера…';later(finish,1550);
 }else finish();
 playback();
}
function start(index=current,animate=true){
 cancel();current=(index+phases.length)%phases.length;render(animate&&active());
 if(active()){
  const token=generation,bar=$('#sequence-progress');requestAnimationFrame(()=>requestAnimationFrame(()=>{if(token!==generation||!active())return;bar.style.transition='transform 6500ms linear';bar.style.transform='scaleX(1)';}));
  later(()=>start(current+1),6500);
 }
}
$('#demo-switch').addEventListener('click',()=>{const {mode,second}=phases[current];if(mode==='board')return;const next=phases.findIndex(phase=>phase.mode===mode&&phase.second!==second);start(next,true);});
for(const button of document.querySelectorAll('[data-scenario]'))button.addEventListener('click',()=>start(phases.findIndex(phase=>phase.mode===button.dataset.scenario),true));
$('#replay').addEventListener('click',()=>start(phases.findIndex(phase=>phase.mode===phases[current].mode),true));
$('#motion-toggle').addEventListener('click',()=>{paused=!paused;start(current,true);});
$('#copy').addEventListener('click',async()=>{const button=$('#copy');try{await navigator.clipboard.writeText($('#install-command').textContent);button.textContent='Скопировано';setTimeout(()=>button.textContent='Скопировать',2000);}catch{const range=document.createRange();range.selectNodeContents($('#install-command'));const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);button.textContent='Выделено';}});
// All scenes are synthetic. Timers never start model requests or contact a hub.
if('IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{const next=entries.some(entry=>entry.isIntersecting);if(next===visible)return;visible=next;start(current,true);},{threshold:.16});observer.observe(demo);}else{visible=true;start();}
document.addEventListener('visibilitychange',()=>start(current,true));
motion.addEventListener('change',event=>{if(event.matches)paused=true;start(current,false);});
render();playback();
