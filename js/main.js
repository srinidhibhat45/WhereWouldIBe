/**
 * main.js — state, wiring, and the frame loop.
 *
 * The app has two stages and never both at once:
 *
 *   pick     one card in the bottom dock: find a place. Nothing else.
 *   explore  the same dock becomes one sentence and the time dial.
 *
 * Nothing ever floats over the middle of the screen, because the middle of the
 * screen is the globe and the globe is the answer. The sheet is the single
 * exception and it only exists while somebody is holding it open.
 *
 * Time changes patch text in place rather than re-rendering. Dragging the dial
 * should move the globe and the numbers — not the layout.
 */

import { PlateModel, toVec, toLonLat, distanceKm, R_EARTH_KM } from './tectonics.js';
import { PlaceIndex } from './places.js';
import { Globe, THREE } from './globe.js';
import { GlobeControls } from './controls.js';
import { Markers, COLORS } from './markers.js';
import { closestApproach, arrivalAt, distanceSeries } from './rendezvous.js';
import {
  renderSheet, renderSearchResults, driftFacts, barFacts, patch, neighbourBody, esc,
} from './ui.js';
import { formatYearsShort, formatYears, calendarYear, formatDistance } from './format.js';

/* ------------------------------ time mapping ----------------------------- */

const MAX_YEARS = 5e8;
const SLIDER_MAX = 2000;
const K = 16;
const DEN = Math.exp(K) - 1;

const sliderToYears = (v) =>
  Math.sign(v) * MAX_YEARS * ((Math.exp((K * Math.abs(v)) / SLIDER_MAX) - 1) / DEN);
const yearsToSlider = (y) =>
  Math.sign(y) * (SLIDER_MAX * Math.log((Math.abs(y) / MAX_YEARS) * DEN + 1)) / K;

/* Five stops. Eight was a wall; six did not fit a phone without the last one
   hanging half off the edge, which reads as broken rather than as scrollable. */
const PRESETS = [
  ['1 kyr', 1e3], ['1 Myr', 1e6],
  ['10 Myr', 1e7], ['50 Myr', 5e7], ['250 Myr', 2.5e8],
];

/* --------------------------------- state --------------------------------- */

const state = {
  stage: 'pick',          // 'pick' | 'explore'
  mode: 'drift',          // 'drift' | 'compare'
  years: 0,
  origin: null,
  destination: null,
  pickTarget: 'origin',
  query: '',
  locating: false,
  playing: false,
  rendezvous: null,
  arrival: null,
  series: null,
  showOrbit: false,
};

let model, placeIndex, globe, controls, markers;
const $ = (id) => document.getElementById(id);
const labelEls = new Map();

/** Which detail folds the reader has opened — kept across re-renders. */
const openFolds = new Set(['nbrs', 'chart']);

/* --------------------------------- boot ---------------------------------- */

const BOOT_LINES = [
  'Winding the clock…',
  'Unfolding 52 tectonic plates…',
  'Measuring how fast the ground moves…',
  'Stitching coastlines onto a sphere…',
  'Looking up 9,000 places…',
  'Lighting the mantle…',
];

