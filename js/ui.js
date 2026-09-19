/**
 * ui.js — the readouts.
 *
 * Pure-ish rendering: each function takes state and returns an HTML string.
 * main.js owns the state and re-renders; nothing in here reaches back.
 */

import {
  formatYears, formatYearsShort, formatDistance, distanceComparison,
  formatSpeed, speedComparison, formatCoords, formatDMS, formatPopulation,
  formatArea, calendarYear, epochNote, comma, signed, PRESENT_YEAR,
} from './format.js';
import { climateBand, project, distanceKm, R_EARTH_KM, angleBetween, toLonLat } from './tectonics.js';
import { verdict } from './rendezvous.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const hsl = (h, s = 62, l = 58) => `hsl(${h} ${s}% ${l}%)`;

/* ============================== picker =================================== */

const ICON = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11Z"/><circle cx="12" cy="10" r="2.6"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>',
  tap: '<svg viewBox="0 0 24 24"><path d="M9 11V6a2 2 0 1 1 4 0v9"/><path d="M13 11a2 2 0 1 1 4 0v4a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5v-3a2 2 0 0 1 4 0"/></svg>',
  dice: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/></svg>',
};

function slotHTML(anchor, { color, label, id, empty }) {
  if (!anchor) {
    return `<div class="slot is-empty" style="--c:${color}">
      <span class="slot-dot"></span>
      <span class="slot-text"><span class="slot-name" style="color:var(--faint)">${esc(empty)}</span></span>
    </div>`;
  }
  return `<div class="slot" style="--c:${color}">
    <span class="slot-dot"></span>
    <span class="slot-text">
      <span class="slot-name">${esc(anchor.name)}</span>
      <span class="slot-meta">${esc(formatCoords(anchor.lat, anchor.lon))}</span>
    </span>
    <button data-act="clear-${id}">change</button>
  </div>`;
}

export function renderPicker(state) {
  if (state.mode === 'rendezvous') return renderRendezvousPicker(state);

  const a = state.origin;
  return `
  <div class="card">
    <div class="card-h accent">Your anchor</div>
    ${a ? slotHTML(a, { color: 'var(--cyan)', label: 'Origin', id: 'origin', empty: '' })
        : `<button class="big-btn" data-act="geolocate" ${state.locating ? 'disabled' : ''}>
             ${ICON.pin}
             <span>${state.locating ? 'Finding you…' : 'Use my location'}
               <small>stays on your device — nothing is sent anywhere</small></span>
           </button>
           <div class="or">or</div>`}
    <div class="search" style="${a ? 'margin-top:12px' : ''}">
      ${ICON.search}
      <input id="searchInput" type="search" autocomplete="off" spellcheck="false"
             placeholder="Search a city or town…" value="${esc(state.query || '')}" />
    </div>
    <div class="results" id="searchResults"></div>
    <div class="btn-row">
      <button class="mini-btn" data-act="surprise">${ICON.dice.replace('<svg', '<svg style="width:13px;height:13px;vertical-align:-2px;margin-right:4px;fill:none;stroke:currentColor;stroke-width:1.7"')} Surprise me</button>
      ${a ? '<button class="mini-btn" data-act="share">Copy link</button>' : ''}
    </div>
    <div class="hint">
      ${ICON.tap.replace('<svg', '<svg style="fill:none;stroke:currentColor;stroke-width:1.7"')}
      <span>You can also tap anywhere on the globe — even mid-ocean — to drop your pin there.</span>
    </div>
  </div>`;
}

function renderRendezvousPicker(state) {
  const active = state.pickTarget || 'origin';
  return `
  <div class="card">
    <div class="card-h accent">Two places</div>
    <div class="rows" style="gap:10px">
      <div>
        <div class="lbl" style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-bottom:5px">From</div>
        ${slotHTML(state.origin, { color: 'var(--cyan)', id: 'origin', empty: 'Pick a starting place' })}
      </div>
      <div>
        <div class="lbl" style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin:4px 0 5px">To</div>
        ${slotHTML(state.destination, { color: 'var(--amber)', id: 'dest', empty: 'Pick a destination' })}
      </div>
    </div>

    <div class="btn-row" style="margin-top:14px">
      <button class="mini-btn ${active === 'origin' ? 'is-on' : ''}" data-act="target-origin">Set “from”</button>
      <button class="mini-btn ${active === 'dest' ? 'is-on' : ''}" data-act="target-dest">Set “to”</button>
      <button class="mini-btn" data-act="swap">Swap</button>
    </div>

    ${state.origin === null ? `<button class="big-btn" style="margin-top:12px" data-act="geolocate">
        ${ICON.pin}<span>Use my location<small>for the “from” slot</small></span></button>` : ''}

    <div class="search" style="margin-top:12px">
      ${ICON.search}
      <input id="searchInput" type="search" autocomplete="off" spellcheck="false"
             placeholder="Search a place for “${active === 'origin' ? 'from' : 'to'}”…" value="${esc(state.query || '')}" />
    </div>
    <div class="results" id="searchResults"></div>

    <div class="hint">
      ${ICON.tap.replace('<svg', '<svg style="fill:none;stroke:currentColor;stroke-width:1.7"')}
      <span>Tapping the globe fills the highlighted slot.</span>
    </div>
  </div>`;
}

