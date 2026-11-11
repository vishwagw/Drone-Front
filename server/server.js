// Drone Front game server: serves the game page, the account API, and the online worlds over
// WebSocket. The game is free; signing in is what keeps a pilot's progress.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { World, RULES, publicProfile } from './world.js';
import { Store } from './store.js';
import { hashPassword, checkPassword, newToken, tokenHash, validEmail, validPassword, Limiter } from './auth.js';

export { RULES };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION_TTL = 30 * 24 * 3600 * 1000;
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').trim().slice(0, 14);
const accountView = (a) => ({ email: a.email, ...publicProfile(a) });

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

export class Server {
  constructor({ store, rules = RULES, clientFile = path.resolve(HERE, '..', 'index.html'), trustProxy = false }) {
    Object.assign(this, { store, R: rules, clientFile, trustProxy });
    this.worlds = [];
    this.online = new Map();   // account id -> session, one live session per pilot
    this.authLimit = new Limiter(10, 60_000);
    this.signupLimit = new Limiter(5, 3600_000);
  }

  pick() {
    let w = this.worlds.find((x) => !x.full);
    if (!w) { w = new World(`Frontier ${this.worlds.length + 1}`, this.store, this.R); this.worlds.push(w); }
    return w;
  }
  get playerCount() { return this.worlds.reduce((n, w) => n + w.players.size, 0); }

  // ---------- WebSocket sessions ----------
  connect(rawSend, close) {
    let pl = null, world = null, budget = this.R.msgPerSec, budgetAt = Date.now();
    const send = (m) => rawSend(JSON.stringify(m));
    const deny = (code, why, wsCode) => { send({ t: 'denied', code, why }); close(wsCode, code); };
    const session = {
      account: null,
      end: () => {
        if (pl) world.leave(pl);
        if (session.account && this.online.get(session.account.id) === session) this.online.delete(session.account.id);
        pl = null;
      },
      kick: (why) => { send({ t: 'kicked', why }); session.end(); close(4000, 'replaced'); },
    };
    return {
      message: (data) => {
        const t = Date.now();
        budget = Math.min(this.R.msgPerSec, budget + (t - budgetAt) / 1000 * this.R.msgPerSec); budgetAt = t;
        if (--budget < 0 || data.length > this.R.maxMessage) return close(1008, 'rate');
        let m; try { m = JSON.parse(data); } catch { return; }
        if (!m || typeof m !== 'object') return;
        if (!pl) {
          if (m.t !== 'hello' || session.account) return;
          const account = typeof m.session === 'string' ? this.store.accountBySession(tokenHash(m.session)) : null;
          if (!account) return deny('auth', 'Sign in to fly online.', 4001);
          this.online.get(account.id)?.kick('This pilot signed in from another window.');
          session.account = account;
          this.online.set(account.id, session);
          world = this.pick();
          pl = world.join(send, account, m.color);
          return;
        }
        if (m.t === 'state') world.onState(pl, m);
        else if (m.t === 'hit') world.onHit(pl, m);
        else if (m.t === 'self') world.onSelfDamage(pl, m);
      },
      close: () => session.end(),
    };
  }

