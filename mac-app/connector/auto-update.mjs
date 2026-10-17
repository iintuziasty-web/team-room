// The signed desktop bundle already contains the connector. The installed
// launch agent owns a separate copy, so replacing the .app alone cannot update it.
export function newerConnectorVersion(next,current){
 const parse=value=>String(value||'').match(/^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/);
 const a=parse(next),b=parse(current);if(!a||!b)return false;
 for(let index=1;index<=3;index++){if(Number(a[index])!==Number(b[index]))return Number(a[index])>Number(b[index]);}
 if(a[4]===b[4])return false;if(!a[4])return true;if(!b[4])return false;
 return a[4].localeCompare(b[4],undefined,{numeric:true})>0;
}

export class IdleConnectorUpdater {
 constructor({version,discover,update,serialize=action=>action(),canRun=()=>true,event=()=>{},safeError=error=>String(error.message||error),now=Date.now,retryMs=300000}){
  Object.assign(this,{version,discover,update,serialize,canRun,event,safeError,now,retryMs});
  this.states=new Map();this.pending=null;this.closed=false;
 }
 snapshot(id){return this.states.get(id)||null;}
 stop(){this.closed=true;}
 report(entry,state,message,extra={}){
  const previous=this.states.get(entry.id),value={state,version:this.version,message,...extra};this.states.set(entry.id,value);
  if(previous?.state!==state||previous?.message!==message)this.event('connector-update',{...value,connectionId:entry.id});
 }
 check(){
  if(this.closed)return Promise.resolve();if(this.pending)return this.pending;
  const request=this.serialize(async()=>{
   if(this.closed||!this.canRun())return;
   const entries=await this.discover();
   for(const entry of entries){
    if(this.closed||!this.canRun())return;
    // Unknown/custom launch configurations remain a manual repair. Never
    // downgrade a connector that is newer than the installed desktop bundle.
    if(!entry.agent?.plist||entry.pairingOnly)continue;
    const previous=this.states.get(entry.id),current=entry.diagnostics?.connectorVersion;
    if(!newerConnectorVersion(this.version,current)){
     if(previous&&current===this.version&&entry.connected)this.report(entry,'updated','Фоновое подключение обновлено до '+this.version+'.');
     else if(newerConnectorVersion(current,this.version))this.states.delete(entry.id);
     continue;
    }
    if(previous?.state==='updated')continue;
    if(!entry.journalValid){this.report(entry,'attention','Автообновление отложено: нужно проверить журнал задач этого Mac.');continue;}
    if(entry.diagnostics?.loginBusy){this.report(entry,'waiting','Подключение обновится автоматически после завершения входа в подписку.');continue;}
    const savedRecovery=Boolean((entry.running||entry.pending)&&entry.savedResultsUpdateEligible===true);
    if((entry.running||entry.pending)&&!savedRecovery){this.report(entry,'waiting','Подключение обновится автоматически после завершения задач и сохранения результатов.');continue;}
    if(previous?.retryAt>this.now())continue;
    this.report(entry,'updating',savedRecovery?'Обновляю подключение для восстановления уже сохранённых результатов…':'Обновляю фоновое подключение этого Mac…');
    try{
     // updateImport rechecks journals, obtains the server maintenance lease,
     // preserves credentials/workspaces and rolls back an unsuccessful start.
     await this.update(entry,{allowSavedResults:savedRecovery});
     this.report(entry,'updated',savedRecovery?'Подключение обновлено до '+this.version+'. Сохранённые результаты восстанавливаются автоматически.':'Фоновое подключение обновлено до '+this.version+'.');
    }catch(error){
     this.report(entry,'retry','Автообновление отложено. '+this.safeError(error),{retryAt:this.now()+this.retryMs});
    }
   }
  }).catch(()=>{}).finally(()=>{if(this.pending===request)this.pending=null;});
  this.pending=request;return request;
 }
}
