import { renderMarkdown } from './markdown.mjs?v=machines-2';
import { questionId, parseQuestionReplies, pendingQuestionItems } from './questions.mjs?v=machines-2';

const questionDrafts = new Map(), questionStates = new Map(), answeredQuestions = new Set();
const imageDrafts = new Map(), modelChoices = new Map(), modelCatalogs = new Map(), modelLoads = new Map();
const basePath = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const machineId=new URLSearchParams(location.search).get('machine') || 'local';
const apiPath=basePath+'/api'+(machineId==='local'?'':'/nodes/'+encodeURIComponent(machineId));
let machineList=[];
const $ = id => document.getElementById(id);
const el = (tag, cls, content) => { const n = document.createElement(tag); if (cls) n.className = cls; if (content !== undefined) n.textContent = content; return n; };
let csrf = '', session, threadId, thread, threads = [], allThreads = [], projects = [], currentProject = null, turns = [], historyCursor, archived = false;
let visibleThreadLimit = 40;
let events, sending = false, loading = false, listSequence = 0, selection = 0, revision = 0, repaint;
let requests = new Map(), draft = new Map(), openTools = new Set(), connected = false, attached = false, ambiguous = false;
let reconnectTimer, reconnectAttempt = 0, streamEpoch = 0;
const active = () => thread?.status?.type === 'active';
const title = t => (t?.name || t?.preview || '未命名会话').replace(/\s+/g, ' ').slice(0,120);
const project = t => t?.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || '工作目录';
const formatTime = n => n ? new Date(n * 1000).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }) : '';
const relative = n => { const d = Date.now()/1000 - n; return d < 60 ? '刚刚' : d < 3600 ? `${Math.floor(d/60)} 分钟` : d < 86400 ? `${Math.floor(d/3600)} 小时` : `${Math.floor(d/86400)} 天`; };
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 6500); }
async function api(path, options = {}) {
  const {local=false,...fetchOptions}=options;
  const prefix=local || ['/login','/logout'].includes(path) || path.startsWith('/machines')?basePath+'/api':apiPath;
  const response = await fetch(prefix + path, { ...fetchOptions, headers: { ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.method && options.method !== 'GET' ? {'X-Codex-CSRF':csrf} : {}), ...options.headers }, credentials:'same-origin' });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/login') showLogin();
    const e = new Error(data.error || '请求失败'); e.status = response.status; throw e;
  }
  return data;
}
const post = (path, data = {}) => api(path, {method:'POST', body:JSON.stringify(data)});
function stopEvents() { streamEpoch++; clearTimeout(reconnectTimer); events?.close(); events = null; }
function showLogin() { stopEvents(); $('workspace').hidden = true; $('login-screen').hidden = false; csrf = ''; }
function connection(value) { connected = value; $('connection-dot').classList.toggle('online', value); $('connection-text').textContent = value ? '后台已连接' : '后台未连接'; }
async function enter() {
  session = await api('/session',{local:true}); csrf = session.csrf;
  await loadMachines();
  if(machineId!=='local'){
    try{const remote=await api('/session');for(const key of ['hostname','username','cwd','connected'])session[key]=remote[key];}
    catch(e){session.hostname=machineList.find(m=>m.id===machineId)?.name || '未连接的电脑';session.username='尚未连接';session.connected=false;toast(e.message);}
  }
  $('machine-name').textContent = session.hostname; $('machine-user').textContent = `${session.username} · 本机账号`;
  $('workspace').hidden = false; $('login-screen').hidden = true; $('password').value = ''; $('password').type = 'password'; $('toggle-password').textContent = '显示'; $('toggle-password').setAttribute('aria-pressed','false'); $('toggle-password').setAttribute('aria-label','显示密码');
  connection(session.connected);
  try { await api('/health'); connection(true); } catch(e) { connection(false); toast(e.message); }
  await loadThreads();
  const id = location.hash.slice(1);
  if (/^[0-9a-f-]{36}$/i.test(id)) await selectThread(id);
}
let loggingIn = false;
$('login-form').addEventListener('submit',async e => {
  e.preventDefault(); if (loggingIn) return; loggingIn = true;
  const button = $('login-submit'); button.disabled = true; button.textContent = '正在登录…'; $('login-error').textContent = '';
  try {
    const r = await api('/login', { method:'POST', body:JSON.stringify({username:$('username').value.trim(),password:$('password').value}), signal:AbortSignal.timeout(15000) });
    csrf = r.csrf; await enter();
  } catch(e) { $('login-error').textContent = e.name === 'TimeoutError' ? '登录请求超时，请检查网络后重试' : e.message; }
  finally { loggingIn = false; button.disabled = false; button.textContent = '登录工作台 ↗'; }
});
$('toggle-password').onclick = () => { const visible = $('password').type === 'password'; $('password').type = visible ? 'text' : 'password'; $('toggle-password').textContent = visible ? '隐藏' : '显示'; $('toggle-password').setAttribute('aria-pressed',String(visible)); $('toggle-password').setAttribute('aria-label',visible ? '隐藏密码' : '显示密码'); };
$('logout').onclick = async () => { try { await post('/logout'); } finally { for(const images of imageDrafts.values())for(const image of images)if(image.preview)URL.revokeObjectURL(image.preview);imageDrafts.clear();modelChoices.clear();location.hash = ''; showLogin(); } };

