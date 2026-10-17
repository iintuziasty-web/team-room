const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const encode=encodeURIComponent;
export const shortcutItems=[
 ['search','K','Поиск по всем сообщениям'],['find','F','Найти в текущем чате'],['new','Alt N','Новый чат с сохранением черновика'],['sidebar','B','Показать или скрыть список чатов'],['send','Enter','Отправить сообщение'],['focus','/','Перейти к полю сообщения'],['help','?','Горячие клавиши'],
];
export function editingTarget(target){return Boolean(target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],.cm-editor,.monaco-editor'));}
export function shortcutAction(event,{mac=false}={}){
 if(event.defaultPrevented||event.isComposing)return '';
 const editor=editingTarget(event.target),mod=event.metaKey||event.ctrlKey,key=String(event.code||'').match(/^Key([A-Z])$/)?.[1].toLowerCase()||String(event.key).toLowerCase();
 if(mod&&key==='enter'&&!event.altKey&&!event.shiftKey&&event.target?.id==='message-input')return 'send';
 if(editor){
  if(event.target?.id!=='message-input'||!(mac?event.metaKey:event.ctrlKey)||event.shiftKey)return '';
  if(event.altKey)return key==='n'?'new':'';
  return {k:'search',f:'find'}[key]||'';
 }
 if(mod&&event.altKey&&key==='n'&&!event.shiftKey)return 'new';
 if(event.altKey)return '';
 if(!mod&&!event.shiftKey&&event.key==='Escape')return 'escape';
 if(!mod&&event.key==='?')return 'help';
 if(!mod&&event.key==='/')return 'focus';
 if(!mod)return '';
 if(event.shiftKey)return '';
 return {k:'search',f:'find',b:'sidebar'}[key]||'';
}
export function lineCommentPrompt(comments){
 return 'Проверь и исправь замечания к файлам:\n\n'+comments.map(c=>'Файл: '+c.path+'\n'+(c.newLine?'Строка '+c.newLine:c.oldLine?'Удалённая строка '+c.oldLine:'Файл целиком')+(c.text?' («'+c.text+'»)':'')+'\nКомментарий: '+c.comment+'\nВерсия после изменений: '+(c.afterHash||'не определена')+'. Перед изменением проверь текущую версию файла; если она изменилась, сначала сопоставь замечание с актуальным содержимым.').join('\n\n');
}
export class ChatTools{
 constructor(options){this.o=options;this.timer=null;this.request=null;this.token=0;this.comments=[];this.searchResults=[];this.queued=[];this.savedSearch='';this.queueDrafts=new Map();this.queueScope=null;this.onKey=event=>this.handleKey(event);document.addEventListener('keydown',this.onKey);}
 context(){return this.o.context()||{};}
 modal(){return document.querySelector('#dialog');}
 current(scope){return scope.account===this.context().account&&this.modal()?.open&&this.modal().dataset.chatTool===scope.token;}
 cancelRead(){clearTimeout(this.timer);this.timer=null;this.request?.abort();this.request=null;}
 clear(){this.cancelRead();this.token++;this.searchResults=[];this.comments=[];this.queued=[];this.savedSearch='';this.queueDrafts.clear();this.queueScope=null;}
 begin(title,body){this.cancelRead();this.o.dialog(title,body);const scope={account:this.context().account,token:String(++this.token)};this.modal().dataset.chatTool=scope.token;return scope;}
 async read(url,scope){this.request?.abort();const controller=new AbortController();this.request=controller;try{return await this.o.api(url,'GET',undefined,{timeoutMs:12000,signal:controller.signal});}finally{if(this.request===controller)this.request=null;}}
 error(scope,error){if(this.current(scope)&&error.name!=='AbortError')this.o.feedback(error.message,'error');}
 handleKey(event){
  if(!this.context().account)return;const action=shortcutAction(event,{mac:/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent)});if(!action)return;
  if(action==='escape'){if(this.modal()?.open){event.preventDefault();this.o.close();}return;}
  if(this.modal()?.open&&action!=='help')return;
  if(action!=='help'&&this.o.storage.getItem('roomShortcuts:'+this.context().account)==='off')return;
  if(action==='find'&&!this.context().chatId)return;
  event.preventDefault();if(action==='search')this.search();else if(action==='find')this.search(true);else if(action==='help')this.help();else this.o[action]?.();
 }
 help(){
  const mac=/Mac|iPhone|iPad/.test(navigator.platform||navigator.userAgent),mod=mac?'⌘':'Ctrl',scope=this.begin('Горячие клавиши',`<p>Поиск, поиск в чате, новый чат и отправка работают также из поля сообщения. Остальные сочетания доступны вне полей редактирования.</p><div class="shortcut-list">${shortcutItems.map(([action,key,label])=>`<div><span>${escape(label)}</span><kbd>${['help','focus'].includes(action)?key:mod+' '+(mac?key.replace('Alt','Option'):key)}</kbd></div>`).join('')}<div><span>Закрыть окно</span><kbd>Esc</kbd></div></div><label class="shortcut-toggle"><input type="checkbox" id="shortcut-enabled" ${this.o.storage.getItem('roomShortcuts:'+this.context().account)!=='off'?'checked':''}> Использовать горячие клавиши Team Room</label>`);
  this.modal().querySelector('#shortcut-enabled').onchange=event=>{if(this.current(scope))this.o.storage.setItem('roomShortcuts:'+scope.account,event.target.checked?'on':'off');};
 }
 search(inChat=false){
  const context=this.context();if(inChat&&!context.chatId)return;const chatId=inChat?context.chatId:'';
  const scope=this.begin(inChat?'Найти в этом чате':'Поиск по сообщениям',`<form id="room-search-form"><label for="room-search-input" class="tools-label">Текст сообщения</label><div class="tools-search-input"><input type="search" id="room-search-input" autocomplete="off" placeholder="Например: решение по проекту" value="${escape(this.savedSearch)}"><button class="primary-button" type="submit">Найти</button></div>${inChat?'<p class="muted">По всей истории текущей сессии.</p>':`<label class="tools-label" for="room-search-project">Где искать</label><select id="room-search-project"><option value="">Все проекты</option>${(context.projects||[]).map(p=>`<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('')}</select>`}</form><div id="room-search-status" class="tools-search-status" role="status" aria-live="polite">Введи текст для поиска.</div><div id="room-search-results" class="tools-search-results"></div>`),modal=this.modal(),input=modal.querySelector('#room-search-input'),project=modal.querySelector('#room-search-project');
  const run=async()=>{
   clearTimeout(this.timer);this.timer=null;if(!this.current(scope))return;const query=input.value.trim(),filter=project?.value||'';this.savedSearch=query;this.searchResults=[];const results=modal.querySelector('#room-search-results'),status=modal.querySelector('#room-search-status');results.replaceChildren();if(query.length<2){status.textContent='Введи хотя бы 2 символа.';this.request?.abort();return;}status.textContent='Ищу в истории…';
   try{const result=await this.read('/search?q='+encode(query)+(chatId?'&chatId='+encode(chatId):filter?'&projectId='+encode(filter):'')+'&limit=60',scope);if(!this.current(scope)||input.value.trim()!==query||(project?.value||'')!==filter)return;this.searchResults=result.matches||[];status.textContent=this.searchResults.length?'Найдено: '+this.searchResults.length+(result.truncated?' · уточни запрос, чтобы увидеть остальные результаты':''):'Ничего не найдено.';results.innerHTML=this.searchResults.map((match,i)=>`<button class="tools-search-result" data-search-index="${i}"><strong>${escape(match.title||match.chatTitle||'Чат')}</strong><small>${escape((context.projects||[]).find(p=>p.id===match.projectId)?.name||'Проект')} · ${match.role==='user'?'Твоё сообщение':'Ответ модели'}</small><span>${escape(match.snippet)}</span></button>`).join('');
   }catch(error){this.error(scope,error);if(this.current(scope)&&error.name!=='AbortError')status.textContent='Не удалось выполнить поиск.';}
  };
  input.oninput=()=>{this.request?.abort();clearTimeout(this.timer);this.timer=setTimeout(run,250);};if(project)project.onchange=()=>void run();modal.querySelector('#room-search-form').onsubmit=event=>{event.preventDefault();void run();};modal.querySelector('#room-search-results').onclick=event=>{const button=event.target.closest('[data-search-index]'),match=button&&this.searchResults[Number(button.dataset.searchIndex)];if(!match||!this.current(scope))return;this.o.close();void this.o.openMatch(match);};input.focus({preventScroll:true});if(input.value.trim().length>=2)void run();
 }
 fork(throughMessageId='',side=false){
  const context=this.context();if(!context.chatId)return;const requestId=crypto.randomUUID();
  const scope=this.begin(side?'Задать вопрос отдельно':'Ответвление чата',`<p>${side?'Новый чат получит историю до выбранного места. Вопрос будет разобран отдельно; текущая задача продолжит работать. Этот чат не изменяет файлы и общую память проекта.':'Создай отдельную сессию с историей до выбранного сообщения. Исходная сессия сохранится.'}</p><form id="fork-chat-form"><label class="tools-label" for="fork-title">Название нового чата</label><input id="fork-title" name="title" maxlength="100" placeholder="${side?'Отдельный вопрос':'Ответвление'} · ${escape(context.title||'Чат')}">${side?'<label class="tools-label" for="side-question">Твой вопрос</label><textarea id="side-question" name="question" required rows="4" placeholder="Что хочешь уточнить отдельно?"></textarea>':''}<div class="modal-buttons"><button type="button" data-fork-cancel>Отмена</button><button class="primary-button" type="submit">${side?'Создать и спросить':'Создать ответвление'}</button></div></form>`),form=this.modal().querySelector('#fork-chat-form');
  form.querySelector('[data-fork-cancel]').onclick=()=>this.o.close();form.onsubmit=async event=>{
   event.preventDefault();if(!this.current(scope))return;const button=form.querySelector('[type=submit]');if(button.disabled)return;const question=form.elements.question?.value.trim()||'';if(side&&!question)return;button.disabled=true;button.textContent='Создаю…';
   try{const result=await this.o.api('/chats/'+encode(context.chatId)+'/fork','POST',{throughMessageId:throughMessageId||undefined,title:form.elements.title.value.trim()||undefined,sideQuestion:side,requestId},{timeoutMs:20000});if(scope.account!==this.context().account)return;if(!this.current(scope))return this.o.notice('Новый чат сохранён. Открой его в списке сессий.');this.o.close();await this.o.openBranch(result,side?question:'');}
   catch(error){this.error(scope,error);if(this.current(scope)){button.disabled=false;button.textContent=side?'Создать и спросить':'Создать ответвление';}}
  };form.querySelector(side?'textarea':'input').focus({preventScroll:true});
 }
 queuedMessage(id){return this.context().messages?.find(m=>m.id===id&&m.followup&&m.delivery==='queued');}
 async queue(editId=''){
  const context=this.context();if(!context.chatId)return;
  const scope=this.begin('Дополнения в очереди','<p>Изменяй сообщения, пока они ожидают передачи. Уже переданные дополнения остаются в истории.</p><button id="queue-tools-refresh">Обновить очередь</button><div id="queue-tools-list"><p role="status">Загружаю очередь…</p></div>');
  this.modal().querySelector('#queue-tools-refresh').onclick=()=>void this.queue(editId);
  try{const result=await this.read('/chats/'+encode(context.chatId)+'?view=queue',scope);if(!this.current(scope))return;this.queueScope={...scope,chatId:context.chatId};this.queued=(result.messages||[]).filter(m=>m.followup&&m.delivery==='queued');this.paintQueue(scope,context.chatId,editId);}
  catch(error){this.error(scope,error);}
 }
 paintQueue(scope,chatId,editId=''){
  if(!this.current(scope))return;const list=this.modal().querySelector('#queue-tools-list'),editable=m=>m.canEdit??(this.context().owner||m.owner===this.context().name),canReorder=this.queued.every(editable);list.innerHTML=this.queued.length?this.queued.map((m,i)=>`<section class="queue-tools-row" data-queued-id="${escape(m.id)}"><div class="queue-tools-heading"><strong>Дополнение ${i+1}</strong><div><button data-queue-move="up" aria-label="Переместить дополнение выше" ${i===0||!canReorder?'disabled':''}>↑</button><button data-queue-move="down" aria-label="Переместить дополнение ниже" ${i===this.queued.length-1||!canReorder?'disabled':''}>↓</button></div></div><p>${escape(m.text)}</p>${editable(m)?`<button data-queue-edit>Изменить</button>`:''}<form class="queue-edit-form" ${m.id!==editId||!editable(m)?'hidden':''}><label class="tools-label">Текст дополнения<textarea name="text" required maxlength="100000" rows="3">${escape(this.queueDrafts.get(chatId+':'+m.id)??m.text)}</textarea></label><div class="modal-buttons"><button type="button" data-queue-edit-cancel>Отмена</button><button type="submit" class="primary-button">Сохранить</button></div></form><div class="form-feedback" hidden role="status"></div></section>`).join(''):'<p class="muted">Очередь пуста. Новые дополнения можно отправлять во время работы модели.</p>';
  list.onclick=async event=>{
   const row=event.target.closest('[data-queued-id]');if(!row||!this.current(scope))return;const id=row.dataset.queuedId,form=row.querySelector('form');
   if(event.target.closest('[data-queue-edit]')){form.hidden=false;form.elements.text.focus({preventScroll:true});return;}if(event.target.closest('[data-queue-edit-cancel]')){form.hidden=true;return;}
   const move=event.target.closest('[data-queue-move]');if(!move||move.disabled)return;const index=this.queued.findIndex(m=>m.id===id),target=index+(move.dataset.queueMove==='up'?-1:1);if(target<0||target>=this.queued.length)return;
   const next=[...this.queued];[next[index],next[target]]=[next[target],next[index]];const feedback=row.querySelector('.form-feedback');feedback.hidden=false;feedback.textContent='Сохраняю порядок…';list.querySelectorAll('button').forEach(b=>b.disabled=true);
   try{const result=await this.o.api('/chats/'+encode(chatId)+'/reorder-followups','POST',{messageIds:next.map(m=>m.id),expectedOrder:this.queued.map(m=>m.id)},{timeoutMs:15000});if(scope.account!==this.context().account)return;this.o.queueChanged(result,chatId);if(!this.current(scope))return;this.queued=result.messages||result.chat?.messages?.filter(m=>m.followup&&m.delivery==='queued')||next;this.paintQueue(scope,chatId);}
   catch(error){if(this.current(scope)){this.paintQueue(scope,chatId);this.o.feedback(error.message,'error');this.o.queueChanged(null,chatId);}}
  };
  list.oninput=event=>{const row=event.target.closest('[data-queued-id]');if(!row||event.target.name!=='text')return;this.queueDrafts.set(chatId+':'+row.dataset.queuedId,event.target.value);if(this.queueDrafts.size>100)this.queueDrafts.delete(this.queueDrafts.keys().next().value);};
  for(const row of list.querySelectorAll('[data-queued-id]'))row.querySelector('form').onsubmit=async event=>{
   event.preventDefault();if(!this.current(scope))return;const form=event.target,text=form.elements.text.value.trim(),button=form.querySelector('[type=submit]'),id=row.dataset.queuedId,feedback=row.querySelector('.form-feedback');if(!text||button.disabled)return;button.disabled=true;feedback.hidden=false;feedback.textContent='Сохраняю дополнение…';feedback.dataset.kind='notice';
   try{const result=await this.o.api('/chats/'+encode(chatId)+'/edit-followup','POST',{messageId:id,text,expectedText:this.queued.find(m=>m.id===id)?.text},{timeoutMs:15000});if(scope.account!==this.context().account)return;this.o.queueChanged(result,chatId);this.queueDrafts.delete(chatId+':'+id);if(!this.current(scope))return;const message=this.queued.find(m=>m.id===id);if(message)message.text=text;this.paintQueue(scope,chatId);}
   catch(error){if(this.current(scope)){feedback.dataset.kind='error';feedback.setAttribute('role','alert');feedback.textContent=error.message;button.disabled=false;this.o.queueChanged(null,chatId);}}
  };
  if(editId)list.querySelector(`[data-queued-id="${CSS.escape(editId)}"] textarea`)?.focus({preventScroll:true});
 }
 syncQueue(){
  const scope=this.queueScope;if(!scope||!this.current(scope)||scope.chatId!==this.context().chatId)return;const known=new Map((this.context().messages||[]).map(m=>[m.id,m]));let stale=false;
  for(const message of this.queued){const latest=known.get(message.id);if(!latest||latest.delivery==='queued')continue;stale=true;const row=this.modal().querySelector('[data-queued-id="'+CSS.escape(message.id)+'"]');if(!row||row.dataset.transferred)continue;row.dataset.transferred='true';row.querySelectorAll('button,textarea').forEach(node=>node.disabled=true);const feedback=row.querySelector('.form-feedback');feedback.hidden=false;feedback.textContent='Дополнение уже передано. Изменить его нельзя; отправь новое сообщение для уточнения.';}
  if(stale)this.modal().querySelectorAll('[data-queue-move]').forEach(button=>button.disabled=true);
 }
 async review(path=''){
  const context=this.context();if(!context.chatId)return;const scope=this.begin('Изменения файлов','<p role="status">Загружаю изменения…</p>');this.comments=[];
  try{const result=await this.read('/chats/'+encode(context.chatId)+'/review'+(path?'?path='+encode(path):''),scope);if(!this.current(scope))return;this.paintReview(scope,context.chatId,result,path);}
  catch(error){this.error(scope,error);}
 }
 paintReview(scope,chatId,result,path){
  if(!this.current(scope))return;const body=this.modal().querySelector('.phone-modal-body')||this.modal();let content;
  if(!path)content=`<p>${result.available===false?escape(result.reason||'Изменения появятся после следующего запроса.'):result.state==='running'?'Работа продолжается. Показаны уже сохранённые изменения.':'Файлы проекта, изменённые за время последнего запроса.'}</p><div class="review-file-list">${(result.files||[]).map((file,i)=>`<div class="review-file-row"><div><strong>${escape(file.path)}</strong><small>${escape({added:'Новый файл',modified:'Изменён',deleted:'Удалён',unchanged:'Без изменений'}[file.status]||file.status||'Файл')}</small>${!file.reviewable?'<small>'+escape(file.reason||'Сравнение недоступно для этого файла.')+'</small>':''}</div><button data-review-file="${i}" ${!file.reviewable?'disabled':''}>Сравнить</button></div>`).join('')||'<p class="muted">В этом запуске нет сохранённых изменений файлов.</p>'}</div>`;
  else content=`<div class="review-toolbar"><button data-review-back>Все файлы</button><strong>${escape(path)}</strong></div><p class="muted">Нажми на строку, чтобы добавить замечание. Комментарии попадут в поле сообщения; отправка остаётся за тобой.</p>${result.truncated?'<p class="form-feedback">Показана часть большого изменения.</p>':''}<div class="review-diff" role="list" aria-label="Изменения строк">${(result.lines||[]).map((line,i)=>`${line.gapBefore?'<div class="review-diff-gap" aria-label="Неизменённые строки пропущены">… неизменённые строки …</div>':''}<button class="review-diff-line ${['add','remove'].includes(line.kind)?line.kind:'context'}" data-diff-line="${i}" role="listitem" aria-label="${line.kind==='remove'?'Удалена строка '+line.oldLine:'Строка '+line.newLine}. Добавить комментарий"><span class="diff-line-numbers">${line.oldLine??''}</span><span class="diff-line-numbers">${line.newLine??''}</span><span class="diff-line-sign" aria-hidden="true">${line.kind==='add'?'+':line.kind==='remove'?'−':' '}</span><code>${escape(line.text)}</code></button>`).join('')||'<p class="muted">Текстовых изменений нет.</p>'}</div><form id="review-comment-form" hidden><label class="tools-label" id="review-comment-label" for="review-comment">Комментарий к строке</label><textarea id="review-comment" required rows="3" maxlength="4000" placeholder="Что нужно изменить?"></textarea><div class="modal-buttons"><button type="button" data-review-cancel>Отмена</button><button class="primary-button" type="submit">Добавить замечание</button></div></form><div id="review-comments"></div><div class="modal-buttons"><button type="button" class="primary-button" id="review-compose" disabled>В сообщение</button></div>`;
  // Keep the modal header and its close control; only replace the feature body.
  let panel=body.querySelector('.review-content');if(!panel){panel=document.createElement('div');panel.className='review-content';body.querySelectorAll(':scope > p').forEach(p=>p.remove());body.append(panel);}panel.innerHTML=content;
  for(const button of panel.querySelectorAll('[data-review-file]'))button.onclick=()=>this.readReviewFile(scope,chatId,result.files[Number(button.dataset.reviewFile)].path);
  const back=panel.querySelector('[data-review-back]');if(back)back.onclick=()=>this.readReviewFile(scope,chatId,'');
  if(!path)return;let selected;
  for(const button of panel.querySelectorAll('[data-diff-line]'))button.onclick=()=>{selected=result.lines[Number(button.dataset.diffLine)];panel.querySelector('#review-comment-form').hidden=false;panel.querySelector('#review-comment-label').textContent=selected.kind==='remove'?'Комментарий к удалённой строке '+selected.oldLine:'Комментарий к строке '+selected.newLine;panel.querySelector('#review-comment').focus({preventScroll:true});};
  panel.querySelector('[data-review-cancel]').onclick=()=>{panel.querySelector('#review-comment-form').hidden=true;};
  const repaint=()=>{panel.querySelector('#review-comments').innerHTML=this.comments.map((c,i)=>`<div class="review-comment-chip"><span>${escape(c.path)} · ${c.newLine||c.oldLine}: ${escape(c.comment)}</span><button data-remove-comment="${i}" aria-label="Убрать замечание">×</button></div>`).join('');panel.querySelector('#review-compose').disabled=!this.comments.length;};
  panel.querySelector('#review-comment-form').onsubmit=event=>{event.preventDefault();const input=panel.querySelector('#review-comment'),comment=input.value.trim();if(!selected||!comment)return;this.comments.push({path,oldLine:selected.oldLine,newLine:selected.newLine,text:String(selected.text||'').slice(0,300),afterHash:result.afterHash,comment});input.value='';panel.querySelector('#review-comment-form').hidden=true;repaint();};
  panel.querySelector('#review-comments').onclick=event=>{const button=event.target.closest('[data-remove-comment]');if(!button)return;this.comments.splice(Number(button.dataset.removeComment),1);repaint();};
  panel.querySelector('#review-compose').onclick=()=>{if(!this.current(scope)||!this.comments.length)return;const text=lineCommentPrompt(this.comments);this.o.close();this.o.compose(text,chatId);};repaint();
 }
 async readReviewFile(scope,chatId,path){
  if(!this.current(scope))return;this.o.feedback('Загружаю изменения…');try{const result=await this.read('/chats/'+encode(chatId)+'/review'+(path?'?path='+encode(path):''),scope);if(this.current(scope)){this.o.feedback('');this.paintReview(scope,chatId,result,path);}}
  catch(error){this.error(scope,error);}
 }
}
