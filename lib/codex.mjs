import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { StdioSocket } from './stdio-socket.mjs';
import { buildQuestionReply, parseQuestionReplies, pendingQuestionItems } from './questions.mjs';

export const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
const APPROVALS = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);

export function approvalResult(request, body) {
  if (APPROVALS.has(request.method)) {
    if (!['accept', 'decline', 'cancel'].includes(body.decision)) throw new Error('请选择仅本次允许、拒绝或取消');
    const available = request.params.availableDecisions;
    if (available?.length && !available.includes(body.decision)) throw new Error('该请求不支持此决定');
    return { decision: body.decision };
  }
  if (request.method === 'item/tool/requestUserInput') {
    const answers = {};
    for (const q of request.params.questions) {
      const value = body.answers?.[q.id];
      if (!Array.isArray(value) || !value.length || value.some(x => typeof x !== 'string' || !x.trim() || x.length > 10000)) throw new Error('请回答所有问题');
      answers[q.id] = { answers: value };
    }
    return { answers };
  }
  // Permission profile grants and arbitrary tool execution require dedicated interfaces.
  // Never silently acknowledge a server request or accept a session-wide permission grant.
  throw new Error('此类请求请在原 Codex 客户端处理；网页不会自动授权');
}

export class CodexConnection extends EventEmitter {
  constructor(socketPath, { timeout = 30000, command, cwd, env } = {}) {
    super(); this.socketPath = socketPath; this.timeout = timeout;
    this.command=command;this.cwd=cwd;this.env=env;
    this.pending = new Map(); this.requests = new Map(); this.sequence = 0;
    this.freshThreads = new Map();
    this.modelCatalogs = new Map();
    this.connected = false; this.generation = 0; this.inflight = new Set(); this.closed = false;
  }
  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async open() {
    const generation = ++this.generation;
    const ws = this.command ? new StdioSocket(this.command,{cwd:this.cwd,env:this.env}) : new WebSocket(`ws+unix://${this.socketPath}:/`, { handshakeTimeout: 8000, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
    this.ws = ws;
    ws.on('message', bytes => {
      if (generation !== this.generation) return;
      let message; try { message = JSON.parse(bytes.toString()); } catch { return; }
      if (message.method) {
        if (message.id !== undefined) {
          const key = `${generation}:${String(message.id)}`;
          const request = { ...message, key };
          this.requests.set(key, request);
          this.emit('request', request);
        } else {
          if (message.method === 'serverRequest/resolved') this.requests.delete(`${generation}:${String(message.params.requestId)}`);
          if (message.method === 'turn/completed') {
            for (const [key, r] of this.requests) if (r.params?.threadId === message.params.threadId && r.params?.turnId === message.params.turn.id) this.requests.delete(key);
          }
          this.emit('notification', message);
        }
      } else if (this.pending.has(message.id)) {
        const request = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.error) request.reject(Object.assign(new Error(message.error.message), { rpcCode: message.error.code }));
        else request.resolve(message.result);
      }
    });
    ws.on('close', () => {
      if (generation !== this.generation) return;
      this.connected = false; this.requests.clear(); this.freshThreads.clear();
      for (const r of this.pending.values()) { clearTimeout(r.timer); r.reject(new Error('Codex 连接已断开；发送结果可能未确认，请查看历史后再决定是否重发')); }
      this.pending.clear(); this.emit('status', { connected: false });
    });
    ws.on('error', () => {});
    try {
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      this.info = await this.raw('initialize', { clientInfo: { name: 'codex_lan_console', title: 'Codex LAN Console', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      ws.send(JSON.stringify({ method: 'initialized' }));
      this.connected = true; this.emit('status', { connected: true });
    } catch (e) { ws.terminate(); throw new Error(`无法连接 Codex 共享后台：${e.message}`); }
  }
  raw(method, params) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('Codex 连接不可用'));
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 请求超时；未自动重试。发送操作请先核对历史，避免重复执行')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }), error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); } });
    });
  }
  async rpc(method, params = {}) {
    await this.connect(); const generation = this.generation;
    const result = await this.raw(method, params);
    if (method === 'thread/start' && result.thread?.id && generation === this.generation) this.freshThreads.set(result.thread.id, generation);
    if (method === 'turn/start') this.freshThreads.delete(params.threadId);
    return result;
  }
  async exclusive(threadId, callback) {
    if (this.inflight.has(threadId)) throw Object.assign(new Error('此会话正在提交请求，请稍后查看状态'), { status: 409 });
    this.inflight.add(threadId);
    try { return await callback(); } finally { this.inflight.delete(threadId); }
  }
  async attach(threadId) {
    // Only called after an explicit user action; never on reads, reconnect or startup.
    // This connection already owns a thread it just created. Before its first
    // message there is no rollout to resume; keep its original permissions.
    if (this.freshThreads.get(threadId) === this.generation) return this.rpc('thread/read', { threadId });
    return this.rpc('thread/resume', { threadId, excludeTurns: true });
  }
  async listModels(modelProvider) {
    const key = modelProvider || '';
    const cached = this.modelCatalogs.get(key);
    if (cached?.until > Date.now()) return cached.promise;
    const promise = (async () => {
      const models=[],cursors=new Set();let cursor=null;
      do {
        const page=await this.rpc('model/list',{includeHidden:false,limit:100,cursor,...(modelProvider?{modelProvider}:{})});
        models.push(...page.data.filter(m=>!m.hidden));cursor=page.nextCursor;
        if(cursor&&cursors.has(cursor))throw new Error('模型列表分页异常');
        if(cursor)cursors.add(cursor);
      }while(cursor);
      return models.map(({id,model,displayName,description,isDefault,supportedReasoningEfforts,defaultReasoningEffort,inputModalities})=>({id,model,displayName,description,isDefault,supportedReasoningEfforts,defaultReasoningEffort,inputModalities}));
    })();
    this.modelCatalogs.set(key,{until:Date.now()+300000,promise});
    try{return await promise;}catch(error){this.modelCatalogs.delete(key);throw error;}
  }
  async turnOptions(thread, { model, effort, images = [] }) {
    const result={};
    if(model===undefined&&effort===undefined&&!images.length)return result;
    const models=await this.listModels(thread.modelProvider);
    const target=models.find(m=>m.model===(model || thread.model)) || (!model&&!thread.model ? models.find(m=>m.isDefault) : null);
    if(model!==undefined){
      if(typeof model!=='string'||!target)throw Object.assign(new Error('请选择当前账号可用的模型'),{status:400});
      result.model=target.model;
    }
    if(effort!==undefined){
      if(typeof effort!=='string'||!target?.supportedReasoningEfforts?.some(e=>e.reasoningEffort===effort))throw Object.assign(new Error('该模型不支持所选推理强度'),{status:400});
      result.effort=effort;
    }else if(model!==undefined&&target.defaultReasoningEffort)result.effort=target.defaultReasoningEffort;
    if(images.length&&target?.inputModalities&&!target.inputModalities.includes('image'))throw Object.assign(new Error('当前模型不支持图片，请先选择支持图片的模型'),{status:400});
    return result;
  }
  async send(threadId, text, clientId, options = {}) {
    return this.exclusive(threadId, async () => {
      const { thread } = await this.rpc('thread/read', { threadId });
      if (thread.status.type === 'active') throw Object.assign(new Error('会话正在执行。请等待完成，或点击停止后再发送。'), { status: 409 });
      if (thread.canAcceptDirectInput === false) throw Object.assign(new Error('此会话由其他任务管理，当前不接受直接输入'), { status: 409 });
      const overrides = await this.turnOptions(thread, options);
      const input=[...(text?[{type:'text',text,text_elements:[]}]:[]),...(options.images || [])];
      if(!input.length)throw Object.assign(new Error('请输入消息或添加图片'),{status:400});
      await this.attach(threadId);
      return this.rpc('turn/start', { threadId, input, clientUserMessageId: clientId, ...overrides });
    });
  }
  async answerQuestion(threadId, { turnId, itemId, answers, clientId }) {
    return this.exclusive(threadId, async () => {
      // Resolve the authoritative question and answers from saved history, including
      // answers submitted by another client. Reading never resumes a thread.
      const answered = new Set(), cursors = new Set(); let cursor = null, source;
      do {
        const page = await this.rpc('thread/items/list', { threadId, limit: 100, sortDirection: 'desc', cursor });
        for (const entry of page.data) {
          for (const reply of parseQuestionReplies(entry.item)) answered.add(reply.questionItemId);
          if (entry.turnId === turnId && entry.item.id === itemId) { source = entry.item; break; }
        }
        if (source) break;
        cursor = page.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('历史分页异常，请刷新后重试');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (!source) throw Object.assign(new Error('找不到原始问题，请刷新会话'), {status: 404});
      const { text, replies } = buildQuestionReply(source, answers, answered);
      // A stale browser must not revive an optional question after the task has
      // finished or a newer user instruction has moved the conversation on.
      const history=[];let historyCursor=null;const historyCursors=new Set();
      do {
        const page=await this.rpc('thread/turns/list',{threadId,limit:8,cursor:historyCursor,sortDirection:'desc',itemsView:'full'});
        history.push(...page.data);historyCursor=page.nextCursor;
        if(page.data.some(t=>t.id===turnId))break;
        if(historyCursor&&historyCursors.has(historyCursor))throw new Error('历史分页异常，请刷新后重试');
        if(historyCursor)historyCursors.add(historyCursor);
      }while(historyCursor);
      if(!pendingQuestionItems(history.reverse()).has(itemId))throw Object.assign(new Error('此询问已结束，请查看最新对话'),{status:409});
      const { thread } = await this.rpc('thread/read', { threadId });
      if (thread.canAcceptDirectInput === false) throw Object.assign(new Error('此会话由其他任务管理，当前不接受直接输入'), {status: 409});
      const input = [{ type: 'text', text, text_elements: [] }];
      if (thread.status.type === 'active') {
        const recent = await this.rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
        const running = recent.data.find(t => t.status === 'inProgress');
        if (!running) throw Object.assign(new Error('执行状态已变化，请刷新后重新提交回答'), {status: 409});
        const result = await this.rpc('turn/steer', { threadId, expectedTurnId: running.id, input, clientUserMessageId: clientId });
        return { delivery: 'steered', ...result, answeredQuestionIds: replies.map(r => r.questionItemId) };
      }
      await this.attach(threadId);
      const result = await this.rpc('turn/start', { threadId, input, clientUserMessageId: clientId });
      return { delivery: 'started', ...result, answeredQuestionIds: replies.map(r => r.questionItemId) };
    });
  }
  respond(key, body) {
    const request = this.requests.get(key);
    if (!request) throw Object.assign(new Error('请求已被处理或已过期，请刷新会话'), { status: 409 });
    const result = approvalResult(request, body);
    if (!this.connected) throw new Error('Codex 连接已断开');
    this.ws.send(JSON.stringify({ id: request.id, result }));
    this.requests.delete(key);
    this.emit('notification', { method: 'serverRequest/resolved', params: { threadId: request.params.threadId, requestId: request.id } });
    return { ok: true };
  }
  close() { this.closed = true; this.ws?.close(); }
}
