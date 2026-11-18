import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import {createConsole} from '../server.mjs';
import {MachineRegistry} from '../lib/machines.mjs';
import {CodexConnection} from '../lib/codex.mjs';
import {sshArguments} from '../agent-connect.mjs';

const id='32a3949f-a555-5b15-9670-6fe41388ac21',token='test-connector-token-'.repeat(3);
class Fake extends EventEmitter{
 connected=true;requests=new Map();last=[];
 constructor(name){super();this.name=name;}
 async connect(){}close(){}async listModels(){return [];}
 async rpc(method){if(method==='thread/list')return {data:[{id,name:this.name,cwd:'/test/'+this.name,status:{type:'idle'}}],nextCursor:null};if(method==='thread/read')return {thread:{id,name:this.name,status:{type:'idle'}}};if(method==='thread/turns/list')return {data:[],nextCursor:null};throw Error('Unexpected '+method);}
 async send(...args){this.last=args;return {turn:{id:'ack'}};}
}
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return server.address().port;}
async function login(base){const r=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'test',password:'test-password'})});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:(await r.json()).csrf};}

test('machine registration persists unique loopback ports and never lists connector secrets',async t=>{
 const dir=await mkdtemp('/tmp/codex-machines-registry-');t.after(()=>rm(dir,{recursive:true,force:true}));const registry=await new MachineRegistry(dir).init();
 const machines=await Promise.all([registry.add({name:'Windows',os:'windows'}),registry.add({name:'Linux',os:'linux'})]);
 assert.equal(new Set(machines.map(m=>m.port)).size,2);assert.equal(machines.some(m=>Object.hasOwn(m,'token')),false);
 assert.equal((await stat(join(dir,'machines.json'))).mode&0o777,0o600);const restored=await new MachineRegistry(dir).init();assert.equal(restored.list().length,2);assert.ok(restored.get(machines[0].id).token.length>=32);
 await assert.rejects(registry.add({name:'',os:'windows'}));await assert.rejects(registry.add({name:'Mac',os:'url:http://example.com'}));
});

test('one website login routes remote history, local images and SSE without sharing credentials or falling back to the local computer',async t=>{
 const dir=await mkdtemp('/tmp/codex-nodes-integration-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const remote=new Fake('REMOTE'),agent=await createConsole({stateDir:join(dir,'agent'),codex:remote,agentToken:token,publicOrigin:'',publicPath:''}),agentPort=await listen(agent.server);
 t.after(()=>{agent.close();agent.server.closeAllConnections();});
 const remoteHeaders=[];agent.server.prependListener('request',q=>remoteHeaders.push(q.headers));
 const hubDir=join(dir,'hub'),registry=await new MachineRegistry(hubDir).init();await registry.add({name:'Windows',os:'windows'});const machine=registry.machines[0];machine.port=agentPort;machine.token=token;await writeFile(registry.file,JSON.stringify(registry.machines),{mode:0o600});
 const local=new Fake('LOCAL'),hub=await createConsole({stateDir:hubDir,codex:local,username:'test',password:'test-password',publicOrigin:'',publicPath:''}),hubPort=await listen(hub.server);t.after(()=>{hub.close();hub.server.closeAllConnections();});
 const base=`http://127.0.0.1:${hubPort}`,path='/api/nodes/'+machine.id,auth=await login(base),headers={Cookie:auth.cookie,'X-Codex-CSRF':auth.csrf};
 assert.equal((await fetch(base+path+'/threads')).status,401);
 const listed=await (await fetch(base+'/api/machines',{headers})).json();assert.equal(listed.data.length,2);assert.ok(!JSON.stringify(listed).includes(token));
 assert.equal((await fetch(`http://127.0.0.1:${agentPort}/api/threads`)).status,401);
 const info=await (await fetch(base+path+'/session',{headers})).json();assert.equal(info.csrf,undefined);assert.ok(!JSON.stringify(info).includes(token));
 const history=await (await fetch(base+path+'/threads',{headers})).json();assert.equal(history.data[0].name,'REMOTE');
 const pic=await sharp({create:{width:40,height:30,channels:3,background:'#448822'}}).png().toBuffer();
 assert.equal((await fetch(base+path+'/attachments',{method:'POST',headers:{Cookie:auth.cookie,'content-type':'image/png'},body:pic})).status,403);
 const upload=await fetch(base+path+'/attachments',{method:'POST',headers:{...headers,'content-type':'image/png'},body:pic});assert.equal(upload.status,201);const image=await upload.json();
 assert.equal((await fetch(base+path+'/attachments/'+image.id,{headers})).status,200);assert.equal((await fetch(base+'/api/attachments/'+image.id,{headers})).status,404);
 const send=await fetch(base+path+`/threads/${id}/messages`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({clientId:id,text:'image',images:[image.id]})});assert.equal(send.status,200);assert.ok(remote.last[3].images[0].path.startsWith(join(dir,'agent','attachments')));assert.equal(local.last.length,0);
 for(const h of remoteHeaders.filter(h=>h['x-codex-agent-token'])){assert.equal(h.cookie,undefined);assert.equal(h.origin,undefined);assert.equal(h['x-codex-agent-token'],token);assert.equal(h['x-codex-csrf'],token);}
 const controller=new AbortController(),sse=await fetch(base+path+'/events?threadId='+id,{headers,signal:controller.signal});assert.equal(sse.status,200);const reader=sse.body.getReader(),first=await reader.read();assert.match(Buffer.from(first.value).toString(),/event: connection/);controller.abort();await reader.cancel().catch(()=>{});
 agent.close();agent.server.closeAllConnections();await new Promise(r=>setTimeout(r,20));assert.equal((await fetch(base+path+'/health',{headers})).status,502);const unchanged=await (await fetch(base+'/api/threads',{headers})).json();assert.equal(unchanged.data[0].name,'LOCAL');
});

