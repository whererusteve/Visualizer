// World map renderer (equirectangular projection, centred on the listening point).
import { subSolar, subLunar, altitudeFrom, geomagneticLat, auroraEdge, moonIllumination } from './astro.js';
import { WIND_GRID, sampleSeries } from './data.js';
import { RHYTHMS } from './resonance.js';

const SHADE_W = 360;
const SHADE_H = 180;

export class EarthMap {
  constructor(canvas, landGeo) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.land = landGeo;
    this.centerLon = 0;
    this.base = document.createElement('canvas');
    this.shade = document.createElement('canvas');
    this.shade.width = SHADE_W;
    this.shade.height = SHADE_H;
    this.shadeCtx = this.shade.getContext('2d');
    this.shadeImg = this.shadeCtx.createImageData(SHADE_W, SHADE_H);
    this.trails = document.createElement('canvas');
    this.particles = [];
    this.windNow = null;
    this.ripples = [];
    this.resoRipples = [];
    this.lastResoPulse = 0;
    const css = getComputedStyle(document.documentElement);
    this.rcolors = Object.fromEntries(Object.entries(RHYTHMS).map(([k, d]) => [k, css.getPropertyValue(d.color).trim() || '#fff']));
    // Geomagnetic latitude per shade pixel never changes, so compute it once.
    this.gmLat = new Float32Array(SHADE_W * SHADE_H);
    this.sinLat = new Float32Array(SHADE_H);
    this.cosLat = new Float32Array(SHADE_H);
    for (let y = 0; y < SHADE_H; y++) {
      const lat = 90 - (y + 0.5);
      this.sinLat[y] = Math.sin((lat * Math.PI) / 180);
      this.cosLat[y] = Math.cos((lat * Math.PI) / 180);
      for (let x = 0; x < SHADE_W; x++) this.gmLat[y * SHADE_W + x] = geomagneticLat(lat, x + 0.5 - 180);
    }
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth;
    const h = Math.round(w / 2);
    this.canvas.style.height = `${h}px`;
    this.dpr = dpr;
    this.W = w;
    this.H = h;
    for (const c of [this.canvas, this.base, this.trails]) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    this.drawBase();
    const n = Math.min(3500, Math.round((w * h) / 420));
    this.ui = Math.max(0.55, Math.min(1, w / 1100)); // marker size scale for small screens
    this.particles = Array.from({ length: n }, () => this.spawn({}));
  }

  setCenter(lon) {
    if (lon === this.centerLon) return;
    this.centerLon = lon;
    this.trails.getContext('2d').clearRect(0, 0, this.trails.width, this.trails.height);
  }

  // lat/lon → CSS pixels, with the map centred on centerLon
  project(lat, lon) {
    let dx = lon - this.centerLon;
    dx = ((((dx + 180) % 360) + 360) % 360);
    return [(dx / 360) * this.W, ((90 - lat) / 180) * this.H];
  }
  unproject(x, y) {
    let lon = (x / this.W) * 360 - 180 + this.centerLon;
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    return [90 - (y / this.H) * 180, lon];
  }

  // Land drawn once in a standard (0°-centred) frame, then blitted with an offset.
  drawBase() {
    const c = this.base.getContext('2d');
    const { W, H, dpr } = this;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    c.fillStyle = css.getPropertyValue('--ocean').trim() || '#0b1a2c';
    c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(255,255,255,0.05)';
    c.lineWidth = 1;
    for (let lon = -180; lon <= 180; lon += 30) { const x = ((lon + 180) / 360) * W; c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    for (let lat = -60; lat <= 60; lat += 30) { const y = ((90 - lat) / 180) * H; c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
    c.fillStyle = css.getPropertyValue('--land').trim() || '#24364a';
    c.strokeStyle = css.getPropertyValue('--coast').trim() || '#3d5873';
    c.lineWidth = 0.6;
    c.beginPath();
    const geoms = this.land.type === 'FeatureCollection' ? this.land.features.map((f) => f.geometry) : [this.land.geometry || this.land];
    for (const g of geoms) {
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      for (const poly of polys) for (const ring of poly) {
        ring.forEach(([lon, lat], i) => {
          const x = ((lon + 180) / 360) * W;
          const y = ((90 - lat) / 180) * H;
          if (i) c.lineTo(x, y); else c.moveTo(x, y);
        });
        c.closePath();
      }
    }
    c.fill('evenodd');
    c.stroke();
  }

  // Blit a 0°-centred image so that centerLon sits in the middle.
  blitCentered(img) {
    const { W, H } = this;
    const off = ((((W / 2 - ((this.centerLon + 180) / 360) * W) % W) + W) % W);
    this.ctx.drawImage(img, off, 0, W, H);
    this.ctx.drawImage(img, off - W, 0, W, H);
  }

  updateShade(ms, showNight, kp) {
    const sun = subSolar(ms);
    const d = this.shadeImg.data;
    const sinD = Math.sin((sun.lat * Math.PI) / 180);
    const cosD = Math.cos((sun.lat * Math.PI) / 180);
    const cosH = new Float32Array(SHADE_W);
    for (let x = 0; x < SHADE_W; x++) cosH[x] = Math.cos(((x + 0.5 - 180 - sun.lon) * Math.PI) / 180);
    const edge = kp == null ? null : auroraEdge(kp);
    const auroraStrength = kp == null ? 0 : Math.min(1, 0.25 + kp / 7);
    for (let y = 0; y < SHADE_H; y++) {
      const sL = this.sinLat[y];
      const cL = this.cosLat[y];
      for (let x = 0; x < SHADE_W; x++) {
        const i = y * SHADE_W + x;
        const alt = (Math.asin(sL * sinD + cL * cosD * cosH[x]) * 180) / Math.PI;
        let r = 0, g = 0, b = 0, a = 0;
        if (showNight) {
          const night = Math.min(1, Math.max(0, -alt / 15)); // 0 at sunset → 1 at 15° below
          a = night * 0.75;
          r = 3; g = 7; b = 24;
          // golden-hour glow along the terminator
          const glow = Math.max(0, 1 - Math.abs(alt + 1) / 5);
          if (glow > 0) { r = 255 * glow + r * (1 - glow); g = 130 * glow + g * (1 - glow); b = 50 * glow + b * (1 - glow); a = Math.max(a, 0.22 * glow); }
        }
        if (edge != null && alt < -4) {
          const gm = Math.abs(this.gmLat[i]);
          const band = Math.max(0, 1 - Math.abs(gm - (edge + 4)) / 4.5);
          if (band > 0) {
            const k = band * auroraStrength * Math.min(1, (-alt - 4) / 8);
            r = r * (1 - k) + 70 * k; g = g * (1 - k) + 255 * k; b = b * (1 - k) + 150 * k;
            a = Math.max(a, 0.15 + 0.55 * k);
          }
        }
        d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a * 255;
      }
    }
    this.shadeCtx.putImageData(this.shadeImg, 0, 0);
  }

  // ---------- wind ----------
  setWindTime(wind, ms) {
    if (!wind) { this.windNow = null; return; }
    const { times, u, v, nPts } = wind;
    const step = times[1] - times[0];
    let f = (ms - times[0]) / step;
    f = Math.max(0, Math.min(times.length - 1.001, f));
    const h = Math.floor(f);
    const w = f - h;
    if (!this.windNow) this.windNow = { u: new Float32Array(nPts), v: new Float32Array(nPts) };
    for (let p = 0; p < nPts; p++) {
      this.windNow.u[p] = u[h * nPts + p] * (1 - w) + u[(h + 1) * nPts + p] * w;
      this.windNow.v[p] = v[h * nPts + p] * (1 - w) + v[(h + 1) * nPts + p] * w;
    }
  }

  windAt(lat, lon) {
    const { lons, lats, dLon, dLat } = WIND_GRID;
    const nx = lons.length;
    const fi = (((lon + 180) % 360) + 360) % 360 / dLon;
    const i0 = Math.floor(fi) % nx;
    const i1 = (i0 + 1) % nx;
    const tx = fi - Math.floor(fi);
    const fj = Math.max(0, Math.min(lats.length - 1.001, (lats[0] - lat) / dLat));
    const j0 = Math.floor(fj);
    const ty = fj - j0;
    const U = this.windNow.u;
    const V = this.windNow.v;
    const idx = (j, i) => j * nx + i;
    const bl = (A) => (A[idx(j0, i0)] * (1 - tx) + A[idx(j0, i1)] * tx) * (1 - ty) +
      (A[idx(j0 + 1, i0)] * (1 - tx) + A[idx(j0 + 1, i1)] * tx) * ty;
    return [bl(U), bl(V)];
  }

  spawn(p) {
    p.lat = Math.asin(Math.random() * 2 * 0.985 - 0.985) * 180 / Math.PI; // even over the sphere
    p.lon = Math.random() * 360 - 180;
    p.age = Math.floor(Math.random() * 90);
    return p;
  }

  drawWind(dt) {
    const tc = this.trails.getContext('2d');
    const { dpr } = this;
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.globalCompositeOperation = 'destination-in';
    tc.fillStyle = 'rgba(0,0,0,0.9)';
    tc.fillRect(0, 0, this.trails.width, this.trails.height);
    tc.globalCompositeOperation = 'source-over';
    if (!this.windNow) return;
    tc.setTransform(dpr, 0, 0, dpr, 0, 0);
    tc.lineWidth = 1.1;
    const buckets = [[], [], [], []];
    const k = 0.03 * Math.min(dt / 16.7, 3) * (this.W < 600 ? 1.4 : 1);
    for (const p of this.particles) {
      if (--p.age < 0 || Math.abs(p.lat) > 80) { this.spawn(p); p.age = 60 + Math.random() * 60; continue; }
      const [u, v] = this.windAt(p.lat, p.lon);
      const speed = Math.hypot(u, v);
      const [x0, y0] = this.project(p.lat, p.lon);
      p.lon += (u * k) / Math.max(0.2, Math.cos((p.lat * Math.PI) / 180));
      p.lat += v * k;
      if (p.lon > 180) p.lon -= 360; else if (p.lon < -180) p.lon += 360;
      const [x1, y1] = this.project(p.lat, p.lon);
      if (Math.abs(x1 - x0) > this.W / 2) continue;
      const b = speed < 4 ? 0 : speed < 9 ? 1 : speed < 15 ? 2 : 3;
      buckets[b].push(x0, y0, x1, y1);
    }
    const colors = ['rgba(170,200,255,0.3)', 'rgba(225,240,255,0.6)', 'rgba(255,230,150,0.8)', 'rgba(255,140,120,0.9)'];
    buckets.forEach((segs, bi) => {
      tc.strokeStyle = colors[bi];
      tc.beginPath();
      for (let i = 0; i < segs.length; i += 4) { tc.moveTo(segs[i], segs[i + 1]); tc.lineTo(segs[i + 2], segs[i + 3]); }
      tc.stroke();
    });
  }

  addRipple(lat, lon, mag) {
    this.ripples.push({ lat, lon, mag, born: performance.now() });
  }

  // ---------- frame ----------
  draw(state, dt) {
    const c = this.ctx;
    const { W, H, dpr } = this;
    const L = state.layers;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.imageSmoothingEnabled = true;
    this.blitCentered(this.base);

    // Tide stations (under the night shade so they glow softly on the dark side)
    if (L.tides.show && state.data.tides) {
      for (const s of state.data.tides) {
        const h = sampleSeries(s.times, s.sea, state.t);
        if (h == null) continue;
        const n = (h - s.min) / Math.max(0.01, s.max - s.min);
        const range = s.max - s.min;
        const [x, y] = this.project(s.lat, s.lon);
        const R = (2 + Math.min(14, 2 + range * 2.2) * (0.35 + 0.65 * n)) * this.ui;
        c.fillStyle = `rgba(90,190,255,${0.15 + 0.45 * n})`;
        c.strokeStyle = 'rgba(140,215,255,0.8)';
        c.lineWidth = 1;
        c.beginPath(); c.arc(x, y, R, 0, Math.PI * 2); c.fill(); c.stroke();
      }
    }

    if (L.daynight.show || (L.aurora.show && state.kpNow != null)) {
      this.updateShade(state.t, L.daynight.show, L.aurora.show ? state.kpNow : null);
      this.blitCentered(this.shade);
    }

    if (L.wind.show) {
      this.drawWind(dt);
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(this.trails, 0, 0);
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Earthquakes in the 24 h before the playhead, fading with age
    if (L.quakes.show && state.data.quakes) {
      const DAY = 86400000;
      for (const q of state.data.quakes) {
        const age = state.t - q.t;
        if (age < 0 || age > DAY) continue;
        const [x, y] = this.project(q.lat, q.lon);
        const fade = 1 - age / DAY;
        const r = Math.max(1.2, (q.mag - 2) * 1.5 * this.ui);
        c.fillStyle = `rgba(255,${120 - q.mag * 10},90,${0.25 + 0.6 * fade})`;
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      }
      const now = performance.now();
      this.ripples = this.ripples.filter((rp) => now - rp.born < 3000);
      for (const rp of this.ripples) {
        const k = (now - rp.born) / 3000;
        const [x, y] = this.project(rp.lat, rp.lon);
        c.strokeStyle = `rgba(255,120,90,${1 - k})`;
        c.lineWidth = 1.5;
        c.beginPath(); c.arc(x, y, (3 + k * (6 + rp.mag * 5)) * this.ui, 0, Math.PI * 2); c.stroke();
      }
    }

    // Sun & moon overhead points
    if (L.daynight.show) {
      const s = subSolar(state.t);
      const [x, y] = this.project(s.lat, s.lon);
      const g = c.createRadialGradient(x, y, 0, x, y, 22);
      g.addColorStop(0, 'rgba(255,220,120,0.95)'); g.addColorStop(0.3, 'rgba(255,190,90,0.5)'); g.addColorStop(1, 'rgba(255,190,90,0)');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, 22, 0, Math.PI * 2); c.fill();
    }
    if (L.moon.show) {
      const m = subLunar(state.t);
      const [x, y] = this.project(m.lat, m.lon);
      drawMoon(c, x, y, 7, moonIllumination(state.t).phase);
    }

    if (L.resonance.show && state.hotNow) this.drawHotspots(state.hotNow);
    if (L.resonance.show && state.resoNow) this.drawResonance(state);

    // Listening point
    const [lx, ly] = this.project(state.loc.lat, state.loc.lon);
    c.strokeStyle = '#fff'; c.lineWidth = 1.5;
    c.beginPath(); c.arc(lx, ly, 6, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(lx - 11, ly); c.lineTo(lx - 7, ly); c.moveTo(lx + 7, ly); c.lineTo(lx + 11, ly);
    c.moveTo(lx, ly - 11); c.lineTo(lx, ly - 7); c.moveTo(lx, ly + 7); c.lineTo(lx, ly + 11); c.stroke();
  }
}

// Resonance rings at the listening point. Each rhythm nearing a peak draws its own
// coloured ring. Out of step, the rings sit apart and wobble at the same rate as
// the beating you hear. As rhythms line up the wobble stops, the rings merge into
// one bright circle and it sends out ripples.
EarthMap.prototype.drawResonance = function drawResonance(state) {
  const { p, R, aligned } = state.resoNow;
  const keys = Object.keys(p).filter((k) => p[k] > 0.05 && state.layers[RHYTHMS[k].layer].show);
  const c = this.ctx;
  const [x, y] = this.project(state.loc.lat, state.loc.lon);
  const ui = this.ui;
  const now = performance.now();
  const secs = now / 1000;
  const sumP = keys.reduce((a, k) => a + p[k], 0);
  const base = (13 + 6 * Math.min(2, sumP) + 6 * R) * ui;
  const out = Math.pow(1 - R, 1.5);
  const beatHz = 220 * (Math.pow(2, (out * 30) / 1200) - 1); // same wobble rate as the audio
  c.save();

  if (R > 0.02) {
    const g = c.createRadialGradient(x, y, 0, x, y, base * 3.2);
    g.addColorStop(0, `rgba(255,244,214,${0.55 * R})`);
    g.addColorStop(0.35, `rgba(255,230,180,${0.22 * R})`);
    g.addColorStop(1, 'rgba(255,230,180,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, base * 3.2, 0, Math.PI * 2); c.fill();
  }

  keys.sort((a, b) => RHYTHMS[a].partial - RHYTHMS[b].partial).forEach((k, i) => {
    const radius = base + (i - (keys.length - 1) / 2) * 5 * ui * out;
    const wob = 5 * ui * out * p[k];
    const lobes = 2 + RHYTHMS[k].partial;
    const phase = secs * beatHz * Math.PI * 2 * (i % 2 ? 1 : -1) / lobes;
    c.globalAlpha = Math.min(1, 0.2 + 0.7 * p[k] + 0.3 * R);
    c.strokeStyle = this.rcolors[k];
    c.lineWidth = (1 + 1.5 * p[k] + R) * ui;
    c.beginPath();
    for (let a = 0; a <= 64; a++) {
      const th = (a / 64) * Math.PI * 2;
      const rr = radius + wob * Math.sin(lobes * th + phase);
      const px = x + rr * Math.cos(th);
      const py = y + rr * Math.sin(th);
      if (a) c.lineTo(px, py); else c.moveTo(px, py);
    }
    c.stroke();
  });

  // Ripples while resonating
  if (R > 0.5 && now - this.lastResoPulse > 1400 - 600 * R) {
    this.resoRipples.push({ born: now, R });
    this.lastResoPulse = now;
  }
  this.resoRipples = this.resoRipples.filter((rp) => now - rp.born < 2600);
  for (const rp of this.resoRipples) {
    const k = (now - rp.born) / 2600;
    c.globalAlpha = (1 - k) * 0.7 * rp.R;
    c.strokeStyle = '#fff4d6';
    c.lineWidth = 1.5 * ui;
    c.beginPath(); c.arc(x, y, base + k * 70 * ui, 0, Math.PI * 2); c.stroke();
  }

  if (R > 0.35 && aligned.length >= 2) {
    c.globalAlpha = Math.min(1, R * 1.4);
    c.font = `600 ${Math.round(12 * Math.max(0.85, ui))}px system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    const label = aligned.slice(0, 3).map((e) => e.label).join(' · ');
    const ty = y - base - 10 * ui < 14 ? y + base + 22 * ui : y - base - 8 * ui;
    c.lineWidth = 3; c.strokeStyle = 'rgba(7,11,20,0.85)';
    c.strokeText(label, x, ty);
    c.fillStyle = '#fff4d6';
    c.fillText(label, x, ty);
  }
  c.restore();
};

// Tide stations that are resonating right now glow and pulse on the map.
EarthMap.prototype.drawHotspots = function drawHotspots(hot) {
  const c = this.ctx;
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 350);
  c.save();
  for (const { h, R } of hot) {
    if (R < 0.15) continue;
    const [x, y] = this.project(h.lat, h.lon);
    const rad = (10 + 18 * R + 4 * pulse * R) * this.ui;
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(255,244,214,${0.75 * R})`);
    g.addColorStop(0.4, `rgba(255,226,170,${0.3 * R})`);
    g.addColorStop(1, 'rgba(255,226,170,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fill();
    c.globalAlpha = R;
    c.strokeStyle = '#fff4d6';
    c.lineWidth = 1.2;
    c.beginPath(); c.arc(x, y, rad * (0.55 + 0.25 * pulse), 0, Math.PI * 2); c.stroke();
    c.globalAlpha = 1;
  }
  c.restore();
};

// Little moon glyph with the right phase (lit part on the right while waxing).
export function drawMoon(c, x, y, r, phase) {
  c.save();
  c.fillStyle = 'rgba(40,48,70,0.9)';
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#e9ecf5';
  const waxing = phase < 0.5;
  const k = Math.cos(phase * 2 * Math.PI); // 1 new → -1 full
  c.beginPath();
  c.arc(x, y, r, -Math.PI / 2, Math.PI / 2, !waxing);
  c.ellipse(x, y, Math.abs(k) * r, r, 0, Math.PI / 2, -Math.PI / 2, waxing ? k > 0 : k < 0);
  c.fill();
  c.restore();
}
