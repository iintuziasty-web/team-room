const metadata=file=>{const {content,source,...value}=file;return value;};
export const checkpointContentKey=packet=>JSON.stringify({text:packet.text||'',followups:packet.followups||[],agentNotes:packet.agentNotes||null});

// ACKed files are a bandwidth baseline, not the original conflict baseline.
// Every attempted publication is retained separately for final reconciliation:
// the hub may have saved a checkpoint even if its ACK was lost.
export class CheckpointState{
 constructor(before=[],publications=[]){
  this.original=new Map(before.map(file=>[file.path,metadata(file)]));
  this.acknowledged=new Map(this.original);
  this.touched=new Map(publications.map(file=>[file.path,metadata(file)]));
  this.contentKey=checkpointContentKey({});
 }
 baseline(){return [...this.acknowledged.values()];}
 publications(){return [...this.touched.values()];}
 record(delta){for(const file of [...delta.changed,...delta.deleted])this.touched.set(file.path,metadata(file));}
 acknowledge(packet){
  for(const file of packet.changes.deleted)this.acknowledged.delete(file.path);
  for(const file of packet.changes.changed)this.acknowledged.set(file.path,metadata(file));
  this.contentKey=checkpointContentKey(packet);
 }
 finalBaseline(){
  const files=new Map(this.original);
  // null cannot match a SHA-256. Force each published path into the final
  // scan's delta, including a file restored to its original bytes. changes()
  // still decides which missing paths are safe deletions (e.g. no symlinks).
  for(const [name,file]of this.touched)files.set(name,{...(this.original.get(name)||file),hash:null});
  return [...files.values()];
 }
 finalChanges(delta){
  return {changed:delta.changed,deleted:delta.deleted.map(file=>file.hash===null?{...file,hash:(this.original.get(file.path)||this.touched.get(file.path)).hash}:file)};
 }
}
