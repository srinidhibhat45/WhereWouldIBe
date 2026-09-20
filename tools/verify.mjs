/**
 * verify.mjs — regression tests for the engine and the shipped data.
 *
 * Run: node tools/verify.mjs
 *
 * The strongest check on a plate-motion model is *relative* motion across a
 * boundary, because that is what GPS and seafloor magnetic stripes actually
 * measure. Absolute (no-net-rotation) velocities are model-frame quantities and
 * much harder to eyeball. So the headline suite is relative motion at famous
 * boundaries, with published rates from the MORVEL literature.
 */

import fs from 'node:fs';
import {
  PlateModel, toVec, project, relativeVelocity, len, distanceKm, angleBetween,
  R_EARTH_KM, R2D,
} from '../js/tectonics.js';
import { PlaceIndex } from '../js/places.js';
import { closestApproach, arrivalAt } from '../js/rendezvous.js';
import { fillPolygon } from '../js/mesh.js';

const read = (f) => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const platesRaw = read('plates.json');
const model = new PlateModel(platesRaw.plates);
const places = new PlaceIndex(read('places.json'), model);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('   \x1b[31mFAIL\x1b[0m', msg); } };
const h = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

/* ---------------------------------------------------------------- */
h('1  Plate identification');
for (const [name, lat, lon, want] of [
  ['Honolulu',       21.31, -157.86, 'PA'],
  ['Los Angeles',    34.05, -118.24, 'PA'],   // west of the San Andreas
  ['Point Reyes',    38.05, -122.87, 'PA'],
  ['San Francisco',  37.77, -122.42, 'NA'],   // east of it, just
  ['Denver',         39.74, -104.99, 'NA'],
  ['Mumbai',         19.08,   72.88, 'IN'],
  ['Kathmandu',      27.72,   85.32, 'EU'],   // north of the Himalayan front
  ['Beijing',        39.90,  116.41, 'EU'],
  ['Shanghai',       31.23,  121.47, 'YA'],
  ['Seoul',          37.57,  126.98, 'AM'],
  ['Tokyo',          35.68,  139.69, 'OK'],
  ['Cairo',          30.04,   31.24, 'AF'],
  ['Nairobi',        -1.29,   36.82, 'SO'],   // east of the East African Rift
  ['Reykjavik',      64.15,  -21.94, 'NA'],   // west of the Mid-Atlantic Ridge
  ['Sydney',        -33.87,  151.21, 'AU'],
  ['Ankara',         39.93,   32.86, 'AT'],
]) {
  const p = model.at(lon, lat);
  ok(p.code === want, `${name}: got ${p.code}, want ${want}`);
}
console.log(`   ${pass} places on the expected plate`);

/* ---------------------------------------------------------------- */
h('2  Relative motion at famous boundaries (mm/yr)');
for (const [label, lat, lon, a, b, want, tol] of [
  ['East Pacific Rise',              -20.0, -113.5, 'PA', 'NZ', 145, 25],
  ['San Andreas',                     37.0, -122.0, 'PA', 'NA',  50,  8],
  ['Peru–Chile trench',              -20.0,  -71.5, 'NZ', 'SA',  70, 12],
  ['Himalaya',                        28.0,   85.0, 'IN', 'EU',  38,  8],
  ['Iceland',                         64.0,  -18.0, 'NA', 'EU',  19,  5],
  ['Mid-Atlantic, equator',            0.0,  -20.0, 'SA', 'AF',  32,  8],
  ['Zagros',                          33.0,   48.0, 'AR', 'EU',  24,  7],
  ['Mediterranean',                   37.0,   15.0, 'AF', 'EU',   6,  4],
  ['Java trench',                    -10.0,  110.0, 'AU', 'SU',  68, 12],
  ['Alpine Fault, New Zealand',      -43.5,  170.0, 'PA', 'AU',  38,  8],
  ['Red Sea',                         20.0,   38.5, 'AR', 'AF',  15,  6],
  ['East African Rift',               -2.0,   36.0, 'SO', 'AF',   5,  4],
]) {
  const v = len(relativeVelocity(model.get(a), model.get(b), toVec(lon, lat)));
  const good = Math.abs(v - want) <= tol;
  ok(good, `${label}: ${v.toFixed(1)}, published ~${want} ±${tol}`);
  console.log(`   ${label.padEnd(26)} ${v.toFixed(1).padStart(6)}   published ~${String(want).padStart(3)}  ${good ? '✓' : '✗'}`);
}

