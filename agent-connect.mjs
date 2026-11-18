import {readFile,access} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline/promises';
import {createConsole} from './server.mjs';
import {CodexConnection} from './lib/codex.mjs';
import {configuredCommand,loadSettings} from './lib/settings.mjs';

export function sshArguments(target,remotePort,localPort,sshPort){
  if(typeof target!=='string'||!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:\[\]-]{0,240}$/.test(target))throw new Error('请使用 user@host 或 SSH 配置中的主机别名');
  for(const port of [remotePort,localPort])if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('端口无效');
  const args=['-NT','-o','ExitOnForwardFailure=yes','-o','ServerAliveInterval=30','-o','ServerAliveCountMax=3','-R',`127.0.0.1:${remotePort}:127.0.0.1:${localPort}`];
  if(sshPort){if(!Number.isInteger(sshPort)||sshPort<1||sshPort>65535)throw new Error('SSH端口无效');args.push('-p',String(sshPort));}
  return [...args,target];
}
async function exists(path){try{await access(path);return true;}catch{return false;}}
export async function codexCommand(config={}){
  const configured=configuredCommand(config);if(configured)return configured;
  if(process.platform==='win32'){
    const paths=spawnSync('where.exe',['codex'],{encoding:'utf8',windowsHide:true}).stdout?.split(/\r?\n/).filter(Boolean) || [];
    const exe=paths.find(p=>p.toLowerCase().endsWith('.exe'));if(exe)return [exe];
    for(const path of paths){const js=join(dirname(path),'node_modules','@openai','codex','bin','codex.js');if(await exists(js))return [process.execPath,js];}
    throw Error('找不到 Codex 可执行文件，请在 connector.json 中设置 codexCommand 数组');
  }
  return ['codex'];
}
export async function startConnector(config,{noSSH=false}={}){
  if(!config||typeof config.token!=='string'||config.token.length<32)throw Error('缺少有效的 connector.json，请从已登录工作台下载接入包');
  const cwd=resolve(config.cwd || homedir()),socketPath=join(process.env.CODEX_HOME || join(homedir(),'.codex'),'app-server-control','app-server-control.sock');
  const shared=process.platform!=='win32'&&config.transport!=='stdio'&&await exists(socketPath);
  const command=shared?undefined:[...await codexCommand(config),'app-server','--listen','stdio://'];
  const codex=new CodexConnection(socketPath,{command,cwd});
  const app=await createConsole({stateDir:join(root,'.connector-state'),codex,agentToken:config.token,defaultCwd:cwd,publicOrigin:'',publicPath:''});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  try{await codex.connect();await codex.rpc('thread/list',{limit:1,modelProviders:[],sourceKinds:[]});}
  catch(error){app.close();throw new Error('本地 Codex 协议检查失败：'+error.message);}
  console.log('本地 Codex 已连接；历史读取已确认，未恢复任何会话。');
  if(noSSH)return app;
  let target=config.sshTarget;
  if(!target){const prompt=createInterface({input:process.stdin,output:process.stdout});try{target=(await prompt.question('输入你平时 SSH 的目标（user@host 或主机别名）：')).trim();}finally{prompt.close();}}
  let args;try{args=sshArguments(target,config.remotePort,app.server.address().port,config.sshPort);}catch(error){app.close();throw error;}
  console.log('正在建立 SSH 反向隧道。请按 SSH 提示核对主机并登录；此窗口需要保持运行。');
  const ssh=spawn('ssh',args,{stdio:'inherit',windowsHide:false});
  const close=()=>{ssh.kill();app.close();};process.once('SIGINT',close);process.once('SIGTERM',close);
  ssh.once('error',error=>{console.error('SSH 启动失败：'+error.message);app.close();process.exitCode=1;});
  ssh.once('exit',code=>{app.close();if(code)console.error('SSH 已退出，请检查连接信息后重新运行接入脚本。');process.exitCode=code || 0;});
  return app;
}
const root=dirname(fileURLToPath(import.meta.url));
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{loadSettings(root);const config=JSON.parse(await readFile(join(root,'connector.json'),'utf8'));await startConnector(config);}
  catch(error){console.error(error.message);process.exitCode=1;}
}
