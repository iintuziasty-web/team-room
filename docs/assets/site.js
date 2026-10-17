'use strict';
const $=selector=>document.querySelector(selector),demo=$('#demo');
const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let mode='provider',second=false,timer=null,finish=null,generation=0;
const captions={provider:'Демонстрация на вымышленных данных. Нажмите на провайдера, чтобы продолжить с другим.',device:'Демонстрация: выбираете другой включённый компьютер и продолжаете ту же задачу.',board:'На личной доске видны задачи, вопросы и готовые ответы ваших сессий.'};
function cancel(){generation++;clearTimeout(timer);clearTimeout(finish);demo.classList.remove('transferring');$('#demo-switch').disabled=false;}
function render(){
 $('#messages').hidden=mode==='board';$('#demo-board').hidden=mode!=='board';demo.dataset.mode=mode;
 $('#provider-name').textContent=second&&mode==='provider'?'Codex':'Claude';$('#provider-icon').textContent=second&&mode==='provider'?'↔':'C';$('#provider-icon').classList.toggle('codex',second&&mode==='provider');
 $('#machine-name').textContent=second&&mode==='device'?'Домашний Mac':'Рабочий Mac';
 $('#demo-switch').innerHTML=(mode==='device'?(second?'Домашний Mac':'Рабочий Mac'):(second?'Codex':'Claude'))+' <span>⌄</span>';
 $('#demo-switch').setAttribute('aria-label',mode==='device'?'Демонстрация: сменить компьютер':'Демонстрация: сменить провайдера');
 $('#demo-answer').textContent=second?'Продолжаю с сохранённой структуры. Сейчас адаптирую первый экран для телефона; готовые файлы остаются в этом проекте.':'Готов первый вариант. Сохранил структуру страницы, выбранный заголовок и заметки для продолжения.';
 $('#handoff-title').textContent=second?'Продолжение готово':'Контекст сохранён';$('#handoff-detail').textContent=second?'История, решения и рабочий файл доступны в этой сессии':'Задача, решения и файлы доступны для продолжения';
 $('#demo-caption').textContent=captions[mode];
}
function transition(){
 cancel();if(mode==='board'){render();return;}const current=generation;
 demo.classList.add('transferring');$('#demo-switch').disabled=true;$('#handoff-title').textContent=mode==='provider'?'Передаём задачу другому провайдеру':'Подготавливаем рабочие файлы';$('#handoff-detail').textContent='Краткий контекст и сохранённые решения остаются с задачей';
 finish=setTimeout(()=>{if(current!==generation)return;second=!second;demo.classList.remove('transferring');$('#demo-switch').disabled=false;render();},reduced?0:1500);
}
$('#demo-switch').addEventListener('click',transition);
for(const button of document.querySelectorAll('[data-scenario]'))button.addEventListener('click',()=>{cancel();mode=button.dataset.scenario;second=false;for(const item of document.querySelectorAll('[data-scenario]')){item.classList.toggle('selected',item===button);item.setAttribute('aria-pressed',String(item===button));}render();});
$('#replay').addEventListener('click',()=>{cancel();second=false;render();if(mode!=='board')timer=setTimeout(transition,reduced?0:450);});
$('#copy').addEventListener('click',async()=>{const button=$('#copy');try{await navigator.clipboard.writeText($('#install-command').textContent);button.textContent='Скопировано';setTimeout(()=>button.textContent='Скопировать',2000);}catch{const range=document.createRange();range.selectNodeContents($('#install-command'));const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);button.textContent='Выделено';}});
// One explanatory transition when the demo first becomes visible. No looping
// animation, analytics, storage, network calls or connections to a live hub.
if(!reduced&&'IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting)){observer.disconnect();if(mode==='provider'&&!second)timer=setTimeout(transition,1600);}},{threshold:.45});observer.observe(demo);}
render();
