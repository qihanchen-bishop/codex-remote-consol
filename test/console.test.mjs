import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsole } from '../server.mjs';
import { approvalResult } from '../lib/codex.mjs';
import { isPrivateIP, allowedHost } from '../lib/security.mjs';

const id='09923bf0-676e-5806-b824-1fee99d75dbf';
class FakeCodex extends EventEmitter {
  connected=true; requests=new Map();calls=[];sends=0;info={userAgent:'test'};
  async connect(){} close(){}
  async rpc(method,params){this.calls.push([method,params]);if(method==='thread/list')return {data:[{id}],nextCursor:null};if(method==='thread/read')return {thread:{id,status:{type:'idle'}}};if(method==='thread/turns/list')return {data:[],nextCursor:null};throw Error('unexpected '+method);}
  async send(threadId,text,clientId){this.sends++;await new Promise(resolve=>setTimeout(resolve,20));return {turn:{id:'test-turn',status:'inProgress'}};}
}
async function fixture(t){
  const stateDir=await mkdtemp(join(tmpdir(),'console-test-')); const codex=new FakeCodex(); const username='console-user', password='test-pass-123';
  const app=await createConsole({stateDir,codex,username,password});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{app.close();app.server.closeAllConnections();await rm(stateDir,{recursive:true,force:true});});
  const req=(path,options={})=>fetch(base+path,options);
  const login=await req('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
  const cookie=login.headers.get('set-cookie').split(';')[0];const {csrf}=await login.json();
  const headers={Cookie:cookie,'Content-Type':'application/json','X-Codex-CSRF':csrf};return {app,codex,base,req,headers};
}
test('LAN boundary accepts local/private networks and rejects public addresses',()=>{
  for(const ip of ['127.0.0.1','::1','::ffff:10.0.0.2','192.168.1.4','172.31.1.2','100.96.91.125','fd7a::1'])assert.ok(isPrivateIP(ip),ip);
  for(const ip of ['8.8.8.8','172.32.1.2','100.128.1.1','2001:4860::1','evil.example',''])assert.equal(isPrivateIP(ip),false,ip);
  assert.equal(allowedHost('evil.example'),false);
});
test('authentication, CSRF, cross-origin and host checks protect private data',async t=>{
  const {req,headers,base}=await fixture(t);
  assert.equal((await req('/api/threads')).status,401);
  assert.equal((await req('/api/threads',{headers})).status,200);
  assert.equal((await req('/api/threads',{method:'POST',headers:{Cookie:headers.Cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await req('/api/threads',{headers:{...headers,Origin:'http://evil.example'}})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{http.get(base+'/',{headers:{Host:'evil.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});
  assert.equal(hostStatus,403);
  assert.equal((await req('/.local/credentials.json',{headers})).status,404);
});
test('listing and reading history never resumes a thread',async t=>{
  const {req,headers,codex}=await fixture(t);
  await req('/api/threads',{headers});await req(`/api/threads/${id}`,{headers});await req(`/api/threads/${id}/turns`,{headers});
  assert.deepEqual(codex.calls.map(c=>c[0]),['thread/list','thread/read','thread/turns/list']);
  assert.ok(codex.calls[0][1].sourceKinds.includes('appServer'));
  assert.ok(codex.calls[0][1].sourceKinds.includes('subAgent'));
});
test('duplicate simultaneous message submissions execute exactly once in this server lifetime',async t=>{
  const {req,headers,codex}=await fixture(t);
  const options={method:'POST',headers,body:JSON.stringify({text:'test',clientId:'bb317c64-37a9-5482-9c06-e1fa8e0032e6'})};
  const results=await Promise.all([req(`/api/threads/${id}/messages`,options),req(`/api/threads/${id}/messages`,options)]);
  assert.ok(results.every(r=>r.status===200));assert.equal(codex.sends,1);
});
test('approvals require an explicit supported decision and never grant session-wide access',()=>{
  const r={method:'item/commandExecution/requestApproval',params:{availableDecisions:['accept','decline']}};
  assert.deepEqual(approvalResult(r,{decision:'accept'}),{decision:'accept'});
  assert.throws(()=>approvalResult(r,{decision:'acceptForSession'}));
  assert.throws(()=>approvalResult(r,{}));
  assert.throws(()=>approvalResult({method:'item/permissions/requestApproval',params:{}},{decision:'accept'}));
  const q={method:'item/tool/requestUserInput',params:{questions:[{id:'choice'}]}};
  assert.throws(()=>approvalResult(q,{answers:{}}));
  assert.deepEqual(approvalResult(q,{answers:{choice:['one']}}),{answers:{choice:{answers:['one']}}});
});
test('logout invalidates the session',async t=>{
  const {req,headers}=await fixture(t);assert.equal((await req('/api/logout',{method:'POST',headers,body:'{}'})).status,200);assert.equal((await req('/api/session',{headers})).status,401);
});
test('an ambiguous failed submission is cached and never retried automatically',async t=>{
  const {req,headers,codex}=await fixture(t);
  codex.send=async()=>{codex.sends++;throw new Error('transport lost after sending');};
  const options={method:'POST',headers,body:JSON.stringify({text:'test',clientId:'bb317c64-37a9-5482-9c06-e1fa8e0032e6'})};
  const a=await req(`/api/threads/${id}/messages`,options);const b=await req(`/api/threads/${id}/messages`,options);
  assert.equal(a.status,500);assert.equal(b.status,500);assert.equal(codex.sends,1);
});
test('login requires the configured account and exact password',async t=>{
  const {req}=await fixture(t);
  const login=value=>req('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
  assert.equal((await login({username:'console-user',password:'test-pass-123'})).status,200);
  assert.equal((await login({username:' console-user ',password:'test-pass-123'})).status,200);
  assert.equal((await login({username:'other-user',password:'test-pass-123'})).status,401);
  assert.equal((await login({username:'console-user',password:'wrong-pass'})).status,401);
  assert.equal((await login({password:'test-pass-123'})).status,401);
  assert.equal((await login({username:'console-user',password:' test-pass-123 '})).status,401);
});
test('question answer submissions require login and CSRF and deduplicate concurrent clicks',async t=>{
 const {req,headers,codex}=await fixture(t);let answers=0;
 codex.answerQuestion=async()=>{answers++;await new Promise(r=>setTimeout(r,20));return {delivery:'steered',turnId:'turn',answeredQuestionIds:['q']};};
 const url=`/api/threads/${id}/answers`,body=JSON.stringify({turnId:'source',itemId:'question',answers:[{questionIndex:0,answer:'selected'}],clientId:'bb317c64-37a9-5482-9c06-e1fa8e0032e6'});
 assert.equal((await req(url,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,401);
 assert.equal((await req(url,{method:'POST',headers:{Cookie:headers.Cookie,'Content-Type':'application/json'},body})).status,403);
 const results=await Promise.all([req(url,{method:'POST',headers,body}),req(url,{method:'POST',headers,body})]);assert.ok(results.every(r=>r.status===200));assert.equal(answers,1);
});
