import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {auditSource} from './audit-source.mjs';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const audit=await auditSource(root,{ref:'HEAD'});if(!audit.ok)throw new Error('Source privacy audit failed; no release was created.');
const output=join(root,'dist');await mkdir(output,{recursive:true});
const name='codex-remote-console-source.zip',path=join(output,name);
execFileSync('git',['archive','--format=zip','--prefix=codex-remote-console/','-o',path,'HEAD'],{cwd:root});
const sha256=createHash('sha256').update(await readFile(path)).digest('hex');
await writeFile(join(output,'SHA256SUMS'),sha256+'  '+name+'\n');
console.log(JSON.stringify({file:'dist/'+name,sha256,sourceFiles:audit.files,commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()}));
