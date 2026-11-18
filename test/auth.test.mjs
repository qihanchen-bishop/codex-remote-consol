import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeCredentials,writeCredentials,readCredentials,verifyCredentials} from '../lib/auth.mjs';

test('passwords are salted hashes and persist across application restarts',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'console-auth-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'credentials.json');
 const password='example-10-character-password';await writeCredentials(path,'test-account',password);
 const raw=await readFile(path,'utf8');assert.equal(raw.includes(password),false);assert.equal((await stat(path)).mode&0o777,0o600);
 const saved=await readCredentials(path);assert.equal(await verifyCredentials(saved,'test-account',password),true);
 assert.equal(await verifyCredentials(saved,'wrong-account',password),false);assert.equal(await verifyCredentials(saved,'test-account','wrong-password'),false);
 const other=await makeCredentials('test-account',password);assert.notEqual(other.hash,saved.hash);assert.notEqual(other.salt,saved.salt);
});
test('ten-character passwords are supported without weakening account verification',async()=>{
 const c=await makeCredentials('test-account','abcdefgh12');assert.equal(await verifyCredentials(c,'test-account','abcdefgh12'),true);
 await assert.rejects(makeCredentials('test-account','short'));assert.equal(await verifyCredentials(c,'','abcdefgh12'),false);
});
