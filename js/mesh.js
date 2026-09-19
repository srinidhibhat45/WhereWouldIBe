/**
 * mesh.js — turning lon/lat polygons into geometry that lives on a sphere.
 *
 * Two jobs:
 *   1. Filled areas. Triangulate in lon/lat with earcut, lift onto the sphere,
 *      then refine until no edge sags noticeably below the surface. The
 *      refinement is conforming — a triangle splits whenever any neighbour
 *      split one of its edges — so the mesh stays watertight and no cracks
 *      open up between continents.
 *   2. Lines with actual thickness. WebGL ignores lineWidth, so every line is
 *      built as a ribbon of quads. Each vertex carries its base position and a
 *      sideways offset vector; both get rotated by the plate's quaternion in
 *      the vertex shader, which keeps ribbons glued to the moving crust.
 */

import earcut from '../vendor/earcut.js';
import { toVec, toLonLat, normalize, cross, sub, len, dot } from './tectonics.js';

/** Largest chord (as a fraction of the radius) we allow before splitting. */
const DEFAULT_MAX_CHORD = 0.045;   // ~2.6° of arc

/* ---------------------------- filled polygons ---------------------------- */

/**
 * Triangulate one polygon (outer ring + holes) given as flat [lon,lat,...]
 * arrays, returning sphere-space vertices plus whatever per-vertex payload the
 * caller supplied for the source vertices.
 *
 * @param {number[][]} rings        [outer, hole, ...] flat lon/lat
 * @param {number[][]} ringPayload  matching per-vertex integers (e.g. plate id)
 */
export function fillPolygon(rings, ringPayload, maxChord = DEFAULT_MAX_CHORD) {
  const coords = [];
  const payload = [];
  const holes = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    // earcut wants rings *not* explicitly closed.
    const n = ring.length / 2;
    const closed = n > 1 && ring[0] === ring[(n - 1) * 2] && ring[1] === ring[(n - 1) * 2 + 1];
    const count = closed ? n - 1 : n;
    if (r > 0) holes.push(coords.length / 2);
    for (let i = 0; i < count; i++) {
      coords.push(ring[i * 2], ring[i * 2 + 1]);
      payload.push(ringPayload ? ringPayload[r][i] ?? ringPayload[r][0] : 0);
    }
  }
  if (coords.length < 6) return null;

  const tris = earcut(coords, holes, 2);
  if (!tris.length) return null;

  // Lift to the sphere.
  const pos = [];
  for (let i = 0; i < coords.length; i += 2) {
    const v = toVec(coords[i], coords[i + 1]);
    pos.push(v.x, v.y, v.z);
  }
  return refine({ pos, payload, index: Array.from(tris) }, maxChord);
}

/**
 * Conforming refinement, red–green style.
 *
 * Each pass splits only the edges that are actually too long. A triangle with
 * all three edges split becomes four ("red"); one with one or two split edges
 * is cut into two or three ("green") so that no vertex is ever left hanging in
 * the middle of a neighbour's edge. Without the green cases, marking one edge
 * would cascade across the entire mesh and the triangle count would explode.
 */
