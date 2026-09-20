/**
 * tectonics.js — the engine.
 *
 * Everything here is pure maths over unit vectors on a sphere. No DOM, no
 * three.js, no globals. Plate motion follows the NNR-MORVEL56 model: each
 * plate is a rigid cap rotating about a fixed Euler pole at a constant rate,
 * so a point's whole history is one rotation about one axis.
 *
 * Caveat worth remembering: the model describes motion averaged over the last
 * ~0.78 Myr. Running it forward for 50 million years assumes nothing ever
 * changes — no new rifts, no plates jamming into each other and stopping.
 * Real Earth will not be so obliging. That is the fun of it.
 */

export const R_EARTH_KM = 6371.0088;
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

/* ------------------------------- vec3 ----------------------------------- */

export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const scale = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const len = (a) => Math.hypot(a.x, a.y, a.z);
export const normalize = (a) => { const m = len(a) || 1; return { x: a.x / m, y: a.y / m, z: a.z / m }; };

/** Geographic lon/lat (degrees) -> unit vector. +Z is the north pole. */
export function toVec(lon, lat) {
  const p = lat * D2R, l = lon * D2R, c = Math.cos(p);
  return { x: c * Math.cos(l), y: c * Math.sin(l), z: Math.sin(p) };
}

/** Unit vector -> [lon, lat] in degrees, lon wrapped to (-180, 180]. */
export function toLonLat(v) {
  return [Math.atan2(v.y, v.x) * R2D, Math.asin(clamp(v.z, -1, 1)) * R2D];
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Rodrigues' rotation of `v` about unit `axis` by `angle` radians. */
export function rotateAbout(v, axis, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return {
    x: v.x * c + k.x * s + axis.x * d,
    y: v.y * c + k.y * s + axis.y * d,
    z: v.z * c + k.z * s + axis.z * d,
  };
}

/** Angle between two unit vectors, in radians. Numerically safe near 0 and π. */
export function angleBetween(a, b) {
  const c = cross(a, b);
  return Math.atan2(len(c), dot(a, b));
}

export const distanceKm = (a, b) => angleBetween(a, b) * R_EARTH_KM;

/** Initial great-circle bearing from `a` towards `b`, degrees clockwise from north. */
export function bearingDeg(a, b) {
  const [lon1, lat1] = toLonLat(a);
  const [lon2, lat2] = toLonLat(b);
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

/* ------------------------------- plates --------------------------------- */

/**
 * One rigid plate. `pole` is [latitude °N, longitude °E, rate °/Myr] from
 * NNR-MORVEL56; `omega` is the same thing as an angular-velocity vector in
 * radians per year, which is what all the arithmetic actually wants.
 */
export class Plate {
  constructor(raw, index) {
    this.index = index;
    this.code = raw.c;
    this.name = raw.n;
    this.morvelCode = raw.m;
    this.pole = raw.pole;                 // [lat, lon, deg/Myr]
    this.hue = raw.hue;
    this.areaKm2 = raw.area;
    this.population = raw.pop;
    this.cityCount = raw.cities;
    this.parts = raw.parts;               // [[flatRing, flatHole...], ...]
    this.edges = raw.edges;               // per-segment [opening, sliding, otherPlate]
    this.rawNeighbours = raw.nbr || [];   // [otherIndex, opening, sliding, lengthKm]

    const [plat, plon, rate] = raw.pole;
    this.poleVec = toVec(plon, plat);
    this.rateRadPerYr = (rate * D2R) / 1e6;
    this.omega = scale(this.poleVec, this.rateRadPerYr);

    this.bbox = bboxOfParts(raw.parts);
  }

  /** Where a point sitting on this plate ends up after `years` (may be negative). */
  positionAt(point, years) {
    return rotateAbout(point, this.poleVec, this.rateRadPerYr * years);
  }

  /** Instantaneous surface velocity at a point, as a vector in mm/yr. */
  velocityVec(point) {
    return scale(cross(this.omega, point), R_EARTH_KM * 1e6);
  }

  /** Speed (mm/yr) and heading (° from north) of the ground at a point. */
  motionAt(point) {
    const speed = len(this.velocityVec(point));
    // Heading from a short finite step along the actual rotation.
    const ahead = this.positionAt(point, 1000);
    const azimuth = speed > 1e-9 ? bearingDeg(point, ahead) : 0;
    return { speed, azimuth, compass: compass(azimuth) };
  }

  /** Angular distance from this plate's Euler pole — motion vanishes at 0°. */
  angleFromPole(point) {
    const a = angleBetween(point, this.poleVec) * R2D;
    return a > 90 ? 180 - a : a;   // either end of the axis works
  }
}

function bboxOfParts(parts) {
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

/** Relative surface velocity of plate A with respect to B at a point (mm/yr vector). */
export function relativeVelocity(a, b, point) {
  return sub(a.velocityVec(point), b.velocityVec(point));
}

/* ---------------------------- plate lookup ------------------------------ */

/** Spatial index over the plate polygons: "which plate is this point on?" */
export class PlateModel {
  constructor(rawPlates) {
    this.plates = rawPlates.map((p, i) => new Plate(p, i));
    this.byCode = new Map(this.plates.map((p) => [p.code, p]));
    // Resolve the pre-computed boundary summary into real plate references.
    for (const p of this.plates) {
      p.neighbourList = p.rawNeighbours
        .filter(([i]) => this.plates[i])
        .map(([i, opening, sliding, lengthKm]) => ({
          plate: this.plates[i], opening, sliding, lengthKm,
          kind: Math.abs(opening) < Math.abs(sliding) * 0.85
            ? 'transform' : opening > 0 ? 'divergent' : 'convergent',
        }));
    }
  }

  get(codeOrIndex) {
    return typeof codeOrIndex === 'number' ? this.plates[codeOrIndex] : this.byCode.get(codeOrIndex);
  }

  /** Plate containing lon/lat. Falls back to the nearest polygon vertex. */
  at(lon, lat) {
    for (const p of this.plates) {
      const [x0, y0, x1, y1] = p.bbox;
      if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
      if (pointInParts(p.parts, lon, lat)) return p;
    }
    const v = toVec(lon, lat);
    let best = this.plates[0], bestD = -2;
    for (const p of this.plates) {
      for (const part of p.parts) for (const ring of part) {
        for (let i = 0; i < ring.length; i += 2) {
          const d = dot(v, toVec(ring[i], ring[i + 1]));
          if (d > bestD) { bestD = d; best = p; }
        }
      }
    }
    return best;
  }

}

export function pointInParts(parts, lon, lat) {
  for (const part of parts) {
    let inside = false;
    for (const ring of part) if (rayCast(ring, lon, lat)) inside = !inside;
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

/* --------------------------- derived readouts ---------------------------- */

/**
 * The full picture for "where would I be" at one instant in time.
 * `point` is the present-day unit vector; `years` is positive into the future.
 */
export function project(point, plate, years) {
  const now = point;
  const then = plate.positionAt(point, years);
  const [lon, lat] = toLonLat(then);
  const motion = plate.motionAt(point);
  const displacement = distanceKm(now, then);

  // Arc length actually travelled along the small circle — differs from
  // straight-line displacement once the point has swung a long way round.
  const swept = Math.abs(plate.rateRadPerYr * years);
  const radiusRad = angleBetween(point, plate.poleVec);
  const pathKm = swept * Math.sin(radiusRad) * R_EARTH_KM;

  return {
    years, lon, lat, vec: then,
    displacementKm: displacement,
    pathKm,
    bearing: displacement > 1 ? bearingDeg(now, then) : motion.azimuth,
    latitudeShift: lat - toLonLat(now)[1],
    speedMmYr: motion.speed,
    headingDeg: motion.azimuth,
    heading: motion.compass,
    turnsAroundPole: swept / (2 * Math.PI),
  };
}

/** Climate band from latitude — crude, but it is what a globe actually shows. */
export function climateBand(lat) {
  const a = Math.abs(lat);
  // `name` labels a field; `zone` is the same thing worded to drop into a
  // sentence — "in the tropics" rather than the fragment "in the tropical".
  if (a < 10) return { name: 'Equatorial', zone: 'the equatorial belt', hint: 'rainforest, year-round heat' };
  if (a < 23.44) return { name: 'Tropical', zone: 'the tropics', hint: 'inside the tropics, wet and dry seasons' };
  if (a < 35) return { name: 'Subtropical', zone: 'the subtropics', hint: 'deserts and mild winters' };
  if (a < 50) return { name: 'Temperate', zone: 'temperate latitudes', hint: 'four distinct seasons' };
  if (a < 66.56) return { name: 'Subpolar', zone: 'the subpolar north', hint: 'long cold winters, short summers' };
  return { name: 'Polar', zone: 'the polar circle', hint: 'midnight sun and polar night' };
}
