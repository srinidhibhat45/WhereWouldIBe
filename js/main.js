/**
 * main.js — state, wiring, and the frame loop.
 *
 * Owns the single source of truth (`state`), hands it to the renderers, and
 * keeps the globe, the markers and the panels in step. Heavy recomputation
 * (nearest neighbours, rendezvous solving) is throttled; the globe itself
 * updates every frame because scrubbing time should feel instant.
 */

import { PlateModel, toVec, toLonLat, distanceKm, R_EARTH_KM } from './tectonics.js';
import { PlaceIndex } from './places.js';
import { Globe, THREE } from './globe.js';
import { GlobeControls } from './controls.js';
import { Markers, COLORS } from './markers.js';
import { closestApproach, arrivalAt, distanceSeries } from './rendezvous.js';
import { renderPicker, renderReadout, renderSearchResults, esc } from './ui.js';
import { formatYearsShort, formatYears, calendarYear, comma, formatDistance } from './format.js';

/* ------------------------------ time mapping ----------------------------- */

const MAX_YEARS = 5e8;
const SLIDER_MAX = 2000;
const K = 16;
const DEN = Math.exp(K) - 1;

const sliderToYears = (v) =>
  Math.sign(v) * MAX_YEARS * ((Math.exp((K * Math.abs(v)) / SLIDER_MAX) - 1) / DEN);
const yearsToSlider = (y) =>
  Math.sign(y) * (SLIDER_MAX * Math.log((Math.abs(y) / MAX_YEARS) * DEN + 1)) / K;

const PRESETS = [
  ['1 kyr', 1e3], ['10 kyr', 1e4], ['100 kyr', 1e5], ['1 Myr', 1e6],
  ['10 Myr', 1e7], ['50 Myr', 5e7], ['100 Myr', 1e8], ['250 Myr', 2.5e8],
];
const TICKS = [1e4, 1e6, 1e8];

/* --------------------------------- state --------------------------------- */

const state = {
  mode: 'drift',
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
  showOrbit: true,
};

let model, placeIndex, globe, controls, markers;
const $ = (id) => document.getElementById(id);
const labelEls = new Map();

/* --------------------------------- boot ---------------------------------- */

const BOOT_LINES = [
  'Winding the clock…',
  'Unfolding 52 tectonic plates…',
  'Measuring how fast the ground moves…',
  'Stitching coastlines onto a sphere…',
  'Looking up 7,800 places…',
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
    mark('scene');

    tick(76, BOOT_LINES[3]);
    await nextFrame();
    globe.buildWorld({ plates: model.plates, land: land.polygons, borders: borders.rings });
    mark('buildWorld');

    markers = new Markers(globe);
    mark('markers');
    tick(94);
    await nextFrame();

    fillSources(plates.source);
    buildTimeUI();
    bindEvents();
    restoreFromHash();
    render();
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
      ? 'This app loads its data with fetch(), which browsers block on <code>file://</code>. Run a local server — <code>python3 -m http.server</code> — and open the localhost address.'
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
  if (anchor && fly) {
    const pair = state.mode === 'rendezvous' && state.origin && state.destination
      ? frameBoth(state.origin, state.destination) : null;
    controls.flyTo(pair || { lon: anchor.lon, lat: anchor.lat, dist: Math.min(controls.target.dist, 3.6) }, 1500);
  }
  // In rendezvous mode, filling "from" should hand the next pick to "to".
  if (state.mode === 'rendezvous') {
    state.pickTarget = !state.origin ? 'origin' : !state.destination ? 'dest' : which === 'origin' ? 'dest' : 'origin';
  }
  state.query = '';
  recompute();
  render();
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
  if (state.mode !== 'rendezvous' || !state.origin || !state.destination) {
    state.rendezvous = state.rendezvousPast = state.arrival = state.series = null;
    return;
  }
  const a = state.origin, b = state.destination;
  state.rendezvous = closestApproach(a.vec, a.plate, b.vec, b.plate, { from: 0, to: 1e9, samples: 9000 });
  // Also look backwards: two places are often drifting apart from a close pass
  // that already happened, and saying so is more honest than "never".
  state.rendezvousPast = closestApproach(a.vec, a.plate, b.vec, b.plate, { from: -1e9, to: 0, samples: 9000 });
  state.arrival = arrivalAt(a.vec, a.plate, b.vec, { from: -1e9, to: 1e9, samples: 18000 });
  if (!state.rendezvous.sameplate) {
    const span = Math.min(1e9, Math.max(6e7, state.rendezvous.bestYears * 2.4));
    state.series = distanceSeries(a.vec, a.plate, b.vec, b.plate, 0, span, 300);
  } else {
    state.series = null;
  }
}

/* -------------------------------- render --------------------------------- */

let readoutDirty = true;
let lastReadout = 0;

function render() {
  $('pickerBody').innerHTML = renderPicker(state);
  readoutDirty = true;
  renderReadoutNow();
  const input = $('searchInput');
  if (input && state.query) input.value = state.query;
}

