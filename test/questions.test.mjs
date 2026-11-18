import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {CodexConnection} from '../lib/codex.mjs';
import {buildQuestionReply,parseQuestionReplies,questionId,pendingQuestionItems} from '../lib/questions.mjs';
const item={id:'source-question',type:'agentMessage',questions:[{title:'Choose a region',options:['Japan','Singapore']},{title:'Other details?',options:null}]};
function fakeConnection(active=false){
 const c=new CodexConnection('/unused');let calls=[],sent=false;
 c.rpc=async(method,params)=>{
  calls.push({method,params});
  if(method==='thread/items/list')return {data:[...(sent?[{turnId:'new',item:{type:'userMessage',content:[{type:'text',text:buildQuestionReply(item,[{questionIndex:0,answer:'Japan'}]).text}]}}]:[]),{turnId:'source-turn',item}],nextCursor:null};
  if(method==='thread/read')return {thread:{status:{type:active?'active':'idle'},canAcceptDirectInput:true}};
  if(method==='thread/turns/list')return {data:params.itemsView==='full'?[{id:'source-turn',status:active?'inProgress':'completed',items:[item]}]:[{id:'running-turn',status:'inProgress'}],nextCursor:null};
  if(method==='thread/resume')return {thread:{id:'thread'}};
  if(method==='turn/start'){sent=true;return {turn:{id:'new-turn',status:'inProgress'}};}
  if(method==='turn/steer'){sent=true;return {turnId:'running-turn'};}
  throw Error('unexpected method '+method);
 };return {c,calls};
}
test('async answer envelopes use native question IDs and authoritative titles',()=>{
 const r=buildQuestionReply(item,[{questionIndex:0,answer:'Japan'}]);
 assert.equal(r.replies[0].questionItemId,'["request_user_input_async","source-question",0]');
 assert.equal(r.replies[0].question,'Choose a region');
 const user={type:'userMessage',content:[{type:'text',text:r.text}]};assert.deepEqual(parseQuestionReplies(user),r.replies);
 assert.throws(()=>buildQuestionReply(item,[{questionIndex:9,answer:'Japan'}]));
 assert.throws(()=>buildQuestionReply(item,[{questionIndex:0,answer:''}]));
 assert.throws(()=>buildQuestionReply(item,[null]));
 assert.throws(()=>buildQuestionReply(item,[{questionIndex:0,answer:'Japan'}],new Set([questionId(item.id,0)])),/已经回答/);
});
test('answering an idle conversation resumes only that conversation and starts a normal user turn',async()=>{
 const {c,calls}=fakeConnection();const r=await c.answerQuestion('thread',{turnId:'source-turn',itemId:item.id,answers:[{questionIndex:0,answer:'Japan'}],clientId:'client'});
 assert.equal(r.delivery,'started');assert.deepEqual(calls.map(c=>c.method),['thread/items/list','thread/turns/list','thread/read','thread/resume','turn/start']);
 const p=calls.at(-1).params;assert.equal(p.threadId,'thread');assert.equal(p.clientUserMessageId,'client');assert.equal(Object.hasOwn(p,'model'),false);assert.equal(Object.hasOwn(p,'approvalPolicy'),false);
 await assert.rejects(c.answerQuestion('thread',{turnId:'source-turn',itemId:item.id,answers:[{questionIndex:0,answer:'Japan'}],clientId:'other'}),/已经回答/);
 assert.equal(calls.filter(c=>c.method==='turn/start').length,1);
});
test('answering during execution steers the exact active turn without resuming or starting another',async()=>{
 const {c,calls}=fakeConnection(true);const r=await c.answerQuestion('thread',{turnId:'source-turn',itemId:item.id,answers:[{questionIndex:1,answer:'Details'}],clientId:'client'});
 assert.equal(r.delivery,'steered');assert.deepEqual(calls.map(c=>c.method),['thread/items/list','thread/turns/list','thread/read','thread/turns/list','turn/steer']);
 assert.equal(calls.at(-1).params.expectedTurnId,'running-turn');
});
test('a changed execution state never falls back to starting a new turn',async()=>{
 const {c,calls}=fakeConnection(true);const original=c.rpc;c.rpc=async(m,p)=>m==='thread/turns/list'&&p.itemsView==='notLoaded'?{data:[]}:original(m,p);
 await assert.rejects(c.answerQuestion('thread',{turnId:'source-turn',itemId:item.id,answers:[{questionIndex:0,answer:'Japan'}],clientId:'client'}),/状态已变化/);
 assert.equal(calls.some(c=>c.method==='turn/start'||c.method==='turn/steer'),false);
});

test('only current questions stay open; final results, new instructions and stopped turns close old prompts',()=>{
 const question={...item,phase:'final_answer'},result={id:'result',type:'agentMessage',text:'Done',phase:'final_answer'};
 const turn=items=>({id:'t',status:'completed',items});
 assert.deepEqual([...pendingQuestionItems([turn([question])])],[question.id]);
 assert.equal(pendingQuestionItems([turn([question,{type:'commandExecution'},result])]).size,0);
 assert.equal(pendingQuestionItems([turn([question,{...result,phase:null}])]).size,0);
 const later={id:'later',status:'inProgress',items:[{type:'userMessage',content:[{type:'text',text:'Start a different task'}]}]};
 assert.equal(pendingQuestionItems([turn([question]),later]).size,0);
 for(const status of ['interrupted','failed'])assert.equal(pendingQuestionItems([{...turn([question]),status}]).size,0);
 const next={...question,id:'new-question'};
 assert.deepEqual([...pendingQuestionItems([turn([question,result]),{id:'next',status:'completed',items:[next]}])],[next.id]);
});

test('optional questions remain answerable during tool execution and partial native replies',()=>{
 const q={...item,phase:'final_answer'};
 const work={id:'t',status:'inProgress',items:[q,{type:'commandExecution'},{id:'progress',type:'agentMessage',phase:'commentary',text:'Working'}]};
 assert.equal(pendingQuestionItems([work]).has(item.id),true);
 const reply={type:'userMessage',content:[{type:'text',text:buildQuestionReply(item,[{questionIndex:0,answer:'Japan'}]).text}]};
 assert.equal(pendingQuestionItems([work,{id:'partial',status:'inProgress',items:[reply]}]).has(item.id),true);
 assert.equal(pendingQuestionItems([work,{id:'image',status:'inProgress',items:[{type:'userMessage',content:[{type:'localImage',path:'/test.png'}]}]}]).size,0);
});

test('an expired question in an old browser cannot resume or steer a finished task, including across history pages',async()=>{
 for(const stopped of [false,true]){
  const {c,calls}=fakeConnection();const original=c.rpc;
  c.rpc=async(method,params)=>{
   if(method==='thread/turns/list'){
    calls.push({method,params});
    if(!params.cursor)return {data:[{id:'newer',status:stopped?'interrupted':'completed',items:stopped?[]:[{id:'done',type:'agentMessage',phase:'final_answer',text:'Finished'}]}],nextCursor:'older'};
    return {data:[{id:'source-turn',status:'completed',items:[item]}],nextCursor:null};
   }
   return original(method,params);
  };
  await assert.rejects(c.answerQuestion('thread',{turnId:'source-turn',itemId:item.id,answers:[{questionIndex:0,answer:'Japan'}],clientId:'client'}),/询问已结束/);
  assert.equal(calls.some(c=>['thread/resume','turn/start','turn/steer'].includes(c.method)),false);
 }
});
