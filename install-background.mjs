import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolveConfiguredDeviceRoot,assertStorageForPath} from './lib/external-storage.mjs';
const exec=promisify(execFile);
const source=path.dirname(fileURLToPath(import.meta.url));
const xml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

try{
 if(process.platform!=='darwin')throw new Error('Этот установщик автозапуска предназначен для macOS.');
 const config=JSON.parse(await fs.readFile(path.join(source,'device-config.json'),'utf8'));
 if(!/^[a-zA-Z0-9-]{16,80}$/.test(config.deviceId)||!config.token)throw new Error('Не найдено подключение Team Room. Распакуй полный архив.');
 const hub=new URL(config.hubUrl);if(!['https:','http:'].includes(hub.protocol))throw new Error('Неверный адрес пространства.');
 const label='io.teamroom.community.connect.'+config.deviceId;
 const domain='gui/'+process.getuid();
 let nodeBin=process.execPath;
 for(const candidate of ['/opt/homebrew/bin/node','/usr/local/bin/node']){try{if(await fs.realpath(candidate)===await fs.realpath(process.execPath)){nodeBin=candidate;break}}catch{}}
 const plistPath=path.join(os.homedir(),'Library','LaunchAgents',label+'.plist');
 if(process.argv.includes('--remove')){
  await exec('launchctl',['bootout',domain+'/'+label]).catch(()=>{});
  await fs.rm(plistPath,{force:true});
  console.log('Фоновое подключение отключено. Рабочие файлы и авторизации сохранены.');process.exit(0);
 }
 const configured=await resolveConfiguredDeviceRoot(config.deviceId),managed=configured.root;
 const requireStorage=async()=>{
  const current=await resolveConfiguredDeviceRoot(config.deviceId);
  if(current.configured!==configured.configured||current.root!==managed||configured.configured&&current.location.volumeUuid!==configured.location.volumeUuid)throw new Error('Выбранный диск подключения изменился. Повтори установку.');
  await assertStorageForPath(managed);
 };
 await assertStorageForPath(source);const sourceRoot=await fs.realpath(source);
 // A registered external directory is the migration's verified destination.
 // The installer never creates a missing external root or substitutes an
 // internal directory when that disk is unavailable.
 await requireStorage();
 try{const stat=await fs.lstat(managed);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(managed)!==managed)throw new Error('Папка подключения не может быть ссылкой.');}catch(error){if(error.code!=='ENOENT'||configured.configured)throw error;}
 // Install only while all local results have been confirmed by the shared hub.
 for(const dir of new Set([sourceRoot,managed]))for(const name of ['running-jobs.json','pending-results.json']){
  let value;try{value=JSON.parse(await fs.readFile(path.join(dir,name),'utf8'))}catch(error){if(error.code==='ENOENT')continue;throw error}
  if(Object.keys(value).length)throw new Error('Дождись завершения задач и сохранения результатов в Team Room, затем повтори установку.');
 }
 console.log('Устанавливаю фоновое подключение. Авторизации подписок останутся на этом Mac.');
 await requireStorage();
 await exec('launchctl',['bootout',domain+'/'+label]).catch(()=>{});
 await pause(2000);
 await requireStorage();
 await fs.mkdir(managed,{recursive:true,mode:0o700});
 const names=['bridge.mjs','lib','teamroom.mjs','install-integration.mjs','install-background.mjs','device-config.json'];
 const copyOptions={recursive:true,dereference:false,...(configured.configured?{filter:async()=>{await assertStorageForPath(managed);return true;}}:{})};
 if(sourceRoot!==managed){
  for(const name of names){await requireStorage();const from=path.join(sourceRoot,name);await fs.cp(from,path.join(managed,name),copyOptions);}
  for(const name of ['workspaces','running-jobs.json','pending-results.json']){
   await requireStorage();
   try{await fs.access(path.join(managed,name));continue}catch(error){if(error.code!=='ENOENT')throw error}
   try{await fs.cp(path.join(sourceRoot,name),path.join(managed,name),copyOptions)}catch(error){if(error.code!=='ENOENT')throw error}
  }
 }
 await requireStorage();
 await fs.chmod(path.join(managed,'device-config.json'),0o600);
 await requireStorage();
 await fs.writeFile(path.join(managed,'package.json'),JSON.stringify({name:'team-room-community-connect',private:true,type:'module',dependencies:{'@modelcontextprotocol/sdk':'1.31.0',ws:'^8.18.0','@openai/codex':'latest','@anthropic-ai/claude-code':'latest'}},null,2));
 const launchPath=[path.dirname(process.execPath),path.join(managed,'node_modules','.bin'),path.join(os.homedir(),'.local','bin'),'/opt/homebrew/bin','/usr/local/bin','/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS','/usr/bin','/bin','/usr/sbin','/sbin',process.env.PATH||''].join(':');
 const env={...process.env,PATH:launchPath};
 let externalEnvironment='';
 if(configured.configured){
  const npmCache=path.join(managed,'.npm-cache'),temporary=path.join(managed,'.install-tmp');
  for(const directory of [npmCache,temporary]){
   await requireStorage();await fs.mkdir(directory,{recursive:true,mode:0o700});
   const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(directory)!==directory)throw new Error('Кэш и временные файлы подключения должны оставаться на выбранном внешнем диске.');
  }
  env.npm_config_cache=npmCache;env.TMPDIR=temporary;env.TMP=temporary;env.TEMP=temporary;
  externalEnvironment=`<key>npm_config_cache</key><string>${xml(npmCache)}</string><key>TMPDIR</key><string>${xml(temporary)}</string><key>TMP</key><string>${xml(temporary)}</string><key>TEMP</key><string>${xml(temporary)}</string>`;
 }
 console.log('Подготавливаю официальные Claude Code и Codex. Первый запуск может занять несколько минут.');
 await requireStorage();
 await exec('npm',['install','--omit=dev'],{cwd:managed,env,timeout:600000,maxBuffer:2000000});
 await requireStorage();
 await exec(process.execPath,[path.join(managed,'install-integration.mjs')],{cwd:managed,env,timeout:30000});
 const plist=`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(nodeBin)}</string><string>${xml(path.join(managed,'bridge.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(managed)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(launchPath)}</string>${externalEnvironment}</dict>
<key>StandardOutPath</key><string>${xml(path.join(managed,'connect.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(managed,'connect-error.log'))}</string>
</dict></plist>`;
 await requireStorage();await fs.mkdir(path.dirname(plistPath),{recursive:true});
 await requireStorage();await fs.writeFile(plistPath,plist,{mode:0o600});
 await exec('plutil',['-lint',plistPath]);
 await requireStorage();
 await exec('launchctl',['bootstrap',domain,plistPath]);
 console.log('Автозапуск установлен. Окно можно закрыть.');
 console.log('Открой '+hub.origin+' → Компьютеры. После пробуждения Mac связь восстановится автоматически.');
 console.log('Для отключения фона: node install-background.mjs --remove');
}catch(error){console.error('Team Room:',error.message);process.exitCode=1}
