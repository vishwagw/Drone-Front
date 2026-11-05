import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { Server } from '../server.js';
import { Store } from '../store.js';
import { Payments } from '../payments.js';

// A stand-in for Stripe's checkout API: records requests and returns a fake hosted page URL.
const stripeCalls = [];
const fakeStripe = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    stripeCalls.push({ url: req.url, auth: req.headers.authorization, form: new URLSearchParams(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `cs_test_${stripeCalls.length}`, url: `https://checkout.stripe.test/pay/${stripeCalls.length}` }));
  });
});

let server, base, store, payments;
before(async () => {
  await new Promise((r) => fakeStripe.listen(0, r));
  payments = new Payments({ secretKey: 'sk_test_x', webhookSecret: 'whsec_test', publicUrl: 'https://game.example', apiBase: `http://localhost:${fakeStripe.address().port}` });
  store = new Store(':memory:');
  server = new Server({ store, payments });
  base = `http://localhost:${await server.start(0)}`;
});
after(async () => { await server.stop(); fakeStripe.close(); });

const call = async (path, { body, token, headers = {}, raw } = {}) => {
  const res = await fetch(base + path, {
    method: body !== undefined || raw !== undefined ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
};
const webhook = (event) => { const raw = JSON.stringify(event); return call('/api/stripe/webhook', { raw, headers: { 'stripe-signature': payments.sign(raw) } }); };
const ws = (session) => new Promise((resolve) => {
  const s = new WebSocket(`${base.replace('http', 'ws')}/ws`), inbox = [];
  s.on('message', (d) => inbox.push(JSON.parse(String(d))));
  s.on('open', () => { s.send(JSON.stringify({ t: 'hello', session, color: 2 })); setTimeout(() => resolve({ s, inbox }), 300); });
});

let token, accountId;

test('sign up validates input and starts a session', async () => {
  assert.equal((await call('/api/signup', { body: { email: 'bad', password: 'longenough', callsign: 'Ace' } })).status, 400);
  assert.equal((await call('/api/signup', { body: { email: 'ace@example.com', password: 'short', callsign: 'Ace' } })).status, 400);
  const r = await call('/api/signup', { body: { email: 'Ace@Example.com ', password: 'correct horse', callsign: 'Ace' } });
  assert.equal(r.status, 200);
  assert.match(r.json.token, /^[0-9a-f]{64}$/);
  assert.equal(r.json.account.email, 'ace@example.com');
  assert.equal(r.json.account.owned, false);
  token = r.json.token;
  accountId = store.accountByEmail('ace@example.com').id;
  assert.equal((await call('/api/signup', { body: { email: 'ace@example.com', password: 'another one', callsign: 'Ace2' } })).status, 409);
});

test('passwords are stored hashed and sign in checks them', async () => {
  assert.doesNotMatch(store.accountByEmail('ace@example.com').pass, /correct horse/);
  assert.equal((await call('/api/login', { body: { email: 'ace@example.com', password: 'wrong pass' } })).status, 401);
  const r = await call('/api/login', { body: { email: 'ACE@example.com', password: 'correct horse' } });
  assert.equal(r.status, 200);
  assert.equal((await call('/api/me', { token: r.json.token })).json.account.name, 'Ace');
});

test('an account that has not paid cannot enter the online world', async () => {
  const c = await ws(token);
  assert.equal(c.inbox[0].t, 'denied'); assert.equal(c.inbox[0].code, 'buy');
  const anon = await ws('0'.repeat(64));
  assert.equal(anon.inbox[0].code, 'auth');
});

test('checkout opens a Stripe session for this account at the set price', async () => {
  assert.equal((await call('/api/checkout', { body: {} })).status, 401);
  const r = await call('/api/checkout', { body: {}, token });
  assert.equal(r.status, 200);
  assert.match(r.json.url, /^https:\/\/checkout\.stripe\.test\//);
  const f = stripeCalls.at(-1).form;
  assert.equal(stripeCalls.at(-1).auth, 'Bearer sk_test_x');
  assert.equal(f.get('mode'), 'payment');
  assert.equal(f.get('line_items[0][price_data][unit_amount]'), '500');
  assert.equal(f.get('line_items[0][price_data][currency]'), 'usd');
  assert.equal(f.get('client_reference_id'), String(accountId));
  assert.equal(f.get('success_url'), 'https://game.example/?purchase=success');
});

test('webhooks with a bad signature are rejected', async () => {
  const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_evil', payment_status: 'paid', client_reference_id: String(accountId) } } });
  const r = await call('/api/stripe/webhook', { raw, headers: { 'stripe-signature': 't=1,v1=deadbeef' } });
  assert.equal(r.status, 400);
  assert.equal(store.account(accountId).owned, 0);
});

test('a paid checkout unlocks the full game and the online world', async () => {
  const ev = { type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', client_reference_id: String(accountId), payment_intent: 'pi_1', amount_total: 500, currency: 'usd' } } };
  assert.equal((await webhook(ev)).status, 200);
  assert.equal((await webhook(ev)).status, 200);   // Stripe retries: handled once
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM purchases').get().n, 1);
  assert.equal((await call('/api/me', { token })).json.account.owned, true);
  assert.equal((await call('/api/checkout', { body: {}, token })).status, 409);
  const c = await ws(token);
  assert.equal(c.inbox[0].t, 'welcome');
  assert.equal(c.inbox[0].profile.name, 'Ace');
  c.s.close();
});

test('a refund takes the game back and disconnects the pilot', async () => {
  const c = await ws(token);
  assert.equal(c.inbox[0].t, 'welcome');
  await webhook({ type: 'charge.refunded', data: { object: { refunded: true, payment_intent: 'pi_1' } } });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(c.inbox.some((m) => m.t === 'kicked'));
  assert.equal((await call('/api/me', { token })).json.account.owned, false);
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

test('the server serves the game page and its info', async () => {
  const info = (await call('/api/info')).json;
  assert.equal(info.game, 'drone-front'); assert.equal(info.price, '$5'); assert.equal(info.checkout, true);
  const page = await (await fetch(base + '/')).text();
  assert.match(page, /<title>Drone Front<\/title>/);
});
