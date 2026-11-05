// Resonance: finds the peak moments of each rhythm at the listening point
// (sunrise, high tide, moonrise…) and measures how closely they line up.
//
// Each rhythm owns one note of the natural harmonic series on D (D2 = 73.42 Hz).
// Notes of the harmonic series are the ones that ring together most purely,
// which is why "lined up" rhythms sound like a chord settling into tune.

import { sunAltitude, moonAltitude } from './astro.js';

const MIN = 60000;
const HOUR = 60 * MIN;
const STEP = 5 * MIN;        // sampling step for sun & moon
const SIGMA = 35 * MIN;      // how long a peak "glows" either side of its moment
const WINDOW = 30 * MIN;     // events closer than this count as aligned

export const RHYTHMS = {
  sun:    { layer: 'daynight', partial: 3, color: '--sun',    name: 'Sun' },
  tide:   { layer: 'tides',    partial: 2, color: '--tide',   name: 'Tide' },
  moon:   { layer: 'moon',     partial: 5, color: '--moon',   name: 'Moon' },
  temp:   { layer: 'temp',     partial: 4, color: '--temp',   name: 'Temperature' },
  wind:   { layer: 'wind',     partial: 6, color: '--wind',   name: 'Wind' },
  kp:     { layer: 'aurora',   partial: 8, color: '--aurora', name: 'Aurora' },
  quakes: { layer: 'quakes',   partial: 1, color: '--quake',  name: 'Quake' },
};
export const D2 = 73.42;

// --- event finders -------------------------------------------------------

// Times where a sampled curve crosses `level`, with linear interpolation.
function crossings(ts, ys, level, upLabel, downLabel, r) {
  const out = [];
  for (let k = 1; k < ys.length; k++) {
    const a = ys[k - 1] - level;
    const b = ys[k] - level;
    if (a < 0 && b >= 0) out.push({ r, t: ts[k - 1] + (ts[k] - ts[k - 1]) * (-a / (b - a)), label: upLabel });
    else if (a >= 0 && b < 0) out.push({ r, t: ts[k - 1] + (ts[k] - ts[k - 1]) * (a / (a - b)), label: downLabel });
  }
  return out;
}

// Peaks/troughs that are the highest/lowest value within ±span, refined with a parabola.
function extrema(ts, ys, spanMs, onMax, onMin) {
  const out = [];
  if (ts.length < 3) return out;
  const step = ts[1] - ts[0];
  const span = Math.max(1, Math.round(spanMs / step));
  for (let k = 1; k < ys.length - 1; k++) {
    const y = ys[k];
    if (y == null || ys[k - 1] == null || ys[k + 1] == null) continue;
    let isMax = true;
    let isMin = true;
    for (let j = Math.max(0, k - span); j <= Math.min(ys.length - 1, k + span); j++) {
      if (j === k || ys[j] == null) continue;
      if (ys[j] > y || (ys[j] === y && j < k)) isMax = false;
      if (ys[j] < y || (ys[j] === y && j < k)) isMin = false;
    }
    if (!isMax && !isMin) continue;
    const denom = ys[k - 1] - 2 * y + ys[k + 1];
    const off = denom ? Math.max(-0.5, Math.min(0.5, (0.5 * (ys[k - 1] - ys[k + 1])) / denom)) : 0;
    const t = ts[k] + off * step;
    if (isMax && onMax) { const e = onMax(t, y); if (e) out.push(e); }
    if (isMin && onMin) { const e = onMin(t, y); if (e) out.push(e); }
  }
  return out;
}