export function renderSearchResults(places) {
  return places.map((p, i) => `
    <button data-place="${p.index}" ${i === 0 ? 'class="is-active"' : ''}>
      <span class="r-name">${esc(p.name)}${p.capital === 2 ? ' <span style="color:var(--amber);font-size:10px">★</span>' : ''}</span>
      <span class="r-meta">${esc([p.admin, p.country].filter(Boolean).join(' · '))}${p.population ? ' — ' + formatPopulation(p.population) : ''}</span>
    </button>`).join('');
}

/* ============================== readout ================================== */

export function renderReadout(state, ctx) {
  if (!state.origin) return emptyState(state);
  return state.mode === 'rendezvous' ? renderRendezvous(state, ctx) : renderDrift(state, ctx);
}

function emptyState(state) {
  return `<div class="card">
    <div class="card-h">Nothing pinned yet</div>
    <p class="note">Pick a spot and the Earth will start telling you where it is going.
    Everything on this globe is moving right now — just very, very slowly.</p>
    <p class="note" style="margin-top:10px">The fastest crust on the planet, out in the
    Pacific, covers about <strong style="color:var(--text)">10&nbsp;cm a year</strong>.
    The slowest barely manages a centimetre.</p>
  </div>`;
}

/* ------------------------------- drift ---------------------------------- */

function renderDrift(state, ctx) {
  const { origin, years } = state;
  const { placeIndex, model } = ctx;
  const plate = origin.plate;
  const r = project(origin.vec, plate, years);
  const band = climateBand(r.lat);
  const bandNow = climateBand(origin.lat);
  const cal = calendarYear(years);
  const hue = plate.hue;

  // Only other plates are interesting here: anywhere on your own plate keeps
  // exactly the distance it has today, however long you wait.
  const neighbours = years === 0 ? []
    : placeIndex.nearest(r.vec, years, 6, {
        exclude: origin.place, minPopulation: 75000, excludePlate: plate.index,
      });
  const nowDistances = neighbours.map((n) =>
    distanceKm(origin.vec, n.place.vec));

  const borders = (plate.neighbourList || []).slice(0, 5);

  return `
  ${heroCard(state, r, cal, band, bandNow)}
  ${anchorCard(origin, hue)}
  ${plateCard(plate, origin, r, hue)}
  ${years !== 0 ? neighbourCard(neighbours, nowDistances) : ''}
  ${borders.length ? borderCard(borders, plate) : ''}
  ${epochCard(years)}`;
}

