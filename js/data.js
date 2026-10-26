// Fetchers for each open data source. All are free, keyless and allow browser (CORS) access.
//   Open-Meteo forecast API  – wind field + local weather   https://open-meteo.com
//   Open-Meteo marine API    – sea level incl. tides         https://open-meteo.com/en/docs/marine-weather-api
//   USGS earthquake feeds    – quakes M2.5+, past 7 days     https://earthquake.usgs.gov/earthquakes/feed/
//   NOAA SWPC                – planetary Kp index            https://services.swpc.noaa.gov
// Each fetch is cached briefly in localStorage so reloads don't hammer the free APIs.

const PAST_DAYS = 2;
const FORECAST_DAYS = 3;

async function cached(key, maxAgeMin, fn) {
  try {
    const hit = JSON.parse(localStorage.getItem(key) || 'null');
    if (hit && Date.now() - hit.at < maxAgeMin * 60000) return hit.value;
  } catch { /* storage unavailable */ }
  const value = await fn();
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), value })); } catch { /* full or blocked */ }
  return value;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${new URL(url).host}`);
  return res.json();
}

// ---------- Global wind field ----------
// A coarse grid (15° lon × 10° lat) fetched in a few batched multi-location requests.
export const WIND_GRID = (() => {
  const lons = [];
  const lats = [];
  for (let lon = -180; lon < 180; lon += 15) lons.push(lon);
  for (let lat = 80; lat >= -80; lat -= 10) lats.push(lat);
  return { lons, lats, dLon: 15, dLat: 10 };
})();

export async function fetchWindField() {
  return cached('er-wind-v1', 45, async () => {
    const pts = [];
    for (const lat of WIND_GRID.lats) for (const lon of WIND_GRID.lons) pts.push([lat, lon]);
    const chunks = [];
    for (let i = 0; i < pts.length; i += 100) chunks.push(pts.slice(i, i + 100));
    const results = await Promise.all(chunks.map((c) => getJSON(
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${c.map((p) => p[0]).join(',')}&longitude=${c.map((p) => p[1]).join(',')}` +
      '&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms' +
      `&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}&timeformat=unixtime&timezone=GMT`
    )));
    const all = results.flatMap((r) => (Array.isArray(r) ? r : [r]));
    const times = all[0].hourly.time;
    const nT = times.length;
    const n = pts.length;
    // Store u (east) and v (north) components, laid out [hour][point]
    const u = new Array(nT * n);
    const v = new Array(nT * n);
    all.forEach((loc, p) => {
      const sp = loc.hourly.wind_speed_10m;
      const dir = loc.hourly.wind_direction_10m;
      for (let h = 0; h < nT; h++) {
        const s = sp[h] ?? 0;
        const d = ((dir[h] ?? 0) * Math.PI) / 180; // direction the wind blows FROM
        u[h * n + p] = Math.round(-s * Math.sin(d) * 100) / 100;
        v[h * n + p] = Math.round(-s * Math.cos(d) * 100) / 100;
      }
    });
    return { times: times.map((t) => t * 1000), u, v, nPts: n };
  });
}

// ---------- Local weather at the chosen place ----------
export async function fetchLocal(lat, lon) {
  const key = `er-local-${lat.toFixed(2)},${lon.toFixed(2)}`;
  return cached(key, 30, async () => {
    const r = await getJSON(
      'https://api.open-meteo.com/v1/forecast' +
      `?latitude=${lat}&longitude=${lon}` +
      '&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms' +
      `&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}&timeformat=unixtime&timezone=auto`
    );
    return {
      times: r.hourly.time.map((t) => t * 1000),
      temp: r.hourly.temperature_2m,
      wind: r.hourly.wind_speed_10m,
      windDir: r.hourly.wind_direction_10m,
      gust: r.hourly.wind_gusts_10m,
      utcOffset: r.utc_offset_seconds ?? 0,
      tz: r.timezone_abbreviation || r.timezone || '',
    };
  });
}

// ---------- Sea level (tides) ----------
// sea_level_height_msl is modelled sea level including tides. cell_selection=sea snaps
// to the nearest ocean grid cell so coastal towns still get a value.
export async function fetchLocalTide(lat, lon) {
  const key = `er-tide-${lat.toFixed(2)},${lon.toFixed(2)}`;
  return cached(key, 60, async () => {
    const r = await getJSON(
      'https://marine-api.open-meteo.com/v1/marine' +
      `?latitude=${lat}&longitude=${lon}&hourly=sea_level_height_msl,wave_height&cell_selection=sea` +
      `&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}&timeformat=unixtime&timezone=GMT`
    );
    const sea = r.hourly.sea_level_height_msl;
    if (!sea || sea.every((x) => x == null)) return null;
    return { times: r.hourly.time.map((t) => t * 1000), sea, wave: r.hourly.wave_height };
  });
}

