/**
 * build-data.mjs — turns raw open datasets into the compact JSON the app ships.
 *
 * Inputs (see tools/fetch-raw.sh):
 *   raw/PB2002_plates.json       Bird (2003) plate polygons, via fraxen/tectonicplates
 *   raw/ne_50m_land.geojson      Natural Earth land polygons
 *   raw/ne_110m_countries.geojson
 *   raw/cities15000.txt          GeoNames cities > 15k people
 *   raw/admin1CodesASCII.txt     GeoNames first-order admin divisions
 *   raw/countryInfo.txt          GeoNames country table
 *   raw/alternateNamesV2.txt     optional — real English exonyms for search
 *
 * Outputs -> ../data/*.json
 *
 * Usage: node tools/build-data.mjs <rawDir>
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW = process.argv[2] || path.join(__dirname, 'raw');
const OUT = path.resolve(__dirname, '..', 'data');

const R_EARTH_KM = 6371.0088;
const D2R = Math.PI / 180;

/* ------------------------------------------------------------------ *
 * NNR-MORVEL56 angular velocities — Argus, Gordon & DeMets (2011),
 * "Geologically current motion of 56 plates relative to the no-net-
 * rotation reference frame", G-cubed 12, Q11001.
 * [pole latitude °N, pole longitude °E, rotation rate °/Myr]
 * ------------------------------------------------------------------ */
const MORVEL56 = {
  AM: [63.17, -122.82, 0.297], AN: [65.42, -118.11, 0.250], AR: [48.88, -8.49, 0.559],
  AU: [33.86, 37.94, 0.632],   CP: [44.44, 23.09, 0.608],   CA: [35.20, -92.62, 0.286],
  CO: [26.93, -124.31, 1.198], EU: [48.85, -106.50, 0.223], IN: [50.37, -3.29, 0.544],
  JF: [-38.31, 60.04, 0.951],  LW: [51.89, -69.52, 0.286],  MQ: [49.19, 11.05, 1.144],
  NZ: [46.23, -101.06, 0.696], NA: [-4.85, -80.64, 0.209],  NU: [47.68, -68.44, 0.292],
  PA: [-63.58, 114.70, 0.651], PS: [-46.02, -31.36, 0.910], RI: [20.25, -107.29, 4.536],
  SW: [-29.94, -36.87, 1.362], SC: [22.52, -106.15, 0.146], SM: [49.95, -84.52, 0.339],
  SA: [-22.62, -112.83, 0.109],SU: [50.06, -95.02, 0.337],  SR: [-32.50, -111.32, 0.107],
  YZ: [63.03, -116.62, 0.334], AS: [19.43, 122.87, 0.124],  AP: [-6.58, -83.98, 0.488],
  AT: [40.11, 26.66, 1.210],   BR: [-63.74, 142.06, 0.490], BS: [-1.49, 121.64, 2.475],
  BH: [-40.00, 100.50, 0.799], BU: [-6.13, -78.10, 2.229],  CL: [-72.78, 72.05, 0.607],
  CR: [-20.40, 170.53, 3.923], EA: [24.97, 67.53, 11.334],  FT: [-16.33, 178.07, 5.101],
  GP: [2.53, 81.18, 5.487],    JZ: [34.25, 70.74, 22.368],  KE: [39.99, 6.46, 2.347],
  MN: [-3.67, 150.27, 51.569], MO: [14.25, 92.67, 0.774],   MA: [11.05, 137.84, 1.306],
  MS: [2.15, -56.09, 3.566],   NH: [0.57, -6.60, 2.469],    NI: [-3.29, -174.49, 3.314],
  ND: [17.73, -122.68, 0.116], NB: [-45.04, 127.64, 0.856], OK: [30.30, -92.28, 0.229],
  ON: [36.12, 137.92, 2.539],  PM: [31.35, -113.90, 0.317], SL: [50.71, -143.47, 0.268],
  SS: [-2.87, 130.62, 1.703],  SB: [6.88, -31.89, 8.111],   TI: [-4.44, 113.50, 1.864],
  TO: [25.87, 4.48, 8.942],    WL: [0.10, 128.52, 1.744],
};

