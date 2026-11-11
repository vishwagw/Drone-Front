// Server-run enemies for the open world: scout patrols, tank patrols, base AA guns, and the bases
// pilots can capture. Enemy shots are simulated here and stopped by terrain and scenery, so damage
// to pilots is decided only by the server.
import * as WG from './worldgen.js';

export const NPC = {
  scout: { hp: 3 * 3.5, radius: 1.6, name: 'Scout', credits: 15, xp: 50, respawnMs: 120_000 },
  tank: { hp: 24 * 3.5, radius: 3.4, name: 'Tank', credits: 40, xp: 150, respawnMs: 150_000 },
  aa: { hp: 16 * 3.5, radius: 2.8, name: 'AA gun', credits: 25, xp: 80, respawnMs: 0 },
};
export const BASE_RULES = { captureSec: 15, holdMs: 10 * 60_000, rewardCredits: 60, rewardXp: 250, rewardRange: 300, captureAgl: 35 };
const ACTIVE_RANGE = 1800;   // enemies with no pilot this close sleep

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const wrap = (a) => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
const yawTo = (from, to) => Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
function segDist2(a, b, c) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2], l2 = dx * dx + dy * dy + dz * dz || 1e-6;
  const t = clamp(((c[0] - a[0]) * dx + (c[1] - a[1]) * dy + (c[2] - a[2]) * dz) / l2, 0, 1);
  const px = a[0] + dx * t - c[0], py = a[1] + dy * t - c[1], pz = a[2] + dz * t - c[2];
  return px * px + py * py + pz * pz;
}

export class Npcs {
  constructor(world, random = Math.random) {
    this.w = world; this.rand = random;
    this.list = new Map(); this.nextId = 1; this.bolts = []; this.pending = []; this.obsCache = new Map();
    this.bases = WG.BASES.map((b) => ({ ...b, owner: 'h', prog: 0, ownedUntil: 0, defenders: [] }));
    for (const b of this.bases) this.garrison(b);
  }

  // ---------- spawning ----------
  add(k, fields) {
    const id = `n${(this.nextId++).toString(36)}`;
    const n = { id, k, h: NPC[k].hp, p: [0, 0, 0], v: [0, 0, 0], y: 0, ty: 0, ge: 0, cool: 1 + this.rand() * 2, burst: 0, burstT: 0, target: null, ...fields };
    this.list.set(id, n);
    return n;
  }
  landPoint(cx, cz, r) {   // a dry spot near (cx, cz)
    for (let i = 0; i < 20; i++) {
      const a = this.rand() * Math.PI * 2, d = r * (0.4 + this.rand() * 0.6), x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (WG.height(x, z) > WG.WATER + 2) return [x, z];
    }
    return [cx, cz];
  }
  garrison(b) {
    b.defenders = WG.BASE_AA.map(([dx, dz]) => this.add('aa', { base: b.id, p: [b.x + dx, b.y + 1.4, b.z + dz] }).id);
    if (!this.list.has(b.tank)) this.spawnTank(b);
    if (!b.scouts || !b.scouts.some((id) => this.list.has(id))) this.spawnScouts(b);
  }
  spawnTank(b) {
    const route = [0, 1, 2, 3].map(() => this.landPoint(b.x, b.z, 160));
    const [x, z] = route[0];
    b.tank = this.add('tank', { base: b.id, route, wp: 1, p: [x, WG.height(x, z) + 1.5, z] }).id;
  }
  spawnScouts(b) {
    const other = WG.BASES[(b.id + 1 + Math.floor(this.rand() * (WG.BASES.length - 1))) % WG.BASES.length];
    const route = [[b.x, b.z], [(b.x + other.x) / 2 + (this.rand() - 0.5) * 300, (b.z + other.z) / 2 + (this.rand() - 0.5) * 300], [other.x, other.z]];
    b.scouts = [0, 1].map((i) => this.add('scout', { base: b.id, route, wp: 1, p: [b.x + i * 12, WG.height(b.x, b.z) + 40, b.z], orbit: this.rand() * 6.28, dir: i ? 1 : -1 }).id);
  }

