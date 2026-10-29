import { EarthMap } from './map.js';
import { Timeline } from './timeline.js';
import { Sonifier } from './audio.js';
import { sunAltitude, moonAltitude, moonIllumination, moonPhaseName } from './astro.js';
import {
  fetchWindField, fetchLocal, fetchLocalTide, fetchTideStations, fetchQuakes, fetchKp,
  sampleSeries, kpAt,
} from './data.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;

// ---------- Layer catalogue ----------
// `hear` is the plain-language description of each sound mapping shown in the UI.
const LAYERS = [
  { id: 'daynight', name: 'Day & night', color: 'var(--sun)', sound: true,
    hear: 'An open, bright chord that rises with the sun; a low, dark drone after dusk.' },
  { id: 'moon', name: 'Moon', color: 'var(--moon)', sound: true,
    hear: 'A high glassy shimmer — louder the fuller the moon and the higher it rides.' },
  { id: 'tides', name: 'Tides', color: 'var(--tide)', sound: true,
    hear: 'A deep ocean wash that swells at high water and thins out at low water.' },
  { id: 'wind', name: 'Wind', color: 'var(--wind)', sound: true,
    hear: 'Moving air: stronger wind is louder and higher, panned the way it blows.' },
  { id: 'temp', name: 'Air temperature', color: 'var(--temp)', sound: false,
    hear: 'Timeline only — watch it lag a few hours behind the sun.' },
  { id: 'quakes', name: 'Earthquakes (M2.5+)', color: 'var(--quake)', sound: true,
    hear: 'A struck bell for each quake as the playhead passes it. Bigger = deeper and longer.' },
  { id: 'aurora', name: 'Aurora / Kp', color: 'var(--aurora)', sound: true,
    hear: 'Wavering, chorused tones that only appear during geomagnetic storms (Kp 3+).' },
];

