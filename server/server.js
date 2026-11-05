// Drone Front game server.
// Serves the game page and runs persistent shared worlds over WebSocket. The server is the
// authority for hull, deaths, kills, ammo and saved progress; clients send their own flight
// state and claim hits, and every claim is checked (rate, range, ammo, target state) first.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const CLIENT = process.env.CLIENT_FILE || path.resolve(HERE, '..', 'index.html');
const DATA_DIR = process.env.DATA_DIR || path.join(HERE, 'data');
const PROFILES = path.join(DATA_DIR, 'profiles.json');

export const RULES = {
  maxPlayersPerWorld: 32,
  snapshotHz: 15,
  bounds: 188, ceiling: 120,
  maxSpeed: 30, moveSlack: 8, spawnGrace: 1500,
  hull: 100, respawnMs: 4000, shieldMs: 2500,
  gunDamage: 3.5, gunRate: 12, gunBurst: 14, gunRange: 220,
  rocketDamage: 38, rocketAmmo: 6, rocketRegenMs: 8000, rocketRange: 260, rocketWindowMs: 5000,
  pad: { x: 0, z: 0, r: 5, maxY: 2.5 }, padHealPerSec: 12, padRearmMs: 1200,
  selfDamageMax: 50, killCredit: 10, killXp: 100,
  msgPerSec: 60, maxMessage: 4096,
};

const now = () => Date.now();
const finite = (...xs) => xs.every(Number.isFinite);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, '').trim().slice(0, 14) || 'Pilot';
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const level = (xp) => 1 + Math.floor(Math.sqrt(xp / 250));

// ---------- saved player profiles (guest accounts keyed by a secret token) ----------
export class ProfileStore {
  constructor(file) {
    this.file = file; this.dirty = false; this.byToken = {};
    try { this.byToken = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  }
  get(token) { return this.byToken[token]; }
  create(name) {
    const token = crypto.randomBytes(16).toString('hex');
    this.byToken[token] = { name, xp: 0, credits: 0, kills: 0, deaths: 0, created: now(), last: now() };
    this.dirty = true;
    return token;
  }
  touch() { this.dirty = true; }
  save() {
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.byToken));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
}
export const publicProfile = (p) => ({ name: p.name, xp: p.xp, level: level(p.xp), credits: p.credits, kills: p.kills, deaths: p.deaths });

// ---------- one shared world ----------
export class World {
  constructor(name, store, rules = RULES) {
    this.name = name; this.store = store; this.R = rules;
    this.players = new Map(); this.nextId = 1;
  }
  get full() { return this.players.size >= this.R.maxPlayersPerWorld; }

  spawnPoint() {
    let best = null, bd = -1;
    for (let k = 0; k < 12; k++) {
      const a = Math.random() * Math.PI * 2, p = [Math.cos(a) * 125, 30, Math.sin(a) * 125];
      let near = 1e9;
      for (const o of this.players.values()) if (o.al) near = Math.min(near, Math.hypot(o.p[0] - p[0], o.p[2] - p[2]));
      if (near > bd) { bd = near; best = p; }
    }
    return best;
  }

  join(send, token, name, color) {
    let profile = token && this.store.get(token);
    if (!profile) { token = this.store.create(name); profile = this.store.get(token); }
    profile.name = name; profile.last = now(); this.store.touch();
    const id = (this.nextId++).toString(36);
    const pl = { id, send, token, profile, name, c: clamp(color | 0, 0, 7), p: [0, 30, 0], v: [0, 0, 0], y: 0, a: 0, f: 0, rs: 0, lk: null,
      h: this.R.hull, al: false, shieldUntil: 0, respawnAt: 0, lastMove: now(), lastFire: 0,
      gunBudget: this.R.gunBurst, gunAt: now(), ammo: this.R.rocketAmmo, regenAt: now(), rocketCredits: [], rearmAt: 0,
      lastHit: null, k: 0, d: 0 };
    this.players.set(id, pl);
    const spawn = this.spawn(pl, false);
    pl.send({ t: 'welcome', id, token, world: this.name, profile: publicProfile(profile), spawn });
    return pl;
  }

  spawn(pl, notify = true) {
    pl.p = this.spawnPoint(); pl.v = [0, 0, 0];
    pl.y = Math.atan2(pl.p[0], pl.p[2]);
    pl.h = this.R.hull; pl.al = true; pl.ammo = this.R.rocketAmmo; pl.rocketCredits = [];
    pl.shieldUntil = now() + this.R.shieldMs; pl.graceUntil = now() + this.R.spawnGrace; pl.lastMove = now(); pl.lastHit = null;
    const spawn = { x: pl.p[0], z: pl.p[2], y: pl.y };
    if (notify) pl.send({ t: 'spawn', ...spawn });
    return spawn;
  }

