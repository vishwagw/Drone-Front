# Drone Front: road to a public online game

## Decided

- **Platform:** browser only.
- **Business model:** free to play. Everything is open to everyone; an account is only
  needed to fly online. (A $5 purchase was built and then removed; it is in the git
  history if you change your mind.)
- **Region:** United States. The server runs in Chicago (`ord`) to keep lag even across the country.

## Where it is now

- **Campaign:** 7 single-player sorties in the browser (Three.js).
- **Arena (inside Claude):** free-for-all over Claude's room sharing. Only signed-in
  Claude users can join and each page trusts the others, so it is a prototype, not
  something to sell.
- **Online world (own server):** `server/` runs persistent shared worlds that anyone
  who owns the game can join from a browser. The server owns hull, kills, ammo and saved pilot progress
  (XP, credits, kills, deaths), checks every hit claim, snaps back impossible
  movement, gives each pilot one live session, and opens a new world when one fills
  at 32 pilots.

## Milestones

1. **Server foundation** (done): authoritative combat, persistence, sharding,
   container build.
2. **Accounts** (done): email sign-in, SQLite storage, Fly.io config for Chicago.
   Still to do here: password reset and email verification (needs an email provider
   such as Postmark or Resend), callsign rules and player reporting.
3. **A real open world:** the streamed map is done: 4 km across in 320 m chunks
   with two detail levels, biomes, towns, 16 outposts, a radar minimap and
   interest management (updates only for pilots within 1.5 km). Server-run
   enemies are done too: 8 capturable bases with AA guns, tank and scout patrols,
   enemy fire simulated on the server, credits and XP for kills and captures.
   Still to do: convoys, timed world events, and harder enemy types (gunships,
   missile trucks) for experienced pilots.
4. **Progression and economy:** drone classes and upgrades bought with credits,
   cosmetics, daily missions, squads and chat.
5. **Server-side hit simulation:** the server re-checks line of sight and aim for
   every claimed hit, with lag compensation, to stop aim bots and wall hacks.
6. **Production:** hosting in more than one region, monitoring, backups, crash
   reporting, load testing, an admin panel and moderation tools.
7. **Public launch:** privacy policy, terms of use, age rating, support, and a way to
   cover hosting costs if the game grows (donations, optional cosmetics or ads).

## Still open

- **Name and art direction:** "Drone Front" is a working title; check trademarks
  before spending on marketing.
- **Email provider** for password reset.
- **Legal entity and policies:** who runs the game, terms of use,
  privacy policy (including the California privacy rules for US players).
