import fs from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {filePath,MAX_FILE} from './workspace.mjs';

const types={html:'text/html; charset=utf-8',htm:'text/html; charset=utf-8',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp',gif:'image/gif',avif:'image/avif',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',pdf:'application/pdf',txt:'text/plain; charset=utf-8',md:'text/plain; charset=utf-8',csv:'text/plain; charset=utf-8',json:'application/json; charset=utf-8'};
// HTML runs in an opaque sandbox, without access to Team Room or the network.
const htmlPolicy="sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export function annotationScript(channel){
 if(!/^[a-zA-Z0-9-]{16,80}$/.test(channel))throw Object.assign(new Error('Недопустимый канал превью.'),{status:400});
 return `<script>(()=>{let timer;const publish=()=>{const text=String(getSelection()||'').trim().slice(0,4000);parent.postMessage({type:'team-room-preview-selection',channel:${JSON.stringify(channel)},text},'*');};document.addEventListener('selectionchange',()=>{clearTimeout(timer);timer=setTimeout(publish,140)});document.addEventListener('pointerup',publish);})();</script>`;
}
const escapeText=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
export async function serveSharedFile(req,res,root,name,preview=false,annotationChannel=''){
 const full=await filePath(root,name),handle=await fs.open(full,'r');
 try{
  const stat=await handle.stat();
  if(!stat.isFile())throw Object.assign(new Error('Файл не найден.'),{status:404});
  if(stat.size>MAX_FILE)throw Object.assign(new Error('Файл превышает допустимый размер.'),{status:413});
  const ext=path.extname(name).slice(1).toLowerCase(),inline=preview&&Boolean(types[ext]);
  // Only an explicitly opened preview gets the tiny selection bridge. It remains
  // opaque: no allow-same-origin, cookies, parent DOM or network access.
  if(preview&&annotationChannel&&['html','htm','txt','md','csv','json'].includes(ext)&&stat.size<=2*1024*1024&&!req.headers.range){
   const script=annotationScript(annotationChannel),chunks=[];let bytes=0;for await(const chunk of handle.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>2*1024*1024)throw Object.assign(new Error('Файл изменился. Открой превью ещё раз.'),{status:409});chunks.push(chunk);}const source=Buffer.concat(chunks).toString('utf8'),body=['html','htm'].includes(ext)?source+script:`<!doctype html><meta charset="utf-8"><style>body{background:#191919;color:#e8e6df;padding:18px;font:15px/1.55 ui-monospace,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><pre>${escapeText(source)}</pre>${script}`;
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-length':Buffer.byteLength(body),'content-security-policy':htmlPolicy,'cache-control':'private, no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','cross-origin-resource-policy':'same-origin'});return res.end(req.method==='HEAD'?undefined:body);
  }
  const headers={'content-type':types[ext]||'application/octet-stream','content-disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(name))}`,'content-length':stat.size,'cache-control':'private, no-store','accept-ranges':'bytes','x-content-type-options':'nosniff','referrer-policy':'no-referrer','cross-origin-resource-policy':'same-origin'};
  if(inline)headers['content-security-policy']=['html','htm'].includes(ext)?htmlPolicy:"sandbox; default-src 'none'; frame-ancestors 'self'";
  let start=0,end=stat.size-1,status=200;
  if(req.headers.range){
   const match=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
   if(!match||(!match[1]&&!match[2])){res.writeHead(416,{...headers,'content-range':`bytes */${stat.size}`,'content-length':0});return res.end();}
   if(match[1]){start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;}
   else{const length=Number(match[2]);start=Math.max(0,stat.size-length);}
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=stat.size){res.writeHead(416,{...headers,'content-range':`bytes */${stat.size}`,'content-length':0});return res.end();}
   status=206;headers['content-range']=`bytes ${start}-${end}/${stat.size}`;headers['content-length']=end-start+1;
  }
  res.writeHead(status,headers);
  if(req.method==='HEAD'||stat.size===0)return res.end();
  try{await pipeline(handle.createReadStream({start,end,autoClose:false}),res);}
  catch(error){if(!res.destroyed)res.destroy(error);}
 }finally{await handle.close();}
}
