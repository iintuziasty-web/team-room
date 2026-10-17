import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {snapshot,portablePath,digest,MAX_TRANSFER,MAX_FILE} from './workspace.mjs';
const uuid=()=>crypto.randomUUID();
const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(v);
const roots=home=>({claude:path.join(home,'.claude','projects'),codex:[path.join(home,'.codex','sessions'),path.join(home,'.codex','archived_sessions')]});
async function walk(root,depth=8){const out=[];try{for(const e of await fs.readdir(root,{withFileTypes:true})){if(e.isSymbolicLink())continue;const p=path.join(root,e.name);if(e.isDirectory()&&depth>0)out.push(...await walk(p,depth-1));else if(e.isFile()&&e.name.endsWith('.jsonl'))out.push(p)}}catch(e){if(e.code!=='ENOENT')throw e}return out}
async function metadataLines(file){const handle=await fs.open(file,'r');try{const stat=await handle.stat(),chunk=256*1024;const front=Buffer.alloc(Math.min(chunk,stat.size));await handle.read(front,0,front.length,0);let data=front.toString('utf8');if(stat.size>chunk){const tail=Buffer.alloc(Math.min(chunk,stat.size));await handle.read(tail,0,tail.length,stat.size-tail.length);data+='\n'+tail.toString('utf8').split('\n').slice(1).join('\n');}const rows=[];for(const line of data.split('\n'))try{rows.push(JSON.parse(line))}catch{}return rows;}finally{await handle.close()}}
// Read a stable prefix of the journal, releasing each raw record after parsing.
// Large hidden/tool records never require retaining the entire JSONL document.
async function* jsonLines(file,report){
 const handle=await fs.open(file,'r');const startedAt=Date.now(),maxLine=128*1024*1024;let parts=[],length=0,lineNumber=0;
 try{const stat=await handle.stat();if(stat.size>8*1024*1024*1024)throw new Error('IMPORT_SOURCE_TOO_LARGE');report.sourceBytes=stat.size;
  const chunk=Buffer.alloc(256*1024);let position=0;
  while(position<stat.size){if(Date.now()-startedAt>150000)throw new Error('IMPORT_READ_TIMEOUT');const {bytesRead}=await handle.read(chunk,0,Math.min(chunk.length,stat.size-position),position);if(!bytesRead)throw new Error('IMPORT_SOURCE_CHANGED');position+=bytesRead;let offset=0;
   while(offset<bytesRead){const newline=chunk.indexOf(10,offset);const end=newline>=0&&newline<bytesRead?newline:bytesRead;const part=Buffer.from(chunk.subarray(offset,end));length+=part.length;if(length>maxLine)throw new Error('IMPORT_RECORD_TOO_LARGE');parts.push(part);offset=end+1;
    if(end<bytesRead){lineNumber++;const line=Buffer.concat(parts,length).toString('utf8').replace(/^\uFEFF/,'');parts=[];length=0;if(!line.trim())continue;let value;try{value=JSON.parse(line)}catch{throw new Error('IMPORT_INVALID_RECORD:'+lineNumber)}if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('IMPORT_INVALID_RECORD:'+lineNumber);yield value;}
   }
  }
  if(length){const line=Buffer.concat(parts,length).toString('utf8');let value;try{value=JSON.parse(line)}catch{report.warnings.push('Последняя запись исходной сессии ещё не завершена и не перенесена. Повтори импорт после завершения записи в Claude/Codex.');return}if(value&&typeof value==='object'&&!Array.isArray(value))yield value;else throw new Error('IMPORT_INVALID_RECORD:'+(lineNumber+1));}
 }finally{await handle.close()}
}
// Full registration also handles replacements and edits. Appending an action
// only serializes the new action and the message fields outside the growing
// action array; all earlier action details have already been counted exactly.
export function importBudget({maxMessageBytes=96*1024*1024,maxTransferBytes=160*1024*1024,maxEntries=55000}={}){
 let messages=0,media=0;const sizes=new Map();const bytes=value=>Buffer.byteLength(JSON.stringify(value));
 const envelope=value=>bytes({...value,actions:[]});
 const record=(key,value,size,envelopeBytes)=>{const delta=size-(sizes.get(key)?.bytes||0);if(key.startsWith('file:'))media+=delta;else messages+=delta;sizes.set(key,{bytes:size,actions:value.actions,actionCount:value.actions?.length,envelopeBytes});if(messages>maxMessageBytes||sizes.size>maxEntries)throw new Error('IMPORT_CONTENT_TOO_LARGE');if(media+messages>maxTransferBytes)throw new Error('IMPORT_TRANSFER_TOO_LARGE');};
 const account=(key,value)=>record(key,value,bytes(value),Array.isArray(value.actions)?envelope(value):undefined);
 account.appendAction=(message,action)=>{
  const previous=sizes.get(message.id),count=message.actions.length;
  // Existing action edits/removals and array replacements use full account().
  // The fallback also remains exact if a caller forgot to register an array.
  if(!previous||previous.actions!==message.actions||previous.actionCount!==count){message.actions.push(action);account(message.id,message);return;}
  const actionBytes=bytes(action),envelopeBytes=envelope(message);message.actions.push(action);
  record(message.id,message,previous.bytes-previous.envelopeBytes+envelopeBytes+actionBytes+(count?1:0),envelopeBytes);
 };
 account.totals=()=>({messageBytes:messages,mediaBytes:media,entries:sizes.size});
 return account;
}
function parseRows(factory,rows,sessionId,options){const parser=factory(sessionId,options);parser.next();for(const row of rows)parser.next(row);return parser.next(null).value;}
async function parseJournal(factory,file,sessionId,options){const report={warnings:[],sourceBytes:0};const parser=factory(sessionId,options);parser.next();for await(const row of jsonLines(file,report))parser.next(row);const result=parser.next(null).value;result.warnings.push(...report.warnings);result.sourceBytes=report.sourceBytes;return result;}