/* ---------------------------------------------------------------- */
h('3  Absolute motion, no-net-rotation frame');
{
  const m = model.get('PA').motionAt(toVec(-157.86, 21.31));
  ok(Math.abs(m.speed - 70) < 8, `Hawaii ${m.speed.toFixed(1)} mm/yr, expected ~70`);
  ok(Math.abs(m.azimuth - 302) < 15, `Hawaii heading ${m.azimuth.toFixed(0)}°, expected ~302°`);
  console.log(`   Hawaii ${m.speed.toFixed(1)} mm/yr towards ${m.azimuth.toFixed(0)}° ${m.compass}`);
}

/* ---------------------------------------------------------------- */
h('4  Rotation is self-consistent');
{
  const pt = toVec(73.83, 15.50);
  const plate = model.at(73.83, 15.50);

  const back = plate.positionAt(plate.positionAt(pt, 4.2e7), -4.2e7);
  ok(distanceKm(pt, back) < 1e-6, `round trip drifted ${distanceKm(pt, back)} km`);

  const speed = plate.motionAt(pt).speed;
  const per1000 = distanceKm(pt, plate.positionAt(pt, 1000)) * 1e6 / 1000;
  ok(Math.abs(per1000 - speed) / speed < 1e-3, 'velocity and displacement disagree');

  ok(distanceKm(plate.poleVec, plate.positionAt(plate.poleVec, 1e9)) < 1e-6,
    'a point on the Euler pole moved');

  const a = toVec(73.83, 15.50), b = toVec(77.59, 12.97);   // Goa, Bengaluru
  ok(Math.abs(distanceKm(a, b) - distanceKm(plate.positionAt(a, 2e8), plate.positionAt(b, 2e8))) < 1e-6,
    'same-plate distance changed');
  console.log('   round trip, velocity/displacement, fixed pole, rigid plate — all consistent');
}

/* ---------------------------------------------------------------- */
h('5  Boundary kinematics agree from both sides');
{
  // Each plate stores its own copy of a shared edge. They must match, or the
  // globe draws one boundary in two different colours.
  const pairs = [['AF', 'SO'], ['NA', 'EU'], ['PA', 'NZ'], ['IN', 'EU'], ['NZ', 'SA'], ['AR', 'AF']];
  for (const [ca, cb] of pairs) {
    const run = (code, otherCode) => {
      const p = model.get(code), o = model.get(otherCode).index;
      const vals = [];
      p.parts.forEach((part, pi) => part.forEach((ring, ri) => {
        const e = p.edges?.[pi]?.[ri];
        if (!e) return;
        for (let i = 0; i < e.length / 3; i++) if (e[i * 3 + 2] === o) vals.push(e[i * 3]);
      }));
      return vals;
    };
    // The two outlines are digitised independently, so they rarely have the
    // same vertex count along a shared edge. What has to match is the physics:
    // same sign, same rate.
    const A = run(ca, cb), B = run(cb, ca);
    const mean = (v) => v.reduce((s, x) => s + x, 0) / (v.length || 1);
    const mA = mean(A), mB = mean(B);
    ok(A.length > 0 && B.length > 0 && Math.sign(mA) === Math.sign(mB) && Math.abs(mA - mB) < 1,
      `${ca}-${cb}: ${mA.toFixed(2)} vs ${mB.toFixed(2)} mm/yr (${A.length}/${B.length} segments)`);
    console.log(`   ${(ca + '–' + cb).padEnd(8)} ${String(A.length).padStart(4)}/${String(B.length).padEnd(4)} segments, mean ${mA > 0 ? '+' : ''}${mA.toFixed(1)} / ${mB > 0 ? '+' : ''}${mB.toFixed(1)} mm/yr ${mA > 0 ? '(opening)' : '(closing)'}`);
  }
}

/* ---------------------------------------------------------------- */
h('6  Plate areas match Bird (2003)');
{
  const published = { PA: 104.6, AF: 58.6, AN: 58.2, NA: 55.4, EU: 48.6, AU: 46.0, SA: 41.9 };
  const total = model.plates.reduce((s, p) => s + p.areaKm2, 0);
  ok(Math.abs(total - 4 * Math.PI * R_EARTH_KM ** 2) / total < 0.001,
    `plate areas sum to ${(total / 1e6).toFixed(1)}M km², sphere is 510.1M`);
  for (const [code, want] of Object.entries(published)) {
    const got = model.get(code).areaKm2 / 1e6;
    ok(Math.abs(got - want) / want < 0.03, `${code} area ${got.toFixed(1)}M vs ${want}M`);
  }
  console.log(`   ${model.plates.length} plates tile the sphere to ${(total / 1e6).toFixed(1)}M km²`);
}

