import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {AttachmentStore} from '../lib/attachments.mjs';
import {CodexConnection} from '../lib/codex.mjs';
import {createConsole} from '../server.mjs';

const id='d198beba-c50f-566a-80c4-a51e36d001b9';
const models=[{id:'vision',model:'vision',displayName:'Vision',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'high'}],inputModalities:['text','image'],isDefault:true},{id:'text',model:'text',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}],inputModalities:['text']}];
const png=()=>sharp({create:{width:80,height:60,channels:3,background:'#24aa50'}}).png().toBuffer();

test('uploaded images are decoded, bounded, private, durable and resolved only by issued IDs',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'codex-image-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new AttachmentStore(dir).init(),image=await store.create(await png(),'截图.png','image/png');
 assert.equal(image.width,80);assert.equal(image.height,60);assert.equal(image.mime,'image/jpeg');
 const input=store.inputs([image.id])[0];assert.equal(input.type,'localImage');assert.equal((await stat(input.path)).mode&0o777,0o600);
 assert.equal((await sharp(await readFile(input.path)).metadata()).width,80);
 assert.throws(()=>store.inputs(['../../credentials.json']),/图片不存在/);assert.throws(()=>store.inputs([image.id,image.id]),/不同的图片/);
 await assert.rejects(store.create(Buffer.from('<svg onload="alert(1)"></svg>'),'fake.png','image/png'),/无法读取/);
 await assert.rejects(store.create(await png(),'a.svg','image/svg+xml'),/请选择/);
 const restored=await new AttachmentStore(dir).init();assert.equal(restored.get(image.id).name,'截图.png');
 const history=restored.decorate({data:[{items:[{type:'userMessage',content:[input,{type:'localImage',path:'/private/secret.png'}]}]}]});
 assert.equal(history.data[0].items[0].content[0].webAttachment.id,image.id);assert.equal(history.data[0].items[0].content[1].webAttachment,undefined);
});

test('explicit model and effort changes preserve permissions and use native localImage input',async()=>{
 const c=new CodexConnection('/unused');const calls=[];c.connect=async()=>{};
 c.raw=async(method,params)=>{calls.push({method,params});if(method==='model/list')return {data:models,nextCursor:null};if(method==='thread/read')return {thread:{model:'vision',modelProvider:'openai',status:{type:'idle'}}};if(method==='thread/resume')return {thread:{id}};if(method==='turn/start')return {turn:{id:'turn'}};throw Error(method);};
 await c.send(id,'看图','client',{model:'vision',effort:'high',images:[{type:'localImage',path:'/test/image.jpg'}]});
 const params=calls.find(x=>x.method==='turn/start').params;
 assert.equal(params.model,'vision');assert.equal(params.effort,'high');assert.equal(params.input[1].type,'localImage');
 for(const key of ['sandbox','sandboxPolicy','approvalPolicy','approvalsReviewer','permissions','serviceTier'])assert.equal(Object.hasOwn(params,key),false);
 calls.length=0;await assert.rejects(c.send(id,'x','other',{model:'missing'}),/可用的模型/);assert.equal(calls.some(x=>x.method==='thread/resume'||x.method==='turn/start'),false);
 await assert.rejects(c.send(id,'x','other',{model:'text',images:[{type:'localImage',path:'/test.jpg'}]}),/不支持图片/);
 await assert.rejects(c.send(id,'x','other',{model:'text',effort:'ultra'}),/推理强度/);
 calls.length=0;await c.send(id,'','image-only',{images:[{type:'localImage',path:'/test.jpg'}]});assert.deepEqual(calls.find(x=>x.method==='turn/start').params.input,[{type:'localImage',path:'/test.jpg'}]);
});

test('image upload/read and model endpoints require authentication; uploads require CSRF',async t=>{
 class Fake extends EventEmitter{connected=true;requests=new Map();last=null;async connect(){}close(){}async listModels(){return models;}async send(...args){this.last=args;return {turn:{id:'turn'}};}}
 const stateDir=await mkdtemp(join(tmpdir(),'codex-upload-api-')),codex=new Fake();
 const app=await createConsole({stateDir,codex,username:'test',password:'test-password'});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.close();app.server.closeAllConnections();await rm(stateDir,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.server.address().port}`,image=await png();
 assert.equal((await fetch(base+'/api/models')).status,401);
 assert.equal((await fetch(base+'/api/attachments',{method:'POST',headers:{'Content-Type':'image/png'},body:image})).status,401);
 const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'test',password:'test-password'})});const cookie=login.headers.get('set-cookie').split(';')[0],{csrf}=await login.json();
 assert.equal((await fetch(base+'/api/models',{headers:{Cookie:cookie}})).status,200);
 assert.equal((await fetch(base+'/api/attachments',{method:'POST',headers:{Cookie:cookie,'Content-Type':'image/png'},body:image})).status,403);
 const upload=await fetch(base+'/api/attachments',{method:'POST',headers:{Cookie:cookie,'Content-Type':'image/png','X-Codex-CSRF':csrf,'X-File-Name':encodeURIComponent('测试.png')},body:image});assert.equal(upload.status,201);const attachment=await upload.json();
 assert.equal((await fetch(base+'/api/attachments/'+attachment.id)).status,401);
 const download=await fetch(base+'/api/attachments/'+attachment.id,{headers:{Cookie:cookie}});assert.equal(download.status,200);assert.match(download.headers.get('cache-control'),/private/);
 const send=await fetch(base+`/api/threads/${id}/messages`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Codex-CSRF':csrf},body:JSON.stringify({text:'',images:[attachment.id],model:'vision',effort:'high',clientId:id})});assert.equal(send.status,200);
 assert.equal(codex.last[1],'');assert.equal(codex.last[3].images[0].type,'localImage');assert.equal(codex.last[3].model,'vision');assert.equal(codex.last[3].effort,'high');
});
