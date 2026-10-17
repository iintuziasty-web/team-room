export function quotaState(limits){
 const nested=limits?.rateLimits||limits?.rate_limits||limits;
 const buckets=limits?.rateLimitsByLimitId?Object.values(limits.rateLimitsByLimitId):[nested];
 const windows=buckets.flatMap(r=>[r?.primary,r?.secondary]).filter(w=>Number.isFinite(w?.usedPercent)&&(!w.resetsAt||w.resetsAt*1000>Date.now()));
 const unified=Object.values(limits?.unifiedWindows||{}).filter(w=>Number.isFinite(w?.utilization)&&(!w.resetsAt||w.resetsAt*1000>Date.now()));
 const claudeRemaining=unified.length?Math.min(...unified.map(w=>Math.max(0,100-w.utilization*100))):Number.isFinite(limits?.utilization)&&(!limits.resetsAt||limits.resetsAt*1000>Date.now())?Math.max(0,100-limits.utilization*100):null;
 const remaining=windows.length?Math.min(...windows.map(w=>Math.max(0,100-w.usedPercent))):claudeRemaining;
 const hasWindows=buckets.some(r=>r?.primary||r?.secondary)||Object.keys(limits?.unifiedWindows||{}).length>0;const status=(!limits?.resetsAt||limits.resetsAt*1000>Date.now())&&(!hasWindows||windows.length||unified.length)?limits?.status||limits?.rate_limit_status:null;
 return {remaining,near:remaining!==null?remaining<=10:/warning|allowed_warning/.test(status||''),exhausted:limits?.ordinaryUsageAllowed===false&&(!hasWindows||windows.length>0)||remaining!==null&&remaining<=0||/^(rejected|rate_limited|denied)$/.test(status||'')};
}
export function isUsageLimit(error){return /(?:rate.?limit|usage.?limit|limit reached|quota exceeded|out of .*tokens|hit your limit|exceeded.*limit|лимит.*(?:достиг|исчерп|законч)|429)/i.test(String(error))}
export function safeModel(catalog,provider,saved={}){
 const models=(catalog?.models||[]).filter(m=>!m.mayUseCredits&&!/fable/i.test(m.model));
 const selected=models.find(m=>m.model===saved.model)||models.find(m=>m.isDefault)||models[0];
 if(!selected)return null;const effort=selected.efforts?.includes(saved.effort)?saved.effort:selected.efforts?.includes('medium')?'medium':selected.defaultEffort||'';
 return {provider,model:selected.model,effort};
}
export function memoryModel(catalog,provider){const preferred=provider==='claude'?/haiku/i:/luna/i;const model=catalog?.models?.find(m=>!m.mayUseCredits&&preferred.test(m.model))||catalog?.models?.find(m=>!m.mayUseCredits&&!/fable/i.test(m.model));return model?{provider,model:model.model,effort:model.efforts?.includes('low')?'low':''}:null}
