import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail=message=>Object.assign(new Error(message),{status:400});
const forbidden=new Set(['__proto__','prototype','constructor']);
const internal=new Set(['codex_app','cua_repl','node_repl','code-review']);
export function mcpName(value){if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(value)||forbidden.has(value))throw fail('Имя MCP: латинские буквы, цифры, дефис или подчёркивание.');return value;}
function strings(value,kind){if(value===undefined||value===null)return {};if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>100)throw fail('Некорректные '+kind);const out=Object.create(null);for(const [k,v]of Object.entries(value)){if(forbidden.has(k)||typeof v!=='string'||v.length>16384||v.includes('\0')||!/^[a-zA-Z0-9_!#$%&'*+.^`|~-]{1,150}$/.test(k))throw fail('Некорректные '+kind);out[k]=v;}return out;}
export function normalizeMcp(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||JSON.stringify(input).length>250000)throw fail('Слишком большие или некорректные настройки MCP.');
 const type=input.type|| (input.url?'http':'stdio'),result={type};
 if(type==='http'||type==='sse'){
  if(typeof input.url!=='string'||input.url.length>16384)throw fail('Укажи адрес MCP.');
  // Environment references are resolved only on the executing device.
  const check=input.url.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g,'placeholder');let url;try{url=new URL(check);}catch{throw fail('Некорректный адрес MCP.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw fail('MCP должен использовать HTTP или HTTPS без пароля в адресе.');
  result.url=input.url;result.headers=strings(input.headers,'заголовки');
 }else if(type==='stdio'){
  if(typeof input.command!=='string'||!input.command.trim()||input.command.length>2000||input.command.includes('\0'))throw fail('Укажи программу MCP.');
  if(input.args!==undefined&&(!Array.isArray(input.args)||input.args.length>100||input.args.some(v=>typeof v!=='string'||v.length>16384||v.includes('\0'))))throw fail('Аргументы MCP должны быть списком строк.');
  result.command=input.command;result.args=input.args||[];result.env=strings(input.env,'переменные окружения');
  if(input.cwd){if(typeof input.cwd!=='string'||input.cwd.length>2000||input.cwd.includes('\0'))throw fail('Некорректная рабочая папка MCP.');result.cwd=input.cwd;}
 }else throw fail('Поддерживаются stdio, HTTP и SSE MCP.');
 return result;
}
async function privateDirectory(root){await fs.mkdir(root,{recursive:true,mode:0o700});const st=await fs.lstat(root);if(st.isSymbolicLink()||!st.isDirectory())throw fail('Папка настроек MCP не может быть ссылкой.');}
export async function readMcpEncrypted(filename,keyPath){for(const p of [filename,keyPath]){const st=await fs.lstat(p);if(st.isSymbolicLink()||!st.isFile()||st.size>3000000)throw fail('Недопустимый файл MCP.');}const key=await fs.readFile(keyPath),row=JSON.parse(await fs.readFile(filename,'utf8'));const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(row.iv,'hex'));decipher.setAAD(Buffer.from('team-room-mcp-v1'));decipher.setAuthTag(Buffer.from(row.tag,'hex'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(row.data,'base64')),decipher.final()]).toString());}
export async function writeMcpEncrypted(filename,keyPath,value){
 if((await fs.lstat(keyPath)).isSymbolicLink())throw fail('Недопустимый ключ MCP.');const key=await fs.readFile(keyPath),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from('team-room-mcp-v1'));const data=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
 const tmp=filename+'.'+crypto.randomUUID()+'.tmp';try{const handle=await fs.open(tmp,'wx',0o600);try{await handle.writeFile(JSON.stringify({iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),data:data.toString('base64')}));await handle.sync();}finally{await handle.close();}await fs.rename(tmp,filename);}finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
}
// What decides which program runs (and with which variables). A device report
// that introduces or changes these waits for the owner instead of reaching
// every Mac: a single device token must not be able to run code everywhere.
const mcpIdentity=c=>JSON.stringify({type:c.type,command:c.command??null,args:c.args??null,cwd:c.cwd??null,url:c.url??null,env:Object.keys(c.env||{}).sort(),headers:Object.keys(c.headers||{}).sort()});
export class McpVault{
 constructor(root,{filename='mcp-vault.json',keyname='security-key'}={}){this.root=root;this.filename=path.join(root,filename);this.keyPath=path.join(root,keyname);this.tail=Promise.resolve();this.data={revision:0,auto:false,servers:{},sources:{}};}
 async init(){await privateDirectory(this.root);try{await fs.access(this.keyPath);}catch(error){if(error.code!=='ENOENT')throw error;await fs.writeFile(this.keyPath,crypto.randomBytes(32),{flag:'wx',mode:0o600});}
  for(const filename of [this.keyPath,this.filename])try{if((await fs.lstat(filename)).isSymbolicLink())throw fail('Файл настроек MCP не может быть ссылкой.');}catch(error){if(error.code!=='ENOENT')throw error;}
  try{this.data=await readMcpEncrypted(this.filename,this.keyPath);if(!Number.isSafeInteger(this.data.revision)||!this.data.servers||!this.data.sources)throw fail('Повреждены настройки MCP.');for(const [name,row]of Object.entries(this.data.servers)){mcpName(name);row.config=normalizeMcp(row.config);}}catch(error){if(error.code!=='ENOENT')throw new Error('Не удалось прочитать защищённые настройки MCP. Восстанови резервную копию.');}return this;
 }
 snapshot(){return {revision:this.data.revision,auto:this.data.auto,servers:structuredClone(this.data.servers)};}
 public(){return {revision:this.data.revision,auto:this.data.auto,servers:Object.entries(this.data.servers).filter(([,v])=>!v.deleted).map(([name,row])=>({name,label:row.label||name,type:row.config.type,enabled:row.enabled,review:row.review||null,sourceDevice:row.sourceDevice,sourceProvider:row.sourceProvider,updatedAt:row.updatedAt,hasSecrets:Boolean(Object.keys(row.config.env||{}).length||Object.keys(row.config.headers||{}).length),envKeys:Object.keys(row.config.env||{})}))};}
 mutate(fn){const next=this.tail.catch(()=>{}).then(async()=>{const original=structuredClone(this.data);try{const modified=await fn(this.data);if(modified){if(JSON.stringify(this.snapshot()).length>1000000||JSON.stringify(this.data).length>1900000)throw fail('Общие настройки MCP слишком большие.');this.data.revision++;await writeMcpEncrypted(this.filename,this.keyPath,this.data);}return modified;}catch(error){this.data=original;throw error;}});this.tail=next;return next;}
 async put(name,config,metadata={}){mcpName(name);config=normalizeMcp(config);return this.mutate(d=>{if(!d.servers[name]&&Object.keys(d.servers).length>=100)throw fail('Максимум 100 MCP подключений.');d.servers[name]={config,enabled:true,label:name,...metadata,deleted:false,updatedAt:new Date().toISOString()};return true;});}
 async enable(name,enabled){mcpName(name);return this.mutate(d=>{if(!d.servers[name])throw fail('MCP не найден.');d.servers[name].enabled=enabled;d.servers[name].deleted=false;if(enabled)delete d.servers[name].review;d.servers[name].updatedAt=new Date().toISOString();return true;});}
 async remove(name){mcpName(name);return this.mutate(d=>{if(!d.servers[name])return false;d.servers[name].enabled=false;d.servers[name].deleted=true;return true;});}
 async automatic(enabled){return this.mutate(d=>{d.auto=enabled;return true;});}
 async publish(deviceId,report){
  if(!report||!Array.isArray(report.items)||report.items.length>100||JSON.stringify(report).length>1000000)throw fail('Некорректный список MCP.');
  const items=report.items.map(row=>({name:mcpName(row.name),config:normalizeMcp(row.config),provider:['claude','codex'].includes(row.provider)?row.provider:'claude',label:String(row.label||row.name).slice(0,150)}));
  return this.mutate(d=>{if(!d.auto)return false;let modified=false;const seen=new Set();for(const row of items){const source=deviceId+':'+row.provider+':'+row.name,fingerprint=hash(row.config);seen.add(source);const prior=d.sources[source];if(prior===fingerprint)continue;if(!prior&&Object.keys(d.sources).length>=10000)throw fail('Слишком много источников MCP.');d.sources[source]=fingerprint;modified=true;const existing=d.servers[row.name];
    // Initial reports from another device must not replace an existing shared setup.
    if(existing&&(existing.deleted||prior===undefined))continue;
    if(!existing&&Object.keys(d.servers).length>=100)throw fail('Максимум 100 MCP подключений.');
    const review=!existing?'new':mcpIdentity(existing.config)!==mcpIdentity(row.config)?'changed':existing.review||null;
    d.servers[row.name]={config:row.config,enabled:review?false:existing.enabled!==false,label:row.label,sourceDevice:deviceId,sourceProvider:row.provider,updatedAt:new Date().toISOString(),...(review?{review}:{})};
   }
   if(report.complete===true)for(const [source]of Object.entries(d.sources))if(source.startsWith(deviceId+':')&&!seen.has(source)){const [,provider,...names]=source.split(':'),name=names.join(':');const row=d.servers[name];if(row?.sourceDevice===deviceId&&row.sourceProvider===provider){row.enabled=false;row.deleted=true;modified=true;}delete d.sources[source];modified=true;}
   return modified;
  });
 }
}
export function portableMcp(config,home=os.homedir(),environment=process.env){
 const resolve=v=>String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(m,k)=>k==='HOME'||k==='PROJECT'?m:environment[k]??m).split(home).join('${HOME}');
 const c=normalizeMcp(config);if(c.type==='stdio'){c.command=resolve(c.command);c.args=c.args.map(resolve);c.env=Object.fromEntries(Object.entries(c.env).map(([k,v])=>[k,resolve(v)]));if(c.cwd)c.cwd=resolve(c.cwd);}else{c.url=resolve(c.url);c.headers=Object.fromEntries(Object.entries(c.headers).map(([k,v])=>[k,resolve(v)]));}return c;
}
export function expandMcp(config,{home=os.homedir(),project=process.cwd(),environment=process.env}={}){
 const missing=new Set(),resolve=v=>v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(m,k)=>{const value=k==='HOME'?home:k==='PROJECT'?project:environment[k];if(value===undefined){missing.add(k);return m;}return value;});
 const c=normalizeMcp(config);if(c.type==='stdio'){c.command=resolve(c.command);c.args=c.args.map(resolve);c.env=Object.fromEntries(Object.entries(c.env).map(([k,v])=>[k,resolve(v)]));if(c.cwd)c.cwd=resolve(c.cwd);}else{c.url=resolve(c.url);c.headers=Object.fromEntries(Object.entries(c.headers).map(([k,v])=>[k,resolve(v)]));}return {config:c,missing:[...missing]};
}
const cliEnv=()=>({...process.env,PATH:[path.join(os.homedir(),'.local','bin'),path.join(os.homedir(),'.npm-global','bin'),process.env.PATH].filter(Boolean).join(path.delimiter)});
export async function discoverMcp({home=os.homedir(),codexList}={}){
 const items=[],issues=[];let complete=true;const add=(name,config,provider,label=name)=>{try{if(internal.has(name))return;items.push({name:mcpName(name),config:portableMcp(config,home),provider,label});}catch{issues.push({name:String(name).slice(0,80),reason:'Настройки требуют ручной проверки'});}};
 try{const p=path.join(home,'.claude.json');const stat=await fs.lstat(p);if(stat.isSymbolicLink()||stat.size>16000000)throw new Error();const d=JSON.parse(await fs.readFile(p,'utf8'));for(const [n,c]of Object.entries(d.mcpServers||{}))add(n,c,'claude');
  for(const [dir,p]of Object.entries(d.projects||{})){let local={};try{const file=path.join(dir,'.mcp.json'),st=await fs.lstat(file);if(st.isSymbolicLink()||st.size>1000000)throw new Error();local=JSON.parse(await fs.readFile(file,'utf8')).mcpServers||{};}catch(e){if(e.code!=='ENOENT'){complete=false;issues.push({name:path.basename(dir),reason:'Не удалось прочитать MCP проекта'});}}for(const [n,c]of Object.entries({...local,...p.mcpServers})){const name=n.slice(0,70)+'_'+hash(dir).slice(0,8);const config={...c};if(!config.url&&!config.cwd)config.cwd=dir;add(name,config,'claude',n+' · '+path.basename(dir));}}
 }catch(error){if(error.code!=='ENOENT'){complete=false;issues.push({name:'Claude',reason:'Не удалось прочитать список MCP'});}}
 try{const rows=codexList?await codexList():JSON.parse((await exec('codex',['mcp','list','--json'],{env:cliEnv(),timeout:15000,maxBuffer:1000000,windowsHide:true})).stdout);for(const row of rows){if(row.enabled===false||internal.has(row.name))continue;const t=row.transport||{},env={...t.env};for(const key of t.env_vars||[])if(typeof key==='string')env[key]=process.env[key]??'${'+key+'}';
   if(t.type==='stdio')add(row.name,{type:'stdio',command:t.command,args:t.args||[],env,...(t.cwd?{cwd:t.cwd}:{})},'codex');
   else if(t.url){const headers={...t.http_headers};for(const [key,v]of Object.entries(t.env_http_headers||{}))headers[key]=process.env[v]??'${'+v+'}';if(t.bearer_token_env_var)headers.Authorization='Bearer '+(process.env[t.bearer_token_env_var]??'${'+t.bearer_token_env_var+'}');add(row.name,{type:'http',url:t.url,headers},'codex');}
  }
 }catch{complete=false;issues.push({name:'Codex',reason:'Не удалось прочитать список MCP'});}
 return {items,complete,issues};
}
function toml(value){if(typeof value==='string')return JSON.stringify(value);if(typeof value==='boolean'||typeof value==='number')return String(value);if(Array.isArray(value))return '['+value.map(toml).join(',')+']';return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+'='+toml(v)).join(',')+'}';}
const CODEX_ADAPTER_VERSION=2;
// Codex merges CLI tables with native config. A separate adapter name prevents
// a native HTTP URL from being combined with our stdio command and args.
// Keep the original name readable and stable across devices, but bound its size.
function codexAdapterName(name){return 'teamroom_sync_'+name.slice(0,39)+'_'+hash(name).slice(0,16);}
function codexAdapterArgs(adapters){return adapters.flatMap(adapter=>['-c',`mcp_servers.${codexAdapterName(adapter.name)}=${toml(adapter.config)}`]);}
export class McpDevice{
 constructor(root){this.root=path.join(root,'.mcp-sync');this.profile={signature:'native',claudeArgs:[],codexArgs:[],codexOriginalNames:[]};this.revision=0;this.info={revision:0,servers:[]};this.tail=Promise.resolve();}
 async init(){this.vault=await new McpVault(this.root,{filename:'state.json',keyname:'key'}).init();
  // A failed runtime write (observed: ENOSPC) must not keep Connect from starting:
  // run without shared MCP and retry when the hub resends the snapshot.
  if(this.vault.data.revision)try{await this.install(this.vault.snapshot());}catch(error){this.installError={message:error.message,code:error.code||null,at:new Date().toISOString()};this.info={revision:0,servers:[],error:error.message};console.error(new Date().toISOString(),'Общие MCP не установлены при запуске:',error.message);}
  return this;}
 async apply(snapshot){const next=this.tail.catch(()=>{}).then(()=>this.install(snapshot));this.tail=next;return next;}
 async install(snapshot){
  if(!snapshot||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0||!snapshot.servers||JSON.stringify(snapshot).length>1000000)throw fail('Некорректные общие настройки MCP.');
  if(snapshot.revision<this.revision)return false;if(Object.keys(snapshot.servers).length>100)throw fail('Слишком много MCP.');if(snapshot.revision===0&&!Object.keys(snapshot.servers).length)return false;const servers={};for(const [n,row]of Object.entries(snapshot.servers)){mcpName(n);servers[n]={...row,config:normalizeMcp(row.config)};}
  const signature=hash({revision:snapshot.revision,servers,codexAdapterVersion:CODEX_ADAPTER_VERSION});if(signature===this.profile.signature)return false;const runtime=path.join(this.root,'runtime-'+signature+'.json');await writeMcpEncrypted(runtime,this.vault.keyPath,{servers});
  const wrapper=path.join(path.dirname(fileURLToPath(import.meta.url)),'mcp-run.mjs'),definitions={},adapters=[],statuses=[];
  for(const [name,row]of Object.entries(servers)){
   if(!row.enabled||row.deleted){adapters.push({name,config:{command:process.execPath,args:[wrapper,name],enabled:false}});continue;}
   const expanded=expandMcp(row.config);const issue=expanded.missing.length?'Нужны переменные: '+expanded.missing.join(', '):expanded.config.type==='stdio'&&path.isAbsolute(expanded.config.command)&&!(await fs.access(expanded.config.command).then(()=>true,()=>false))?'Программа MCP не установлена на этом компьютере':expanded.config.cwd&&!(await fs.access(expanded.config.cwd).then(()=>true,()=>false))?'Рабочая папка MCP отсутствует на этом компьютере':null;
   statuses.push({name,state:issue?'attention':'configured',detail:issue});
   if(expanded.missing.length){adapters.push({name,config:{command:process.execPath,args:[wrapper,name],enabled:false}});continue;}
   const env={TEAM_ROOM_MCP_FILE:runtime,TEAM_ROOM_MCP_KEY:this.vault.keyPath};
   definitions[name]={type:'stdio',command:process.execPath,args:[wrapper,name],env};
   adapters.push({name,config:{command:process.execPath,args:[wrapper,name],env,enabled:true,startup_timeout_sec:25,tool_timeout_sec:90,default_tools_approval_mode:'prompt'}});
  }
  const claudeFile=path.join(this.root,'claude-'+signature+'.json');await fs.writeFile(claudeFile,JSON.stringify({mcpServers:definitions}),{mode:0o600});
  await this.vault.mutate(d=>{d.revision=snapshot.revision-1;d.servers=servers;d.auto=snapshot.auto;return true;});
  this.revision=snapshot.revision;this.profile={signature,claudeArgs:['--strict-mcp-config','--mcp-config',claudeFile],codexArgs:codexAdapterArgs(adapters),codexOriginalNames:Object.keys(servers)};this.info={revision:this.revision,servers:statuses};this.installError=null;for(const f of await fs.readdir(this.root))if(/^(runtime-|claude-)[a-f0-9]+\.json$/.test(f)){const full=path.join(this.root,f);if(Date.now()-(await fs.lstat(full)).mtimeMs>7*86400000&&full!==runtime&&full!==claudeFile)await fs.rm(full,{force:true});}return true;
 }
}