  // ---------- HTTP API ----------
  ip(req) {
    if (this.trustProxy) return String(req.headers['fly-client-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    return req.socket.remoteAddress;
  }
  auth(req) {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '');
    const account = m && this.store.accountBySession(tokenHash(m[1]));
    if (!account) throw new HttpError(401, 'Your session has ended. Sign in again.');
    return { account, token: m[1] };
  }
  startSession(account) {
    const token = newToken();
    this.store.createSession(tokenHash(token), account.id, SESSION_TTL);
    return { token, account: accountView(account) };
  }

  async api(req, raw) {
    const route = `${req.method} ${req.url.split('?')[0]}`;
    const body = () => { try { return JSON.parse(raw || '{}'); } catch { throw new HttpError(400, 'Malformed request.'); } };
    switch (route) {
      case 'GET /api/info':
        return { game: 'drone-front', players: this.playerCount, worlds: this.worlds.length };
      case 'POST /api/signup': {
        const { email, password, callsign } = body();
        const mail = String(email || '').trim().toLowerCase(), name = cleanName(callsign);
        if (!validEmail(mail)) throw new HttpError(400, 'Enter a valid email address.');
        if (!validPassword(password)) throw new HttpError(400, 'Use a password of at least 8 characters.');
        if (name.length < 2) throw new HttpError(400, 'Pick a callsign of 2 to 14 characters.');
        if (!this.signupLimit.allow(this.ip(req))) throw new HttpError(429, 'Too many new accounts from this network. Try again later.');
        if (this.store.accountByEmail(mail)) throw new HttpError(409, 'An account with this email already exists. Sign in instead.');
        return this.startSession(this.store.createAccount(mail, await hashPassword(password), name));
      }
      case 'POST /api/login': {
        const { email, password } = body();
        const mail = String(email || '').trim().toLowerCase();
        if (!this.authLimit.allow(this.ip(req)) || !this.authLimit.allow(`e:${mail}`)) throw new HttpError(429, 'Too many sign-in attempts. Wait a minute and try again.');
        const account = validEmail(mail) ? this.store.accountByEmail(mail) : null;
        if (!account || !(await checkPassword(String(password || ''), account.pass))) throw new HttpError(401, 'Email or password is incorrect.');
        return this.startSession(account);
      }
      case 'POST /api/logout': {
        const { token } = this.auth(req);
        this.store.deleteSession(tokenHash(token));
        return { ok: true };
      }
      case 'GET /api/me':
        return { account: accountView(this.auth(req).account) };
      default:
        throw new HttpError(404, 'Not found.');
    }
  }

  handle(req, res) {
    const url = req.url.split('?')[0];
    const security = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin' };
    if (url === '/' && req.method === 'GET') {
      fs.readFile(this.clientFile, (err, body) => {
        if (err) { res.writeHead(500); res.end('client missing'); return; }
        res.writeHead(200, { ...security, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(body);
      });
      return;
    }
    if (url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
    if (url === '/worldgen.js' && req.method === 'GET') {   // the shared map generator, imported by the game page
      fs.readFile(path.join(HERE, 'worldgen.js'), (err, body) => {
        if (err) { res.writeHead(500); res.end(); return; }
        res.writeHead(200, { ...security, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' }); res.end(body);
      });
      return;
    }
    if (!url.startsWith('/api/')) { res.writeHead(404, security); res.end('not found'); return; }
    let raw = '', size = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk) => { size += chunk.length; if (size > 64 * 1024) req.destroy(); else raw += chunk; });
    req.on('end', async () => {
      let status = 200, out;
      try { out = await this.api(req, raw); }
      catch (err) {
        status = err instanceof HttpError ? err.status : 500;
        out = { error: err instanceof HttpError ? err.message : 'Something went wrong on our side.' };
        if (status === 500) console.error(err);
      }
      res.writeHead(status, { ...security, 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out));
    });
  }

  start(port) {
    const httpServer = http.createServer((req, res) => this.handle(req, res));
    const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: this.R.maxMessage });
    wss.on('connection', (ws) => {
      const conn = this.connect((s) => { if (ws.readyState === 1) ws.send(s); }, (code, why) => ws.close(code, why));
      ws.on('message', (d) => conn.message(String(d)));
      ws.on('close', conn.close);
      ws.on('error', () => {});
    });
    this.timers = [
      setInterval(() => this.worlds.forEach((w) => w.tick()), 1000 / this.R.snapshotHz),
      setInterval(() => this.worlds.forEach((w) => w.board()), 1000),
      setInterval(() => this.store.flush(), 5000),
      setInterval(() => { this.store.purgeSessions(); this.authLimit.sweep(); this.signupLimit.sweep(); }, 3600_000),
    ];
    return new Promise((resolve) => httpServer.listen(port, () => { this.http = httpServer; this.wss = wss; resolve(httpServer.address().port); }));
  }

  stop() {
    this.timers?.forEach(clearInterval);
    this.store.flush();
    this.wss?.clients.forEach((c) => c.terminate());
    return new Promise((r) => (this.http ? this.http.close(() => r()) : r()));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const dataDir = env.DATA_DIR || path.join(HERE, 'data');
  const server = new Server({
    store: new Store(path.join(dataDir, 'drone-front.db')),
    clientFile: env.CLIENT_FILE || undefined, trustProxy: env.TRUST_PROXY === '1',
  });
  const port = await server.start(Number(env.PORT) || 8080);
  console.log(`Drone Front server on http://localhost:${port}`);
  const shutdown = async () => { await server.stop(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
