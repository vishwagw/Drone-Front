# Drone Front: road to a commercial online game

## Where it is now

- **Campaign:** 7 single-player sorties in the browser (Three.js).
- **Arena (inside Claude):** free-for-all over Claude's room sharing. Only signed-in
  Claude users can join and each page trusts the others, so it is a prototype, not
  something to sell.
- **Online world (own server):** `server/` runs persistent shared worlds that anyone
  with a browser can join. The server owns hull, kills, ammo and saved pilot progress
  (XP, credits, kills, deaths), checks every hit claim, snaps back impossible
  movement, gives each pilot one live session, and opens a new world when one fills
  at 32 pilots.

## Milestones

1. **Server foundation** (done): authoritative combat, persistence, sharding,
   container build.
2. **Accounts and storage:** real sign-in (email or OAuth), a database (Postgres)
   instead of the JSON file, server-side rate limits per account, name rules and
   reporting.
3. **A real open world:** a map several kilometres across streamed in chunks,
   zones with different terrain, server-run AI (patrols, convoys, bases to capture),
   world events, and interest management so each pilot only gets updates for what
   is near them.
4. **Progression and economy:** drone classes and upgrades bought with credits,
   cosmetics, daily missions, squads and chat.
5. **Server-side hit simulation:** the server re-checks line of sight and aim for
   every claimed hit, with lag compensation, to stop aim bots and wall hacks.
6. **Production:** hosting in more than one region, monitoring, backups, crash
   reporting, load testing, an admin panel and moderation tools.
7. **Launch business:** store and payments, privacy policy, terms, age rating,
   refunds and support.

## Decisions only you can make

- **Platform:** browser only, or also a desktop build (Steam) or mobile.
- **Business model:** free to play with cosmetics, a one-time price, or a subscription.
- **Hosting budget:** one region to start, or several for lower lag.
- **Name and art direction:** "Drone Front" is a working title; check trademarks
  before spending on marketing.