function heroCard(state, r, cal, band, bandNow) {
  const { years } = state;
  if (years === 0) {
    return `<div class="card hero">
      <div class="card-h accent">Right now</div>
      <div class="big cyan">${esc(formatCoords(r.lat, r.lon))}</div>
      <div class="sub">${esc(state.origin.name)}</div>
      <div class="rows" style="margin-top:14px">
        <div class="row"><span class="k">Ground speed</span><span class="v">${formatSpeed(r.speedMmYr)}
          <small>${esc(speedComparison(r.speedMmYr))}</small></span></div>
        <div class="row"><span class="k">Heading</span><span class="v">${r.heading} · ${Math.round(r.headingDeg)}°</span></div>
        <div class="row"><span class="k">Climate band</span><span class="v">${band.name}</span></div>
      </div>
      <p class="note" style="margin-top:12px">Drag the slider below to run the clock forward —
        or back.</p>
    </div>`;
  }

  const dir = years > 0 ? 'in' : 'ago';
  const moved = formatDistance(r.displacementKm);
  const cmp = distanceComparison(r.displacementKm);
  const latShift = r.lat - state.origin.lat;

  return `<div class="card hero">
    <div class="card-h accent">${years > 0 ? 'Where it ends up' : 'Where it came from'}</div>
    <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
      <span class="big coral">${esc(formatYearsShort(years))}</span>
      <span class="sub" style="margin:0">${dir === 'in' ? 'from now' : 'ago'}${cal ? ' · ' + esc(cal) : ''}</span>
    </div>

    <div class="split" style="margin-top:16px">
      <div>
        <div class="lbl">Latitude</div>
        <div class="mono" style="font-size:16px;font-weight:500">${esc(r.lat.toFixed(4))}°</div>
        <div class="note">${signed(latShift, 2)}° from today</div>
      </div>
      <div>
        <div class="lbl">Longitude</div>
        <div class="mono" style="font-size:16px;font-weight:500">${esc((((r.lon + 180) % 360 + 360) % 360 - 180).toFixed(4))}°</div>
        <div class="note">${esc(band.name)} zone</div>
      </div>
    </div>

    <div class="rows" style="margin-top:16px">
      <div class="row"><span class="k">Distance travelled</span>
        <span class="v">${esc(moved)}${cmp ? `<small>${esc(cmp)}</small>` : ''}</span></div>
      <div class="row"><span class="k">Direction</span>
        <span class="v">
          <svg viewBox="0 0 24 24" class="arrow" style="width:13px;height:13px;transform:rotate(${r.bearing}deg)">
            <path d="M12 3v18M12 3l6 7M12 3 6 10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          ${esc(r.heading)} · ${Math.round(r.bearing)}°</span></div>
      ${bandNow.name !== band.name ? `<div class="row"><span class="k">Climate shift</span>
        <span class="v">${esc(bandNow.name)} → ${esc(band.name)}<small>${esc(band.hint)}</small></span></div>` : ''}
      ${r.turnsAroundPole > 0.02 ? `<div class="row"><span class="k">Turns about the pole</span>
        <span class="v">${r.turnsAroundPole.toFixed(2)}</span></div>` : ''}
    </div>
  </div>`;
}

function anchorCard(origin, hue) {
  return `<div class="card">
    <div class="card-h">Anchor</div>
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
      <div style="min-width:0">
        <div style="font-weight:600;font-size:15px">${esc(origin.name)}</div>
        <div class="mono note" style="margin-top:3px">${esc(formatDMS(origin.lat, origin.lon))}</div>
      </div>
      <span class="chip" style="--c:${hsl(hue)}"><i></i>${esc(origin.plate.code)}</span>
    </div>
    ${origin.detail ? `<p class="note" style="margin-top:9px">${esc(origin.detail)}</p>` : ''}
  </div>`;
}

function plateCard(plate, origin, r, hue) {
  const poleDist = plate.angleFromPole(origin.vec);
  return `<div class="card">
    <div class="card-h">Your plate</div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:13px">
      <span class="chip" style="--c:${hsl(hue)};font-size:14px"><i></i>${esc(plate.name)}</span>
      <span class="note mono">${esc(plate.code === plate.morvelCode ? plate.code : `${plate.code} · ${plate.morvelCode}`)}</span>
    </div>
    <div class="rows">
      <div class="row"><span class="k">Ground speed here</span>
        <span class="v">${formatSpeed(r.speedMmYr)}<small>${esc(speedComparison(r.speedMmYr))}</small></span></div>
      <div class="row"><span class="k">Heading</span><span class="v">${esc(r.heading)} · ${Math.round(r.headingDeg)}°</span></div>
      <div class="row"><span class="k">Plate area</span><span class="v">${esc(formatArea(plate.areaKm2))}
        <small>${(plate.areaKm2 / 5.101e8 * 100).toFixed(1)}% of Earth’s surface</small></span></div>
      <div class="row"><span class="k">People aboard</span><span class="v">${formatPopulation(plate.population)}
        <small>across ${comma(plate.cityCount)} towns &amp; cities</small></span></div>
      <div class="row"><span class="k">Euler pole</span>
        <span class="v mono">${plate.pole[0].toFixed(2)}°, ${plate.pole[1].toFixed(2)}°
          <small>${plate.pole[2].toFixed(3)}° per million years</small></span></div>
      <div class="row"><span class="k">Your distance from it</span>
        <span class="v">${poleDist.toFixed(1)}°
          <small>${comma(poleDist * 111.19)} km — sit on the pole and you would not move at all</small></span></div>
    </div>
    <p class="note" style="margin-top:11px">Every point on this plate swings around that one
      axis. The further you sit from it, the faster you travel.</p>
  </div>`;
}