// Bird's PB2002 codes -> NNR-MORVEL56 codes where they differ.
const PB_TO_MORVEL = { AF: 'NU', SO: 'SM', YA: 'YZ' };

// A hand-tuned hue per plate so neighbours never share a colour.
const PLATE_HUE = {
  AF: 42, AN: 196, AP: 318, AR: 18, AS: 274, AT: 356, AU: 148, BH: 96, BR: 214, BS: 30,
  BU: 262, CA: 168, CL: 58, CO: 300, CR: 122, EA: 340, EU: 222, FT: 76, GP: 286, IN: 8,
  JF: 250, JZ: 110, KE: 184, MA: 328, MN: 64, MO: 240, MS: 14, NA: 288, NB: 132, ND: 206,
  NH: 50, NI: 310, NZ: 90, OK: 178, ON: 350, PA: 232, PM: 104, PS: 268, RI: 26, SA: 160,
  SB: 68, SC: 296, SL: 118, SO: 190, SS: 344, SU: 84, SW: 256, TI: 4, TO: 140, WL: 210,
};

/* ------------------------------ vector math ------------------------------ */

const toVec = (lon, lat) => {
  const p = lat * D2R, l = lon * D2R, c = Math.cos(p);
  return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
};
const toLonLat = (v) => [Math.atan2(v[1], v[0]) / D2R, Math.asin(Math.max(-1, Math.min(1, v[2]))) / D2R];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a) => { const m = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / m, a[1] / m, a[2] / m]; };

/** Angular-velocity vector in rad/yr from a MORVEL pole triple. */
function omegaVec([plat, plon, rate]) {
  const radPerYr = rate * D2R / 1e6;
  return scale(toVec(plon, plat), radPerYr);
}

/** Surface velocity (mm/yr) of a plate at a point, as a 3-vector. */
function surfaceVelocity(omega, point) {
  return scale(cross(omega, point), R_EARTH_KM * 1e6); // rad/yr * km -> mm/yr
}

/* --------------------------- polygon utilities --------------------------- */

