# Drone Front server

Serves the game at `/`, the account and checkout API under `/api/`, and the online
worlds over WebSocket at `/ws`.

- **Accounts:** email and password (scrypt-hashed), 30-day sessions. Only a hash of
  each session token is stored.
- **One-time purchase:** $5 through Stripe Checkout. A signed Stripe webhook marks the
  account as owning the full game; a refund takes it back and disconnects the pilot.
- **Free demo:** sorties 01 and 02. Sorties 03 to 07 and the online world need the
  full game. The online world is locked by the server; the campaign lock is in the
  page, so a modified page could get around it.
- **Combat authority:** the server decides hull, damage, deaths, kills and rocket ammo,
  checks every hit claim (fire rate, range, ammo, spawn shields, target alive) and
  snaps back movement faster than a drone can fly.
- **Storage:** SQLite (`node:sqlite`, built into Node 22.13+) at `$DATA_DIR/drone-front.db`.

## Run it locally

```bash
cd server && npm install
```

```bash
npm start
```

Open http://localhost:8080. Without Stripe keys the server runs with purchases
closed: you can sign up and play the free sorties.

## Test

```bash
npm test
```

## Settings

| Variable | Needed for | Meaning |
|---|---|---|
| `PORT` | | HTTP and WebSocket port (default `8080`) |
| `DATA_DIR` | | Where the database lives (default `server/data`) |
| `PUBLIC_URL` | purchases | The game's public address, e.g. `https://drone-front.fly.dev` |
| `STRIPE_SECRET_KEY` | purchases | Stripe secret key (`sk_live_...`, or `sk_test_...` while testing) |
| `STRIPE_WEBHOOK_SECRET` | purchases | Signing secret of the webhook endpoint (`whsec_...`) |
| `PRICE_CENTS` | | Price in US cents (default `500`) |
| `STRIPE_AUTOMATIC_TAX` | | `1` to have Stripe Tax collect US sales tax (enable Stripe Tax first) |
| `TRUST_PROXY` | | `1` behind a proxy that sets the client IP header (Fly.io) |
| `CLIENT_FILE` | | The game page to serve (default `../index.html`) |

Gameplay limits (damage, fire rate, ranges, 32 pilots per world) are in `RULES` in
`world.js`. When a world is full the next pilot goes to a new one.

## Launch checklist

1. **Stripe:** create an account, finish business verification, and copy the secret
   key. Add a webhook endpoint at `https://<your-domain>/api/stripe/webhook` for the
   events `checkout.session.completed`, `checkout.session.async_payment_succeeded` and
   `charge.refunded`, then copy its signing secret. Do a full test purchase with test
   keys and the card `4242 4242 4242 4242` before switching to live keys.
2. **Sales tax:** digital goods are taxable in many US states. Turn on Stripe Tax and
   set `STRIPE_AUTOMATIC_TAX=1`, or confirm with an accountant that you do not need to
   collect yet.
3. **Hosting (Fly.io, Chicago):** `fly.toml` in the repository root runs one machine in
   `ord` with a volume for the database.

   ```bash
   fly launch --no-deploy --copy-config
   ```

   ```bash
   fly volumes create drone_front_data --region ord --size 1
   ```

   ```bash
   fly secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_... PUBLIC_URL=https://drone-front.fly.dev
   ```

   ```bash
   fly deploy
   ```
4. **Backups:** take regular snapshots of the `drone_front_data` volume (`fly volumes
   snapshots`), since it holds every account and purchase.
5. **Legal pages:** publish terms of sale, a refund policy and a privacy policy, and
   link them from the game before taking real payments.

## Limits of this version

- No password reset yet: it needs an email provider (see `docs/ROADMAP.md`).
- One server process. SQLite fits one machine; more machines need Postgres.
- Hits are checked, not re-simulated: a modified page can still aim perfectly within
  the fire-rate and range limits.
