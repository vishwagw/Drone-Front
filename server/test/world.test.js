import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, RULES } from '../world.js';
import * as WG from '../worldgen.js';

const client = () => { const inbox = []; return { inbox, send: (m) => inbox.push(m), last: (t) => inbox.filter((m) => m.t === t).at(-1) }; };
const account = (callsign) => ({ id: Math.random(), callsign, xp: 0, credits: 0, kills: 0, deaths: 0, owned: 1 });
const store = () => ({ dirty: new Set(), markDirty(a) { this.dirty.add(a); } });

function duel() {
  const s = store(), w = new World('Test', s);
  const A = client(), B = client();
  const a = w.join(A.send, account('Alpha'), 1), b = w.join(B.send, account('Bravo'), 2);
  a.shieldUntil = b.shieldUntil = 0; a.graceUntil = b.graceUntil = 0;
  a.p = [0, 30, 0]; b.p = [0, 30, -50];
  a.lastFire = Date.now();
  return { w, s, A, B, a, b };
}

test('join hands out an id, a profile and a spawn point', () => {
  const { A } = duel();
  const wel = A.last('welcome');
  assert.ok(wel.id && Number.isFinite(wel.spawn.x));
  assert.equal(wel.profile.name, 'Alpha');
});

test('gun hits are capped by fire rate and kill after enough damage', () => {
  const { w, s, B, a, b } = duel();
  assert.equal(w.onHit(a, { target: b.id, w: 'gun', n: 50 }), true);
  assert.equal(b.h, 100 - RULES.gunBurst * RULES.gunDamage);
  assert.equal(w.onHit(a, { target: b.id, w: 'gun', n: 5 }), false);
  for (let i = 0; i < 2; i++) { a.gunAt -= 3000; a.lastFire = Date.now(); w.onHit(a, { target: b.id, w: 'gun', n: 14 }); }
  assert.equal(b.al, false);
  assert.equal(B.last('kill').k, a.id);
  assert.equal(a.account.kills, 1); assert.equal(a.account.credits, RULES.killCredit); assert.equal(b.account.deaths, 1);
  assert.ok(s.dirty.has(a.account) && s.dirty.has(b.account));
});

test('hits are refused out of range, without firing, on shielded or dead targets', () => {
  const { w, a, b } = duel();
  b.p = [0, 30, -500];
  assert.equal(w.onHit(a, { target: b.id, w: 'gun', n: 1 }), false);
  b.p = [0, 30, -50]; a.lastFire = 0;
  assert.equal(w.onHit(a, { target: b.id, w: 'gun', n: 1 }), false);
  a.lastFire = Date.now(); b.shieldUntil = Date.now() + 1000;
  assert.equal(w.onHit(a, { target: b.id, w: 'gun', n: 1 }), false);
  b.shieldUntil = 0; b.al = false;
  assert.equal(w.onHit(a, { target: b.id, w: 'gun', n: 1 }), false);
  assert.equal(w.onHit(a, { target: a.id, w: 'gun', n: 1 }), false);
});

test('rocket hits need a launched rocket and ammo', () => {
  const { w, a, b } = duel();
  assert.equal(w.onHit(a, { target: b.id, w: 'rocket' }), false);
  w.onState(a, { p: a.p, v: [0, 0, 0], y: 0, a: 0, f: 0, rs: 1 });
  assert.equal(w.onHit(a, { target: b.id, w: 'rocket' }), true);
  assert.equal(w.onHit(a, { target: b.id, w: 'rocket' }), false);
  w.onState(a, { p: a.p, v: [0, 0, 0], y: 0, a: 0, f: 0, rs: 50 });
  assert.equal(a.ammo, 0);
  assert.equal(a.rocketCredits.length, RULES.rocketAmmo - 1);
});

test('teleports are corrected, normal flight is accepted', () => {
  const { w, A, a } = duel();
  a.lastMove = Date.now() - 1000;
  w.onState(a, { p: [10, 30, 0], v: [10, 0, 0], y: 0, a: 0 });
  assert.deepEqual(a.p, [10, 30, 0]);
  a.lastMove = Date.now();
  w.onState(a, { p: [150, 30, 0], v: [0, 0, 0], y: 0, a: 0 });
  assert.deepEqual(a.p, [10, 30, 0]);
  assert.ok(A.last('correct'));
});

test('crash damage after being shot credits the shooter', () => {
  const { w, B, a, b } = duel();
  w.onHit(a, { target: b.id, w: 'gun', n: 2 });
  w.onSelfDamage(b, { n: 999 });
  assert.equal(b.h, 100 - 2 * RULES.gunDamage - RULES.selfDamageMax);
  w.onSelfDamage(b, { n: 999 });
  assert.equal(B.last('kill').k, a.id);
});

test('pilots spawn beside an outpost, above the ground', () => {
  const w = new World('Test', store());
  for (let i = 0; i < 20; i++) {
    const [x, y, z] = w.spawnPoint();
    const { dist } = WG.nearestOutpost(x, z);
    assert.ok(dist >= 29 && dist <= 61, `spawn ${dist.toFixed(1)} m from an outpost`);
    assert.ok(y > WG.height(x, z) + 25);
  }
});

test('a new pilot spawns within reach of pilots already flying', () => {
  const w = new World('Test', store());
  const A = client(), a = w.join(A.send, account('Alpha'), 1);
  for (let i = 0; i < 20; i++) {
    const [x, , z] = w.spawnPoint();
    assert.ok(Math.hypot(x - a.p[0], z - a.p[2]) < RULES.viewRange, 'spawned within view range of the other pilot');
  }
});

test('landing on any outpost pad repairs the hull', () => {
  const { w, b } = duel();
  const o = WG.OUTPOSTS[5];
  b.h = 40; b.p = [o.x + 1, o.y + 0.5, o.z];
  for (let i = 0; i < 15; i++) w.tick();
  assert.ok(b.h > 50);
  b.h = 40; b.p = [o.x + 1, o.y + 40, o.z];   // hovering high over it does not count
  w.tick();
  assert.equal(b.h, 40);
});

test('snapshots only carry pilots within view range', () => {
  const { w, A, a, b } = duel();
  b.p = [a.p[0] + RULES.viewRange + 100, 30, a.p[2]];
  w.tick();
  assert.equal(A.last('snap').pl.length, 0);
  b.p = [a.p[0] + 300, 30, a.p[2]];
  w.tick();
  assert.equal(A.last('snap').pl.length, 1);
});

test('the generator is deterministic and keeps outposts on dry, flat ground', () => {
  assert.equal(WG.OUTPOSTS.length, 16);
  for (const o of WG.OUTPOSTS) {
    assert.ok(o.y > WG.WATER + 2);
    assert.ok(Math.abs(WG.height(o.x + 8, o.z) - o.y) < 0.5, `${o.name} pad is flat`);
  }
  assert.deepEqual(WG.chunkItems(2, -3), WG.chunkItems(2, -3));
});

test('dead pilots respawn with full hull after the timer', () => {
  const { w, B, b } = duel();
  w.kill(b, null);
  b.respawnAt = Date.now() - 1;
  w.tick();
  assert.equal(b.al, true); assert.equal(b.h, 100);
  assert.ok(B.last('spawn'));
  assert.equal(B.last('snap').pl.length, 1);
});