/** Even-odd ray cast in lon/lat. `parts` = [[ring, hole...], ...] flat [lon,lat] pairs. */
function inParts(parts, lon, lat) {
  for (const part of parts) {
    let inside = false;
    for (const ring of part) {
      if (rayCast(ring, lon, lat)) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

function rayCast(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bboxOf(parts) {
  let x0 = 180, y0 = 90, x1 = -180, y1 = -90;
  for (const part of parts) for (const ring of part) {
    for (let i = 0; i < ring.length; i += 2) {
      if (ring[i] < x0) x0 = ring[i];
      if (ring[i] > x1) x1 = ring[i];
      if (ring[i + 1] < y0) y0 = ring[i + 1];
      if (ring[i + 1] > y1) y1 = ring[i + 1];
    }
  }
  return [x0, y0, x1, y1];
}

const SPHERE_KM2 = 4 * Math.PI * R_EARTH_KM * R_EARTH_KM;

/**
 * Spherical excess of a ring (Chamberlain & Duquette). The raw sum is the
 * enclosed area for one winding direction and (area − whole sphere) for the
 * other, so callers fold it back with `enclosedArea`.
 */
function ringArea(ring) {
  let total = 0;
  for (let i = 0, n = ring.length; i < n; i += 2) {
    const j = (i + 2) % n;
    const l1 = ring[i] * D2R, p1 = ring[i + 1] * D2R;
    const l2 = ring[j] * D2R, p2 = ring[j + 1] * D2R;
    let dl = l2 - l1;
    if (dl > Math.PI) dl -= 2 * Math.PI;
    if (dl < -Math.PI) dl += 2 * Math.PI;
    total += dl * (2 + Math.sin(p1) + Math.sin(p2));
  }
  return (total * R_EARTH_KM * R_EARTH_KM) / 2;
}

/** Area enclosed by a ring (km²), independent of winding direction. */
function enclosedArea(ring) {
  const a = ringArea(ring);
  return a < 0 ? a + SPHERE_KM2 : a;
}

/** Area of one polygon part = outer ring minus its holes. */
function partArea(part) {
  let a = enclosedArea(part[0]);
  for (let i = 1; i < part.length; i++) a -= enclosedArea(part[i]);
  return a;
}

/* ------------------------------ simplification --------------------------- */

/** Douglas–Peucker on a flat [lon,lat,...] ring, tolerance in degrees. */
function simplify(flat, tol) {
  const n = flat.length / 2;
  if (n < 4) return flat;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = flat[a * 2], ay = flat[a * 2 + 1], bx = flat[b * 2], by = flat[b * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bestD = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = flat[i * 2], py = flat[i * 2 + 1];
      let d;
      if (len2 === 0) d = (px - ax) ** 2 + (py - ay) ** 2;
      else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(flat[i * 2], flat[i * 2 + 1]);
  return out;
}

const round = (v, dp) => { const f = 10 ** dp; return Math.round(v * f) / f; };
const roundFlat = (flat, dp) => flat.map((v) => round(v, dp));

/** GeoJSON geometry -> [[ringFlat, holeFlat...], ...] */
function toParts(geom) {
  if (!geom) return [];
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  return polys.map((poly) => poly.map((ring) => ring.flat()));
}

/* ================================ BUILD ================================== */

const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
const log = (...a) => console.log('  ', ...a);

fs.mkdirSync(OUT, { recursive: true });

/* ---------- 1. Plates -------------------------------------------------- */
console.log('\n[1/5] plates');
const platesGeo = readJSON('PB2002_plates.json');
const plateMap = new Map();

for (const f of platesGeo.features) {
  const code = f.properties.Code;
  const parts = toParts(f.geometry);
  if (!plateMap.has(code)) {
    plateMap.set(code, { code, name: f.properties.PlateName, parts: [] });
  }
  plateMap.get(code).parts.push(...parts);
}

const plates = [...plateMap.values()].map((p) => {
  const mCode = PB_TO_MORVEL[p.code] || p.code;
  const pole = MORVEL56[mCode];
  if (!pole) throw new Error(`no MORVEL pole for ${p.code}`);
  const area = p.parts.reduce((a, part) => a + partArea(part), 0);
  return { ...p, morvel: mCode, pole, area, bbox: bboxOf(p.parts), hue: PLATE_HUE[p.code] ?? 0 };
});
plates.sort((a, b) => b.area - a.area);
plates.forEach((p, i) => { p.index = i; });
const areaSum = plates.reduce((a, p) => a + p.area, 0);
log(`${plates.length} plates; total area ${(areaSum / 1e6).toFixed(1)}M km² (sphere = ${(SPHERE_KM2 / 1e6).toFixed(1)}M)`);
log('largest: ' + plates.slice(0, 4).map((p) => `${p.name} ${(p.area / 1e6).toFixed(1)}M`).join(', '));

/** Plate lookup used throughout the build. Returns plate index. */
function plateAt(lon, lat) {
  for (const p of plates) {
    const [x0, y0, x1, y1] = p.bbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    if (inParts(p.parts, lon, lat)) return p.index;
  }
  // Fallback: nearest polygon vertex (great-circle).
  const v = toVec(lon, lat);
  let best = 0, bestD = -2;
  for (const p of plates) {
    for (const part of p.parts) for (const ring of part) {
      for (let i = 0; i < ring.length; i += 2) {
        const d = dot(v, toVec(ring[i], ring[i + 1]));
        if (d > bestD) { bestD = d; best = p.index; }
      }
    }
  }
  return best;
}

/* ---------- 2. Edge kinematics ------------------------------------------ *
 * Every plate carries its own outline, so a shared boundary gets drawn twice —
 * once by each side. For every outline segment we work out what the two plates
 * are doing to each other: take the relative NNR-MORVEL56 surface velocity and
 * split it into boundary-normal (opening / closing) and along-boundary
 * (sliding) components. That number is what paints mid-ocean ridges red and
 * trenches blue on the globe.
 *
 * The delicate part is deciding which side of a segment is "outside" the
 * plate. Probing 40 km to each side and asking which plate is there fails on
 * jagged outlines — a handful of probes land wrong, the sign flips, and the
 * two copies of one boundary end up coloured as opposites. So orientation is
 * settled once per ring by majority vote and then applied to every segment of
 * it, which is both stable and consistent between neighbours.
 * ------------------------------------------------------------------------- */
console.log('\n[2/5] edge kinematics');
const omegaByIndex = plates.map((p) => omegaVec(p.pole));
const PROBE_KM = [40, 90, 180];

function angleBetween(a, b) {
  return Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));
}

/** Unit frame for a segment: midpoint, along-boundary tangent, left normal. */
function segmentFrame(lonA, latA, lonB, latB) {
  const a = toVec(lonA, latA), b = toVec(lonB, latB);
  const mid = norm([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  const chord = sub(b, a);
  const tangent = norm(sub(chord, scale(mid, dot(chord, mid))));
  if (!isFinite(tangent[0]) || !isFinite(mid[0])) return null;
  return { a, b, mid, tangent, left: norm(cross(mid, tangent)) };
}

const offsetPoint = (mid, dir, km) => {
  const off = km / R_EARTH_KM;
  return toLonLat(norm([mid[0] + dir[0] * off, mid[1] + dir[1] * off, mid[2] + dir[2] * off]));
};

/**
 * Which way is out of the plate: +1 if the left-hand normal points outward,
 * -1 if the right-hand one does. Decided by sampling segments around the ring.
 */
function ringOutwardSign(ring, plate) {
  const n = ring.length / 2;
  const step = Math.max(1, Math.floor((n - 1) / 48));
  let votes = 0;
  for (let i = 0; i < n - 1; i += step) {
    const f = segmentFrame(ring[i * 2], ring[i * 2 + 1], ring[i * 2 + 2], ring[i * 2 + 3]);
    if (!f) continue;
    const [lo, la] = offsetPoint(f.mid, f.left, PROBE_KM[0]);
    votes += inParts(plate.parts, lo, la) ? -1 : 1;
  }
  return votes >= 0 ? 1 : -1;
}

function classifyEdge(lonA, latA, lonB, latB, ownIndex, outwardSign) {
  const f = segmentFrame(lonA, latA, lonB, latB);
  if (!f) return null;
  const outward = scale(f.left, outwardSign);

  // Step out until we actually leave the plate; a 40 km probe is not enough
  // where two boundaries run close together.
  let other = -1;
  for (const km of PROBE_KM) {
    const [lo, la] = offsetPoint(f.mid, outward, km);
    const idx = plateAt(lo, la);
    if (idx !== ownIndex) { other = idx; break; }
  }
  if (other < 0) return null;

  const vRel = sub(
    surfaceVelocity(omegaByIndex[ownIndex], f.mid),
    surfaceVelocity(omegaByIndex[other], f.mid),
  );
  return {
    opening: -dot(vRel, outward),        // + = the two plates are separating
    sliding: dot(vRel, f.tangent),
    other,
    lengthKm: angleBetween(f.a, f.b) * R_EARTH_KM,
  };
}

let edgeSegs = 0, divergentSegs = 0;
for (const p of plates) {
  p.edges = [];
  const nbr = new Map();
  for (const part of p.parts) {
    const partEdges = [];
    for (const ring of part) {
      const n = ring.length / 2;
      const e = new Array((n - 1) * 3).fill(0);
      const sign = ringOutwardSign(ring, p);
      for (let i = 0; i < n - 1; i++) {
        const c = classifyEdge(ring[i * 2], ring[i * 2 + 1], ring[i * 2 + 2], ring[i * 2 + 3], p.index, sign);
        if (!c) { e[i * 3 + 2] = -1; continue; }
        // One decimal, not integers: on a rift opening at 4-6 mm/yr, rounding
        // to whole numbers flips the divergent/transform call at random.
        e[i * 3] = round(c.opening, 1);
        e[i * 3 + 1] = round(c.sliding, 1);
        e[i * 3 + 2] = c.other;
        edgeSegs++;
        if (c.opening > 4) divergentSegs++;
        const acc = nbr.get(c.other) || { open: 0, slide: 0, len: 0 };
        acc.open += c.opening * c.lengthKm;
        acc.slide += Math.abs(c.sliding) * c.lengthKm;
        acc.len += c.lengthKm;
        nbr.set(c.other, acc);
      }
      partEdges.push(e);
    }
    p.edges.push(partEdges);
  }
  p.neighbours = [...nbr.entries()]
    .filter(([, v]) => v.len > 50)
    .map(([idx, v]) => [idx, round(v.open / v.len, 1), round(v.slide / v.len, 1), Math.round(v.len)])
    .sort((a, b) => b[3] - a[3]);
}
log(`${edgeSegs} edge segments classified, ${divergentSegs} spreading`);
{
  const pa = plates.find((p) => p.code === 'PA');
  log('Pacific borders: ' + pa.neighbours.slice(0, 5)
    .map(([i, o, s, l]) => `${plates[i].code} ${o > 0 ? '+' : ''}${o}mm/yr over ${Math.round(l / 1000)}Mm`).join(', '));
}

/* ---------- 3. Land + countries ---------------------------------------- */
console.log('\n[3/5] coastlines');
const landGeo = readJSON('ne_50m_land.geojson');
const LAND_TOL = 0.09;      // degrees — keeps the silhouette, drops the noise
const MIN_AREA = 180;       // km² — drop specks that render as single pixels

// Each coastline vertex is tagged with the plate it rides on, so the renderer
// never has to run point-in-polygon on tens of thousands of mesh vertices.
const land = [];
let landVerts = 0;
for (const f of landGeo.features) {
  for (const part of toParts(f.geometry)) {
    const rings = [], ringPlates = [];
    for (let r = 0; r < part.length; r++) {
      const ring = simplify(part[r], LAND_TOL);
      if (ring.length < 8) continue;
      if (r === 0 && enclosedArea(ring) < MIN_AREA) { rings.length = 0; break; }
      rings.push(roundFlat(ring, 2));
      const pl = [];
      for (let i = 0; i < ring.length; i += 2) pl.push(plateAt(ring[i], ring[i + 1]));
      ringPlates.push(pl);
    }
    if (rings.length) {
      land.push({ r: rings, p: ringPlates });
      landVerts += rings.reduce((a, r) => a + r.length / 2, 0);
    }
  }
}
log(`${land.length} landmasses, ${landVerts} vertices (plate-tagged)`);

const ctryGeo = readJSON('ne_110m_countries.geojson');
const borders = [];
let borderVerts = 0;
for (const f of ctryGeo.features) {
  for (const part of toParts(f.geometry)) {
    for (const ring of part) {
      const s = simplify(ring, 0.12);
      if (s.length < 8) continue;
      const pl = [];
      for (let i = 0; i < s.length; i += 2) pl.push(plateAt(s[i], s[i + 1]));
      borders.push({ r: roundFlat(s, 2), p: pl });
      borderVerts += s.length / 2;
    }
  }
}
log(`${borders.length} country rings, ${borderVerts} vertices`);

/**
 * Replace the guessed aliases with real English exonyms, when the full
 * GeoNames alternate-names dump is available locally.
 *
 * The heuristic below does well on "Bombay" and "Peking" but misses cases like
 * Cologne (for Köln) and Seville (for Sevilla), where the English name is not
 * distinguishable from a transliteration by shape alone. The dump has the
 * language tag and the preferred/short/historic flags, which settles it — but
 * it is a 785 MB download, so this stays optional and the build works without
 * it. Streamed line by line; only the ~9,000 places we ship are kept.
 */
async function enrichWithEnglishNames(selected) {
  const file = path.join(RAW, 'alternateNamesV2.txt');
  if (!fs.existsSync(file)) {
    log('alternateNamesV2.txt not present — keeping heuristic aliases');
    return;
  }
  const wanted = new Map(selected.map((p) => [p.id, p]));
  const found = new Map();

  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let scanned = 0;
  for await (const line of rl) {
    scanned++;
    // Cheap reject before splitting: the language tag is the third column.
    if (line.indexOf('\ten\t') < 0) continue;
    const c = line.split('\t');
    if (c[2] !== 'en' || !wanted.has(c[1])) continue;
    const name = c[3];
    if (!name || name.length < 3 || name.length > 28 || !ALIAS_OK.test(name)) continue;
    const rank =
      c[4] === '1' ? 0 :          // isPreferredName
      c[5] === '1' ? 1 :          // isShortName
      c[7] === '1' ? 2 : 3;       // isHistoric, then plain
    if (!found.has(c[1])) found.set(c[1], []);
    found.get(c[1]).push([rank, name]);
  }

  let changed = 0;
  for (const [id, list] of found) {
    const place = wanted.get(id);
    const nameKey = fold(place.name);
    const seen = new Set([nameKey]);
    const kept = [];
    list.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length);
    for (const [, n] of list) {
      const k = fold(n);
      if (seen.has(k)) continue;
      seen.add(k);
      kept.push(n);
      if (kept.length === 4) break;
    }
    if (kept.length) { place.alt = kept.join('|'); changed++; }
  }
  log(`English names: scanned ${(scanned / 1e6).toFixed(1)}M rows, enriched ${changed} places`);
}

/* ---------- 4. Places ---------------------------------------------------- */
console.log('\n[4/5] places');
const admin1 = new Map();
for (const line of fs.readFileSync(path.join(RAW, 'admin1CodesASCII.txt'), 'utf8').split('\n')) {
  const c = line.split('\t');
  if (c.length >= 2) admin1.set(c[0], c[1]);
}
const countries = new Map();
for (const line of fs.readFileSync(path.join(RAW, 'countryInfo.txt'), 'utf8').split('\n')) {
  if (!line || line[0] === '#') continue;
  const c = line.split('\t');
  if (c.length > 4) countries.set(c[0], c[4]);
}

/**
 * A few Latin-script aliases per place, purely so search is forgiving:
 * "Panaji" should find the city GeoNames files as "Panjim", "Bombay" should
 * find Mumbai.
 *
 * GeoNames lists every exonym in every script, alphabetically, so taking the
 * first few gives you six spellings of the same Russian transliteration and
 * misses the name people actually type. So: drop anything non-Latin, drop the
 * junk (IATA codes like BOM, and vowel-less transliterations like "klkta" —
 * both are always all-one-case), collapse near-identical spellings by their
 * first six letters, then prefer the shortest survivors, which are the forms
 * in common use.
 */
const fold = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const ALIAS_OK = /^[A-Za-z\u00C0-\u024F][A-Za-z\u00C0-\u024F .'`-]*$/;

const isJunkAlias = (a) =>
  !/[aeiouy]/i.test(a) ||                              // "klkta", "pkn"
  a === a.toLowerCase() ||                             // "cennai", "bmbyy"
  (a.length <= 4 && a === a.toUpperCase());            // "BOM", "CCU"

function pickAlternates(name, field) {
  if (!field) return '';
  const nameKey = fold(name);
  const seen = new Set([nameKey.slice(0, 6)]);
  const kept = [];
  for (const a of field.split(',')) {
    if (a.length < 3 || a.length > 24 || !ALIAS_OK.test(a) || isJunkAlias(a)) continue;
    const k = fold(a);
    if (k === nameKey) continue;
    const bucket = k.slice(0, 6);
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    kept.push(a);
  }
  // True exonyms first. Near-spellings ("Cennai" for Chennai) are already
  // covered by the loose matching in the search, so the slots are better spent
  // on names that share nothing with the primary one — Madras, Bombay, Peking.
  const distinct = (a) => (fold(a).slice(0, 3) === nameKey.slice(0, 3) ? 1 : 0);
  kept.sort((x, y) => distinct(x) - distinct(y) || x.length - y.length);
  return kept.slice(0, 6).join('|');
}

const rawCities = [];
for (const line of fs.readFileSync(path.join(RAW, 'cities15000.txt'), 'utf8').split('\n')) {
  if (!line) continue;
  const c = line.split('\t');
  if (c.length < 15) continue;
  rawCities.push({
    id: c[0], name: c[1], lat: +c[4], lon: +c[5], fcode: c[7], cc: c[8],
    admin: admin1.get(`${c[8]}.${c[10]}`) || '', pop: +c[14] || 0,
    alt: pickAlternates(c[1], c[3]),
  });
}
log(`${rawCities.length} GeoNames cities read`);

// Keep every capital (national + first-order admin) and everything over 100k,
// then top up sparse regions so remote points still find a sensible neighbour.
const CAP = new Set(['PPLC', 'PPLA']);
const chosen = rawCities.filter((c) => c.pop >= 100000 || CAP.has(c.fcode));
const chosenSet = new Set(chosen);
const grid = new Map();
const cellKey = (c) => `${Math.floor(c.lon / 2)},${Math.floor(c.lat / 2)}`;
for (const c of chosen) grid.set(cellKey(c), (grid.get(cellKey(c)) || 0) + 1);
const extras = rawCities
  .filter((c) => !chosenSet.has(c))
  .sort((a, b) => b.pop - a.pop)
  .filter((c) => {
    const k = cellKey(c);
    if ((grid.get(k) || 0) >= 2) return false;
    grid.set(k, (grid.get(k) || 0) + 1);
    return true;
  });
const places = [...chosen, ...extras].sort((a, b) => b.pop - a.pop);
log(`${places.length} places kept (${chosen.length} capitals/major + ${extras.length} coverage fills)`);

await enrichWithEnglishNames(places);

// Per-plate demographics from the *full* GeoNames set, not just what we ship.
const platePop = new Array(plates.length).fill(0);
const plateCities = new Array(plates.length).fill(0);
for (const c of rawCities) {
  const pi = plateAt(c.lon, c.lat);
  platePop[pi] += c.pop;
  plateCities[pi] += 1;
}

const ccList = [...new Set(places.map((p) => p.cc))].sort();
const ccIndex = new Map(ccList.map((c, i) => [c, i]));
const placeRows = places.map((p) => [
  p.name, p.admin, ccIndex.get(p.cc), round(p.lat, 3), round(p.lon, 3), p.pop, plateAt(p.lon, p.lat),
  CAP.has(p.fcode) ? (p.fcode === 'PPLC' ? 2 : 1) : 0, p.alt,
]);

/* ---------- 5. Write ----------------------------------------------------- */
console.log('\n[5/5] writing');
const PROVENANCE = {
  motion: 'NNR-MORVEL56 — Argus, Gordon & DeMets (2011), G-cubed 12, Q11001',
  plates: 'PB2002 — Bird (2003), G-cubed 4(3), 1027 (GeoJSON via fraxen/tectonicplates)',
  coastlines: 'Natural Earth 1:50m land, 1:110m admin-0 (public domain)',
  places: 'GeoNames cities15000 (CC BY 4.0)',
  built: new Date().toISOString().slice(0, 10),
};

const write = (name, obj) => {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, JSON.stringify(obj));
  log(`${name.padEnd(18)} ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
};

write('plates.json', {
  source: PROVENANCE,
  plates: plates.map((p) => ({
    c: p.code, n: p.name, m: p.morvel, pole: p.pole, hue: p.hue,
    area: Math.round(p.area), pop: platePop[p.index], cities: plateCities[p.index],
    parts: p.parts.map((part) => part.map((ring) => roundFlat(ring, 2))),
    edges: p.edges,
    nbr: p.neighbours,
  })),
});
write('land.json', { source: PROVENANCE.coastlines, polygons: land });
write('borders.json', { source: PROVENANCE.coastlines, rings: borders });
write('places.json', {
  source: PROVENANCE.places,
  countries: ccList.map((c) => countries.get(c) || c),
  cc: ccList,
  fields: ['name', 'admin', 'countryIndex', 'lat', 'lon', 'pop', 'plate', 'capital', 'aliases'],
  rows: placeRows,
});

console.log('\ndone.\n');
