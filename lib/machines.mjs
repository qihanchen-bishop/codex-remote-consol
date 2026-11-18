import http from 'node:http';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
const fail=(status,message)=>Object.assign(new Error(message),{status});

export class MachineRegistry {
  constructor(directory){this.directory=directory;this.file=join(directory,'machines.json');this.machines=[];this.queue=Promise.resolve();}
  async init(){await mkdir(this.directory,{recursive:true,mode:0o700});try{const data=JSON.parse(await readFile(this.file,'utf8'));if(!Array.isArray(data))throw Error('电脑配置文件无效');for(const m of data){if(!/^[a-z0-9-]{1,64}$/.test(m.id)||!Number.isInteger(m.port)||m.port<1024||m.port>65535||typeof m.token!=='string'||m.token.length<32)throw Error('电脑配置文件无效');}this.machines=data;}catch(e){if(e.code!=='ENOENT')throw e;}return this;}
  public(m){return {id:m.id,name:m.name,os:m.os,port:m.port};}
  list(){return this.machines.map(m=>this.public(m));}
  get(id){const m=this.machines.find(m=>m.id===id);if(!m)throw fail(404,'未注册这台电脑');return m;}
  add({name,os}){
    const task=this.queue.then(async()=>{
      if(typeof name!=='string'||!name.trim()||name.length>60||!['windows','linux'].includes(os))throw fail(400,'请填写电脑名称并选择系统');
      if(this.machines.length>=20)throw fail(400,'最多添加20台电脑');
      let port=18781;while(this.machines.some(m=>m.port===port))port++;
      const m={id:os+'-'+randomUUID().slice(0,8),name:name.trim(),os,port,token:randomBytes(32).toString('base64url')};
      const next=[...this.machines,m],temp=this.file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(next,null,2),{mode:0o600,flag:'wx'});await rename(temp,this.file);this.machines=next;return this.public(m);
    });this.queue=task.catch(()=>{});return task;
  }
}

// Loopback only: the endpoint is provided by an authenticated SSH reverse
// tunnel. Never accept browser-selected URLs or forward website cookies/CSRF.
export function proxyMachine(request,response,machine,path,{onStream}={}) {
  const headers={'host':`127.0.0.1:${machine.port}`,'x-codex-agent-token':machine.token,'x-codex-csrf':machine.token};
  for(const name of ['content-type','content-length','x-file-name','accept','if-none-match'])if(request.headers[name])headers[name]=request.headers[name];
  const upstream=http.request({hostname:'127.0.0.1',port:machine.port,path,method:request.method,headers},incoming=>{
    if([401,403].includes(incoming.statusCode)){incoming.resume();response.writeHead(502,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify({error:'这台电脑的接入认证失败，请使用对应的接入包重新连接'}));return;}
    const out={};for(const name of ['content-type','content-disposition','etag','x-content-type-options'])if(incoming.headers[name])out[name]=incoming.headers[name];
    out['cache-control']=incoming.headers['cache-control']?.startsWith('private')?incoming.headers['cache-control']:'no-store';
    response.writeHead(incoming.statusCode,out);
    if(incoming.headers['content-type']?.startsWith('text/event-stream')){response.flushHeaders();onStream?.(response);}
    incoming.on('error',()=>response.destroy());incoming.pipe(response);
  });
  upstream.setTimeout(45000,()=>{if(!response.headersSent)upstream.destroy(new Error('timeout'));});
  upstream.on('error',()=>{if(response.headersSent)response.end();else{response.writeHead(502,{'content-type':'application/json; charset=utf-8'});response.end(JSON.stringify({error:'这台电脑尚未连接或已离线，请检查接入程序和 SSH 隧道'}));}});
  request.on('aborted',()=>upstream.destroy());response.on('close',()=>upstream.destroy());request.pipe(upstream);
}
