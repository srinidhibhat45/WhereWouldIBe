/**
 * rendezvous.js — the reverse question.
 *
 * "How long before that place becomes my neighbour?" Both points ride their
 * own plate, so each traces a small circle about its own Euler pole and the
 * distance between them is a quasi-periodic function of time. There is no
 * closed form worth having, so: scan coarsely, collect every local minimum,
 * then refine each one by golden section. That finds the global minimum and
 * also the near-misses along the way, which are the interesting part.
 */

import { angleBetween, R_EARTH_KM, rotateAbout } from './tectonics.js';

const PHI_INV = (Math.sqrt(5) - 1) / 2;

/** Distance in radians between two points carried forward to time t. */
function separation(a, plateA, b, plateB, t) {
  const pa = plateA ? rotateAbout(a, plateA.poleVec, plateA.rateRadPerYr * t) : a;
  const pb = plateB ? rotateAbout(b, plateB.poleVec, plateB.rateRadPerYr * t) : b;
  return angleBetween(pa, pb);
}

/** Golden-section minimisation of a unimodal-ish f over [lo, hi]. */
function refine(f, lo, hi, iterations = 60) {
  let a = lo, b = hi;
  let c = b - PHI_INV * (b - a), d = a + PHI_INV * (b - a);
  let fc = f(c), fd = f(d);
  for (let i = 0; i < iterations && b - a > 1; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - PHI_INV * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + PHI_INV * (b - a); fd = f(d); }
  }
  const t = (a + b) / 2;
  return { t, value: f(t) };
}

/**
 * Find when two points come closest.
 *
 * @param {object} a  present-day unit vector of the origin
 * @param {Plate}  plateA
 * @param {object} b  present-day unit vector of the target
 * @param {Plate|null} plateB  null = the target stays put in space
 * @param {object} opts  { from, to, samples }
 */
export function closestApproach(a, plateA, b, plateB, opts = {}) {
  const from = opts.from ?? 0;
  const to = opts.to ?? 1e9;
  const samples = opts.samples ?? 8000;

  const nowKm = angleBetween(a, b) * R_EARTH_KM;

  // Same plate: rigid body, the distance can never change.
  if (plateA && plateB && plateA.index === plateB.index) {
    return {
      sameplate: true,
      nowKm,
      bestKm: nowKm,
      bestYears: 0,
      closingMmYr: 0,
      candidates: [],
    };
  }

  const f = (t) => separation(a, plateA, b, plateB, t);
  const step = (to - from) / samples;
  const d = new Float64Array(samples + 1);
  for (let i = 0; i <= samples; i++) d[i] = f(from + i * step);

  const candidates = [];
  for (let i = 1; i < samples; i++) {
    if (d[i] <= d[i - 1] && d[i] <= d[i + 1]) {
      const r = refine(f, from + (i - 1) * step, from + (i + 1) * step);
      candidates.push({ years: r.t, km: r.value * R_EARTH_KM });
    }
  }
  // Endpoints can be minima too.
  if (d[0] < d[1]) candidates.push({ years: from, km: d[0] * R_EARTH_KM });
  if (d[samples] < d[samples - 1]) candidates.push({ years: to, km: d[samples] * R_EARTH_KM });

  candidates.sort((x, y) => x.km - y.km);
  const best = candidates[0] || { years: 0, km: nowKm };

  // Are they approaching or receding right now?
  const eps = 5000;
  const closingMmYr =
    ((separation(a, plateA, b, plateB, -eps) - separation(a, plateA, b, plateB, eps)) / (2 * eps)) *
    R_EARTH_KM * 1e6;

  return {
    sameplate: false,
    nowKm,
    bestKm: best.km,
    bestYears: best.years,
    closingMmYr,
    candidates: candidates.slice(0, 6),
    // Chronological near-misses, useful for "and then again at…"
    upcoming: candidates.filter((c) => c.years > 1e5).sort((x, y) => x.years - y.years).slice(0, 4),
  };
}

/**
 * When does the origin's ground arrive at a fixed set of coordinates — the
 * literal reading of "when will I be there?". The target does not move.
 */
export function arrivalAt(a, plateA, targetVec, opts = {}) {
  return closestApproach(a, plateA, targetVec, null, opts);
}

/** A sampled distance-vs-time curve for plotting. */
export function distanceSeries(a, plateA, b, plateB, from, to, n = 360) {
  const pts = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const t = from + ((to - from) * i) / n;
    pts[i] = { t, km: separation(a, plateA, b, plateB, t) * R_EARTH_KM };
  }
  return pts;
}

/**
 * Plain-language verdict. The thresholds are deliberately generous: the model
 * is an extrapolation, so "within 200 km in 40 Myr" genuinely does mean
 * "these two end up in the same neighbourhood".
 */
export function verdict(result) {
  if (result.sameplate) {
    return {
      headline: 'Same plate — locked together',
      detail: 'These two ride the same slab of crust. Their separation never changes, no matter how long you wait.',
      tone: 'locked',
    };
  }
  const km = result.bestKm;
  if (km < 120) return { headline: 'They meet', detail: 'Close enough to call it the same place.', tone: 'meet' };
  if (km < 600) return { headline: 'Near neighbours', detail: 'A day’s travel apart, where today they are not.', tone: 'close' };
  if (km < 2500) return { headline: 'Same region', detail: 'The same broad corner of the world.', tone: 'region' };
  return { headline: 'They never really meet', detail: 'This is the closest these two ever get.', tone: 'far' };
}
