/**
 * ui.js — the words.
 *
 * Three rules, all learned the hard way:
 *
 *   1. The answer is ONE sentence, and it lives in the dock. Not a panel, not a
 *      column of tiles — a sentence. The globe is doing the real explaining and
 *      anything laid over it is in the way.
 *   2. Every number past that sentence lives in the sheet, which is shut until
 *      somebody opens it.
 *   3. Scrubbing time must not rebuild anything. `driftFacts()` computes one
 *      flat object; markup renders it with `data-live` keys and `patch()` walks
 *      those keys and writes text. Nothing reflows, nothing flickers.
 */

import {
  formatYears, formatYearsShort, formatDistance, distanceComparison,
  formatSpeed, speedComparison, formatCoords, formatDMS, formatPopulation,
  formatArea, epochNote, comma, signed, calendarYear,
} from './format.js';
import { climateBand, project, distanceKm, compass } from './tectonics.js';
import { verdict } from './rendezvous.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const hsl = (h, s = 62, l = 58) => `hsl(${h} ${s}% ${l}%)`;

const CHEV = '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

/** Compass word -> something you would actually say out loud. */
const LONGHAND = {
  N: 'north', NE: 'north-east', E: 'east', SE: 'south-east',
  S: 'south', SW: 'south-west', W: 'west', NW: 'north-west',
  NNE: 'north-north-east', ENE: 'east-north-east', ESE: 'east-south-east',
  SSE: 'south-south-east', SSW: 'south-south-west', WSW: 'west-south-west',
  WNW: 'west-north-west', NNW: 'north-north-west',
};
const longhand = (c) => LONGHAND[c] || String(c).toLowerCase();

/* ============================ search results ============================= */

export function renderSearchResults(places) {
  return places.map((p, i) => `
    <button data-place="${p.index}" ${i === 0 ? 'class="is-active"' : ''}>
      <span class="r-name">${esc(p.name)}${p.capital === 2 ? ' <span style="color:var(--other);font-size:10px">★</span>' : ''}</span>
      <span class="r-meta">${esc([p.admin, p.country].filter(Boolean).join(' · '))}${p.population ? ' — ' + formatPopulation(p.population) : ''}</span>
    </button>`).join('');
}

/* =============================== the facts =============================== */

/**
 * Everything the top of the panel shows, as flat strings. One function so the
 * initial render and every later patch cannot drift apart.
 */
export function driftFacts(state) {
  const { origin, years } = state;
  const r = project(origin.vec, origin.plate, years);
  const band = climateBand(r.lat);
  const bandNow = climateBand(origin.lat);
  const lonWrapped = ((r.lon + 180) % 360 + 360) % 360 - 180;
  // Bare degrees are ambiguous; a hemisphere letter costs two characters.
  const latText = `${Math.abs(r.lat).toFixed(3)}° ${r.lat >= 0 ? 'N' : 'S'}`;
  const lonText = `${Math.abs(lonWrapped).toFixed(3)}° ${lonWrapped >= 0 ? 'E' : 'W'}`;

  if (years === 0) {
    return {
      kicker: 'Right now',
      // The sentence is four slots rather than one string, so the dock can
      // rewrite its numbers without rewriting its markup. See renderBar().
      who: origin.name,
      mid: ' is creeping ',
      key: longhand(r.heading),
      tail: ` at ${formatSpeed(r.speedMmYr)}.`,
      meta: metaLine(origin, r, bandNow, band),
      lat: latText,
      lon: lonText,
      shift: 'where it sits today',
      k1: 'Speed', v1: formatSpeed(r.speedMmYr), s1: speedComparison(r.speedMmYr),
      k2: 'Heading', v2: r.heading, s2: `${Math.round(r.headingDeg)}°`,
      k3: 'Climate', v3: band.name, s3: band.hint,
      rot: r.headingDeg,
      foot: 'Drag the dial below — or hit Play — and watch where it goes.',
    };
  }

  const ago = years < 0;
  const cal = calendarYear(years);
  const climateChanged = band.name !== bandNow.name;
  const latShift = r.lat - origin.lat;
  // Where it ended up relative to today, not which way the plate is heading —
  // those are opposite once the clock runs backwards.
  const went = compass(r.bearing);

  return {
    kicker: ago ? `${formatYears(Math.abs(years))} ago` : `In ${formatYears(years)}`,
    who: origin.name,
    mid: ago ? ' sat ' : ' ends up ',
    key: formatDistance(r.displacementKm),
    tail: ` to the ${longhand(went)}${
      climateChanged ? `, ${ago ? 'back then in' : 'in'} ${band.zone}` : ''}.`,
    meta: metaLine(origin, r, bandNow, band),
    lat: latText,
    lon: lonText,
    shift: `${cal ? `${cal} · ` : ''}${signed(latShift, 1)}° of latitude`,
    k1: ago ? 'It has moved' : 'It travels',
    v1: formatDistance(r.displacementKm),
    s1: distanceComparison(r.displacementKm) || '',
    k2: 'Direction', v2: went, s2: `${Math.round(r.bearing)}°`,
    k3: 'Climate', v3: band.name,
    s3: climateChanged ? `today: ${bandNow.name.toLowerCase()}` : 'same as today',
    rot: r.bearing,
    foot: '',
  };
}

