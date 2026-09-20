/**
 * globe.js — the 3D Earth.
 *
 * The whole trick of this app is that every plate moves independently, and it
 * has to do so at 60fps while you drag a time slider. So plate motion happens
 * on the GPU: each vertex carries the id of the plate it belongs to, the 52
 * plate rotations are uploaded once per frame as quaternions in a tiny
 * texture, and the vertex shader rotates each vertex by its own plate.
 *
 * Quaternions travel in a texture rather than a uniform array because dynamic
 * indexing into uniform arrays is not reliably supported across GLSL versions,
 * whereas a vertex texture fetch is.
 *
 * Radii, inner to outer:
 *   0.994  mantle      (glows through rifts once plates pull apart)
 *   1.000  plate fills (+ a hair per plate, to stop z-fighting on overlap)
 *   1.004  land
 *   1.005  coastlines, country borders
 *   1.007  plate edges
 *   1.013  graticule
 */

import * as THREE from '../vendor/three.module.js';
import { fillPolygon, RibbonBuilder, densifyIndexed, ringToVectors } from './mesh.js';
import {
  toVec, toLonLat, rotateAbout, normalize, cross, sub, dot, len,
  pointInParts, angleBetween,
} from './tectonics.js';

const MAX_PLATES = 64;   // texture width; the model has 52

const R_MANTLE = 0.994;
const R_PLATE = 1.0;
const R_LAND = 1.004;
const R_COAST = 1.0052;
const R_BORDER = 1.0046;
const R_EDGE = 1.007;
const R_GRID = 1.013;

const srgb = (hex) => new THREE.Color(hex).convertSRGBToLinear();

function plateColor(hue, sat = 0.5, light = 0.5) {
  const c = new THREE.Color();
  c.setHSL((((hue % 360) + 360) % 360) / 360, sat, light);
  return c.convertSRGBToLinear();
}

/**
 * Plate identity, but still recognisably sea floor.
 *
 * Letting plate hues run the whole colour wheel turns the South Atlantic
 * brown, which reads as land. So the hues are squeezed into a teal-to-violet
 * band and separated by lightness instead — neighbours stay distinguishable,
 * and every ocean still looks like an ocean.
 */
function oceanColor(hue, index) {
  const band = 182 + ((((hue % 360) + 360) % 360) / 360) * 108;   // 182 - 290
  const light = 0.20 + (((index * 5) % 7) / 7) * 0.10;
  return plateColor(band, 0.46, light);
}

/* ------------------------------ shader chunks ---------------------------- */

const ROT = /* glsl */`
  uniform sampler2D uQuatTex;
  vec3 qrot(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }
  vec4 plateQuat(float plate) {
    return texture2D(uQuatTex, vec2((plate + 0.5) / ${MAX_PLATES}.0, 0.5));
  }
`;

const SHADE = /* glsl */`
  uniform vec3 uLight;
  float surfaceShade(vec3 n) {
    float lam = dot(normalize(n), normalize(uLight));
    return 0.38 + 0.62 * smoothstep(-0.55, 0.95, lam);
  }
`;

const FILL_VERT = /* glsl */`
  ${ROT}
  uniform float uRadius;
  uniform float uRadiusStep;
  attribute vec3 aBase;
  attribute vec3 aTint;
  attribute float aPlate;
  varying vec3 vNormal;
  varying vec3 vTint;
  void main() {
    vec3 p = qrot(plateQuat(aPlate), aBase);
    vNormal = p;
    vTint = aTint;
    gl_Position = projectionMatrix * modelViewMatrix *
      vec4(p * (uRadius + aPlate * uRadiusStep), 1.0);
  }
`;

const FILL_FRAG = /* glsl */`
  ${SHADE}
  uniform vec3 uBase;
  uniform float uTint;
  uniform float uOpacity;
  uniform float uSheen;
  uniform vec3 uCamera;
  varying vec3 vNormal;
  varying vec3 vTint;
  void main() {
    vec3 n = normalize(vNormal);
    float s = surfaceShade(n);
    vec3 col = mix(uBase, vTint, uTint) * s;
    col = mix(col, col * vec3(0.55, 0.63, 1.0), (1.0 - s) * 0.5);
    // A little glancing-angle brightening reads as water rather than paint.
    float fres = pow(1.0 - abs(dot(n, normalize(uCamera))), 3.0);
    col += uSheen * fres * vec3(0.20, 0.42, 0.62) * s;
    gl_FragColor = vec4(col, uOpacity);
    #include <colorspace_fragment>
  }
`;

