import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';

const SOCKET_NAME='admin-diagnostics.sock';
const MAX_REQUEST=4096,MAX_RESPONSE=64*1024,DEADLINE=45000,MAX_CONNECTIONS=2;
const sameEntry=(a,b)=>a&&b&&a.dev===b.dev&&a.ino===b.ino;
async function statOrMissing(filename){try{return await fs.lstat(filename);}catch(error){if(error.code==='ENOENT')return null;throw error;}}

async function removeStaleSocket(filename,uid){
 const original=await statOrMissing(filename);if(!original)return;
 if(!original.isSocket()||original.isSymbolicLink()||original.uid!==uid||original.nlink!==1||(original.mode&0o077))throw new Error('ADMIN_DIAGNOSTICS_UNSAFE_SOCKET');
 const stale=await new Promise((resolve,reject)=>{
  const socket=net.createConnection(filename),timer=setTimeout(()=>finish(new Error('ADMIN_DIAGNOSTICS_SOCKET_UNAVAILABLE')),500);
  const finish=(error,value)=>{clearTimeout(timer);socket.destroy();error?reject(error):resolve(value);};
  socket.once('connect',()=>finish(new Error('ADMIN_DIAGNOSTICS_ALREADY_RUNNING')));
  socket.once('error',error=>error.code==='ECONNREFUSED'||error.code==='ENOENT'?finish(null,true):finish(new Error('ADMIN_DIAGNOSTICS_SOCKET_UNAVAILABLE')));
 });
 if(!stale)return;
 const current=await statOrMissing(filename);if(!current)return;
 if(!sameEntry(original,current)||!current.isSocket()||current.isSymbolicLink())throw new Error('ADMIN_DIAGNOSTICS_SOCKET_CHANGED');
 await fs.unlink(filename);
}

// Private, local-only metadata for an administrator already using SSH. The
// callback must return a whitelist of status fields, never prompts, tool
// contents, account credentials, configuration files or arbitrary requests.
export async function createAdminDiagnostics({storage,sessions}={}){
 if(process.platform==='win32'||typeof process.getuid!=='function')throw new Error('ADMIN_DIAGNOSTICS_UNIX_ONLY');
 if(typeof storage!=='string'||!path.isAbsolute(storage)||typeof sessions!=='function')throw new TypeError('ADMIN_DIAGNOSTICS_INVALID_OPTIONS');
 const directory=path.resolve(storage),uid=process.getuid(),directoryStat=await fs.lstat(directory);
 if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink()||directoryStat.uid!==uid||(directoryStat.mode&0o022)||await fs.realpath(directory)!==directory)throw new Error('ADMIN_DIAGNOSTICS_UNSAFE_DIRECTORY');
 const socketPath=path.join(directory,SOCKET_NAME);await removeStaleSocket(socketPath,uid);
 let closing=false,ready=false,inflight=0,boundStat;
 const clients=new Set();
 const server=net.createServer({allowHalfOpen:true},socket=>{
  if(!ready||closing||clients.size>=MAX_CONNECTIONS){socket.destroy();return;}
  clients.add(socket);let input=[],bytes=0,started=false,answered=false;
  const controller=new AbortController();
  const respond=value=>{
   if(answered||socket.destroyed)return;answered=true;clearTimeout(timer);
   let encoded;try{encoded=Buffer.from(JSON.stringify(value)+'\n');}catch{encoded=Buffer.from('{"ok":false,"error":"INVALID_RESULT"}\n');}
   if(encoded.length>MAX_RESPONSE)encoded=Buffer.from('{"ok":false,"error":"RESULT_TOO_LARGE"}\n');
   socket.end(encoded);const destroyTimer=setTimeout(()=>socket.destroy(),1000);destroyTimer.unref();socket.once('close',()=>clearTimeout(destroyTimer));
  };
  const reject=error=>{controller.abort();respond({ok:false,error});};
  const timer=setTimeout(()=>reject('TIMEOUT'),DEADLINE);timer.unref();
  socket.on('error',()=>{});
  socket.once('close',()=>{clearTimeout(timer);clients.delete(socket);controller.abort();});
  socket.on('data',chunk=>{
   if(started){reject('ONE_REQUEST_ONLY');return;}
   bytes+=chunk.length;if(bytes>MAX_REQUEST){reject('REQUEST_TOO_LARGE');return;}
   input.push(chunk);const data=Buffer.concat(input),end=data.indexOf(10);if(end<0)return;
   started=true;input=[];
   if(data.subarray(end+1).toString('utf8').trim()){reject('ONE_REQUEST_ONLY');return;}
   let request;try{request=JSON.parse(data.subarray(0,end).toString('utf8'));}catch{reject('INVALID_REQUEST');return;}
   if(!request||Array.isArray(request)||typeof request!=='object'||Object.keys(request).length!==1||request.action!=='sessions'){reject('UNSUPPORTED_ACTION');return;}
   if(inflight>=MAX_CONNECTIONS){reject('BUSY');return;}
   inflight++;
   Promise.resolve().then(()=>sessions({signal:controller.signal})).then(result=>{
    if(!controller.signal.aborted)respond({ok:true,result});
   },()=>{if(!controller.signal.aborted)respond({ok:false,error:'DIAGNOSTICS_UNAVAILABLE'});}).finally(()=>{inflight--;});
  });
  socket.once('end',()=>{if(!started)reject('INCOMPLETE_REQUEST');});
 });
 server.maxConnections=MAX_CONNECTIONS;
 await new Promise((resolve,reject)=>{
  const failed=()=>{server.removeListener('listening',listening);reject(new Error('ADMIN_DIAGNOSTICS_LISTEN_FAILED'));};
  const listening=()=>{server.removeListener('error',failed);resolve();};
  server.once('error',failed);server.once('listening',listening);
  // Binding a Unix socket is synchronous inside listen(). Restrict its initial
  // permissions too; chmod after listen alone would leave an exposure window.
  const previousMask=process.umask(0o177);try{server.listen(socketPath);}catch{failed();}finally{process.umask(previousMask);}
 });
 server.on('error',()=>{});
 try{
  const currentDirectory=await fs.lstat(directory);boundStat=await fs.lstat(socketPath);
  if(!sameEntry(directoryStat,currentDirectory)||!boundStat.isSocket()||boundStat.isSymbolicLink()||boundStat.uid!==uid||boundStat.nlink!==1)throw new Error('ADMIN_DIAGNOSTICS_SOCKET_CHANGED');
  await fs.chmod(socketPath,0o600);ready=true;
 }catch(error){await new Promise(resolve=>server.close(resolve));throw error;}
 return {socketPath,close:async()=>{
  if(closing)return;closing=true;ready=false;for(const client of clients)client.destroy();
  await new Promise(resolve=>server.close(resolve));
  const current=await statOrMissing(socketPath);if(sameEntry(boundStat,current)&&current.isSocket()&&!current.isSymbolicLink())await fs.unlink(socketPath);
 }};
}