  // ---------- simulation ----------
  pilotsNear(p, r) {
    const out = [];
    for (const pl of this.w.players.values()) if (pl.al && Math.abs(pl.p[0] - p[0]) < r && Math.abs(pl.p[2] - p[2]) < r) out.push(pl);
    return out;
  }
  nearestTarget(n, range) {
    let best = null, bd = range;
    for (const pl of this.pilotsNear(n.p, range)) {
      const d = Math.hypot(pl.p[0] - n.p[0], pl.p[1] - n.p[1], pl.p[2] - n.p[2]);
      if (d < bd && pl.shieldUntil <= Date.now()) { bd = d; best = pl; }
    }
    return best;
  }
  fire(n, speed, dmg, spread, size, lead = 0.7) {
    const t = n.target, from = [n.p[0], n.p[1] + (n.k === 'scout' ? -0.3 : 1), n.p[2]];
    const d = Math.hypot(t.p[0] - from[0], t.p[1] - from[1], t.p[2] - from[2]), tt = d / speed;
    const aim = [0, 1, 2].map((i) => t.p[i] + t.v[i] * tt * lead + (this.rand() - 0.5) * 2 * spread * (i === 1 ? 0.5 : 1) - from[i]);
    const len = Math.hypot(...aim) || 1, v = aim.map((x) => (x / len) * speed);
    this.bolts.push({ p: from, v, dmg, life: 4, size, src: n.k === 'aa' ? 'AA fire' : `a ${n.k}` });
    this.pending.push({ t: 'shot', o: from.map((x) => Math.round(x * 100) / 100), v: v.map((x) => Math.round(x * 100) / 100), s: size });
  }
  move(n, tx, ty, tz, speed, dt, k = 2) {
    const dx = tx - n.p[0], dy = ty - n.p[1], dz = tz - n.p[2], d = Math.hypot(dx, dy, dz) || 1;
    const want = [dx / d * speed * Math.min(1, d / 10), dy / d * speed * Math.min(1, d / 10), dz / d * speed * Math.min(1, d / 10)];
    const a = 1 - Math.exp(-k * dt);
    for (let i = 0; i < 3; i++) { n.v[i] += (want[i] - n.v[i]) * a; n.p[i] += n.v[i] * dt; }
  }

  thinkScout(n, dt) {
    if (n.target && (!n.target.al || Math.hypot(n.target.p[0] - n.p[0], n.target.p[2] - n.p[2]) > 350)) n.target = null;
    if (!n.target) n.target = this.nearestTarget(n, 220);
    if (n.target) {
      const t = n.target;
      n.orbit += n.dir * dt * 0.55;
      this.move(n, t.p[0] + Math.cos(n.orbit) * 30, t.p[1] + 7, t.p[2] + Math.sin(n.orbit) * 30, 16, dt);
      n.cool -= dt;
      if (n.cool <= 0 && t.shieldUntil <= Date.now()) { this.fire(n, 36, 6, 1.5, 1); n.cool = 1.8 + this.rand() * 1.2; }
      n.y = yawTo(n.p, t.p);
    } else {
      const [wx, wz] = n.route[n.wp];
      if (Math.hypot(wx - n.p[0], wz - n.p[2]) < 25) n.wp = (n.wp + 1) % n.route.length;
      this.move(n, wx, WG.height(wx, wz) + 40, wz, 13, dt, 1);
      if (Math.hypot(n.v[0], n.v[2]) > 1) n.y = Math.atan2(-n.v[0], -n.v[2]);
    }
    const floor = Math.max(WG.height(n.p[0], n.p[2]), WG.height(n.p[0] + n.v[0] * 2, n.p[2] + n.v[2] * 2), WG.WATER) + 10;
    if (n.p[1] < floor) { n.p[1] += (floor - n.p[1]) * Math.min(1, 5 * dt); n.v[1] = Math.max(0, n.v[1]); }
  }

