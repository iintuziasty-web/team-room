// Completion receipts belong to the viewer, not to the chat owner/device.
export function recordCompletion(chat,message,runId,completedAt=new Date().toISOString()) {
 if(!message||message.role!=='assistant'||!['completed','failed','interrupted'].includes(message.status))return;
 const token=`${runId}:${message.id}`;
 if(chat.completion?.token===token)return;
 chat.completion={token,messageId:message.id,runId,completedAt,status:message.status};
}
export function completionState(chat,userId) {
 return {completion:chat.completion||null,unreadCompletion:Boolean(chat.completion&&chat.completionReads?.[userId]!==chat.completion.token)};
}
export function readCompletion(chat,userId,token) {
 if(!userId||!token||token!==chat.completion?.token)return false;
 chat.completionReads||={};
 chat.completionReads[userId]=token;
 return true;
}