  leave(pl) { this.players.delete(pl.id); }

  onState(pl, m) {
    if (!pl.al) return;
    const p = m.p, v = m.v;
    if (!Array.isArray(p) || !Array.isArray(v) || p.length !== 3 || v.length !== 3 || !finite(...p, ...v, m.y, m.a)) return;
    const t = now();
    const allowed = t < pl.graceUntil ? 60 : this.R.maxSpeed * (t - pl.lastMove) / 1000 + this.R.moveSlack;
    const from = t < pl.graceUntil ? [pl.p[0], p[1], pl.p[2]] : pl.p;
    if (dist(p, from) > allowed) { pl.send({ t: 'correct', p: pl.p }); return; }   // teleport or speed hack
    pl.p = [clamp(p[0], -this.R.bounds, this.R.bounds), clamp(p[1], -20, this.R.ceiling), clamp(p[2], -this.R.bounds, this.R.bounds)];
    pl.v = v.map((x) => clamp(x, -40, 40)); pl.y = m.y; pl.a = clamp(m.a, -1, 1); pl.lastMove = t;
    pl.f = m.f ? 1 : 0; if (pl.f) pl.lastFire = t;
    pl.lk = typeof m.lk === 'string' && m.lk.length <= 16 ? m.lk : null;
    if (Number.isInteger(m.rs) && m.rs > pl.rs) {   // rockets launched since the last update
      const fired = Math.min(m.rs - pl.rs, pl.ammo);
      pl.ammo -= fired;
      for (let i = 0; i < fired; i++) pl.rocketCredits.push(t + this.R.rocketWindowMs);
      pl.rs = m.rs;
    }
  }

  onHit(pl, m) {
    const target = this.players.get(String(m.target));
    const t = now();
    if (!pl.al || !target || target === pl || !target.al || target.shieldUntil > t) return false;
    if (m.w === 'gun') {
      if (t - pl.lastFire > 600 || dist(pl.p, target.p) > this.R.gunRange) return false;
      pl.gunBudget = Math.min(this.R.gunBurst, pl.gunBudget + (t - pl.gunAt) / 1000 * this.R.gunRate); pl.gunAt = t;
      const n = Math.min(Math.max(1, m.n | 0), Math.floor(pl.gunBudget));
      if (n <= 0) return false;
      pl.gunBudget -= n;
      this.damage(target, n * this.R.gunDamage, pl);
      return true;
    }
    if (m.w === 'rocket') {
      pl.rocketCredits = pl.rocketCredits.filter((exp) => exp > t);
      if (!pl.rocketCredits.length || dist(pl.p, target.p) > this.R.rocketRange) return false;
      pl.rocketCredits.shift();
      this.damage(target, this.R.rocketDamage, pl);
      return true;
    }
    return false;
  }

  onSelfDamage(pl, m) {
    const n = Number(m.n);
    if (!pl.al || !Number.isFinite(n) || n <= 0 || pl.shieldUntil > now()) return;
    const by = pl.lastHit && now() - pl.lastHit.t < 6000 ? this.players.get(pl.lastHit.id) : null;
    this.damage(pl, Math.min(n, this.R.selfDamageMax), by, true);
  }

  damage(target, n, by, self = false) {
    target.h = Math.max(0, target.h - n);
    if (by && !self) target.lastHit = { id: by.id, t: now() };
    target.send({ t: 'dmg', n, h: target.h, from: by && !self ? by.id : null });
    if (target.h <= 0) this.kill(target, by);
  }

  kill(victim, killer) {
    victim.al = false; victim.f = 0; victim.respawnAt = now() + this.R.respawnMs;
    victim.d++; victim.profile.deaths++;
    if (killer && killer !== victim && this.players.has(killer.id)) {
      killer.k++; killer.profile.kills++; killer.profile.credits += this.R.killCredit; killer.profile.xp += this.R.killXp;
      killer.send({ t: 'profile', profile: publicProfile(killer.profile) });
    }
    this.store.touch();
    this.broadcast({ t: 'kill', k: killer && killer !== victim ? killer.id : null, v: victim.id, kn: killer && killer !== victim ? killer.name : null, vn: victim.name });
  }

