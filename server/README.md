# Drone Front server

Serves the game at `/`, the account API under `/api/`, and the online worlds over
WebSocket at `/ws`. The game is free: all 7 sorties and the online world are open to
everyone, and an account is only needed to fly online, where it keeps a pilot's
progress.

- **Accounts:** email and password (scrypt-hashed), 30-day sessions. Only a hash of
  each session token is stored.
- **One live session per pilot:** signing in from a second window disconnects the
  first.
- **Combat authority:** the server decides hull, damage, deaths, kills and rocket ammo,
  checks every hit claim (fire rate, range, ammo, spawn shields, target alive) and
  snaps back movement faster than a drone can fly.
- **Open world:** a 4 km by 4 km generated map (`worldgen.js`) with lakes, forests,
  grassland, desert, mountain ranges, towns and 16 outposts whose pads repair and
  rearm. The server and the game page run the same generator (the page loads it from
  `/worldgen.js`), so the map itself is never sent over the network. Pilots spawn
  beside an outpost near other pilots, and each pilot only receives updates about
  pilots within 1.5 km.
- **Server-run enemies (`npc.js`):** 8 hostile bases, each with 3 AA guns, a tank
  patrolling nearby and two scout drones on patrol to a neighbouring base. Enemies
  only think while a pilot is within 1.8 km. Their shots are simulated on the server
  and stopped by terrain, trees, rocks and buildings, so the server alone decides
  enemy damage. Pilots' hits on enemies go through the same checks as hits on
  pilots. Kills pay credits and XP (scout 15, AA gun 25, tank 40 credits); scouts and
  tanks respawn after two to three minutes.
- **Capturing bases:** a base cannot be taken while any AA gun stands. Once they are
  down, pilots flying below 35 m inside the 45 m ring fill a capture bar (15 seconds,
  faster with more pilots). Capturing pays 60 credits and 250 XP to every pilot
  within 300 m, turns the base's pad into a repair pad, and hostile forces retake it
  with a fresh garrison after 10 minutes.
- **Storage:** SQLite (`node:sqlite`, built into Node 22.13+) at `$DATA_DIR/drone-front.db`.

## Run it locally

```bash
cd server && npm install
```

```bash
npm start
```

Open http://localhost:8080, create a pilot and enter the online world.

## Test

```bash
npm test
```

## Settings

| Variable | Meaning |
|---|---|
| `PORT` | HTTP and WebSocket port (default `8080`) |
| `DATA_DIR` | Where the database lives (default `server/data`) |
| `TRUST_PROXY` | `1` behind a proxy that sets the client IP header (Fly.io) |
| `CLIENT_FILE` | The game page to serve (default `../index.html`) |

Gameplay limits (damage, fire rate, ranges, view range, 64 pilots per world) are in
`RULES` in `world.js`. When a world is full the next pilot goes to a new copy of the
map. Changing anything in `worldgen.js` changes the map for everyone, so deploy the
server and page together.

## Launch checklist

1. **Hosting (Fly.io, Chicago):** `fly.toml` in the repository root runs one machine in
   `ord` with a volume for the database.

   ```bash
   fly launch --no-deploy --copy-config
   ```

   ```bash
   fly volumes create drone_front_data --region ord --size 1
   ```

   ```bash
   fly deploy
   ```
2. **Backups:** take regular snapshots of the `drone_front_data` volume (`fly volumes
   snapshots`), since it holds every pilot account.
3. **Legal pages:** publish terms of use and a privacy policy (the game stores email
   addresses), and link them from the game before opening it to the public.
4. **Running costs:** a free game earns nothing, so check what the hosting costs as
   players arrive. One small Fly.io machine handles 64 pilots per world copy.

## Limits of this version

- No password reset yet: it needs an email provider (see `docs/ROADMAP.md`).
- One server process. SQLite fits one machine; more machines need Postgres.
- Hits are checked, not re-simulated: a modified page can still aim perfectly within
  the fire-rate and range limits.