  thinkTank(n, dt) {
    if (n.target && (!n.target.al || Math.hypot(n.target.p[0] - n.p[0], n.target.p[2] - n.p[2]) > 220)) n.target = null;
    if (!n.target) n.target = this.nearestTarget(n, 170);
    let tx, tz, speed = 4.2;
    if (n.target) {   // close to 45-80 m and circle
      const t = n.target, dx = t.p[0] - n.p[0], dz = t.p[2] - n.p[2], d = Math.hypot(dx, dz) || 1;
      if (d > 80) { tx = t.p[0]; tz = t.p[2]; }
      else if (d < 45) { tx = n.p[0] - dx / d * 30; tz = n.p[2] - dz / d * 30; }
      else { tx = n.p[0] - dz / d * 20; tz = n.p[2] + dx / d * 20; speed = 2.5; }
    } else {
      [tx, tz] = n.route[n.wp];
      if (Math.hypot(tx - n.p[0], tz - n.p[2]) < 6) n.wp = (n.wp + 1) % n.route.length;
      speed = 3;
    }
    const want = Math.atan2(-(tx - n.p[0]), -(tz - n.p[2]));
    n.y += clamp(wrap(want - n.y), -1.1 * dt, 1.1 * dt);
    const nx = n.p[0] - Math.sin(n.y) * speed * dt, nz = n.p[2] - Math.cos(n.y) * speed * dt;
    if (WG.height(nx, nz) > WG.WATER + 0.5) { n.p[0] = nx; n.p[2] = nz; n.v = [-Math.sin(n.y) * speed, 0, -Math.cos(n.y) * speed]; }
    else { n.y += 1.5 * dt; n.v = [0, 0, 0]; }   // turn away from water
    n.p[1] = WG.height(n.p[0], n.p[2]) + 1.5;
    this.aim(n, dt, 1.2, 0.9);
    n.cool -= dt;
    const t = n.target;
    if (t && n.cool <= 0 && Math.abs(wrap(yawTo(n.p, t.p) - n.ty)) < 0.12 && n.ge < 0.88 && Math.hypot(t.p[0] - n.p[0], t.p[2] - n.p[2]) < 115) {
      this.fire(n, 46, 14, 1, 1.8, 0.85); n.cool = 2.8 + this.rand();
    }
  }

  thinkAA(n, dt) {
    if (n.target && (!n.target.al || Math.hypot(n.target.p[0] - n.p[0], n.target.p[2] - n.p[2]) > 160)) n.target = null;
    if (!n.target) n.target = this.nearestTarget(n, 140);
    if (!n.target) { n.ty += dt * 0.4; return; }
    this.aim(n, dt, 3, 1.4);
    n.cool -= dt;
    if (n.cool <= 0) { n.burst = 4; n.burstT = 0; n.cool = 2.2 + this.rand() * 0.8; }
    if (n.burst > 0) { n.burstT -= dt; if (n.burstT <= 0 && n.target.shieldUntil <= Date.now()) { this.fire(n, 64, 4, 2.2, 0.8, 0.9); n.burst--; n.burstT = 0.11; } }
  }

  aim(n, dt, rate, maxElev) {   // turret yaw and gun elevation follow the target
    const t = n.target;
    if (!t) return;
    n.ty += clamp(wrap(yawTo(n.p, t.p) - n.ty), -rate * dt, rate * dt);
    const elev = Math.atan2(t.p[1] - n.p[1], Math.hypot(t.p[0] - n.p[0], t.p[2] - n.p[2]));
    n.ge += (clamp(elev, -0.08, maxElev) - n.ge) * Math.min(1, 3 * dt);
  }

  // scenery collision for enemy shots, cached per chunk
  obstaclesAt(x, z) {
    const ci = Math.floor(x / WG.CHUNK), cj = Math.floor(z / WG.CHUNK), k = ci * 1000 + cj;
    let obs = this.obsCache.get(k);
    if (!obs) { obs = WG.chunkObstacles(ci, cj); this.obsCache.set(k, obs); }
    return obs;
  }

  stepBolts(dt) {
    const now = Date.now();
    this.bolts = this.bolts.filter((b) => {
      const a = b.p, p = [a[0] + b.v[0] * dt, a[1] + b.v[1] * dt, a[2] + b.v[2] * dt];
      b.p = p; b.life -= dt;
      if (b.life <= 0 || p[1] < Math.max(WG.height(p[0], p[2]), WG.WATER)) return false;
      for (const o of this.obstaclesAt(p[0], p[2])) {   // the whole step, not just its end: a shot covers ~4 m per tick
        const sx = p[0] - a[0], sz = p[2] - a[2], l2 = sx * sx + sz * sz || 1e-6;
        const k = clamp(((o.x - a[0]) * sx + (o.z - a[2]) * sz) / l2, 0, 1);
        const cx = a[0] + sx * k - o.x, cz = a[2] + sz * k - o.z, y = a[1] + (p[1] - a[1]) * k;
        if (cx * cx + cz * cz < o.r * o.r * 0.7 && y < o.top && y > o.base + 0.5) return false;
      }
      for (const pl of this.w.players.values()) {
        if (!pl.al || pl.shieldUntil > now) continue;
        if (segDist2(a, p, pl.p) < 1.3 * 1.3) { this.w.damage(pl, b.dmg, null, false, b.src); return false; }
      }
      return true;
    });
  }

