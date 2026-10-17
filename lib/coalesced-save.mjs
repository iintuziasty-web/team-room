// Keep one write in progress and one pending batch, regardless of event rate.
// A caller resolves only after a snapshot taken after its request is durable.
export function coalescedSave(write) {
 let next, running=false;
 async function drain() {
  running=true;
  while(next) {
   const batch=next;next=null;
   try {await write();batch.resolve();} catch(error) {batch.reject(error);}
  }
  running=false;
 }
 return function save() {
  if(!next) {
   let resolve,reject;
   const promise=new Promise((a,b)=>{resolve=a;reject=b;});
   next={promise,resolve,reject};
  }
  const result=next.promise;
  if(!running) {running=true;queueMicrotask(()=>void drain());}
  return result;
 };
}
