// Canonical origins are supplied by each self-hosted installation.
export function hubOrigin(value){
 if(typeof value!=='string'||!value.trim())throw new Error('Укажи TEAMROOM_HUB_URL своего сервера перед сборкой приложения.');
 let url;try{url=new URL(value.trim());}catch{throw new Error('Неверный TEAMROOM_HUB_URL.');}
 const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if((url.protocol!=='https:'&&!(loopback&&url.protocol==='http:'))||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw new Error('Нужен HTTPS адрес своего сервера без пути; HTTP разрешён только для localhost.');
 return url.origin;
}
