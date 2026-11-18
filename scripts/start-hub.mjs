import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {loadSettings} from '../lib/settings.mjs';
import {codexCommand} from '../agent-connect.mjs';
import {CodexConnection} from '../lib/codex.mjs';
import {createConsole} from '../server.mjs';

export async function startHub(root){
  loadSettings(root);
  const transport=process.env.CODEX_TRANSPORT || 'auto';
  if(!['auto','shared','stdio'].includes(transport))throw new Error('CODEX_TRANSPORT must be auto, shared or stdio');
  const socket=process.env.CODEX_SOCKET || join(process.env.CODEX_HOME || join(homedir(),'.codex'),'app-server-control','app-server-control.sock');
  const shared=transport==='shared'||(transport==='auto'&&process.platform!=='win32');
  if(shared){
    let present=false;try{await access(socket);present=true;}catch{}
    if(!present){
      const command=await codexCommand();
      await new Promise((resolve,reject)=>{const child=spawn(command[0],[...command.slice(1),'app-server','daemon','start'],{stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Codex daemon startup failed; inspect its output.')));});
    }
  }
  const command=shared?undefined:[...await codexCommand(),'app-server','--listen','stdio://'];
  const codex=new CodexConnection(socket,{command,cwd:process.env.CODEX_DEFAULT_CWD || root});
  let app;
  try{app=await createConsole({codex});}catch(error){codex.close();throw error;}
  const host=process.env.WEB_HOST || '127.0.0.1',port=Number(process.env.WEB_PORT || 8787);
  if(!Number.isInteger(port)||port<1||port>65535){app.close();throw new Error('WEB_PORT must be a valid TCP port');}
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(port,host,resolve);});
  console.log(`Codex Remote Console: http://${host}:${port}`);
  console.log(`Codex transport: ${shared?'shared daemon':'stdio'}; viewing history does not resume tasks.`);
  codex.connect().catch(error=>console.error(error.message));
  process.once('SIGINT',app.close);process.once('SIGTERM',app.close);
  return app;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=dirname(dirname(fileURLToPath(import.meta.url)));
  startHub(root).catch(error=>{console.error(error.message);process.exitCode=1;});
}
