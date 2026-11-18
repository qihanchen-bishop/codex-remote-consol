import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('base64url');

// Poll the local Unix-socket API once per watched thread, regardless of how many
// browsers are watching. Reading and reconnecting never resume a Codex thread.
export class ThreadSync {
  constructor(codex, { onChange = () => {}, onError = () => {}, transformHistory = history => history, activeMs = 2000, idleMs = 15000, retryMs = 10000 } = {}) {
    Object.assign(this, { codex, onChange, onError, transformHistory, activeMs, idleMs, retryMs });
    this.states = new Map(); this.closed = false;
  }
  state(id) {
    let state = this.states.get(id);
    if (!state) {
      state = { id, watchers: 0, version: 0, timer: null, due: 0, lastRead: 0 };
      this.states.set(id, state);
    }
    return state;
  }
  watch(id) {
    const state = this.state(id); state.watchers++;
    let released = false;
    return () => {
      if (released) return; released = true; state.watchers--;
      if (!state.watchers) {
        clearTimeout(state.timer); state.timer = null;
        if (!state.inflight) this.states.delete(id);
      }
    };
  }
  schedule(state, delay) {
    if (this.closed || !state.watchers) return;
    const due = Date.now() + delay;
    if (state.timer && state.due <= due) return;
    clearTimeout(state.timer); state.due = due;
    state.timer = setTimeout(() => {
      state.timer = null;
      this.read(state.id).catch(error => this.onError(error, state.id));
    }, delay);
    state.timer.unref();
  }
  wake(id) {
    for (const state of id ? [this.states.get(id)].filter(Boolean) : this.states.values()) {
      this.schedule(state, Math.max(100, state.lastRead + this.activeMs - Date.now()));
    }
  }
  read(id) {
    const state = this.state(id);
    if (state.inflight) return state.inflight;
    clearTimeout(state.timer); state.timer = null; state.lastRead = Date.now();
    let failed = false;
    state.inflight = (async () => {
      const [meta, history] = await Promise.all([
        this.codex.rpc('thread/read', { threadId: id }),
        this.codex.rpc('thread/turns/list', { threadId: id, limit: 8, cursor: null, sortDirection: 'desc', itemsView: 'full' }).catch(error => {
          // A freshly created thread is live, but has no persisted history until
          // its first user message. Other protocol/transport errors still fail.
          if (error.rpcCode === -32600 && /is not materialized yet; thread\/turns\/list is unavailable before first user message/.test(error.message)) return { data: [], nextCursor: null };
          throw error;
        }),
      ]);
      const decorated = this.transformHistory(history);
      const payload = { thread: meta.thread, data: decorated.data, nextCursor: decorated.nextCursor, requests: [...this.codex.requests.values()].filter(r => r.params?.threadId === id) };
      const signature = hash(payload);
      if (signature !== state.signature) {
        const previous = state.snapshot;
        const previousTurns = new Map((previous?.data || []).map(turn => [turn.id, hash(turn)]));
        state.signature = signature;
        state.snapshot = { ...payload, version: ++state.version };
        const patch = { ...state.snapshot, data: payload.data.filter(turn => previousTurns.get(turn.id) !== hash(turn)), full: false };
        this.onChange(state.snapshot, patch, id);
      }
      return state.snapshot;
    })().catch(error => { failed = true; throw error; }).finally(() => {
      state.inflight = null;
      if (!state.watchers || this.closed) this.states.delete(id);
      else this.schedule(state, failed ? this.retryMs : state.snapshot?.thread.status?.type === 'active' ? this.activeMs : this.idleMs);
    });
    return state.inflight;
  }
  close() {
    this.closed = true;
    for (const state of this.states.values()) clearTimeout(state.timer);
    this.states.clear();
  }
}
