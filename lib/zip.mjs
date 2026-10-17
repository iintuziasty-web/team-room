const table=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0});
function crc(b){let n=0xffffffff;for(const v of b)n=table[(n^v)&255]^(n>>>8);return (n^0xffffffff)>>>0}
export function zip(entries){
  const pieces=[],central=[];let offset=0;
  for(const entry of entries){const name=Buffer.from(entry.name),bytes=Buffer.from(entry.content);const sum=crc(bytes);const h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt32LE(sum,14);h.writeUInt32LE(bytes.length,18);h.writeUInt32LE(bytes.length,22);h.writeUInt16LE(name.length,26);pieces.push(h,name,bytes);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt32LE(sum,16);c.writeUInt32LE(bytes.length,20);c.writeUInt32LE(bytes.length,24);c.writeUInt16LE(name.length,28);c.writeUInt32LE((entry.executable?0o100755:0o100600)*65536>>>0,38);c.writeUInt32LE(offset,42);central.push(c,name);offset+=h.length+name.length+bytes.length;}
  const dir=Buffer.concat(central);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...pieces,dir,end]);
}