/* ---------------------------------------------------------------- */
h('7  Place search');
{
  const cases = {
    Panaji: 'Panjim', Bombay: 'Mumbai', Calcutta: 'Kolkata', Madras: 'Chennai',
    Peking: 'Beijing', Bangalore: 'Bengaluru', Saigon: 'Ho Chi Minh', Rangoon: 'Yangon',
    Cologne: 'Köln', Seville: 'Sevilla', Kiev: 'Kyiv', Bruges: 'Brugge',
    Munich: 'Munich', Florence: 'Florence', Vienna: 'Vienna', Tokyo: 'Tokyo',
    'The Hague': 'Hague', Gothenburg: 'Gothenburg', Nuremberg: 'Nuremberg',
  };
  let miss = 0;
  for (const [q, want] of Object.entries(cases)) {
    const top = places.search(q, 1)[0];
    const good = top && top.label.includes(want);
    if (!good) { miss++; ok(false, `search "${q}" -> ${top ? top.label : '(none)'}, want ${want}`); }
    else pass++;
  }
  console.log(`   ${Object.keys(cases).length - miss}/${Object.keys(cases).length} lookups resolve, ${places.places.length} places indexed`);
}

/* ---------------------------------------------------------------- */
h('8  Rendezvous solver matches brute force');
{
  const A = { v: toVec(139.692, 35.69), p: model.at(139.692, 35.69) };   // Tokyo
  const B = { v: toVec(73.826, 15.496), p: model.at(73.826, 15.496) };   // Panjim

  const rv = closestApproach(A.v, A.p, B.v, B.p, { from: 0, to: 1e9, samples: 9000 });
  let bt = 0, bd = Infinity;
  for (let i = 0; i <= 400000; i++) {
    const t = (1e9 * i) / 400000;
    const d = angleBetween(A.p.positionAt(A.v, t), B.p.positionAt(B.v, t));
    if (d < bd) { bd = d; bt = t; }
  }
  const bruteKm = bd * R_EARTH_KM;
  ok(Math.abs(rv.bestKm - bruteKm) < 5, `solver ${rv.bestKm.toFixed(0)} km vs brute force ${bruteKm.toFixed(0)} km`);
  ok(Math.abs(rv.bestYears - bt) / 1e6 < 2, `solver ${(rv.bestYears / 1e6).toFixed(1)} Myr vs brute force ${(bt / 1e6).toFixed(1)} Myr`);
  console.log(`   Tokyo↔Panjim closest ${rv.bestKm.toFixed(0)} km at ${(rv.bestYears / 1e6).toFixed(1)} Myr (brute force ${bruteKm.toFixed(0)} km at ${(bt / 1e6).toFixed(1)} Myr)`);

  // Same plate: distance must be exactly constant.
  const c = { v: toVec(72.88, 19.08), p: model.at(72.88, 19.08) };
  const d = { v: toVec(77.59, 12.97), p: model.at(77.59, 12.97) };
  const same = closestApproach(c.v, c.p, d.v, d.p, {});
  ok(same.sameplate, 'Mumbai and Bengaluru should be recognised as the same plate');
  console.log(`   Mumbai↔Bengaluru: same plate, locked at ${same.nowKm.toFixed(0)} km forever`);
}

/* ---------------------------------------------------------------- */
h('9  Deep time — Panaji, Goa');
{
  const pt = toVec(73.83, 15.50);
  const plate = model.at(73.83, 15.50);
  for (const y of [1e3, 1e6, 1e7, 5e7, 1e8]) {
    const r = project(pt, plate, y);
    console.log(
      `   +${y.toExponential(0).padStart(5)} yr  ${r.lat.toFixed(2).padStart(7)}°N ${r.lon.toFixed(2).padStart(8)}°E` +
      `  moved ${(r.displacementKm < 10 ? r.displacementKm.toFixed(3) : r.displacementKm.toFixed(0)).padStart(7)} km  ${r.bearing.toFixed(0).padStart(3)}°`,
    );
  }
}

