import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const fail=(status,message)=>Object.assign(new Error(message),{status});
export const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,240}$/.test(value);
export const validMessageId=value=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
export function cookieValue(req,name){return String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1)||'';}
export function secureCookie(name,value,maxAge,secure=false){return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure?'; Secure':''}`;}
export function sameOrigin(req,canonical){
 if(req.headers['sec-fetch-site']==='cross-site')return false;
 if(!req.headers.origin)return true; // Authenticated CLI requests have no browser Origin.
 try{const origin=new URL(req.headers.origin);return origin.origin===(canonical||`${req.socket.encrypted?'https':'http'}://${req.headers.host}`);}catch{return false;}
}
export class RateLimiter{
 constructor({clock=Date.now,maxKeys=5000}={}){this.clock=clock;this.maxKeys=maxKeys;this.rows=new Map();}
 take(key,limit,windowMs){const at=this.clock();for(const [k,v] of this.rows)if(v.until<=at)this.rows.delete(k);let row=this.rows.get(key);if(!row){if(this.rows.size>=this.maxKeys)throw fail(429,'Слишком много запросов. Попробуй позже.');row={until:at+windowMs,count:0};this.rows.set(key,row);}if(++row.count>limit)throw fail(429,'Слишком много попыток. Подожди и попробуй снова.');}
}
export function securityHeaders(res,https=false,{microphone=false}={}){
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Permissions-Policy',`camera=(), microphone=${microphone?'(self)':'()'}, geolocation=()`);
 res.setHeader('X-Frame-Options','SAMEORIGIN');
 if(https)res.setHeader('Strict-Transport-Security','max-age=31536000');
}
export const appCsp="default-src 'self'; script-src 'self'; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export class TelegramAuth{
 constructor({storage,clock=Date.now,deliver}={}){this.storage=storage;this.clock=clock;this.deliver=deliver||this.sendTelegram.bind(this);this.challenges=new Map();this.pepper=crypto.randomBytes(32);this.limiter=new RateLimiter({clock});this.saveTail=Promise.resolve();}
 async init(){
  this.keyPath=path.join(this.storage,'security-key');this.configPath=path.join(this.storage,'security-config.json');
  try{this.key=await fs.readFile(this.keyPath);}catch(error){if(error.code!=='ENOENT')throw error;this.key=crypto.randomBytes(32);try{await fs.writeFile(this.keyPath,this.key,{mode:0o600,flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;this.key=await fs.readFile(this.keyPath);}}
  if(this.key.length!==32)throw new Error('Security key is invalid. Restore the saved key.');
  try{const stored=JSON.parse(await fs.readFile(this.configPath,'utf8'));const decipher=crypto.createDecipheriv('aes-256-gcm',this.key,Buffer.from(stored.iv,'hex'));decipher.setAuthTag(Buffer.from(stored.tag,'hex'));this.config=JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.encrypted,'base64')),decipher.final()]).toString());}catch(error){if(error.code!=='ENOENT')throw new Error('Telegram security configuration cannot be read. Restore it; password fallback is disabled.');}
  if(process.env.TEAM_ROOM_TELEGRAM_BOT_TOKEN&&process.env.TEAM_ROOM_TELEGRAM_CHAT_ID)this.config={...this.config,token:process.env.TEAM_ROOM_TELEGRAM_BOT_TOKEN,chatId:process.env.TEAM_ROOM_TELEGRAM_CHAT_ID,enabled:true};
  return this;
 }
 status(){return {telegramEnabled:Boolean(this.config?.enabled),botUsername:this.config?.username||null};}
 async writeConfig(config){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);const encrypted=Buffer.concat([cipher.update(JSON.stringify(config)),cipher.final()]);const target=this.configPath+'.tmp';await fs.writeFile(target,JSON.stringify({iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),encrypted:encrypted.toString('base64')}),{mode:0o600});await fs.rename(target,this.configPath);this.config=config;}
 save(config){return this.edit(()=>config);}
 edit(change){const task=this.saveTail.catch(()=>{}).then(async()=>{const config=change(structuredClone(this.config||{}));await this.writeConfig(config);return config;});this.saveTail=task;return task;}
 deliveryConfig(userId,name){const row=(this.config?.recipients||[]).find(r=>r.state==='active'&&((r.userId&&r.userId===userId)||r.accountName.toLocaleLowerCase()===String(name||'').trim().normalize('NFC').toLocaleLowerCase()));return {...this.config,...(row?{chatId:row.chatId}:{})};}
 recipients(){return {botUsername:this.config?.username||null,webhookReady:Boolean(this.webhookReady),webhookError:this.webhookError||null,defaultRecipient:{label:'Владелец пространства',telegramId:'…'+String(this.config?.chatId||'').slice(-4)},recipients:(this.config?.recipients||[]).map(r=>({id:r.id,label:r.label,accountName:r.accountName,userId:r.userId||null,state:r.state,expiresAt:r.expiresAt||null,telegramId:r.chatId?'…'+String(r.chatId).slice(-4):null,link:r.state==='pending'&&r.expiresAt>this.clock()?'https://t.me/'+this.config.username+'?start=tr_'+r.linkToken:null}))};}
 webhookSecret(){return crypto.createHmac('sha256',this.key).update('teamroom-telegram-webhook:'+this.config.token).digest('hex');}
 async ensureWebhook(origin){
  if(!this.config?.enabled)return;if(!origin||new URL(origin).protocol!=='https:')throw fail(503,'Для подключения пользователей Telegram нужен HTTPS адрес сайта.');
  const bot=await this.telegram(this.config,'getMe',{});if(this.config.username!==bot.username)await this.edit(c=>({...c,username:bot.username}));
  const target=new URL('/telegram/webhook',origin).href,info=await this.telegram(this.config,'getWebhookInfo',{});
  if(info.url&&info.url!==target)throw fail(409,'Этот бот уже подключён к другому серверу. Для Team Room нужен отдельный бот; существующее подключение сохранено.');
  await this.telegram(this.config,'setWebhook',{url:target,secret_token:this.webhookSecret(),allowed_updates:['message'],max_connections:5});this.webhookReady=true;this.webhookError=null;
 }
 validWebhook(secret){return this.config?.enabled&&typeof secret==='string'&&this.equal(this.digest(secret),this.digest(this.webhookSecret()));}
 recipientAction(input,users){
  if(!this.config?.enabled)throw fail(409,'Сначала подключи Telegram для входа.');
  if(input.operation==='remove'){const row=(this.config.recipients||[]).find(r=>r.id===input.id);if(!row)throw fail(404,'Получатель не найден.');return {operation:'remove',id:row.id,label:row.label,accountName:row.accountName,revision:this.config.recipientRevision||0};}
  if(input.operation!=='invite')throw fail(400,'Неизвестное действие.');
  const label=String(input.label||'').trim().slice(0,60);let accountName=String(input.accountName||'').trim().normalize('NFC');if(!label||!accountName||accountName.length>50||/[\x00-\x1f\x7f]/.test(label+accountName))throw fail(400,'Укажи имя получателя и имя аккаунта Team Room до 50 символов.');
  const user=users.find(u=>u.name.toLocaleLowerCase()===accountName.toLocaleLowerCase()||(u.loginAliases||[]).some(a=>a.toLocaleLowerCase()===accountName.toLocaleLowerCase()));accountName=user?.name||accountName;
  if((this.config.recipients||[]).some(r=>r.accountName.toLocaleLowerCase()===accountName.toLocaleLowerCase()))throw fail(409,'Для этого аккаунта уже есть получатель или приглашение. Сначала отключи его.');
  if((this.config.recipients||[]).length>=30)throw fail(400,'Можно добавить до 30 получателей.');
  return {operation:'invite',label,accountName:user?.name||accountName,userId:user?.id||null,revision:this.config.recipientRevision||0};
 }
 async applyRecipientAction(action){
  let removed;
  await this.edit(config=>{
   if((config.recipientRevision||0)!==action.revision)throw fail(409,'Список получателей изменился. Открой его заново.');
   const rows=config.recipients||=[];
   if(action.operation==='remove'){removed=rows.find(r=>r.id===action.id);if(!removed)throw fail(404,'Получатель уже отключён.');config.recipients=rows.filter(r=>r.id!==action.id);}
   else{if(rows.some(r=>r.accountName.toLocaleLowerCase()===action.accountName.toLocaleLowerCase())||rows.length>=30)throw fail(409,'Приглашение уже создано или список заполнен.');rows.push({id:crypto.randomUUID(),label:action.label,accountName:action.accountName,userId:action.userId,state:'pending',linkToken:crypto.randomBytes(24).toString('hex'),expiresAt:this.clock()+24*3600000,createdAt:this.clock()});}
   config.recipientRevision=(config.recipientRevision||0)+1;return config;
  });return {removed,info:this.recipients()};
 }
 async bindAccount(user){const row=(this.config?.recipients||[]).find(r=>r.state==='active'&&!r.userId&&r.accountName.toLocaleLowerCase()===user.name.toLocaleLowerCase());if(row)await this.edit(config=>{const target=config.recipients.find(r=>r.id===row.id);if(target&&!target.userId){target.userId=user.id;config.recipientRevision=(config.recipientRevision||0)+1;}return config;});}
 async receiveTelegram(update){
  const message=update?.message;if(!message||message.chat?.type!=='private'||String(message.chat.id)!==String(message.from?.id)||message.from?.is_bot)return;
  if(!Number.isSafeInteger(update.update_id)||update.update_id<0)return;
  const token=String(message.text||'').match(/^\/start(?:@\w+)?\s+tr_([a-f0-9]{48})\s*$/)?.[1];if(!token||!(this.config.recipients||[]).some(r=>r.state==='pending'&&r.expiresAt>this.clock()&&this.equal(this.digest(r.linkToken),this.digest(token))))return;
  let row;
  await this.edit(config=>{
   if((config.telegramUpdates||[]).includes(update.update_id))return config;
   const candidate=(config.recipients||[]).find(r=>r.state==='pending'&&r.expiresAt>this.clock()&&this.equal(this.digest(r.linkToken),this.digest(token)));
   if(candidate){candidate.state='active';candidate.chatId=String(message.from.id);candidate.connectedAt=this.clock();delete candidate.linkToken;delete candidate.expiresAt;row={...candidate};config.recipientRevision=(config.recipientRevision||0)+1;}
   config.telegramUpdates=[...(config.telegramUpdates||[]),update.update_id].slice(-300);return config;
  });
  if(row)try{await this.telegram(this.config,'sendMessage',{chat_id:row.chatId,text:`Team Room подключён.\nКоды входа для аккаунта «${row.accountName}» будут приходить сюда.\nПри входе в сайт укажи именно это имя. Для нового аккаунта также нужен код приглашения Team Room от владельца.`,protect_content:true});}catch{console.error('Telegram: получатель подключён, но подтверждение доставки не отправлено.');}
 }
 digest(value){return crypto.createHmac('sha256',this.pepper).update(value).digest();}
 equal(a,b){return a?.length===b?.length&&crypto.timingSafeEqual(a,b);}
 async telegram(config,method,body){
  let response,data;
  try{response=await fetch(`https://api.telegram.org/bot${config.token}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});data=await response.json();}catch(error){console.error('Telegram API:',method,error.name==='TimeoutError'?'timeout':'connection-error');throw fail(503,'Telegram сейчас не отвечает. Попробуй запросить код ещё раз через минуту. Компьютер включать не нужно.');}
  if(!response.ok||!data.ok){const status=data.error_code||response.status;console.error('Telegram API:',method,'status',status);const bot=config.username?'@'+config.username:'бота Team Room';if(status===429)throw fail(429,`Telegram просит подождать ${Math.min(Number(data.parameters?.retry_after)||60,3600)} секунд. Затем запроси код снова.`);if(status===401)throw fail(503,'Токен Telegram-бота больше не действует. Владелец должен восстановить подключение бота.');if(status===403)throw fail(503,`Разблокируй ${bot} в Telegram и нажми Start. Затем запроси код снова.`);throw fail(503,`Открой ${bot} в Telegram и нажми Start. Код приходит получателю, привязанному к аккаунту Team Room.`);}
  return data.result;
 }
 async botConfig(token,chatId){if(!/^\d{5,}:[a-zA-Z0-9_-]{20,}$/.test(token)||!/^\d{1,20}$/.test(chatId))throw fail(400,'Укажи токен бота и свой числовой Telegram ID.');const config={token,chatId,enabled:true};const bot=await this.telegram(config,'getMe',{});config.username=bot.username;return config;}
 async sendTelegram(config,{code,name,purpose,action}){await this.telegram(config,'sendMessage',{chat_id:config.chatId,text:`Team Room\n${purpose==='enroll'?'Подключение защищённого входа':purpose==='recipients'?'Изменение получателей кодов':'Код входа'}: ${code}\nАккаунт: ${name}${action?'\nДействие: '+(action.operation==='invite'?'Пригласить':'Отключить')+' «'+action.label+'» для «'+action.accountName+'»':''}\nКод действует 5 минут, только для запроса в твоём браузере. Никому его не передавай. Если вход не запрашивал — не вводи код.`,protect_content:true});}
 async request({name,userId,pendingUser,config=this.config,purpose='login',binding,action}){
  const at=this.clock();for(const [key,value]of this.challenges)if(value.expiresAt<=at)this.challenges.delete(key);
  if(this.challenges.size>=500)throw fail(429,'Слишком много запросов кодов. Попробуй позже.');
  this.limiter.take('request:'+binding+':'+name.toLowerCase(),1,60000);
  if(userId||pendingUser){
   // One account must not consume the login-code allowance of every other account.
   const recipient=userId?'user:'+userId:'join:'+name.toLowerCase();
   this.limiter.take('recipient:'+recipient,10,3600000);
   this.limiter.take('delivery-total',60,3600000);
  }
  const id=crypto.randomUUID(),nonce=crypto.randomBytes(32).toString('hex'),code=String(crypto.randomInt(0,1000000)).padStart(6,'0');
  const record={name,userId,pendingUser,purpose,config,action,recipientRevision:this.config?.recipientRevision||0,nonceHash:this.digest(nonce),codeHash:this.digest(id+':'+code),expiresAt:at+300000,attempts:0};
  this.challenges.set(id,record);
  try{if(userId||pendingUser)await this.deliver(config,{code,name,purpose,action});}catch(error){this.challenges.delete(id);throw error;}
  return {id,nonce,expiresAt:record.expiresAt};
 }
 consume(id,code,nonce,purpose){
  const record=this.challenges.get(id);
  if(record&&purpose==='login'&&record.recipientRevision!==(this.config?.recipientRevision||0)){this.challenges.delete(id);throw fail(401,'Получатель кода изменился. Запроси новый код.');}
  if(!record||record.expiresAt<=this.clock()||record.purpose!==purpose||!this.equal(record.nonceHash,this.digest(String(nonce))))throw fail(401,'Код не подошёл или истёк. Запроси новый.');
  if(++record.attempts>5){this.challenges.delete(id);throw fail(429,'Попытки закончились. Запроси новый код.');}
  if(!/^\d{6}$/.test(String(code))||!this.equal(record.codeHash,this.digest(id+':'+code))||!record.userId&&!record.pendingUser){if(record.attempts>=5)this.challenges.delete(id);throw fail(401,'Код не подошёл или истёк.');}
  this.challenges.delete(id);return record; // Consume before any awaited session write.
 }
}
