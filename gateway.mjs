import http from 'node:http';
import { createGzip, constants } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings } from './lib/settings.mjs';

const hopHeaders = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
function cleanHeaders(headers) {
  const result = { ...headers };
  for (const name of [...hopHeaders, ...(headers.connection || '').split(',').map(s => s.trim().toLowerCase())]) delete result[name];
  return result;
}

export function createGateway({ publicOrigin, mainURL = 'http://127.0.0.1:3000', codexURL = 'http://127.0.0.1:8787', codexPath = '/codex' } = {}) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== publicOrigin) throw new Error('GATEWAY_PUBLIC_ORIGIN must be an HTTPS origin without a path');
  if (!/^\/[a-zA-Z0-9_-]+$/.test(codexPath)) throw new Error('Invalid Codex path');
  const targets = [mainURL, codexURL].map(value => {
    const target = new URL(value);
    if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Gateway upstreams must be local HTTP services');
    return target;
  });
  const targetFor = url => {
    const path = url.split('?')[0];
    return targets[path === codexPath || path.startsWith(codexPath + '/') ? 1 : 0];
  };
  function headersFor(request) {
    const host = new URL(`http://${request.headers.host}`).host;
    if (host !== origin.host && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(`http://${host}`).hostname)) throw new Error('Unexpected gateway host');
    const headers = cleanHeaders(request.headers);
    // Do not accept client-supplied forwarding metadata as proof of TLS or IP.
    delete headers.forwarded; delete headers['x-forwarded-for']; delete headers['x-forwarded-host'];
    delete headers['x-forwarded-port']; delete headers['x-real-ip'];
    headers['x-forwarded-proto'] = host === origin.host ? 'https' : 'http';
    headers['x-forwarded-host'] = request.headers.host;
    return headers;
  }
  const server = http.createServer((request, response) => {
    let headers;
    try { headers = headersFor(request); }
    catch { response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }); return response.end('不允许的访问域名'); }
    const rawPath = request.url.split('?')[0];
    if (rawPath === codexPath) {
      response.writeHead(308, { Location: codexPath + '/' + request.url.slice(rawPath.length), 'Cache-Control': 'no-store' });
      return response.end();
    }
    const target = targetFor(request.url);
    const upstream = http.request({ hostname: target.hostname, port: target.port, method: request.method, path: request.url, headers }, incoming => {
      const outgoing = cleanHeaders(incoming.headers);
      const compress = request.method !== 'HEAD' && ![204, 304].includes(incoming.statusCode) && /\bgzip\b/.test(request.headers['accept-encoding'] || '') && !outgoing['content-encoding'] && /^(?:text\/|application\/(?:json|javascript)|image\/svg)/i.test(outgoing['content-type'] || '');
      outgoing.vary = [...new Set([...(outgoing.vary || '').split(',').map(s => s.trim()).filter(Boolean), 'Accept-Encoding'])].join(', ');
      if (compress) { outgoing['content-encoding'] = 'gzip'; delete outgoing['content-length']; delete outgoing['content-md5']; }
      response.writeHead(incoming.statusCode, outgoing);
      if (incoming.headers['content-type']?.startsWith('text/event-stream')) response.flushHeaders();
      if (compress) {
        // Flush each SSE chunk immediately; compression must not buffer messages.
        const gzip = createGzip({ flush: constants.Z_SYNC_FLUSH });
        gzip.on('error', () => response.destroy()); incoming.on('error', () => gzip.destroy());
        response.on('close', () => gzip.destroy()); incoming.pipe(gzip).pipe(response);
      } else incoming.pipe(response);
      incoming.on('error', () => response.destroy());
    });
    upstream.on('error', () => {
      if (response.headersSent) response.destroy();
      else { response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); response.end('服务暂时不可用，请稍后重试'); }
    });
    response.on('close', () => { if (!upstream.destroyed) upstream.destroy(); });
    request.on('aborted', () => upstream.destroy());
    request.pipe(upstream);
  });
  const upgraded = new Set();
  server.on('upgrade', (request, socket, head) => {
    let headers;
    try { headers = headersFor(request); }
    catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    headers.connection = 'Upgrade'; headers.upgrade = request.headers.upgrade;
    const target = targetFor(request.url);
    const upstream = http.request({ hostname: target.hostname, port: target.port, method: request.method, path: request.url, headers });
    upstream.on('upgrade', (incoming, remote, remoteHead) => {
      upgraded.add(remote); upgraded.add(socket);
      const responseHeaders = Object.entries(incoming.headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(v => `${name}: ${v}`));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${responseHeaders.join('\r\n')}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.pipe(socket).pipe(remote);
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
      remote.on('close', () => { upgraded.delete(remote); socket.destroy(); });
      socket.on('close', () => { upgraded.delete(socket); remote.destroy(); });
    });
    upstream.on('response', incoming => { socket.end(`HTTP/1.1 ${incoming.statusCode} ${incoming.statusMessage}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); incoming.resume(); });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    upstream.end();
  });
  server.headersTimeout = 15000; server.requestTimeout = 60000;
  const close = () => { for (const socket of upgraded) socket.destroy(); server.close(); server.closeAllConnections(); };
  return { server, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadSettings(dirname(fileURLToPath(import.meta.url)));
  const app = createGateway({ publicOrigin: process.env.GATEWAY_PUBLIC_ORIGIN, mainURL: process.env.GATEWAY_MAIN_URL, codexURL: process.env.GATEWAY_CODEX_URL });
  const port = Number(process.env.GATEWAY_PORT || 8790);
  app.server.listen(port, '127.0.0.1', () => console.log(`Public website gateway listening on 127.0.0.1:${port}`));
  app.server.on('error', error => { console.error(error.message); app.close(); process.exitCode = 1; });
  process.on('SIGTERM', app.close); process.on('SIGINT', app.close);
}
