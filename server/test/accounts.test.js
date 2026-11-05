import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Server } from '../server.js';
import { Store } from '../store.js';

let server, base, store;
before(async () => {
  store = new Store(':memory:');
  server = new Server({ store });
  base = `http://localhost:${await server.start(0)}`;
});
after(() => server.stop());

const call = async (path, { body, token } = {}) => {
  const res = await fetch(base + path, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};
const ws = (session) => new Promise((resolve) => {
  const s = new WebSocket(`${base.replace('http', 'ws')}/ws`), inbox = [];
  s.on('message', (d) => inbox.push(JSON.parse(String(d))));
  s.on('open', () => { s.send(JSON.stringify({ t: 'hello', session, color: 2 })); setTimeout(() => resolve({ s, inbox }), 300); });
});

let token;

test('sign up validates input and starts a session', async () => {
  assert.equal((await call('/api/signup', { body: { email: 'bad', password: 'longenough', callsign: 'Ace' } })).status, 400);
  assert.equal((await call('/api/signup', { body: { email: 'ace@example.com', password: 'short', callsign: 'Ace' } })).status, 400);
  assert.equal((await call('/api/signup', { body: { email: 'ace@example.com', password: 'longenough', callsign: 'A' } })).status, 400);
  const r = await call('/api/signup', { body: { email: 'Ace@Example.com ', password: 'correct horse', callsign: 'Ace' } });
  assert.equal(r.status, 200);
  assert.match(r.json.token, /^[0-9a-f]{64}$/);
  assert.equal(r.json.account.email, 'ace@example.com');
  assert.equal(r.json.account.name, 'Ace');
  token = r.json.token;
  assert.equal((await call('/api/signup', { body: { email: 'ace@example.com', password: 'another one', callsign: 'Ace2' } })).status, 409);
});

test('passwords are stored hashed and sign in checks them', async () => {
  assert.doesNotMatch(store.accountByEmail('ace@example.com').pass, /correct horse/);
  assert.equal((await call('/api/login', { body: { email: 'ace@example.com', password: 'wrong pass' } })).status, 401);
  const r = await call('/api/login', { body: { email: 'ACE@example.com', password: 'correct horse' } });
  assert.equal(r.status, 200);
  assert.equal((await call('/api/me', { token: r.json.token })).json.account.name, 'Ace');
});

test('the game is free: any signed-in pilot can enter the online world', async () => {
  const c = await ws(token);
  assert.equal(c.inbox[0].t, 'welcome');
  assert.equal(c.inbox[0].profile.name, 'Ace');
  c.s.close();
});

test('pilots who are not signed in are turned away from the online world', async () => {
  const anon = await ws('0'.repeat(64));
  assert.equal(anon.inbox[0].t, 'denied');
  assert.equal(anon.inbox[0].code, 'auth');
});

test('signing in again from another window replaces the older session', async () => {
  const first = await ws(token), second = await ws(token);
  assert.ok(first.inbox.some((m) => m.t === 'kicked'));
  assert.equal(second.inbox[0].t, 'welcome');
  assert.equal(server.playerCount, 1);
  second.s.close();
});

test('there are no purchase routes', async () => {
  assert.equal((await call('/api/checkout', { body: {}, token })).status, 404);
  assert.equal((await call('/api/stripe/webhook', { body: {} })).status, 404);
  assert.equal((await call('/api/me', { token })).json.account.owned, undefined);
});

test('signing out ends the session', async () => {
  assert.equal((await call('/api/logout', { body: {}, token })).status, 200);
  assert.equal((await call('/api/me', { token })).status, 401);
});

test('sign in is rate limited', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await call('/api/login', { body: { email: 'nobody@example.com', password: 'whatever1' } });
  assert.equal(last.status, 429);
});

test('the server serves the game page, its info and the map generator', async () => {
  const info = (await call('/api/info')).json;
  assert.equal(info.game, 'drone-front');
  assert.equal(info.price, undefined);
  const page = await (await fetch(base + '/')).text();
  assert.match(page, /<title>Drone Front<\/title>/);
  const gen = await fetch(base + '/worldgen.js');
  assert.match(gen.headers.get('content-type'), /javascript/);
  assert.match(await gen.text(), /export function height/);
});
