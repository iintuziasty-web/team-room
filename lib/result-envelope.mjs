import fs from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Readable,Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {TextDecoder} from 'node:util';
import {OutgoingResults,IncomingResults} from './result-transfer.mjs';
import {internalDirectory,filePath} from './workspace.mjs';
import {writeDurableJson,syncDirectory} from './durable-json.mjs';

export const RESULT_ENVELOPE_THRESHOLD_BYTES=8*1024*1024;
export const MAX_RESULT_ENVELOPE_DECODED_BYTES=128*1024*1024;
export const MAX_RESULT_ENVELOPE_COMPRESSED_BYTES=64*1024*1024;
const ENVELOPE_FILE='result.json.gz';
const DESCRIPTOR_FILE='envelope.json';
const MAX_DESCRIPTOR_BYTES=4096;
const SHA256=/^[a-f0-9]{64}$/;
const fail=(message,status=400,code='RESULT_ENVELOPE_INVALID')=>Object.assign(new Error(message),{status,code});
const tooLarge=()=>fail('Метаданные результата превышают допустимый размер. Полный результат сохранён на компьютере.',413,'RESULT_ENVELOPE_TOO_LARGE');
function validateRun(runId){if(typeof runId!=='string'||!/^[a-zA-Z0-9_-]{1,240}$/.test(runId))throw fail('Недопустимый запуск передачи результата.');}
function validateResult(runId,result){validateRun(runId);if(!result||typeof result!=='object'||Array.isArray(result)||result.type!=='turn-result'||result.runId!==runId)throw fail('Результат не соответствует запуску передачи.');}
function serializeResult(result,serialized){let text=serialized;if(text===undefined)try{text=JSON.stringify(result);}catch{throw fail('Не удалось сохранить метаданные результата.');}if(typeof text!=='string')throw fail('Некорректные метаданные результата.');const size=Buffer.byteLength(text);if(size>MAX_RESULT_ENVELOPE_DECODED_BYTES)throw tooLarge();return {text,size};}

// Callers may pass an already serialized packet to avoid a second stringify.
export function resultEnvelopeRequired(result){const {size}=typeof result==='string'?{size:Buffer.byteLength(result)}:serializeResult(result);if(size>MAX_RESULT_ENVELOPE_DECODED_BYTES)throw tooLarge();return size>RESULT_ENVELOPE_THRESHOLD_BYTES;}
export function validateResultEnvelope(runId,envelope){
 validateRun(runId);
 if(!envelope||envelope.version!==1||envelope.encoding!=='gzip'||envelope.type!=='turn-result'||envelope.runId!==runId||!Number.isSafeInteger(envelope.size)||envelope.size<1||envelope.size>MAX_RESULT_ENVELOPE_DECODED_BYTES||typeof envelope.hash!=='string'||!SHA256.test(envelope.hash)||envelope.file?.path!==ENVELOPE_FILE||!Number.isSafeInteger(envelope.file.size)||envelope.file.size<1||envelope.file.size>MAX_RESULT_ENVELOPE_COMPRESSED_BYTES||typeof envelope.file.hash!=='string'||!SHA256.test(envelope.file.hash))throw fail('Некорректный пакет метаданных результата.');
 return {version:1,encoding:'gzip',type:'turn-result',runId,size:envelope.size,hash:envelope.hash,file:{path:ENVELOPE_FILE,size:envelope.file.size,hash:envelope.file.hash}};
}
const sameEnvelope=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const sameFile=(left,right)=>left?.path===right.path&&left.size===right.size&&left.hash===right.hash;
function* textChunks(text){
 // A UTF-16 surrogate pair must stay in one UTF-8 conversion.
 for(let start=0;start<text.length;){let end=Math.min(start+65536,text.length);if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;yield Buffer.from(text.slice(start,end));start=end;}
}
function meter(limit,digest,onSize){let size=0;return new Transform({transform(bytes,encoding,done){size+=bytes.length;if(size>limit)return done(tooLarge());digest.update(bytes);onSize(size);done(null,bytes);}});}
async function regular(filename){const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink())throw fail('Файл метаданных результата повреждён.');return stat;}

