import {execFileSync,spawnSync} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import {join,relative,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const forbidden=/(?:^|\/)(?:\.local|\.connector-state|\.codex|node_modules|\.git|artifacts|test-results|playwright-report)(?:\/|$)|(?:^|\/)(?:connector|machines|credentials|auth)\.json$|(?:^|\/)(?:access-token|id_rsa|id_ed25519)$|\.(?:sqlite(?:3)?(?:-\w+)?|db(?:-\w+)?|jsonl|pem|key|zip|tgz|log)$/i;
const secrets=[/-----BEGIN(?: [A-Z]+)* PRIVATE KEY-----/,/\bgh[pousr]_[A-Za-z0-9]{30,}\b/,/\bgithub_pat_[A-Za-z0-9_]{30,}\b/,/\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/];
export async function auditSource(root,{ref}={}){
  if(ref&&(!/^[A-Za-z0-9_./-]+$/.test(ref)||ref.startsWith('-')))throw new Error('Invalid Git reference');
  let files=[],read;
  const args=ref?['ls-tree','-r','--name-only','-z',ref]:['ls-files','--cached','-z'];
  const git=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:10*1024*1024});
  if(git.status===0&&git.stdout){
    files=git.stdout.split('\0').filter(Boolean);
    read=async file=>execFileSync('git',['show',`${ref || ''}:${file}`],{cwd:root,maxBuffer:10*1024*1024});
  }else{
    if(ref)throw new Error('Cannot audit the requested committed Git tree');
    const walk=async dir=>{for(const item of await readdir(dir,{withFileTypes:true})){if(['.git','node_modules','.local','.connector-state','dist','artifacts'].includes(item.name))continue;const path=join(dir,item.name);if(item.isSymbolicLink())throw new Error('Source export must not contain symbolic links');if(item.isDirectory())await walk(path);else files.push(relative(root,path).replaceAll('\\','/'));}};
    await walk(root);read=file=>readFile(join(root,file));
  }
  const issues=[];
  for(const file of files){
    if(forbidden.test(file)||(/(?:^|\/)\.env(?:\.|$)/.test(file)&&!file.endsWith('.env.example'))){issues.push({file,reason:'runtime or credential filename'});continue;}
    const bytes=await read(file);
    if(bytes.length>1024*1024){issues.push({file,reason:'unexpected large source file'});continue;}
    if(bytes.includes(0)){issues.push({file,reason:'unexpected binary source file'});continue;}
    const content=bytes.toString('utf8');
    if(secrets.some(pattern=>pattern.test(content)))issues.push({file,reason:'possible credential; value withheld'});
    if(/\/Users\/(?!example(?:\/|\b))[^/\s"']+\/|[A-Za-z]:\\Users\\(?!example(?:\\|\b))[^\\\s"']+\\/.test(content))issues.push({file,reason:'personal workstation path'});
  }
  return {ok:issues.length===0,files:files.length,ref:ref || 'index-or-source',issues};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=dirname(dirname(fileURLToPath(import.meta.url))),at=process.argv.indexOf('--ref');
  const result=await auditSource(root,{ref:at>=0?process.argv[at+1]:undefined});
  console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
}
