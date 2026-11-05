// One persistent shared world. The server is the authority for hull, deaths, kills, ammo and
// pilot stats; clients send their own flight state and claim hits, and every claim is checked
// (rate, range, ammo, target state) before it is applied. The map is the generated open world.
import * as WG from './worldgen.js';

export const RULES = {
  maxPlayersPerWorld: 64,
  snapshotHz: 15, viewRange: 1500,
  bounds: WG.HALF - 30, ceiling: 600,
  maxSpeed: 30, moveSlack: 8, spawnGrace: 1500,
  hull: 100, respawnMs: 4000, shieldMs: 2500,
  gunDamage: 3.5, gunRate: 12, gunBurst: 14, gunRange: 220,
  rocketDamage: 38, rocketAmmo: 6, rocketRegenMs: 8000, rocketRange: 260, rocketWindowMs: 5000,
  padRadius: 5, padMaxY: 2.5, padHealPerSec: 12, padRearmMs: 1200,
  selfDamageMax: 50, killCredit: 10, killXp: 100,
  msgPerSec: 60, maxMessage: 4096,
};

const now = () => Date.now();
const finite = (...xs) => xs.every(Number.isFinite);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const level = (xp) => 1 + Math.floor(Math.sqrt(xp / 250));
export const publicProfile = (a) => ({ name: a.callsign, xp: a.xp, level: level(a.xp), credits: a.credits, kills: a.kills, deaths: a.deaths });

export class World {
  // `store` needs markDirty(account); accounts are live objects with callsign, xp, credits, kills, deaths.
  constructor(name, store, rules = RULES) {
    this.name = name; this.store = store; this.R = rules;
    this.players = new Map(); this.nextId = 1;
  }
  get full() { return this.players.size >= this.R.maxPlayersPerWorld; }

  // Spawn beside an outpost: usually one with pilots within a few kilometres but nobody on top of it.
  spawnPoint() {
    let best = null, bs = -Infinity;
    for (const o of WG.OUTPOSTS) {
      let near = 1e9;
      for (const p of this.players.values()) if (p.al) near = Math.min(near, Math.hypot(p.p[0] - o.x, p.p[2] - o.z));
      const s = (near === 1e9 ? 0 : -Math.abs(near - 600)) + Math.random() * 150;   // close enough to find a fight, not on top of one
      if (s > bs) { bs = s; best = o; }
    }
    const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * 30;
    const x = best.x + Math.cos(a) * r, z = best.z + Math.sin(a) * r;
    return [x, WG.height(x, z) + 30, z];
  }

  join(send, account, color) {
    const id = (this.nextId++).toString(36);
    const pl = { id, send, account, name: account.callsign, c: clamp(color | 0, 0, 7), p: [0, 30, 0], v: [0, 0, 0], y: 0, a: 0, f: 0, rs: 0, lk: null,
      h: this.R.hull, al: false, shieldUntil: 0, respawnAt: 0, lastMove: now(), lastFire: 0,
      gunBudget: this.R.gunBurst, gunAt: now(), ammo: this.R.rocketAmmo, regenAt: now(), rocketCredits: [], rearmAt: 0,
      lastHit: null, k: 0, d: 0 };
    this.players.set(id, pl);
    const spawn = this.spawn(pl, false);
    pl.send({ t: 'welcome', id, world: this.name, profile: publicProfile(account), spawn });
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
    victim.d++; victim.account.deaths++; this.store.markDirty(victim.account);
    const credited = killer && killer !== victim && this.players.has(killer.id);
    if (credited) {
      const a = killer.account;
      killer.k++; a.kills++; a.credits += this.R.killCredit; a.xp += this.R.killXp;
      this.store.markDirty(a);
      killer.send({ t: 'profile', profile: publicProfile(a) });
    }
    this.broadcast({ t: 'kill', k: credited ? killer.id : null, v: victim.id, kn: credited ? killer.name : null, vn: victim.name });
  }

  tick() {
    const t = now();
    for (const pl of this.players.values()) {
      if (!pl.al) { if (t >= pl.respawnAt) this.spawn(pl); continue; }
      if (t - pl.regenAt >= this.R.rocketRegenMs) { pl.regenAt = t; pl.ammo = Math.min(this.R.rocketAmmo, pl.ammo + 1); }
      const pad = WG.padAt(pl.p[0], pl.p[2], this.R.padRadius);
      if (pad && pl.p[1] < pad.y + this.R.padMaxY) {   // landed on an outpost pad: repair and rearm
        pl.h = Math.min(this.R.hull, pl.h + this.R.padHealPerSec / this.R.snapshotHz);
        if (t >= pl.rearmAt && pl.ammo < this.R.rocketAmmo) { pl.ammo++; pl.rearmAt = t + this.R.padRearmMs; }
      }
    }
    const view = [...this.players.values()].map((o) => ({ id: o.id, n: o.name, c: o.c, p: o.p, v: o.v, y: o.y, a: o.a,
      f: o.f, rs: o.rs, lk: o.lk, h: Math.round(o.h), al: o.al ? 1 : 0, iv: o.shieldUntil > t ? 1 : 0 }));
    const range = this.R.viewRange;
    for (const pl of this.players.values()) {   // each pilot hears only about pilots within view range
      pl.send({ t: 'snap', me: { h: Math.round(pl.h * 10) / 10, al: pl.al ? 1 : 0, iv: pl.shieldUntil > t ? 1 : 0, rk: pl.ammo },
        pl: view.filter((o) => o.id !== pl.id && Math.abs(o.p[0] - pl.p[0]) < range && Math.abs(o.p[2] - pl.p[2]) < range) });
    }
  }

  board() {
    const list = [...this.players.values()].map((o) => ({ id: o.id, n: o.name, k: o.k, d: o.d }))
      .sort((a, b) => b.k - a.k || a.d - b.d);
    this.broadcast({ t: 'board', list: list.slice(0, 20) });
  }

  broadcast(m) { for (const pl of this.players.values()) pl.send(m); }
}