function neighbourCard(neighbours, nowDistances) {
  if (!neighbours.length) return '';
  const max = Math.max(...neighbours.map((n) => n.km), 1);
  return `<div class="card">
    <div class="card-h">New neighbours</div>
    <div class="nbr">
      ${neighbours.map((n, i) => {
        const was = nowDistances[i];
        const closer = n.km < was;
        return `<div class="nbr-item">
          <div class="nbr-top">
            <span class="nbr-name">${esc(n.place.shortLabel)}</span>
            <span class="nbr-km">${comma(n.km)} km</span>
          </div>
          <div class="bar" style="--c:${closer ? 'var(--mint)' : 'var(--coral)'}">
            <i style="width:${Math.max(3, (n.km / max) * 100)}%"></i></div>
          <div class="nbr-was">today ${comma(was)} km away —
            ${closer ? `<span style="color:var(--mint)">${comma(was - n.km)} km closer</span>`
                     : `<span style="color:var(--coral)">${comma(n.km - was)} km further</span>`}</div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function borderCard(borders, plate) {
  return `<div class="card">
    <div class="card-h">What it’s doing to the neighbours</div>
    <div class="rows">
      ${borders.map((b) => {
        const kind = Math.abs(b.opening) < Math.abs(b.sliding) * 0.85
          ? ['slide', 'sliding past'] : b.opening > 0 ? ['rift', 'pulling apart'] : ['crush', 'colliding'];
        const rate = Math.abs(kind[0] === 'slide' ? b.sliding : b.opening);
        return `<div class="row">
          <span class="k"><span class="chip" style="--c:${hsl(b.plate.hue)};padding:2px 9px 2px 7px;font-size:11.5px"><i style="width:7px;height:7px"></i>${esc(b.plate.name)}</span></span>
          <span class="v"><span class="tag ${kind[0]}">${kind[1]}</span>
            <small>${rate.toFixed(0)} mm/yr over ${comma(b.lengthKm)} km</small></span>
        </div>`;
      }).join('')}
    </div>
    <p class="note" style="margin-top:11px">Pulling apart makes new sea floor. Colliding
      destroys it — that is where trenches, volcanoes and the big earthquakes live.</p>
  </div>`;
}

function epochCard(years) {
  return `<div class="card">
    <div class="card-h">For scale</div>
    <p class="note" style="color:var(--dim);font-size:13px">${esc(epochNote(years))}</p>
    ${Math.abs(years) > 5e7 ? `<p class="note" style="margin-top:9px;color:var(--amber)">
      Past about 50 million years this is extrapolation for fun, not prediction. Plates
      change course, jam up and break apart — this model assumes they never do.</p>` : ''}
  </div>`;
}

/* ---------------------------- rendezvous -------------------------------- */

function renderRendezvous(state, ctx) {
  const { origin, destination } = state;
  if (!destination) {
    return `<div class="card">
      <div class="card-h">Pick a second place</div>
      <p class="note">Choose somewhere else on Earth and this will work out when — if ever —
        the two patches of ground come closest together, and how near they get.</p>
      <p class="note" style="margin-top:10px">Try Goa and Tokyo. Or London and New York,
        which are drifting apart at about the rate your fingernails grow.</p>
    </div>`;
  }

  const res = state.rendezvous;
  if (!res) return `<div class="card"><div class="card-h">Working…</div></div>`;
  const v = verdict(res);
  const nowKm = res.nowKm;

  return `
  <div class="card hero">
    <div class="card-h accent">Verdict</div>
    <div class="big ${v.tone === 'meet' ? 'cyan' : 'coral'}">${esc(v.headline)}</div>
    <p class="sub">${esc(v.detail)}</p>
    ${res.sameplate ? '' : `
    <div class="split" style="margin-top:18px">
      <div>
        <div class="lbl">Closest approach</div>
        <div class="big sm">${esc(formatDistance(res.bestKm))}</div>
      </div>
      <div>
        <div class="lbl">When</div>
        <div class="big sm">${res.bestYears < 1e4 ? 'now' : esc(formatYearsShort(res.bestYears))}</div>
      </div>
    </div>`}
    ${state.rendezvousPast && !res.sameplate && state.rendezvousPast.bestKm < res.bestKm * 0.92
      ? `<p class="note" style="margin-top:14px;color:var(--violet)">They were closer once:
         ${comma(state.rendezvousPast.bestKm)} km apart,
         ${esc(formatYearsShort(Math.abs(state.rendezvousPast.bestYears)))} ago.</p>` : ''}
  </div>

  <div class="card">
    <div class="card-h">Right now</div>
    <div class="rows">
      <div class="row"><span class="k">Distance apart</span><span class="v">${comma(nowKm)} km</span></div>
      <div class="row"><span class="k">Closing speed</span>
        <span class="v" style="color:${res.closingMmYr > 0 ? 'var(--mint)' : 'var(--coral)'}">
          ${res.closingMmYr > 0 ? 'approaching' : 'separating'} ${Math.abs(res.closingMmYr).toFixed(1)} mm/yr
          <small>${Math.abs(res.closingMmYr).toFixed(0)} m every thousand years</small></span></div>
      <div class="row"><span class="k">${esc(state.origin.plate.name)}</span>
        <span class="v mono">${formatSpeed(state.origin.plate.motionAt(state.origin.vec).speed)}</span></div>
      <div class="row"><span class="k">${esc(destination.plate.name)}</span>
        <span class="v mono">${formatSpeed(destination.plate.motionAt(destination.vec).speed)}</span></div>
    </div>
  </div>

  ${res.sameplate ? '' : chartCard(state)}
  ${res.sameplate ? '' : arrivalCard(state)}
  ${res.upcoming && res.upcoming.length > 1 ? encountersCard(res) : ''}
  ${epochCard(res.bestYears || 0)}`;
}

function chartCard(state) {
  const pts = state.series;
  if (!pts || !pts.length) return '';
  const W = 330, H = 116, PAD = 4;
  const maxKm = Math.max(...pts.map((p) => p.km));
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const X = (t) => PAD + ((t - t0) / (t1 - t0)) * (W - PAD * 2);
  const Y = (km) => H - 14 - (km / maxKm) * (H - 26);

  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.km).toFixed(1)}`).join('');
  const area = `${d}L${X(t1).toFixed(1)},${H - 14}L${X(t0).toFixed(1)},${H - 14}Z`;
  const best = state.rendezvous;
  const bx = X(Math.min(Math.max(best.bestYears, t0), t1));
  const by = Y(best.bestKm);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const t = t0 + (t1 - t0) * f;
    return `<text class="axis" x="${X(t).toFixed(1)}" y="${H - 2}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${esc(t === 0 ? 'now' : formatYearsShort(t))}</text>`;
  }).join('');

  return `<div class="card">
    <div class="card-h">How far apart, over time</div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"
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
    <p class="note" style="margin-top:8px">The dip is the closest they ever get. Because both
      places are circling their own axis, the curve repeats — they drift apart, then back
      together, over and over.</p>
  </div>`;
}

