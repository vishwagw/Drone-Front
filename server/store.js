// Accounts, sessions and purchases in SQLite (node:sqlite, no native dependencies).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const now = () => Date.now();

export class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        pass TEXT NOT NULL,
        callsign TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        xp INTEGER NOT NULL DEFAULT 0,
        credits INTEGER NOT NULL DEFAULT 0,
        kills INTEGER NOT NULL DEFAULT 0,
        deaths INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL,
        last INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY,
        account INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created INTEGER NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS purchases (
        id TEXT PRIMARY KEY,
        account INTEGER NOT NULL REFERENCES accounts(id),
        payment_intent TEXT,
        amount INTEGER NOT NULL,
        currency TEXT NOT NULL,
        refunded INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS purchases_pi ON purchases(payment_intent);
    `);
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      insertAccount: p('INSERT INTO accounts (email, pass, callsign, created, last) VALUES (?, ?, ?, ?, ?)'),
      byEmail: p('SELECT * FROM accounts WHERE email = ?'),
      byId: p('SELECT * FROM accounts WHERE id = ?'),
      insertSession: p('INSERT INTO sessions (hash, account, created, expires) VALUES (?, ?, ?, ?)'),
      sessionAccount: p('SELECT account FROM sessions WHERE hash = ? AND expires > ?'),
      deleteSession: p('DELETE FROM sessions WHERE hash = ?'),
      purgeSessions: p('DELETE FROM sessions WHERE expires <= ?'),
      setOwned: p('UPDATE accounts SET owned = ? WHERE id = ?'),
      insertPurchase: p('INSERT OR IGNORE INTO purchases (id, account, payment_intent, amount, currency, created) VALUES (?, ?, ?, ?, ?, ?)'),
      purchaseByIntent: p('SELECT * FROM purchases WHERE payment_intent = ?'),
      refund: p('UPDATE purchases SET refunded = 1 WHERE id = ?'),
      activePurchases: p('SELECT COUNT(*) AS n FROM purchases WHERE account = ? AND refunded = 0'),
      saveStats: p('UPDATE accounts SET callsign = ?, xp = ?, credits = ?, kills = ?, deaths = ?, last = ? WHERE id = ?'),
    };
    this.live = new Map();    // one shared object per account, so game stats and purchases never overwrite each other
    this.dirty = new Set();
  }

  // ---- accounts ----
  createAccount(email, passHash, callsign) {
    const t = now();
    const { lastInsertRowid } = this.q.insertAccount.run(email, passHash, callsign, t, t);
    return this.account(Number(lastInsertRowid));
  }
  account(id) {
    if (this.live.has(id)) return this.live.get(id);
    const row = this.q.byId.get(id);
    if (!row) return null;
    this.live.set(id, row);
    return row;
  }
  accountByEmail(email) {
    const row = this.q.byEmail.get(email);
    return row ? this.account(row.id) : null;
  }
  markDirty(acc) { this.dirty.add(acc); }
  flush() {
    const t = now();
    for (const a of this.dirty) this.q.saveStats.run(a.callsign, a.xp, a.credits, a.kills, a.deaths, t, a.id);
    this.dirty.clear();
  }

  // ---- sessions (only a hash of the token is stored) ----
  createSession(hash, accountId, ttlMs) { this.q.insertSession.run(hash, accountId, now(), now() + ttlMs); }
  accountBySession(hash) {
    const row = this.q.sessionAccount.get(hash, now());
    return row ? this.account(row.account) : null;
  }
  deleteSession(hash) { this.q.deleteSession.run(hash); }
  purgeSessions() { this.q.purgeSessions.run(now()); }

  // ---- purchases ----
  recordPurchase({ id, accountId, paymentIntent, amount, currency }) {
    const acc = this.account(accountId);
    if (!acc) return false;
    this.q.insertPurchase.run(id, accountId, paymentIntent || null, amount, currency, now());
    this.q.setOwned.run(1, accountId);
    acc.owned = 1;
    return true;
  }
  refundByIntent(paymentIntent) {
    const row = this.q.purchaseByIntent.get(paymentIntent);
    if (!row) return false;
    this.q.refund.run(row.id);
    const still = this.q.activePurchases.get(row.account).n > 0 ? 1 : 0;
    this.q.setOwned.run(still, row.account);
    const acc = this.account(row.account);
    if (acc) acc.owned = still;
    return true;
  }
}