const SOURCES = {
  wind: ['Global wind field', 'Open-Meteo forecast API', 'https://open-meteo.com/'],
  local: ['Local wind & temperature', 'Open-Meteo forecast API', 'https://open-meteo.com/'],
  tide: ['Local sea level (tides)', 'Open-Meteo marine API', 'https://open-meteo.com/en/docs/marine-weather-api'],
  tides: ['World tide stations', 'Open-Meteo marine API', 'https://open-meteo.com/en/docs/marine-weather-api'],
  quakes: ['Earthquakes, past 7 days', 'USGS Earthquake Hazards Program', 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php'],
  kp: ['Planetary Kp index', 'NOAA Space Weather Prediction Center', 'https://www.swpc.noaa.gov/products/planetary-k-index'],
};

// ---------- State ----------
const loadPrefs = () => { try { return JSON.parse(localStorage.getItem('er-prefs') || '{}'); } catch { return {}; } };
const prefs = loadPrefs();
const now = Date.now();
const state = {
  t: now,
  mode: 'live', // 'live' | 'play' | 'paused'
  speed: 3600,
  t0: now - 2 * DAY,
  t1: now + 3 * DAY,
  loc: prefs.loc || { lat: 49.375, lon: -123.275, name: 'Horseshoe Bay, BC' },
  utcOffset: 0,
  layers: Object.fromEntries(LAYERS.map((l) => [l.id, {
    show: prefs.layers?.[l.id]?.show ?? true,
    sound: l.sound ? (prefs.layers?.[l.id]?.sound ?? true) : false,
  }])),
  data: { wind: null, local: null, localTide: null, tides: null, quakes: null, kp: null },
  status: Object.fromEntries(Object.keys(SOURCES).map((k) => [k, 'loading'])),
  kpNow: null,
};
state.utcOffset = Math.round(state.loc.lon / 15) * 3600;
const savePrefs = () => { try { localStorage.setItem('er-prefs', JSON.stringify({ loc: state.loc, layers: state.layers })); } catch { /* ignore */ } };

const $ = (id) => document.getElementById(id);
const audio = new Sonifier();
let map;
let timeline;

// ---------- UI: layers ----------
function buildLayerList() {
  const ul = $('layer-list');
  ul.innerHTML = '';
  for (const l of LAYERS) {
    const li = document.createElement('li');
    li.className = 'layer';
    li.innerHTML = `
      <span class="swatch" style="background:${l.color}"></span>
      <div><div class="name">${l.name}</div><div class="value" id="val-${l.id}">—</div></div>
      <button class="toggle" data-kind="show" aria-label="Show ${l.name}">👁</button>
      <button class="toggle" data-kind="sound" aria-label="Hear ${l.name}" ${l.sound ? '' : 'disabled'}>🔊</button>
      <div class="hear">${l.hear}</div>`;
    li.querySelectorAll('.toggle').forEach((b) => {
      const kind = b.dataset.kind;
      b.setAttribute('aria-pressed', String(state.layers[l.id][kind]));
      b.addEventListener('click', () => {
        state.layers[l.id][kind] = !state.layers[l.id][kind];
        b.setAttribute('aria-pressed', String(state.layers[l.id][kind]));
        if (kind === 'show') timeline.layout(state);
        savePrefs();
      });
    });
    ul.appendChild(li);
  }
}

function renderSources() {
  $('sources').innerHTML = Object.entries(SOURCES).map(([k, [what, who, url]]) => {
    const s = state.status[k];
    const label = s === 'ok' ? 'live' : s === 'loading' ? 'loading…' : `unavailable (${s})`;
    return `<li><span class="dot ${s === 'ok' ? 'ok' : s === 'loading' ? 'loading' : 'err'}"></span>
      ${what} — <a href="${url}" target="_blank" rel="noopener">${who}</a> <span class="muted">· ${label}</span></li>`;
  }).join('');
}

// ---------- Data loading ----------
async function load(key, fn, after) {
  state.status[key] = 'loading';
  renderSources();
  try {
    state.data[key === 'tide' ? 'localTide' : key] = await fn();
    state.status[key] = 'ok';
    after?.();
  } catch (e) {
    console.warn(key, e);
    state.status[key] = e.message?.slice(0, 60) || 'error';
  }
  renderSources();
  if (timeline) timeline.dirty = true;
}

function loadLocal() {
  const { lat, lon } = state.loc;
  state.data.local = null;
  state.data.localTide = null;
  load('local', () => fetchLocal(lat, lon), () => { state.utcOffset = state.data.local.utcOffset; });
  load('tide', () => fetchLocalTide(lat, lon), () => {
    if (!state.data.localTide) state.status.tide = 'no sea nearby';
  });
}

let knownQuakes = null;
function loadQuakes() {
  load('quakes', fetchQuakes, () => {
    const ids = new Set(state.data.quakes.map((q) => q.id));
    // In live mode, ring a bell for quakes that arrived since the last poll.
    if (knownQuakes && state.mode === 'live') {
      state.data.quakes.filter((q) => !knownQuakes.has(q.id)).slice(-5).forEach(triggerQuake);
    }
    knownQuakes = ids;
  });
}

function loadAll() {
  load('wind', fetchWindField);
  load('tides', fetchTideStations);
  load('kp', fetchKp);
  loadQuakes();
  loadLocal();
}

// ---------- Location ----------
function setLocation(lat, lon, name) {
  state.loc = { lat: +lat.toFixed(3), lon: +lon.toFixed(3), name: name || `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}` };
  state.utcOffset = Math.round(lon / 15) * 3600;
  map.setCenter(state.loc.lon);
  updatePlace();
  savePrefs();
  loadLocal();
  timeline.dirty = true;
}

function updatePlace() {
  const { lat, lon, name } = state.loc;
  $('place-name').textContent = name;
  $('place-coords').textContent = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
}

function setupSearch() {
  const input = $('search-input');
  const results = $('search-results');
  let timer;
  const pick = (r) => {
    results.hidden = true;
    input.value = '';
    setLocation(r.latitude, r.longitude, [r.name, r.admin1, r.country_code].filter(Boolean).join(', '));
  };
  const search = async () => {
    const q = input.value.trim();
    if (q.length < 2) { results.hidden = true; return; }
    try {
      const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6`);
      const j = await res.json();
      const list = j.results || [];
      results.innerHTML = '';
      list.forEach((r) => {
        const li = document.createElement('li');
        li.tabIndex = 0;
        li.textContent = [r.name, r.admin1, r.country].filter(Boolean).join(', ');
        li.addEventListener('click', () => pick(r));
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(r); });
        results.appendChild(li);
      });
      results.hidden = !list.length;
    } catch { results.hidden = true; }
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 300); });
  $('search').addEventListener('submit', (e) => { e.preventDefault(); results.querySelector('li')?.click(); });
  document.addEventListener('click', (e) => { if (!$('search').contains(e.target)) results.hidden = true; });

  $('locate').addEventListener('click', () => {
    navigator.geolocation?.getCurrentPosition(
      (p) => setLocation(p.coords.latitude, p.coords.longitude, 'My location'),
      () => alert('Location unavailable — try searching for a place instead.'),
      { timeout: 10000 }
    );
  });
}

// ---------- Transport ----------
function setMode(mode) {
  const changed = mode !== state.mode;
  state.mode = mode;
  if (mode === 'live') state.t = Date.now();
  if (changed) {
    // Only one clock drives the sound: hand over cleanly to the new one.
    lastT = state.t;
    audio.transition();
  }
  $('live').classList.toggle('on', mode === 'live');
  $('play').classList.toggle('on', mode === 'play');
  $('play').textContent = mode === 'play' ? '❚❚ Pause' : '▶ Time-lapse';
}

function setupTransport() {
  $('live').addEventListener('click', () => setMode('live'));
  $('play').addEventListener('click', () => setMode(state.mode === 'play' ? 'paused' : 'play'));
  $('speed').addEventListener('change', (e) => { state.speed = +e.target.value; });
  $('listen').addEventListener('click', async () => {
    const btn = $('listen');
    if (audio.running) { audio.stop(); btn.textContent = '▶ Listen'; btn.setAttribute('aria-pressed', 'false'); }
    else { await audio.start(); btn.textContent = '■ Stop sound'; btn.setAttribute('aria-pressed', 'true'); }
  });
  $('volume').addEventListener('input', (e) => audio.setVolume(+e.target.value));
}

function scrub(t, jump) {
  if (state.mode !== 'paused') setMode('paused');
  else if (jump) audio.transition(); // tapping a new spot is a jump, not a glide
  lastT = jump ? t : lastT;
  state.t = t;
}

// ---------- Quakes ----------
function triggerQuake(q) {
  if (state.layers.quakes.show) map.addRipple(q.lat, q.lon, q.mag);
  if (state.layers.quakes.sound) audio.quake(q.mag, q.lon);
}

let lastT = state.t;
function checkQuakeCrossings() {
  const qs = state.data.quakes;
  const from = lastT;
  const to = state.t;
  lastT = to;
  if (!qs || to <= from || to - from > 6 * HOUR) return;
  const crossed = qs.filter((q) => q.t > from && q.t <= to);
  // Keep it musical: at most 4 bells per frame, the biggest ones.
  crossed.sort((a, b) => b.mag - a.mag).slice(0, 4).forEach(triggerQuake);
}

// ---------- Readouts ----------
const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
function sample() {
  const { lat, lon } = state.loc;
  const t = state.t;
  const ill = moonIllumination(t);
  const out = {
    sunAlt: sunAltitude(t, lat, lon),
    moonAlt: moonAltitude(t, lat, lon),
    moonFraction: ill.fraction,
    moonPhase: ill.phase,
    kp: kpAt(state.data.kp, t),
    sound: Object.fromEntries(LAYERS.map((l) => [l.id, state.layers[l.id].sound])),
    speed: state.mode === 'play' ? state.speed : 1,
  };
  const d = state.data.local;
  if (d) {
    out.windSpeed = sampleSeries(d.times, d.wind, t);
    out.windDir = sampleSeries(d.times, d.windDir, t);
    out.gust = sampleSeries(d.times, d.gust, t);
    out.temp = sampleSeries(d.times, d.temp, t);
  }
  const tide = state.data.localTide;
  if (tide) {
    const h = sampleSeries(tide.times, tide.sea, t);
    const valid = tide.sea.filter((x) => x != null);
    const lo = Math.min(...valid);
    const hi = Math.max(...valid);
    out.tide = h;
    out.tideNorm = h == null ? null : (h - lo) / Math.max(0.01, hi - lo);
    out.tideRising = sampleSeries(tide.times, tide.sea, t + 20 * 60000) > h;
  }
  return out;
}

function updateReadouts(s) {
  const sunWord = s.sunAlt > 0 ? 'Day' : s.sunAlt > -6 ? 'Civil twilight' : s.sunAlt > -12 ? 'Nautical twilight' : s.sunAlt > -18 ? 'Astronomical twilight' : 'Night';
  const set = (id, txt) => { const el = $(`val-${id}`); if (el.textContent !== txt) el.textContent = txt; };
  set('daynight', `${sunWord} · sun ${s.sunAlt.toFixed(0)}°`);
  set('moon', `${moonPhaseName(s.moonPhase)} · ${Math.round(s.moonFraction * 100)}% · ${s.moonAlt > 0 ? 'up' : 'set'} ${s.moonAlt.toFixed(0)}°`);
  set('tides', s.tide != null ? `${s.tide.toFixed(2)} m · ${s.tideRising ? 'rising ↑' : 'falling ↓'}` : state.status.tide === 'loading' ? 'loading…' : 'no local tide');
  set('wind', s.windSpeed != null ? `${(s.windSpeed * 3.6).toFixed(0)} km/h from ${compass(s.windDir)} · gusts ${(s.gust * 3.6).toFixed(0)}` : '—');
  set('temp', s.temp != null ? `${s.temp.toFixed(1)} °C` : '—');
  const qs = state.data.quakes;
  if (qs) {
    const recent = qs.filter((q) => q.t <= state.t && state.t - q.t < DAY);
    const big = recent.reduce((m, q) => (q.mag > (m?.mag ?? 0) ? q : m), null);
    set('quakes', `${recent.length} in past 24 h${big ? ` · largest M${big.mag.toFixed(1)}` : ''}`);
  } else set('quakes', state.status.quakes === 'loading' ? 'loading…' : '—');
  set('aurora', s.kp != null ? `Kp ${s.kp.toFixed(1)} · ${s.kp >= 5 ? 'storm' : s.kp >= 4 ? 'active' : 'quiet'}` : '—');

  const fmt = (ms, opts) => new Date(ms).toLocaleString(undefined, { timeZone: 'UTC', ...opts });
  const local = fmt(state.t + state.utcOffset * 1000, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const utc = fmt(state.t, { hour: '2-digit', minute: '2-digit', hour12: false });
  const tl = $('time-local');
  if (tl.textContent !== local) tl.textContent = local;
  const tu = $('time-utc');
  const u = `${utc} UTC`;
  if (tu.textContent !== u) tu.textContent = u;
}

// ---------- Tooltip (hover a tide station or quake) ----------
function setupTooltip(canvas) {
  const tip = $('tooltip');
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    let best = null;
    let bestD = 14;
    const consider = (lat, lon, html) => {
      const [px, py] = map.project(lat, lon);
      const d = Math.hypot(px - x, py - y);
      if (d < bestD) { bestD = d; best = html; }
    };
    if (state.layers.tides.show) for (const s of state.data.tides || []) {
      const h = sampleSeries(s.times, s.sea, state.t);
      if (h != null) consider(s.lat, s.lon, `<b>${s.name}</b><br>Sea level ${h.toFixed(2)} m · range ${(s.max - s.min).toFixed(1)} m`);
    }
    if (state.layers.quakes.show) for (const q of state.data.quakes || []) {
      if (q.t <= state.t && state.t - q.t < DAY) consider(q.lat, q.lon, `<b>M${q.mag.toFixed(1)}</b> ${q.place}<br>${new Date(q.t).toUTCString().slice(5, 22)} UTC · ${q.depth.toFixed(0)} km deep`);
    }
    if (best) { tip.innerHTML = best; tip.style.left = `${x}px`; tip.style.top = `${y}px`; tip.hidden = false; } else tip.hidden = true;
  });
  canvas.addEventListener('pointerleave', () => { tip.hidden = true; });
}

// ---------- Main loop ----------
let lastFrame = performance.now();
let lastAudio = 0;
let lastReadout = 0;
function frame(nowPerf) {
  const dt = Math.min(100, nowPerf - lastFrame);
  lastFrame = nowPerf;
  if (state.mode === 'live') state.t = Date.now();
  else if (state.mode === 'play') {
    state.t += (dt / 1000) * state.speed * 1000;
    if (state.t > state.t1) { state.t = state.t0; lastT = state.t; audio.transition(); }
  }
  state.kpNow = kpAt(state.data.kp, state.t);
  checkQuakeCrossings();
  map.setWindTime(state.data.wind, state.t);
  map.draw(state, dt);
  timeline.draw(state);
  if (nowPerf - lastReadout > 150) {
    const s = sample();
    updateReadouts(s);
    lastReadout = nowPerf;
    if (nowPerf - lastAudio > 150) { audio.update(s); lastAudio = nowPerf; }
  }
  requestAnimationFrame(frame);
}

// ---------- Boot ----------
async function boot() {
  const topo = await (await fetch('data/land-110m.json')).json();
  const land = window.topojson.feature(topo, topo.objects.land);
  map = new EarthMap($('map'), land);
  map.setCenter(state.loc.lon);
  timeline = new Timeline($('timeline'), scrub);
  timeline.t0 = state.t0;
  timeline.t1 = state.t1;
  buildLayerList();
  timeline.layout(state);
  updatePlace();
  renderSources();
  setupSearch();
  setupTransport();
  setupTooltip($('map'));

  $('map').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const [lat, lon] = map.unproject(e.clientX - r.left, e.clientY - r.top);
    setLocation(lat, lon);
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { map.resize(); timeline.layout(state); }, 150);
  });

  loadAll();
  // Keep live data fresh
  setInterval(loadQuakes, 5 * 60000);
  setInterval(() => { load('kp', fetchKp); load('wind', fetchWindField); }, 30 * 60000);
  // Slide the 5-day window forward once an hour
  setInterval(() => {
    const n = Date.now();
    state.t0 = timeline.t0 = n - 2 * DAY;
    state.t1 = timeline.t1 = n + 3 * DAY;
    timeline.dirty = true;
  }, HOUR);

  requestAnimationFrame(frame);
}

boot();
