import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import crypto from 'node:crypto';
import {snapshot,filePath,portablePath,isIgnoredPortablePath,atomicProjectWrite,digest,MAX_FILE,MAX_TRANSFER,MAX_WORKSPACE_FILES} from './workspace.mjs';

// Serialize only reads/writes of shared files. Model turns never hold this queue.
export class ProjectFiles {
 constructor(){this.queues=new Map();}
 async run(projectId,fn){const pending=(this.queues.get(projectId)||Promise.resolve()).catch(()=>{}).then(fn);this.queues.set(projectId,pending);try{return await pending}finally{if(this.queues.get(projectId)===pending)this.queues.delete(projectId)}}
}

export async function syncWorkspace(source,target){
 const files=await snapshot(source),existing=await snapshot(target),old=new Map(existing.map(f=>[f.path,f.hash]));
 const incoming=new Set(files.map(f=>f.path));for(const file of existing)if(!incoming.has(file.path))await fs.rm(await filePath(target,file.path));
 // Keep native tool metadata/dependencies; snapshot excludes them on both sides.
 for(const file of files)if(old.get(file.path)!==file.hash){const full=await filePath(source,file.path);await atomicProjectWrite(target,file.path,checkedSource({...file,source:()=>createReadStream(full)}),{replaceLinks:true});}
 return files;
}

// Caller holds ProjectFiles.run. Hashes detect concurrent edits and deletions.
export async function mergeChanges(root,delta,before,runId,accepted={},currentFiles){
 if(!/^[a-zA-Z0-9_-]{1,240}$/.test(runId||''))throw new Error('Недопустимый запуск.');
 delta||={changed:[],deleted:[]};if(!Array.isArray(delta.changed)||!Array.isArray(delta.deleted)||delta.changed.length+delta.deleted.length>MAX_WORKSPACE_FILES*2)throw new Error('Недопустимый пакет изменений.');
 // Old clients can still report browser databases. Ignore those entries only;
 // they must not fail the real result or create/delete project files.
 delta={changed:delta.changed.filter(file=>!isIgnoredPortablePath(file?.path)),deleted:delta.deleted.filter(file=>!isIgnoredPortablePath(file?.path))};
 if(delta.changed.reduce((n,f)=>n+(typeof f.content==='string'?Math.ceil(f.content.length*3/4):0),0)>MAX_TRANSFER)throw new Error('Пакет изменений слишком большой.');
 const paths=new Set();for(const file of [...delta.changed,...delta.deleted]){const relative=portablePath(file.path);if(paths.has(relative))throw new Error('Повторяющийся путь изменения.');paths.add(relative);}
 for(const file of delta.changed){if(typeof file.source==='function'){if(!Number.isSafeInteger(file.size)||file.size<0||file.size>MAX_FILE||!/^[a-f0-9]{64}$/.test(file.hash))throw new Error('Некорректный файл результата.');continue;}const bytes=Buffer.from(file.content||'','base64');if(bytes.length>MAX_FILE||digest(bytes)!==file.hash)throw new Error('Повреждённый результат синхронизации: '+file.path);}
 // An empty checkpoint has no file conflicts to resolve. Avoid re-reading
 // the entire shared workspace while another chat saves its real changes.
 if(!delta.changed.length&&!delta.deleted.length)return {conflicts:[],overrides:{},changedPaths:[]};
 const baseline=new Map(before.map(f=>[f.path,f.hash])),current=currentFiles||new Map((await snapshot(root)).map(f=>[f.path,f.hash])),conflicts=[],overrides={};
 const pathConflict=error=>['SYMLINK_PATH','ENOTDIR','EISDIR','ENOTEMPTY','EEXIST'].includes(error.code)||/Путь занят файлом/.test(error.message);
 async function saveConflict(relative,source){let conflict='_conflicts/'+runId+'/'+relative;try{await atomicProjectWrite(root,conflict,source())}catch(error){if(!pathConflict(error))throw error;conflict=(error.code==='SYMLINK_PATH'?'_conflicts-'+runId.slice(0,100)+'_'+digest(Buffer.from(relative)).slice(0,12):'_conflicts/'+runId+'_'+digest(Buffer.from(relative)).slice(0,12))+'/'+relative.split('/').at(-1);await atomicProjectWrite(root,conflict,source());}conflicts.push(relative);overrides[relative]=conflict;}
 async function deletionConflict(file,present){const intent=Buffer.from(JSON.stringify({path:file.path,operation:'delete',expectedHash:file.hash,currentHash:present},null,2)),key=crypto.createHash('sha256').update(file.path).digest('hex')+'.json';try{await atomicProjectWrite(root,'_conflicts/'+runId+'/_deletions/'+key,intent)}catch(error){if(!pathConflict(error))throw error;await atomicProjectWrite(root,'_conflicts-deletions-'+runId.slice(0,100)+'/'+key,intent);}conflicts.push(file.path);}
 for(const file of delta.deleted){const present=current.get(file.path);if(!present)continue;
  if(present===baseline.get(file.path)&&baseline.get(file.path)===file.hash||Object.hasOwn(accepted,file.path)&&present===accepted[file.path]){try{await fs.rm(await filePath(root,file.path));accepted[file.path]=null;current.delete(file.path);}catch(error){if(error.code!=='SYMLINK_PATH')throw error;await deletionConflict(file,present);}}
  else await deletionConflict(file,present);
 }
 for(const file of delta.changed){const relative=file.path,present=current.get(relative);
  const source=()=>typeof file.source==='function'?checkedSource(file):Buffer.from(file.content,'base64');
  if(present===file.hash){accepted[relative]=file.hash;continue;}
  const own=Object.hasOwn(accepted,relative)&&(present||null)===accepted[relative];
  if(present!==baseline.get(relative)&&!own){await saveConflict(relative,source);continue;}
  try{await atomicProjectWrite(root,relative,source());accepted[relative]=file.hash;current.set(relative,file.hash);}catch(error){if(pathConflict(error))await saveConflict(relative,source);else throw error;}
 }
 return {conflicts,overrides,changedPaths:delta.changed.map(f=>f.path)};
}

async function* checkedSource(file){const hash=crypto.createHash('sha256');let size=0;for await(const bytes of file.source()){size+=bytes.length;if(size>file.size)throw new Error('Размер результата изменился.');hash.update(bytes);yield bytes;}if(size!==file.size||hash.digest('hex')!==file.hash)throw new Error('Контрольная сумма результата изменилась.');}