async function boot() {
  const t0 = performance.now();
  const bar = $('bootBar'), status = $('bootStatus');
  const marks = [];
  let lastMark = t0;
  const mark = (label) => {
    const now = performance.now();
    marks.push(`${label} ${Math.round(now - lastMark)}ms`);
    lastMark = now;
  };
  const tick = (pct, line) => {
    bar.style.width = `${pct}%`;
    if (line !== undefined) status.textContent = line;
  };

  try {
    tick(8, BOOT_LINES[0]);
    const [plates, land, borders, places] = await Promise.all([
      fetchJSON('data/plates.json', () => tick(26, BOOT_LINES[1])),
      fetchJSON('data/land.json', () => tick(38, BOOT_LINES[3])),
      fetchJSON('data/borders.json'),
      fetchJSON('data/places.json', () => tick(48, BOOT_LINES[4])),
    ]);

    mark('fetch');
    tick(56, BOOT_LINES[2]);
    model = new PlateModel(plates.plates);
    mark('plateModel');
    placeIndex = new PlaceIndex(places, model);
    mark('placeIndex');

    tick(66, BOOT_LINES[5]);
    await nextFrame();

    globe = new Globe($('globe'), model);
    globe.resize();
    controls = new GlobeControls(globe.camera, $('globe'), THREE);
    controls.autoRotateSpeed = 0.9;      // a slow turn while you decide, and no more
    mark('scene');

    tick(76, BOOT_LINES[3]);
    await nextFrame();
    globe.buildWorld({ plates: model.plates, land: land.polygons, borders: borders.rings });
    mark('buildWorld');

    markers = new Markers(globe);
    applyQuietDefaults();
    mark('markers');
    tick(94);
    await nextFrame();

    fillSources(plates.source);
    buildTimeUI();
    bindEvents();          // measures the dock, which gives us controls.fitDist
    controls.dist = controls.target.dist = controls.fitDist;
    restoreFromHash();
    renderAll();
    mark('ui');
    startLoop();

    tick(100);
    // A handle for poking at the model from the console — this is a toy about
    // geology; people should be able to take it apart.
    window.wwib = { state, model, placeIndex, globe, controls, markers, setYears, setAnchor, makeAnchor };
    console.log('BOOT', Math.round(performance.now() - t0) + 'ms |', marks.join(' | '), '| layers', JSON.stringify(globe.buildTimes));
    setTimeout(() => $('boot').classList.add('done'), 320);
  } catch (err) {
    console.error(err);
    status.innerHTML = 'Could not start.';
    const hint = location.protocol === 'file:'
      ? 'This app loads its data with fetch(), which browsers block on <code>file://</code>. Run a local server — <code>node tools/serve.mjs</code> — and open the localhost address.'
      : esc(err.message || String(err));
    status.insertAdjacentHTML('afterend', `<p class="boot-error">${hint}</p>`);
  }
}