function renderReadoutNow() {
  $('readoutBody').innerHTML = renderReadout(state, { placeIndex, model });
  readoutDirty = false;
  lastReadout = performance.now();
}

function setYears(y, { fromSlider = false } = {}) {
  state.years = y;
  globe.setTime(y);
  markers.update(y);

  const bar = $('timebar');
  bar.classList.toggle('is-past', y < 0);
  bar.classList.toggle('is-now', y === 0);
  $('timeValue').textContent = y === 0 ? 'now' : formatYearsShort(y);
  $('timeDirection').textContent = y === 0 ? 'the present day' : y > 0 ? 'from now' : 'ago';
  const cal = y === 0 ? '' : calendarYear(y);
  $('timeCalendar').textContent = cal || '';

  if (!fromSlider) $('timeSlider').value = String(Math.round(yearsToSlider(y)));
  $('flipBtn').textContent = y < 0 ? '⇄ future' : '⇄ past';
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

  readoutDirty = true;
}

/* ------------------------------- labels ---------------------------------- */

const LABEL_STYLE = {
  origin: { color: COLORS.origin, text: () => state.origin?.name || '', sub: () => 'today' },
  future: { color: COLORS.future, text: () => formatYearsShort(state.years), sub: () => futureCoordText() },
  destination: { color: COLORS.destination, text: () => state.destination?.name || '', sub: () => '' },
  pole: { color: COLORS.pole, text: () => 'Euler pole', sub: () => state.origin ? `${state.origin.plate.name} plate` : '' },
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

  $('trackTicks').innerHTML = [
    ...TICKS.map((y) => tickHTML(-y)),
    `<span style="left:50%">now</span>`,
    ...TICKS.map((y) => tickHTML(y)),
  ].join('');
}

function tickHTML(y) {
  const pct = 50 + (yearsToSlider(y) / SLIDER_MAX) * 50;
  return `<span style="left:${pct.toFixed(2)}%">${formatYearsShort(y)}</span>`;
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

  $('flipBtn').addEventListener('click', () => {
    stopPlaying();
    setYears(-state.years || 0);
    writeHash();
  });

  $('nowBtn').addEventListener('click', () => { stopPlaying(); setYears(0); writeHash(); });
  $('playBtn').addEventListener('click', togglePlay);

  // Panels use event delegation — their markup is re-rendered wholesale.
  document.addEventListener('click', onDelegatedClick);
  document.addEventListener('input', (e) => {
    if (e.target.id === 'searchInput') onSearch(e.target.value);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.id === 'searchInput' && e.key === 'Enter') {
      const first = $('searchResults')?.querySelector('button');
      if (first) first.click();
    }
    if (e.key === 'Escape') { closeModal(); $('layersMenu').hidden = true; }
    if (e.key === ' ' && e.target === document.body) { e.preventDefault(); togglePlay(); }
  });

  // Globe interaction: a tap (not a drag) drops a pin.
  $('globe').addEventListener('click', (e) => {
    if (!controls.wasClick) return;
    const hit = globe.pick(e.clientX, e.clientY);
    if (!hit) return;
    const anchor = makeAnchor(hit.lon, hit.lat);
    const slot = state.mode === 'rendezvous' ? state.pickTarget : 'origin';
    setAnchor(slot === 'dest' ? 'dest' : 'origin', anchor, { fly: false });
  });

  for (const b of document.querySelectorAll('.mode')) {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  }

  $('layersBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('layersMenu');
    m.hidden = !m.hidden;
    $('layersBtn').classList.toggle('is-on', !m.hidden);
  });
  $('layersMenu').addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    $('layersMenu').hidden = true;
    $('layersBtn').classList.remove('is-on');
  });
  $('layersMenu').addEventListener('change', (e) => {
    const layer = e.target.dataset.layer;
    if (layer === 'orbit') {
      state.showOrbit = e.target.checked;
      markers.circle.mesh.visible = e.target.checked && !!state.origin;
      markers.polePin.visible = e.target.checked && !!state.origin;
    } else {
      globe.setLayerVisible(layer, e.target.checked);
    }
  });

  $('aboutBtn').addEventListener('click', () => { $('aboutModal').hidden = false; });
  $('aboutModal').addEventListener('click', (e) => {
    if (e.target.id === 'aboutModal' || e.target.classList.contains('modal-close')) closeModal();
  });

  $('sheetToggle').addEventListener('click', () => {
    $('panels').classList.toggle('collapsed');
  });
  const mq = window.matchMedia('(max-width: 900px)');
  const applyMQ = () => { $('sheetToggle').hidden = !mq.matches; };
  mq.addEventListener('change', applyMQ); applyMQ();

  // The time bar's height depends on how the presets wrap, so measure it
  // rather than guessing: the bottom sheet sits directly on top of it.
  const timebar = $('timebar');
  const syncTimebarHeight = () => {
    document.documentElement.style.setProperty('--timebar-h', `${Math.ceil(timebar.offsetHeight)}px`);
  };
  if (window.ResizeObserver) new ResizeObserver(syncTimebarHeight).observe(timebar);
  syncTimebarHeight();

  window.addEventListener('resize', () => { globe.resize(); syncTimebarHeight(); });
  window.addEventListener('hashchange', restoreFromHash);
}