/* ---------------------------------------------------------------- */
h('10  Fills land where the land is, and nowhere else');
{
  // Both halves of this once failed, and neither is visible from the data:
  // the polygons are right, it is the meshing of them that can go wrong.
  //
  // The triangles are lifted lon/lat triangles, so a point is inside the
  // rendered shape if it is inside one of them on the sphere.
  const cross = (u, v) => [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
  const dot3 = (u, v) => u[0]*v[0] + u[1]*v[1] + u[2]*v[2];
  const inTri = (p, a, b, c) => {
    if (dot3(p, a) < 0 && dot3(p, b) < 0 && dot3(p, c) < 0) return false;   // far side
    const s1 = dot3(cross(a, b), p), s2 = dot3(cross(b, c), p), s3 = dot3(cross(c, a), p);
    return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
  };
  const covers = (meshes, lon, lat) => {
    const v = toVec(lon, lat), p = [v.x, v.y, v.z];
    for (const m of meshes) {
      const g = (k) => [m.pos[k*3], m.pos[k*3+1], m.pos[k*3+2]];
      for (let t = 0; t < m.index.length; t += 3)
        if (inTri(p, g(m.index[t]), g(m.index[t+1]), g(m.index[t+2]))) return true;
    }
    return false;
  };
  // Bucketed by z alone, so nothing can be lost at the ±180 seam the way a
  // longitude index loses it. Enough to sweep the globe finely in a second.
  const indexed = (tris) => {
    const N = 180, band = (z) => Math.min(N - 1, Math.max(0, Math.floor((z + 1) / 2 * N)));
    const buckets = Array.from({ length: N }, () => []);
    tris.forEach((t, i) => {
      const lo = band(Math.min(t[0][2], t[1][2], t[2][2]));
      const hi = band(Math.max(t[0][2], t[1][2], t[2][2]));
      for (let b = lo; b <= hi; b++) buckets[b].push(i);
    });
    return (lon, lat) => {
      const v = toVec(lon, lat), p = [v.x, v.y, v.z];
      for (const i of buckets[band(p[2])]) { const t = tris[i]; if (inTri(p, t[0], t[1], t[2])) return true; }
      return false;
    };
  };
  const trianglesOf = (meshes) => {
    const out = [];
    for (const m of meshes) {
      const g = (k) => [m.pos[k*3], m.pos[k*3+1], m.pos[k*3+2]];
      for (let t = 0; t < m.index.length; t += 3) out.push([g(m.index[t]), g(m.index[t+1]), g(m.index[t+2])]);
    }
    return out;
  };

  // (a) Land must not spill into the sea. Ear clipping cuts Afro-Eurasia's
  // 2,472-point ring into slivers that reach across the continent; splitting
  // those in 3D instead of in lon/lat bows them poleward, and the Siberian
  // Arctic fills in solid.
  const landMeshes = read('land.json').polygons
    .map((poly) => fillPolygon(poly.r, poly.p, 0.04)).filter(Boolean);
  const sea = [
    ['Kara Sea',        70,  76], ['Laptev Sea',    130,  76],
    ['north of Taymyr', 95,  79], ['Barents Sea',    40,  76],
    ['North Pole',       0, 89.5], ['mid-Atlantic', -30,  30],
    ['open Pacific',  -150,   0], ['Bay of Bengal',  88,  15],
  ];
  let spills = 0;
  for (const [name, lon, lat] of sea) {
    const wet = !covers(landMeshes, lon, lat);
    if (!wet) spills++;
    ok(wet, `${name} is drawn as sea`);
  }
  console.log(`   ${sea.length - spills}/${sea.length} open-water probes are still open water`);

  // (b) The plate fills must leave no gap for the mantle to glow through.
  // Away from the ±180 cut in the source polygons, every point belongs to
  // exactly one plate and must be painted by one.
  //
  // The polar cap is where this breaks and it needs the fine comb to see it.
  // The Antarctic plate wraps the pole, so its outline is closed by running
  // along latitude −90; near a pole every distance is short, so edges that
  // cross half the globe in longitude look perfectly short to a length test
  // and never get split. When that happened, the gaps ran along whole
  // parallels around −69° and a 4° sweep stepped straight over them.
  const plateMeshes = [];
  for (const pl of platesRaw.plates) for (const part of pl.parts) {
    const m = fillPolygon(part, null, 0.05);
    if (m) plateMeshes.push(m);
  }
  const painted = indexed(trianglesOf(plateMeshes));
  const sweep = (latLo, latHi, dLat, dLon) => {
    let bare = 0, n = 0, first = null;
    for (let lat = latLo; lat <= latHi; lat += dLat)
      for (let lon = -179; lon < 180; lon += dLon) {
        n++;
        if (!painted(lon, lat)) { bare++; first = first || [+lon.toFixed(1), +lat.toFixed(1)]; }
      }
    return { bare, n, first };
  };
  for (const [what, lo, hi, dLat, dLon] of [
    ['the whole globe', -88, 88, 2, 2],
    ['the polar caps',  -89.5, -55, 0.5, 1],
    ['the far north',    55, 89.5, 0.5, 1],
  ]) {
    const r = sweep(lo, hi, dLat, dLon);
    ok(r.bare === 0, `plate fills leave ${r.bare} of ${r.n} points bare over ${what}` +
      (r.first ? ` (first at ${r.first[0]}, ${r.first[1]})` : ''));
    console.log(`   ${String(r.n).padStart(6)} points over ${what}${r.bare ? ` — ${r.bare} BARE` : ', all painted'}`);
  }
}

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