// Roots must be dedicated internal spools outside portable workspaces. These
// stores are never cleaned automatically: only the caller's durable result ACK
// authorizes cleanup, just as for ordinary outgoing/incoming result files.
class ResultEnvelopes{
 constructor(root,Store){this.root=path.resolve(root);this.transfers=new Store(this.root);}
 async directory(runId){validateRun(runId);const dir=await internalDirectory(this.root,runId);await fs.chmod(this.root,0o700);await fs.chmod(dir,0o700);return dir;}
 async readEnvelope(runId){
  const dir=await this.directory(runId),filename=path.join(dir,DESCRIPTOR_FILE),stat=await regular(filename);
  if(stat.size>MAX_DESCRIPTOR_BYTES)throw fail('Пакет метаданных результата повреждён.');
  const handle=await fs.open(filename,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW||0));
  try{const opened=await handle.stat();if(!opened.isFile()||opened.dev!==stat.dev||opened.ino!==stat.ino)throw fail('Пакет метаданных результата изменился.');const bytes=Buffer.alloc(MAX_DESCRIPTOR_BYTES+1),{bytesRead}=await handle.read(bytes,0,bytes.length,0);if(bytesRead>MAX_DESCRIPTOR_BYTES)throw fail('Пакет метаданных результата повреждён.');let envelope;try{envelope=JSON.parse(bytes.subarray(0,bytesRead).toString('utf8'));}catch{throw fail('Пакет метаданных результата повреждён.');}return validateResultEnvelope(runId,envelope);}finally{await handle.close();}
 }
 async sync(runId){await syncDirectory(await this.directory(runId));await syncDirectory(this.root);}
 async cleanup(runId){validateRun(runId);await this.transfers.cleanup(runId);await syncDirectory(this.root);}
}

