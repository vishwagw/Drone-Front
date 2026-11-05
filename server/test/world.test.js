import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { World, ProfileStore, Server, RULES } from '../server.js';

const tmpStore = () => new ProfileStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'df-')), 'profiles.json'));
const client = () => { const inbox = []; return { inbox, send: (m) => inbox.push(m), last: (t) => inbox.filter((m) => m.t === t).at(-1) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function duel() {
  const w = new World('Test', tmpStore());
  const A = client(), B = client();
  const a = w.join(A.send, null, 'Alpha', 1), b = w.join(B.send, null, 'Bravo', 2);
  a.shieldUntil = b.shieldUntil = 0; a.graceUntil = b.graceUntil = 0;
  a.p = [0, 30, 0]; b.p = [0, 30, -50];
  a.lastFire = Date.now();
  return { w, A, B, a, b };
}

test('join hands out a token, an id and a spawn point', () => {
  const { A } = duel();
  const wel = A.last('welcome');
  assert.match(wel.token, /^[0-9a-f]{32}$/);
  assert.ok(wel.id && Number.isFinite(wel.spawn.x));
});

test('a returning token keeps its saved profile', () => {
  const store = tmpStore(), w = new World('Test', store), A = client();
  const a = w.join(A.send, null, 'Alpha', 1);
  a.profile.credits = 70;
  const B = client(), again = w.join(B.send, A.last('welcome').token, 'Alpha2', 1);
  assert.equal(again.profile.credits, 70);
  assert.equal(again.profile.name, 'Alpha2');
});

test('gun hits are capped by fire rate and kill after enough damage', () => {
  const { w, B, a, b } = duel();
  assert.equal(w.onHit(a, { target: b.id, w: 'gun', n: 50 }), true);   // only a burst's worth lands
  assert.equal(b.h, 100 - RULES.gunBurst * RULES.gunDamage);
  assert.equal(w.onHit(a, { target: b.id, w: 'gun', n: 5 }), false);   // budget spent
  for (let i = 0; i < 2; i++) { a.gunAt -= 3000; a.lastFire = Date.now(); w.onHit(a, { target: b.id, w: 'gun', n: 14 }); }
  assert.equal(b.al, false);
  const kill = B.last('kill');
  assert.equal(kill.k, a.id); assert.equal(kill.v, b.id);
  assert.equal(a.profile.kills, 1); assert.equal(a.profile.credits, RULES.killCredit); assert.equal(b.profile.deaths, 1);
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
  assert.equal(w.onHit(a, { target: b.id, w: 'rocket' }), false);   // one hit per rocket
  w.onState(a, { p: a.p, v: [0, 0, 0], y: 0, a: 0, f: 0, rs: 50 });   // claims 49 more, only ammo counts
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

test('dead pilots respawn with full hull after the timer', () => {
  const { w, B, b } = duel();
  w.kill(b, null);
  b.respawnAt = Date.now() - 1;
  w.tick();
  assert.equal(b.al, true); assert.equal(b.h, 100);
  assert.ok(B.last('spawn'));
  assert.ok(B.last('snap').pl.length === 1);
});

test('profiles survive a save and reload', () => {
  const store = tmpStore(), token = store.create('Alpha');
  store.get(token).xp = 900; store.touch(); store.save();
  assert.equal(new ProfileStore(store.file).get(token).xp, 900);
});

test('signing in again with the same token replaces the older session', () => {
  const server = new Server(tmpStore());
  const out1 = [], out2 = [], closed = [];
  const c1 = server.connect((s) => out1.push(JSON.parse(s)), (code) => closed.push(code));
  c1.message(JSON.stringify({ t: 'hello', name: 'Alpha' }));
  const token = out1[0].token;
  const c2 = server.connect((s) => out2.push(JSON.parse(s)), () => {});
  c2.message(JSON.stringify({ t: 'hello', token, name: 'Alpha' }));
  assert.equal(out1.at(-1).t, 'kicked');
  assert.deepEqual(closed, [4000]);
  assert.equal(server.playerCount, 1);
  c1.close();   // the old socket closing later must not end the new session
  assert.equal(server.sessions.size, 1);
  assert.equal(out2[0].token, token);
});

test('two real WebSocket clients see each other and the server serves the game', async () => {
  const server = new Server(tmpStore());
  const port = await server.start(0);
  try {
    const info = await (await fetch(`http://localhost:${port}/api/info`)).json();
    assert.equal(info.game, 'drone-front');
    const page = await (await fetch(`http://localhost:${port}/`)).text();
    assert.match(page, /<title>Drone Front<\/title>/);
    const open = (name) => new Promise((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws`), inbox = [];
      ws.on('message', (d) => inbox.push(JSON.parse(String(d))));
      ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', name })); resolve({ ws, inbox }); });
    });
    const A = await open('Alpha'), B = await open('Bravo');
    await sleep(400);
    const snap = A.inbox.filter((m) => m.t === 'snap').at(-1);
    assert.equal(snap.pl.length, 1);
    assert.equal(snap.pl[0].n, 'Bravo');
    const board = A.inbox.filter((m) => m.t === 'board').at(-1) || (await sleep(800), A.inbox.filter((m) => m.t === 'board').at(-1));
    assert.equal(board.list.length, 2);
    A.ws.close(); B.ws.close();
  } finally { await server.stop(); }
});
