// Deterministic open-world generator shared by the server and the browser (served at /worldgen.js).
// Same inputs give the same terrain, outposts and scenery on every machine, so nothing about the
// map has to be sent over the network.

export const SIZE = 4096;              // metres across
export const HALF = SIZE / 2;
export const WATER = 0;                // lake surface height
export const CHUNK = 320;              // streaming chunk size in metres
export const BIOME = { SHORE: 0, DESERT: 1, GRASS: 2, FOREST: 3, ROCK: 4, SNOW: 5, LAKEBED: 6 };

const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

function hash(x, z, s) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, z, s) {
  const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi, s), b = hash(xi + 1, zi, s), c = hash(xi, zi + 1, s), d = hash(xi + 1, zi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, z, octaves, s) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) { sum += amp * vnoise(x * f, z * f, s + i * 17); norm += amp; amp *= 0.5; f *= 2.03; }
  return sum / norm;
}
export function rng(seed) {
  let a = seed | 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function rawHeight(x, z) {
  const land = fbm(x / 900, z / 900, 4, 11);                          // broad lowlands and basins
  const hills = fbm(x / 170, z / 170, 4, 23);
  const r = fbm(x / 520, z / 520, 5, 37), ridge = 1 - Math.abs(r * 2 - 1);
  const range = Math.pow(smooth(0.5, 0.82, fbm(x / 1400, z / 1400, 3, 51)), 1.3);   // where the mountain ranges are
  let h = (land - 0.43) * 95 + (hills - 0.5) * 24 + ridge * ridge * 175 * range;
  h += smooth(HALF - 280, HALF - 30, Math.max(Math.abs(x), Math.abs(z))) * 160;   // mountains wall the world in
  return h;
}

// ---- outposts: repair pads on a jittered 4x4 grid, each sitting on flattened ground ----
const NAMES = ['Kestrel', 'Osprey', 'Falcon', 'Harrier', 'Merlin', 'Condor', 'Raven', 'Heron', 'Shrike', 'Swift', 'Kite', 'Petrel', 'Gannet', 'Tern', 'Plover', 'Curlew'];
export const OUTPOSTS = [];
{
  const R = rng(4242);
  for (let gz = 0; gz < 4; gz++) for (let gx = 0; gx < 4; gx++) {
    const cx = -1350 + gx * 900, cz = -1350 + gz * 900;
    let best = null, score = Infinity;
    for (let k = 0; k < 16; k++) {
      const x = cx + (R() - 0.5) * 380, z = cz + (R() - 0.5) * 380, h = rawHeight(x, z);
      const s = h < 4 ? 100 + (4 - h) : h > 70 ? 100 + h : Math.abs(h - 20) * 0.1;
      if (s < score) { score = s; best = { x, z, h }; }
    }
    OUTPOSTS.push({ name: NAMES[OUTPOSTS.length], x: Math.round(best.x), z: Math.round(best.z), y: Math.max(WATER + 3, best.h) });
  }
}

// ---- hostile bases: a bunker, AA guns and a landing pad on flattened ground, away from outposts ----
const BASE_NAMES = ['Ironhold', 'Redcliff', 'Saltmarsh', 'Stonegate', 'Dustwell', 'Greywater', 'Ashfield', 'Blackrock'];
export const BASE_AA = [[20, -14], [-20, -14], [-22, 16]];   // AA gun positions relative to the base centre
export const BASE_PAD = [18, 18];                             // repair pad, usable once pilots hold the base
export const BASE_RADIUS = 45;                                // capture ring
export const BASES = [];
{
  const R = rng(9191);
  const spots = [[-900, -900], [900, -900], [-900, 900], [900, 900], [0, -1150], [0, 1150], [-1150, 0], [1150, 0]];
  for (const [cx, cz] of spots) {
    let best = null, score = Infinity;
    for (let k = 0; k < 24; k++) {
      const x = cx + (R() - 0.5) * 320, z = cz + (R() - 0.5) * 320, h = rawHeight(x, z);
      const nearOutpost = OUTPOSTS.some((o) => Math.hypot(o.x - x, o.z - z) < 260);
      const s = (nearOutpost ? 500 : 0) + (h < 4 ? 100 + (4 - h) : h > 70 ? 100 + h : Math.abs(h - 18) * 0.1);
      if (s < score) { score = s; best = { x, z, h }; }
    }
    BASES.push({ id: BASES.length, name: BASE_NAMES[BASES.length], x: Math.round(best.x), z: Math.round(best.z), y: Math.max(WATER + 3, best.h) });
  }
}

export function height(x, z) {
  let h = rawHeight(x, z);
  for (const o of OUTPOSTS) {
    const dx = x - o.x, dz = z - o.z, d2 = dx * dx + dz * dz;
    if (d2 < 2025) { const k = smooth(14, 45, Math.sqrt(d2)); h = o.y + (h - o.y) * k; }
  }
  for (const b of BASES) {
    const dx = x - b.x, dz = z - b.z, d2 = dx * dx + dz * dz;
    if (d2 < 4900) { const k = smooth(32, 70, Math.sqrt(d2)); h = b.y + (h - b.y) * k; }
  }
  return h;
}

export const moisture = (x, z) => fbm(x / 700, z / 700, 3, 71);
const townness = (x, z) => fbm(x / 600, z / 600, 2, 91);

export function biome(x, z, h = height(x, z)) {
  if (h < WATER - 0.5) return BIOME.LAKEBED;
  if (h < WATER + 2) return BIOME.SHORE;
  if (h > 118) return BIOME.SNOW;
  if (h > 72) return BIOME.ROCK;
  const m = moisture(x, z);
  return m < 0.4 ? BIOME.DESERT : m < 0.56 ? BIOME.GRASS : BIOME.FOREST;
}

export function padAt(x, z, r = 5) {
  for (const o of OUTPOSTS) if (Math.hypot(x - o.x, z - o.z) < r) return o;
  return null;
}
export function nearestBase(x, z) {
  let best = null, bd = Infinity;
  for (const b of BASES) { const d = Math.hypot(x - b.x, z - b.z); if (d < bd) { bd = d; best = b; } }
  return { base: best, dist: bd };
}
// Collision cylinders for one chunk's scenery: the same shapes the game page builds.
export function chunkObstacles(ci, cj) {
  return chunkItems(ci, cj).map((t) => {
    if (t.k === 'tree') return { x: t.x, z: t.z, r: 2.8 * t.s * 0.85, top: t.y + 6.6 * t.s + 3.2 * t.s * 0.85, base: t.y };
    const rock = t.k === 'rock', y = rock ? t.y : t.y - 0.5;
    return { x: t.x, z: t.z, r: Math.max(t.w, t.d) * (rock ? 0.85 : 0.62), top: y + t.hgt * (rock ? 0.85 : 1), base: t.y };
  });
}
export function nearestOutpost(x, z) {
  let best = null, bd = Infinity;
  for (const o of OUTPOSTS) { const d = Math.hypot(x - o.x, z - o.z); if (d < bd) { bd = d; best = o; } }
  return { outpost: best, dist: bd };
}

// Scenery for one chunk: trees, rocks, buildings and ruins, placed by biome. Each item becomes an
// obstacle on the client; the server never needs them.
export function chunkItems(ci, cj) {
  const R = rng(Math.imul(ci, 92821) ^ Math.imul(cj, 68917) ^ 777);
  const items = [], x0 = ci * CHUNK, z0 = cj * CHUNK;
  for (let n = 0; n < 170; n++) {
    const x = x0 + R() * CHUNK, z = z0 + R() * CHUNK, roll = R(), a = R(), b = R(), c = R(), rot = R() * Math.PI * 2;
    if (Math.abs(x) > HALF - 40 || Math.abs(z) > HALF - 40) continue;
    const h = height(x, z);
    if (h < WATER + 1) continue;
    if (OUTPOSTS.some((o) => Math.hypot(x - o.x, z - o.z) < 55) || BASES.some((b) => Math.hypot(x - b.x, z - b.z) < 75)) continue;
    const slope = Math.abs(height(x + 3, z) - h) + Math.abs(height(x, z + 3) - h);
    const bio = biome(x, z, h), town = townness(x, z) > 0.7 && h < 60 && slope < 1.2;
    if (town && roll < 0.42) {
      if (roll < 0.28) items.push({ k: 'building', x, z, y: h, rot, w: 6 + a * 9, d: 6 + b * 9, hgt: 5 + c * 13 });
      else items.push({ k: 'ruin', x, z, y: h, rot, w: 4 + a * 7, d: 4 + b * 6, hgt: 1.5 + c * 4 });
      continue;
    }
    const treeP = bio === BIOME.FOREST ? 0.55 : bio === BIOME.GRASS ? 0.08 : bio === BIOME.SHORE ? 0.03 : 0;
    const rockP = bio === BIOME.ROCK ? 0.16 : bio === BIOME.DESERT ? 0.07 : bio === BIOME.SNOW ? 0.05 : 0.025;
    if (roll < treeP && slope < 3) items.push({ k: 'tree', x, z, y: h, rot, s: 0.8 + a * 0.7, tint: b });
    else if (roll < treeP + rockP) items.push({ k: 'rock', x, z, y: h, rot, w: 1.6 + a * 4.5, d: 1.6 + b * 4.5, hgt: 1.2 + c * (bio === BIOME.ROCK ? 7 : 3.5), bio });
  }
  return items;
}