  tick(dt) {
    for (const n of this.list.values()) {
      if (!this.pilotsNear(n.p, ACTIVE_RANGE).length) { n.target = null; continue; }   // asleep: nobody to see it
      if (n.k === 'scout') this.thinkScout(n, dt);
      else if (n.k === 'tank') this.thinkTank(n, dt);
      else this.thinkAA(n, dt);
    }
    this.stepBolts(dt);
    this.tickBases(dt);
    for (const m of this.pending) {   // shots go to pilots who can see them
      for (const pl of this.pilotsNear(m.o, this.w.R.viewRange)) pl.send(m);
    }
    this.pending.length = 0;
  }

  tickBases(dt) {
    const now = Date.now();
    for (const b of this.bases) {
      if (b.owner === 'p') {
        if (now >= b.ownedUntil) {
          b.owner = 'h'; b.prog = 0; this.garrison(b);
          this.w.broadcast({ t: 'event', text: `Hostile forces retook ${b.name}`, kind: 'warn' });
        }
        continue;
      }
      if (b.defenders.some((id) => this.list.has(id))) { b.prog = Math.max(0, b.prog - dt / 60); continue; }
      const inside = this.pilotsNear([b.x, 0, b.z], WG.BASE_RADIUS)
        .filter((pl) => Math.hypot(pl.p[0] - b.x, pl.p[2] - b.z) < WG.BASE_RADIUS && pl.p[1] < b.y + BASE_RULES.captureAgl);
      if (inside.length) b.prog = Math.min(1, b.prog + dt / BASE_RULES.captureSec * Math.sqrt(Math.min(inside.length, 4)));
      else b.prog = Math.max(0, b.prog - dt / 60);
      if (b.prog >= 1) {
        b.owner = 'p'; b.ownedUntil = now + BASE_RULES.holdMs;
        const by = inside[0]?.name || 'Pilots';
        for (const pl of this.pilotsNear([b.x, 0, b.z], BASE_RULES.rewardRange)) {
          pl.account.credits += BASE_RULES.rewardCredits; pl.account.xp += BASE_RULES.rewardXp;
          this.w.store.markDirty(pl.account);
          pl.send({ t: 'profile', profile: this.w.profileOf(pl) });
        }
        this.w.broadcast({ t: 'event', text: `${by} captured ${b.name}`, kind: 'ok' });
      }
    }
  }

  // ---------- pilots shooting enemies ----------
  damage(n, amount, by) {
    n.h -= amount;
    if (n.h > 0) return;
    this.list.delete(n.id);
    const spec = NPC[n.k];
    if (by) {
      by.account.credits += spec.credits; by.account.xp += spec.xp; this.w.store.markDirty(by.account);
      by.send({ t: 'profile', profile: this.w.profileOf(by) });
    }
    for (const pl of this.pilotsNear(n.p, this.w.R.viewRange)) pl.send({ t: 'ndown', id: n.id, k: n.k, by: by?.id ?? null, cr: by === pl ? spec.credits : 0 });
    const b = this.bases[n.base];
    if (n.k === 'aa' && b && !b.defenders.some((id) => this.list.has(id))) this.w.broadcast({ t: 'event', text: `Defences down at ${b.name}: hold the ring to capture it`, kind: 'ok' });
    if (spec.respawnMs && b) setTimeout(() => { if (n.k === 'tank') this.spawnTank(b); else if (!b.scouts.some((id) => this.list.has(id))) this.spawnScouts(b); }, spec.respawnMs).unref?.();
  }

  view(p, range) {
    const out = [];
    for (const n of this.list.values()) {
      if (Math.abs(n.p[0] - p[0]) > range || Math.abs(n.p[2] - p[2]) > range) continue;
      out.push({ id: n.id, k: n.k, p: n.p.map((x) => Math.round(x * 100) / 100), v: n.v.map((x) => Math.round(x * 10) / 10),
        y: Math.round(n.y * 1000) / 1000, ty: Math.round(n.ty * 1000) / 1000, ge: Math.round(n.ge * 1000) / 1000, h: Math.round(n.h), mh: NPC[n.k].hp });
    }
    return out;
  }
  basesView() {
    const now = Date.now();
    return this.bases.map((b) => ({ id: b.id, o: b.owner, pr: Math.round(b.prog * 100) / 100,
      aa: b.defenders.filter((id) => this.list.has(id)).length, left: b.owner === 'p' ? Math.max(0, Math.round((b.ownedUntil - now) / 1000)) : 0 }));
  }
  ownedPadAt(x, z) {
    for (const b of this.bases) if (b.owner === 'p' && Math.hypot(x - (b.x + WG.BASE_PAD[0]), z - (b.z + WG.BASE_PAD[1])) < 5) return b;
    return null;
  }
}
