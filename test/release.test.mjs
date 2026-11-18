import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {configuredCommand,validateCommand} from '../lib/settings.mjs';
import {auditSource} from '../scripts/audit-source.mjs';

test('custom Codex launchers preserve arguments and require explicit configuration',()=>{
 assert.equal(configuredCommand({},{}),null);
 assert.deepEqual(configuredCommand({codexCommand:['custom','run','codex']},{CODEX_BIN:'ignored'}),['custom','run','codex']);
 assert.deepEqual(configuredCommand({},{CODEX_COMMAND_JSON:'["custom launcher","--flag","codex"]'}),['custom launcher','--flag','codex']);
 assert.deepEqual(configuredCommand({},{CODEX_PROXY_BIN:'/path/to/launcher',CODEX_BIN:'/path/to/codex'}),['/path/to/launcher','run','/path/to/codex']);
 assert.throws(()=>validateCommand('codex'));assert.throws(()=>validateCommand([]));assert.throws(()=>validateCommand(['codex\nother']));
});

test('source auditing rejects staged runtime data and audits the exact committed tree used for releases',async t=>{
 const dir=await mkdtemp('/tmp/console-source-audit-');t.after(()=>rm(dir,{recursive:true,force:true}));const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
 await writeFile(join(dir,'README.md'),'Synthetic project\n');git('add','README.md');git('commit','-qm','Synthetic clean tree');
 assert.equal((await auditSource(dir,{ref:'HEAD'})).ok,true);
 await writeFile(join(dir,'connector.json'),JSON.stringify({token:'fixture-only-not-a-real-key'}));git('add','connector.json');
 const index=await auditSource(dir);assert.equal(index.ok,false);assert.ok(index.issues.some(i=>i.file==='connector.json'));
 // Release export inspects HEAD, not a different index or working tree.
 assert.equal((await auditSource(dir,{ref:'HEAD'})).ok,true);
 git('commit','-qm','Synthetic unsafe fixture');assert.equal((await auditSource(dir,{ref:'HEAD'})).ok,false);
});

test('startup loads a private state directory and uses an explicitly configured mock command without resuming tasks',async t=>{
 const dir=await mkdtemp('/tmp/console-startup-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const script=join(dir,'mock.mjs'),record=join(dir,'methods.txt');
 await writeFile(script,`import {appendFileSync} from 'node:fs';import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);if(q.method){appendFileSync(process.env.FIXTURE_METHODS,q.method+'\\n');}if(q.id!==undefined)console.log(JSON.stringify({id:q.id,result:q.method==='initialize'?{}:{data:[],nextCursor:null}}));}`);
 const root=process.cwd();const {spawn}=await import('node:child_process');
 const {makeCredentials}=await import('../lib/auth.mjs');const state=join(dir,'state');await mkdir(state);await writeFile(join(state,'credentials.json'),JSON.stringify(await makeCredentials('test','fixture-password')));
 const child=spawn(process.execPath,['scripts/start-hub.mjs'],{cwd:root,env:{...process.env,WEB_HOST:'127.0.0.1',WEB_PORT:'18899',WEB_STATE_DIR:state,CODEX_TRANSPORT:'stdio',CODEX_COMMAND_JSON:JSON.stringify([process.execPath,script]),FIXTURE_METHODS:record},stdio:['ignore','pipe','pipe']});
 t.after(()=>child.kill());let output='',errors='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
 const deadline=Date.now()+5000;while(!output.includes('Codex Remote Console:')&&Date.now()<deadline&&child.exitCode===null)await new Promise(r=>setTimeout(r,20));
 assert.match(output,/Codex Remote Console:/,errors);await new Promise(r=>setTimeout(r,100));
 const methods=(await readFile(record,'utf8')).trim().split('\n');assert.ok(methods.includes('initialize'));assert.equal(methods.some(m=>['thread/resume','turn/start'].includes(m)),false);
 child.kill();await new Promise(r=>child.once('exit',r));
});
