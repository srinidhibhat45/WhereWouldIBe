/**
 * places.js — the gazetteer.
 *
 * ~7,800 settlements from GeoNames: every national and first-order capital,
 * everything over 100k people, plus fills so that remote points still have a
 * sensible nearest neighbour. Each one knows which plate it rides on, so we
 * can ask "who will my neighbours be in 50 million years?" and get a real
 * answer rather than a shrug.
 *
 * Nothing here talks to the network. The user's coordinates never leave the
 * browser.
 */

import { toVec, rotateAbout, angleBetween, R_EARTH_KM, toLonLat } from './tectonics.js';

const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * A deliberately sloppy key: letters only, with doubled letters collapsed.
 * It is what lets "Calcutta" match the spelling "Calcuta" and "Peking" match
 * "Pekin", without a hand-maintained synonym table.
 */
const loosen = (s) => strip(s).replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');

export class Place {
  constructor(row, countries, index) {
    this.index = index;
    this.name = row[0];
    this.admin = row[1];
    this.country = countries[row[2]];
    this.lat = row[3];
    this.lon = row[4];
    this.population = row[5];
    this.plateIndex = row[6];
    this.capital = row[7];              // 2 = national, 1 = first-order admin
    this.aliases = row[8] || '';        // a few Latin-script alternates
    this.vec = toVec(this.lon, this.lat);
    this.key = strip(`${this.name} ${this.admin} ${this.country} ${this.aliases.replace(/\|/g, ' ')}`);
    this.nameKey = strip(this.name);
    this.aliasKeys = this.aliases ? this.aliases.split('|').map(strip) : [];
    this.looseKeys = [loosen(this.name), ...this.aliasKeys.map(loosen)];
  }

  /** "Panaji, Goa, India" — skipping the middle part when it just repeats. */
  get label() {
    const parts = [this.name];
    if (this.admin && strip(this.admin) !== this.nameKey) parts.push(this.admin);
    if (this.country && strip(this.country) !== this.nameKey) parts.push(this.country);
    return parts.join(', ');
  }

  get shortLabel() {
    return this.admin && strip(this.admin) !== this.nameKey
      ? `${this.name}, ${this.admin}`
      : `${this.name}, ${this.country}`;
  }
}

export class PlaceIndex {
  constructor(data, model) {
    this.model = model;
    this.places = data.rows.map((r, i) => new Place(r, data.countries, i));
    this.byPlate = new Map();
    for (const p of this.places) {
      if (!this.byPlate.has(p.plateIndex)) this.byPlate.set(p.plateIndex, []);
      this.byPlate.get(p.plateIndex).push(p);
    }
  }

  /** Name search, ranked by how well it matches and then by size. */
  search(query, limit = 8) {
    const q = strip(query.trim());
    if (q.length < 2) return [];
    const ql = loosen(q);
    const out = [];
    for (const p of this.places) {
      let score;
      if (p.nameKey === q) score = 0;
      else if (p.nameKey.startsWith(q) || p.aliasKeys.some((a) => a === q)) score = 1;
      else if (p.aliasKeys.some((a) => a.startsWith(q))) score = 2;
      else if (p.key.includes(` ${q}`)) score = 2;
      // Spelling-variant fallbacks: "Calcutta"/"Calcuta", "Peking"/"Pekin".
      else if (ql.length >= 4 && p.looseKeys.some((a) => a === ql || (a.length >= 4 && ql.startsWith(a)))) score = 3;
      else if (p.key.includes(q)) score = 4;
      else continue;
      // Big and capital cities float up; it is what people mean.
      const rank = score * 1e12 - p.population - (p.capital === 2 ? 5e6 : p.capital ? 5e5 : 0);
      out.push([rank, p]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out.slice(0, limit).map((x) => x[1]);
  }

  /**
   * The `limit` places closest to `target` at time `years`, with every place
   * carried forward on its own plate. Returns distances in km.
   */
  nearest(target, years = 0, limit = 6, { exclude = null, minPopulation = 0, excludePlate = null } = {}) {
    const rot = this.plateRotations(years);
    const best = [];
    for (const p of this.places) {
      if (p === exclude || p.population < minPopulation) continue;
      if (excludePlate !== null && p.plateIndex === excludePlate) continue;
      const v = applyRotation(rot[p.plateIndex], p.vec);
      const d = angleBetween(target, v);
      if (best.length < limit) {
        best.push({ place: p, angle: d, vec: v });
        if (best.length === limit) best.sort((a, b) => a.angle - b.angle);
      } else if (d < best[limit - 1].angle) {
        best[limit - 1] = { place: p, angle: d, vec: v };
        for (let i = limit - 1; i > 0 && best[i].angle < best[i - 1].angle; i--) {
          const t = best[i]; best[i] = best[i - 1]; best[i - 1] = t;
        }
      }
    }
    best.sort((a, b) => a.angle - b.angle);
    return best.map((b) => ({
      place: b.place,
      km: b.angle * R_EARTH_KM,
      vec: b.vec,
      lonlat: toLonLat(b.vec),
    }));
  }

  /** Single nearest place to a present-day coordinate — used to name a pin. */
  nearestNow(target, opts) {
    return this.nearest(target, 0, 1, opts)[0] || null;
  }

  /** Pre-baked rotation matrices, one per plate, for a given time offset. */
  plateRotations(years) {
    return this.model.plates.map((p) => rotationMatrix(p.poleVec, p.rateRadPerYr * years));
  }
}

/* ------------------------- small rotation helpers ------------------------ */

/** Rodrigues rotation matrix (row-major, 9 floats) about a unit axis. */
export function rotationMatrix(axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const { x, y, z } = axis;
  return [
    t * x * x + c,     t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c,     t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

export function applyRotation(m, v) {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

export { rotateAbout };
