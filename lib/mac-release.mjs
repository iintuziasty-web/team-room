import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';

// Public, signed installers only. No project files or device configuration.
export async function serveMacRelease(req,res,pathname,folder){
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{allow:'GET, HEAD'});return res.end();}
 let name,type;
 if(pathname==='/desktop/releases/latest'){name='latest.json';type='application/json; charset=utf-8';}
 else{const match=pathname.match(/^\/desktop\/releases\/([a-f0-9]{64})\.zip$/);if(!match){res.writeHead(404);return res.end();}name=match[1]+'.zip';type='application/zip';}
 try{
  const file=path.join(folder,name),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Object.assign(new Error(),{code:'ENOENT'});
  res.writeHead(200,{'content-type':type,'content-length':stat.size,'cache-control':name==='latest.json'?'no-store':'public, max-age=31536000, immutable','x-content-type-options':'nosniff'});
  if(req.method==='HEAD')return res.end();await pipeline(createReadStream(file),res);
 }catch(error){if(!res.headersSent){res.writeHead(error.code==='ENOENT'?404:503,{'cache-control':'no-store'});res.end();}else res.destroy();}
}