async function fetchJSON(url, after) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status} ${r.statusText}`);
  const j = await r.json();
  if (after) after();
  return j;
}

/**
 * Yield so the loading screen can repaint between heavy steps.
 *
 * requestAnimationFrame never fires in a background tab, so this races it
 * against a timer — otherwise opening the app in a tab you are not looking at
 * would leave it stuck on the splash for ever.
 */
const nextFrame = () => new Promise((resolve) => {
  let done = false;
  const go = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(() => setTimeout(go, 0));
  setTimeout(go, 80);
});

/**
 * Six line styles at once is not a map, it is a migraine — and nobody opened
 * this to be taught plate tectonics, they opened it to find out where their
 * ground goes. So the globe starts as sea, land and coastlines, and nothing
 * else. The boundaries are the most interesting thing you can add, so they get
 * the top slot in the Detail menu; switching them on brings their key with
 * them, which is the only honest way to put a coloured line on a screen.
 */
function applyQuietDefaults() {
  globe.setLayerVisible('graticule', false);
  globe.setLayerVisible('borders', false);
  globe.setLayerVisible('plateColors', false);
  setOrbitVisible(false);
  setEdgesVisible(false);
}

/** The lines and their key are one feature, so they switch as one. */
function setEdgesVisible(on) {
  globe.setLayerVisible('plateEdges', on);
  $('legend').hidden = !on;
  const box = $('detailMenu').querySelector('[data-layer="plateEdges"]');
  if (box) box.checked = on;
}

function fillSources(src) {
  $('sourceList').innerHTML = Object.entries({
    'Plate motions': src.motion,
    'Plate outlines': src.plates,
    'Coastlines & borders': src.coastlines,
    'Place names': src.places,
  }).map(([k, v]) => `<li><strong style="color:var(--dim)">${esc(k)}:</strong> ${esc(v)}</li>`).join('');
}

/* ------------------------------- anchors --------------------------------- */

/** Build the object the whole app passes around for "a spot on the Earth". */
function makeAnchor(lon, lat, { name, detail, place } = {}) {
  const vec = toVec(lon, lat);
  const plate = model.at(lon, lat);
  if (!name) {
    const near = placeIndex.nearestNow(vec);
    if (near && near.km < 26) {
      name = near.place.shortLabel;
      detail = `Nearest settlement, ${formatDistance(near.km)} away.`;
    } else if (near) {
      name = `Near ${near.place.shortLabel}`;
      detail = `${formatDistance(near.km)} from ${near.place.name}. Open water or open country.`;
    } else {
      name = 'Somewhere on Earth';
    }
  }
  return { lon, lat, vec, plate, name, detail, place: place || null };
}

function setAnchor(which, anchor, { fly = true } = {}) {
  if (which === 'origin') {
    state.origin = anchor;
    markers.setOrigin(anchor ? { vec: anchor.vec, plate: anchor.plate } : null);
  } else {
    state.destination = anchor;
    markers.setDestination(anchor ? { vec: anchor.vec, plate: anchor.plate } : null);
  }
  setOrbitVisible(state.showOrbit);

  if (anchor && fly) {
    const pair = state.mode === 'compare' && state.origin && state.destination
      ? frameBoth(state.origin, state.destination) : null;
    controls.flyTo(pair || { lon: anchor.lon, lat: anchor.lat, dist: controls.fitDist || 4.3 }, 1200);
  }

  state.query = '';
  // Picking is done as soon as the slot this stage was opened for is filled.
  if (anchor) {
    const needsSecond = state.mode === 'compare' && !state.destination;
    state.pickTarget = needsSecond ? 'dest' : 'origin';
    setStage(needsSecond && which === 'origin' ? 'pick' : 'explore');
  }
  recompute();
  renderAll();
  writeHash();
}

/** A camera position that fits both anchors in view at once. */
function frameBoth(a, b) {
  const mid = toLonLat({ x: (a.vec.x + b.vec.x) / 2, y: (a.vec.y + b.vec.y) / 2, z: (a.vec.z + b.vec.z) / 2 });
  const sepDeg = (distanceKm(a.vec, b.vec) / R_EARTH_KM) * (180 / Math.PI);
  // Two places on opposite sides of the Earth need more room than two in the
  // same county, but never less than the distance that fits the globe at all.
  const fit = controls.fitDist || 4.3;
  return { lon: mid[0], lat: mid[1], dist: Math.min(controls.maxDist - 0.2, fit * (0.86 + (sepDeg / 180) * 0.5)) };
}

/* ------------------------------ computation ------------------------------ */

function recompute() {
  if (state.mode !== 'compare' || !state.origin || !state.destination) {
    state.rendezvous = state.rendezvousPast = state.arrival = state.series = null;
    return;
  }
  const a = state.origin, b = state.destination;
  state.rendezvous = closestApproach(a.vec, a.plate, b.vec, b.plate, { from: 0, to: 1e9, samples: 9000 });
  state.rendezvousPast = closestApproach(a.vec, a.plate, b.vec, b.plate, { from: -1e9, to: 0, samples: 9000 });
  state.arrival = arrivalAt(a.vec, a.plate, b.vec, { from: -1e9, to: 1e9, samples: 18000 });
  if (!state.rendezvous.sameplate) {
    const span = Math.min(1e9, Math.max(6e7, state.rendezvous.bestYears * 2.4));
    state.series = distanceSeries(a.vec, a.plate, b.vec, b.plate, 0, span, 300);
  } else {
    state.series = null;
  }
}

/* --------------------------------- stages -------------------------------- */

/**
 * The dock's height depends on how its contents wrap, and the legend and the
 * answer sheet both stack above it on a phone. Measure rather than guess — and
 * re-measure on a stage change, since the two docks are different heights.
 */
let lastDockH = -1, lastSide = -1;
function syncDockHeight() {
  const dock = state.stage === 'pick' ? $('start') : $('timebar');
  const h = Math.ceil(dock.offsetHeight) + 12;
  const sideNow = $('sheet').hidden ? 0 : Math.max(0, window.innerWidth - $('sheet').getBoundingClientRect().left);
  if (h === lastDockH && sideNow === lastSide) return;
  lastDockH = h; lastSide = sideNow;
  document.documentElement.style.setProperty('--dock-h', `${h}px`);
  // And tell the globe, so the planet centres itself in the gap that is left
  // rather than behind the dock. This is the difference between looking at the
  // Earth and looking at the top third of the Earth.
  if (globe) {
    // A sheet docked to the side is chrome too, so the globe steps out of its
    // way rather than hiding a limb behind it.
    globe.setFrame($('topbar').offsetHeight, h, sideNow);
    controls.fitDist = fitDistance(h, sideNow);
  }
}

/**
 * How far back the camera has to sit for the whole planet to fit in the gap
 * between the top bar and the dock.
 *
 * A sphere of radius 1 seen from `dist` through a vertical field of view `fov`
 * covers `2h / (2·dist·tan(fov/2))` pixels of a canvas `h` pixels tall — note
 * that aspect ratio cancels, so the same number governs width. Invert it for
 * the distance that makes the globe exactly `want` pixels across.
 *
 * `want` is the smaller of the free band and the canvas width, less a hair so
 * the globe sits inside the screen instead of bleeding off the sides.
 */
function fitDistance(dockH, side = 0) {
  const w = window.innerWidth, h = window.innerHeight;
  const band = Math.max(160, h - $('topbar').offsetHeight - dockH);
  const want = Math.min(band, Math.max(240, w - side)) * 0.97;
  const tan = Math.tan((globe.camera.fov * Math.PI / 180) / 2);
  return clamp(h / (want * tan), controls.minDist + 0.4, controls.maxDist - 0.2);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function setStage(stage) {
  state.stage = stage;
  document.body.classList.toggle('stage-pick', stage === 'pick');
  document.body.classList.toggle('stage-explore', stage === 'explore');
  lastDockH = -1;                 // the other dock is a different height
  syncDockHeight();
  // The globe turns gently while you are choosing, and holds still while you read.
  controls.autoRotate = stage === 'pick' && !state.origin;
  if (stage === 'pick') {
    $('searchResults').innerHTML = '';
    $('searchInput').value = '';
    // Focus is a nudge, not a hijack: skip it on touch so no keyboard pops up.
    if (matchMedia('(hover: hover)').matches) setTimeout(() => $('searchInput').focus(), 340);
  }
}

/* -------------------------------- render --------------------------------- */

function renderAll() {
  renderStart();
  renderChip();
  renderSheetBody();
  setYears(state.years);
}

function renderStart() {
  const second = state.mode === 'compare' && state.pickTarget === 'dest';
  const changing = !!state.origin && !second;

  $('startTitle').innerHTML = second
    ? 'Pick a second place'
    : changing ? 'Pick a different place'
    : 'Where would&nbsp;I&nbsp;be<em>…?</em>';

  $('startLede').textContent = second
    ? 'Both places ride their own plate. We’ll work out when — if ever — they come closest together.'
    : changing ? 'Search, tap the globe, or use your location again.'
    : 'The ground under your feet is moving — about as fast as your fingernails grow. Pick a spot and we’ll run the clock forward.';

  $('geoBtn').hidden = second;
  $('geoBtn').disabled = state.locating;
  $('geoBtn').querySelector('span').innerHTML = state.locating
    ? 'Finding you…<small>stays on your device</small>'
    : 'Use my location<small>stays on your device — nothing is sent anywhere</small>';
  $('searchInput').placeholder = second ? 'Search the second place…' : 'Search a city or town…';

  const keep = state.origin
    ? `<button class="mini-btn" data-act="keep">← keep ${esc(shortName(second ? state.origin.name : state.origin.name))}</button>`
    : '';
  $('start').querySelector('.start-foot').innerHTML =
    `<button class="mini-btn" data-act="surprise">🎲 Surprise me</button>
     ${keep || '<span class="tip">…or just tap the globe anywhere</span>'}`;
}

const shortName = (n) => (n.length > 18 ? n.slice(0, 17) + '…' : n);

function renderChip() {
  const chip = $('hereChip');
  const a = state.origin;
  chip.hidden = !a || state.stage !== 'explore';
  if (!a) return;
  $('hereName').textContent = state.mode === 'compare' && state.destination
    ? `${shortName(a.name)} ⇄ ${shortName(state.destination.name)}`
    : a.name;
}

/**
 * Full rebuild of the answer panel. Only called when the *shape* changes —
 * a new place, a mode switch, crossing the present day. Scrubbing time never
 * lands here.
 */
let panelSignature = '';
function renderSheetBody({ force = false } = {}) {
  const sig = [
    state.mode, state.origin?.lon, state.origin?.lat,
    state.destination?.lon, state.destination?.lat,
    state.years === 0 ? 'now' : state.years < 0 ? 'past' : 'future',
  ].join('|');
  if (!force && sig === panelSignature) return;
  panelSignature = sig;

  const body = $('sheetBody');
  body.innerHTML = renderSheet(state, { placeIndex, model });
  for (const d of body.querySelectorAll('.fold')) d.open = openFolds.has(d.dataset.fold);
  $('sheetTitle').textContent = !state.origin ? 'Details'
    : state.mode === 'compare' ? 'Two places' : state.origin.name;
  lastFacts = null;
  renderBar();
}

/**
 * The dock's sentence — the one piece of text that changes on every frame of
 * Play. Its markup is written once, in index.html, and never again; each step
 * only writes the four slots, so a scrub causes no DOM churn and no reflow.
 */
function renderBar() {
  if (!state.origin) return;
  patch($('answerBar'), barFacts(state));
  syncDockHeight();   // cheap, and a no-op unless the sentence really did resize
}

let lastFacts = null;
function patchPanel() {
  if (state.mode !== 'drift' || !state.origin) return;
  const f = driftFacts(state);
  if (lastFacts && f.headline === lastFacts.headline && f.v1 === lastFacts.v1) return;
  lastFacts = f;
  patch($('answerBar'), f);
  if (!$('sheet').hidden) patch($('sheetBody'), f);
}

/** Folds hold time-dependent lists; refresh them once the dial settles. */
let foldTimer;
function refreshFoldsSoon() {
  clearTimeout(foldTimer);
  foldTimer = setTimeout(() => {
    if (state.mode !== 'drift' || !state.origin) return;
    if ($('sheet').hidden) return;
    const fold = $('sheetBody').querySelector('[data-fold="nbrs"]');
    if (fold && fold.open) {
      fold.querySelector('.fold-body').innerHTML = neighbourBody(state, { placeIndex, model });
    }
  }, 160);
}

function setYears(y, { fromSlider = false } = {}) {
  const crossed = (state.years === 0) !== (y === 0) || Math.sign(state.years) !== Math.sign(y);
  state.years = y;
  globe.setTime(y);
  markers.update(y);

  $('nowBtn').hidden = y === 0;
  if (!fromSlider) $('timeSlider').value = String(Math.round(yearsToSlider(y)));
  for (const b of $('presets').children) {
    b.classList.toggle('is-on', Math.abs(Math.abs(y) - Number(b.dataset.years)) < 1);
  }

  // Neighbour dots follow the drifting crust.
  if (state.origin && state.mode === 'drift' && y !== 0) {
    const here = state.origin.plate.positionAt(state.origin.vec, y);
    markers.setNeighbours(placeIndex.nearest(here, y, 12, { exclude: state.origin.place }));
  } else {
    markers.clearNeighbours();
  }

  if (crossed) renderSheetBody();
  renderBar();
  patchPanel();
  refreshFoldsSoon();
}

/* ------------------------------- labels ---------------------------------- */

/*
 * Two words, total. The chip at the top already says *where*, so the globe only
 * has to say *when* — one end is today, the other is the year you dialled in.
 * Anything more and the two labels sit on top of each other at short
 * timescales, which is how you end up with a coordinate pair written across
 * somebody's home town.
 *
 * `below` hangs a label under its pin instead of over it, so the pair separate
 * even when the pins themselves are a few pixels apart.
 */
const LABEL_STYLE = {
  origin: { color: COLORS.origin, below: true, text: () => 'today', sub: () => '' },
  future: { color: COLORS.future, text: () => formatYearsShort(state.years), sub: () => '' },
  destination: { color: COLORS.destination, below: true, text: () => shortName(state.destination?.name || ''), sub: () => '' },
  pole: { color: COLORS.pole, text: () => 'the spindle', sub: () => state.origin ? `${state.origin.plate.name} plate` : '' },
};

function updateLabels() {
  const anchors = markers.anchors();
  const seen = new Set();
  for (const a of anchors) {
    if (a.id === 'pole' && !state.showOrbit) continue;
    seen.add(a.id);
    let el = labelEls.get(a.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'glabel';
      $('labels').appendChild(el);
      labelEls.set(a.id, el);
    }
    const style = LABEL_STYLE[a.id];
    const p = globe.project(a.vec, a.radius);
    el.style.setProperty('--c', style.color);
    el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, ${style.below ? '0' : '-100%'})`;
    el.classList.toggle('below', !!style.below);
    el.classList.toggle('hide', !p.visible);
    const sub = style.sub();
    const html = `${esc(style.text())}${sub ? `<small>${esc(sub)}</small>` : ''}`;
    if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; }
  }
  for (const [id, el] of labelEls) {
    if (!seen.has(id)) { el.remove(); labelEls.delete(id); }
  }
}

