import { timingSafeEqual, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { hostname } from 'node:os';

export function isPrivateIP(ip = '') {
  ip = ip.replace(/^::ffff:/, '').split('%')[0];
  if (ip === '::1') return true;
  if (isIP(ip) === 6) return /^(fc|fd|fe[89ab])/i.test(ip);
  if (!isIP(ip)) return false;
  const [a,b] = ip.split('.').map(Number);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}
export function allowedHost(host, extraHosts = []) {
  return host === 'localhost' || host === hostname() || extraHosts.includes(host) || isPrivateIP(host.replace(/^\[|\]$/g, ''));
}
export function sameSecret(a, b) {
  const hash = x => createHash('sha256').update(String(x)).digest();
  return timingSafeEqual(hash(a), hash(b));
}
export function cookieValue(header, name) {
  return (header || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1);
}