/**
 * The quiet line under the sentence: which slab you are riding, how fast, and
 * what the weather does to you. Three facts, always in that order, always one
 * line — enough to be worth a glance, not enough to be a paragraph. Everything
 * else stays in the sheet.
 */
function metaLine(origin, r, bandNow, band) {
  const climate = band.name === bandNow.name ? band.name : `${bandNow.name} → ${band.name}`;
  return `${origin.plate.name} plate · ${formatSpeed(r.speedMmYr)} · ${climate}`;
}

/* =========================== the one-line answer ========================= */

/**
 * What the dock says. Both modes reduce to the same two strings, because the
 * dock has room for exactly two strings and no more.
 */
const EMPTY = { kicker: '', who: '', mid: '', key: '', tail: '', meta: '' };

export function barFacts(state) {
  if (!state.origin) return EMPTY;
  if (state.mode !== 'compare') return driftFacts(state);

  const { origin, destination } = state;
  if (!destination) {
    return { ...EMPTY,
      kicker: 'Two places',
      meta: `${origin.plate.name} plate · waiting for a second place`,
      who: origin.name,
      tail: ' needs a partner. Pick a second place and we’ll work out when'
          + ' the two of them come closest.',
    };
  }
  const res = state.rendezvous;
  if (!res) return { ...EMPTY, kicker: 'Working…' };
  const v = verdict(res);
  return { ...EMPTY,
    kicker: v.headline,
    tail: v.detail,
    meta: res.sameplate
      ? `Both on the ${origin.plate.name} plate · locked together`
      : `${origin.plate.name} & ${destination.plate.name} plates · ${
          comma(res.nowKm)} km apart today`,
  };
}

/* ============================== the sheet =============================== */

export function renderSheet(state, ctx) {
  if (!state.origin) return '';
  return state.mode === 'compare' ? renderCompare(state, ctx) : renderDrift(state, ctx);
}

function renderDrift(state, ctx) {
  const f = driftFacts(state);
  return `
  <div class="coords">
    <b data-live="lat">${esc(f.lat)}</b>
    <b data-live="lon">${esc(f.lon)}</b>
    <small data-live="shift">${esc(f.shift)}</small>
  </div>

  <div class="tiles">
    ${tile('1', f)}
    ${tile('2', f, true)}
    ${tile('3', f)}
  </div>

  <button class="next-step" data-act="compare">
    <span>Compare with another place<small>when do two patches of ground meet?</small></span>
    <span aria-hidden="true">→</span>
  </button>

  ${foldPlate(state)}
  ${foldNeighbours(state, ctx)}
  ${foldEdges(state)}
  ${foldTrust(state)}`;
}