/* -------------------------------- events --------------------------------- */

function buildTimeUI() {
  $('presets').innerHTML = PRESETS
    .map(([label, y]) => `<button data-years="${y}">${label}</button>`).join('');
}

function bindEvents() {
  const slider = $('timeSlider');
  slider.addEventListener('input', () => {
    stopPlaying();
    setYears(roundYears(sliderToYears(Number(slider.value))), { fromSlider: true });
    writeHashSoon();
  });

  $('presets').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    stopPlaying();
    const mag = Number(b.dataset.years);
    setYears(state.years < 0 ? -mag : mag);
    writeHash();
  });

  $('nowBtn').addEventListener('click', () => { stopPlaying(); setYears(0); writeHash(); });
  $('playBtn').addEventListener('click', togglePlay);

  document.addEventListener('click', onDelegatedClick);
  $('searchInput').addEventListener('input', (e) => onSearch(e.target.value));
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'searchInput' && e.key === 'Enter') {
      const first = $('searchResults')?.querySelector('button');
      if (first) first.click();
    }
    if (e.key === 'Escape') {
      if (!$('sheet').hidden) return closeSheet();
      closeModal();
      $('detailMenu').hidden = true;
      if (state.stage === 'pick' && state.origin) setStageAndRender('explore');
    }
    if (e.key === ' ' && e.target === document.body && state.stage === 'explore') {
      e.preventDefault(); togglePlay();
    }
  });

  // Remember which folds the reader opened, so a rebuild does not close them.
  $('sheetBody').addEventListener('toggle', (e) => {
    const d = e.target.closest('.fold');
    if (!d) return;
    if (d.open) { openFolds.add(d.dataset.fold); refreshFoldsSoon(); }
    else openFolds.delete(d.dataset.fold);
  }, true);

  // Globe interaction: a tap (not a drag) drops a pin. No camera move — the
  // globe jumping away from where you just tapped is disorienting.
  $('globe').addEventListener('click', (e) => {
    if (!controls.wasClick) return;
    const hit = globe.pick(e.clientX, e.clientY);
    if (!hit) return;
    const slot = state.mode === 'compare' && state.pickTarget === 'dest' ? 'dest' : 'origin';
    setAnchor(slot, makeAnchor(hit.lon, hit.lat), { fly: false });
  });

  $('detailBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('detailMenu');
    m.hidden = !m.hidden;
    $('detailBtn').classList.toggle('is-on', !m.hidden);
  });
  $('detailMenu').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    $('detailMenu').hidden = true;
    $('detailBtn').classList.remove('is-on');
  });
  $('detailMenu').addEventListener('change', (e) => {
    const layer = e.target.dataset.layer;
    if (layer === 'orbit') { state.showOrbit = e.target.checked; setOrbitVisible(e.target.checked); }
    else if (layer === 'plateEdges') setEdgesVisible(e.target.checked);
    else globe.setLayerVisible(layer, e.target.checked);
  });

  $('aboutBtn').addEventListener('click', () => { $('aboutModal').hidden = false; });
  $('aboutModal').addEventListener('click', (e) => {
    if (e.target.id === 'aboutModal' || e.target.classList.contains('modal-close')) closeModal();
  });

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(syncDockHeight);
    ro.observe($('timebar')); ro.observe($('start'));
  }
  syncDockHeight();

  window.addEventListener('resize', () => { globe.resize(); syncDockHeight(); });
  window.addEventListener('hashchange', restoreFromHash);
}

