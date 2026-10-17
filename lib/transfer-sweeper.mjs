import fs from 'node:fs/promises';
import path from 'node:path';
const NAME=/^[a-zA-Z0-9_-]{1,240}$/;
// Directories named by run id whose last change is older than maxAgeMs.
// `keep` protects ids that are still referenced (running, journaled, queued).
export async function staleEntries(base,{maxAgeMs,now=Date.now(),keep=()=>false}){
 let entries;try{entries=await fs.readdir(base,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
 const stale=[];
 for(const entry of entries){
  if(!entry.isDirectory()||entry.isSymbolicLink()||!NAME.test(entry.name)||keep(entry.name))continue;
  const full=path.join(base,entry.name);const stat=await fs.lstat(full);if(!stat.isDirectory())continue;
  if(stat.mtimeMs<now-maxAgeMs)stale.push({name:entry.name,path:full,mtimeMs:stat.mtimeMs});
 }
 return stale;
}
// Move a directory aside instead of deleting it. Collisions get a timestamp suffix.
export async function parkDirectory(source,parkRoot,label){
 await fs.mkdir(parkRoot,{recursive:true,mode:0o700});const target=path.join(parkRoot,label);
 try{await fs.rename(source,target);return target;}
 catch(error){if(error.code==='ENOENT')return null;if(!['ENOTEMPTY','EEXIST'].includes(error.code))throw error;const alt=target+'-'+Date.now();await fs.rename(source,alt);return alt;}
}
