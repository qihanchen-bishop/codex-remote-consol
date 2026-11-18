import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import WebSocket, { WebSocketServer } from 'ws';
import { createConsole } from '../server.mjs';
import { createGateway } from '../gateway.mjs';
import { ThreadSync } from '../lib/thread-sync.mjs';

const id = '09923bf0-676e-5806-b824-1fee99d75dbf';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
class FakeCodex extends EventEmitter {
  connected = true; requests = new Map(); calls = []; status = 'idle'; text = 'initial';
  async connect() {} close() {}
  async rpc(method) {
    this.calls.push(method); await wait(4);
    if (method === 'thread/read') return { thread: { id, status: { type: this.status } } };
    if (method === 'thread/turns/list') return { data: [{ id: 'new', startedAt: 2, items: [{id:'msg',type:'agentMessage',text:this.text}] }, { id: 'old', startedAt: 1, items: [] }], nextCursor: null };
    throw Error('Unexpected mutation: ' + method);
  }
}
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
function request(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end(body);
  });
}
async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'codex-public-test-'));
  const codex = new FakeCodex();
  const app = await createConsole({ stateDir, username: 'tester', password: 'test-password', codex, publicOrigin: 'https://console.example', publicPath: '/codex', syncOptions: { activeMs: 25, idleMs: 45 } });
  const port = await listen(app.server);
  t.after(async () => { app.close(); app.server.closeAllConnections(); await rm(stateDir, { recursive: true, force: true }); });
  return { app, codex, port };
}
test('public path, HTTPS cookies and CSRF work while LAN HTTP login stays usable', async t => {
  const { port } = await fixture(t);
  const publicHeaders = { Host: 'console.example', Origin: 'https://console.example', 'Content-Type': 'application/json' };
  const body = JSON.stringify({ username: 'tester', password: 'test-password' });
  const login = await request(port, '/codex/api/login', { method: 'POST', headers: publicHeaders, body });
  assert.equal(login.status, 200);
  assert.match(login.headers['set-cookie'][0], /Path=\/codex\/;/); assert.match(login.headers['set-cookie'][0], /; Secure/);
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  assert.equal((await request(port, '/codex/api/session', { headers: { ...publicHeaders, Cookie: cookie } })).status, 200);
  assert.equal((await request(port, '/codex/api/session', { headers: { ...publicHeaders, Cookie: cookie, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request(port, '/codex/api/logout', { method: 'POST', headers: { ...publicHeaders, Cookie: cookie }, body:'{}' })).status, 403);
  assert.equal((await request(port, '/api/session', { headers: publicHeaders })).status, 404);
  const local = await request(port, '/api/login', { method: 'POST', headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' }, body });
  assert.equal(local.status, 200); assert.doesNotMatch(local.headers['set-cookie'][0], /; Secure/);
  assert.match(local.headers['set-cookie'][0], /Path=\/;/);
  const page = await request(port, '/codex/', { headers: publicHeaders });
  assert.equal(page.status, 200); assert.match(page.body.toString(), /src="\.\/app.js/);
  const asset = await request(port, '/codex/app.js?v=public-1', { headers: publicHeaders });
  assert.equal(asset.status, 200); assert.match(asset.headers['cache-control'], /max-age/);
  assert.equal((await request(port, '/codex/app.js?v=public-1', { headers: { ...publicHeaders, 'If-None-Match':asset.headers.etag } })).status, 304);
  const logout = await request(port, '/codex/api/logout', { method:'POST', headers:{...publicHeaders,Cookie:cookie,'X-Codex-CSRF':JSON.parse(login.body).csrf}, body:'{}' });
  assert.equal(logout.status, 200); assert.match(logout.headers['set-cookie'][0], /Path=\/codex\/;/);
  assert.equal((await request(port, '/codex/api/session', { headers:{...publicHeaders,Cookie:cookie} })).status, 401);
});
test('local snapshots coalesce readers, push only changed turns, and stop when nobody watches', async () => {
  const codex = new FakeCodex(), changes = [];
  const sync = new ThreadSync(codex, { onChange:(snapshot,patch) => changes.push({snapshot,patch}), activeMs: 30, idleMs: 40 });
  const unwatchA = sync.watch(id), unwatchB = sync.watch(id);
  await Promise.all([sync.read(id),sync.read(id)]); assert.equal(codex.calls.length, 2);
  await sync.read(id); assert.equal(changes.length, 1);
  codex.text = 'external client updated this'; await sync.read(id);
  assert.equal(changes.length, 2); assert.deepEqual(changes[1].patch.data.map(t => t.id), ['new']);
  assert.equal(changes[1].snapshot.data.length, 2);
  unwatchA(); unwatchB(); const calls = codex.calls.length; await wait(90);
  assert.equal(codex.calls.length, calls); assert.equal(sync.states.size, 0); sync.close();
  assert.ok(codex.calls.every(m => ['thread/read','thread/turns/list'].includes(m)));
});
test('new unmaterialized threads have empty history without hiding transport failures', async () => {
  const codex = new FakeCodex(), original = codex.rpc.bind(codex);
  codex.rpc = async method => {
    if (method === 'thread/turns/list') throw Object.assign(new Error(`thread ${id} is not materialized yet; thread/turns/list is unavailable before first user message`), {rpcCode:-32600});
    return original(method);
  };
  const sync = new ThreadSync(codex);
  const snapshot = await sync.read(id); assert.deepEqual(snapshot.data, []); assert.equal(snapshot.thread.status.type, 'idle');
  codex.rpc = async () => {throw new Error('transport disconnected');};
  await assert.rejects(sync.read(id), /transport disconnected/); sync.close();
});
test('gateway preserves mainSite requests and WebSockets and streams compressed Codex updates', async t => {
  const { port, codex } = await fixture(t);
  const mainSite = http.createServer(async (req,res) => {
    const chunks=[];for await (const c of req) chunks.push(c);
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ path:req.url,method:req.method,body:Buffer.concat(chunks).toString(),proto:req.headers['x-forwarded-proto'] }));
  });
  const wsServer = new WebSocketServer({ server:mainSite }); wsServer.on('connection',ws => ws.on('message',bytes => ws.send(bytes)));
  const mainPort=await listen(mainSite);
  const gateway=createGateway({publicOrigin:'https://console.example',mainURL:`http://127.0.0.1:${mainPort}`,codexURL:`http://127.0.0.1:${port}`});
  const gatewayPort=await listen(gateway.server);
  t.after(() => {gateway.close();wsServer.close();mainSite.close();mainSite.closeAllConnections();});
  const headers={Host:'console.example','Content-Type':'application/json'};
  const primarySite=await request(gatewayPort,'/api/mainSite?q=1',{method:'POST',headers:{...headers,'X-Forwarded-Proto':'garbage'},body:'{"test":true}'});
  assert.deepEqual(JSON.parse(primarySite.body),{path:'/api/mainSite?q=1',method:'POST',body:'{"test":true}',proto:'https'});
  assert.equal((await request(gatewayPort,'/codex?x=1',{headers})).headers.location,'/codex/?x=1');
  assert.equal((await request(gatewayPort,'/',{headers:{Host:'evil.example'}})).status,403);
  assert.equal((await request(gatewayPort,'/codex/api/session',{headers})).status,401);
  const asset=await request(gatewayPort,'/codex/app.js',{headers:{...headers,'Accept-Encoding':'gzip'}});
  assert.equal(asset.headers['content-encoding'],'gzip');assert.match(gunzipSync(asset.body).toString(),/EventSource/);
  const login=await request(gatewayPort,'/codex/api/login',{method:'POST',headers:{...headers,Origin:'https://console.example'},body:JSON.stringify({username:'tester',password:'test-password'})});
  const cookie=login.headers['set-cookie'][0].split(';')[0];
  const controller=new AbortController();
  const response=await fetch(`http://127.0.0.1:${gatewayPort}/codex/api/events?threadId=${id}`,{headers:{Host:'console.example',Cookie:cookie,'Accept-Encoding':'gzip'},signal:controller.signal});
  assert.equal(response.status,200);assert.equal(response.headers.get('content-encoding'),'gzip');
  const reader=response.body.getReader();let stream='';
  const until=async text=>{const deadline=Date.now()+3000;while(!stream.includes(text)&&Date.now()<deadline){const result=await Promise.race([reader.read(),wait(1500).then(()=>{throw Error('SSE chunk was buffered');})]);stream+=new TextDecoder().decode(result.value);}assert.ok(stream.includes(text));};
  await until('"text":"initial"'); codex.text='external-update-via-sse';await until('external-update-via-sse');
  controller.abort();await reader.cancel().catch(()=>{});
  const ws=new WebSocket(`ws://127.0.0.1:${gatewayPort}/ws`,{headers:{Host:'console.example'}});
  await once(ws,'open');const echoed=once(ws,'message');ws.send('mainSite-websocket');assert.equal((await echoed)[0].toString(),'mainSite-websocket');ws.close();await once(ws,'close');
});
