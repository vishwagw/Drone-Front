# Drone Front server

Serves the game at `/` and runs the online worlds over WebSocket at `/ws`.
The server decides hull, damage, deaths, kills, rocket ammo and saved progress.
Each client sends its own flight state and claims its hits, and the server checks
every claim before applying it: fire rate, range, rocket ammo, spawn shields and
whether the target is alive. Movement faster than the drone can fly is snapped back.

## Run it

```bash
cd server && npm install
```

```bash
npm start
```

Open http://localhost:8080. The menu shows an **Online world** panel when the page
is served by this server. To point a copy of the page hosted elsewhere at a server,
add `?server=wss://your-host/ws` to its URL.

## Test

```bash
npm test
```

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP and WebSocket port |
| `DATA_DIR` | `server/data` | Where `profiles.json` (saved pilots) is written |
| `CLIENT_FILE` | `../index.html` | The game page to serve |

Gameplay limits (damage, fire rate, ranges, 32 pilots per world) are in `RULES` at
the top of `server.js`. When a world is full the next pilot goes to a new one.

## Deploy

The `Dockerfile` in the repository root builds a container that serves the game and
keeps saved pilots in the `/data` volume. Any container host with WebSocket support
works (Fly.io, Render, Railway, a small VPS). Mount a persistent volume at `/data`
and put the server behind HTTPS so browsers connect with `wss://`.

## Limits of this version

- Pilots are guest accounts: a random token stored in the browser. Clearing site
  data loses the pilot. Real accounts are the next step (see `docs/ROADMAP.md`).
- Saved pilots live in one JSON file, which suits one server process. Several
  servers need a shared database.
- Hit detection is checked, not simulated: a modified client can still aim
  perfectly within the fire-rate and range limits.
