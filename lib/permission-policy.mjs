export const permissionModes=['manual','auto','full'];
export function executionMode(value){
 if(value==null||value==='')return 'build';
 if(!['plan','build'].includes(value))throw Object.assign(new Error('Неизвестный режим работы.'),{status:400});
 return value;
}
export function permissionMode(value){
 if(value==null||value==='')return 'manual';
 if(!permissionModes.includes(value))throw Object.assign(new Error('Неизвестный режим разрешений.'),{status:400});
 return value;
}
export function permissionPolicy(value,readOnly=false){
 const mode=readOnly?'manual':permissionMode(value);
 return {claude:readOnly?'manual':({manual:'manual',auto:'auto',full:'bypassPermissions'}[mode]),
 approvalPolicy:mode==='full'?'never':'on-request',approvalsReviewer:mode==='auto'?'auto_review':'user',
 sandbox:readOnly?'read-only':mode==='full'?'danger-full-access':'workspace-write',
 sandboxPolicy:readOnly?{type:'readOnly'}:mode==='full'?{type:'dangerFullAccess'}:null};
}