function arrivalCard(state) {
  const a = state.arrival;
  if (!a) return '';
  const past = a.bestYears < -1e4;
  const now = Math.abs(a.bestYears) <= 1e4;
  return `<div class="card">
    <div class="card-h">The literal question</div>
    <p class="note" style="margin-bottom:11px">When does <strong style="color:var(--text)">${esc(state.origin.name)}</strong>’s
      ground pass closest to the coordinates <strong style="color:var(--text)">${esc(state.destination.name)}</strong>
      sits on today — with the destination held still?</p>
    <div class="rows">
      <div class="row"><span class="k">Closest it ever gets</span><span class="v">${esc(formatDistance(a.bestKm))}</span></div>
      <div class="row"><span class="k">When</span><span class="v">${
        now ? 'right about now' : `${esc(formatYears(Math.abs(a.bestYears)))} ${past ? 'ago' : 'from now'}`
      }</span></div>
    </div>
    ${past ? `<p class="note" style="margin-top:10px">That pass has already happened — on this
      model the ground under ${esc(state.origin.name)} has been drifting away from those
      coordinates ever since.</p>` : ''}
  </div>`;
}

function encountersCard(res) {
  return `<div class="card">
    <div class="card-h">Near misses ahead</div>
    <div class="rows">
      ${res.upcoming.map((c) => `<div class="row">
        <span class="k">${esc(formatYearsShort(c.years))} from now</span>
        <span class="v">${comma(c.km)} km apart</span></div>`).join('')}
    </div>
  </div>`;
}

export { esc };
