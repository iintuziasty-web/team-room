#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Providers} from './lib/providers.mjs';
import {NativeSessions} from './lib/native-sessions.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));const args=process.argv.slice(2),command=args.shift()||'help',options={};for(let i=0;i<args.length;i++){if(args[i].startsWith('--'))options[args[i].slice(2)]=args[i+1]&&!args[i+1].startsWith('--')?args[++i]:true;}
let providers;
try{
 if(command==='help'){console.log('Team Room — перенос чата без API-ключей.\nnode teamroom.mjs projects\nnode teamroom.mjs import --provider claude|codex --session current|ID --project "Название" [--files referenced|all|none]\nБез --project используется проект пакета подключения или единственный проект пространства.');process.exit(0)}
 let config;for(const file of ['device-config.json','local-client.json'])try{config=JSON.parse(await fs.readFile(path.join(root,file),'utf8'));break}catch{}
 if(!config)throw new Error('Сначала войди в Team Room или установи пакет подключения с этого пространства.');
 const origin=new URL(config.hubUrl).origin;async function api(route,method='GET',body){const r=await fetch(origin+'/api'+route,{method,headers:{authorization:'Bearer '+config.token,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new Error(data.error||'Пространство не ответило.');return data}
 const {projects}=await api('/import-projects');if(command==='projects'){for(const p of projects)console.log(`${p.id}\t${p.name}`);process.exit(0)}
 if(command!=='import')throw new Error('Неизвестная команда. Используй import или projects.');
 const provider=options.provider||(process.env.CODEX_THREAD_ID?'codex':process.env.CLAUDE_SESSION_ID?'claude':null);if(!['claude','codex'].includes(provider))throw new Error('Укажи --provider claude или --provider codex.');
 let sessionId=options.session||'current';if(sessionId==='current'){providers=new Providers();sessionId=await new NativeSessions(providers).resolveCurrent(provider,process.cwd());}
 const requested=options.project||config.projectId;const project=requested?projects.find(p=>p.id===requested||p.name===requested):projects.length===1?projects[0]:null;
 if(!project&&!requested)throw new Error('В пространстве несколько проектов. Добавь --project "Название". Список: '+projects.map(p=>p.name).join(', '));
 const result=await api('/import-session','POST',{provider,sessionId,projectId:project?.id,projectName:project?undefined:requested,deviceId:config.deviceId||'local',files:options.files||'referenced',watch:options.watch!=='false'});
 console.log(`Перенесено: ${result.messageCount} сообщений, ${result.fileCount} файлов.\nОткрой ${origin}${result.url}\nИсходный чат сохранён. Новые ответы источника подтягиваются до первого запроса в Team Room.`);for(const warning of result.warnings||[])console.log(warning);if(result.conflicts?.length)console.log('Обе версии конфликтующих файлов сохранены: '+result.conflicts.join(', '));
}catch(e){console.error('Team Room:',e.message);process.exitCode=1}finally{providers?.close()}
