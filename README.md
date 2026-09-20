# Where Would I Be…?

The ground under you is moving right now, at roughly the speed your fingernails
grow. Wait long enough and it ends up somewhere else entirely.

This is a 3D globe you can fast-forward. Drop a pin, drag the clock, and watch
the continents crawl — with your patch of crust riding along, carrying its
coordinates, its climate and eventually a completely different set of
neighbours.

**How it goes:**

1. **Pick a place** — your location, a search, or a tap on the globe. That is
   the only thing on screen at this point.
2. **Run the clock** — the picker becomes a time dial. The answer appears as a
   sentence first: where the ground ends up, how far it travelled, which way,
   and what the climate does. Numbers sit under it; everything else is folded
   away until you ask for it.
3. **Compare, if you like** — pick a second place and the app solves for when
   the two patches of ground come closest, how close that is, and whether they
   ever really meet at all.

Dragging the dial moves the globe and the numbers. It does not move the
layout — the panel patches its text in place rather than re-rendering, so
nothing you are reading jumps.

The globe starts quiet: land, coastlines and plate edges, with the edges
coloured by what they are actually doing and a key on screen saying so.
The lat/long grid, country borders and Euler orbit are all off by default and
live behind the layers button.

Everything runs in the browser. There is no server, no analytics, and if you
share your location it never leaves your device.

---

## Running it

The app is plain ES modules and `fetch`ed JSON, so it needs to be served over
HTTP rather than opened as a `file://`.

```bash
node tools/serve.mjs
```

Then open <http://localhost:8123>. Any static server works — `npx serve`,
`python3 -m http.server`, GitHub Pages. There is no build step and no
dependency install; three.js and earcut are vendored in `vendor/`.

To check the science still holds:

```bash
node tools/verify.mjs
```

---

## How it works

### The model

A tectonic plate behaves, to a good approximation, like a rigid cap sliding on
a sphere. Any such motion is a rotation about some axis, and where that axis
pierces the surface is called the plate's **Euler pole**. Give a plate its pole
and its rate, and the entire future and past of every point on it is one
rotation — which is why this app can redraw 300,000 vertices for an arbitrary
year without breaking a sweat.

Plate motions come from **NNR-MORVEL56** (Argus, Gordon & DeMets, 2011): 56
plates in a no-net-rotation reference frame. Outlines come from Peter Bird's
**PB2002**, 52 plates that tile the sphere exactly — the build checks that they
sum to 510.1 million km², and that individual plate areas match Bird's
published values to within a few tenths of a percent.

### Boundary colours are computed, not painted

Nothing in the data says "this is a mid-ocean ridge". For every segment of
every plate outline, the build:

1. decides which side of the segment is outside the plate (by majority vote
   over the whole ring — probing segment by segment is too noisy on jagged
   outlines),
2. steps out until it finds the neighbouring plate,
3. takes the relative NNR-MORVEL56 surface velocity there, and
4. splits it into a boundary-normal component (opening or closing) and an
   along-boundary one (sliding).

That single number per segment is why the East Pacific Rise glows orange at
~100 mm/yr, the Japan Trench is blue at ~84, and the San Andreas is yellow.
The tests check these against published rates.

### Rendering

Every plate moves independently, and it has to do so at 60 fps while you drag a
slider — so plate motion happens on the GPU. Each vertex carries the id of the
plate it belongs to; the 52 plate rotations are uploaded once per frame as
quaternions in a 64×1 float texture; the vertex shader rotates each vertex by
its own plate. Lines are ribbons of quads rather than `GL_LINES`, because WebGL
ignores `lineWidth` — and because a ribbon's sideways offset can be rotated by
the same quaternion, so lines stay glued to moving crust.

Filled areas are triangulated with earcut in lon/lat, lifted onto the sphere,
then refined red–green style until no edge sags visibly below the surface. The
refinement is conforming, so continents do not crack apart along seams.

As you run the clock forward, plates pull apart and overlap. The gaps are real
— that is where new sea floor would be made — so they show the dark abyss
beneath rather than being papered over.

