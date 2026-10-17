// Preview messages are untrusted selections, never commands. Only an explicit
// click moves a bounded excerpt and the user's instruction into the composer.
export function attachPreview({root,projectId,path,chatId,onCompose}){
 const host=root.querySelector('.artifact-preview'),toolbar=root.querySelector('.artifact-toolbar');if(!host||!toolbar)return ()=>{};
 const channel=crypto.randomUUID(),frame=host.querySelector('iframe'),image=host.querySelector('img'),selectable=/\.(html?|txt|md|csv|json)$/i.test(path);
 let selected='',region='',start=null,closed=false,regionMode=false;const originalTouchAction=image?.style.touchAction;
 const button=document.createElement('button');button.type='button';button.textContent=selectable?'Правка выделения':'Указать правку';button.className='preview-annotate-button';toolbar.append(button);
 const panel=document.createElement('section');panel.className='preview-annotation';panel.hidden=true;panel.innerHTML='<label>Фрагмент или область<input class="preview-region" placeholder="Например: заголовок вверху или второй абзац"></label><blockquote class="preview-selection" hidden></blockquote><label>Что изменить<textarea class="preview-instruction" rows="3" placeholder="Опиши нужную правку…"></textarea></label><div class="preview-annotation-actions"><button type="button" class="preview-annotation-cancel">Отмена</button><button type="button" class="primary-button preview-annotation-apply">В сообщение</button></div><p class="muted preview-annotation-note" role="status"></p>';host.after(panel);
 const excerpt=panel.querySelector('.preview-selection'),regionInput=panel.querySelector('.preview-region'),instruction=panel.querySelector('.preview-instruction'),note=panel.querySelector('.preview-annotation-note');
 const update=()=>{excerpt.textContent=selected;excerpt.hidden=!selected;regionInput.value=region;};
 const show=()=>{panel.hidden=false;update();note.textContent=chatId?'Правка добавится в поле ввода. Проверь и отправь.':'Правка добавится в поле ввода нового чата этого проекта.';instruction.focus({preventScroll:true});};
 button.onclick=()=>{regionMode=Boolean(image);if(image)image.style.touchAction='none';show();};panel.querySelector('.preview-annotation-cancel').onclick=()=>{panel.hidden=true;regionMode=false;if(image)image.style.touchAction=originalTouchAction;};
 panel.querySelector('.preview-annotation-apply').onclick=()=>{const text=instruction.value.trim().slice(0,6000),where=regionInput.value.trim().slice(0,500);if(!text){note.textContent='Опиши, что нужно изменить.';instruction.focus();return;}if(!selected&&!where){note.textContent='Выдели текст в превью или укажи область.';regionInput.focus();return;}onCompose(`В проекте ${projectId}, файл ${path}${where?' — '+where:''}.${selected?'\nВыделенный фрагмент (проверь текущую версию файла):\n«'+selected+'»':''}\nПравка: ${text}`);};
 const receive=event=>{if(closed||!root.isConnected||event.source!==frame?.contentWindow||event.origin!=='null'||event.data?.type!=='team-room-preview-selection'||event.data.channel!==channel||typeof event.data.text!=='string')return;selected=event.data.text.trim().slice(0,4000);button.textContent=selected?'Правка выделения':'Указать правку';if(!panel.hidden)update();};
 window.addEventListener('message',receive);
 if(frame&&selectable){const url=new URL(frame.src,location.href);url.searchParams.set('annotation',channel);frame.setAttribute('sandbox','allow-scripts');frame.src=url.href;}
 const point=event=>{const r=image.getBoundingClientRect();return {x:Math.max(0,Math.min(100,(event.clientX-r.left)/r.width*100)),y:Math.max(0,Math.min(100,(event.clientY-r.top)/r.height*100))};};
 const down=event=>{if(!event.altKey&&!regionMode)return;event.preventDefault();image.setPointerCapture?.(event.pointerId);start=point(event);};
 const up=event=>{if(!start)return;const end=point(event);region=`Область изображения: x ${Math.min(start.x,end.x).toFixed(0)}–${Math.max(start.x,end.x).toFixed(0)}%, y ${Math.min(start.y,end.y).toFixed(0)}–${Math.max(start.y,end.y).toFixed(0)}%`;start=null;regionMode=false;image.style.touchAction=originalTouchAction;show();};
 image?.addEventListener('pointerdown',down);image?.addEventListener('pointerup',up);
 if(image)button.title='Укажи область словами или нажми эту кнопку и выдели область на изображении';
 return ()=>{closed=true;window.removeEventListener('message',receive);image?.removeEventListener('pointerdown',down);image?.removeEventListener('pointerup',up);if(image)image.style.touchAction=originalTouchAction;button.remove();panel.remove();};
}