function tile(n, f, withArrow = false) {
  const arrow = withArrow
    ? `<svg class="arrow" data-live-rot="rot" viewBox="0 0 24 24" aria-hidden="true" focusable="false"
           style="transform:rotate(${f.rot}deg)">
         <path d="M12 3v18M12 3l6 7M12 3 6 10" fill="none" stroke="currentColor"
               stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg> `
    : '';
  return `<div class="tile">
    <div class="t-k" data-live="k${n}">${esc(f[`k${n}`])}</div>
    <div class="t-v">${arrow}<span data-live="v${n}">${esc(f[`v${n}`])}</span></div>
    <div class="t-s" data-live="s${n}">${esc(f[`s${n}`] || '')}</div>
  </div>`;
}

/**
 * Write the current facts into an already-rendered panel.
 * Returns false if the panel is not the one these facts belong to.
 */
export function patch(root, f) {
  if (!root) return false;
  for (const el of root.querySelectorAll('[data-live]')) {
    const v = f[el.dataset.live];
    if (v === undefined || el.textContent === v) continue;
    // Write *into* the existing text node where there is one. Assigning to
    // textContent would drop the node and build a new one, which churns the
    // DOM 60 times a second during Play for no gain.
    const first = el.firstChild;
    if (first && first.nodeType === 3 && !first.nextSibling) first.data = v;
    else el.textContent = v;
  }
  for (const el of root.querySelectorAll('[data-live-html]')) {
    const v = f[el.dataset.liveHtml];
    if (v !== undefined && el.dataset.h !== v) { el.innerHTML = v; el.dataset.h = v; }
  }
  for (const el of root.querySelectorAll('[data-live-rot]')) {
    const v = f[el.dataset.liveRot];
    if (v !== undefined) el.style.transform = `rotate(${v}deg)`;
  }
  return true;
}

/* ------------------------------- the folds ------------------------------ */

function fold(id, title, body, open = false) {
  return `<details class="fold" data-fold="${id}"${open ? ' open' : ''}>
    <summary>${esc(title)}${CHEV}</summary>
    <div class="fold-body">${body}</div>
  </details>`;
}

function foldPlate(state) {
  const { origin } = state;
  const plate = origin.plate;
  const r = project(origin.vec, plate, state.years);
  const poleDist = plate.angleFromPole(origin.vec);

  return fold('plate', `The plate you’re riding`, `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:13px">
      <span class="chip" style="--c:${hsl(plate.hue)};font-size:14px"><i></i>${esc(plate.name)}</span>
    </div>
    <p class="note" style="margin-bottom:12px">A plate turns like a record on a spindle. The
      spindle is called its <strong>Euler pole</strong>; the further you sit from it, the
      faster you travel.</p>
    <div class="rows">
      <div class="row"><span class="k">Speed here</span>
        <span class="v">${esc(formatSpeed(r.speedMmYr))}<small>${esc(speedComparison(r.speedMmYr))}</small></span></div>
      <div class="row"><span class="k">Size</span>
        <span class="v">${esc(formatArea(plate.areaKm2))}<small>${(plate.areaKm2 / 5.101e8 * 100).toFixed(1)}% of the Earth’s surface</small></span></div>
      <div class="row"><span class="k">People aboard</span>
        <span class="v">${formatPopulation(plate.population)}<small>across ${comma(plate.cityCount)} towns &amp; cities</small></span></div>
      <div class="row"><span class="k">Distance to the spindle</span>
        <span class="v">${poleDist.toFixed(0)}°<small>${comma(Math.round(poleDist * 111.19))} km</small></span></div>
      <div class="row"><span class="k">Spindle sits at</span>
        <span class="v mono">${plate.pole[0].toFixed(1)}°, ${plate.pole[1].toFixed(1)}°</span></div>
    </div>`);
}

