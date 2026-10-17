import fs from 'node:fs/promises';
import path from 'node:path';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {filePath,portablePath,digest,snapshot} from './workspace.mjs';
import {writeDurableJson} from './durable-json.mjs';
const zip=promisify(gzip),unzip=promisify(gunzip);
const MAX_TEXT=128*1024,MAX_TOTAL=1024*1024;
const textExtensions=new Set('txt md markdown html htm css scss js mjs cjs jsx ts tsx json jsonc yaml yml toml xml svg csv tsv sql py rb rs go c cpp h java sh zsh bat ps1 swift kt dart vue svelte conf ini'.split(' '));
const key=value=>{if(typeof value!=='string'||!/^[-a-zA-Z0-9]{1,100}$/.test(value))throw Object.assign(new Error('Недопустимый идентификатор просмотра.'),{status:400});return value;};
function textCandidate(file){return file.size<=MAX_TEXT&&(textExtensions.has(path.extname(file.path).slice(1).toLowerCase())||/^(?:Dockerfile|Makefile|LICENSE|README)$/.test(path.basename(file.path)));}
async function readText(root,file,budget){
 if(!textCandidate(file))return {reason:file.size>MAX_TEXT?'Для этого файла доступен список изменений; текст слишком большой.':'Для двоичного файла доступен список изменений.'};
 if(file.size>budget)return {reason:'Текстовый бюджет просмотра исчерпан; файл сохранён полностью.'};
 try{const handle=await fs.open(await filePath(root,file.path),'r');try{const st=await handle.stat();if(!st.isFile()||st.size>MAX_TEXT)return {reason:'Файл изменился во время чтения.'};const chunks=[];let size=0;for await(const chunk of handle.createReadStream({autoClose:false})){size+=chunk.length;if(size>MAX_TEXT)return {reason:'Версия файла изменилась во время чтения.'};chunks.push(chunk);}const bytes=Buffer.concat(chunks);if(digest(bytes)!==file.hash)return {reason:'Версия файла изменилась во время чтения.'};let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return {reason:'Файл содержит двоичные данные или другую кодировку.'};}if(text.includes('\0'))return {reason:'Двоичный файл.'};return {text,bytes:bytes.length};}finally{await handle.close();}}catch(error){if(['ENOENT','SYMLINK_PATH'].includes(error.code))return {reason:'Версия файла недоступна.'};throw error;}
}
// Bounded Myers diff. Large rewrites fall back to a correct replacement block,
// rather than allocating an N×M matrix on the server event loop.
export function diffLines(before,after,{maxRows=1600,maxDistance=240}={}){
 const a=before?before.split('\n'):[],b=after?after.split('\n'):[];let prefix=0,suffix=0;
 if(a.length>8000||b.length>8000){const half=Math.floor(maxRows/2);return {lines:[...a.slice(0,half).map((text,i)=>({kind:'remove',text,oldLine:i+1,newLine:null})),...b.slice(0,maxRows-half).map((text,i)=>({kind:'add',text,oldLine:null,newLine:i+1,gapBefore:i===0}))],truncated:true,fallback:true,added:b.length,removed:a.length};}
 while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
 while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
 const x=a.slice(prefix,a.length-suffix),y=b.slice(prefix,b.length-suffix);let ops=[],fallback=false;
 if(x.length&&y.length){let v=new Map([[1,0]]),trace=[],found=-1,work=0;
  outer:for(let d=0;d<=Math.min(maxDistance,x.length+y.length);d++){trace.push(new Map(v));for(let k=-d;k<=d;k+=2){let i=k===-d||k!==d&&(v.get(k-1)??-1)<(v.get(k+1)??-1)?(v.get(k+1)??0):(v.get(k-1)??0)+1;let j=i-k;while(i<x.length&&j<y.length&&x[i]===y[j]){i++;j++;if(++work>2_000_000)break outer;}v.set(k,i);if(i>=x.length&&j>=y.length){found=d;break outer;}}}
  if(found>=0){let i=x.length,j=y.length;for(let d=found;d>=0;d--){const old=trace[d],k=i-j,prev=k===-d||k!==d&&(old.get(k-1)??-1)<(old.get(k+1)??-1)?k+1:k-1,pi=old.get(prev)??0,pj=pi-prev;while(i>pi&&j>pj){ops.push({kind:'context',text:x[--i]});j--;}if(d){if(i===pi)ops.push({kind:'add',text:y[--j]});else ops.push({kind:'remove',text:x[--i]});}}ops.reverse();}
  else{fallback=true;ops=[...x.map(text=>({kind:'remove',text})),...y.map(text=>({kind:'add',text}))];}
 }else ops=[...x.map(text=>({kind:'remove',text})),...y.map(text=>({kind:'add',text}))];
 const all=[...a.slice(0,prefix).map(text=>({kind:'context',text})),...ops,...a.slice(a.length-suffix).map(text=>({kind:'context',text}))];let old=1,next=1;
 for(const row of all){row.oldLine=row.kind==='add'?null:old++;row.newLine=row.kind==='remove'?null:next++;}
 const wanted=new Set();for(let i=0;i<all.length;i++)if(all[i].kind!=='context')for(let j=Math.max(0,i-3);j<=Math.min(all.length-1,i+3);j++)wanted.add(j);
 const lines=[];let previous=-1;for(const i of wanted){if(lines.length>=maxRows)break;const row=all[i];lines.push({...row,gapBefore:previous>=0&&i>previous+1});previous=i;}
 return {lines,truncated:wanted.size>lines.length,fallback,added:ops.filter(o=>o.kind==='add').length,removed:ops.filter(o=>o.kind==='remove').length};
}

