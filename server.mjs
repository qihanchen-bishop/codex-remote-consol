import http from 'node:http';
import { readFile, mkdir, stat } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname, userInfo } from 'node:os';
import { CodexConnection, SOURCE_KINDS } from './lib/codex.mjs';
import { allowedHost, isPrivateIP, cookieValue, sameSecret } from './lib/security.mjs';
import { makeCredentials, readCredentials, verifyCredentials } from './lib/auth.mjs';
import { ThreadSync } from './lib/thread-sync.mjs';
import { AttachmentStore, MAX_IMAGE_BYTES } from './lib/attachments.mjs';
import { MachineRegistry, proxyMachine } from './lib/machines.mjs';
import { connectorPackage } from './lib/connector-package.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cookieName = 'codex_console';
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, max = 50000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(400, '文本不能为空或超过长度限制'); return value.trim(); };

export async function createConsole(options = {}) {
  const stateDir = options.stateDir || process.env.WEB_STATE_DIR || join(root, '.local');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const credentialsPath = join(stateDir, 'credentials.json');
  const agentToken=options.agentToken || '';
  if(agentToken && (typeof agentToken!=='string'||agentToken.length<32))throw new Error('接入密钥无效');
  const machines=agentToken?null:await new MachineRegistry(stateDir).init();
  const attachments = await new AttachmentStore(join(stateDir,'attachments')).init();
  const credentials = agentToken ? {username:'connector'} : options.username && options.password
    ? await makeCredentials(options.username, options.password)
    : await readCredentials(credentialsPath);
  const extraHosts = (process.env.WEB_ALLOWED_HOSTS || '').split(',').map(x => x.trim()).filter(Boolean);
  const publicOrigin = options.publicOrigin ?? process.env.WEB_PUBLIC_ORIGIN ?? '';
  const publicURL = publicOrigin ? new URL(publicOrigin) : null;
  const publicPath = options.publicPath ?? process.env.WEB_PUBLIC_PATH ?? '';
  if (publicURL && (publicURL.origin !== publicOrigin || publicURL.protocol !== 'https:')) throw new Error('WEB_PUBLIC_ORIGIN 必须为不含路径的 HTTPS 来源');
  if (publicPath && !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(publicPath)) throw new Error('WEB_PUBLIC_PATH 应为 /codex 这样的路径，不带结尾斜杠');
  if (publicURL) extraHosts.push(publicURL.hostname);
  const socketPath = process.env.CODEX_SOCKET || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control/app-server-control.sock');
  const codex = options.codex || new CodexConnection(socketPath);
  const sessions = new Map(), attempts = new Map(), streams = new Set(), submissions = new Map();
  if(agentToken)sessions.set('agent',{account:'connector',csrf:agentToken,expires:Infinity});
  const remoteStreams=new Set();
  const sessionTTL = 12 * 60 * 60 * 1000;
  const publish = (event, data, threadId) => {
    for (const client of streams) {
      if (client.session.expires < Date.now()) { client.response.end(); continue; }
      if (!threadId || threadId === client.threadId) {
        if (client.response.writableLength > 1024 * 1024) client.response.destroy();
        else client.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    }
  };
  const sendSnapshot = (client, snapshot, patch) => {
    if (client.lastVersion === snapshot.version || client.response.destroyed) return;
    if (client.session.expires < Date.now()) { client.response.end(); return; }
    const data = client.lastVersion ? patch : { ...snapshot, full: true };
    if (client.response.writableLength > 1024 * 1024) { client.response.destroy(); return; }
    client.response.write(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`);
    client.lastVersion = snapshot.version;
  };
  const sync = new ThreadSync(codex, {
    ...options.syncOptions,
    transformHistory: history => attachments.decorate(history),
    onChange(snapshot, patch, id) { for (const client of streams) if (client.threadId === id) sendSnapshot(client, snapshot, patch); },
    onError(error, id) { publish('sync-error', { error: error.message }, id); },
  });
  const onStatus = data => { publish('connection', data); if (data.connected) sync.wake(); };
  const onRequest = data => { publish('request', data, data.params?.threadId); sync.wake(data.params?.threadId); };
  // The authoritative snapshots also see edits made by CLI/other clients. Do not
  // mix text deltas with snapshots, which can otherwise duplicate streamed text.
  const onNotification = data => sync.wake(data.params?.threadId || data.params?.thread?.id);
  codex.on('status', onStatus); codex.on('request', onRequest); codex.on('notification', onNotification);
  async function body(request) {
    if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw fail(415, '请使用 JSON 请求');
    let size = 0, chunks = [];
    for await (const chunk of request) { size += chunk.length; if (size > 256 * 1024) throw fail(413, '请求内容过大'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(400, 'JSON 格式错误'); }
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    const json = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };
    try {
      if (!isPrivateIP(request.socket.remoteAddress)) throw fail(403, '当前版本仅接受内网连接');
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (!allowedHost(url.hostname, extraHosts)) throw fail(403, '不允许的访问域名');
      const isPublic = !!publicURL && url.host === publicURL.host;
      const expectedOrigin = isPublic ? publicOrigin : `http://${request.headers.host}`;
      if (request.headers.origin && request.headers.origin !== expectedOrigin) throw fail(403, '请从本站发起操作');
      if (publicPath && url.pathname === publicPath) { response.writeHead(308, { Location: `${publicPath}/${url.search}` }); return response.end(); }
      const mount = publicPath && url.pathname.startsWith(publicPath + '/') ? publicPath : '';
      if (isPublic && publicPath && !mount) throw fail(404, '页面不存在');
      const cookiePath = mount ? mount + '/' : '/';
      if(agentToken&&!sameSecret(request.headers['x-codex-agent-token'] || '',agentToken))throw fail(401,'接入认证失败');
      const sessionToken = agentToken?'agent':cookieValue(request.headers.cookie, cookieName);
      const session = sessions.get(sessionToken);
      const authenticated = session && session.expires > Date.now();
      const path = url.pathname.slice(mount.length);
      if(agentToken && ['/api/login','/api/logout'].includes(path))throw fail(404,'接口不存在');
      if (path === '/api/login' && request.method === 'POST') {
        const ip = request.socket.remoteAddress;
        let entry = attempts.get(ip);
        if (!entry || entry.until < Date.now()) { entry = { count: 0, until: Date.now() + 10 * 60 * 1000 }; attempts.set(ip, entry); }
        if (entry.count >= 8) throw fail(429, '尝试次数过多，请 10 分钟后重试');
        const data = await body(request);
        if (!await verifyCredentials(credentials, data?.username, data?.password)) { entry.count++; throw fail(401, '账号或密码不正确'); }
        attempts.delete(ip);
        if (sessionToken) sessions.delete(sessionToken);
        if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
        const token = randomBytes(32).toString('base64url');
        const s = { account: credentials.username, csrf: randomBytes(24).toString('base64url'), expires: Date.now() + sessionTTL };
        sessions.set(token, s);
        response.setHeader('Set-Cookie', `${cookieName}=${token}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=43200${isPublic ? '; Secure' : ''}`);
        return json(200, { csrf: s.csrf });
      }
      if (path.startsWith('/api/')) {
        if (!authenticated) throw fail(401, '请先登录');
        if (request.method !== 'GET' && !sameSecret(request.headers['x-codex-csrf'] || '', session.csrf)) throw fail(403, '页面凭证已失效，请重新登录');
        if (path === '/api/session' && request.method === 'GET') return json(200, { ...(!agentToken?{csrf:session.csrf}:{}), account: session.account, hostname: hostname(), username: userInfo().username, cwd: options.defaultCwd || process.env.CODEX_DEFAULT_CWD || process.cwd(), connected: codex.connected, socketPath:codex.command?'stdio':socketPath });
        if(!agentToken && path==='/api/machines'){
          if(request.method==='GET')return json(200,{data:[{id:'local',name:'当前服务器',hostname:hostname(),os:process.platform},...machines.list()]});
          if(request.method==='POST')return json(201,await machines.add(await body(request)));
        }
        const packageMatch=path.match(/^\/api\/machines\/([a-z0-9-]+)\/package$/);
        if(!agentToken && packageMatch && request.method==='GET'){
          const machine=machines.get(packageMatch[1]),content=await connectorPackage(root,machine);
          response.setHeader('Content-Type','application/zip');response.setHeader('Content-Disposition',`attachment; filename="codex-connector-${machine.id}.zip"`);return response.end(content);
        }
        const remoteMatch=path.match(/^\/api\/nodes\/([a-z0-9-]+)\/(.+)$/);
        if(!agentToken && remoteMatch){
          const [,id,action]=remoteMatch;
          if(!/^(?:session|health|models|attachments(?:\/[^/]+)?|threads(?:\/[^/]+(?:\/(?:snapshot|turns|attach|messages|interrupt|requests|answers))?)?|requests\/respond|events)$/.test(action))throw fail(404,'接口不存在');
          const machine=machines.get(id);
          proxyMachine(request,response,machine,'/api/'+action+url.search,{onStream(res){
            const entry={response:res,session};remoteStreams.add(entry);
            const expiry=setInterval(()=>{if(!sessions.has(sessionToken)||session.expires<Date.now())res.end();},15000);expiry.unref();
            res.once('close',()=>{clearInterval(expiry);remoteStreams.delete(entry);});
          }});return;
        }
        if (path === '/api/logout' && request.method === 'POST') {
          sessions.delete(sessionToken);
          for (const client of streams) if (client.session === session) client.response.end();
          for (const client of remoteStreams) if (client.session === session) client.response.end();
          response.setHeader('Set-Cookie', `${cookieName}=; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=0${isPublic ? '; Secure' : ''}`);
          return json(200, { ok: true });
        }
        if (path === '/api/health' && request.method === 'GET') {
          await codex.connect(); return json(200, { connected: true, ...codex.info });
        }
        if (path === '/api/models' && request.method === 'GET') {
          const provider=url.searchParams.get('provider');
          if(provider && (provider.length>128 || !/^[a-zA-Z0-9_.-]+$/.test(provider)))throw fail(400,'模型服务商无效');
          return json(200,{data:await codex.listModels(provider || undefined)});
        }
        if (path === '/api/attachments' && request.method === 'POST') {
          const mime=(request.headers['content-type'] || '').split(';')[0];
          if(!['image/jpeg','image/png','image/webp'].includes(mime))throw fail(415,'请选择 JPG、PNG 或 WebP 图片');
          let name;try{name=decodeURIComponent(request.headers['x-file-name'] || '图片');}catch{throw fail(400,'文件名无效');}
          const chunks=[];let size=0;
          for await(const chunk of request){size+=chunk.length;if(size>MAX_IMAGE_BYTES)throw fail(413,'每张图片需在 8MB 以内');chunks.push(chunk);}
          return json(201,await attachments.create(Buffer.concat(chunks),name,mime));
        }
        const imageMatch=path.match(/^\/api\/attachments\/([^/]+)$/);
        if(imageMatch && ['GET','HEAD'].includes(request.method)) {
          const image=attachments.get(imageMatch[1]);
          response.setHeader('Content-Type',image.mime);
          response.setHeader('Cache-Control','private, max-age=86400, immutable');
          response.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(image.name)}`);
          response.end(request.method==='HEAD'?undefined:await readFile(join(attachments.directory,image.filename)));return;
        }
        if (path === '/api/events' && request.method === 'GET') {
          const threadId = url.searchParams.get('threadId');
          if (!uuid.test(threadId || '')) throw fail(400, '会话 ID 无效');
          response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          response.write(`event: connection\ndata: ${JSON.stringify({ connected: codex.connected })}\n\n`);
          const client = { response, threadId, session, lastVersion: 0 }; streams.add(client);
          for (const r of codex.requests.values()) if (r.params?.threadId === threadId) response.write(`event: request\ndata: ${JSON.stringify(r)}\n\n`);
          const heartbeat = setInterval(() => { if (!sessions.has(sessionToken) || session.expires < Date.now()) response.end(); else response.write(': heartbeat\n\n'); }, 15000);
          const unwatch = sync.watch(threadId);
          response.on('close', () => { clearInterval(heartbeat); streams.delete(client); unwatch(); });
          sync.read(threadId).then(snapshot => sendSnapshot(client, snapshot, { ...snapshot, full: true })).catch(error => {
            if (!response.destroyed) response.write(`event: sync-error\ndata: ${JSON.stringify({error:error.message})}\n\n`);
          });
          return;
        }
        if (path === '/api/threads' && request.method === 'GET') {
          return json(200, await codex.rpc('thread/list', { limit: 40, cursor: url.searchParams.get('cursor') || null, archived: url.searchParams.get('archived') === 'true', sortKey: 'updated_at', sortDirection: 'desc', modelProviders: [], sourceKinds: SOURCE_KINDS, ...(url.searchParams.get('q') ? { includeAttachedThreads: true, searchTerm: url.searchParams.get('q').slice(0,200) } : {}) }));
        }
        if (path === '/api/threads' && request.method === 'POST') {
          const data = await body(request);
          const cwd = resolve(text(data.cwd, 4096));
          if (!(await stat(cwd)).isDirectory()) throw fail(400, '工作目录不存在');
          // New threads start with bounded permissions; existing threads retain their own policy.
          const result = await codex.rpc('thread/start', { cwd, sandbox: 'workspace-write', approvalPolicy: 'on-request' });
          return json(201, result);
        }
        const match = path.match(/^\/api\/threads\/([^/]+)(?:\/(turns|attach|messages|interrupt|requests|answers|snapshot))?$/);
        if (match) {
          const [,threadId, action] = match;
          if (!uuid.test(threadId)) throw fail(400, '会话 ID 无效');
          if (action === 'snapshot' && request.method === 'GET') return json(200, await sync.read(threadId));
          if (!action && request.method === 'GET') return json(200, await codex.rpc('thread/read', { threadId }));
          if (action === 'turns' && request.method === 'GET') return json(200, attachments.decorate(await codex.rpc('thread/turns/list', { threadId, limit: 8, cursor: url.searchParams.get('cursor') || null, sortDirection: 'desc', itemsView: 'full' })));
          if (action === 'requests' && request.method === 'GET') return json(200, { data: [...codex.requests.values()].filter(r => r.params?.threadId === threadId) });
          if (action === 'attach' && request.method === 'POST') return json(200, await codex.exclusive(threadId, () => codex.attach(threadId)));
          if (action === 'messages' && request.method === 'POST') {
            const data = await body(request); const clientId = text(data.clientId, 100);
            if(data.text!==undefined && (typeof data.text!=='string'||data.text.length>50000))throw fail(400,'消息内容超过长度限制或格式不正确');
            const message=(data.text || '').trim();
            const images=attachments.inputs(data.images);
            if(!message&&!images.length)throw fail(400,'请输入消息或添加图片');
            const model=data.model===undefined?undefined:text(data.model,128);
            const effort=data.effort===undefined?undefined:text(data.effort,40);
            if (!uuid.test(clientId)) throw fail(400, '消息 ID 无效');
            const key = `${threadId}:${clientId}`;
            if (submissions.has(key)) return json(200, await submissions.get(key).promise);
            const promise = codex.send(threadId, message, clientId, {images,model,effort});
            // Cache failures too: an ambiguous timeout must never automatically repeat a turn.
            submissions.set(key, { promise, time: Date.now() });
            return json(200, await promise);
          }
          if (action === 'answers' && request.method === 'POST') {
            const data = await body(request);
            const clientId = text(data.clientId, 100);
            if (!uuid.test(clientId)) throw fail(400, '消息 ID 无效');
            const payload = { turnId: text(data.turnId, 100), itemId: text(data.itemId, 200), answers: data.answers, clientId };
            const key = `answer:${threadId}:${clientId}`;
            if (submissions.has(key)) return json(200, await submissions.get(key).promise);
            const promise = codex.answerQuestion(threadId, payload);
            submissions.set(key, { promise, time: Date.now() });
            return json(200, await promise);
          }
          if (action === 'interrupt' && request.method === 'POST') {
            const data = await body(request);
            return json(200, await codex.rpc('turn/interrupt', { threadId, turnId: text(data.turnId, 100) }));
          }
        }
        if (path === '/api/requests/respond' && request.method === 'POST') {
          const data = await body(request); return json(200, codex.respond(text(data.key, 100), data));
        }
        throw fail(404, '接口不存在');
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw fail(405, '不支持的请求');
      const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/markdown.mjs': ['markdown.mjs','text/javascript; charset=utf-8'], '/questions.mjs': ['questions.mjs','text/javascript; charset=utf-8'], '/vendor/marked.mjs': ['../node_modules/marked/lib/marked.esm.js','text/javascript; charset=utf-8'], '/vendor/purify.mjs': ['../node_modules/dompurify/dist/purify.es.mjs','text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
      if (!assets[path]) throw fail(404, '页面不存在');
      const [file, type] = assets[path]; response.setHeader('Content-Type', type);
      const content = await readFile(join(root, 'public', file));
      if (file !== 'index.html') {
        const etag = `W/"${createHash('sha256').update(content).digest('base64url')}"`;
        response.setHeader('ETag', etag);
        response.setHeader('Cache-Control', 'public, max-age=86400');
        if (request.headers['if-none-match'] === etag) { response.writeHead(304); return response.end(); }
      }
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch (e) {
      if (!response.headersSent) json(e.status || (e.rpcCode !== undefined ? 502 : 500), { error: e.message, ...(e.rpcCode !== undefined ? { rpcCode: e.rpcCode } : {}) });
      else response.end();
    }
  });
  server.requestTimeout = 60000; server.headersTimeout = 15000;
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k,v] of sessions) if (v.expires < now) sessions.delete(k);
    for (const [k,v] of attempts) if (v.until < now) attempts.delete(k);
    for (const [k,v] of submissions) if (v.time < now - sessionTTL) submissions.delete(k);
  }, 60000); cleanup.unref();
  const close = () => {
    clearInterval(cleanup); sync.close(); for (const c of streams) c.response.end();
    for(const c of remoteStreams)c.response.end();
    codex.off('status',onStatus); codex.off('request',onRequest); codex.off('notification',onNotification);
    codex.close(); server.close(); server.closeIdleConnections();
  };
  return { server, codex, close, credentialsPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createConsole();
  const host = process.env.WEB_HOST || '127.0.0.1', port = Number(process.env.WEB_PORT || 8787);
  app.server.listen(port, host, () => {
    console.log(`Codex LAN Console listening on http://${host}:${port}`);
    console.log('Account/password login enabled');
    app.codex.connect().catch(e => console.error(e.message));
  });
  app.server.on('error', e => { console.error(e.message); app.close(); process.exitCode = 1; });
  process.on('SIGTERM', app.close); process.on('SIGINT', app.close);
}