export function neighbourBody(state, ctx) {
  const { origin, years } = state;
  if (years === 0) {
    return `<p class="note">Run the clock forward and this fills up with the towns that end
      up nearest — the ones riding other plates, which are the only ones whose distance
      from you ever changes.</p>`;
  }
  const list = ctx.placeIndex.nearest(origin.plate.positionAt(origin.vec, years), years, 6, {
    exclude: origin.place, minPopulation: 75000, excludePlate: origin.plate.index,
  });
  if (!list.length) return `<p class="note">Nothing close enough to call a neighbour.</p>`;

  const max = Math.max(...list.map((n) => n.km), 1);
  return `<div class="nbr">${list.map((n) => {
    const was = distanceKm(origin.vec, n.place.vec);
    const closer = n.km < was;
    return `<div>
      <div class="nbr-top">
        <span class="nbr-name">${esc(n.place.shortLabel)}</span>
        <span class="nbr-km">${comma(n.km)} km</span>
      </div>
      <div class="bar" style="--c:${closer ? 'var(--near)' : 'var(--then)'}">
        <i style="width:${Math.max(3, (n.km / max) * 100).toFixed(1)}%"></i></div>
      <div class="nbr-was">${closer
        ? `<span style="color:var(--near)">${comma(was - n.km)} km closer</span>`
        : `<span style="color:var(--then)">${comma(n.km - was)} km further</span>`} than today</div>
    </div>`;
  }).join('')}</div>`;
}

function foldNeighbours(state, ctx) {
  return fold('nbrs', 'Who ends up next door', neighbourBody(state, ctx), true);
}

function foldEdges(state) {
  const borders = (state.origin.plate.neighbourList || []).slice(0, 5);
  if (!borders.length) return '';
  return fold('edges', 'What it’s doing to its neighbours', `
    <div class="rows">
      ${borders.map((b) => {
        const kind = Math.abs(b.opening) < Math.abs(b.sliding) * 0.85
          ? ['slide', 'sliding past'] : b.opening > 0 ? ['rift', 'pulling apart'] : ['crush', 'crashing in'];
        const rate = Math.abs(kind[0] === 'slide' ? b.sliding : b.opening);
        return `<div class="row">
          <span class="k"><span class="chip" style="--c:${hsl(b.plate.hue)};padding:2px 9px 2px 7px;font-size:11.5px"><i style="width:7px;height:7px"></i>${esc(b.plate.name)}</span></span>
          <span class="v"><span class="tag ${kind[0]}">${kind[1]}</span>
            <small>${rate.toFixed(0)} mm/yr along ${comma(b.lengthKm)} km</small></span>
        </div>`;
      }).join('')}
    </div>
    <p class="note" style="margin-top:12px">These are the coloured lines on the globe.</p>`);
}

function foldTrust(state) {
  const far = Math.abs(state.years) > 5e7;
  return fold('trust', 'Should I believe this?', `
    <p class="note">${esc(epochNote(state.years))}</p>
    <p class="note" style="margin-top:10px">The model is real — 56 plates measured over the
      last 780,000 years — but running it forward assumes plates never change course, jam or
      break, which is exactly what plates always do.</p>
    ${far ? `<p class="note" style="margin-top:10px;color:var(--other)">Past 50 million years
      this is a very well-informed daydream, not a prediction.</p>` : ''}`);
}

/* ============================ compare mode ============================== */

function renderCompare(state, ctx) {
  const { destination } = state;

  if (!destination) return pairRows(state);

  const res = state.rendezvous;
  if (!res) return '<p class="note">Working…</p>';

  return `
  ${pairRows(state)}

    ${res.sameplate ? '' : `
    <div class="tiles" style="grid-template-columns:repeat(2,1fr)">
      <div class="tile">
        <div class="t-k">Closest they get</div>
        <div class="t-v">${esc(formatDistance(res.bestKm))}</div>
        <div class="t-s">${comma(res.nowKm)} km apart today</div>
      </div>
      <div class="tile">
        <div class="t-k">When</div>
        <div class="t-v">${res.bestYears < 1e4 ? 'now' : esc(formatYearsShort(res.bestYears))}</div>
        <div class="t-s">${res.closingMmYr > 0 ? 'closing' : 'drifting apart'} ${Math.abs(res.closingMmYr).toFixed(0)} mm/yr</div>
      </div>
    </div>`}

    <button class="next-step" data-act="uncompare">
      <span>Back to one place<small>where does my ground go?</small></span>
      <span aria-hidden="true">←</span>
    </button>

  ${res.sameplate ? '' : fold('chart', 'How far apart, over time', chartBody(state), true)}
  ${res.sameplate ? '' : fold('arrival', 'The literal question', arrivalBody(state))}
  ${foldTrust(state)}`;
}