export class FileReviews{
 constructor(directory,{maxRecords=80,maxStoredBytes=128*1024*1024}={}){this.directory=directory;this.maxRecords=maxRecords;this.maxStoredBytes=maxStoredBytes;}
 filename(chatId){return path.join(this.directory,key(chatId)+'.json.gz');}
 async load(chatId){try{return JSON.parse((await unzip(await fs.readFile(this.filename(chatId)),{maxOutputLength:8*1024*1024})).toString('utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
 async save(chatId,record){await fs.mkdir(this.directory,{recursive:true,mode:0o700});await writeDurableJson(this.filename(chatId),await zip(Buffer.from(JSON.stringify(record))));}
 async captureBefore(root,chatId,runId,files){
  key(runId);const record={version:1,runId,startedAt:new Date().toISOString(),state:'running',before:[],after:null},previous=await this.load(chatId),reusable=new Map([...(previous?.before||[]),...(previous?.after||[])].filter(f=>f.text!==undefined).map(f=>[f.hash,f.text]));let budget=MAX_TOTAL,reads=0;
  for(const file of files){portablePath(file.path);const item={path:file.path,hash:file.hash,size:file.size};let body;if(reusable.has(file.hash)&&file.size<=budget)body={text:reusable.get(file.hash),bytes:file.size};else if(reads>=256&&textCandidate(file))body={reason:'Для остальных файлов доступен список изменений; лимит чтения достигнут.'};else{if(textCandidate(file)&&file.size<=budget)reads++;body=await readText(root,file,budget);}if(body.text!==undefined){item.text=body.text;budget-=body.bytes;}else item.reason=body.reason;record.before.push(item);}
  await this.save(chatId,record);await this.prune();
 }
 async captureAfter(root,chatId,runId,files){const record=await this.load(chatId);if(!record||record.runId!==runId)return;record.after=await this.readAfter(root,record,files);record.state='completed';record.completedAt=new Date().toISOString();await this.save(chatId,record);}
 async readAfter(root,record,files){let budget=MAX_TOTAL;const previous=new Map(record.before.map(f=>[f.path,f]));const after=[];for(const file of files){portablePath(file.path);const item={path:file.path,hash:file.hash,size:file.size};if(previous.get(file.path)?.hash!==file.hash){const body=await readText(root,file,budget);if(body.text!==undefined){item.text=body.text;budget-=body.bytes;}else item.reason=body.reason;}after.push(item);}return after;}
 async view(root,chatId,name){const record=await this.load(chatId);if(!record)return {available:false,files:[],reason:'Просмотр изменений появится после следующего запроса в этом чате.'};const after=record.after||await this.readAfter(root,record,await snapshot(root));const old=new Map(record.before.map(f=>[f.path,f])),next=new Map(after.map(f=>[f.path,f]));const files=[];
  for(const p of new Set([...old.keys(),...next.keys()])){const a=old.get(p),b=next.get(p);if(a?.hash===b?.hash)continue;files.push({path:p,status:!a?'added':!b?'deleted':'modified',beforeHash:a?.hash||null,afterHash:b?.hash||null,reviewable:(!a||a.text!==undefined)&&(!b||b.text!==undefined),reason:a?.reason||b?.reason||null});}
  const result={available:true,runId:record.runId,startedAt:record.startedAt,completedAt:record.completedAt||null,state:record.state,files};if(name){name=portablePath(name);const f=files.find(f=>f.path===name);if(!f)throw Object.assign(new Error('Изменение файла не найдено.'),{status:404});Object.assign(result,f);if(f.reviewable)Object.assign(result,diffLines(old.get(name)?.text||'',next.get(name)?.text||''));else result.lines=[];}return result;
 }
 async remove(chatId){await fs.rm(this.filename(chatId),{force:true});}
 async prune(){const names=(await fs.readdir(this.directory)).filter(n=>/^[-a-zA-Z0-9]{1,100}\.json\.gz$/.test(n));const entries=await Promise.all(names.map(async name=>({name,...await fs.stat(path.join(this.directory,name))})));entries.sort((a,b)=>b.mtimeMs-a.mtimeMs);let total=0;for(let i=0;i<entries.length;i++){total+=entries[i].size;if(i>=this.maxRecords||total>this.maxStoredBytes)await fs.rm(path.join(this.directory,entries[i].name),{force:true});}}
}