// A ring of coastal stations around the world, so you can watch the tide wave travel.
export const TIDE_STATIONS = [
  ['Bay of Fundy', 45.1, -65.5], ['New York', 40.4, -73.8], ['Reykjavík', 64.1, -22.2],
  ['Saint-Malo', 48.8, -2.2], ['Thames Estuary', 51.5, 1.3], ['Lisbon', 38.6, -9.5],
  ['Cape Town', -34.0, 18.3], ['Mombasa', -4.1, 39.8], ['Mumbai', 18.9, 72.6],
  ['Bay of Bengal', 21.3, 88.2], ['Singapore', 1.2, 103.9], ['Hong Kong', 22.2, 114.2],
  ['Shanghai', 30.9, 122.4], ['Incheon', 37.3, 126.3], ['Tokyo Bay', 35.2, 139.8],
  ['Darwin', -12.4, 130.7], ['King Sound (WA)', -16.8, 123.2], ['Sydney', -33.9, 151.4],
  ['Auckland', -36.8, 174.9], ['Honolulu', 21.2, -157.9], ['Cook Inlet', 60.3, -151.9],
  ['Salish Sea', 49.3, -123.5], ['San Francisco', 37.7, -122.7], ['Gulf of California', 31.0, -114.4],
  ['Panamá', 8.8, -79.4], ['Rio de Janeiro', -23.0, -43.2], ['Patagonia', -51.6, -68.8],
];

export async function fetchTideStations() {
  return cached('er-tides-v1', 90, async () => {
    const r = await getJSON(
      'https://marine-api.open-meteo.com/v1/marine' +
      `?latitude=${TIDE_STATIONS.map((s) => s[1]).join(',')}` +
      `&longitude=${TIDE_STATIONS.map((s) => s[2]).join(',')}` +
      '&hourly=sea_level_height_msl&cell_selection=sea' +
      `&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}&timeformat=unixtime&timezone=GMT`
    );
    const arr = Array.isArray(r) ? r : [r];
    return arr.map((loc, i) => {
      const sea = loc.hourly?.sea_level_height_msl || [];
      const valid = sea.filter((x) => x != null);
      if (!valid.length) return null;
      return {
        name: TIDE_STATIONS[i][0], lat: TIDE_STATIONS[i][1], lon: TIDE_STATIONS[i][2],
        times: loc.hourly.time.map((t) => t * 1000), sea,
        min: Math.min(...valid), max: Math.max(...valid),
      };
    }).filter(Boolean);
  });
}

// ---------- Earthquakes ----------
export async function fetchQuakes() {
  return cached('er-quakes-v1', 5, async () => {
    const r = await getJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson');
    return r.features.map((f) => ({
      id: f.id,
      t: f.properties.time,
      mag: f.properties.mag ?? 2.5,
      place: f.properties.place || '',
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      depth: f.geometry.coordinates[2],
    })).sort((a, b) => a.t - b.t);
  });
}

// ---------- Geomagnetic activity (Kp) ----------
// SWPC switched these files from "header row + string rows" to "array of objects" in 2026.
// This parser accepts either shape.
function parseKp(json) {
  if (!Array.isArray(json) || !json.length) return [];
  let rows;
  if (Array.isArray(json[0])) {
    const head = json[0].map((h) => String(h).toLowerCase());
    rows = json.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  } else {
    rows = json.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])));
  }
  return rows.map((r) => {
    const tKey = Object.keys(r).find((k) => k.startsWith('time'));
    const kKey = Object.keys(r).find((k) => k === 'kp' || k === 'kp_index' || k.startsWith('kp'));
    const t = Date.parse(String(r[tKey]).replace(' ', 'T') + (/[zZ+]/.test(String(r[tKey]).slice(10)) ? '' : 'Z'));
    const kp = parseFloat(r[kKey]);
    const obs = r.observed ? String(r.observed).toLowerCase() : 'observed';
    return { t, kp, predicted: obs === 'predicted' };
  }).filter((r) => Number.isFinite(r.t) && Number.isFinite(r.kp));
}

export async function fetchKp() {
  return cached('er-kp-v2', 30, async () => {
    const [obs, fc] = await Promise.allSettled([
      getJSON('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'),
      getJSON('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json'),
    ]);
    const a = obs.status === 'fulfilled' ? parseKp(obs.value) : [];
    const b = fc.status === 'fulfilled' ? parseKp(fc.value) : [];
    if (!a.length && !b.length) throw new Error('Kp feed unavailable');
    const seen = new Set(a.map((r) => r.t));
    return [...a, ...b.filter((r) => !seen.has(r.t))].sort((x, y) => x.t - y.t);
  });
}

// ---------- helpers ----------
// Linear interpolation into an hourly series at time ms. Returns null if out of range.
export function sampleSeries(times, values, ms) {
  if (!times || !times.length) return null;
  if (ms <= times[0]) return values[0];
  const last = times.length - 1;
  if (ms >= times[last]) return values[last];
  const step = times[1] - times[0];
  const f = (ms - times[0]) / step;
  const i = Math.floor(f);
  const a = values[i];
  const b = values[i + 1];
  if (a == null || b == null) return a ?? b ?? null;
  return a + (b - a) * (f - i);
}

// Step lookup for 3-hourly Kp.
export function kpAt(kp, ms) {
  if (!kp || !kp.length) return null;
  let v = kp[0].kp;
  for (const r of kp) { if (r.t <= ms) v = r.kp; else break; }
  return v;
}