const RIBBON_VERT = (rotate) => /* glsl */`
  ${rotate ? ROT : ''}
  uniform float uRadius;
  uniform float uWidth;
  attribute vec3 aBase;
  attribute vec3 aOffset;
  attribute float aPlate;
  attribute float aWidth;
  attribute vec3 aColor;
  varying vec3 vNormal;
  varying vec3 vColor;
  void main() {
    ${rotate
      ? 'vec4 q = plateQuat(aPlate); vec3 p = qrot(q, aBase); vec3 o = qrot(q, aOffset);'
      : 'vec3 p = aBase; vec3 o = aOffset;'}
    vNormal = p;
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix *
      vec4(p * uRadius + o * (uWidth * aWidth), 1.0);
  }
`;

const RIBBON_FRAG = /* glsl */`
  ${SHADE}
  uniform float uOpacity;
  uniform float uGain;
  uniform float uShadeMix;
  varying vec3 vNormal;
  varying vec3 vColor;
  void main() {
    float s = mix(1.0, surfaceShade(vNormal), uShadeMix);
    gl_FragColor = vec4(vColor * uGain * s, uOpacity);
    #include <colorspace_fragment>
  }
`;

/* ------------------------------- the globe ------------------------------- */

export class Globe {
  constructor(canvas, model) {
    this.model = model;
    this.years = 0;
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setClearColor(srgb('#05050c'), 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.3, 120);
    this.raycaster = new THREE.Raycaster();

    this.light = new THREE.Vector3(1, 0.4, 0.5);

    // 64 x 1 RGBA float texture holding one quaternion per plate.
    this.quatData = new Float32Array(MAX_PLATES * 4);
    for (let i = 0; i < MAX_PLATES; i++) this.quatData[i * 4 + 3] = 1;
    this.quatTex = new THREE.DataTexture(this.quatData, MAX_PLATES, 1, THREE.RGBAFormat, THREE.FloatType);
    this.quatTex.minFilter = this.quatTex.magFilter = THREE.NearestFilter;
    this.quatTex.needsUpdate = true;

    this.materials = [];
    this.ribbonMaterials = [];
    this.layers = {};

    this._buildStars();
    this._buildMantle();
    this._buildGraticule();

    this.markerGroup = new THREE.Group();
    this.scene.add(this.markerGroup);
  }

  /* ------------------------------ materials ------------------------------ */

  _fillMaterial({ base, tint, opacity = 1, radius, radiusStep = 0, sheen = 0, transparent = false, depthWrite = true }) {
    const m = new THREE.ShaderMaterial({
      vertexShader: FILL_VERT,
      fragmentShader: FILL_FRAG,
      uniforms: {
        uQuatTex: { value: this.quatTex },
        uLight: { value: this.light },
        uRadius: { value: radius },
        uRadiusStep: { value: radiusStep },
        uBase: { value: srgb(base) },
        uTint: { value: tint },
        uOpacity: { value: opacity },
        uSheen: { value: sheen },
        uCamera: { value: this.camera.position },
      },
      transparent, depthWrite,
    });
    this.materials.push(m);
    return m;
  }