const closeModal = () => { $('aboutModal').hidden = true; };

/* The sheet is the only thing allowed to cover the globe, and only for as long
   as the reader is deliberately holding it open. */
function openSheet() {
  renderSheetBody({ force: true });
  $('sheet').hidden = false;
  $('scrim').hidden = false;
  syncDockHeight();
  refreshFoldsSoon();
}
function closeSheet() {
  if ($('sheet').hidden) return;
  $('sheet').hidden = true;
  $('scrim').hidden = true;
  syncDockHeight();
}

function setStageAndRender(stage) {
  setStage(stage);
  renderStart();
  renderChip();
}

function setOrbitVisible(on) {
  const live = on && !!state.origin;
  markers.circle.mesh.visible = live;
  markers.polePin.visible = live;
}

function onDelegatedClick(e) {
  const btn = e.target.closest('[data-act], [data-place]');
  if (!btn) return;

  if (btn.dataset.place !== undefined) {
    const place = placeIndex.places[Number(btn.dataset.place)];
    const anchor = makeAnchor(place.lon, place.lat, { name: place.label, place });
    const slot = state.mode === 'compare' && state.pickTarget === 'dest' ? 'dest' : 'origin';
    setAnchor(slot, anchor);
    $('searchResults').innerHTML = '';
    return;
  }

  switch (btn.dataset.act) {
    case 'details': return openSheet();
    case 'close-sheet': return closeSheet();
    case 'hide-edges': return setEdgesVisible(false);
    case 'geolocate': return geolocate();
    case 'surprise': return surprise();
    case 'repick':
      state.pickTarget = 'origin';
      return setStageAndRender('pick');
    case 'keep':
      return setStageAndRender('explore');
    case 'compare':
      closeSheet();
      state.mode = 'compare';
      state.pickTarget = 'dest';
      document.body.classList.replace('mode-drift', 'mode-compare');
      panelSignature = '';
      return setStageAndRender('pick');
    case 'uncompare':
      state.mode = 'drift';
      state.destination = null;
      state.pickTarget = 'origin';
      markers.setDestination(null);
      document.body.classList.replace('mode-compare', 'mode-drift');
      recompute();
      renderAll();
      return writeHash();
    case 'pick-origin':
      state.pickTarget = 'origin';
      return setStageAndRender('pick');
    case 'pick-dest':
      state.pickTarget = 'dest';
      return setStageAndRender('pick');
  }
}

