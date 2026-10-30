// Buildings from real footprints (traced from OpenStreetMap via the course
// builder). Small footprints become gabled chalets; big ones keep their real
// outline with a snow-covered flat roof. You crash if you ride into one.
import * as THREE from '../vendor/three.module.min.js';
import { rng } from './course.js';

// Storey count guessed from footprint size (square metres).
function heightFor(area, r) {
  if (area < 120) return 6 + r() * 1.5;      // small house
  if (area < 300) return 7.5 + r() * 2;      // chalet / duplex
  if (area < 1200) return 9 + r() * 3;       // townhouse block
  return 12 + r() * 3;                       // lodge / hotel (4-5 storeys)
}

const WALLS = [
  [0.55, 0.38, 0.25], [0.62, 0.45, 0.30], [0.48, 0.33, 0.24], // wood
  [0.78, 0.74, 0.66], [0.70, 0.66, 0.58],                     // stucco
  [0.36, 0.42, 0.48], [0.55, 0.22, 0.18],                     // painted
];
const SNOW = [0.95, 0.97, 1.0];
const TRIM = [0.25, 0.2, 0.17];

// Windows: a tiling texture drawn on a canvas, about one window per 4.5 m x 3.2 m.
function windowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#2b3a4f'; g.fillRect(18, 16, 28, 30);
  g.fillStyle = '#5b7391'; g.fillRect(20, 18, 24, 12);
  g.fillStyle = '#fff'; g.fillRect(31, 16, 2, 30);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Smallest rectangle around a footprint, aligned to one of its edges.
function orientedBox(pts) {
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.5) continue;
    const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of pts) {
      const u = p[0] * ux + p[1] * uz, v = -p[0] * uz + p[1] * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) best = { area, ux, uz, u0, u1, v0, v1 };
  }
  const { ux, uz, u0, u1, v0, v1 } = best;
  const at = (u, v) => [u * ux - v * uz, u * uz + v * ux];
  // Long side first, so the roof ridge runs along it.
  const corners = [at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)];
  return (u1 - u0) >= (v1 - v0) ? corners : [corners[1], corners[2], corners[3], corners[0]];
}