test('connector packages require login and include only the selected machine key with no server credentials',async t=>{
 const dir=await mkdtemp('/tmp/codex-node-package-');t.after(()=>rm(dir,{recursive:true,force:true}));const hub=await createConsole({stateDir:dir,codex:new Fake('LOCAL'),username:'test',password:'test-password',publicOrigin:'',publicPath:''}),port=await listen(hub.server);t.after(()=>{hub.close();hub.server.closeAllConnections();});const base=`http://127.0.0.1:${port}`,auth=await login(base),headers={Cookie:auth.cookie,'X-Codex-CSRF':auth.csrf,'content-type':'application/json'};
 assert.equal((await fetch(base+'/api/machines',{method:'POST',headers:{Cookie:auth.cookie,'content-type':'application/json'},body:'{"name":"Windows","os":"windows"}'})).status,403);
 const added=await fetch(base+'/api/machines',{method:'POST',headers,body:'{"name":"Windows","os":"windows"}'});assert.equal(added.status,201);const machine=await added.json(),path='/api/machines/'+machine.id+'/package';assert.equal((await fetch(base+path)).status,401);
 const download=await fetch(base+path,{headers});assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'application/zip');assert.match(download.headers.get('cache-control'),/no-store/);const zip=Buffer.from(await download.arrayBuffer()),files=new Map();let pos=0;
 while(zip.readUInt32LE(pos)===0x04034b50){const size=zip.readUInt32LE(pos+18),nameLen=zip.readUInt16LE(pos+26),extra=zip.readUInt16LE(pos+28),name=zip.subarray(pos+30,pos+30+nameLen).toString(),start=pos+30+nameLen+extra;files.set(name,zip.subarray(start,start+size));pos=start+size;}
 assert.ok(files.has('start-windows.ps1'));assert.ok(files.has('start-linux.sh'));assert.ok(files.has('agent-connect.mjs'));assert.equal([...files.keys()].some(f=>f.startsWith('.local')||f.includes('credentials')),false);
 const config=JSON.parse(files.get('connector.json')),stored=JSON.parse(await readFile(join(dir,'machines.json'),'utf8'));assert.equal(config.token,stored[0].token);assert.equal(config.remotePort,machine.port);assert.ok(!zip.includes(Buffer.from('test-password')));assert.ok(!zip.includes(await readFile(join(dir,'credentials.json')).catch(()=>Buffer.from('impossible-credential-value'))));
});

test('stdio connections initialize separately from requests and never automatically answer approvals',async t=>{
 const dir=await mkdtemp('/tmp/codex-stdio-test-');t.after(()=>rm(dir,{recursive:true,force:true}));const script=join(dir,'fake.mjs');await writeFile(script,`import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);if(q.method==='initialized')continue;if(q.method==='initialize'){console.log(JSON.stringify({id:q.id,result:{serverInfo:{name:'fake'}}}));console.log(JSON.stringify({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn'}}));}else if(q.method==='thread/list')console.log(JSON.stringify({id:q.id,result:{data:[],nextCursor:null}}));}`);
 const c=new CodexConnection('/unused',{command:[process.execPath,script]});t.after(()=>c.close());const requested=once(c,'request');await c.connect();assert.equal(c.connected,true);await requested;assert.equal(c.requests.size,1);await c.rpc('thread/list');assert.equal(c.requests.size,1);assert.throws(()=>c.respond([...c.requests.keys()][0],{decision:'acceptForSession'}));assert.equal(c.requests.size,1);
 const exited=once(c.ws.child,'exit');c.close();await exited;
});

test('SSH uses a loopback reverse tunnel without approving host keys or changing server permissions',()=>{
 const args=sshArguments('operator@server.example',18781,22222,2200);assert.ok(args.includes('127.0.0.1:18781:127.0.0.1:22222'));assert.equal(args.at(-1),'operator@server.example');assert.ok(args.includes('ExitOnForwardFailure=yes'));assert.equal(args.some(a=>/StrictHostKeyChecking|UserKnownHostsFile|GatewayPorts/.test(a)),false);assert.throws(()=>sshArguments('-oProxyCommand=bad',18781,22222));assert.throws(()=>sshArguments('server;bad',18781,22222));
});
