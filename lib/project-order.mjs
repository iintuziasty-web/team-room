export function orderedProjects(projects,order=[]) {
 const ranks=new Map((Array.isArray(order)?order:[]).map((id,index)=>[id,index]));
 return [...projects].sort((a,b)=>(ranks.get(a.id)??Infinity)-(ranks.get(b.id)??Infinity));
}
export function moveProject(projects,order,projectId,targetId,placement) {
 if(!['before','after'].includes(placement)||projectId===targetId)return null;
 const ids=orderedProjects(projects,order).map(p=>p.id);
 if(!ids.includes(projectId)||!ids.includes(targetId))return null;
 ids.splice(ids.indexOf(projectId),1);
 ids.splice(ids.indexOf(targetId)+(placement==='after'?1:0),0,projectId);
 return ids;
}