export class OutgoingResultEnvelopes extends ResultEnvelopes{
 constructor(root){super(root,OutgoingResults);this.preparations=new Map();this.envelopes=new Map();}
 prepare(runId,result,serializedJSON){
  validateRun(runId);const saved=this.envelopes.get(runId);if(saved)return Promise.resolve(validateResultEnvelope(runId,saved));const existing=this.preparations.get(runId);if(existing)return existing;
  validateResult(runId,result);
  // Freeze every event and field before any await; no later live object can
  // change the metadata captured for this completed native turn.
  // An optional JSON snapshot must come from this same result; it lets the
  // connector reuse the serialization it already measured for wire delivery.
  const serialized=serializeResult(result,serializedJSON);
  const operation=this.prepareFrozen(runId,serialized);this.preparations.set(runId,operation);operation.then(envelope=>{this.envelopes.set(runId,validateResultEnvelope(runId,envelope));if(this.preparations.get(runId)===operation)this.preparations.delete(runId);},()=>{if(this.preparations.get(runId)===operation)this.preparations.delete(runId);});return operation;
 }
 async cleanup(runId){validateRun(runId);this.envelopes.delete(runId);await super.cleanup(runId);}
 async prepareFrozen(runId,serialized){
  const dir=await this.directory(runId),source=await internalDirectory(this.root,runId,'.source');await fs.chmod(source,0o700);
  let envelope;
  try{envelope=await this.readEnvelope(runId);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(envelope){
   // A descriptor is sealed before the transfer manifest. If the process
   // stopped between those writes, resume from the preserved gzip source.
   const files=await this.transfers.prepare(runId,source,[envelope.file]);if(files.length!==1||!sameFile(files[0],envelope.file))throw fail('Сохранённый пакет результата содержит другие данные.');await this.sync(runId);return validateResultEnvelope(runId,envelope);
  }
  const filename=await filePath(source,ENVELOPE_FILE),temporary=path.join(source,crypto.randomUUID()+'.tmp');let handle;
  try{
   handle=await fs.open(temporary,'wx',0o600);const decoded=crypto.createHash('sha256'),compressed=crypto.createHash('sha256');let decodedSize=0,compressedSize=0;
   // A FileHandle write stream with autoClose:false can leave pipeline waiting
   // for close forever. This sink finishes independently; the handle remains
   // open for the explicit durable sync immediately after pipeline completes.
   const sink=new Writable({write(bytes,encoding,done){handle.writeFile(bytes).then(()=>done(),done);}});
   await pipeline(Readable.from(textChunks(serialized.text)),meter(MAX_RESULT_ENVELOPE_DECODED_BYTES,decoded,size=>{decodedSize=size;}),createGzip({level:6}),meter(MAX_RESULT_ENVELOPE_COMPRESSED_BYTES,compressed,size=>{compressedSize=size;}),sink);
   if(decodedSize!==serialized.size)throw fail('Метаданные результата изменились во время сохранения.');await handle.sync();await handle.close();handle=null;await fs.rename(temporary,filename);await syncDirectory(source);
   envelope=validateResultEnvelope(runId,{version:1,encoding:'gzip',type:'turn-result',runId,size:decodedSize,hash:decoded.digest('hex'),file:{path:ENVELOPE_FILE,size:compressedSize,hash:compressed.digest('hex')}});
   // Keep the source and descriptor until durable ACK. A failed or interrupted
   // manifest write can then resume without recompressing a changed object.
   await writeDurableJson(path.join(dir,DESCRIPTOR_FILE),envelope);await syncDirectory(this.root);
   await this.transfers.prepare(runId,source,[envelope.file]);await this.sync(runId);return validateResultEnvelope(runId,envelope);
  }finally{await handle?.close().catch(()=>{});await fs.rm(temporary,{force:true}).catch(()=>{});}
 }
 async readChunk(runId,offset){const envelope=await this.readEnvelope(runId);return this.transfers.readChunk(runId,envelope.file.path,offset);}
}

export class IncomingResultEnvelopes extends ResultEnvelopes{
 constructor(root){super(root,IncomingResults);}
 async status(runId,input){
  const envelope=validateResultEnvelope(runId,input);let saved;
  try{saved=await this.readEnvelope(runId);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(saved&&!sameEnvelope(saved,envelope))throw fail('Пакет метаданных результата изменился.',409);
  const state=await this.transfers.status(runId,[envelope.file]);
  if(!saved)await writeDurableJson(path.join(await this.directory(runId),DESCRIPTOR_FILE),envelope);
  // Existing transfer stores fsync bytes. Also persist the directory entries
  // before confirming manifest/chunk durability to the sender.
  await this.sync(runId);return {...state,offset:state.files[0].offset};
 }
 async chunk(runId,input){
  const envelope=await this.readEnvelope(runId);if(input?.runId!==undefined&&input.runId!==runId||input?.path!==envelope.file.path||input?.hash!==envelope.file.hash)throw fail('Часть метаданных результата не соответствует запуску.');
  const state=await this.transfers.chunk(runId,input);await this.sync(runId);return state;
 }
 async load(runId,input){
  const envelope=validateResultEnvelope(runId,input),saved=await this.readEnvelope(runId);if(!sameEnvelope(saved,envelope))throw fail('Пакет метаданных результата изменился.',409);
  const results=await this.transfers.apply(runId,{changed:[envelope.file],deleted:[]},async delta=>{
   const decoded=crypto.createHash('sha256'),compressed=crypto.createHash('sha256'),decoder=new TextDecoder('utf-8',{fatal:true});let decodedSize=0,compressedSize=0,parts=[];
   const output=new Writable({write(bytes,encoding,done){try{decodedSize+=bytes.length;if(decodedSize>MAX_RESULT_ENVELOPE_DECODED_BYTES||decodedSize>envelope.size)throw tooLarge();decoded.update(bytes);const text=decoder.decode(bytes,{stream:true});if(text)parts.push(text);done();}catch(error){done(error);}}});
   // Read the immutable compressed spool as a stream. Both byte counts and
   // hashes are checked again while decoding, including the gzip trailer/CRC.
   await pipeline(delta.changed[0].source(),meter(Math.min(MAX_RESULT_ENVELOPE_COMPRESSED_BYTES,envelope.file.size),compressed,size=>{compressedSize=size;}),createGunzip(),output);
   let tail;try{tail=decoder.decode();}catch{throw fail('Метаданные результата содержат некорректный текст.');}if(tail)parts.push(tail);
   if(compressedSize!==envelope.file.size||compressed.digest('hex')!==envelope.file.hash||decodedSize!==envelope.size||decoded.digest('hex')!==envelope.hash)throw fail('Контрольная сумма метаданных результата не совпадает.');
   const text=parts.join('');parts=null;let result;try{result=JSON.parse(text);}catch{throw fail('Метаданные результата повреждены.');}validateResult(runId,result);return result;
  },{stream:true});
  if(results.length!==1)throw fail('Некорректный пакет метаданных результата.');return results[0];
 }
}
