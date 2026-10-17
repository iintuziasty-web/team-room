import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import crypto from 'node:crypto';

const workerPath=fileURLToPath(new URL('./voice-worker.py',import.meta.url));
// Independent process, two CPU threads, serialized recordings. No project
// files or model session are touched; only the decoded text goes to the chat.
export class VoiceDevice {
 constructor(root){this.root=path.join(root,'voice-engine');this.python=path.join(this.root,'venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');this.model=path.join(this.root,'models');this.state='not-ready';this.pending=new Map();this.busy=false;}
 async info(){if(this.state==='not-ready')try{await fs.access(path.join(this.root,'ready'));await fs.access(this.python);this.state='ready';}catch{}return {version:1,state:this.state,engine:'Whisper small',local:true};}
 run(program,args,timeout){return new Promise((resolve,reject)=>{const child=spawn(program,args,{stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...process.env,HF_HUB_DISABLE_TELEMETRY:'1',DO_NOT_TRACK:'1'}});const timer=setTimeout(()=>{child.kill();reject(new Error('Подготовка голосового движка заняла слишком долго. Попробуй ещё раз.'));},timeout);child.stdout.resume();child.stderr.resume();child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('Не удалось подготовить распознавание. Нужен установленный Python 3.9+ с поддержкой venv.'))});});}
 async prepare(){
  if(this.preparing)return {preparing:true};if((await this.info()).state==='ready')return {ready:true};
  this.state='preparing';this.preparing=(async()=>{
   try{await fs.mkdir(this.root,{recursive:true,mode:0o700});
    let python;
    const candidates=[...(process.env.TEAM_ROOM_PYTHON?[process.env.TEAM_ROOM_PYTHON]:[]),...(process.platform==='win32'?['python','python3']:['/opt/homebrew/bin/python3','/usr/local/bin/python3','python3'])];
    for(const candidate of candidates)try{await this.run(candidate,['-c','import sys; assert sys.version_info >= (3,9)'],10000);python=candidate;break}catch{}
    if(!python)throw new Error('На выбранном компьютере нужен Python 3.9+. Установи Python и снова нажми «Подготовить голос».');
    await this.run(python,['-m','venv',path.join(this.root,'venv')],120000);
    await this.run(this.python,['-m','pip','install','--disable-pip-version-check','--only-binary=:all:','faster-whisper==1.2.1'],600000);
    await this.run(this.python,[workerPath,this.model,'prepare'],600000);
    await fs.writeFile(path.join(this.root,'ready'),'Whisper small', {mode:0o600});this.state='ready';this.error=null;
   }catch(error){this.state='not-ready';this.error=error.message;}finally{this.preparing=null;}
  })();return {preparing:true};
 }
 start(){
  if(this.child)return;
  const child=spawn(this.python,[workerPath,this.model],{stdio:['pipe','pipe','pipe'],windowsHide:true,env:{...process.env,HF_HUB_DISABLE_TELEMETRY:'1',DO_NOT_TRACK:'1'}});this.child=child;child.stderr.resume();
  createInterface({input:child.stdout}).on('line',line=>{let result;try{result=JSON.parse(line)}catch{return;}const p=this.pending.get(result.id);if(p){this.pending.delete(result.id);clearTimeout(p.timer);result.error?p.reject(new Error(result.error)):p.resolve({text:String(result.text||'').slice(0,12000),engine:'Whisper small'});}});
  const ended=()=>{if(this.child!==child)return;this.child=null;if(this.pending.size){this.state='not-ready';this.error='Движок не запустился. Нажми «Подготовить голос» ещё раз.';void fs.rm(path.join(this.root,'ready'),{force:true}).catch(()=>{});}for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Движок распознавания остановился. Повтори запись.'));}this.pending.clear();};child.once('exit',ended);child.once('error',ended);child.stdin.on('error',ended);
 }
 async transcribe(input){
  if(!['ru','uk'].includes(input.language)||typeof input.audio!=='string'||input.audio.length>8*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.audio))throw new Error('Некорректная запись.');
  if((await this.info()).state!=='ready')throw new Error(this.error||'Сначала подготовь голосовой движок в настройках Team Room.');
  if(this.busy)throw new Error('Компьютер уже распознаёт другую запись. Повтори через несколько секунд.');
  this.busy=true;clearTimeout(this.idleTimer);
  try{this.start();const id=crypto.randomUUID();return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);this.child?.kill();reject(new Error('Распознавание заняло слишком долго. Попробуй более короткую запись.'));},180000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,audio:input.audio,language:input.language})+'\n',error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(new Error('Движок недоступен. Повтори запись.'));}});});}
  finally{this.busy=false;this.idleTimer=setTimeout(()=>{if(!this.busy)this.child?.kill();},300000);this.idleTimer.unref();}
 }
 close(){clearTimeout(this.idleTimer);this.child?.kill();}
}