function textBlocks(content){if(typeof content==='string')return content;return (content||[]).filter(c=>['text','input_text','output_text'].includes(c.type)).map(c=>c.text||'').join('\n')}
function collectReferences(v,set,base,depth=0){if(!v||depth>16)return;if(Array.isArray(v)){for(const x of v)collectReferences(x,set,base,depth+1);return}if(typeof v==='object')for(const [key,x]of Object.entries(v)){if(['path','file_path','filePath','filename'].includes(key)&&typeof x==='string'&&x.length<1000)set.add(path.isAbsolute(x)?x:path.resolve(base||'.',x));else if(key!=='cwd'&&key!=='encrypted_content'&&key!=='base_instructions')collectReferences(x,set,base,depth+1)}}
function referencesFromText(text,set,base){for(const m of String(text||'').matchAll(/(?:`|\[)([^`\]\n]{1,500}\.(?:md|txt|json|jsonl|js|mjs|ts|tsx|jsx|py|html|css|csv|xlsx|docx|pdf|png|jpg|jpeg|webp|mp4|mov|yaml|yml))(?::\d+)?(?:`|\])/gi)){const v=m[1];if(!/^https?:/.test(v))set.add(path.isAbsolute(v)?v:path.resolve(base||'.',v))}}
function codexImages(content,message,sessionId,cwd,mediaFiles,inlineFiles){
 for(const part of content||[]){const source=part.type==='localImage'?part.path:null;const data=(part.url||part.image_url||'').match?.(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/);if(!source&&!data)continue;
  const ext=data?({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[data[1]]):path.extname(source).slice(1).toLowerCase();const mime={'png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','webp':'image/webp','gif':'image/gif'}[ext];if(!mime)continue;
  const relative=`imports/codex/${sessionId}/images/${digest(Buffer.from(message.id+':'+(source||data[2]))).slice(0,24)}.${ext}`;message.attachments||=[];message.attachments.push({path:relative,name:path.basename(source||relative),mimeType:mime});
  if(data){const bytes=Buffer.from(data[2],'base64');if(bytes.length<=MAX_FILE)inlineFiles.push({path:relative,content:bytes.toString('base64'),size:bytes.length,hash:digest(bytes)})}else mediaFiles.push({source:path.isAbsolute(source)?source:path.resolve(cwd||'.',source),path:relative});
 }
}
function claudeParse(rows,sessionId,options){return parseRows(claudeParser,rows,sessionId,options)}
function* claudeParser(sessionId,{includeMedia=true}={}){
 const messages=[],byId=new Map(),references=new Set(),inlineFiles=[],imageFiles=new Map(),account=importBudget();let cwd='',title='',updatedAt='',sourceActive=false,lastConversation;
 const toolOwners=new Map(),ownerKeys=new WeakMap(),positions=new WeakMap();let position=0;
 const registerTools=message=>{
  if(!positions.has(message))positions.set(message,position++);
  const keys=new Set(message.actions.map(action=>action.toolId));
  for(const key of ownerKeys.get(message)||[])if(!keys.has(key)){
   const entry=toolOwners.get(key);entry.owners.delete(message);
   if(!entry.owners.size)toolOwners.delete(key);
   else if(entry.last===message){entry.last=null;for(const owner of entry.owners)if(!entry.last||positions.get(owner)>positions.get(entry.last))entry.last=owner;}
  }
  for(const key of keys){let entry=toolOwners.get(key);if(!entry){entry={owners:new Set(),last:message};toolOwners.set(key,entry);}entry.owners.add(message);if(positions.get(message)>positions.get(entry.last))entry.last=message;}
  ownerKeys.set(message,keys);
 };
 while(true){const row=yield;if(row===null)break;if(row.isSidechain)continue;if(['user','assistant'].includes(row.type)&&row.message)lastConversation=row;cwd=row.cwd||cwd;updatedAt=row.timestamp||updatedAt;title=row.aiTitle||row.customTitle||title;
  if(row.type==='summary'&&row.summary){messages.push({id:'native-claude-'+(row.uuid||digest(Buffer.from(JSON.stringify(row)))),role:'assistant',provider:'claude',text:'Сводка исходного приложения:\n'+row.summary,status:'completed',createdAt:row.timestamp||updatedAt,actions:[],imported:true});account(messages.at(-1).id,messages.at(-1));continue}
  if(!['user','assistant'].includes(row.type)||!row.message)continue;const msg=row.message;const content=Array.isArray(msg.content)?msg.content:[];
  const tools=content.filter(c=>c.type==='tool_use');for(const t of tools)collectReferences(t.input,references,cwd);
  const results=content.filter(c=>c.type==='tool_result');for(const t of results){const parent=toolOwners.get(t.tool_use_id)?.last;if(parent)account.appendAction(parent,{tool:'Результат действия',toolId:t.tool_use_id,status:t.is_error?'failed':'completed',details:typeof t.content==='string'?t.content:textBlocks(t.content),at:row.timestamp});}
  const text=textBlocks(msg.content);if(!text&&!tools.length&&!content.some(b=>b.type==='image'))continue;
  const messageId='native-claude-'+(row.uuid||msg.id||digest(Buffer.from(JSON.stringify(row))));const old=byId.get(messageId);const m={id:messageId,role:row.type,provider:row.type==='assistant'?'claude':undefined,text,model:msg.model,status:'completed',createdAt:row.timestamp||updatedAt,actions:tools.map(t=>({tool:t.name,toolId:t.id,status:'started',details:t.input,at:row.timestamp})),attachments:[],imported:true};
  for(const [imageIndex,b]of content.entries()){if(b.type==='image'&&b.source?.type==='base64'&&includeMedia){const ext={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[b.source.media_type];if(ext){const relative=`imports/claude/${sessionId}/images/${row.uuid||digest(Buffer.from(JSON.stringify(row)))}-${imageIndex}.${ext}`;const bytes=Buffer.from(b.source.data,'base64');if(bytes.length<=MAX_FILE){const image={path:relative,content:b.source.data,hash:digest(bytes),size:bytes.length};const existing=imageFiles.get(relative);if(existing)Object.assign(existing,image);else{inlineFiles.push(image);imageFiles.set(relative,image);}account('file:'+relative,image);m.attachments.push({path:relative,name:path.basename(relative),mimeType:b.source.media_type})}}}}
  referencesFromText(text,references,cwd);if(old){m.actions=[...old.actions.filter(a=>a.tool==='Результат действия'),...m.actions];Object.assign(old,m);}else{byId.set(messageId,m);messages.push(m)}registerTools(old||m);account(messageId,old||m);
 }
 if(!title)title=messages.find(m=>m.role==='user')?.text.slice(0,90)||'Claude Code '+sessionId.slice(0,8);
 sourceActive=lastConversation?.type==='user'&&!/\[Request interrupted by user/.test(textBlocks(lastConversation.message.content))||lastConversation?.message?.stop_reason==='tool_use'||Boolean(lastConversation?.type==='assistant'&&!textBlocks(lastConversation.message.content)&&lastConversation.message.content?.some?.(b=>b.type==='tool_use'));
 return {provider:'claude',sessionId,title,cwd,updatedAt,messages,references:[...references],inlineFiles,active:sourceActive,warnings:[]};
}
export function codexThreadParse(thread,{includeMedia=true}={}){
 const messages=[],references=new Set(),mediaFiles=[],inlineFiles=[],account=importBudget();const cwd=thread.cwd||'';
 for(const turn of thread.turns||[]){let lastAssistant;for(const item of turn.items||[]){const stamp=turn.startedAt||turn.createdAt||thread.createdAt||thread.updatedAt||Date.now();const timestamp=new Date(typeof stamp==='number'&&stamp<1e12?stamp*1000:stamp).toISOString();
  if(item.type==='userMessage'){const text=textBlocks(item.content||item.input);const m={id:'native-codex-'+thread.id+'-'+turn.id+'-'+item.id,role:'user',text,status:'completed',createdAt:timestamp,actions:[],attachments:[],imported:true};messages.push(m);if(includeMedia){const firstFile=inlineFiles.length;codexImages(item.content||item.input,m,thread.id,cwd,mediaFiles,inlineFiles);for(let i=firstFile;i<inlineFiles.length;i++)account('file:'+inlineFiles[i].path,inlineFiles[i]);}account(m.id,m);referencesFromText(text,references,cwd)}
  else if(item.type==='agentMessage'){const m={id:'native-codex-'+thread.id+'-'+turn.id+'-'+item.id,role:'assistant',provider:'codex',model:thread.model,text:item.text||'',status:turn.status==='completed'?'completed':turn.status==='inProgress'?'interrupted':'failed',error:turn.error?.message||null,createdAt:timestamp,actions:[],imported:true};messages.push(m);account(m.id,m);lastAssistant=m;referencesFromText(m.text,references,cwd)}
  else if(!['reasoning','contextCompaction'].includes(item.type)){collectReferences(item,references,cwd);if(!lastAssistant){lastAssistant={id:'native-codex-action-'+thread.id+'-'+turn.id+'-'+item.id,role:'assistant',provider:'codex',text:'',status:'completed',createdAt:timestamp,actions:[],imported:true};messages.push(lastAssistant)}account.appendAction(lastAssistant,{tool:item.type,toolId:item.id,status:item.status||'completed',details:item,at:timestamp});}
 }
 }
 return {provider:'codex',sessionId:thread.id,title:thread.name||thread.preview?.slice(0,90)||'Codex '+thread.id.slice(0,8),cwd,updatedAt:new Date((thread.updatedAt||Date.now()/1000)*1000).toISOString(),messages,references:[...references],inlineFiles,mediaFiles,active:thread.status?.type==='active'||thread.turns?.at(-1)?.status==='inProgress',warnings:[]};
}
function codexRolloutParse(rows,sessionId,options){return parseRows(codexRolloutParser,rows,sessionId,options)}
function* codexRolloutParser(sessionId,{includeMedia=true}={}){
 let meta={},latestTask,lastTimestamp;const messages=[],references=new Set(),mediaFiles=[],inlineFiles=[],toolCalls=new Map(),account=importBudget();let lastAssistant;let warnings=[];
 while(true){const row=yield;if(row===null)break;if(row.type==='session_meta')meta=row.payload||{};if(row.type==='event_msg'&&['task_started','task_complete','turn_aborted'].includes(row.payload?.type))latestTask=row;lastTimestamp=row.timestamp||lastTimestamp;const p=row.payload||{},at=row.timestamp||meta.timestamp||new Date().toISOString();
  if(row.type==='response_item'&&p.type==='message'&&['user','assistant'].includes(p.role)&&p.channel!=='analysis'){const text=textBlocks(p.content);if(!text&&!p.content?.some(c=>['input_image','image','localImage'].includes(c.type)))continue;const m={id:'native-codex-'+(p.id||digest(Buffer.from(at+text))),role:p.role,provider:p.role==='assistant'?'codex':undefined,text,status:'completed',createdAt:at,actions:[],imported:true};messages.push(m);if(p.role==='user'&&includeMedia){const firstFile=inlineFiles.length;codexImages(p.content,m,sessionId,meta.cwd,mediaFiles,inlineFiles);for(let i=firstFile;i<inlineFiles.length;i++)account('file:'+inlineFiles[i].path,inlineFiles[i]);}account(m.id,m);if(p.role==='assistant')lastAssistant=m;referencesFromText(text,references,meta.cwd)}
  else if(row.type==='response_item'&&['function_call','custom_tool_call'].includes(p.type)){let args=p.arguments||p.input;try{args=JSON.parse(args)}catch{}collectReferences(args,references,meta.cwd);if(!lastAssistant){lastAssistant={id:'native-codex-action-'+(p.call_id||uuid()),role:'assistant',provider:'codex',text:'',status:'completed',createdAt:at,actions:[],imported:true};messages.push(lastAssistant)}const a={tool:p.name,toolId:p.call_id,status:'started',details:args,at};account.appendAction(lastAssistant,a);toolCalls.set(p.call_id,lastAssistant)}
  else if(row.type==='response_item'&&['function_call_output','custom_tool_call_output'].includes(p.type)){const m=toolCalls.get(p.call_id);if(m)account.appendAction(m,{tool:'Результат действия',toolId:p.call_id,status:'completed',details:p.output,at})}
  else if(row.type==='compacted'&&p.message){messages.push({id:'native-codex-compact-'+digest(Buffer.from(at)),role:'assistant',provider:'codex',text:'Сводка исходного приложения:\n'+p.message,status:'completed',createdAt:at,actions:[],imported:true});account(messages.at(-1).id,messages.at(-1));}
  else if(row.type==='response_item'&&p.type==='compaction'&&p.encrypted_content&&!warnings.length)warnings.push('Исходная сессия содержит закрытый компакт. Он не переносится; доступны сохранённые сообщения и действия.');
 }
 const active=latestTask?latestTask.payload.type==='task_started':messages.at(-1)?.role==='user';
 return {provider:'codex',sessionId,title:messages.find(m=>m.role==='user')?.text.slice(0,90)||'Codex '+sessionId.slice(0,8),cwd:meta.cwd||'',updatedAt:lastTimestamp||meta.timestamp,messages,references:[...references],inlineFiles,mediaFiles,active:Boolean(active),warnings:[...new Set(warnings)]};
}
export class NativeSessions{
 constructor(providers,{home=os.homedir()}={}){this.providers=providers;this.home=home;this.index=new Map();this.indexAt=0;}
 async scan(provider,force=false){if(!force&&Date.now()-this.indexAt<10000&&[...this.index.values()].some(x=>x.provider===provider))return;const r=roots(this.home);if(this.home===os.homedir()){if(this.providers.env?.CLAUDE_CONFIG_DIR)r.claude=path.join(this.providers.env.CLAUDE_CONFIG_DIR,'projects');if(this.providers.env?.CODEX_HOME)r.codex=['sessions','archived_sessions'].map(name=>path.join(this.providers.env.CODEX_HOME,name));}const files=provider==='claude'?await walk(r.claude,1):(await Promise.all(r.codex.map(p=>walk(p)))).flat();const ranked=await Promise.all(files.map(async file=>({file,stat:await fs.stat(file)})));ranked.sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);
  for(const [key,value]of this.index)if(value.provider===provider)this.index.delete(key);const seen=new Set();for(const {file,stat}of ranked.slice(0,1000)){const basename=path.basename(file,'.jsonl');const sessionId=provider==='claude'?basename:basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];if(!validId(sessionId)||seen.has(sessionId))continue;seen.add(sessionId);this.index.set(provider+':'+sessionId,{provider,sessionId,file,updatedAt:stat.mtime.toISOString(),size:stat.size})}this.indexAt=Date.now();
 }
 async list(provider,cursor=null){if(provider==='codex'&&this.home===os.homedir()){try{const r=await this.providers.nativeCodexList(cursor);return {sessions:r.data.map(t=>({provider,sessionId:t.id,title:t.name||t.preview?.slice(0,90)||'Codex '+t.id.slice(0,8),cwd:t.cwd,updatedAt:new Date(t.updatedAt*1000).toISOString(),active:t.status?.type==='active'})),nextCursor:r.nextCursor||null}}catch{}}
  await this.scan(provider,true);const list=[...this.index.values()].filter(x=>x.provider===provider).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));const offset=Number(cursor)||0;const sessions=[];for(const m of list.slice(offset,offset+40)){try{const rows=await metadataLines(m.file);const p=provider==='claude'?claudeParse(rows,m.sessionId,{includeMedia:false}):codexRolloutParse(rows,m.sessionId,{includeMedia:false});sessions.push({provider,sessionId:m.sessionId,title:p.title,cwd:p.cwd,updatedAt:m.updatedAt,active:p.active,messageCount:p.messages.length})}catch{}}return {sessions,nextCursor:offset+40<list.length?String(offset+40):null};
 }
 async read(provider,sessionId,options={}){if(this.readBusy)throw new Error('IMPORT_BUSY');this.readBusy=true;try{return await this.readSnapshot(provider,sessionId,options)}finally{this.readBusy=false}}
 async readSnapshot(provider,sessionId,{files='referenced'}={}){if(!['claude','codex'].includes(provider)||!validId(sessionId))throw new Error('Укажи корректный провайдер и ID сессии.');let parsed;
  if(provider==='codex'&&this.home===os.homedir())try{parsed=codexThreadParse(await this.providers.nativeCodexRead(sessionId),{includeMedia:files!=='none'})}catch{}
  if(!parsed){await this.scan(provider,true);const m=this.index.get(provider+':'+sessionId);if(!m)throw new Error('Сессия не найдена на выбранном компьютере.');parsed=await parseJournal(provider==='claude'?claudeParser:codexRolloutParser,m.file,sessionId,{includeMedia:files!=='none'})}
  if(parsed.messages.length>50000)throw new Error('IMPORT_CONTENT_TOO_LARGE');if(!parsed.messages.length)throw new Error('В сессии пока нет сохранённых сообщений.');parsed.files=files==='none'?[]:[...parsed.inlineFiles];delete parsed.inlineFiles;
  const cwd=parsed.cwd&&path.resolve(parsed.cwd);const realCwd=cwd?await fs.realpath(cwd).catch(()=>cwd):null;const transferable=[];const missing=[];
  if(files==='all'){if(!cwd||cwd===path.parse(cwd).root||cwd===this.home)throw new Error('Нельзя переносить корень диска или всю домашнюю папку. Выбери только упомянутые файлы.');const stat=await fs.lstat(cwd);if(stat.isSymbolicLink())throw new Error('Рабочая папка является ссылкой.');transferable.push(...await snapshot(cwd,{contents:true}));}
  else if(files!=='none'){for(const reference of parsed.references){const absolute=path.resolve(reference);if(!cwd||!absolute.startsWith(cwd+path.sep))continue;const relative=path.relative(cwd,absolute);try{portablePath(relative);const real=await fs.realpath(absolute);if(real!==path.join(realCwd,relative))continue;const stat=await fs.lstat(absolute);if(!stat.isFile()||stat.size>MAX_TRANSFER){missing.push(relative);continue};const bytes=await fs.readFile(absolute);transferable.push({path:relative,content:bytes.toString('base64'),hash:digest(bytes),size:bytes.length})}catch{missing.push(relative)}}}
  if(files!=='none')for(const image of parsed.mediaFiles||[])try{const st=await fs.lstat(image.source);if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_TRANSFER)continue;const bytes=await fs.readFile(image.source);const valid=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes[0]===255&&bytes[1]===216||bytes.subarray(0,3).toString()==='GIF'||bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';if(!valid)continue;parsed.files.push({path:image.path,content:bytes.toString('base64'),hash:digest(bytes),size:bytes.length})}catch{missing.push(image.path)}delete parsed.mediaFiles;
  parsed.files.push(...transferable);if(parsed.files.reduce((n,f)=>n+f.size,0)>1024*1024*1024)throw new Error('Перенос превышает 1 ГБ. Выбери только нужные файлы.');parsed.warnings.push(...(missing.length?['Не найдены некоторые упомянутые файлы: '+missing.slice(0,20).join(', ')]:[]));parsed.fileFingerprint=digest(Buffer.from(JSON.stringify(parsed.files.map(f=>({path:f.path,hash:f.hash})).sort((a,b)=>a.path.localeCompare(b.path)))));const normalized=JSON.stringify(parsed.messages);if(Buffer.byteLength(normalized)>96*1024*1024)throw new Error('IMPORT_CONTENT_TOO_LARGE');parsed.sourceFingerprint=digest(Buffer.from(normalized));if(Buffer.byteLength(JSON.stringify(parsed))>160*1024*1024)throw new Error('IMPORT_TRANSFER_TOO_LARGE');return parsed;
 }
 async resolveCurrent(provider,cwd){const envId=provider==='codex'?process.env.CODEX_THREAD_ID:process.env.CLAUDE_SESSION_ID;if(validId(envId))return envId;await this.scan(provider,true);const candidates=[...this.index.values()].filter(x=>x.provider===provider).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));const matching=[];for(const m of candidates){try{const rows=await metadataLines(m.file);const sourceCwd=provider==='claude'?rows.find(x=>x.cwd)?.cwd:rows.find(x=>x.type==='session_meta')?.payload?.cwd;if(sourceCwd&&(await fs.realpath(sourceCwd).catch(()=>path.resolve(sourceCwd)))===(await fs.realpath(cwd).catch(()=>path.resolve(cwd))))matching.push(m.sessionId)}catch{}}if(matching.length===1)return matching[0];if(matching.length>1)throw new Error('В этой рабочей папке несколько сессий. Укажи точный ID или выбери чат в Team Room.');throw new Error('Не удалось определить текущую сессию. Укажи её ID или выбери чат в Team Room.');}

}
export {claudeParse,codexRolloutParse};
