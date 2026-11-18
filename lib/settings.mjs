import {loadEnvFile} from 'node:process';
import {join} from 'node:path';

export function loadSettings(root){
  try{loadEnvFile(join(root,'.env'));}catch(error){if(error.code!=='ENOENT')throw error;}
}
export function validateCommand(command){
  if(!Array.isArray(command)||!command.length||command.some(x=>typeof x!=='string'||!x||/[\0\r\n]/.test(x)))throw new Error('Codex command must be a nonempty JSON array of arguments');
  return [...command];
}
export function configuredCommand(config={},env=process.env){
  if(config.codexCommand!==undefined)return validateCommand(config.codexCommand);
  if(env.CODEX_COMMAND_JSON)return validateCommand(JSON.parse(env.CODEX_COMMAND_JSON));
  if(env.CODEX_PROXY_BIN)return [env.CODEX_PROXY_BIN,'run',env.CODEX_BIN || 'codex'];
  if(env.CODEX_BIN)return [env.CODEX_BIN];
  return null;
}
