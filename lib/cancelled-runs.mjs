// A heartbeat lists both live jobs and durable recovery journals/outbox entries.
// Only a cancelled/failed run, absent on three heartbeats of this connection, may close.
export function cancelledRunsMissing(pending,deviceId,running,results,counts,failedRuns=new Set()){
 const missing=[];
 for(const [runId,p]of Object.entries(pending)){
  if(p.deviceId!==deviceId||(!p.cancelRequested&&!failedRuns.has(runId)))continue;
  if(running.has(runId)||results.has(runId)){counts.delete(runId);continue;}
  const count=(counts.get(runId)||0)+1;counts.set(runId,count);if(count>=3)missing.push(runId);
 }
 for(const key of counts.keys())if(!pending[key]||!pending[key].cancelRequested&&!failedRuns.has(key))counts.delete(key);
 return missing;
}
