// A slow/backgrounded browser must not accumulate every intermediate reply in
// memory. Reconnection uses the existing authoritative HTTP reconciliation.
export function sendBrowserPacket(ws,packet){
 if(ws.readyState!==1)return false;
 if(ws.bufferedAmount>1024*1024){
  if(!ws.backpressureClosing){
   ws.backpressureClosing=true;ws.close(1013,'Восстанавливаю поток обновлений');
   const timer=setTimeout(()=>{if(ws.readyState!==3)ws.terminate?.();},1500);timer.unref?.();
   ws.once?.('close',()=>clearTimeout(timer));
  }
  return false;
 }
 try{ws.send(packet);return true;}catch{return false;}
}

export class BrowserReplies{
 constructor(){this.replies=new Map();}
 broadcast(value,sockets,valid){
  const key=value.chatId+':'+value.messageId,previous=this.replies.get(key);
  let full,partial;
  const canAppend=previous&&previous.runId===value.runId&&Number.isSafeInteger(previous.streamRevision)&&typeof value.text==='string'&&value.text.startsWith(previous.text);
  for(const ws of sockets){
   if(!valid(ws)){ws.close(4001,'Вход завершён');continue;}
   let packet;
   if(ws.replyDeltas===1&&canAppend&&ws.replyRevisions?.get(key)===previous.streamRevision){
    if(!partial){const {text,...rest}=value;partial=JSON.stringify({...rest,delta:{offset:previous.text.length,text:text.slice(previous.text.length),baseRevision:previous.streamRevision}});}
    packet=partial;
   }else packet=full||=JSON.stringify(value);
   if(sendBrowserPacket(ws,packet)){
    ws.replyRevisions||=new Map();ws.replyRevisions.delete(key);ws.replyRevisions.set(key,value.streamRevision);
    while(ws.replyRevisions.size>16)ws.replyRevisions.delete(ws.replyRevisions.keys().next().value);
   }
  }
  this.replies.delete(key);this.replies.set(key,{runId:value.runId,streamRevision:value.streamRevision,text:value.text});
  while(this.replies.size>32)this.replies.delete(this.replies.keys().next().value);
 }
 complete(value){this.replies.delete(value.chatId+':'+value.messageId);}
}
