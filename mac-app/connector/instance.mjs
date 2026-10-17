import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
// This file belongs to the newly built application, never to a shared updater.
const resources=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let config={};try{config=JSON.parse(fs.readFileSync(path.join(resources,'instance.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw new Error('Настройки этой сборки повреждены.');}
function origin(value){
 if(typeof value!=='string'||!value.trim())throw new Error('Собери приложение с TEAMROOM_HUB_URL своего сервера.');
 const url=new URL(value),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if((url.protocol!=='https:'&&!(local&&url.protocol==='http:'))||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw new Error('Неверный адрес собственного сервера.');
 return url.origin;
}
export const HUB=origin(config.hubUrl||process.env.TEAMROOM_HUB_URL);
export const updatesEnabled=config.updatesEnabled===true;
