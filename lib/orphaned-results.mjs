import fs from 'node:fs/promises';
import path from 'node:path';
const RUN=/^[a-zA-Z0-9_-]{1,240}$/;
// The hub answers `result-unknown` when no pending run matches a delivered
// result (chat deleted, device re-paired, database restored from a backup).
// One answer may be transient; several answers over a couple of minutes mean
// the hub will never accept the result and retrying only keeps the chat busy.
export class UnknownResults{
 constructor({threshold=3,windowMs=120000,clock=Date.now}={}){this.rows=new Map();this.threshold=threshold;this.windowMs=windowMs;this.clock=clock;}
 note(runId){const at=this.clock();const row=this.rows.get(runId)||{count:0,firstAt:at};row.count++;this.rows.set(runId,row);return row.count>=this.threshold&&at-row.firstAt>=this.windowMs;}
 forget(runId){this.rows.delete(runId);}
}
// Park the outbox record and its spool directories under .result-orphaned/<runId>.
// Nothing is deleted: the owner can inspect or re-import the parked result.
export async function parkResult(root,runId,record,spools=[]){
 if(!RUN.test(runId||''))throw new Error('Недопустимый идентификатор результата.');
 const dir=path.join(root,'.result-orphaned',runId);await fs.mkdir(dir,{recursive:true,mode:0o700});
 const tmp=path.join(dir,'result.json.tmp');await fs.writeFile(tmp,JSON.stringify({parkedAt:new Date().toISOString(),reason:'result-unknown',record}),{mode:0o600});await fs.rename(tmp,path.join(dir,'result.json'));
 for(const spool of spools){
  const target=path.join(dir,path.basename(path.dirname(spool)).replace(/^\./,''));
  try{await fs.rename(spool,target);}catch(error){if(error.code==='ENOENT')continue;if(!['ENOTEMPTY','EEXIST'].includes(error.code))throw error;await fs.rename(spool,target+'-'+Date.now());}
 }
 return dir;
}
