import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';
import {fail} from './security.mjs';

const endpointId=value=>crypto.createHash('sha256').update(value).digest('hex');
const defaults={questions:true,completed:true,failed:true,scope:'all',preview:false};
function preferences(input={}){return {...Object.fromEntries(['questions','completed','failed','preview'].map(k=>[k,typeof input[k]==='boolean'?input[k]:defaults[k]])),scope:input.scope==='mine'?'mine':'all'};}
// Only browser push services may be contacted. Never follow redirects or accept
// arbitrary endpoints: subscriptions otherwise become an authenticated SSRF.
export function validateSubscription(value){
 let url;try{url=new URL(value?.endpoint)}catch{throw fail(400,'Некорректная подписка уведомлений.');}
 const allowed=url.hostname==='web.push.apple.com'||url.hostname.endsWith('.push.apple.com')||url.hostname==='fcm.googleapis.com'||url.hostname==='updates.push.services.mozilla.com';
 if(!allowed||url.protocol!=='https:'||url.port||url.username||url.password||url.hash||url.href.length>2048)throw fail(400,'Неизвестная служба уведомлений.');
 const keys=value?.keys;if(!keys||!Object.values(keys).every(v=>typeof v==='string'&&/^[A-Za-z0-9_-]+={0,2}$/.test(v))||Buffer.from(keys.p256dh||'','base64url').length!==65||Buffer.from(keys.auth||'','base64url').length!==16)throw fail(400,'Некорректные ключи уведомлений.');
 return {endpoint:url.href,keys:{p256dh:keys.p256dh,auth:keys.auth}};
}
export function responseNeedsAnswer(text){
 const tail=String(text||'').replace(/```[\s\S]*?```/g,'').trim().slice(-650);
 return /(?:ответь|уточни|подтверди|пришли|дай доступ|нужен твой|нужно твоё|жду тво|выбери|какой вариант|как продолжим)/i.test(tail)||/\?\s*(?:\*\*)?\s*$/.test(tail);
}
export class Notifications {
 constructor(storage,{sessions=()=>[],users=()=>[],alive=()=>true,origin='http://127.0.0.1:4173'}={}){Object.assign(this,{sessions,users,alive,origin});this.filename=path.join(storage,'push-notifications.json');this.tail=Promise.resolve();this.running=false;}
 async init(){
  try{this.data=JSON.parse(await fs.readFile(this.filename,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;this.data={keys:webpush.generateVAPIDKeys(),subscriptions:[],seen:[],queue:[]};await this.save();}
  this.data.queue||=[];this.timer=setInterval(()=>void this.drain().catch(()=>{}),30000);this.timer.unref();void this.drain().catch(()=>{});return this;
 }
 save(){const body=JSON.stringify(this.data);this.tail=this.tail.catch(()=>{}).then(async()=>{await fs.writeFile(this.filename+'.tmp',body,{mode:0o600});await fs.rename(this.filename+'.tmp',this.filename)});return this.tail;}
 valid(record){return this.users().some(u=>u.id===record.userId)&&this.sessions().some(s=>s.tokenHash===record.sessionHash&&s.userId===record.userId&&s.expiresAt>Date.now());}
 config(userId,sessionHash){return {subscriptions:this.data.subscriptions.filter(s=>s.userId===userId&&s.sessionHash===sessionHash&&this.valid(s)).map(s=>({id:s.id,preferences:s.preferences})),publicKey:this.data.keys.publicKey,enabled:this.data.subscriptions.some(s=>s.userId===userId&&s.sessionHash===sessionHash&&this.valid(s)),defaults};}
 async subscribe(userId,sessionHash,input){
  const subscription=validateSubscription(input.subscription),id=endpointId(subscription.endpoint);
  this.data.subscriptions=this.data.subscriptions.filter(s=>s.id!==id&&this.valid(s));
  if(this.data.subscriptions.length>=120||this.data.subscriptions.filter(s=>s.userId===userId).length>=12)throw fail(429,'Слишком много устройств с уведомлениями. Отключи уведомления на старом устройстве.');
  this.data.subscriptions.push({id,userId,sessionHash,subscription,preferences:preferences(input.preferences),updatedAt:Date.now()});await this.save();return {ok:true,id};
 }
 async unsubscribe(userId,id){this.data.subscriptions=this.data.subscriptions.filter(s=>s.userId!==userId||s.id!==id);await this.save();return {ok:true};}
 async revokeSession(hash){this.data.subscriptions=this.data.subscriptions.filter(s=>s.sessionHash!==hash);await this.save();}
 async enqueue(event){
  if(this.data.seen.includes(event.id))return;
  this.data.seen.push(event.id);this.data.seen=this.data.seen.slice(-3000);
  const targets=this.data.subscriptions.filter(s=>this.valid(s)&&(!event.demoUser||s.userId===event.demoUser)&&(event.demoUser||s.preferences[event.kind])&&(s.preferences.scope==='all'||event.userIds.includes(s.userId))).map(s=>s.id);
  if(targets.length){this.data.queue.push({event,targets,delivered:[],attempts:0,nextAt:Date.now(),expiresAt:Date.now()+15*60000});this.data.queue=this.data.queue.slice(-200);}
  await this.save();if(this.running)this.again=true;void this.drain().catch(()=>{});
 }
 async drain(){
  if(this.running)return;this.running=true;
  try{
   for(const job of [...this.data.queue]){
    if(job.nextAt>Date.now())continue;
    if(job.expiresAt<=Date.now()||!this.alive(job.event)){this.data.queue=this.data.queue.filter(x=>x!==job);continue;}
    for(const id of job.targets.filter(id=>!job.delivered.includes(id))){
     const record=this.data.subscriptions.find(s=>s.id===id);
     if(!record||!this.valid(record)||(!job.event.demoUser&&!record.preferences[job.event.kind])||(record.preferences.scope==='mine'&&!job.event.userIds.includes(record.userId))){job.delivered.push(id);continue;}
     const e=job.event,name=e.provider==='claude'?'Claude':'Codex';
     const title=e.demoUser?'Team Room · уведомления работают':e.kind==='questions'?name+' ждёт ответа':e.kind==='failed'?'Работа требует внимания':name+' завершил работу';
     const body=e.demoUser?'Это проверочное уведомление. Нажми, чтобы открыть выбранный чат.':record.preferences.preview?e.title:'Открой Team Room, чтобы '+(e.kind==='questions'?'ответить и продолжить.':e.kind==='failed'?'посмотреть причину и продолжить.':'прочитать ответ и открыть файлы.');
     try{await webpush.sendNotification(record.subscription,JSON.stringify({title,body,tag:e.id,url:'/room/?project='+encodeURIComponent(e.projectId)+'&chat='+encodeURIComponent(e.chatId)}),{TTL:900,urgency:e.kind==='questions'?'high':'normal',timeout:8000,vapidDetails:{subject:this.origin,publicKey:this.data.keys.publicKey,privateKey:this.data.keys.privateKey}});job.delivered.push(id);}
     catch(error){if([400,401,403,404,410].includes(error.statusCode)){this.data.subscriptions=this.data.subscriptions.filter(s=>s.id!==id);job.delivered.push(id);}}
    }
    job.attempts++;job.nextAt=Date.now()+Math.min(300000,30000*2**job.attempts);
    if(job.delivered.length===job.targets.length||job.attempts>=4)this.data.queue=this.data.queue.filter(x=>x!==job);
    await this.save();
   }
   this.data.subscriptions=this.data.subscriptions.filter(s=>this.valid(s));await this.save();
  }finally{this.running=false;if(this.again){this.again=false;queueMicrotask(()=>void this.drain().catch(()=>{}));}}
 }
 close(){clearInterval(this.timer);}
}