function refine(mesh, maxChord) {
  const { pos, payload } = mesh;
  let index = mesh.index;
  const maxChord2 = maxChord * maxChord;
  const KEY = 8388608;
  const key = (a, b) => (a < b ? a * KEY + b : b * KEY + a);

  const chord2 = (a, b) => {
    const dx = pos[a * 3] - pos[b * 3];
    const dy = pos[a * 3 + 1] - pos[b * 3 + 1];
    const dz = pos[a * 3 + 2] - pos[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };

  const midpoint = (a, b, cache) => {
    const k = key(a, b);
    let id = cache.get(k);
    if (id !== undefined) return id;
    const x = (pos[a * 3] + pos[b * 3]) / 2;
    const y = (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2;
    const z = (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2;
    const m = Math.hypot(x, y, z) || 1;
    id = pos.length / 3;
    pos.push(x / m, y / m, z / m);
    payload.push(payload[a]);
    cache.set(k, id);
    return id;
  };

  for (let pass = 0; pass < 7; pass++) {
    const cache = new Map();
    let split = false;
    // Every over-long edge gets a midpoint, shared by both adjacent triangles.
    for (let t = 0; t < index.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = index[t + e], b = index[t + ((e + 1) % 3)];
        if (chord2(a, b) > maxChord2) { midpoint(a, b, cache); split = true; }
      }
    }
    if (!split) break;

    const next = [];
    for (let t = 0; t < index.length; t += 3) {
      const v = [index[t], index[t + 1], index[t + 2]];
      const m = [
        cache.get(key(v[0], v[1])), cache.get(key(v[1], v[2])), cache.get(key(v[2], v[0])),
      ];
      const n = m.reduce((a, x) => a + (x !== undefined ? 1 : 0), 0);

      if (n === 0) { next.push(v[0], v[1], v[2]); continue; }
      if (n === 3) {
        next.push(v[0], m[0], m[2], m[0], v[1], m[1], m[2], m[1], v[2], m[0], m[1], m[2]);
        continue;
      }
      // Rotate so the split edges sit in a known place, then emit the fan.
      if (n === 1) {
        const r = m.findIndex((x) => x !== undefined);
        const a = v[r], b = v[(r + 1) % 3], c = v[(r + 2) % 3], mm = m[r];
        next.push(a, mm, c, mm, b, c);
      } else {
        const missing = m.findIndex((x) => x === undefined);
        const r = (missing + 1) % 3;             // rotate so edges r and r+1 are split
        const a = v[r], b = v[(r + 1) % 3], c = v[(r + 2) % 3];
        const m0 = m[r], m1 = m[(r + 1) % 3];
        next.push(m0, b, m1, a, m0, m1, a, m1, c);
      }
    }
    index = next;
  }
  return { pos, payload, index };
}

/* --------------------------------- lines --------------------------------- */

/**
 * Insert extra points so no segment chords across more than `maxChord`.
 * Without this a long straight run (a plate edge across open ocean) would
 * visibly cut beneath the surface.
 *
 * Also returns, for each output point, the index of the source segment it came
 * from. Per-vertex data (plate ids, boundary kinematics) rides along on that.
 * Recovering the mapping afterwards by nearest-vertex search does not work:
 * plate outlines loop back close to themselves all the time, a monotone walk
 * skips ahead when they do, and every colour after that point is read from the
 * wrong stretch of the boundary.
 */
export function densifyIndexed(points, maxChord = DEFAULT_MAX_CHORD) {
  if (points.length < 2) return { points, source: new Int32Array(points.length) };
  const out = [points[0]];
  const source = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const steps = Math.max(1, Math.ceil(len(sub(b, a)) / maxChord));
    for (let s = 1; s <= steps; s++) {
      if (s === steps) { out.push(b); source.push(i); break; }
      const t = s / steps;
      out.push(normalize({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
      }));
      source.push(i - 1);
    }
  }
  return { points: out, source: Int32Array.from(source) };
}

export const densify = (points, maxChord = DEFAULT_MAX_CHORD) =>
  densifyIndexed(points, maxChord).points;

/**
 * Accumulates ribbon geometry across many polylines.
 *
 * Every vertex stores:
 *   base   unit position on the present-day sphere
 *   offset unit sideways direction (already signed), rotated with the plate
 *   plate  which plate's rotation to apply
 *   width  per-vertex width multiplier
 *   color  rgb
 */
export class RibbonBuilder {
  constructor() {
    this.base = [];
    this.offset = [];
    this.plate = [];
    this.width = [];
    this.color = [];
    this.index = [];
  }

  get count() { return this.plate.length; }

  /**
   * @param {object[]} points  unit vectors, already densified
   * @param {object} opts
   *   plate  number | (i)=>number
   *   color  [r,g,b] | (i)=>[r,g,b]
   *   width  number | (i)=>number
   *   closed boolean
   */
  add(points, { plate = 0, color = [1, 1, 1], width = 1, closed = false } = {}) {
    const n = points.length;
    if (n < 2) return;
    const at = (v, i) => (typeof v === 'function' ? v(i) : v);
    const start = this.base.length / 3;

    for (let i = 0; i < n; i++) {
      const p = points[i];
      const prev = points[i === 0 ? (closed ? n - 2 : 0) : i - 1];
      const next = points[i === n - 1 ? (closed ? 1 : n - 1) : i + 1];
      let tangent = sub(next, prev);
      tangent = sub(tangent, { x: p.x * dot(tangent, p), y: p.y * dot(tangent, p), z: p.z * dot(tangent, p) });
      if (len(tangent) < 1e-9) tangent = { x: -p.y, y: p.x, z: 0 };
      const side = normalize(cross(p, normalize(tangent)));
      const c = at(color, i);
      const w = at(width, i);
      const pl = at(plate, i);
      for (const sign of [1, -1]) {
        this.base.push(p.x, p.y, p.z);
        this.offset.push(side.x * sign, side.y * sign, side.z * sign);
        this.plate.push(pl);
        this.width.push(w);
        this.color.push(c[0], c[1], c[2]);
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const a = start + i * 2;
      this.index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  build(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('aBase', new THREE.Float32BufferAttribute(this.base, 3));
    g.setAttribute('aOffset', new THREE.Float32BufferAttribute(this.offset, 3));
    g.setAttribute('aPlate', new THREE.Float32BufferAttribute(this.plate, 1));
    g.setAttribute('aWidth', new THREE.Float32BufferAttribute(this.width, 1));
    g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.color, 3));
    g.setIndex(this.index);
    // `position` must exist for three.js bookkeeping even though the shader
    // never reads it; reuse the base buffer rather than duplicating data.
    g.setAttribute('position', g.getAttribute('aBase'));
    g.computeBoundingSphere();
    g.boundingSphere.radius = 1.4;
    return g;
  }
}

/** Flat [lon,lat,...] -> array of unit vectors. */
export function ringToVectors(flat) {
  const out = new Array(flat.length / 2);
  for (let i = 0; i < flat.length; i += 2) out[i / 2] = toVec(flat[i], flat[i + 1]);
  return out;
}

export { toLonLat };
