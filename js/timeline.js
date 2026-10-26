// Stacked timeline: one lane per rhythm at the listening point, so peaks and troughs
// can be compared by eye. Drag anywhere on it to scrub through time.
import { sunAltitude, moonAltitude, moonIllumination } from './astro.js';
import { sampleSeries } from './data.js';

const HOUR = 3600000;

export class Timeline {
  constructor(canvas, onScrub) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.static = document.createElement('canvas');
    this.dirty = true;
    this.lanes = [];
    let dragging = false;
    const toT = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = Math.max(this.left, Math.min(r.width, e.clientX - r.left));
      return this.t0 + ((x - this.left) / (r.width - this.left)) * (this.t1 - this.t0);
    };
    canvas.addEventListener('pointerdown', (e) => { dragging = true; canvas.setPointerCapture(e.pointerId); onScrub(toT(e), true); });
    canvas.addEventListener('pointermove', (e) => { if (dragging) onScrub(toT(e), false); });
    const end = () => { dragging = false; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  layout(state) {
    const L = state.layers;
    const lanes = [];
    if (L.daynight.show) lanes.push('sun');
    if (L.moon.show) lanes.push('moon');
    if (L.tides.show) lanes.push('tide');
    if (L.wind.show) lanes.push('wind');
    if (L.temp.show) lanes.push('temp');
    if (L.aurora.show) lanes.push('kp');
    if (L.quakes.show) lanes.push('quakes');
    this.lanes = lanes;
    const w = this.canvas.clientWidth;
    this.laneH = w < 600 ? 30 : 36;
    this.left = w < 600 ? 64 : 92;
    const h = 22 + lanes.length * this.laneH;
    this.canvas.style.height = `${h}px`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr; this.W = w; this.H = h;
    for (const c of [this.canvas, this.static]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    this.dirty = true;
  }

  x(t) { return this.left + ((t - this.t0) / (this.t1 - this.t0)) * (this.W - this.left); }

  drawStatic(state) {
    const c = this.static.getContext('2d');
    const { W, H, dpr, left, laneH } = this;
    const css = getComputedStyle(document.documentElement);
    const col = (n) => css.getPropertyValue(n).trim();
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const { lat, lon } = state.loc;
    const off = state.utcOffset * 1000;
    const N = Math.min(600, Math.round(W - left));
    const ts = Array.from({ length: N + 1 }, (_, i) => this.t0 + (i / N) * (this.t1 - this.t0));

    // Day separators + labels (local time at the listening point)
    c.font = '11px system-ui, sans-serif';
    c.textBaseline = 'top';
    const firstMidnight = Math.ceil((this.t0 + off) / 86400000) * 86400000 - off;
    for (let m = firstMidnight; m < this.t1; m += 86400000) {
      const x = this.x(m);
      c.strokeStyle = col('--grid'); c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
      const d = new Date(m + off);
      c.fillStyle = col('--muted');
      c.fillText(d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' }), x + 4, 4);
    }
    // "now" marker
    const nx = this.x(Date.now());
    c.strokeStyle = col('--accent'); c.setLineDash([3, 3]);
    c.beginPath(); c.moveTo(nx, 16); c.lineTo(nx, H); c.stroke();
    c.setLineDash([]);
    c.fillStyle = col('--accent'); c.fillText('now', nx + 3, H - 13 > 18 ? 18 : 4);

    this.lanes.forEach((lane, i) => {
      const y0 = 20 + i * laneH;
      const y1 = y0 + laneH - 4;
      c.fillStyle = col('--lane');
      c.fillRect(left, y0, W - left, laneH - 4);
      c.fillStyle = col('--text');
      c.textBaseline = 'middle';
      c.fillText(LANE_LABEL[lane], 6, (y0 + y1) / 2);
      c.textBaseline = 'top';
      const plot = (vals, lo, hi, stroke, fill) => {
        c.beginPath();
        let started = false;
        vals.forEach((v, k) => {
          if (v == null) return;
          const x = this.x(ts[k]);
          const y = y1 - ((v - lo) / (hi - lo)) * (y1 - y0 - 2) - 1;
          if (started) c.lineTo(x, y); else { c.moveTo(x, y); started = true; }
        });
        c.strokeStyle = stroke; c.lineWidth = 1.4; c.stroke();
        if (fill) { c.lineTo(this.x(ts[N]), y1); c.lineTo(this.x(ts[0]), y1); c.closePath(); c.fillStyle = fill; c.fill(); }
      };
      const noData = (msg) => { c.fillStyle = col('--muted'); c.textBaseline = 'middle'; c.fillText(msg, left + 8, (y0 + y1) / 2); c.textBaseline = 'top'; };

      if (lane === 'sun') {
        const alts = ts.map((t) => sunAltitude(t, lat, lon));
        // daylight blocks
        ts.forEach((t, k) => { if (k && alts[k] > 0) { c.fillStyle = 'rgba(245,194,107,0.13)'; c.fillRect(this.x(ts[k - 1]), y0, this.x(t) - this.x(ts[k - 1]) + 0.5, y1 - y0); } });
        const hor = y1 - ((0 + 90) / 180) * (y1 - y0);
        c.strokeStyle = col('--grid'); c.beginPath(); c.moveTo(left, hor); c.lineTo(W, hor); c.stroke();
        plot(alts, -90, 90, col('--sun'));
      } else if (lane === 'moon') {
        plot(ts.map((t) => moonAltitude(t, lat, lon)), -90, 90, col('--moon'));
        const ill = moonIllumination(state.t);
        c.fillStyle = col('--muted');
        c.textBaseline = 'middle';
        c.textAlign = 'right';
        c.textBaseline = 'top';
        c.fillText(`${Math.round(ill.fraction * 100)}% lit`, W - 6, y0 + 2);
        c.textAlign = 'left';
        c.textBaseline = 'top';
      } else if (lane === 'tide') {
        const tide = state.data.localTide;
        if (!tide) return noData(state.status.tide === 'loading' ? 'loading…' : 'no sea nearby / unavailable');
        const v = ts.map((t) => sampleSeries(tide.times, tide.sea, t));
        const valid = tide.sea.filter((x) => x != null);
        plot(v, Math.min(...valid) - 0.05, Math.max(...valid) + 0.05, col('--tide'), 'rgba(90,190,255,0.15)');
      } else if (lane === 'wind') {
        const d = state.data.local;
        if (!d) return noData(state.status.local === 'loading' ? 'loading…' : 'unavailable');
        const hi = Math.max(5, ...d.gust.filter((x) => x != null));
        plot(ts.map((t) => sampleSeries(d.times, d.gust, t)), 0, hi, 'rgba(200,220,255,0.35)');
        plot(ts.map((t) => sampleSeries(d.times, d.wind, t)), 0, hi, col('--wind'), 'rgba(200,220,255,0.12)');
      } else if (lane === 'temp') {
        const d = state.data.local;
        if (!d) return noData(state.status.local === 'loading' ? 'loading…' : 'unavailable');
        const valid = d.temp.filter((x) => x != null);
        plot(ts.map((t) => sampleSeries(d.times, d.temp, t)), Math.min(...valid) - 1, Math.max(...valid) + 1, col('--temp'));
      } else if (lane === 'kp') {
        const kp = state.data.kp;
        if (!kp) return noData(state.status.kp === 'loading' ? 'loading…' : 'unavailable');
        for (const r of kp) {
          if (r.t + 3 * HOUR < this.t0 || r.t > this.t1) continue;
          const xa = this.x(r.t);
          const xb = this.x(r.t + 3 * HOUR);
          const h = (r.kp / 9) * (y1 - y0);
          c.fillStyle = r.kp >= 6 ? '#ff6b6b' : r.kp >= 5 ? '#ffc861' : col('--aurora');
          c.globalAlpha = r.predicted ? 0.4 : 0.85;
          c.fillRect(xa + 0.5, y1 - h, Math.max(1, xb - xa - 1), h);
          c.globalAlpha = 1;
        }
      } else if (lane === 'quakes') {
        const qs = state.data.quakes;
        if (!qs) return noData(state.status.quakes === 'loading' ? 'loading…' : 'unavailable');
        for (const q of qs) {
          if (q.t < this.t0 || q.t > this.t1) continue;
          const x = this.x(q.t);
          const h = Math.min(1, (q.mag - 2) / 5.5) * (y1 - y0);
          c.strokeStyle = q.mag >= 5 ? '#ff7a5c' : 'rgba(255,140,110,0.55)';
          c.lineWidth = q.mag >= 5 ? 1.6 : 1;
          c.beginPath(); c.moveTo(x, y1); c.lineTo(x, y1 - h); c.stroke();
        }
      }
    });
    this.dirty = false;
  }

  draw(state) {
    if (this.dirty) this.drawStatic(state);
    const c = this.ctx;
    const { dpr, H } = this;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    c.drawImage(this.static, 0, 0);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const x = this.x(state.t);
    c.strokeStyle = '#fff'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(x, 16); c.lineTo(x, H); c.stroke();
    c.fillStyle = '#fff';
    c.beginPath(); c.moveTo(x - 6, 14); c.lineTo(x + 6, 14); c.lineTo(x, 21); c.closePath(); c.fill();
  }
}

const LANE_LABEL = {
  sun: 'Sun', moon: 'Moon', tide: 'Tide', wind: 'Wind', temp: 'Temp', kp: 'Kp', quakes: 'Quakes',
};
