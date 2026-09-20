/**
 * controls.js — orbit camera with a bit of weight to it.
 *
 * Hand-rolled rather than OrbitControls because this globe needs things
 * OrbitControls fights you on: momentum that feels like spinning a real globe,
 * an idle drift, and scripted fly-to moves that hand control back cleanly.
 */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class GlobeControls {
  constructor(camera, dom, THREE) {
    this.camera = camera;
    this.dom = dom;
    this.THREE = THREE;

    this.lon = 20;          // camera longitude, degrees
    this.lat = 18;          // camera latitude, degrees
    this.dist = 4.3;        // distance from globe centre

    this.target = { lon: this.lon, lat: this.lat, dist: this.dist };
    this.velocity = { lon: 0, lat: 0 };

    this.minDist = 1.35;
    this.fitDist = 4.3;     // distance at which the whole globe fits the free band
    // Roomy on purpose: a tall narrow phone needs the camera further back than
    // a laptop does before the whole globe fits, and the fit distance must not
    // land on the clamp.
    this.maxDist = 8.6;
    this.autoRotate = false;   // switched on only while the reader is choosing a place
    this.autoRotateSpeed = 1.6;   // degrees per second
    this.idleDelay = 2500;

    this.dragging = false;
    this.lastInteraction = 0;
    this.flight = null;
    this.onChange = null;

    this._bind();
  }

  _bind() {
    const dom = this.dom;
    let pointers = new Map();
    let pinchStart = null;

    const pos = (e) => ({ x: e.clientX, y: e.clientY });

    dom.addEventListener('pointerdown', (e) => {
      dom.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, pos(e));
      this.dragging = true;
      this.flight = null;
      this.velocity.lon = this.velocity.lat = 0;
      this.lastInteraction = performance.now();
      this._moved = false;
    });

    dom.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      const prev = pointers.get(e.pointerId);
      const cur = pos(e);
      pointers.set(e.pointerId, cur);

      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchStart) {
          this.target.dist = clamp(this.target.dist * (pinchStart / d), this.minDist, this.maxDist);
        }
        pinchStart = d;
        return;
      }

      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) this._moved = true;
      // Slower when zoomed in, so close inspection stays controllable.
      const k = 0.22 * (this.dist / 3.2);
      this.target.lon -= dx * k;
      this.target.lat = clamp(this.target.lat + dy * k, -88, 88);
      this.velocity.lon = -dx * k;
      this.velocity.lat = dy * k;
      this.lastInteraction = performance.now();
    });

    const end = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (pointers.size === 0) {
        this.dragging = false;
        this.lastInteraction = performance.now();
      }
    };
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);

    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.flight = null;
      const factor = Math.exp(clamp(e.deltaY, -120, 120) * 0.0016);
      this.target.dist = clamp(this.target.dist * factor, this.minDist, this.maxDist);
      this.lastInteraction = performance.now();
    }, { passive: false });
  }

  /** True when the pointer went down and up without a real drag — i.e. a click. */
  get wasClick() { return !this._moved; }

  flyTo({ lon, lat, dist }, duration = 1400) {
    const from = { lon: this.target.lon, lat: this.target.lat, dist: this.target.dist };
    // Always take the short way round.
    let dLon = ((lon - from.lon + 540) % 360) - 180;
    this.flight = {
      from, dLon, lat, dist: dist ?? from.dist,
      start: performance.now(), duration,
    };
    this.lastInteraction = performance.now();
  }

  update(dt) {
    const now = performance.now();

    if (this.flight) {
      const f = this.flight;
      const t = clamp((now - f.start) / f.duration, 0, 1);
      const e = easeInOut(t);
      this.target.lon = f.from.lon + f.dLon * e;
      this.target.lat = f.from.lat + (f.lat - f.from.lat) * e;
      // Pull back and swoop in — reads as travel rather than a jump cut.
      const arc = Math.sin(Math.PI * t) * 0.35;
      this.target.dist = f.from.dist + (f.dist - f.from.dist) * e + arc;
      if (t >= 1) { this.flight = null; this.lastInteraction = now; }
    } else if (!this.dragging) {
      // Momentum, then idle drift once it has bled off.
      this.target.lon += this.velocity.lon;
      this.target.lat = clamp(this.target.lat + this.velocity.lat, -88, 88);
      this.velocity.lon *= 0.93;
      this.velocity.lat *= 0.93;
      if (Math.abs(this.velocity.lon) < 0.002) this.velocity.lon = 0;
      if (Math.abs(this.velocity.lat) < 0.002) this.velocity.lat = 0;

      if (this.autoRotate && now - this.lastInteraction > this.idleDelay && !this.velocity.lon) {
        this.target.lon -= this.autoRotateSpeed * dt;
      }
    }

    const k = 1 - Math.pow(0.0015, dt);
    this.lon += (this.target.lon - this.lon) * k;
    this.lat += (this.target.lat - this.lat) * k;
    this.dist += (this.target.dist - this.dist) * k;

    const p = this.lat * Math.PI / 180;
    const l = this.lon * Math.PI / 180;
    const c = Math.cos(p);
    this.camera.position.set(
      this.dist * c * Math.cos(l),
      this.dist * c * Math.sin(l),
      this.dist * Math.sin(p),
    );
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(0, 0, 0);
    if (this.onChange) this.onChange();
  }
}
