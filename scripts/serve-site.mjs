import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../docs/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png','.md':'text/plain; charset=utf-8','.txt':'text/plain; charset=utf-8'};
http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost'),relative=decodeURIComponent(url.pathname).replace(/^\//,'')||'index.html',file=path.resolve(root,relative);if(!file.startsWith(root))throw Error('Invalid path');const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Missing');res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','cache-control':'no-store'});res.end(await fs.readFile(file));}catch{res.writeHead(404);res.end('Not found');}}).listen(4321,'127.0.0.1',()=>console.log('Landing: http://127.0.0.1:4321'));
