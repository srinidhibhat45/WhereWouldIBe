/**
 * main.js — state, wiring, and the frame loop.
 *
 * The app has two stages and never both at once:
 *
 *   pick     one card in the middle-bottom dock: find a place. Nothing else.
 *   explore  the same dock becomes the time dial; the answer appears on the right.
 *
 * Time changes patch text in place rather than re-rendering the panel. Dragging
 * the dial should move the globe and the numbers — not the layout.
 */

import { PlateModel, toVec, toLonLat, distanceKm, R_EARTH_KM } from './tectonics.js';
import { PlaceIndex } from './places.js';
import { Globe, THREE } from './globe.js';
import { GlobeControls } from './controls.js';
import { Markers, COLORS } from './markers.js';
import { closestApproach, arrivalAt, distanceSeries } from './rendezvous.js';
import {
  renderReadout, renderSearchResults, driftFacts, patch, neighbourBody, esc,
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

/* Six stops, evenly spread across the feel of the scale. Eight was a wall. */
const PRESETS = [
  ['1 kyr', 1e3], ['100 kyr', 1e5], ['1 Myr', 1e6],
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
    bindEvents();
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
 * Six line styles at once is not a map, it is a migraine. Start with land,
 * coasts and the plate edges — the only lines this app is actually about —
 * and leave the rest in the Detail menu for anyone who wants them.
 */
function applyQuietDefaults() {
  globe.setLayerVisible('graticule', false);
  globe.setLayerVisible('borders', false);
  setOrbitVisible(false);
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
    controls.flyTo(pair || { lon: anchor.lon, lat: anchor.lat, dist: Math.min(controls.target.dist, 3.4) }, 1200);
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
  return { lon: mid[0], lat: mid[1], dist: Math.min(6, 2.4 + (sepDeg / 180) * 3.8) };
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
function syncDockHeight() {
  const dock = state.stage === 'pick' ? $('start') : $('timebar');
  document.documentElement.style.setProperty('--dock-h', `${Math.ceil(dock.offsetHeight)}px`);
}

function setStage(stage) {
  state.stage = stage;
  document.body.classList.toggle('stage-pick', stage === 'pick');
  document.body.classList.toggle('stage-explore', stage === 'explore');
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
  renderPanel();
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
function renderPanel({ force = false } = {}) {
  const sig = [
    state.mode, state.origin?.lon, state.origin?.lat,
    state.destination?.lon, state.destination?.lat,
    state.years === 0 ? 'now' : state.years < 0 ? 'past' : 'future',
  ].join('|');
  if (!force && sig === panelSignature) return;
  panelSignature = sig;

  const body = $('readoutBody');
  body.innerHTML = renderReadout(state, { placeIndex, model });
  for (const d of body.querySelectorAll('.fold')) d.open = openFolds.has(d.dataset.fold);
  lastFacts = null;
}

let lastFacts = null;
function patchPanel() {
  if (state.mode !== 'drift' || !state.origin) return;
  const f = driftFacts(state);
  if (lastFacts && f.headline === lastFacts.headline && f.v1 === lastFacts.v1) return;
  lastFacts = f;
  patch($('readoutBody'), f);
}

/** Folds hold time-dependent lists; refresh them once the dial settles. */
let foldTimer;
function refreshFoldsSoon() {
  clearTimeout(foldTimer);
  foldTimer = setTimeout(() => {
    if (state.mode !== 'drift' || !state.origin) return;
    const fold = $('readoutBody').querySelector('[data-fold="nbrs"]');
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

  const bar = $('timebar');
  bar.classList.toggle('is-past', y < 0);
  bar.classList.toggle('is-now', y === 0);
  $('timeValue').textContent = y === 0 ? 'today' : formatYearsShort(y);
  const cal = y === 0 ? '' : calendarYear(y);
  $('timeDirection').textContent = y === 0
    ? 'drag the dial to travel in time'
    : `${y > 0 ? 'from now' : 'ago'}${cal ? ' · ' + cal : ''}`;

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

  if (crossed) renderPanel();
  patchPanel();
  refreshFoldsSoon();
}

/* ------------------------------- labels ---------------------------------- */

const LABEL_STYLE = {
  origin: { color: COLORS.origin, text: () => state.origin?.name || '', sub: () => 'today' },
  future: { color: COLORS.future, text: () => formatYearsShort(state.years), sub: () => futureCoordText() },
  destination: { color: COLORS.destination, text: () => state.destination?.name || '', sub: () => '' },
  pole: { color: COLORS.pole, text: () => 'the spindle', sub: () => state.origin ? `${state.origin.plate.name} plate` : '' },
};

function futureCoordText() {
  if (!state.origin) return '';
  const p = state.origin.plate.positionAt(state.origin.vec, state.years);
  const [lon, lat] = toLonLat(p);
  return `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
}

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
    el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
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
      closeModal();
      $('detailMenu').hidden = true;
      if (state.stage === 'pick' && state.origin) setStageAndRender('explore');
    }
    if (e.key === ' ' && e.target === document.body && state.stage === 'explore') {
      e.preventDefault(); togglePlay();
    }
  });

  // Remember which folds the reader opened, so a rebuild does not close them.
  $('readoutBody').addEventListener('toggle', (e) => {
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
    else globe.setLayerVisible(layer, e.target.checked);
  });

  $('legendToggle').addEventListener('click', () => {
    const l = $('legend');
    const collapsed = l.classList.toggle('collapsed');
    $('legendToggle').setAttribute('aria-expanded', String(!collapsed));
  });

  $('aboutBtn').addEventListener('click', () => { $('aboutModal').hidden = false; });
  $('aboutModal').addEventListener('click', (e) => {
    if (e.target.id === 'aboutModal' || e.target.classList.contains('modal-close')) closeModal();
  });

  $('sheetToggle').addEventListener('click', () => {
    $('readout').classList.toggle('hidden-sheet');
  });
  const mq = window.matchMedia('(max-width: 900px)');
  const applyMQ = () => { $('sheetToggle').hidden = !mq.matches; };
  mq.addEventListener('change', applyMQ); applyMQ();

  if (window.ResizeObserver) {
    const ro = new ResizeObserver(syncDockHeight);
    ro.observe($('timebar')); ro.observe($('start'));
  }
  syncDockHeight();

  window.addEventListener('resize', () => { globe.resize(); syncDockHeight(); });
  window.addEventListener('hashchange', restoreFromHash);
}

const closeModal = () => { $('aboutModal').hidden = true; };

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
    case 'geolocate': return geolocate();
    case 'surprise': return surprise();
    case 'repick':
      state.pickTarget = 'origin';
      return setStageAndRender('pick');
    case 'keep':
      return setStageAndRender('explore');
    case 'compare':
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