async function loadMachines(){
  const r=await api('/machines');machineList=r.data;
  const options=machineList.map(m=>new Option(m.name,m.id));
  if(!machineList.some(m=>m.id===machineId))options.push(new Option('未注册的电脑',machineId));
  $('machine-select').replaceChildren(...options);$('machine-select').value=machineId;renderMachineCards();
}
function renderMachineCards(){
  const fragment=document.createDocumentFragment();
  for(const m of machineList){
    const row=el('div','machine-card'),info=el('div');info.append(el('strong','',m.name),el('small','',m.id==='local'?'本机已接入':m.os==='windows'?'Windows 原生终端':'Linux'));
    row.append(info);
    if(m.id!=='local'){
      const link=el('a','secondary','下载接入包 ↓');link.href=basePath+'/api/machines/'+encodeURIComponent(m.id)+'/package';link.download='';let downloading=false;
      link.onclick=async e=>{
        e.preventDefault();if(downloading)return;downloading=true;link.textContent='正在准备…';
        try{
          // Browser download navigations can receive ngrok's warning page even
          // after normal API calls succeed. Fetch the authenticated ZIP first.
          const response=await fetch(link.href,{credentials:'same-origin',headers:{'ngrok-skip-browser-warning':'1'}});
          if(!response.ok || !response.headers.get('content-type')?.startsWith('application/zip'))throw new Error(response.status===401?'请重新登录后下载接入包':'接入包下载失败，请稍后重试');
          const blob=await response.blob(),url=URL.createObjectURL(blob),download=el('a');download.href=url;download.download='codex-connector-'+m.id+'.zip';download.hidden=true;document.body.append(download);download.click();download.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
        }catch(e){toast(e.message);}finally{downloading=false;link.textContent='下载接入包 ↓';}
      };row.append(link);
    }
    fragment.append(row);
  }
  $('machine-cards').replaceChildren(fragment);
}
$('machine-select').onchange=()=>{
  if(sending||[...questionStates.values()].some(s=>s.busy)){$('machine-select').value=machineId;return;}
  const url=new URL(location.href);url.hash='';
  if($('machine-select').value==='local')url.searchParams.delete('machine');else url.searchParams.set('machine',$('machine-select').value);
  location.assign(url.href);
};
$('manage-machines').onclick=()=>{$('machine-error').textContent='';$('machine-dialog').showModal();};
$('machine-form').onsubmit=async e=>{
  e.preventDefault();$('machine-add').disabled=true;$('machine-error').textContent='';
  try{const m=await post('/machines',{name:$('new-machine-name').value,os:$('machine-os').value});await loadMachines();$('new-machine-name').value='';$('machine-error').textContent=`已添加“${m.name}”。请下载它的接入包，到目标电脑解压并运行。`;}
  catch(e){$('machine-error').textContent=e.message;}finally{$('machine-add').disabled=false;}
};

