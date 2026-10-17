// Local MCP adapter. Provider command lines contain only encrypted file pointers.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readMcpEncrypted,expandMcp,mcpName} from './mcp-sync.mjs';
export async function mcpExecutable(command,environment=process.env){
 const exists=p=>fs.access(p).then(()=>true,()=>false);
 let name=command;
 if(path.isAbsolute(command)&&await exists(command))return {bin:command,args:[]};
 // Standard runtime installations differ between Mac and Windows.
 if(/^(?:\/opt\/homebrew\/bin\/|\/usr\/local\/bin\/)(node|npx|npm|uvx|uv)$/.test(command))name=path.basename(command);
 if(name==='node')return {bin:process.execPath,args:[]};
 if(process.platform==='win32'&&['npx','npm'].includes(name)){
  for(const base of [path.dirname(process.execPath),...(environment.PATH||'').split(path.delimiter)])for(const p of [path.join(base,'node_modules/npm/bin',name+'-cli.js'),path.resolve(base,'../npm/bin',name+'-cli.js')])if(await exists(p))return {bin:process.execPath,args:[p]};
 }
 if(path.isAbsolute(name))throw new Error('Программа MCP не установлена на этом компьютере.');
 for(const dir of (environment.PATH||'').split(path.delimiter).filter(Boolean))for(const suffix of process.platform==='win32'?['.exe','']:['']){const p=path.join(dir,name+suffix);if(await exists(p))return {bin:p,args:[]};}
 throw new Error('Программа MCP не установлена на этом компьютере.');
}
async function main(){
 const name=mcpName(process.argv[2]);
 const runtime=process.env.TEAM_ROOM_MCP_FILE,key=process.env.TEAM_ROOM_MCP_KEY;
 if(!runtime||!key)throw new Error('Нет общих настроек MCP.');
 for(const p of [runtime,key]){const st=await fs.lstat(p);if(st.isSymbolicLink()||!st.isFile()||st.size>2000000)throw new Error('Недопустимые настройки MCP.');}
 const row=(await readMcpEncrypted(runtime,key)).servers[name];if(!row?.enabled||row.deleted)throw new Error('MCP отключён.');
 const {config,missing}=expandMcp(row.config);if(missing.length)throw new Error('Не заданы необходимые переменные MCP.');
 const environment={...process.env,PATH:[path.join(os.homedir(),'.local/bin'),path.join(os.homedir(),'.npm-global/bin'),process.env.PATH].filter(Boolean).join(path.delimiter),...config.env};
 for(const k of ['TEAM_ROOM_MCP_FILE','TEAM_ROOM_MCP_KEY','CLAUDECODE'])delete environment[k];
  for(const k of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','CODEX_API_KEY'])if(!Object.hasOwn(config.env||{},k))delete environment[k];
 if(config.type==='stdio'){
  const cli=await mcpExecutable(config.command,environment);
  const child=spawn(cli.bin,[...cli.args,...config.args],{cwd:config.cwd||process.cwd(),env:environment,stdio:['pipe','pipe','pipe'],windowsHide:true});
  process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);
  // Native servers can include keys in diagnostics: do not forward their stderr.
  child.stderr.resume();child.stdin.on('error',()=>{});child.stdout.on('error',()=>{});
  child.on('error',()=>{process.stderr.write('Не удалось запустить MCP. Проверь программу и рабочую папку.\n');process.exitCode=1;process.stdin.destroy();});
  child.on('exit',code=>process.exit(code||0));
  const stop=()=>{child.kill();setTimeout(()=>process.exit(),1500).unref();};
  process.stdin.on('end',stop);process.on('SIGTERM',stop);process.on('SIGINT',stop);return;
 }
 const {StdioServerTransport}=await import('@modelcontextprotocol/sdk/server/stdio.js');
 const {StreamableHTTPClientTransport}=await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
 const {SSEClientTransport}=await import('@modelcontextprotocol/sdk/client/sse.js');
 const front=new StdioServerTransport(),options={requestInit:{headers:config.headers},fetch:(url,init)=>{if(new URL(url instanceof Request?url.url:url).origin!==new URL(config.url).origin)throw new Error('MCP изменил адрес сервиса.');const headers=new Headers(config.headers);for(const [k,v]of new Headers(init?.headers))headers.set(k,v);return fetch(url,{...init,redirect:'error',headers,signal:init?.signal||AbortSignal.timeout(30000)});}};
 const remote=config.type==='sse'?new SSEClientTransport(new URL(config.url),options):new StreamableHTTPClientTransport(new URL(config.url),options);
 let closing=false,initializeId;const pending=new Set();
 const safeError=error=>[401,403].includes(error?.code)?'MCP требует отдельного входа или ключа сервиса.':'Связь с MCP потеряна. Проверь подключение сервиса.';
 const stop=async()=>{if(closing)return;closing=true;await Promise.allSettled([remote.close(),front.close()]);process.exit(0);};
 front.onmessage=async message=>{if(message.method==='initialize')initializeId=message.id;if(message.method&&message.id!==undefined)pending.add(message.id);try{await remote.send(message);}catch(error){if(message.id!==undefined){pending.delete(message.id);await front.send({jsonrpc:'2.0',id:message.id,error:{code:-32000,message:safeError(error)}}).catch(()=>{});}}};
 remote.onmessage=async message=>{if(message.id===initializeId&&message.result?.protocolVersion)remote.setProtocolVersion(message.result.protocolVersion);if(!message.method)pending.delete(message.id);await front.send(message).catch(stop);};
 remote.onerror=error=>{process.stderr.write(safeError(error)+'\n');};
 remote.onclose=()=>{if(!closing){for(const id of pending)void front.send({jsonrpc:'2.0',id,error:{code:-32000,message:'MCP отключён.'}}).catch(()=>{});setTimeout(stop,100).unref();}};
 front.onerror=()=>void stop();front.onclose=()=>void stop();process.stdin.on('end',()=>void stop());process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
 await remote.start();await front.start();
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{process.stderr.write('Не удалось подключить MCP. Проверь настройки, программу и доступ к сервису.\n');process.exitCode=1;});
