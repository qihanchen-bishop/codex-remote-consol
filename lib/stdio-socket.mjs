import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

// The same JSON-RPC client can talk to a shared daemon or a private stdio
// app-server. Starting this transport never starts/resumes a conversation.
export class StdioSocket extends EventEmitter {
  readyState=0;
  constructor(command,{cwd,env=process.env}={}) {
    super();
    if(!Array.isArray(command)||!command.length||command.some(x=>typeof x!=='string'||!x||x.includes('\0')))throw new Error('Codex 启动命令无效');
    this.child=spawn(command[0],command.slice(1),{cwd,env,stdio:['pipe','pipe','inherit'],windowsHide:true});
    const lines=createInterface({input:this.child.stdout,crlfDelay:Infinity});
    lines.on('line',line=>{if(Buffer.byteLength(line)>64*1024*1024){this.emit('error',new Error('Codex 消息过大'));this.terminate();return;}if(line.trim().startsWith('{'))this.emit('message',Buffer.from(line));});
    this.child.once('spawn',()=>{this.readyState=1;this.emit('open');});
    this.child.once('error',error=>{this.emit('error',error);this.finish();});
    this.child.once('exit',()=>{lines.close();this.finish();});
    this.child.stdin.on('error',()=>{});
  }
  send(message,callback){if(this.readyState!==1){callback?.(new Error('Codex 连接不可用'));return;}this.child.stdin.write(message+'\n',callback);}
  finish(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
  close(){if(this.readyState===3)return;this.child.stdin.end();}
  terminate(){this.child.kill();this.finish();}
}