  tick() {
    const t = now();
    for (const pl of this.players.values()) {
      if (!pl.al) { if (t >= pl.respawnAt) this.spawn(pl); continue; }
      if (t - pl.regenAt >= this.R.rocketRegenMs) { pl.regenAt = t; pl.ammo = Math.min(this.R.rocketAmmo, pl.ammo + 1); }
      const P = this.R.pad;
      if (Math.hypot(pl.p[0] - P.x, pl.p[2] - P.z) < P.r && pl.p[1] < P.maxY) {   // landed on the pad: repair and rearm
        pl.h = Math.min(this.R.hull, pl.h + this.R.padHealPerSec / this.R.snapshotHz);
        if (t >= pl.rearmAt && pl.ammo < this.R.rocketAmmo) { pl.ammo++; pl.rearmAt = t + this.R.padRearmMs; }
      }
    }
    const view = [...this.players.values()].map((o) => ({ id: o.id, n: o.name, c: o.c, p: o.p, v: o.v, y: o.y, a: o.a,
      f: o.f, rs: o.rs, lk: o.lk, h: Math.round(o.h), al: o.al ? 1 : 0, iv: o.shieldUntil > t ? 1 : 0 }));
    for (const pl of this.players.values()) {
      pl.send({ t: 'snap', me: { h: Math.round(pl.h * 10) / 10, al: pl.al ? 1 : 0, iv: pl.shieldUntil > t ? 1 : 0, rk: pl.ammo },
        pl: view.filter((o) => o.id !== pl.id) });
    }
  }

  board() {
    const list = [...this.players.values()].map((o) => ({ id: o.id, n: o.name, k: o.k, d: o.d }))
      .sort((a, b) => b.k - a.k || a.d - b.d);
    this.broadcast({ t: 'board', list: list.slice(0, 20) });
  }

  broadcast(m) { for (const pl of this.players.values()) pl.send(m); }
}

// ---------- worlds (shards) ----------
export class Server {
  constructor(store, rules = RULES) { this.store = store; this.R = rules; this.worlds = []; this.sessions = new Map(); }
  pick() {
    let w = this.worlds.find((x) => !x.full);
    if (!w) { w = new World(`Frontier ${this.worlds.length + 1}`, this.store, this.R); this.worlds.push(w); }
    return w;
  }
  get playerCount() { return this.worlds.reduce((n, w) => n + w.players.size, 0); }

  connect(rawSend, close) {
    let pl = null, world = null, budget = this.R.msgPerSec, budgetAt = now();
    const send = (m) => rawSend(JSON.stringify(m));
    const session = {
      token: null,
      end: () => {
        if (pl) world.leave(pl);
        if (session.token && this.sessions.get(session.token) === session) this.sessions.delete(session.token);
        pl = null;
      },
      kick: () => {
        send({ t: 'kicked', why: 'This pilot signed in from another window' });
        session.end();
        close(4000, 'replaced');
      },
    };
    return {
      message: (data) => {
        const t = now();
        budget = Math.min(this.R.msgPerSec, budget + (t - budgetAt) / 1000 * this.R.msgPerSec); budgetAt = t;
        if (--budget < 0 || data.length > this.R.maxMessage) return close(1008, 'rate');
        let m; try { m = JSON.parse(data); } catch { return; }
        if (!m || typeof m !== 'object') return;
        if (!pl) {
          if (m.t !== 'hello') return;
          world = this.pick();
          const token = typeof m.token === 'string' && /^[0-9a-f]{32}$/.test(m.token) ? m.token : null;
          if (token) this.sessions.get(token)?.kick();   // one live session per pilot: the newest wins
          pl = world.join(send, token, cleanName(m.name), m.color);
          session.token = pl.token;
          this.sessions.set(pl.token, session);
          return;
        }
        if (m.t === 'state') world.onState(pl, m);
        else if (m.t === 'hit') world.onHit(pl, m);
        else if (m.t === 'self') world.onSelfDamage(pl, m);
      },
      close: () => session.end(),
    };
  }

  start(port) {
    const httpServer = http.createServer((req, res) => {
      if (req.url === '/api/info') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ game: 'drone-front', players: this.playerCount, worlds: this.worlds.length }));
      } else if (req.url === '/' || req.url.startsWith('/?')) {
        fs.readFile(CLIENT, (err, body) => {
          if (err) { res.writeHead(500); res.end('client missing'); return; }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body);
        });
      } else if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); }
      else { res.writeHead(404); res.end('not found'); }
    });
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
      setInterval(() => this.store.save(), 10000),
    ];
    return new Promise((resolve) => httpServer.listen(port, () => { this.http = httpServer; this.wss = wss; resolve(httpServer.address().port); }));
  }

  stop() {
    this.timers?.forEach(clearInterval);
    this.store.save();
    this.wss?.clients.forEach((c) => c.terminate());
    return new Promise((r) => this.http ? this.http.close(() => r()) : r());
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = new Server(new ProfileStore(PROFILES));
  const port = await server.start(PORT);
  console.log(`Drone Front server on http://localhost:${port}`);
  const shutdown = async () => { await server.stop(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
