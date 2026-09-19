/**
 * format.js — turning numbers into things a human actually feels.
 *
 * Deep time is hard to hold in your head. 40 mm/yr means nothing; "about as
 * fast as your fingernails grow" means everything. Most of this file exists to
 * do that translation.
 */

export const PRESENT_YEAR = new Date().getFullYear();

const nf = (min = 0, max = 0) => new Intl.NumberFormat('en-US', {
  minimumFractionDigits: min, maximumFractionDigits: max,
});
const int = nf(0, 0);

export const comma = (n) => int.format(Math.round(n));

/* ------------------------------- time ----------------------------------- */

/** "1,000 years" / "4.2 million years" / "250 million years" */
export function formatYears(y) {
  const a = Math.abs(y);
  if (a < 1) return '0 years';
  if (a < 1e4) return `${comma(a)} years`;
  if (a < 1e6) return `${nf(0, a < 1e5 ? 1 : 0).format(a / 1e3)} thousand years`;
  if (a < 1e9) return `${nf(0, a < 1e7 ? 1 : 0).format(a / 1e6)} million years`;
  return `${nf(0, 2).format(a / 1e9)} billion years`;
}

/** Compact form for the big dial readout: "1 kyr", "4.2 Myr", "250 Myr". */
export function formatYearsShort(y) {
  const a = Math.abs(y);
  if (a < 1e3) return `${comma(a)} yr`;
  if (a < 1e6) return `${nf(0, a < 1e4 ? 1 : 0).format(a / 1e3)} kyr`;
  if (a < 1e9) return `${nf(0, a < 1e7 ? 1 : 0).format(a / 1e6)} Myr`;
  return `${nf(0, 2).format(a / 1e9)} Gyr`;
}

/** Calendar year, but only while that is still a sane thing to say. */
export function calendarYear(y) {
  const target = PRESENT_YEAR + y;
  if (Math.abs(y) > 1e6) return null;
  if (target < 0) return `${comma(-target)} BCE`;
  return `CE ${comma(target)}`;
}

/**
 * What was (or might be) happening on Earth at this moment in time. Past
 * entries are established geology; future ones are clearly flagged guesses.
 */
const EPOCHS = [
  [-4.0e9, 'Earth is barely solid. No continents worth the name yet.'],
  [-2.4e9, 'The Great Oxidation — cyanobacteria are poisoning the sky with oxygen.'],
  [-1.1e9, 'Rodinia, an earlier supercontinent, is assembling.'],
  [-5.4e8, 'The Cambrian explosion. Eyes are invented.'],
  [-3.6e8, 'Forests appear. Fish start experimenting with legs.'],
  [-3.0e8, 'Pangaea is coming together. You could walk from Texas to Morocco.'],
  [-2.52e8, 'The Permian extinction — 90% of species gone. Earth’s worst day.'],
  [-2.0e8, 'Pangaea begins to tear apart. The Atlantic starts as a crack.'],
  [-1.4e8, 'India breaks free of Africa and starts its run north.'],
  [-6.6e7, 'The Chicxulub impact. Non-avian dinosaurs end here.'],
  [-5.0e7, 'India slams into Asia. The Himalaya begin to rise.'],
  [-5.3e6, 'The Mediterranean refills after drying out almost completely.'],
  [-3.0e6, 'Early hominins walking upright in East Africa.'],
  [-1.0e5, 'Modern humans spreading out of Africa.'],
  [-2.0e4, 'Peak of the last ice age. Sea level 120 m lower than today.'],
  [-1.2e4, 'The ice retreats. Agriculture is about to be invented.'],
  [-5.0e3, 'The first cities. Writing is brand new.'],
  [0, 'Now.'],
  [1e3, 'Speculative: barely a geological blink. Coastlines mostly as you know them.'],
  [1e5, 'Speculative: ice ages have come and gone several more times.'],
  [1e6, 'Speculative: new volcanic islands, rivers in new places, familiar continents.'],
  [1e7, 'Speculative: East Africa has split off. A new ocean is opening.'],
  [5e7, 'Speculative: Africa has closed the Mediterranean. Australia is on Asia’s doorstep.'],
  [1.5e8, 'Speculative: the Atlantic may have started closing again.'],
  [2.5e8, 'Speculative: a new supercontinent. Some call the idea Pangaea Proxima.'],
  [6.0e8, 'Speculative: the Sun is hot enough to end the carbon cycle as we know it.'],
];

export function epochNote(years) {
  let best = EPOCHS[0];
  for (const e of EPOCHS) if (years >= e[0]) best = e;
  // Prefer the nearer of the two bracketing entries.
  const i = EPOCHS.indexOf(best);
  const next = EPOCHS[i + 1];
  if (next && Math.abs(next[0] - years) < Math.abs(years - best[0])) best = next;
  return best[1];
}

/* ----------------------------- distance --------------------------------- */

