// Pinned model IDs verified against Anthropic's official catalogue on 2026-09-30.
// These supplement old CLI catalogues; a completed request, not this list, proves account access.
export const source='https://platform.claude.com/docs/en/models/overview';
const verified=[
 {model:'claude-opus-5-5',name:'Opus 5.5',description:'Claude Opus 5.5 · 1M context',defaultEffort:'medium'},
 {model:'claude-sonnet-5-5',name:'Sonnet 5.5',description:'Claude Sonnet 5.5 · 1M context',defaultEffort:'medium',isDefault:true},
 {model:'claude-fable-5-1',name:'Fable 5.1',description:'Claude Fable 5.1 · 1M context. Depending on plan, may use usage credits.',defaultEffort:'high',mayUseCredits:true},
 {model:'claude-haiku-4-5-20251001',name:'Haiku 4.5',description:'Claude Haiku 4.5 · 200K context',efforts:[]},
];
export function claudeModelList(runtime,version=''){
 const versionParts=version.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number)||[];const ultracode=versionParts[0]>2||versionParts[0]===2&&(versionParts[1]>1||versionParts[1]===1&&versionParts[2]>=203);
 const levels=model=>/haiku/i.test(model)?[]:/4-6/.test(model)?['low','medium','high','max']:['low','medium','high','xhigh','max',...(ultracode?['ultracode']:[])];
 const newest=verified.map(m=>({...m,efforts:m.efforts||levels(m.model),source,availability:'not-yet-verified'}));
 const seen=new Set(newest.map(m=>m.model));
 for(const m of runtime){if(seen.has(m.model)||/^(default|opus|sonnet|haiku|fable)(\[1m\])?$/.test(m.model))continue;newest.push({...m,isDefault:false,efforts:levels(m.model),mayUseCredits:/fable/i.test(m.model),availability:'cli-catalogue'});seen.add(m.model)}return newest;
}