function onSearch(q) {
  state.query = q;
  const box = $('searchResults');
  const hits = placeIndex.search(q, 7);
  box.innerHTML = hits.length ? renderSearchResults(hits)
    : q.trim().length >= 2 ? '<button disabled style="color:var(--faint);cursor:default">No match — try a bigger town nearby</button>' : '';
}

function geolocate() {
  if (!navigator.geolocation) return toast('This browser has no location support.', true);
  state.locating = true; renderStart();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.locating = false;
      const { latitude, longitude } = pos.coords;
      setAnchor('origin', makeAnchor(longitude, latitude));
      toast('Found you. Nothing left your device.');
    },
    (err) => {
      state.locating = false; renderStart();
      toast(err.code === 1
        ? 'Location permission denied — search for a place instead.'
        : location.protocol !== 'https:' && location.hostname !== 'localhost'
          ? 'Browsers only share location over https or localhost.'
          : 'Could not get a location fix.', true);
    },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 },
  );
}

const SURPRISES = ['Reykjavik', 'Panaji', 'Nairobi', 'Ushuaia', 'Kathmandu', 'Honolulu',
  'Wellington', 'Djibouti', 'Lisbon', 'Vladivostok', 'Perth', 'Anchorage', 'Male', 'Suva'];

function surprise() {
  const name = SURPRISES[Math.floor(Math.random() * SURPRISES.length)];
  const hit = placeIndex.search(name, 1)[0]
    || placeIndex.places[Math.floor(Math.random() * placeIndex.places.length)];
  const slot = state.mode === 'compare' && state.pickTarget === 'dest' ? 'dest' : 'origin';
  setAnchor(slot, makeAnchor(hit.lon, hit.lat, { name: hit.label, place: hit }));
}

