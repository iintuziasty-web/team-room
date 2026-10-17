import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {realpath} from 'node:fs/promises';
const exec=promisify(execFile);
async function processTree(){
 const {stdout}=await exec('ps',['-axo','pid=,ppid=,pgid=,lstart='],{maxBuffer:4*1024*1024});
 return new Map(stdout.trim().split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);return m?[Number(m[1]),{parent:Number(m[2]),group:Number(m[3]),born:m[4]}]:null;}).filter(Boolean));
}
async function processes(){return new Map([...(await processTree())].map(([pid,p])=>[pid,p.born]));}
export function descendantOf(pid,parent,tree){const seen=new Set();while(pid>1&&!seen.has(pid)){if(pid===parent)return true;seen.add(pid);pid=tree.get(pid)?.parent||0;}return false;}
export class RunProcesses {
 constructor(workspace,baseline,onChange=()=>{}){this.workspace=path.resolve(workspace);this.baseline=baseline;this.owned=new Map();this.groups=new Set();this.onChange=onChange;}
 static async start(workspace,onChange,previousOwned=[]){
  if(process.platform==='win32')return {stop:async()=>{},dispose:()=>{}};
  const tracker=new RunProcesses(await realpath(workspace),await processes(),onChange);
  tracker.owned=new Map(previousOwned.filter(p=>tracker.baseline.get(p.pid)===p.born).map(p=>[p.pid,p.born]));
  tracker.timer=setInterval(()=>void tracker.scan().catch(()=>{}),1500);tracker.timer.unref();return tracker;
 }
 static restore(workspace,owned=[]){const tracker=new RunProcesses(workspace,new Map());tracker.owned=new Map(owned.map(p=>[p.pid,p.born]));tracker.scan=async()=>{};return tracker;}
 async scan(){
  if(this.scanning)return this.scanning;
  this.scanning=(async()=>{
   const tree=await processTree(),current=new Map([...tree].map(([pid,p])=>[pid,p.born]));
   for(const [pid,p]of tree)if(descendantOf(pid,process.pid,tree))this.groups.add(p.group);
   const candidates=[...current].filter(([pid,born])=>pid!==process.pid&&this.baseline.get(pid)!==born&&!this.owned.has(pid)&&(descendantOf(pid,process.pid,tree)||this.groups.has(tree.get(pid).group)));
   if(!candidates.length)return;
   let stdout='';try{({stdout}=await exec('lsof',['-nP','-p',candidates.map(([pid])=>pid).join(','),'-Fpn'],{maxBuffer:16*1024*1024,timeout:5000}));}catch(error){if(error.code!==1)throw error;stdout=error.stdout||'';}
   const size=this.owned.size;let pid;for(const line of stdout.split('\n')){
    if(line.startsWith('p'))pid=Number(line.slice(1));
    else if(line.startsWith('n')&&current.has(pid)){
     const name=line.slice(1);if(name===this.workspace||name.startsWith(this.workspace+path.sep))this.owned.set(pid,current.get(pid));
    }
   }
   if(this.owned.size!==size)this.onChange([...this.owned].map(([pid,born])=>({pid,born})));
  })().finally(()=>{this.scanning=null;});return this.scanning;
 }
 async stop(){
  this.dispose();await this.scan();
  const signal=async kind=>{const current=await processes();for(const [pid,born]of this.owned)if(current.get(pid)===born){try{process.kill(pid,kind);}catch(error){if(error.code!=='ESRCH')throw error;}}};
  await signal('SIGTERM');await new Promise(resolve=>setTimeout(resolve,800));await signal('SIGKILL');
 }
 dispose(){clearInterval(this.timer);this.timer=null;}
}
// Keep only owners whose PID still exists with the same birth time; PIDs get reused.
export async function pruneOwners(owners){
 const current=await processes();const next={};
 for(const [chat,rows]of Object.entries(owners||{})){const live=(Array.isArray(rows)?rows:[]).filter(p=>Number.isInteger(p?.pid)&&typeof p?.born==='string'&&current.get(p.pid)===p.born);if(live.length)next[chat]=live;}
 return next;
}