/** Picks a sensible unit: mm below a metre, then m, then km. */
export function formatDistance(km) {
  const m = km * 1000;
  if (Math.abs(m) < 0.01) return `${nf(0, 2).format(m * 1000)} mm`;
  if (Math.abs(m) < 1) return `${nf(0, 1).format(m * 100)} cm`;
  if (Math.abs(m) < 1000) return `${nf(0, m < 10 ? 2 : 0).format(m)} m`;
  if (Math.abs(km) < 100) return `${nf(0, 1).format(km)} km`;
  return `${comma(km)} km`;
}

const LANDMARKS = [
  [0.0003, 'a grain of rice'],
  [0.0018, 'a credit card'],
  [0.03, 'a bus'],
  [0.1, 'a football pitch'],
  [0.3, 'the Eiffel Tower laid on its side'],
  [1.6, 'a mile'],
  [8.8, 'the height of Everest'],
  [42.2, 'a marathon'],
  [344, 'London to Paris'],
  [1200, 'the length of Italy'],
  [3940, 'New York to Los Angeles'],
  [6371, 'the radius of the Earth'],
  [10008, 'a quarter of the way around the world'],
  [20015, 'halfway around the world'],
  [40075, 'the whole way around the world'],
];

/** "about 3× the height of Everest" — a size you can picture. */
export function distanceComparison(km) {
  if (!isFinite(km) || km <= 0) return null;
  let best = null, bestScore = Infinity;
  for (const [size, label] of LANDMARKS) {
    const ratio = km / size;
    if (ratio < 0.4 || ratio > 40) continue;
    const score = Math.abs(Math.log(ratio));
    if (score < bestScore) { bestScore = score; best = [ratio, label]; }
  }
  if (!best) return null;
  const [ratio, label] = best;
  if (ratio > 0.85 && ratio < 1.2) return `about ${label}`;
  if (ratio < 1) return `about ${nf(0, 1).format(ratio)}× ${label}`;
  return `about ${nf(0, ratio < 10 ? 1 : 0).format(ratio)}× ${label}`;
}

/* ------------------------------- speed ---------------------------------- */

const SPEED_LIKENESSES = [
  [150, 'roughly the speed your hair grows'],
  [42, 'about as fast as your fingernails grow'],
  [25, 'about half the speed your fingernails grow'],
  [10, 'slower than a glacier — and glaciers are the slow ones'],
];

export function speedComparison(mmPerYear) {
  if (mmPerYear <= 0) return 'not moving at all';
  let best = SPEED_LIKENESSES[0], bestScore = Infinity;
  for (const [rate, label] of SPEED_LIKENESSES) {
    const score = Math.abs(Math.log(mmPerYear / rate));
    if (score < bestScore) { bestScore = score; best = [rate, label]; }
  }
  if (bestScore > 0.9) {
    const lifetime = (mmPerYear * 80) / 1000;
    return `${nf(0, 2).format(lifetime)} m in an 80-year lifetime`;
  }
  return best[1];
}

export const formatSpeed = (mmPerYear) => `${nf(0, mmPerYear < 10 ? 2 : 1).format(mmPerYear)} mm/yr`;

/* ---------------------------- coordinates -------------------------------- */

export function formatLat(lat) {
  return `${nf(0, 4).format(Math.abs(lat))}° ${lat >= 0 ? 'N' : 'S'}`;
}
export function formatLon(lon) {
  const l = ((lon + 180) % 360 + 360) % 360 - 180;
  return `${nf(0, 4).format(Math.abs(l))}° ${l >= 0 ? 'E' : 'W'}`;
}
export const formatCoords = (lat, lon) => `${formatLat(lat)}, ${formatLon(lon)}`;

/** Degrees / minutes / seconds, for people who like their coordinates old-school. */
export function formatDMS(lat, lon) {
  const one = (v, pos, neg) => {
    const hemi = v >= 0 ? pos : neg;
    const a = Math.abs(v);
    const d = Math.floor(a);
    const mFull = (a - d) * 60;
    const m = Math.floor(mFull);
    const s = (mFull - m) * 60;
    return `${d}°${String(m).padStart(2, '0')}′${nf(0, 1).format(s).padStart(4, '0')}″${hemi}`;
  };
  return `${one(lat, 'N', 'S')} ${one(((lon + 180) % 360 + 360) % 360 - 180, 'E', 'W')}`;
}

/* ------------------------------ misc ------------------------------------ */

export function formatPopulation(n) {
  if (n >= 1e9) return `${nf(0, 2).format(n / 1e9)} billion`;
  if (n >= 1e6) return `${nf(0, 1).format(n / 1e6)} million`;
  if (n >= 1e3) return `${comma(n)}`;
  return comma(n);
}

export function formatArea(km2) {
  if (km2 >= 1e6) return `${nf(0, 1).format(km2 / 1e6)} million km²`;
  return `${comma(km2)} km²`;
}

export const signed = (n, digits = 1) =>
  `${n > 0 ? '+' : n < 0 ? '−' : ''}${nf(0, digits).format(Math.abs(n))}`;