  _ribbonMaterial({ radius, width, opacity = 1, gain = 1, rotate = true, shadeMix = 1, blending, depthWrite = true }) {
    const m = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VERT(rotate),
      fragmentShader: RIBBON_FRAG,
      uniforms: {
        uQuatTex: { value: this.quatTex },
        uLight: { value: this.light },
        uRadius: { value: radius },
        uWidth: { value: width },
        uOpacity: { value: opacity },
        uGain: { value: gain },
        uShadeMix: { value: shadeMix },
      },
      transparent: true,
      depthWrite,
      side: THREE.DoubleSide,
      blending: blending ?? THREE.NormalBlending,
    });
    m.userData.baseWidth = width;
    this.ribbonMaterials.push(m);
    return m;
  }

  /* -------------------------------- layers ------------------------------- */

  _buildStars() {
    const N = 2600;
    const pos = new Float32Array(N * 3);
    const size = new Float32Array(N);
    const col = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const R = 46 + Math.random() * 8;
      pos.set([R * r * Math.cos(th), R * r * Math.sin(th), R * u], i * 3);
      const bright = Math.pow(Math.random(), 2.6);
      size[i] = 0.6 + bright * 2.6;
      // A few warm and a few blue stars stops it looking like static.
      const t = Math.random();
      const c = t < 0.12 ? [1, 0.82, 0.62] : t > 0.9 ? [0.72, 0.84, 1] : [1, 1, 1];
      col.set([c[0] * (0.35 + bright * 0.75), c[1] * (0.35 + bright * 0.75), c[2] * (0.35 + bright * 0.75)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    const m = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float aSize; attribute vec3 aColor;
        varying vec3 vColor; uniform float uScale;
        void main(){ vColor = aColor;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
          gl_PointSize = aSize * uScale; }`,
      fragmentShader: `
        varying vec3 vColor;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float a = 1.0 - smoothstep(0.18, 0.5, length(d));
          if (a <= 0.01) discard;
          gl_FragColor = vec4(vColor, a);
          #include <colorspace_fragment>
        }`,
      uniforms: { uScale: { value: Math.min(devicePixelRatio || 1, 2) } },
      transparent: true, depthWrite: false,
    });
    this.stars = new THREE.Points(g, m);
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);
  }

  _buildMantle() {
    const m = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vN;
        void main(){ vN = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying vec3 vN; uniform float uTime;
        void main(){
          // Whatever shows through a rift is brand-new sea floor: abyssal and
          // dark, with just enough heat in it to read as freshly made.
          float n = sin(vN.x*9.0 + uTime*0.10) * sin(vN.y*11.0 - uTime*0.08)
                  * sin(vN.z*8.0 + uTime*0.13);
          float heat = 0.5 + 0.5 * n;
          vec3 abyss = vec3(0.012, 0.030, 0.055);
          vec3 fresh = vec3(0.32, 0.105, 0.045);
          gl_FragColor = vec4(mix(abyss, fresh, pow(heat, 2.4) * 0.85), 1.0);
          #include <colorspace_fragment>
        }`,
      uniforms: { uTime: { value: 0 } },
    });
    this.mantleMat = m;
    this.mantle = new THREE.Mesh(new THREE.SphereGeometry(R_MANTLE, 96, 64), m);
    this.scene.add(this.mantle);
  }

  _buildGraticule() {
    const m = new THREE.ShaderMaterial({
      vertexShader: `varying vec3 vN;
        void main(){ vN = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying vec3 vN; uniform float uOpacity; uniform vec3 uColor;
        float grid(float v, float step){
          float g = abs(fract(v/step + 0.5) - 0.5) * step;
          float w = fwidth(v) * 1.1;
          return 1.0 - smoothstep(0.0, w, g);
        }
        void main(){
          float lat = degrees(asin(clamp(vN.z,-1.0,1.0)));
          float lon = degrees(atan(vN.y, vN.x));
          float g = max(grid(lat, 15.0), grid(lon, 15.0));
          float major = max(grid(lat, 90.0), grid(lon, 90.0));
          float a = (g * 0.5 + major * 0.9) * uOpacity;
          if (a <= 0.004) discard;
          gl_FragColor = vec4(uColor, a);
          #include <colorspace_fragment>
        }`,
      uniforms: { uOpacity: { value: 0.22 }, uColor: { value: srgb('#9fd8ff') } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.graticuleMat = m;
    this.graticule = new THREE.Mesh(new THREE.SphereGeometry(R_GRID, 128, 80), m);
    this.scene.add(this.graticule);
  }

  /** Builds every data-driven layer. Called once, after the JSON has loaded. */
  buildWorld({ plates, land, borders }) {
    const t = (label, fn) => {
      const t0 = performance.now();
      fn();
      this.buildTimes = this.buildTimes || {};
      this.buildTimes[label] = Math.round(performance.now() - t0);
    };
    t('plateFills', () => this._buildPlateFills(plates));
    t('plateEdges', () => this._buildPlateEdges(plates));
    t('land', () => this._buildLand(land));
    t('coast', () => this._buildCoastlines(land));
    t('borders', () => this._buildBorders(borders));
    this.setTime(0);
  }

  _buildPlateFills(plates) {
    const pos = [], tint = [], plate = [], index = [];
    plates.forEach((p, pi) => {
      const col = oceanColor(p.hue, pi);
      for (const part of p.parts) {
        const mesh = fillPolygon(part, null, 0.05);
        if (!mesh) continue;
        const base = pos.length / 3;
        for (let i = 0; i < mesh.pos.length; i += 3) {
          pos.push(mesh.pos[i], mesh.pos[i + 1], mesh.pos[i + 2]);
          tint.push(col.r, col.g, col.b);
          plate.push(pi);
        }
        for (const idx of mesh.index) index.push(base + idx);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('aBase', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 3));
    g.setAttribute('aPlate', new THREE.Float32BufferAttribute(plate, 1));
    g.setAttribute('position', g.getAttribute('aBase'));
    g.setIndex(index);
    g.computeBoundingSphere();
    g.boundingSphere.radius = 1.4;

    this.plateFillMat = this._fillMaterial({
      base: '#12406b', tint: 0.34, radius: R_PLATE, radiusStep: 3e-5, sheen: 0.9,
    });
    this.layers.plates = new THREE.Mesh(g, this.plateFillMat);
    this.layers.plates.frustumCulled = false;
    this.scene.add(this.layers.plates);
  }

  _buildPlateEdges(plates) {
    const rb = new RibbonBuilder();
    // Colour by what the two plates are doing: spreading, colliding, sliding.
    const DIVERGENT = plateColor(14, 0.95, 0.56);
    const CONVERGENT = plateColor(215, 0.9, 0.62);
    const TRANSFORM = plateColor(46, 0.95, 0.58);

    plates.forEach((p, pi) => {
      p.parts.forEach((part, partIdx) => {
        part.forEach((ring, ringIdx) => {
          const pts = ringToVectors(ring);
          const edge = p.edges?.[partIdx]?.[ringIdx];
          const segments = edge ? edge.length / 3 : 0;

          // Whether a boundary is spreading, colliding or sliding is a regional
          // property, not something that changes every 100 km. Average along
          // the boundary over a fixed *distance* rather than a fixed number of
          // segments — vertex spacing varies wildly, and on a slow boundary
          // like the East African Rift (3 mm/yr opening against 3 mm/yr of
          // shear) a short window flips the classification back and forth and
          // the two plates end up drawing their shared edge in two colours.
          const smoothed = smoothAlongBoundary(pts, edge, segments, 0.094);

          const colourAt = (i) => {
            if (!segments) return [0.5, 0.5, 0.5];
            const j = Math.min(i, segments - 1);
            const opening = smoothed[j * 2], sliding = smoothed[j * 2 + 1];
            const c = Math.abs(opening) < sliding * 0.85
              ? TRANSFORM : opening > 0 ? DIVERGENT : CONVERGENT;
            // Square-root ramp: a 5 mm/yr rift should still read as a rift, not
            // fade to near-black next to a 140 mm/yr ridge.
            const mag = Math.sqrt(Math.min(1, Math.max(Math.abs(opening), sliding) / 80));
            const k = 0.55 + 0.45 * mag;
            return [c.r * k, c.g * k, c.b * k];
          };
          const widthAt = (i) => {
            if (!segments) return 0.7;
            const j = Math.min(i, segments - 1);
            const mag = Math.sqrt(Math.min(1,
              Math.max(Math.abs(smoothed[j * 2]), smoothed[j * 2 + 1]) / 80));
            return 0.6 + mag * 0.8;
          };
          // Densify, carrying each new point's source segment with it.
          const { points: dense, source: map } = densifyIndexed(pts, 0.02);
          rb.add(dense, {
            plate: pi,
            color: (i) => colourAt(map[i]),
            width: (i) => widthAt(map[i]),
          });
        });
      });
    });

    const g = rb.build(THREE);
    this.plateEdgeGlowMat = this._ribbonMaterial({
      radius: R_EDGE - 0.0004, width: 0.0075, opacity: 0.30, gain: 1.5,
      shadeMix: 0.2, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.plateEdgeMat = this._ribbonMaterial({
      radius: R_EDGE, width: 0.0022, opacity: 0.95, gain: 1.25, shadeMix: 0.35, depthWrite: false,
    });
    this.layers.plateEdgeGlow = new THREE.Mesh(g, this.plateEdgeGlowMat);
    this.layers.plateEdges = new THREE.Mesh(g, this.plateEdgeMat);
    this.layers.plateEdgeGlow.frustumCulled = this.layers.plateEdges.frustumCulled = false;
    this.layers.plateEdgeGlow.renderOrder = 3;
    this.layers.plateEdges.renderOrder = 4;
    this.scene.add(this.layers.plateEdgeGlow, this.layers.plateEdges);
  }

  _buildLand(land) {
    const pos = [], tint = [], plate = [], index = [];
    for (const poly of land) {
      const mesh = fillPolygon(poly.r, poly.p, 0.04);
      if (!mesh) continue;
      const base = pos.length / 3;
      for (let i = 0; i < mesh.pos.length / 3; i++) {
        pos.push(mesh.pos[i * 3], mesh.pos[i * 3 + 1], mesh.pos[i * 3 + 2]);
        const pi = mesh.payload[i] | 0;
        const c = plateColor(this.model.plates[pi]?.hue ?? 0, 0.40, 0.55);
        tint.push(c.r, c.g, c.b);
        plate.push(pi);
      }
      for (const idx of mesh.index) index.push(base + idx);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('aBase', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 3));
    g.setAttribute('aPlate', new THREE.Float32BufferAttribute(plate, 1));
    g.setAttribute('position', g.getAttribute('aBase'));
    g.setIndex(index);
    g.computeBoundingSphere();
    g.boundingSphere.radius = 1.4;

    this.landMat = this._fillMaterial({ base: '#ded0a8', tint: 0.20, radius: R_LAND });
    this.layers.land = new THREE.Mesh(g, this.landMat);
    this.layers.land.frustumCulled = false;
    this.layers.land.renderOrder = 1;
    this.scene.add(this.layers.land);
  }

  _buildCoastlines(land) {
    const rb = new RibbonBuilder();
    for (const poly of land) {
      poly.r.forEach((ring, ri) => {
        const pts = ringToVectors(ring);
        const plateIds = poly.p[ri];
        const { points: dense, source: map } = densifyIndexed(pts, 0.02);
        rb.add(dense, {
          plate: (i) => plateIds[Math.min(map[i], plateIds.length - 1)] | 0,
          color: [1, 0.98, 0.93],
          width: 1,
          closed: true,
        });
      });
    }
    this.coastMat = this._ribbonMaterial({
      radius: R_COAST, width: 0.0013, opacity: 0.85, gain: 1.0, shadeMix: 0.55, depthWrite: false,
    });
    this.layers.coast = new THREE.Mesh(rb.build(THREE), this.coastMat);
    this.layers.coast.frustumCulled = false;
    this.layers.coast.renderOrder = 2;
    this.scene.add(this.layers.coast);
  }

  _buildBorders(borders) {
    const rb = new RibbonBuilder();
    for (const b of borders) {
      const pts = ringToVectors(b.r);
      const { points: dense, source: map } = densifyIndexed(pts, 0.03);
      rb.add(dense, {
        plate: (i) => b.p[Math.min(map[i], b.p.length - 1)] | 0,
        color: [0.62, 0.70, 0.82],
        width: 1,
        closed: true,
      });
    }
    // Deliberately faint. Country borders are background context here; a slow
    // rift opening at 5 mm/yr still has to out-shout them.
    this.borderMat = this._ribbonMaterial({
      radius: R_BORDER, width: 0.0007, opacity: 0.20, gain: 1.0, shadeMix: 0.7, depthWrite: false,
    });
    this.layers.borders = new THREE.Mesh(rb.build(THREE), this.borderMat);
    this.layers.borders.frustumCulled = false;
    this.scene.add(this.layers.borders);
  }

  /* -------------------------------- time --------------------------------- */

  /** Upload one quaternion per plate for the given time offset in years. */
  setTime(years) {
    this.years = years;
    const d = this.quatData;
    this.model.plates.forEach((p, i) => {
      const half = (p.rateRadPerYr * years) / 2;
      const s = Math.sin(half);
      d[i * 4] = p.poleVec.x * s;
      d[i * 4 + 1] = p.poleVec.y * s;
      d[i * 4 + 2] = p.poleVec.z * s;
      d[i * 4 + 3] = Math.cos(half);
    });
    this.quatTex.needsUpdate = true;

    // National borders stop meaning anything long before the plates do.
    const fade = 1 - Math.min(1, Math.max(0, (Math.log10(Math.max(Math.abs(years), 1)) - 4.2) / 1.6));
    this.borderMat.uniforms.uOpacity.value = 0.20 * fade;
    // …unless the reader has switched them off entirely.
    this.layers.borders.visible = this._bordersOn !== false && fade > 0.02;
  }

  setLayerVisible(name, visible) {
    if (name === 'borders') { this._bordersOn = visible; this.layers.borders.visible = visible; return; }
    if (name === 'plateEdges') {
      this.layers.plateEdges.visible = visible;
      this.layers.plateEdgeGlow.visible = visible;
      return;
    }
    if (name === 'graticule') { this.graticule.visible = visible; return; }
    if (name === 'plateColors') {
      this.plateFillMat.uniforms.uTint.value = visible ? 0.36 : 0.05;
      this.landMat.uniforms.uTint.value = visible ? 0.20 : 0.04;
      return;
    }
    if (this.layers[name]) this.layers[name].visible = visible;
  }

  /* ------------------------------- picking -------------------------------- */

  /**
   * Screen pixel -> present-day lon/lat.
   *
   * The globe the user is looking at is the *rotated* one, so we intersect the
   * sphere, then undo each plate's rotation in turn and ask which plate's
   * present-day outline actually contains the result. That is what makes
   * clicking a drifted continent give you the right piece of ground.
   */
  pick(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const o = this.raycaster.ray.origin, dir = this.raycaster.ray.direction;
    const b = 2 * (o.x * dir.x + o.y * dir.y + o.z * dir.z);
    const c = o.x * o.x + o.y * o.y + o.z * o.z - R_LAND * R_LAND;
    const disc = b * b - 4 * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / 2;
    if (t < 0) return null;
    const hit = normalize({ x: o.x + dir.x * t, y: o.y + dir.y * t, z: o.z + dir.z * t });

    const unrotated = [];
    for (const p of this.model.plates) {
      const back = rotateAbout(hit, p.poleVec, -p.rateRadPerYr * this.years);
      const [lon, lat] = toLonLat(back);
      if (pointInParts(p.parts, lon, lat)) return { lon, lat, plate: p, vec: back };
      unrotated.push({ p, back, lon, lat });
    }
    // The click landed in a rift or an overlap where no plate claims the spot.
    // Fall back to whichever plate's outline the un-rotated point is nearest.
    let best = null, bestD = Infinity;
    for (const { p, back, lon, lat } of unrotated) {
      for (const part of p.parts) for (const ring of part) {
        for (let i = 0; i < ring.length; i += 2) {
          const d = angleBetween(back, toVec(ring[i], ring[i + 1]));
          if (d < bestD) { bestD = d; best = { lon, lat, plate: p, vec: back }; }
        }
      }
    }
    return best;
  }

  /** World position -> screen pixels, with a flag for "hidden behind the globe". */
  project(vec, radius = 1) {
    const v = new THREE.Vector3(vec.x * radius, vec.y * radius, vec.z * radius);
    const camDir = this.camera.position.clone().normalize();
    const facing = v.clone().normalize().dot(camDir);
    v.project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (v.x * 0.5 + 0.5) * rect.width,
      y: (-v.y * 0.5 + 0.5) * rect.height,
      visible: facing > 0.08 && v.z < 1,
      facing,
    };
  }

  /* ------------------------------- rendering ------------------------------ */

  /**
   * Tell the globe how much of the screen the chrome is eating, so it can aim
   * for the middle of what is *left*. Without this the planet centres itself
   * behind the dock and you spend the whole time looking at its forehead.
   */
  setFrame(top, bottom, right = 0) {
    this._frameTop = top;
    this._frameBottom = bottom;
    this._frameRight = right;
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;

    // Shift the rendered frame so the globe's centre lands in the middle of
    // whatever the chrome has left. Derivation: the free band runs from `top`
    // to `h - bottom`, so its centre is top + (h - top - bottom)/2, and moving
    // the centre there from h/2 is an offset of exactly (bottom - top)/2. The
    // same argument gives the horizontal shift when a side panel is open.
    const dy = (((this._frameBottom || 0) - (this._frameTop || 0)) / 2) | 0;
    const dx = ((this._frameRight || 0) / 2) | 0;
    if (dx || dy) this.camera.setViewOffset(w, h, dx, dy, w, h);
    else this.camera.clearViewOffset();

    this.camera.updateProjectionMatrix();
  }

  /**
   * Client coordinates of the point on the globe facing the camera — i.e. what
   * is dead centre of the view, allowing for the frame offset. Keyboard users
   * drop their pin here, so it has to agree with what the eye calls "middle".
   */
  centreOfView() {
    const r = this.canvas.getBoundingClientRect();
    const dy = (((this._frameBottom || 0) - (this._frameTop || 0)) / 2) | 0;
    const dx = ((this._frameRight || 0) / 2) | 0;
    return { x: r.left + r.width / 2 - dx, y: r.top + r.height / 2 - dy };
  }

  render(elapsed) {
    // Keep the lit side towards the viewer, offset so there is always relief.
    const c = this.camera.position;
    this.light.set(c.x, c.y, c.z).normalize();
    const side = new THREE.Vector3(-this.light.y, this.light.x, 0).normalize();
    this.light.addScaledVector(side, 0.55).addScaledVector(new THREE.Vector3(0, 0, 1), 0.28).normalize();

    // Ribbons keep a roughly constant on-screen thickness at any zoom.
    const wScale = Math.max(0.42, Math.min(1.35, this.camera.position.length() / 3.2));
    for (const m of this.ribbonMaterials) {
      m.uniforms.uWidth.value = m.userData.baseWidth * wScale;
    }
    this.mantleMat.uniforms.uTime.value = elapsed;
    this.renderer.render(this.scene, this.camera);
  }
}

/**
 * Length-weighted running average of the opening / sliding rates along a
 * boundary ring. `halfWindow` is an angular distance in radians (0.094 rad is
 * about 600 km). Prefix sums keep it linear in the number of segments.
 *
 * The window never crosses a change of neighbouring plate. A single ring walks
 * past several different neighbours in turn, and averaging across a triple
 * junction both smears unrelated boundaries together and — because the two
 * plates sharing an edge meet their other neighbours in a different order —
 * makes them disagree about the edge they share, so one draws it red while the
 * other draws it blue.
 */
function smoothAlongBoundary(pts, edge, segments, halfWindow) {
  const out = new Float64Array(Math.max(segments, 1) * 2);
  if (!segments) return out;

  const cum = new Float64Array(segments + 1);
  const sumOpen = new Float64Array(segments + 1);
  const sumSlide = new Float64Array(segments + 1);
  for (let i = 0; i < segments; i++) {
    const w = Math.max(1e-9, angleBetween(pts[i], pts[Math.min(i + 1, pts.length - 1)]));
    cum[i + 1] = cum[i] + w;
    sumOpen[i + 1] = sumOpen[i] + edge[i * 3] * w;
    sumSlide[i + 1] = sumSlide[i] + Math.abs(edge[i * 3 + 1]) * w;
  }

  // Contiguous stretches that face the same neighbour.
  const runStart = new Int32Array(segments);
  const runEnd = new Int32Array(segments);
  for (let i = 0; i < segments; i++) {
    runStart[i] = i > 0 && edge[i * 3 + 2] === edge[(i - 1) * 3 + 2] ? runStart[i - 1] : i;
  }
  for (let i = segments - 1; i >= 0; i--) {
    runEnd[i] = i < segments - 1 && edge[i * 3 + 2] === edge[(i + 1) * 3 + 2] ? runEnd[i + 1] : i;
  }

  for (let i = 0; i < segments; i++) {
    const centre = (cum[i] + cum[i + 1]) / 2;
    let lo = runStart[i];
    let hi = runEnd[i] + 1;
    while (lo < i && cum[lo + 1] < centre - halfWindow) lo++;
    while (hi > i + 1 && cum[hi - 1] > centre + halfWindow) hi--;
    const span = cum[hi] - cum[lo];
    if (span <= 0) {
      out[i * 2] = edge[i * 3];
      out[i * 2 + 1] = Math.abs(edge[i * 3 + 1]);
    } else {
      out[i * 2] = (sumOpen[hi] - sumOpen[lo]) / span;
      out[i * 2 + 1] = (sumSlide[hi] - sumSlide[lo]) / span;
    }
  }
  return out;
}

export { THREE };
