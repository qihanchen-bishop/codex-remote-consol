import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { writeCredentials } from '../lib/auth.mjs';
import { loadSettings } from '../lib/settings.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
loadSettings(root);

const username = process.argv[process.argv.indexOf('--username') + 1];
if (!process.argv.includes('--username') || !username) throw new Error('用法：node scripts/set-credentials.mjs --username <账号>，密码从隐藏提示或 stdin 输入');
let password;
if (process.stdin.isTTY) {
  const silent = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const rl = createInterface({ input: process.stdin, output: silent, terminal: true });
  try {
    process.stderr.write('输入新密码（不显示）：'); password = await rl.question(''); process.stderr.write('\n');
    process.stderr.write('再次输入密码：'); const confirmation = await rl.question(''); process.stderr.write('\n');
    if (password !== confirmation) throw new Error('两次密码不一致');
  } finally { rl.close(); }
} else {
  let raw = ''; for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 2048) throw new Error('密码输入过长'); }
  password = raw.replace(/\r?\n$/, '');
}
const path = join(process.env.WEB_STATE_DIR || join(root, '.local'), 'credentials.json');
const credentials = await writeCredentials(path, username, password);
console.log(`网站账号已配置：${credentials.username}；已保存加盐哈希，请重新启动工作台生效。`);