function groupProjects(data) {
  const groups = new Map();
  for (const t of data) {
    const cwd = t.cwd || '';
    let p = groups.get(cwd);
    if (!p) { p = {cwd, name:project(t), count:0, activeCount:0, updatedAt:0}; groups.set(cwd,p); }
    p.count++; if (t.status?.type === 'active') p.activeCount++;
    p.updatedAt = Math.max(p.updatedAt,t.updatedAt || 0);
  }
  return [...groups.values()].sort((a,b)=>b.updatedAt-a.updatedAt || a.cwd.localeCompare(b.cwd));
}
async function loadThreads(more = false) {
  if (more) { visibleThreadLimit += 40; renderList(); return; }
  const seq = ++listSequence; $('refresh-list').disabled = true;
  try {
    // Collect every page before grouping so older projects and counts are complete.
    const byId = new Map(), cursors = new Set(); let cursor = null;
    do {
      const query = new URLSearchParams({archived, ...(cursor ? {cursor} : {})});
      const r = await api('/threads?' + query);
      if (seq !== listSequence) return;
      for (const t of r.data) byId.set(t.id,t);
      cursor = r.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error('会话分页异常，请刷新列表');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    allThreads = [...byId.values()]; projects = groupProjects(allThreads);
    if (currentProject) currentProject = projects.find(p=>p.cwd===currentProject.cwd) || {...currentProject,count:0,activeCount:0};
    renderList();
  } catch(e) {
    if (seq === listSequence) { toast(e.message); if (!allThreads.length) $('thread-list').replaceChildren(el('p','list-empty','无法读取项目，请检查后台连接后刷新。')); }
  } finally { if (seq === listSequence) $('refresh-list').disabled = false; }
}
function projectMatches(p) {
  const q = $('search').value.trim().toLocaleLowerCase();
  return !q || `${p.name} ${p.cwd}`.toLocaleLowerCase().includes(q);
}
function projectButton(p, overview = false) {
  const b = el('button',overview ? 'project-card' : 'project-entry'); b.dataset.projectCwd=p.cwd; b.title=p.cwd || '未设置工作目录';
  const head=el('div','project-card-head');head.append(el('span','folder-symbol','▱'),el('strong','',p.name),el('span','project-count',String(p.count)));
  const path=el('span','project-path',p.cwd || '未设置工作目录');
  const bottom=el('div','project-card-bottom');bottom.append(el('span','',p.activeCount ? `${p.activeCount} 个执行中` : `${p.count} 个对话`),el('span','',overview ? '进入项目 ↗' : '›'));
  b.append(head,path,bottom);b.onclick=()=>selectProject(p);return b;
}
function renderList() {
  $('project-navigation').hidden=!currentProject;
  $('sidebar-project-name').textContent=currentProject?.name || '';
  $('sidebar-project-path').textContent=currentProject?.cwd || '';
  $('search').placeholder=currentProject ? '搜索此项目的对话…' : '搜索项目名称或路径…';
  $('search').setAttribute('aria-label',currentProject ? '搜索此项目的对话' : '搜索项目名称或路径');
  $('thread-list').setAttribute('aria-label',currentProject ? '项目对话列表' : '项目列表');
  const list=document.createDocumentFragment();
  if (!currentProject) {
    const visible=projects.filter(projectMatches);
    $('list-count').textContent=`${archived ? '归档项目' : '全部项目'} · ${visible.length}`;
    $('more-threads').hidden=true;
    for(const p of visible) list.append(projectButton(p));
    if(!visible.length) list.append(el('p','list-empty',$('search').value ? '没有找到匹配的项目。' : archived ? '暂无归档会话。' : '暂无项目，新建对话后会自动归类。'));
  } else {
    const q=$('search').value.trim().toLocaleLowerCase();
    const matching=allThreads.filter(t=>(t.cwd || '')===currentProject.cwd && (!q || title(t).toLocaleLowerCase().includes(q)));
    threads=matching.slice(0,visibleThreadLimit);
    $('list-count').textContent=`${archived ? '归档对话' : '项目对话'} · ${matching.length}`;
    $('more-threads').hidden=matching.length<=visibleThreadLimit;
    for(const t of threads) {
      const button=el('button','thread-entry'+(t.id===threadId ? ' selected' : ''));button.dataset.threadId=t.id;
      button.title=`${title(t)}\n${t.cwd}\n${t.id}`;button.setAttribute('aria-current',t.id===threadId ? 'true' : 'false');
      const heading=el('strong');if(t.status.type==='active')heading.append(el('span','entry-live'));heading.append(document.createTextNode(title(t)));
      const bottom=el('div','entry-bottom');bottom.append(el('span','',t.status.type==='active'?'执行中':'对话'),el('time','',relative(t.updatedAt)));
      button.append(heading,bottom);button.onclick=()=>selectThread(t.id);list.append(button);
    }
    if(!matching.length)list.append(el('p','list-empty',q ? '此项目内没有匹配的对话。' : archived ? '此项目暂无归档对话。' : '此项目还没有对话。'));
  }
  $('thread-list').replaceChildren(list);
  if (!$('welcome').hidden) renderWelcome();
}
function renderWelcome() {
  $('overview-back').hidden=!currentProject;
  $('welcome-eyebrow').textContent=currentProject ? 'PROJECT / CONVERSATIONS' : 'PROJECTS / YOUR WORKSPACES';
  $('welcome-title').textContent=currentProject ? currentProject.name : '从哪个项目开始？';
  $('welcome-description').textContent=currentProject ? currentProject.cwd || '未设置工作目录' : '先选择项目，再进入对话。你的工作，按目录井然有序。';
  $('welcome-new').textContent=currentProject ? '在此项目新建对话 ↗' : '新建对话 ↗';
  $('breadcrumb-name').textContent=currentProject ? currentProject.name : '全部项目';
  $('overview-caption').textContent=currentProject ? `${currentProject.count} 个${archived ? '归档' : ''}对话 · 最近更新优先` : `${projects.length} 个项目 · ${allThreads.length} 个${archived ? '归档' : ''}对话`;
  const fragment=document.createDocumentFragment();
  if (!currentProject) {
    for (const p of projects.filter(projectMatches)) fragment.append(projectButton(p,true));
  } else {
    for (const t of threads) {
      const b=el('button','overview-thread');b.dataset.threadId=t.id;
      const head=el('div','overview-thread-head');head.append(el('strong','',title(t)),el('span','','↗'));
      const bottom=el('div','overview-thread-bottom');bottom.append(el('span','',t.status.type==='active'?'● 执行中':'继续对话'),el('time','',formatTime(t.updatedAt)));
      b.append(head,bottom);b.onclick=()=>selectThread(t.id);fragment.append(b);
    }
    if (!$('more-threads').hidden) { const b=el('button','overview-more','加载更多对话 ↓');b.onclick=()=>loadThreads(true);fragment.append(b); }
  }
  if(!fragment.childNodes.length)fragment.append(el('p','overview-empty',$('search').value ? '没有找到匹配的结果。' : archived ? '暂无归档对话。' : '新建一个对话，开始你的工作。'));
  $('project-overview').classList.toggle('conversation-overview',!!currentProject);
  $('project-overview').replaceChildren(fragment);
}
function selectProject(p) {
  if (threadId) draft.set(threadId,$('message-input').value);
  selection++;stopEvents();threadId=null;thread=null;turns=[];requests.clear();attached=false;
  currentProject=p;visibleThreadLimit=40;$('search').value='';
  history.replaceState(null,'',location.pathname+location.search);
  $('conversation').hidden=true;$('welcome').hidden=false;menu(false);renderList();$('welcome').scrollTop=0;
}
$('back-projects').onclick=()=>selectProject(null);
$('overview-back').onclick=()=>selectProject(null);
$('search').oninput=()=>{visibleThreadLimit=40;renderList();};
$('refresh-list').onclick=()=>loadThreads();
$('more-threads').onclick=()=>loadThreads(true);
$('archive-toggle').onclick=()=>{archived=!archived;visibleThreadLimit=40;$('archive-toggle').setAttribute('aria-pressed',String(archived));loadThreads();};
function menu(open) { $('sidebar').classList.toggle('open',open); $('sidebar-backdrop').hidden = !open; }
$('menu-button').onclick = () => menu(true); $('sidebar-backdrop').onclick = () => menu(false);

async function selectThread(id) {
  if (threadId) draft.set(threadId, $('message-input').value);
  const current = ++selection; threadId = id; thread = null; turns = []; requests.clear(); attached = false; ambiguous = false;
  stopEvents(); reconnectAttempt = 0; openTools.clear(); location.hash = id; menu(false);
  $('welcome').hidden = true; $('conversation').hidden = false; $('messages').replaceChildren(); $('requests').replaceChildren(); $('requests').dataset.signature = '';
  $('older-turns').hidden = true; $('history-loading').hidden = false;$('question-summary').hidden=true;
  $('thread-title').textContent = '正在读取会话…'; $('thread-project').textContent = ''; $('thread-status').textContent = '读取中'; $('thread-model').textContent = '';
  $('message-input').value = draft.get(id) || ''; $('activity').textContent = ''; $('send-button').disabled = true; $('attach-button').disabled = true;
  renderAttachments(); renderModelPicker();
  renderList(); loading = true;
  try {
    const snapshot = await api(`/threads/${id}/snapshot`);
    if (current !== selection) return;
    thread = snapshot.thread; turns = snapshot.data.reverse(); historyCursor = snapshot.nextCursor;
    requests = new Map(snapshot.requests.map(r => [r.key, r]));
    if (!currentProject || currentProject.cwd !== (thread.cwd || '')) { currentProject=projects.find(p=>p.cwd===(thread.cwd || '')) || {cwd:thread.cwd || '',name:project(thread),count:1};$('search').value=''; }
    const position=allThreads.filter(t=>(t.cwd || '')===currentProject.cwd).findIndex(t=>t.id===id);
    visibleThreadLimit=Math.max(visibleThreadLimit,Math.ceil((position+1)/40)*40);renderList();
    updateHeader(); renderMessages(true); renderRequests(); loadModels(); $('older-turns').hidden = !historyCursor;
  } catch(e) { if (current === selection) { toast(e.message); $('thread-title').textContent = '无法读取会话'; $('messages').replaceChildren(el('p','history-empty',e.message)); } }
  finally { if (current === selection) { loading = false; $('history-loading').hidden = true; controls(); if (thread && csrf) openEvents(id, current); } }
}
function openEvents(id, current) {
  if (document.hidden || !csrf || current !== selection || !navigator.onLine) return;
  stopEvents(); const epoch = streamEpoch;
  const stream = events = new EventSource(`${apiPath}/events?threadId=${encodeURIComponent(id)}`);
  const valid = () => current === selection && epoch === streamEpoch;
  stream.addEventListener('connection', e => { if (valid()) { const value = JSON.parse(e.data).connected; connection(value); if (!value) { attached = false; controls(); } } });
  stream.addEventListener('snapshot', e => { if (valid()) { reconnectAttempt = 0; revision++; applySnapshot(JSON.parse(e.data)); connection(true); } });
  stream.addEventListener('notification', e => { if (valid()) onEvent(JSON.parse(e.data)); });
  stream.addEventListener('request', e => { if (!valid()) return; const r = JSON.parse(e.data); requests.set(r.key,r); renderRequests(); controls(); });
  stream.addEventListener('sync-error', e => { if (valid()) { connection(false); $('activity').textContent = JSON.parse(e.data).error; } });
  stream.onerror = async () => {
    if (!valid()) return;
    stopEvents(); const failedEpoch = streamEpoch;
    connection(false); attached = false; controls();
    $('activity').textContent = '连接中断，正在重新连接；未自动重发消息。';
    const delay = Math.min(60000, 5000 * 2 ** reconnectAttempt++);
    // Detect session expiry once per failed connection, rather than reconnecting
    // an unauthorized EventSource forever at the browser's default retry rate.
    try { await api('/session'); } catch {}
    if (failedEpoch !== streamEpoch || current !== selection || !csrf || document.hidden || !navigator.onLine) return;
    reconnectTimer = setTimeout(() => openEvents(id, current), delay);
  };
}
function applySnapshot(snapshot) {
  const wasActive = active(), oldName = thread?.name;
  thread = snapshot.thread;
  const byId = new Map(turns.map(t => [t.id, t]));
  for (const turn of snapshot.data) byId.set(turn.id, turn);
  turns = [...byId.values()].sort((a,b) => (a.startedAt || 0) - (b.startedAt || 0));
  if (snapshot.full) { historyCursor = snapshot.nextCursor; $('older-turns').hidden = !historyCursor; }
  requests = new Map(snapshot.requests.map(r => [r.key, r]));
  updateHeader(); if (snapshot.data.length) renderMessages(); renderRequests();
  const entry = allThreads.find(t => t.id === threadId);
  if (entry) Object.assign(entry, thread);
  if ((wasActive && !active()) || oldName !== thread.name) loadThreads();
}
function updateHeader() {
  if (!thread) return;
  $('thread-title').textContent = title(thread); $('breadcrumb-name').textContent = project(thread); $('thread-project').textContent = thread.cwd;
  $('thread-model').textContent = [thread.model || thread.modelProvider,thread.reasoningEffort].filter(Boolean).join(' · ');
  renderModelPicker();
  const flags = thread.status?.activeFlags || [];
  const label = flags.includes('waitingOnApproval') ? '等待审批' : flags.includes('waitingOnUserInput') ? '等待你的回答' : active() ? '执行中' : thread.status?.type === 'notLoaded' ? '历史会话' : thread.status?.type === 'systemError' ? '会话异常' : '就绪';
  $('thread-status').textContent = label; $('thread-status').className = 'state-tag' + (active() ? ' active' : '') + (flags.length ? ' waiting' : '');
  controls();
}
function controls() {
  $('machine-select').disabled=sending;
  const images=draftImages();
  $('send-button').disabled = !thread || sending || active() || images.some(i=>i.processing) || !activeInputAllowed() || !($('message-input').value.trim() || images.length);
  $('image-button').disabled = !thread || sending;
  $('image-input').disabled = !thread || sending;
  $('model-select').disabled = !thread || sending || active() || !modelCatalogs.get(thread.modelProvider || '')?.length;
  $('effort-select').disabled = $('model-select').disabled;
  $('attach-button').disabled = !thread || sending || attached;
  $('attach-button').textContent = attached ? '实时已接入 ✓' : '接入实时会话 ↗';
  $('stop-button').hidden = !active();
  if (!sending && thread) {
    const flags = thread.status?.activeFlags || [];
    $('activity').classList.remove('error');
    $('activity').textContent = ambiguous ? '上次提交结果未确认。请先检查消息历史，确认后再决定是否重发。' : requests.size ? '等待你处理下方请求。' : flags.length ? '等待审批或回答；如网页未显示请求，请接入会话或在原客户端处理。' : active() ? 'Codex 正在执行，你可以查看进展或停止本轮。' : thread.canAcceptDirectInput === false ? '此会话由其他任务管理，暂不接受直接输入。' : '';
  }
}
const activeInputAllowed = () => thread?.canAcceptDirectInput !== false;
$('message-input').oninput = () => { $('message-input').style.height = 'auto'; $('message-input').style.height = Math.min($('message-input').scrollHeight,180) + 'px'; controls(); };
async function loadModels() {
  if(!thread)return;
  const provider=thread.modelProvider || '';
  if(modelCatalogs.has(provider)||modelLoads.has(provider)){renderModelPicker();return;}
  const request=api('/models'+(provider?'?provider='+encodeURIComponent(provider):''));modelLoads.set(provider,request);
  try{const r=await request;modelCatalogs.set(provider,r.data);}
  catch(e){modelCatalogs.set(provider,[]);toast('模型列表暂不可用，当前会话仍可继续：'+e.message);}
  finally{modelLoads.delete(provider);if((thread?.modelProvider || '')===provider){renderModelPicker();controls();}}
}
function renderModelPicker() {
  const models=modelCatalogs.get(thread?.modelProvider || '') || [],choice=modelChoices.get(threadId) || {};
  const signature=JSON.stringify([threadId,thread?.model,thread?.reasoningEffort,models.map(m=>m.model),choice]);
  if($('model-select').dataset.signature!==signature){
    $('model-select').dataset.signature=signature;
    const current=models.find(m=>m.model===thread?.model),options=[new Option(current?.displayName || thread?.model || '默认模型','')];
    for(const model of models){if(model.model===thread?.model)continue;const option=new Option(model.displayName || model.model,model.model);option.title=model.description || '';options.push(option);}
    $('model-select').replaceChildren(...options);$('model-select').value=choice.model || '';
    const target=models.find(m=>m.model===(choice.model || thread?.model)) || (!thread?.model?models.find(m=>m.isDefault):null);
    const defaultEffort=(choice.model?target?.defaultReasoningEffort:thread?.reasoningEffort) || target?.defaultReasoningEffort || '';
    const efforts=(target?.supportedReasoningEfforts || []).map(e=>{const option=new Option(e.reasoningEffort,e.reasoningEffort);option.title=e.description || '';return option;});
    if(!efforts.some(option=>option.value===defaultEffort))efforts.unshift(new Option(defaultEffort || '默认强度',defaultEffort));
    $('effort-select').replaceChildren(...efforts);$('effort-select').value=choice.effort || defaultEffort;
  }
  $('model-note').textContent=choice.model||choice.effort?'待应用 · 下一条消息生效':'沿用会话设置';
  $('model-select').title='模型：'+($('model-select').selectedOptions[0]?.textContent || '会话默认')+'；从下一条消息生效';
  $('effort-select').title='推理强度：'+($('effort-select').selectedOptions[0]?.textContent || '会话默认')+'；从下一条消息生效';
  $('model-select').disabled=!thread || sending || active() || !models.length;
  $('effort-select').disabled=$('model-select').disabled;
}
$('model-select').onchange=()=>{modelChoices.set(threadId,{model:$('model-select').value || undefined});renderModelPicker();controls();};
$('effort-select').onchange=()=>{modelChoices.set(threadId,{...modelChoices.get(threadId),effort:$('effort-select').value || undefined});renderModelPicker();controls();};
function draftImages(id=threadId){return imageDrafts.get(id) || [];}
function openImage(src,name){$('image-dialog-preview').src=src;$('image-dialog-name').textContent=name || '图片';$('image-dialog').showModal();}
function renderAttachments(){
  const fragment=document.createDocumentFragment(),images=draftImages();
  for(const image of images){
    const card=el('div','image-draft');
    if(image.preview){const preview=el('button','image-preview-button');preview.type='button';const img=el('img');img.src=image.preview;img.alt=image.name;preview.append(img);preview.onclick=()=>openImage(image.preview,image.name);card.append(preview);}
    else card.append(el('span','image-preparing','处理中…'));
    const info=el('span','image-draft-info',image.name);info.title=image.name;
    const status=el('small','',image.processing?'正在处理':image.uploaded?'已上传':image.blob?Math.ceil(image.blob.size/1024)+' KB':'');
    const remove=el('button','image-remove','×');remove.type='button';remove.title='移除图片';remove.setAttribute('aria-label','移除图片 '+image.name);remove.disabled=sending;
    remove.onclick=()=>{if(sending)return;const list=draftImages();const index=list.indexOf(image);if(index>=0)list.splice(index,1);if(image.preview)URL.revokeObjectURL(image.preview);renderAttachments();controls();};
    card.append(info,status,remove);fragment.append(card);
  }
  $('image-drafts').replaceChildren(fragment);$('image-drafts').hidden=!images.length;
}
async function prepareImage(file){
  if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('请选择 JPG、PNG 或 WebP 图片');
  if(file.size>20*1024*1024)throw new Error('原始图片需在 20MB 以内');
  const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
  try{
    const ratio=Math.min(1,2048/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*ratio));canvas.height=Math.max(1,Math.round(bitmap.height*ratio));
    canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
    const mime=file.type==='image/png'?'image/png':'image/jpeg';
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,mime,0.86));
    if(!blob || blob.size>8*1024*1024)throw new Error('处理后的图片仍超过 8MB，请缩小后重试');
    return blob;
  }finally{bitmap.close();}
}
async function addImages(files){
  if(!threadId || sending)return;
  const id=threadId,list=draftImages(id);imageDrafts.set(id,list);
  for(const file of files){
    if(list.length>=4){toast('每条消息最多添加 4 张图片');break;}
    const image={name:file.name || '截图.png',processing:true};list.push(image);if(id===threadId){renderAttachments();controls();}
    try{const blob=await prepareImage(file);if(!list.includes(image)||imageDrafts.get(id)!==list)continue;image.blob=blob;image.preview=URL.createObjectURL(blob);}
    catch(e){const index=list.indexOf(image);if(index>=0)list.splice(index,1);toast(e.message);}
    finally{image.processing=false;if(id===threadId){renderAttachments();controls();}}
  }
}
$('image-button').onclick=()=>$('image-input').click();
$('image-input').onchange=()=>{const files=[...$('image-input').files];$('image-input').value='';addImages(files);};
$('message-input').addEventListener('paste',e=>{const files=[...(e.clipboardData?.items || [])].filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);if(files.length){e.preventDefault();addImages(files);}});
$('composer-form').addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();$('composer-form').classList.add('dragging');}});
$('composer-form').addEventListener('dragleave',e=>{if(!$('composer-form').contains(e.relatedTarget))$('composer-form').classList.remove('dragging');});
$('composer-form').addEventListener('drop',e=>{e.preventDefault();$('composer-form').classList.remove('dragging');addImages([...e.dataTransfer.files]);});
function ensureTurn(id) { let t = turns.find(t => t.id === id); if (!t) { t = {id,items:[],status:'inProgress'}; turns.push(t); } return t; }
function onEvent(event) {
  const {method,params:p = {}} = event; revision++;
  if (method === 'thread/status/changed') { if (thread) { thread.status = p.status; updateHeader(); } return; }
  if (method === 'serverRequest/resolved') { for (const [k,r] of requests) if (r.id === p.requestId) requests.delete(k); renderRequests(); controls(); return; }
  if (method === 'turn/started') { const t = ensureTurn(p.turn.id); Object.assign(t,p.turn); if (thread) thread.status = {type:'active',activeFlags:[]}; updateHeader(); }
  else if (method === 'turn/completed') { const t = ensureTurn(p.turn.id); const items = t.items; Object.assign(t,p.turn); if (!t.items?.length) t.items = items; requests.clear(); renderRequests(); if (thread) thread.status = {type:'idle'}; updateHeader(); refreshThread(); loadThreads(); }
  else if (method === 'item/started' || method === 'item/completed') { const t = ensureTurn(p.turnId); const old = t.items.find(i => i.id === p.item.id); if (old) Object.assign(old,p.item); else t.items.push(p.item); }
  else if (method === 'item/agentMessage/delta') { const t = ensureTurn(p.turnId); let item = t.items.find(i => i.id === p.itemId); if (!item) { item = {id:p.itemId,type:'agentMessage',text:''}; t.items.push(item); } item.text += p.delta; }
  else if (method === 'item/commandExecution/outputDelta') { const item = ensureTurn(p.turnId).items.find(i=>i.id === p.itemId); if (item) item.aggregatedOutput = (item.aggregatedOutput || '') + p.delta; }
  else if (method === 'error') { toast(p.error?.message || 'Codex 报告执行错误'); refreshThread(); }
  else if (method === 'thread/name/updated') { if (thread) { thread.name = p.threadName; updateHeader(); } loadThreads(); }
  cancelAnimationFrame(repaint); repaint = requestAnimationFrame(() => renderMessages());
}
let refreshing = false;
async function refreshThread() {
  if (!threadId || refreshing || loading || !csrf) return;
  refreshing = true; const current = selection, rev = revision, id = threadId;
  try {
    const snapshot = await api(`/threads/${id}/snapshot`);
    if (current !== selection || rev !== revision) return;
    applySnapshot(snapshot);
  } catch(e) { if (current === selection) connection(false); }
  finally { refreshing = false; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopEvents();
  else if (csrf && threadId) { reconnectAttempt = 0; openEvents(threadId, selection); }
});
window.addEventListener('offline', () => { stopEvents(); connection(false); });
window.addEventListener('online', () => { if (csrf && threadId) { reconnectAttempt = 0; openEvents(threadId, selection); } });
window.addEventListener('pagehide', stopEvents);
window.addEventListener('pageshow', e => { if (e.persisted && csrf && threadId) openEvents(threadId, selection); });
$('older-turns').onclick = async () => {
  if (!threadId || !historyCursor) return; const current = selection, oldHeight = $('history').scrollHeight; $('older-turns').disabled = true;
  try { const r = await api(`/threads/${threadId}/turns?cursor=${encodeURIComponent(historyCursor)}`); if (current !== selection) return; const ids = new Set(turns.map(t=>t.id)); turns = [...r.data.reverse().filter(t=>!ids.has(t.id)),...turns]; historyCursor = r.nextCursor; $('older-turns').hidden = !historyCursor; renderMessages(false); $('history').scrollTop += $('history').scrollHeight-oldHeight; }
  catch(e) { toast(e.message); } finally { $('older-turns').disabled = false; }
};