function pointInPolygon(x, z, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function buildBuildings(terrain, scene) {
  const list = terrain.meta.buildings || [];
  const rand = rng(11);
  const pos = [], col = [], uv = [];
  const tri = (a, b, c, color, uva = [0, 0], uvb = [0, 0], uvc = [0, 0]) => {
    pos.push(...a, ...b, ...c);
    col.push(...color, ...color, ...color);
    uv.push(...uva, ...uvb, ...uvc);
  };
  // A wall from footprint edge a->b, between heights y0 and y1, with windows.
  const wall = (a, b, y0, y1, color, windows) => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u = windows ? Math.max(1, Math.round(len / 4.5)) : 0, v0 = 0, v1 = windows ? (y1 - y0) / 3.2 : 0;
    const A = [a[0], y0, a[1]], B = [b[0], y0, b[1]], C = [b[0], y1, b[1]], D = [a[0], y1, a[1]];
    tri(A, B, C, color, [0, v0], [u, v0], [u, v1]);
    tri(A, C, D, color, [0, v0], [u, v1], [0, v1]);
  };
  const solid = [0.93, 0.93, 0.93]; // uv (0,0) is white in the window texture

  const hits = [];
  for (const b of list) {
    let pts = b.points;
    // Make the outline counter-clockwise (seen from above) so walls face out.
    let s = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; s += (q[0] - p[0]) * (q[1] + p[1]); }
    if (s < 0) pts = pts.slice().reverse();
    const ground = pts.map(p => terrain.terrainHeight(p[0], p[1]));
    const base = Math.min(...ground) - 1.5;
    const top = ground.reduce((a, c) => a + c, 0) / ground.length + heightFor(b.area, rand);
    const wallColor = WALLS[Math.floor(rand() * WALLS.length)];

    if (b.area < 300) {
      // Chalet: box walls and a pitched roof along the long side.
      const [c0, c1, c2, c3] = orientedBox(pts);
      const eave = top - 2.2, ridge = top + 1.2;
      const box = [c0, c1, c2, c3];
      for (let i = 0; i < 4; i++) wall(box[i], box[(i + 1) % 4], base, eave, wallColor, true);
      const m03 = [(c0[0] + c3[0]) / 2, (c0[1] + c3[1]) / 2], m12 = [(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2];
      // overhang
      const grow = (p, o, k) => [p[0] + (p[0] - o[0]) * k, p[1] + (p[1] - o[1]) * k];
      const ctr = [(c0[0] + c2[0]) / 2, (c0[1] + c2[1]) / 2];
      const [e0, e1, e2, e3] = box.map(p => grow(p, ctr, 0.12));
      const r03 = grow(m03, ctr, 0.12), r12 = grow(m12, ctr, 0.12);
      const Y = (p, y) => [p[0], y, p[1]];
      // gables
      tri(Y(c1, eave), Y(c2, eave), Y(m12, ridge), wallColor);
      tri(Y(c3, eave), Y(c0, eave), Y(m03, ridge), wallColor);
      // roof slopes (snowy) + dark trim underneath
      for (const [p, q, color, lift] of [[e0, e1, SNOW, 0.05], [e2, e3, SNOW, 0.05], [e0, e1, TRIM, -0.15], [e2, e3, TRIM, -0.15]]) {
        const ra = q === e1 ? r12 : r03, rb = q === e1 ? r03 : r12;
        const quad = [Y(p, eave - 0.4 + lift), Y(q, eave - 0.4 + lift), Y(ra, ridge + lift), Y(rb, ridge + lift)];
        if (lift > 0) { tri(quad[0], quad[1], quad[2], color); tri(quad[0], quad[2], quad[3], color); }
        else { tri(quad[0], quad[2], quad[1], color); tri(quad[0], quad[3], quad[2], color); }
      }
    } else {
      // Big building: real outline, flat snowy roof with a parapet.
      for (let i = 0; i < pts.length; i++) wall(pts[i], pts[(i + 1) % pts.length], base, top, wallColor, true);
      const shape = pts.map(p => new THREE.Vector2(p[0], p[1]));
      const tris = THREE.ShapeUtils.triangulateShape(shape, []);
      for (const [i, j, k] of tris) {
        const P = q => [pts[q][0], top + 0.05, pts[q][1]];
        // keep the roof facing up whatever order the triangulation returns
        const cross = (pts[j][0] - pts[i][0]) * (pts[k][1] - pts[i][1]) - (pts[j][1] - pts[i][1]) * (pts[k][0] - pts[i][0]);
        if (cross < 0) tri(P(i), P(j), P(k), SNOW); else tri(P(i), P(k), P(j), SNOW);
      }
    }
    let cx = 0, cz = 0;
    for (const p of pts) { cx += p[0]; cz += p[1]; }
    cx /= pts.length; cz /= pts.length;
    const r = Math.max(...pts.map(p => Math.hypot(p[0] - cx, p[1] - cz)));
    hits.push({ pts, cx, cz, r, top: top + 1.2 });
  }
  if (!pos.length) return { near: () => [] };

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, map: windowTexture(), side: THREE.DoubleSide }));
  scene.add(mesh);

  return {
    list: hits,
    // Buildings whose footprint contains this point (with a little padding).
    hit(x, z, y, pad = 0.6) {
      for (const h of hits) {
        if ((x - h.cx) ** 2 + (z - h.cz) ** 2 > (h.r + pad) ** 2 || y > h.top) continue;
        if (pointInPolygon(x, z, h.pts)) return h;
      }
      return null;
    },
    // Is a spot clear of buildings (used to keep trees out of houses)?
    clear(x, z, pad = 4) {
      for (const h of hits) {
        if ((x - h.cx) ** 2 + (z - h.cz) ** 2 < (h.r + pad) ** 2) return false;
      }
      return true;
    },
  };
}