const closeModal = () => { $('aboutModal').hidden = true; };

function onDelegatedClick(e) {
  const btn = e.target.closest('[data-act], [data-place]');
  if (!btn) return;

  if (btn.dataset.place !== undefined) {
    const place = placeIndex.places[Number(btn.dataset.place)];
    const anchor = makeAnchor(place.lon, place.lat, { name: place.label, place });
    const slot = state.mode === 'rendezvous' ? state.pickTarget : 'origin';
    setAnchor(slot === 'dest' ? 'dest' : 'origin', anchor);
    const box = $('searchResults');
    if (box) box.innerHTML = '';
    return;
  }

  switch (btn.dataset.act) {
    case 'geolocate': return geolocate();
    case 'clear-origin': state.pickTarget = 'origin'; setAnchor('origin', null); break;
    case 'clear-dest': state.pickTarget = 'dest'; setAnchor('dest', null); break;
    case 'target-origin': state.pickTarget = 'origin'; render(); break;
    case 'target-dest': state.pickTarget = 'dest'; render(); break;
    case 'swap': {
      const a = state.origin, b = state.destination;
      state.origin = b; state.destination = a;
      markers.setOrigin(b ? { vec: b.vec, plate: b.plate } : null);
      markers.setDestination(a ? { vec: a.vec, plate: a.plate } : null);
      recompute(); render(); writeHash();
      break;
    }
    case 'surprise': return surprise();
    case 'share': return share();
  }
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  state.query = '';
  for (const b of document.querySelectorAll('.mode')) {
    const on = b.dataset.mode === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  }
  if (mode === 'drift') {
    markers.setDestination(null);
    state.destination = null;
  } else {
    state.pickTarget = state.origin ? 'dest' : 'origin';
  }
  recompute();
  setYears(state.years);
  render();
  writeHash();
}

function onSearch(q) {
  state.query = q;
  const box = $('searchResults');
  if (!box) return;
  const hits = placeIndex.search(q, 8);
  box.innerHTML = hits.length ? renderSearchResults(hits)
    : q.trim().length >= 2 ? '<button disabled style="color:var(--faint);cursor:default">No match — try a bigger town nearby</button>' : '';
}

function geolocate() {
  if (!navigator.geolocation) return toast('This browser has no location support.', true);
  state.locating = true; render();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.locating = false;
      const { latitude, longitude } = pos.coords;
      setAnchor('origin', makeAnchor(longitude, latitude));
      toast('Found you. Nothing left your device.');
    },
    (err) => {
      state.locating = false; render();
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
  setAnchor(state.mode === 'rendezvous' && state.pickTarget === 'dest' ? 'dest' : 'origin',
    makeAnchor(hit.lon, hit.lat, { name: hit.label, place: hit }));
  if (state.years === 0) setYears(5e7);
}

async function share() {
  writeHash();
  try {
    await navigator.clipboard.writeText(location.href);
    toast('Link copied — it remembers the place and the year.');
  } catch {
    toast('Copy the address bar to share this view.');
  }
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
const PLAY_MS = 6500;

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
  if (m === 'rendezvous' || m === 'drift') state.mode = m;
  for (const b of document.querySelectorAll('.mode')) {
    b.classList.toggle('is-on', b.dataset.mode === state.mode);
  }
  const o = coord(p.get('o'));
  if (o) {
    state.origin = makeAnchor(o.lon, o.lat);
    markers.setOrigin({ vec: state.origin.vec, plate: state.origin.plate });
    controls.flyTo({ lon: o.lon, lat: o.lat, dist: 3.6 }, 1800);
  }
  const d = coord(p.get('d'));
  if (d) {
    state.destination = makeAnchor(d.lon, d.lat);
    markers.setDestination({ vec: state.destination.vec, plate: state.destination.plate });
  }
  const t = Number(p.get('t'));
  recompute();
  setYears(isFinite(t) ? Math.max(-MAX_YEARS, Math.min(MAX_YEARS, t)) : 0);
  render();
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
        const v = playFrom + (playTo - playFrom) * t;
        $('timeSlider').value = String(Math.round(v));
        setYears(roundYears(sliderToYears(v)), { fromSlider: true });
      }
    }

    controls.update(dt);
    globe.render(now / 1000);
    updateLabels();

    // Panels are expensive to rebuild; 12/sec is plenty while scrubbing.
    if (readoutDirty && now - lastReadout > 85) renderReadoutNow();

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

boot();
