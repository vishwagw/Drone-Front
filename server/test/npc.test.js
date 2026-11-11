import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, RULES } from '../world.js';
import { NPC, BASE_RULES } from '../npc.js';
import * as WG from '../worldgen.js';

const client = () => { const inbox = []; return { inbox, send: (m) => inbox.push(m), all: (t) => inbox.filter((m) => m.t === t), last: (t) => inbox.filter((m) => m.t === t).at(-1) }; };
const account = (callsign) => ({ id: Math.random(), callsign, xp: 0, credits: 0, kills: 0, deaths: 0 });
const store = () => ({ markDirty() {} });
const dt = 1 / RULES.snapshotHz;

function pilotAt(w, x, y, z, name = 'Alpha') {
  const C = client(), pl = w.join(C.send, account(name), 1);
  pl.p = [x, y, z]; pl.shieldUntil = 0; pl.graceUntil = 0; pl.lastFire = Date.now();
  return { C, pl };
}
const enemies = (w, k, base) => [...w.npcs.list.values()].filter((n) => n.k === k && (base === undefined || n.base === base));

test('every base starts hostile with AA guns, a tank and two scouts', () => {
  const w = new World('Test', store());
  assert.equal(w.npcs.bases.length, WG.BASES.length);
  for (const b of w.npcs.bases) {
    assert.equal(b.owner, 'h');
    assert.equal(enemies(w, 'aa', b.id).length, WG.BASE_AA.length);
    assert.equal(enemies(w, 'tank', b.id).length, 1);
    assert.equal(enemies(w, 'scout', b.id).length, 2);
  }
});

test('enemies sleep while no pilot is anywhere near', () => {
  const w = new World('Test', store());
  const tank = enemies(w, 'tank')[0], before = [...tank.p];
  for (let i = 0; i < 30; i++) w.npcs.tick(dt);
  assert.deepEqual(tank.p, before);
});

test('AA guns shoot pilots inside their range and the server applies the damage', () => {
  const w = new World('Test', store());
  const b = w.npcs.bases[1];
  const { C, pl } = pilotAt(w, b.x, b.y + 40, b.z + 60);
  for (let i = 0; i < RULES.snapshotHz * 6 && pl.h === 100; i++) { w.npcs.tick(dt); pl.p = [b.x, b.y + 40, b.z + 60]; pl.shieldUntil = 0; }
  assert.ok(pl.h < 100, 'pilot took damage');
  assert.ok(C.all('shot').length > 0, 'the pilot was sent the shots to draw');
  assert.ok(C.all('dmg').length > 0);
});

test('enemy shots stop at terrain and scenery', () => {
  const w = new World('Test', store());
  let tree = null;
  for (let i = -5; i < 5 && !tree; i++) for (let j = -5; j < 5 && !tree; j++) tree = WG.chunkObstacles(i, j).find((o) => o.r > 2);
  const y = tree.base + 2;
  w.npcs.bolts.push({ p: [tree.x - 6, y, tree.z], v: [60, 0, 0], dmg: 6, life: 2, src: 'a scout' });
  for (let i = 0; i < 4; i++) w.npcs.stepBolts(dt);
  assert.equal(w.npcs.bolts.length, 0, 'the shot hit the tree');
  w.npcs.bolts.push({ p: [0, WG.height(0, 0) + 1, 0], v: [0, -40, 0], dmg: 6, life: 2, src: 'a scout' });
  w.npcs.stepBolts(dt);
  assert.equal(w.npcs.bolts.length, 0, 'the shot hit the ground');
});

test('pilots destroy enemies with validated hits and earn credits', () => {
  const w = new World('Test', store());
  const tank = enemies(w, 'tank')[0];
  const { C, pl } = pilotAt(w, tank.p[0], tank.p[1] + 30, tank.p[2] + 40);
  pl.p = [tank.p[0] + 500, tank.p[1] + 30, tank.p[2]];
  assert.equal(w.onHit(pl, { target: tank.id, w: 'gun', n: 5 }), false, 'out of range');
  pl.p = [tank.p[0], tank.p[1] + 30, tank.p[2] + 40];
  assert.equal(w.onHit(pl, { target: tank.id, w: 'rocket' }), false, 'no rocket launched');
  w.onState(pl, { p: pl.p, v: [0, 0, 0], y: 0, a: 0, f: 1, rs: 3 });
  for (let i = 0; i < 3; i++) assert.equal(w.onHit(pl, { target: tank.id, w: 'rocket' }), true);
  assert.equal(w.npcs.list.has(tank.id), false);
  assert.equal(pl.account.credits, NPC.tank.credits);
  assert.equal(C.last('ndown').id, tank.id);
  assert.equal(C.last('ndown').cr, NPC.tank.credits);
});

test('a base is captured only after its AA is down, then pays out, repairs and is retaken later', () => {
  const w = new World('Test', store());
  const b = w.npcs.bases[2];
  const { C, pl } = pilotAt(w, b.x, b.y + 10, b.z);
  const hold = () => { pl.p = [b.x, b.y + 10, b.z]; pl.shieldUntil = Date.now() + 60_000; pl.h = 100; };
  hold();
  for (let i = 0; i < RULES.snapshotHz * 20; i++) { w.npcs.tickBases(dt); hold(); }
  assert.equal(b.owner, 'h', 'defended bases cannot be captured');
  for (const n of enemies(w, 'aa', b.id)) w.npcs.damage(n, 1e6, pl);
  assert.ok(C.all('event').some((e) => /Defences down/.test(e.text)));
  for (let i = 0; i < RULES.snapshotHz * (BASE_RULES.captureSec + 1) && b.owner === 'h'; i++) { w.npcs.tickBases(dt); hold(); }
  assert.equal(b.owner, 'p');
  assert.ok(C.all('event').some((e) => e.text.includes(`captured ${b.name}`)));
  assert.equal(pl.account.credits, NPC.aa.credits * WG.BASE_AA.length + BASE_RULES.rewardCredits);
  // its pad repairs once held
  pl.p = [b.x + WG.BASE_PAD[0], b.y + 0.5, b.z + WG.BASE_PAD[1]]; pl.h = 40; pl.shieldUntil = 0;
  for (let i = 0; i < 15; i++) w.tick();
  assert.ok(pl.h > 50);
  // hostile forces come back when the hold time runs out
  b.ownedUntil = Date.now() - 1;
  w.npcs.tickBases(dt);
  assert.equal(b.owner, 'h');
  assert.equal(enemies(w, 'aa', b.id).length, WG.BASE_AA.length);
});

test('dying to enemy fire names the enemy, and snapshots carry nearby enemies and bases', () => {
  const w = new World('Test', store());
  const b = w.npcs.bases[3];
  const { C, pl } = pilotAt(w, b.x + 30, b.y + 20, b.z);
  w.damage(pl, 200, null, false, 'a tank');
  assert.equal(C.last('kill').src, 'a tank');
  w.tick(); w.board();
  assert.ok(C.last('snap').npc.length >= WG.BASE_AA.length);
  assert.equal(C.last('bases').list.length, WG.BASES.length);
});