export function findEvents(state) {
  const { lat, lon } = state.loc;
  const { t0, t1 } = state;
  const active = (r) => state.layers[RHYTHMS[r].layer].show;
  const ev = [];
  const ts = [];
  for (let t = t0; t <= t1; t += STEP) ts.push(t);

  if (active('sun')) {
    const alt = ts.map((t) => sunAltitude(t, lat, lon));
    ev.push(...crossings(ts, alt, -0.833, 'Sunrise', 'Sunset', 'sun'));
    ev.push(...extrema(ts, alt, 6 * HOUR, (t, y) => (y > 0 ? { r: 'sun', t, label: 'Solar noon' } : null)));
  }
  if (active('moon')) {
    const alt = ts.map((t) => moonAltitude(t, lat, lon));
    ev.push(...crossings(ts, alt, 0.13, 'Moonrise', 'Moonset', 'moon'));
    ev.push(...extrema(ts, alt, 6 * HOUR, (t, y) => (y > 0 ? { r: 'moon', t, label: 'Moon highest' } : null)));
  }
  const tide = state.data.localTide;
  if (active('tide') && tide) {
    ev.push(...extrema(tide.times, tide.sea, 4 * HOUR,
      (t) => ({ r: 'tide', t, label: 'High tide' }),
      (t) => ({ r: 'tide', t, label: 'Low tide' })));
  }
  const local = state.data.local;
  if (local) {
    if (active('temp')) {
      ev.push(...extrema(local.times, local.temp, 8 * HOUR,
        (t) => ({ r: 'temp', t, label: 'Warmest' }),
        (t) => ({ r: 'temp', t, label: 'Coolest' })));
    }
    if (active('wind')) {
      ev.push(...extrema(local.times, local.wind, 8 * HOUR,
        (t, y) => (y >= 6 ? { r: 'wind', t, label: 'Wind peak' } : null)));
    }
  }
  if (active('kp') && state.data.kp) {
    let inStorm = false;
    for (const k of state.data.kp) {
      if (k.kp >= 5 && !inStorm) ev.push({ r: 'kp', t: k.t + 1.5 * HOUR, label: 'Magnetic storm' });
      inStorm = k.kp >= 5;
    }
  }
  if (active('quakes') && state.data.quakes) {
    for (const q of state.data.quakes) if (q.mag >= 6) ev.push({ r: 'quakes', t: q.t, label: `M${q.mag.toFixed(1)} quake` });
  }
  return ev.filter((e) => e.t >= t0 && e.t <= t1).sort((a, b) => a.t - b.t);
}

// Moments where two or more different rhythms peak within WINDOW of each other.
export function findMoments(events) {
  const moments = [];
  let i = 0;
  while (i < events.length) {
    const group = [events[i]];
    const seen = new Set([events[i].r]);
    let j = i + 1;
    for (; j < events.length && events[j].t - events[i].t <= WINDOW; j++) {
      if (!seen.has(events[j].r)) { group.push(events[j]); seen.add(events[j].r); }
    }
    if (group.length >= 2) {
      moments.push({ t: group.reduce((s, e) => s + e.t, 0) / group.length, events: group });
      i = j;
    } else i++;
  }
  return moments;
}

// How strongly the rhythms are lined up at time t.
//   p[r]  0–1: how close rhythm r is to one of its own peaks
//   R     0–1: resonance — only rises when at least two rhythms peak together
export function resonanceAt(events, t) {
  const p = {};
  const near = {};
  for (const e of events) {
    const d = (t - e.t) / SIGMA;
    if (Math.abs(d) > 3) continue;
    const v = Math.exp(-d * d);
    if (v > (p[e.r] ?? 0)) { p[e.r] = v; near[e.r] = e; }
  }
  const vals = Object.values(p).sort((a, b) => b - a);
  // Two rhythms together reach about 0.6; three or more reach full resonance.
  const R = Math.min(1, 0.6 * (vals[1] ?? 0) + 0.4 * (vals[2] ?? 0) + 0.2 * (vals[3] ?? 0));
  const aligned = Object.keys(p).filter((r) => p[r] > 0.4).sort((a, b) => p[b] - p[a]).map((r) => near[r]);
  return { p, R, aligned };
}

export function computeResonance(state) {
  const events = findEvents(state);
  return { events, moments: findMoments(events) };
}