let toastTimer;
function toast(msg, warn = false) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.toggle('warn', warn);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}

/* --------------------------------- play ---------------------------------- */

let playFrom = 0, playTo = 0, playStart = 0;
const PLAY_MS = 7200;
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

function togglePlay() {
  if (state.playing) return stopPlaying();
  let target = state.years;
  if (Math.abs(target) < 1) target = 5e7;
  playFrom = 0;
  playTo = yearsToSlider(target);
  playStart = performance.now();
  state.playing = true;
  $('playBtn').querySelector('.i-play').hidden = true;
  $('playBtn').querySelector('.i-pause').hidden = false;
  $('playBtn').querySelector('span').textContent = 'Stop';
}

function stopPlaying() {
  if (!state.playing) return;
  state.playing = false;
  $('playBtn').querySelector('.i-play').hidden = false;
  $('playBtn').querySelector('.i-pause').hidden = true;
  $('playBtn').querySelector('span').textContent = 'Play';
}

/** Round to something that reads cleanly instead of 49,999,872 years. */
function roundYears(y) {
  const a = Math.abs(y);
  if (a < 100) return Math.round(y);
  const mag = Math.pow(10, Math.floor(Math.log10(a)) - 2);
  return Math.round(y / mag) * mag;
}

/* ------------------------------- url state ------------------------------- */

