import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {filePath,portablePath,MAX_FILE} from './workspace.mjs';
import {serveSharedFile} from './shared-file.mjs';
import {fail} from './security.mjs';

// Scoped read capabilities bridge separate PWA/Safari cookie stores. Tokens
// expire, grant no account access, and cannot name any file other than the one
// validated at issuance. Only hashed tokens are retained in server memory.
export class FileOpenLinks {
 constructor({clock=Date.now,lifetime=5*60*1000,limit=2000}={}){Object.assign(this,{clock,lifetime,limit});this.links=new Map();}
 prune(){for(const [key,value]of this.links)if(value.expiresAt<=this.clock())this.links.delete(key);}
 async issue(root,name,owner){
  this.prune();if(this.links.size>=this.limit)throw fail(429,'Слишком много открытых ссылок. Попробуй позже.');
  const relative=portablePath(name),stat=await fs.stat(await filePath(root,relative));
  if(!stat.isFile())throw fail(404,'Файл не найден.');if(stat.size>MAX_FILE)throw fail(413,'Файл превышает допустимый размер.');
  const token=crypto.randomBytes(32).toString('base64url'),expiresAt=this.clock()+this.lifetime;
  this.links.set(this.hash(token),{root,name:relative,owner,expiresAt});
  return {url:'/open/'+token,expiresAt};
 }
 hash(value){return crypto.createHash('sha256').update(value).digest('hex');}
 revoke(owner){for(const [key,value]of this.links)if(value.owner===owner)this.links.delete(key);}
 async serve(req,res,token){
  this.prune();const link=/^[A-Za-z0-9_-]{43}$/.test(token)&&this.links.get(this.hash(token));
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'allow':'GET, HEAD'});return res.end();}
  if(!link){res.writeHead(410,{'content-type':'text/plain; charset=utf-8'});return res.end(req.method==='HEAD'?undefined:'Ссылка истекла. Вернись в Team Room и снова нажми «В браузере».');}
  return serveSharedFile(req,res,link.root,link.name,true);
 }
}
