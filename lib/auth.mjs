import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sameSecret } from './security.mjs';

const derive = promisify(scrypt);
export async function makeCredentials(username, password) {
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(username.trim())) throw new Error('账号需为 1 到 64 位字母、数字、下划线、点或短横线');
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw new Error('密码需为 8 到 1024 个字符');
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64);
  return { version: 1, username: username.trim(), algorithm: 'scrypt', salt, hash: hash.toString('hex') };
}
export async function writeCredentials(path, username, password) {
  const credentials = await makeCredentials(username, password);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.credentials-${randomBytes(8).toString('hex')}.tmp`);
  await writeFile(temporary, JSON.stringify(credentials) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, path); await chmod(path, 0o600);
  return credentials;
}
export async function readCredentials(path) {
  let c;
  try { c = JSON.parse(await readFile(path, 'utf8')); }
  catch(e) { if (e.code === 'ENOENT') throw new Error('尚未配置网站账号，请运行 node scripts/set-credentials.mjs --username <账号>'); throw e; }
  if (c.version !== 1 || c.algorithm !== 'scrypt' || typeof c.username !== 'string' || !/^[a-f0-9]{32}$/.test(c.salt) || !/^[a-f0-9]{128}$/.test(c.hash)) throw new Error('网站账号配置格式错误');
  return c;
}
export async function verifyCredentials(credentials, username, password) {
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > 1024 || username.length > 128) return false;
  const candidate = await derive(password, credentials.salt, 64);
  const hashMatches = timingSafeEqual(candidate, Buffer.from(credentials.hash, 'hex'));
  return sameSecret(username.trim(), credentials.username) && hashMatches;
}