let hashTimer;
const writeHashSoon = () => { clearTimeout(hashTimer); hashTimer = setTimeout(writeHash, 400); };

let suppressHash = false;
function writeHash() {
  const p = new URLSearchParams();
  p.set('m', state.mode);
  if (state.origin) p.set('o', `${state.origin.lat.toFixed(4)},${state.origin.lon.toFixed(4)}`);
  if (state.destination) p.set('d', `${state.destination.lat.toFixed(4)},${state.destination.lon.toFixed(4)}`);
  if (state.years) p.set('t', String(Math.round(state.years)));
  suppressHash = true;
  history.replaceState(null, '', `#${p.toString()}`);
  setTimeout(() => { suppressHash = false; }, 0);
}

function restoreFromHash() {
  if (suppressHash) return;
  const p = new URLSearchParams(location.hash.slice(1));
  const coord = (s) => {
    const [lat, lon] = String(s).split(',').map(Number);
    return isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 ? { lat, lon } : null;
  };
  const m = p.get('m');
  if (m === 'compare' || m === 'drift') state.mode = m;
  document.body.classList.toggle('mode-compare', state.mode === 'compare');
  document.body.classList.toggle('mode-drift', state.mode === 'drift');

  const o = coord(p.get('o'));
  if (o) {
    state.origin = makeAnchor(o.lon, o.lat);
    markers.setOrigin({ vec: state.origin.vec, plate: state.origin.plate });
    controls.flyTo({ lon: o.lon, lat: o.lat, dist: 3.4 }, 1500);
  }
  const d = coord(p.get('d'));
  if (d) {
    state.destination = makeAnchor(d.lon, d.lat);
    markers.setDestination({ vec: state.destination.vec, plate: state.destination.plate });
  }
  setOrbitVisible(state.showOrbit);
  const t = Number(p.get('t'));
  state.years = isFinite(t) ? Math.max(-MAX_YEARS, Math.min(MAX_YEARS, t)) : 0;
  recompute();
  setStage(state.origin ? 'explore' : 'pick');
  panelSignature = '';
  renderAll();
}

/* -------------------------------- the loop -------------------------------- */

function startLoop() {
  let last = performance.now();
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (state.playing) {
      const t = (now - playStart) / PLAY_MS;
      if (t >= 1) {
        setYears(roundYears(sliderToYears(playTo)));
        stopPlaying();
      } else {
        const v = playFrom + (playTo - playFrom) * easeInOut(t);
        $('timeSlider').value = String(Math.round(v));
        setYears(roundYears(sliderToYears(v)), { fromSlider: true });
      }
    }

    controls.update(dt);
    globe.render(now / 1000);
    updateLabels();

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot();