function pairRows(state) {
  const row = (anchor, color, id, empty) => `<div class="pair-row" style="--c:${color}">
    <i></i>
    <b${anchor ? '' : ' style="color:var(--faint);font-weight:400"'}>${esc(anchor ? anchor.name : empty)}</b>
    <button data-act="pick-${id}">${anchor ? 'change' : 'pick'}</button>
  </div>`;
  return `<div class="pair">
    ${row(state.origin, 'var(--now)', 'origin', 'Pick a first place')}
    ${row(state.destination, 'var(--other)', 'dest', 'Pick a second place')}
  </div>`;
}

function chartBody(state) {
  const pts = state.series;
  if (!pts || !pts.length) return '<p class="note">No curve to draw.</p>';
  const W = 320, H = 112, PAD = 4;
  const maxKm = Math.max(...pts.map((p) => p.km));
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const X = (t) => PAD + ((t - t0) / (t1 - t0)) * (W - PAD * 2);
  const Y = (km) => H - 14 - (km / maxKm) * (H - 26);

  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.km).toFixed(1)}`).join('');
  const area = `${d}L${X(t1).toFixed(1)},${H - 14}L${X(t0).toFixed(1)},${H - 14}Z`;
  const best = state.rendezvous;
  const bx = X(Math.min(Math.max(best.bestYears, t0), t1));
  const by = Y(best.bestKm);

  const ticks = [0, 0.5, 1].map((fr) => {
    const t = t0 + (t1 - t0) * fr;
    return `<text class="axis" x="${X(t).toFixed(1)}" y="${H - 2}" text-anchor="${fr === 0 ? 'start' : fr === 1 ? 'end' : 'middle'}">${esc(t === 0 ? 'now' : formatYearsShort(t))}</text>`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
       aria-label="Distance between the two places over time">
    <defs><linearGradient id="chartFade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3DDBFF" stop-opacity=".22"/>
      <stop offset="100%" stop-color="#3DDBFF" stop-opacity="0"/>
    </linearGradient></defs>
    <line class="grid" x1="${PAD}" y1="${H - 14}" x2="${W - PAD}" y2="${H - 14}"/>
    <path class="area" d="${area}"/>
    <path class="curve" d="${d}"/>
    <line class="mark" x1="${bx.toFixed(1)}" y1="6" x2="${bx.toFixed(1)}" y2="${H - 14}"/>
    <circle class="dot" cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="4"/>
    <text class="axis" x="${PAD}" y="10">${comma(maxKm)} km</text>
    ${ticks}
  </svg>
  <p class="note" style="margin-top:8px">The dip is the closest they ever get. Both places
    circle their own spindle, so the curve repeats — apart, together, apart again.</p>`;
}

function arrivalBody(state) {
  const a = state.arrival;
  if (!a) return '';
  const past = a.bestYears < -1e4;
  const now = Math.abs(a.bestYears) <= 1e4;
  return `<p class="note" style="margin-bottom:11px">When does the ground under
    <strong>${esc(state.origin.name)}</strong> pass closest to the coordinates
    <strong>${esc(state.destination.name)}</strong> sits on today — with those coordinates
    held still?</p>
  <div class="rows">
    <div class="row"><span class="k">Closest it ever gets</span><span class="v">${esc(formatDistance(a.bestKm))}</span></div>
    <div class="row"><span class="k">When</span><span class="v">${
      now ? 'right about now' : `${esc(formatYears(Math.abs(a.bestYears)))} ${past ? 'ago' : 'from now'}`
    }</span></div>
  </div>
  ${past ? `<p class="note" style="margin-top:10px">That pass has already happened — the
    ground has been drifting away from those coordinates ever since.</p>` : ''}`;
}

/* ============================== full detail ============================= */

export function fullCoords(anchor) {
  return formatDMS(anchor.lat, anchor.lon);
}

export { esc, formatCoords };