### Rendezvous

Two points on different plates each trace a small circle about their own Euler
pole, so the distance between them is a quasi-periodic function of time with no
closed-form minimum worth having. The solver scans coarsely over a billion
years, collects every local minimum, and refines each by golden section. The
test suite checks it against a 400,000-sample brute force.

---

## Project layout

```
index.html            markup and the loading screen
css/style.css         all styling
js/
  tectonics.js        Euler-pole maths, plate lookup — pure, no DOM, no three.js
  mesh.js             spherical triangulation, refinement, ribbon building
  globe.js            three.js scene, shaders, layers, picking
  markers.js          pins, drift trail, Euler orbit, neighbour dots
  controls.js         orbit camera with momentum and fly-to
  places.js           gazetteer: search, nearest-place, drift
  rendezvous.js       closest-approach solver
  format.js           numbers into things a human can feel
  ui.js               panel rendering
  main.js             state, wiring, frame loop
data/                 built JSON — see below
vendor/               three.js, earcut
tools/
  fetch-raw.sh        download the source datasets
  build-data.mjs      turn them into data/
  verify.mjs          regression tests
  serve.mjs           static dev server
```

### Rebuilding `data/`

The four files in `data/` are generated. To rebuild them:

```bash
./tools/fetch-raw.sh                    # ~25 MB of open data
node tools/build-data.mjs tools/raw
node tools/verify.mjs
```

Search quality improves if you also grab GeoNames' full alternate-names dump,
which carries language tags and preferred-name flags — it is what lets
"Cologne" find Köln and "Seville" find Sevilla:

```bash
WITH_ENGLISH_NAMES=1 ./tools/fetch-raw.sh
```

It is an ~800 MB file, so the build treats it as optional and falls back to a
heuristic without it.

---

## How much to trust it

Not very much, past a point — and that is fine, because the point is to feel
deep time rather than to predict it.

NNR-MORVEL56 describes motion averaged over roughly the last 780,000 years.
Running it forward assumes plates never change course, never jam, and never
break, which is exactly what plates always do. Subduction zones die, new rifts
open, continents collide and stop.

A rough guide:

| Horizon | How it reads |
| --- | --- |
| 1,000 years | Solid. Your street moves a few metres. |
| 1 million | Fair. Coastlines recognisable, rivers in new places. |
| 50 million | A decent story. Africa closes the Mediterranean; Australia arrives in Asia. |
| Beyond that | A very well-informed daydream. |

Running the clock backwards is a naïve extrapolation too — real plate
reconstructions use seafloor magnetic stripes and hotspot tracks, not today's
velocities held constant. The app says so where it matters.

Microplates are the other caveat. A few of the 56 spin fast (the Manus plate
turns 51.6° per million years), so over long spans they whirl around their
poles. That is genuinely what the published model says; it just stops meaning
anything long before the big plates do.

---

## Data sources

| What | Source | Licence |
| --- | --- | --- |
| Plate motions | NNR-MORVEL56 — Argus, Gordon & DeMets (2011), *G-cubed* 12, Q11001 | published table |
| Plate outlines | PB2002 — Bird (2003), *G-cubed* 4(3), 1027, via [fraxen/tectonicplates](https://github.com/fraxen/tectonicplates) | CC BY-SA |
| Coastlines, borders | [Natural Earth](https://www.naturalearthdata.com/) 1:50m land, 1:110m admin-0 | public domain |
| Places | [GeoNames](https://www.geonames.org/) `cities15000` | CC BY 4.0 |
| 3D | [three.js](https://threejs.org/) | MIT |
| Triangulation | [earcut](https://github.com/mapbox/earcut) | ISC |

Fonts are Bricolage Grotesque, Space Grotesk and JetBrains Mono, loaded from
Google Fonts. The app degrades to system fonts offline.

---

## Licence

MIT for the code. The bundled data keeps the licences above — in particular,
GeoNames requires attribution, which the app carries in its About panel.

Built for fun. Not for navigation, land registry, or arguing with your
neighbour about where the fence goes in 40 million years.
