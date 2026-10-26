// Sun and moon positions, computed from the date alone (no network needed).
// Low-precision formulas adapted from Jean Meeus / the SunCalc approach.
// Accuracy is about a degree, which is plenty for a world-scale picture.

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

const toDays = (ms) => ms / DAY_MS - 0.5 + J1970 - J2000;

function rightAscension(l, b) {
  return Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l));
}
function declination(l, b) {
  return Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l));
}
// Greenwich sidereal angle (radians)
const sidereal0 = (d) => RAD * (280.16 + 360.9856235 * d);

function sunCoords(d) {
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

function moonCoords(d) {
  const L = RAD * (218.316 + 13.176396 * d);
  const M = RAD * (134.963 + 13.064993 * d);
  const F = RAD * (93.272 + 13.22935 * d);
  const l = L + RAD * 6.289 * Math.sin(M);
  const b = RAD * 5.128 * Math.sin(F);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

const wrapLon = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;

// The point on Earth where the body is directly overhead.
function subPoint(c, d) {
  return { lat: c.dec / RAD, lon: wrapLon((c.ra - sidereal0(d)) / RAD) };
}

export function subSolar(ms) {
  const d = toDays(ms);
  return subPoint(sunCoords(d), d);
}

export function subLunar(ms) {
  const d = toDays(ms);
  return subPoint(moonCoords(d), d);
}

// Altitude (degrees above horizon) of a body whose sub-point is `sp`, seen from lat/lon.
export function altitudeFrom(sp, lat, lon) {
  const φ = lat * RAD;
  const δ = sp.lat * RAD;
  const H = (lon - sp.lon) * RAD;
  return Math.asin(Math.sin(φ) * Math.sin(δ) + Math.cos(φ) * Math.cos(δ) * Math.cos(H)) / RAD;
}

export const sunAltitude = (ms, lat, lon) => altitudeFrom(subSolar(ms), lat, lon);
export const moonAltitude = (ms, lat, lon) => altitudeFrom(subLunar(ms), lat, lon);

// fraction: 0 = new, 1 = full. phase: 0 new → 0.25 first quarter → 0.5 full → 0.75 last quarter.
export function moonIllumination(ms) {
  const d = toDays(ms);
  const s = sunCoords(d);
  const m = moonCoords(d);
  const sdist = 149598000;
  const phi = Math.acos(
    Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra)
  );
  const inc = Math.atan2(sdist * Math.sin(phi), m.dist - sdist * Math.cos(phi));
  const angle = Math.atan2(
    Math.cos(s.dec) * Math.sin(s.ra - m.ra),
    Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra)
  );
  return {
    fraction: (1 + Math.cos(inc)) / 2,
    phase: 0.5 + (0.5 * inc * (angle < 0 ? -1 : 1)) / Math.PI,
  };
}

export function moonPhaseName(phase) {
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
    'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  return names[Math.round(phase * 8) % 8];
}

// Geomagnetic latitude using a tilted-dipole model (IGRF-2025 north pole ≈ 80.8°N, 72.6°W).
const GM_LAT = 80.8 * RAD;
const GM_LON = -72.6 * RAD;
export function geomagneticLat(lat, lon) {
  const φ = lat * RAD;
  const λ = lon * RAD;
  return Math.asin(
    Math.sin(φ) * Math.sin(GM_LAT) + Math.cos(φ) * Math.cos(GM_LAT) * Math.cos(λ - GM_LON)
  ) / RAD;
}

// Rough equatorward edge of the auroral oval for a given Kp (geomagnetic degrees).
export const auroraEdge = (kp) => 66.5 - 2.2 * kp;
