import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {CodexConnection} from '../lib/codex.mjs';

test('shared-server protocol preserves permissions and never starts an already active thread',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-ws-'));const socket=join(dir,'control.sock');const server=http.createServer();const wsServer=new WebSocketServer({server});
  const calls=[],responses=[];let active=false,peer;const client=new CodexConnection(socket,{timeout:1000});
  t.after(async()=>{client.close();for(const p of wsServer.clients)p.terminate();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  wsServer.on('connection',ws=>{peer=ws;ws.on('message',b=>{const m=JSON.parse(b);if(!m.method){responses.push(m);return;}calls.push(m);if(m.id===undefined)return;let result={};if(m.method==='thread/read')result={thread:{status:{type:active?'active':'notLoaded'},canAcceptDirectInput:null}};if(m.method==='thread/resume')result={thread:{id:'example',status:{type:'idle'}}};if(m.method==='turn/start')result={turn:{id:'turn',status:'inProgress'}};ws.send(JSON.stringify({id:m.id,result}));});});
  await new Promise(resolve=>server.listen(socket,resolve));await client.connect();
  assert.deepEqual(calls.map(c=>c.method),['initialize']);
  await client.send('example','Hello','message-id');
  assert.deepEqual(calls.filter(c=>c.method==='thread/resume').at(-1).params,{threadId:'example',excludeTurns:true});
  const params=calls.find(c=>c.method==='turn/start').params;
  for(const key of ['sandbox','sandboxPolicy','approvalPolicy','approvalsReviewer','model','permissions'])assert.equal(Object.hasOwn(params,key),false,key);
  const before=calls.length;active=true;await assert.rejects(client.send('example','Hello','other-id'),/会话正在执行/);
  assert.deepEqual(calls.slice(before).map(c=>c.method),['thread/read']);
  peer.send(JSON.stringify({id:812,method:'item/commandExecution/requestApproval',params:{threadId:'example',turnId:'turn',command:'example-command',availableDecisions:['accept','decline']}}));
  await new Promise(resolve=>client.once('request',resolve));assert.equal(responses.length,0);assert.equal(client.requests.size,1);
  client.respond([...client.requests.keys()][0],{decision:'decline'});await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(responses,[{id:812,result:{decision:'decline'}}]);
});

test('a newly created thread starts before its first rollout, then later continuations resume normally', async () => {
  const client = new CodexConnection('/unused'), calls = [];
  client.connect = async () => {};
  client.raw = async (method, params) => {
    calls.push({method,params});
    if (method === 'thread/start' || method === 'thread/read') return {thread:{id:'fresh',status:{type:'idle'},canAcceptDirectInput:true}};
    if (method === 'turn/start') return {turn:{id:'first',status:'inProgress'}};
    if (method === 'thread/resume') return {thread:{id:params.threadId}};
    throw Error(method);
  };
  await client.rpc('thread/start',{cwd:'/test',sandbox:'workspace-write',approvalPolicy:'on-request'});
  await client.attach('fresh'); await client.send('fresh','first message','first-id');
  assert.equal(calls.some(c=>c.method==='thread/resume'),false);
  assert.equal(client.freshThreads.has('fresh'),false);
  const input=calls.find(c=>c.method==='turn/start').params;
  assert.deepEqual(Object.keys(input).sort(),['clientUserMessageId','input','threadId']);
  await client.send('fresh','next message','next-id');
  assert.deepEqual(calls.filter(c=>c.method==='thread/resume').map(c=>c.params),[{threadId:'fresh',excludeTurns:true}]);
});
