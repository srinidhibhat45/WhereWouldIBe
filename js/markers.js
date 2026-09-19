/**
 * markers.js — everything drawn *on top of* the Earth.
 *
 * Pins, the drift trail, the small circle a point traces around its plate's
 * Euler pole, and the neighbour dots. These are all cheap (hundreds of
 * vertices, not tens of thousands), so unlike the crust they are recomputed on
 * the CPU whenever time changes, into pre-allocated buffers.
 */

import * as THREE from '../vendor/three.module.js';
import { RibbonBuilder, densify } from './mesh.js';
import { rotateAbout, normalize, cross, sub, dot, angleBetween } from './tectonics.js';

const TRAIL_SAMPLES = 260;
const CIRCLE_SAMPLES = 400;
const RING_SAMPLES = 64;

const COLORS = {
  origin: '#3ddbff',
  originGlow: '#8af0ff',
  future: '#ff5d73',
  destination: '#ffc247',
  pole: '#b58cff',
  neighbour: '#ffe9a8',
};

/** A soft glowing dot with a ring, drawn once into a canvas and reused. */
function pinTexture(hex, ring = true) {
  const S = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  // A tight core with a fast falloff. A wide soft gradient looks lovely on its
  // own and turns into a blown-out white blob the moment two pins overlap.
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grad.addColorStop(0, '#ffffff');
  grad.addColorStop(0.07, hex);
  grad.addColorStop(0.16, hex + 'aa');
  grad.addColorStop(0.34, hex + '22');
  grad.addColorStop(1, hex + '00');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  if (ring) {
    g.strokeStyle = '#ffffffaa';
    g.lineWidth = 3;
    g.beginPath();
    g.arc(S / 2, S / 2, S * 0.23, 0, Math.PI * 2);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function sprite(hex, scale, ring = true) {
  const m = new THREE.SpriteMaterial({
    map: pinTexture(hex, ring),
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  const s = new THREE.Sprite(m);
  s.scale.setScalar(scale);
  s.visible = false;
  return s;
}

export class Markers {
  constructor(globe) {
    this.globe = globe;
    this.group = globe.markerGroup;
    this.origin = null;          // { vec, plate }
    this.destination = null;
    this.years = 0;

    this.originPin = sprite(COLORS.origin, 0.055);
    this.futurePin = sprite(COLORS.future, 0.062);
    this.destPin = sprite(COLORS.destination, 0.055);
    this.polePin = sprite(COLORS.pole, 0.042, false);
    this.group.add(this.originPin, this.futurePin, this.destPin, this.polePin);

    this._makeTrail();
    this._makeCircle();
    this._makeNeighbours();
  }

  /* ------------------------------ geometry -------------------------------- */

  _staticRibbon(count, { radius, width, opacity, gain, blending, renderOrder = 10 }) {
    const base = new Float32Array(count * 2 * 3);
    const offset = new Float32Array(count * 2 * 3);
    const color = new Float32Array(count * 2 * 3);
    const aWidth = new Float32Array(count * 2).fill(1);
    const plate = new Float32Array(count * 2);
    const index = [];
    for (let i = 0; i < count - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('aBase', new THREE.BufferAttribute(base, 3));
    g.setAttribute('aOffset', new THREE.BufferAttribute(offset, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
    g.setAttribute('aWidth', new THREE.BufferAttribute(aWidth, 1));
    g.setAttribute('aPlate', new THREE.BufferAttribute(plate, 1));
    g.setAttribute('position', g.getAttribute('aBase'));
    g.setIndex(index);
    g.computeBoundingSphere();
    g.boundingSphere.radius = 1.4;

    const mat = this.globe._ribbonMaterial({
      radius, width, opacity, gain, rotate: false, shadeMix: 0,
      blending: blending ?? THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    mesh.visible = false;
    this.group.add(mesh);
    return { mesh, geometry: g, material: mat, base, offset, color, count };
  }

  _makeTrail() {
    this.trail = this._staticRibbon(TRAIL_SAMPLES, {
      radius: 1.018, width: 0.0042, opacity: 0.95, gain: 1.5, renderOrder: 12,
    });
  }

  _makeCircle() {
    this.circle = this._staticRibbon(CIRCLE_SAMPLES, {
      radius: 1.012, width: 0.0013, opacity: 0.4, gain: 1.0, renderOrder: 11,
    });
    this.ring = this._staticRibbon(RING_SAMPLES, {
      radius: 1.0075, width: 0.0022, opacity: 0.8, gain: 1.4, renderOrder: 13,
    });
  }

  _makeNeighbours() {
    const N = 64;
    const g = new THREE.BufferGeometry();
    this._nbPos = new Float32Array(N * 3);
    this._nbSize = new Float32Array(N);
    g.setAttribute('position', new THREE.BufferAttribute(this._nbPos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this._nbSize, 1));
    g.setDrawRange(0, 0);
    const m = new THREE.ShaderMaterial({
      vertexShader: `
        attribute float aSize; uniform float uScale; varying float vFade;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vFade = 1.0;
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / max(0.6, -mv.z);
        }`,
      fragmentShader: `
        uniform vec3 uColor; varying float vFade;
        void main(){
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d);
          float a = (1.0 - smoothstep(0.24, 0.5, r)) * vFade;
          if (a <= 0.01) discard;
          gl_FragColor = vec4(uColor, a);
          #include <colorspace_fragment>
        }`,
      uniforms: {
        // gl_PointSize is in device pixels and divided by view depth, so this
        // scale is small on purpose: aSize ~4 at a camera distance of ~3.5
        // lands a dot at roughly 10px.
        uScale: { value: 4.2 * Math.min(devicePixelRatio || 1, 2) },
        uColor: { value: new THREE.Color(COLORS.neighbour).convertSRGBToLinear() },
      },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.neighbours = new THREE.Points(g, m);
    this.neighbours.frustumCulled = false;
    this.neighbours.renderOrder = 14;
    this.neighbours.visible = false;
    this.group.add(this.neighbours);
  }

  /* ------------------------------- updates -------------------------------- */

  /** Writes a polyline of unit vectors into a pre-allocated ribbon. */
  _writeRibbon(target, points, colorAt) {
    const n = Math.min(points.length, target.count);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      const prev = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      let t = sub(next, prev);
      t = sub(t, { x: p.x * dot(t, p), y: p.y * dot(t, p), z: p.z * dot(t, p) });
      const side = normalize(cross(p, normalize(t)));
      const c = colorAt(i / Math.max(1, n - 1));
      for (let k = 0; k < 2; k++) {
        const j = (i * 2 + k) * 3;
        const s = k === 0 ? 1 : -1;
        target.base[j] = p.x; target.base[j + 1] = p.y; target.base[j + 2] = p.z;
        target.offset[j] = side.x * s; target.offset[j + 1] = side.y * s; target.offset[j + 2] = side.z * s;
        target.color[j] = c[0]; target.color[j + 1] = c[1]; target.color[j + 2] = c[2];
      }
    }
    target.geometry.attributes.aBase.needsUpdate = true;
    target.geometry.attributes.aOffset.needsUpdate = true;
    target.geometry.attributes.aColor.needsUpdate = true;
    target.geometry.setDrawRange(0, Math.max(0, (n - 1) * 6));
    target.mesh.visible = n > 1;
  }

  setOrigin(origin) {
    this.origin = origin;
    if (!origin) {
      this.originPin.visible = this.futurePin.visible = this.polePin.visible = false;
      this.trail.mesh.visible = this.circle.mesh.visible = this.ring.mesh.visible = false;
      return;
    }
    // The complete small circle this point rides around its Euler pole: the
    // orbit it would follow if the plate never changed course.
    const { vec, plate } = origin;
    const pts = [];
    for (let i = 0; i <= CIRCLE_SAMPLES - 1; i++) {
      const a = (i / (CIRCLE_SAMPLES - 1)) * Math.PI * 2;
      pts.push(rotateAbout(vec, plate.poleVec, a));
    }
    const c = new THREE.Color(COLORS.pole).convertSRGBToLinear();
    this._writeRibbon(this.circle, pts, () => [c.r * 0.9, c.g * 0.9, c.b * 0.9]);

    const pole = plate.poleVec;
    // Show whichever end of the rotation axis is on the near side of the globe.
    this.polePin.position.set(pole.x * 1.03, pole.y * 1.03, pole.z * 1.03);
    this.polePin.visible = true;
    this.update(this.years);
  }

  setDestination(dest) {
    this.destination = dest;
    this.destPin.visible = !!dest;
    if (dest) this.update(this.years);
  }

  setNeighbours(list) {
    const n = Math.min(list.length, 64);
    for (let i = 0; i < n; i++) {
      const v = list[i].vec;
      this._nbPos.set([v.x * 1.012, v.y * 1.012, v.z * 1.012], i * 3);
      this._nbSize[i] = 2.2 + Math.min(2.2, Math.log10(Math.max(10, list[i].place.population)) * 0.42);
    }
    this.neighbours.geometry.attributes.position.needsUpdate = true;
    this.neighbours.geometry.attributes.aSize.needsUpdate = true;
    this.neighbours.geometry.setDrawRange(0, n);
    this.neighbours.visible = n > 0;
  }

  clearNeighbours() {
    this.neighbours.visible = false;
    this.neighbours.geometry.setDrawRange(0, 0);
  }

  /** Re-place everything for a new point in time. */
  update(years) {
    this.years = years;
    const cNow = new THREE.Color(COLORS.origin).convertSRGBToLinear();
    const cThen = new THREE.Color(COLORS.future).convertSRGBToLinear();

    if (this.origin) {
      const { vec, plate } = this.origin;
      const then = plate.positionAt(vec, years);

      this.originPin.position.set(vec.x * 1.012, vec.y * 1.012, vec.z * 1.012);
      this.originPin.visible = true;
      this.futurePin.position.set(then.x * 1.02, then.y * 1.02, then.z * 1.02);
      this.futurePin.visible = Math.abs(years) > 0 && angleBetween(vec, then) > 0.004;

      // Drift trail from now to the selected moment.
      const pts = [];
      for (let i = 0; i <= TRAIL_SAMPLES - 1; i++) {
        pts.push(plate.positionAt(vec, (years * i) / (TRAIL_SAMPLES - 1)));
      }
      this._writeRibbon(this.trail, pts, (t) => [
        cNow.r + (cThen.r - cNow.r) * t,
        cNow.g + (cThen.g - cNow.g) * t,
        cNow.b + (cThen.b - cNow.b) * t,
      ]);
      this.trail.mesh.visible = this.futurePin.visible;

      // A halo on the surface where the ground has ended up.
      const ringPts = smallCircleAround(then, 0.022, RING_SAMPLES);
      this._writeRibbon(this.ring, ringPts, () => [cThen.r, cThen.g, cThen.b]);
    }

    if (this.destination) {
      const { vec, plate } = this.destination;
      const v = plate ? plate.positionAt(vec, years) : vec;
      this.destPin.position.set(v.x * 1.02, v.y * 1.02, v.z * 1.02);
    }
  }

  /** Where each pin currently is, so the DOM can hang labels on them. */
  anchors() {
    const out = [];
    if (this.origin) {
      const { vec, plate } = this.origin;
      out.push({ id: 'origin', vec, radius: 1.03 });
      const then = plate.positionAt(vec, this.years);
      if (this.futurePin.visible) out.push({ id: 'future', vec: then, radius: 1.045 });
      out.push({ id: 'pole', vec: plate.poleVec, radius: 1.05 });
    }
    if (this.destination) {
      const { vec, plate } = this.destination;
      out.push({ id: 'destination', vec: plate ? plate.positionAt(vec, this.years) : vec, radius: 1.045 });
    }
    return out;
  }
}

/** A circle of given angular radius (radians) centred on a unit vector. */
function smallCircleAround(centre, radiusRad, samples) {
  let ref = Math.abs(centre.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const u = normalize(cross(centre, ref));
  const pts = [];
  for (let i = 0; i < samples; i++) {
    const a = (i / (samples - 1)) * Math.PI * 2;
    const axis = rotateAbout(u, centre, a);
    pts.push(rotateAbout(centre, axis, radiusRad));
  }
  return pts;
}

export { COLORS };
