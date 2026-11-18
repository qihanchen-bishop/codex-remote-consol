import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

const table=Uint32Array.from({length:256},(_,i)=>{for(let n=0;n<8;n++)i=(i>>>1)^((i&1)?0xedb88320:0);return i>>>0;});
const crc32=buffer=>{let crc=0xffffffff;for(const b of buffer)crc=table[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;};
export function zipFiles(files){
  const chunks=[],index=[];let offset=0;
  for(const [path,value]of files){
    if(!/^[a-zA-Z0-9_.\/-]+$/.test(path)||path.startsWith('/')||path.split('/').includes('..'))throw Error('Invalid package filename');
    const name=Buffer.from(path),data=Buffer.from(value),crc=crc32(data),local=Buffer.alloc(30),central=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(33,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt16LE(33,14);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    chunks.push(local,name,data);index.push(central,name);offset+=local.length+name.length+data.length;
  }
  const directory=Buffer.concat(index),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...chunks,directory,end]);
}
const sources=['package.json','package-lock.json','LICENSE','server.mjs','agent-connect.mjs','start-windows.ps1','start-linux.sh','CONNECTOR.md','lib/settings.mjs','lib/auth.mjs','lib/security.mjs','lib/codex.mjs','lib/stdio-socket.mjs','lib/questions.mjs','lib/thread-sync.mjs','lib/attachments.mjs','lib/machines.mjs','lib/connector-package.mjs','public/questions.mjs'];
export async function connectorPackage(root,machine){
  const files=await Promise.all(sources.map(async file=>[file,await readFile(join(root,file))]));
  files.push(['connector.json',JSON.stringify({id:machine.id,name:machine.name,os:machine.os,remotePort:machine.port,token:machine.token,...(machine.sshTarget?{sshTarget:machine.sshTarget}:{})},null,2)]);
  return zipFiles(files);
}
