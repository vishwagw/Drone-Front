// Passwords (scrypt), session tokens and a small rate limiter.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32, SCRYPT);
  return `s1$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function checkPassword(password, stored) {
  const [version, salt, key] = String(stored).split('$');
  if (version !== 's1' || !salt || !key) return false;
  const got = await scrypt(password, Buffer.from(salt, 'hex'), 32, SCRYPT);
  const want = Buffer.from(key, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export const newToken = () => crypto.randomBytes(32).toString('hex');
export const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

export const validEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
export const validPassword = (s) => typeof s === 'string' && s.length >= 8 && s.length <= 200;

// Fixed-window limiter: at most `max` hits per key per window.
export class Limiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  allow(key) {
    const t = Date.now(), h = this.hits.get(key);
    if (!h || t >= h.reset) { this.hits.set(key, { n: 1, reset: t + this.windowMs }); return true; }
    h.n++;
    return h.n <= this.max;
  }
  sweep() { const t = Date.now(); for (const [k, h] of this.hits) if (t >= h.reset) this.hits.delete(k); }
}