function richText(text) { return renderMarkdown(text, copyText); }
async function copyText(value) {
  try { if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value); else { const t=el('textarea'); t.value=value; document.body.append(t); t.select(); const ok=document.execCommand('copy'); t.remove(); if (!ok) throw Error(); } toast('已复制'); } catch { toast('当前浏览器不允许复制，请手动选择文本'); }
}
$('copy-id').onclick = () => copyText(threadId);
function toolText(i) {
  if (i.type === 'commandExecution') return [i.command,i.aggregatedOutput, i.exitCode != null ? `退出码：${i.exitCode}` : ''].filter(Boolean).join('\n\n');
  if (i.type === 'reasoning') return (i.summary || []).join('\n');
  if (i.type === 'fileChange') return i.changes?.map(c=>`${c.path}\n${c.diff || ''}`).join('\n\n') || JSON.stringify(i,null,2);
  if (i.type === 'mcpToolCall') return JSON.stringify({arguments:i.arguments,result:i.result,error:i.error},null,2);
  return JSON.stringify(i,null,2);
}
const labels = { commandExecution:'终端执行', fileChange:'文件修改', mcpToolCall:'工具调用', dynamicToolCall:'工具调用', reasoning:'思考摘要', plan:'执行计划', webSearch:'网页搜索', collabAgentToolCall:'协作任务', contextCompaction:'上下文整理', imageView:'查看图片', imageGeneration:'图片生成', functionCallOutput:'工具结果', subAgentActivity:'任务进展', sleep:'等待' };
function renderMessages(forceBottom = false) {
  const focus = document.activeElement?.dataset?.questionField;
  const caret = focus ? [document.activeElement.selectionStart,document.activeElement.selectionEnd] : null;
  for(const t of turns)for(const i of t.items || [])for(const r of parseQuestionReplies(i))answeredQuestions.add(`${threadId}:${r.questionItemId}`);
  const pending=pendingQuestionItems(turns);
  const history = $('history'); const bottom = forceBottom || history.scrollHeight-history.scrollTop-history.clientHeight < 100;
  const scroll = history.scrollTop; const f = document.createDocumentFragment();
  for (const turn of turns) {
    for (const item of turn.items || []) {
      if (item.type === 'userMessage' || item.type === 'agentMessage') {
        const images=item.type==='userMessage'?(item.content || []).filter(c=>c.type==='localImage'||c.type==='image'):[];
        let content = item.type === 'agentMessage' ? item.text : (item.content || []).filter(c=>c.type!=='localImage'&&c.type!=='image').map(c => c.type === 'text' ? c.text : `[${c.type}]`).join('\n');
        const questionReplies=parseQuestionReplies(item);
        if(questionReplies.length)content=questionReplies.map(r=>`${r.question}\n回答：${r.answer}`).join('\n\n');
        if (!content && !item.questions?.length && !images.length) continue;
        const user = item.type === 'userMessage', message = el('article','message '+(user?'user':'agent'));
        const head = el('div','message-head'); head.append(el('span','avatar',user?'你':'c↗'),el('strong','',user?'你':'Codex'),el('time','',formatTime(turn.startedAt)));
        const body = el('div','message-body');
        if(content || item.questions?.length)body.append(item.type==='agentMessage' && item.questions?.length
          ? pending.has(item.id) && item.questions.some((q,index)=>!questionAnswered(item.id,index)) ? asyncQuestionForm(item,turn) : questionHistory(item)
          : richText(content));
        if(images.length){
          const gallery=el('div','message-images');
          for(const image of images){
            const uploaded=image.webAttachment;
            const src=uploaded?.id?`${apiPath}/attachments/${encodeURIComponent(uploaded.id)}`:image.type==='image'&&/^data:image\/(png|jpeg|webp);base64,/i.test(image.url || '')?image.url:null;
            if(!src){gallery.append(el('span','image-unavailable','[来自其他客户端的图片，暂不支持预览]'));continue;}
            const button=el('button','message-image');button.type='button';button.title='查看大图';
            const img=el('img');img.src=src;img.alt=uploaded?.name || '图片附件';img.loading='lazy';img.decoding='async';
            if(uploaded){img.width=uploaded.width;img.height=uploaded.height;}
            button.append(img);button.onclick=()=>openImage(src,img.alt);gallery.append(button);
          }
          body.append(gallery);
        }
        message.append(head,body); f.append(message);
      } else if (item.type !== 'hookPrompt') {
        if (item.type === 'reasoning' && !item.summary?.length) continue;
        const tool = el('details','tool'); tool.open = openTools.has(item.id);
        tool.addEventListener('toggle',()=>{ if (tool.isConnected) tool.open ? openTools.add(item.id) : openTools.delete(item.id); });
        const summary=el('summary'); const desc=item.type === 'commandExecution' ? item.command?.split('\n')[0] : item.type === 'mcpToolCall' ? `${item.server} / ${item.tool}` : item.type === 'webSearch' ? item.query : '';
        summary.append(el('span','',`${labels[item.type] || item.type}${desc ? ' · '+desc.slice(0,160) : ''}`),el('small','',item.status === 'inProgress' ? '进行中' : item.exitCode ? `退出 ${item.exitCode}` : ''));
        tool.append(summary,el('pre','',toolText(item))); f.append(tool);
      }
    }
    if (turn.error) f.append(el('div','turn-error',turn.error.message || JSON.stringify(turn.error)));
    else if (turn.status === 'interrupted') f.append(el('div','turn-error','本轮已停止。'));
  }
  if (!turns.length) f.append(el('div','history-empty','这个会话还没有消息。\n从下面发送第一条指令。'));
  $('messages').replaceChildren(f);
  if(focus){const target=[...$('messages').querySelectorAll('[data-question-field]')].find(n=>n.dataset.questionField===focus);if(target){target.focus({preventScroll:true});if(caret)try{target.setSelectionRange(...caret);}catch{}}}
  history.scrollTop = bottom ? history.scrollHeight : scroll;
  updateQuestionSummary(pending);
}
function questionAnswered(itemId,index,id=threadId) {
  return answeredQuestions.has(`${id}:${questionId(itemId,index)}`) || answeredQuestions.has(`${id}:${itemId}`);
}
function questionHistory(item) {
  const details=el('details','question-history');
  details.append(el('summary','',item.questions.every((q,index)=>questionAnswered(item.id,index))?'历史询问 · 已回答':'历史询问 · 已结束'));
  if(item.text)details.append(richText(item.text));
  for(const question of item.questions){
    details.append(el('p','',question.title || question.question));
    if(question.options?.length){const list=el('ul');for(const option of question.options)list.append(el('li','',typeof option==='string'?option:option.label));details.append(list);}
  }
  return details;
}
function newMessageId() {
  return crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16));
}
function questionFields(form, questions, prefix, resolved = () => false) {
  return questions.map((q,index)=>{
    const key=JSON.stringify([prefix,index]);
    let value=questionDrafts.get(key);if(!value){value={selected:-1,text:''};questionDrafts.set(key,value);}
    const field=el('fieldset','question-field');field.append(el('legend','',`${questions.length>1 ? `${index+1}. ` : ''}${q.question || q.title}`));
    if(resolved(index)){field.append(el('p','question-answered','✓ 已回答'));form.append(field);return {q,index,key,value,resolved:true};}
    for(const [n,raw]of (q.options || []).entries()){
      const option=typeof raw==='string'?{label:raw}:raw;
      const label=el('label','question-choice'),radio=el('input');radio.type='radio';radio.name=key;radio.value=String(n);radio.checked=value.selected===n;radio.dataset.questionField=key+':'+n;
      radio.onchange=()=>{value.selected=n;};
      const text=el('span');text.append(el('strong','',option.label));if(option.description)text.append(el('small','',option.description));
      label.append(radio,text);field.append(label);
    }
    const custom=el(q.isSecret?'input':'textarea','question-custom');if(q.isSecret)custom.type='password';else custom.rows=2;
    custom.autocomplete='off';custom.maxLength=10000;custom.placeholder=q.options?.length?'补充说明，或填写其他回答':'填写你的回答';custom.setAttribute('aria-label',`${q.question || q.title}：自定义回答`);custom.value=value.text;custom.dataset.questionField=key+':text';custom.oninput=()=>{value.text=custom.value;};field.append(custom);
    form.append(field);return {q,index,key,value,resolved:false};
  });
}
function selectedAnswer(field, structured = false) {
  const raw=field.q.options?.[field.value.selected];
  const label=typeof raw==='string'?raw:raw?.label;
  const note=field.value.text.trim();
  if(structured)return [...(label?[label]:[]),...(note?[label?'user_note: '+note:note]:[])];
  return [label,note && (label?'补充：'+note:note)].filter(Boolean).join('\n');
}
function asyncQuestionForm(item,turn) {
  const id=threadId,key=JSON.stringify([id,item.id]);
  let state=questionStates.get(key);if(!state){state={busy:false,error:''};questionStates.set(key,state);}
  const form=el('form','question-form async-question-form');form.dataset.questionItem=item.id;
  const fields=questionFields(form,item.questions,key,index=>questionAnswered(item.id,index,id));
  const outstanding=fields.filter(f=>!f.resolved);
  if(!outstanding.length)return form;
  const error=el('p','question-error',state.error),row=el('div','question-actions'),button=el('button','primary',state.busy?'正在提交…':'提交回答');button.type='submit';row.append(button);form.append(error,row);
  if(state.busy)for(const node of form.querySelectorAll('input,textarea,button'))node.disabled=true;
  form.onsubmit=async e=>{
    e.preventDefault();if(state.busy)return;
    if(!pendingQuestionItems(turns).has(item.id)){renderMessages();toast('此询问已结束');return;}
    const answers=outstanding.map(f=>({questionIndex:f.index,answer:selectedAnswer(f)})).filter(a=>a.answer);
    if(!answers.length){state.error='请至少选择或填写一个回答';error.textContent=state.error;return;}
    state.busy=true;state.error='';error.textContent='';button.textContent='正在提交…';for(const node of form.querySelectorAll('input,textarea,button'))node.disabled=true;
    const current=selection;
    try{
      const result=await post(`/threads/${id}/answers`,{turnId:turn.id,itemId:item.id,answers,clientId:newMessageId()});
      for(const qid of result.answeredQuestionIds)answeredQuestions.add(`${id}:${qid}`);
      for(const a of answers)questionDrafts.delete(JSON.stringify([key,a.questionIndex]));
      state.busy=false;if(current===selection){if(result.delivery==='started')attached=true;renderMessages();toast('Codex 已接收你的回答');await refreshThread();}
    }catch(e){state.busy=false;state.error=e.message+'；未自动重发';if(current===selection){renderMessages();toast(e.message);}}
  };
  return form;
}
function updateQuestionSummary(pending=pendingQuestionItems(turns)) {
  let count=0;
  for(const t of turns)for(const i of t.items || [])if(pending.has(i.id))for(let n=0;n<(i.questions?.length || 0);n++)if(!questionAnswered(i.id,n))count++;
  $('question-summary').hidden=!count;$('question-summary-text').textContent=`${count} 个可回答的问题`;
}
$('show-questions').onclick=()=>{
  const target=[...$('messages').querySelectorAll('.async-question-form')].find(f=>f.querySelector('button[type=submit]'));
  target?.scrollIntoView({behavior:'smooth',block:'center'});
};
function renderRequests() {
  const fragment = document.createDocumentFragment();
  for (const r of requests.values()) {
    const card=el('section','request-card'), p=r.params || {};
    const approvals=['item/commandExecution/requestApproval','item/fileChange/requestApproval'];
    card.append(el('h3','',r.method === 'item/tool/requestUserInput' ? '需要你的回答' : approvals.includes(r.method) ? '需要你审批此操作' : '需要在原客户端处理'));
    if (p.reason) card.append(el('p','',p.reason));
    if (p.command) card.append(el('pre','',`${p.cwd || ''}\n${p.command}`));
    else if (r.method !== 'item/tool/requestUserInput') card.append(el('pre','',JSON.stringify(p,null,2)));
    if (approvals.includes(r.method)) {
      if (p.additionalPermissions) card.append(el('pre','',JSON.stringify(p.additionalPermissions,null,2)));
      const row=el('div','request-actions');
      for (const [value,label,cls] of [['cancel','取消本轮','secondary'],['decline','拒绝','secondary'],['accept','仅本次允许','primary']]) {
        if (p.availableDecisions?.length && !p.availableDecisions.includes(value)) continue;
        const b=el('button',cls,label); b.onclick=async()=>{ b.disabled=true; try {await post('/requests/respond',{key:r.key,decision:value});requests.delete(r.key);renderRequests();}catch(e){toast(e.message);b.disabled=false;} };row.append(b);
      }card.append(row);
    } else if (r.method === 'item/tool/requestUserInput') {
      const form=el('form','question-form');
      const fields=questionFields(form,p.questions,'request:'+r.key);
      const error=el('p','question-error'),row=el('div','request-actions'),b=el('button','primary','提交回答');b.type='submit';row.append(b);form.append(error,row);
      form.onsubmit=async e=>{
        e.preventDefault();if(b.disabled)return;const answers=Object.create(null);
        for(const f of fields){const values=selectedAnswer(f,true);if(!values.length){error.textContent='请回答所有问题后再提交';return;}answers[f.q.id]=values;}
        b.disabled=true;b.textContent='正在提交…';error.textContent='';
        try{await post('/requests/respond',{key:r.key,answers});requests.delete(r.key);renderRequests();controls();}
        catch(e){error.textContent=e.message;toast(e.message);b.disabled=false;b.textContent='提交回答';}
      };card.append(form);
    } else card.append(el('p','','网页未授予权限。请在原客户端处理此请求，或停止本轮。'));
    fragment.append(card);
  }
  // Do not destroy an answer currently being typed on a periodic history refresh.
  const signature=JSON.stringify([...requests.keys()]); if ($('requests').dataset.signature !== signature) { $('requests').dataset.signature=signature; $('requests').replaceChildren(fragment); }
}
$('attach-button').onclick = async () => {
  const id=threadId,current=selection; $('attach-button').disabled=true;
  try {const r=await post(`/threads/${id}/attach`);if(current!==selection)return;attached=true;thread=r.thread;updateHeader();await refreshThread();toast('已接入所选会话');}
  catch(e){toast(e.message);}finally{if(current===selection)controls();}
};
$('composer-form').onsubmit = async e => {
  e.preventDefault(); const value=$('message-input').value.trim(),images=[...draftImages()]; if((!value&&!images.length) || sending || images.some(i=>i.processing) || active() || !thread)return;
  const id=threadId,current=selection; sending=true;controls();$('activity').textContent='正在提交给 Codex…';
  const clientId=newMessageId();
  try {
    for(const image of images){
      if(!image.uploaded)image.uploaded=await api('/attachments',{method:'POST',headers:{'Content-Type':image.blob.type,'X-File-Name':encodeURIComponent(image.name)},body:image.blob});
      if(current===selection){$('activity').textContent=`图片已准备 ${images.filter(i=>i.uploaded).length}/${images.length}，正在发送…`;renderAttachments();}
    }
    const choice=modelChoices.get(id) || {};
    const r=await post(`/threads/${id}/messages`,{text:value,clientId,images:images.map(i=>i.uploaded.id),...(choice.model?{model:choice.model}:{}),...(choice.effort?{effort:choice.effort}:{})});
    for(const image of images)if(image.preview)URL.revokeObjectURL(image.preview);
    imageDrafts.delete(id);draft.delete(id);modelChoices.delete(id);
    if(current!==selection)return;
    attached=true;ambiguous=false;$('message-input').value='';renderAttachments();
    if(choice.model)thread.model=choice.model;if(choice.effort)thread.reasoningEffort=choice.effort;
    const t=ensureTurn(r.turn.id);Object.assign(t,r.turn);thread.status={type:'active',activeFlags:[]};
    $('activity').textContent='Codex 已接收，等待回复…';renderMessages(true);updateHeader();await refreshThread();loadThreads();
  } catch(e) { if(current===selection){ambiguous=e.status!==409 && e.status!==400;$('activity').textContent=e.message;$('activity').classList.add('error');toast(e.message);} }
  finally {sending=false;renderAttachments();controls();}
};
$('message-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&window.matchMedia('(min-width:721px)').matches){e.preventDefault();if(!$('send-button').disabled)$('composer-form').requestSubmit();}};
$('stop-button').onclick=async()=>{const current=selection,id=threadId;const t=[...turns].reverse().find(t=>t.status==='inProgress');if(!t){toast('正在更新执行状态，请稍后再试');await refreshThread();return;}$('stop-button').disabled=true;try{await post(`/threads/${id}/interrupt`,{turnId:t.id});toast('已发送停止请求');if(current===selection)await refreshThread();}catch(e){toast(e.message);}finally{$('stop-button').disabled=false;}};
function newDialog(){ $('new-cwd').value=currentProject?.cwd || thread?.cwd || session?.cwd || ''; $('new-error').textContent='';$('new-dialog').showModal(); }
$('new-thread').onclick=newDialog; $('welcome-new').onclick=newDialog;
$('help-button').onclick=()=> $('help-dialog').showModal();
for(const b of document.querySelectorAll('[data-close]'))b.onclick=()=>$(b.dataset.close).close();
$('new-form').onsubmit=async e=>{e.preventDefault();$('create-button').disabled=true;$('new-error').textContent='';try{const r=await post('/threads',{cwd:$('new-cwd').value});$('new-dialog').close();archived=false;$('archive-toggle').setAttribute('aria-pressed','false');await loadThreads();await selectThread(r.thread.id);}catch(e){$('new-error').textContent=e.message;}finally{$('create-button').disabled=false;}};
document.addEventListener('keydown',e=>{if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)||document.querySelector('dialog[open]')||!csrf||e.metaKey||e.ctrlKey||e.altKey)return;if(e.key==='/'){e.preventDefault();menu(true);$('search').focus();}if(e.key==='n'){e.preventDefault();newDialog();}});
window.addEventListener('hashchange',()=>{const id=location.hash.slice(1);if(id&&id!==threadId&&csrf)selectThread(id);});
try {await enter();} catch(e) {if(e.status!==401)toast(e.message);showLogin();}
