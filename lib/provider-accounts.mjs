import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {Providers,login,isolatedEnvironment} from './providers.mjs';
import {NativeSessions} from './native-sessions.mjs';
import {internalDirectory} from './workspace.mjs';

export function accountId(value){
 if(value===undefined||value===null||value==='')return '';
 if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))throw new Error('Некорректный аккаунт подписки.');
 return value;
}
const providerName=value=>{if(!['claude','codex'].includes(value))throw new Error('Неизвестный провайдер.');return value;};
export class ProviderAccounts {
 constructor(root,defaults=new Providers(),{createProviders=environment=>new Providers({environment}),startLogin=login}={}){this.root=root;this.defaults=defaults;this.createProviders=createProviders;this.login=startLogin;this.records=[];this.instances=new Map();this.sessions=new Map();this.auth=new Map();this.logins=new Map();this.tail=Promise.resolve();}
 async init(){
  try{this.directory=await internalDirectory(this.root,'.provider-accounts');await fs.chmod(this.directory,0o700);
  this.filename=path.join(this.directory,'accounts.json');
  try{const stat=await fs.lstat(this.filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>100000)throw new Error('Небезопасный реестр аккаунтов.');const records=JSON.parse(await fs.readFile(this.filename,'utf8'));if(!Array.isArray(records)||records.length>20)throw new Error('Реестр аккаунтов повреждён.');const ids=new Set();for(const r of records){if(!accountId(r.id)||ids.has(r.id))throw new Error('Реестр аккаунтов повреждён.');ids.add(r.id);providerName(r.provider);if(typeof r.name!=='string'||!r.name.trim()||r.name.length>60||/[\x00-\x1f\x7f]/.test(r.name))throw new Error('Реестр аккаунтов повреждён.');}this.records=records.map(({id,provider,name})=>({id,provider,name}));for(const record of this.records){const base=await internalDirectory(this.directory,record.id);await fs.chmod(base,0o700);await fs.chmod(await internalDirectory(base,record.provider),0o700);}}
  catch(error){if(error.code!=='ENOENT')throw error;}}catch{this.error='Не удалось открыть сохранённые аккаунты на этом Mac. Основной вход работает; дополнительные входы сохранены и требуют проверки подключения.';this.records=[];}return this;
 }
 record(provider,id){providerName(provider);id=accountId(id);if(!id)return null;const record=this.records.find(r=>r.id===id&&r.provider===provider);if(!record)throw new Error('Аккаунт не найден на выбранном компьютере.');return record;}
 get(provider,id=''){
  const record=this.record(provider,id);if(!record)return this.defaults;
  let instance=this.instances.get(record.id);if(!instance){instance=this.createProviders(isolatedEnvironment(provider,path.join(this.directory,record.id,provider)));this.instances.set(record.id,instance);}
  instance.mcp=this.defaults.mcp;instance.skills=this.defaults.skills;return instance;
 }
 native(provider,id=''){const instance=this.get(provider,id),key=provider+':'+(id||'');if(!this.sessions.has(key))this.sessions.set(key,new NativeSessions(instance));return this.sessions.get(key);}
 async create(provider,name){
  if(this.error)throw new Error(this.error);providerName(provider);name=String(name||'').trim();if(!name||name.length>60||/[\x00-\x1f\x7f]/.test(name))throw new Error('Укажи имя аккаунта, до 60 символов.');
  const operation=this.tail.then(async()=>{
   if(this.records.some(r=>r.provider===provider&&r.name.toLocaleLowerCase()===name.toLocaleLowerCase()))throw new Error('Такое имя уже есть. Укажи другое имя аккаунта.');
   if(this.records.length>=20)throw new Error('На этом компьютере уже 20 аккаунтов.');
   const record={id:crypto.randomUUID(),provider,name};const base=await internalDirectory(this.directory,record.id),directory=await internalDirectory(base,provider);await fs.chmod(base,0o700);await fs.chmod(directory,0o700);
   // The file backend belongs to this CODEX_HOME; a shared OS keyring would
   // otherwise let a second login replace the native application's account.
   if(provider==='codex')await fs.writeFile(path.join(directory,'config.toml'),'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n',{mode:0o600,flag:'wx'});
   const next=[...this.records,record],temporary=this.filename+'.'+crypto.randomUUID()+'.tmp';let handle;try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify(next));await handle.sync();await handle.close();handle=null;await fs.rename(temporary,this.filename);}finally{await handle?.close().catch(()=>{});await fs.rm(temporary,{force:true}).catch(()=>{});}this.records=next;return record;
  });this.tail=operation.catch(()=>{});return operation;
 }
 list(){return this.records.map(record=>({...record,status:this.auth.get(record.id)||null,loginBusy:this.logins.has(record.provider+':'+record.id)}));}
 async status(force=false){let index=0;await Promise.all(Array.from({length:Math.min(3,this.records.length)},async()=>{while(index<this.records.length){const record=this.records[index++];try{const instance=this.get(record.provider,record.id),generation=instance.authGeneration;const value=await instance.providerStatus(record.provider,force);if(generation===instance.authGeneration)this.auth.set(record.id,value);}catch{this.auth.set(record.id,{connected:false,detail:'Не удалось проверить вход. Повтори проверку.'});}}}));return this.list();}
 startLogin(provider,id,emit){
  id=accountId(id);const instance=this.get(provider,id),key=provider+':'+id;
  if(this.logins.has(key))return {ok:true,alreadyStarted:true};
  if(this.logins.size)throw new Error('На этом компьютере уже открыт вход. Заверши его и добавь следующий аккаунт.');
  if(instance.active.size||instance.handlers.size)throw new Error('Этот аккаунт выполняет работу. Дождись её завершения перед новым входом.');
  const entry={child:null,timer:null};this.logins.set(key,entry);let completed=false;
  const finish=event=>{if(completed)return;completed=true;clearTimeout(entry.timer);this.logins.delete(key);instance.invalidateAuth();instance.claudeCatalog=null;void instance.providerStatus(provider,true).then(value=>this.auth.set(id,value)).catch(()=>{});emit({...event,accountId:id});};
  try{instance.close();entry.child=this.login(provider,event=>event.type==='login-complete'?finish(event):emit({...event,accountId:id}),instance.env);entry.timer=setTimeout(()=>{entry.child.kill();finish({type:'login-complete',provider,code:null,error:'Время входа истекло. Нажми «Войти» и повтори.'});},300000);entry.timer.unref();}
  catch(error){this.logins.delete(key);throw error;}return {ok:true};
 }
 close(){for(const entry of this.logins.values()){clearTimeout(entry.timer);entry.child?.kill();}for(const instance of this.instances.values())instance.close();this.defaults.close();}
}
