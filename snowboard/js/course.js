// Course design: where the stars and jumps go.
// On a course they follow the line down the mountain; in free ride they are
// spread over the real open snow (runs and bowls) seen in satellite images.
// Change the numbers in LAYOUT to reshape things without touching the physics.
import * as THREE from '../vendor/three.module.min.js';
import { buildBuildings } from './buildings.js';
import { TreeField } from './trees.js';
import { buildLifts } from './lifts.js';

export const LAYOUT = {
  starEvery: 85,        // metres between star patterns
  jumpEvery: 300,       // metres between jumps
  jumpSize: { length: 10, width: 8, height: 1.6 }, // a medium park jump
  clearing: 9,          // metres either side of a course line kept free of trees
  poleEvery: 22,        // metres between boundary poles (open alpine only)
  poleOffset: 20,       // metres from the line to the poles
  freeJumpEvery: 260,   // free ride: at least this far apart
  freeStarEvery: 170,   // free ride: grid for star lines (one line per square, if open)
  seed: 7,
};

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- The guide line ----------
export class Route {
  constructor(points) {
    this.p = points.map(([x, z]) => ({ x, z }));
    this.s = [0];
    for (let i = 1; i < this.p.length; i++) {
      this.s.push(this.s[i - 1] + Math.hypot(this.p[i].x - this.p[i - 1].x, this.p[i].z - this.p[i - 1].z));
    }
    this.length = this.s[this.s.length - 1];
  }

  // Position and direction at a distance along the line.
  at(s) {
    s = Math.min(Math.max(s, 0), this.length);
    let i = 0;
    let lo = 0, hi = this.s.length - 1;
    while (lo < hi - 1) { const m = (lo + hi) >> 1; if (this.s[m] <= s) lo = m; else hi = m; }
    i = lo;
    const a = this.p[i], b = this.p[Math.min(i + 1, this.p.length - 1)];
    const seg = (this.s[i + 1] ?? this.s[i]) - this.s[i] || 1;
    const f = (s - this.s[i]) / seg;
    // Smooth the direction over ~30 m so patterns follow the line gently.
    const a2 = this.p[Math.max(0, i - 3)], b2 = this.p[Math.min(this.p.length - 1, i + 4)];
    const dx = b2.x - a2.x, dz = b2.z - a2.z, d = Math.hypot(dx, dz) || 1;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, dx: dx / d, dz: dz / d };
  }

  // Closest point index, searching near the last known one.
  nearest(x, z, hint = 0, span = 60) {
    let best = hint, bd = Infinity;
    const lo = Math.max(0, hint - span), hi = Math.min(this.p.length - 1, hint + span);
    for (let i = lo; i <= hi; i++) {
      const d = (this.p[i].x - x) ** 2 + (this.p[i].z - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return { index: best, distance: Math.sqrt(bd), s: this.s[best] };
  }
}

// ---------- Jumps ----------
function makeKicker(terrain, x, z, dx, dz, size) {
  const { length: L, width: Wd, height: Hh } = size;
  const cx = x + dx * L / 2, cz = z + dz * L / 2;
  const k = {
    x: cx, z: cz, dx, dz, L, Wd, Hh,
    r2: (L * L + Wd * Wd) / 4 + 1,
    height(ox, oz) {
      const u = ox * dx + oz * dz + L / 2;
      const w = -ox * dz + oz * dx;
      if (u < 0 || u > L || Math.abs(w) > Wd / 2) return 0;
      const t = u / L;
      return Hh * t * t;
    },
  };
  // Lip position and launch direction, for placing stars in the air.
  k.lip = { x: x + dx * L, z: z + dz * L };
  return k;
}

function kickerMesh(terrain, k) {
  const pos = [], col = [];
  const snow = [0.97, 0.98, 1], side = [0.78, 0.84, 0.92], lip = [1, 0.45, 0.12];
  const NU = 16, NW = 6;
  const pt = (u, w, top) => {
    const ox = (u - k.L / 2) * k.dx - w * k.dz;
    const oz = (u - k.L / 2) * k.dz + w * k.dx;
    const x = k.x + ox, z = k.z + oz;
    const g = terrain.terrainHeight(x, z);
    const t = u / k.L;
    return [x, top ? g + k.Hh * t * t + 0.03 : g - 0.6, z];
  };
  const tri = (a, b, c, color) => { pos.push(...a, ...b, ...c); for (let i = 0; i < 3; i++) col.push(...color); };
  const quad = (a, b, c, d, color) => { tri(a, b, c, color); tri(b, d, c, color); };
  for (let i = 0; i < NU; i++) {
    const u0 = (i / NU) * k.L, u1 = ((i + 1) / NU) * k.L;
    const color = i >= NU - 1 ? lip : snow;
    for (let j = 0; j < NW; j++) {
      const w0 = -k.Wd / 2 + (j / NW) * k.Wd, w1 = -k.Wd / 2 + ((j + 1) / NW) * k.Wd;
      quad(pt(u0, w0, true), pt(u0, w1, true), pt(u1, w0, true), pt(u1, w1, true), color);
    }
    // side walls
    quad(pt(u0, -k.Wd / 2, false), pt(u0, -k.Wd / 2, true), pt(u1, -k.Wd / 2, false), pt(u1, -k.Wd / 2, true), side);
    quad(pt(u0, k.Wd / 2, true), pt(u0, k.Wd / 2, false), pt(u1, k.Wd / 2, true), pt(u1, k.Wd / 2, false), side);
  }
  for (let j = 0; j < NW; j++) {
    const w0 = -k.Wd / 2 + (j / NW) * k.Wd, w1 = -k.Wd / 2 + ((j + 1) / NW) * k.Wd;
    quad(pt(k.L, w0, true), pt(k.L, w1, true), pt(k.L, w0, false), pt(k.L, w1, false), side);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}

// ---------- Stars ----------
function starGeometry() {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? 0.27 : 0.62;
    const a = (i / 10) * Math.PI * 2 + Math.PI / 2;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.16, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 1 });
  g.center();
  return g;
}

function placeStars(terrain, route, kickers, rand) {
  const stars = [];
  const add = (x, z, lift = 1.1) => stars.push({ x, z, y: terrain.groundHeight(x, z) + lift });
  // Step sideways off the line, but never into the trees: a star that would land
  // in forest goes back onto the line so you can always see and reach it.
  const side = (p, off) => {
    const q = { x: p.x - p.dz * off, z: p.z + p.dx * off };
    return terrain.forestAt(q.x, q.z) > 0.25 ? { x: p.x, z: p.z } : q;
  };
  const nearKicker = s => kickers.some(k => Math.abs(k.s - s) < 45);
  const patterns = ['line', 'slalom', 'line', 'zig', 'arc'];
  for (let s = 60; s < route.length - 60; s += LAYOUT.starEvery) {
    if (nearKicker(s)) continue;
    const kind = patterns[Math.floor(rand() * patterns.length)];
    const off = (rand() - 0.5) * 16;
    if (kind === 'line') {
      for (let i = 0; i < 6; i++) { const q = side(route.at(s + i * 5), off); add(q.x, q.z); }
    } else if (kind === 'slalom') {
      for (let i = 0; i < 9; i++) { const q = side(route.at(s + i * 5), off * 0.3 + Math.sin(i / 8 * Math.PI * 2) * 9); add(q.x, q.z); }
    } else if (kind === 'zig') {
      for (let i = 0; i < 8; i++) { const q = side(route.at(s + i * 5), (i % 4 < 2 ? -1 : 1) * 6 + off * 0.3); add(q.x, q.z); }
    } else {
      // A little arc you have to hop to collect
      for (let i = 0; i < 6; i++) { const q = side(route.at(s + i * 4), off); add(q.x, q.z, 1.1 + Math.sin(i / 5 * Math.PI) * 2.6); }
    }
  }
  return stars.concat(kickerStars(terrain, kickers));
}

// Stars on the approach to each jump and in the air along a typical flight path.
function kickerStars(terrain, kickers) {
  const stars = [];
  const add = (x, z, lift = 1.1) => stars.push({ x, z, y: terrain.groundHeight(x, z) + lift });
  for (const k of kickers) {
    for (let i = 0; i < 3; i++) {
      const a = { x: k.x - k.dx * (k.L / 2 + 14 - i * 5), z: k.z - k.dz * (k.L / 2 + 14 - i * 5) };
      add(a.x, a.z);
    }
    const lipY = terrain.terrainHeight(k.lip.x, k.lip.z) + k.Hh;
    const ahead = terrain.terrainHeight(k.lip.x + k.dx * 10, k.lip.z + k.dz * 10);
    const slope = Math.atan2(lipY - k.Hh - ahead, 10);       // ground falls away
    const pitch = Math.atan(2 * k.Hh / k.L) - slope;         // launch angle
    const v = 17;
    for (let i = 1; i <= 7; i++) {
      const t = i * 0.17;
      const d = v * Math.cos(pitch) * t;
      const y = lipY + v * Math.sin(pitch) * t - 4.9 * t * t + 0.9;
      const x = k.lip.x + k.dx * d, z = k.lip.z + k.dz * d;
      if (y < terrain.groundHeight(x, z) + 0.8) break;
      stars.push({ x, y, z });
    }
  }
  return stars;
}

// ---------- Free ride ----------
// Is this spot open snow (no forest within r metres)?
function openSnow(terrain, x, z, r) {
  for (let a = 0; a < 8; a++) {
    const ang = a / 8 * Math.PI * 2;
    if (terrain.forestAt(x + Math.cos(ang) * r, z + Math.sin(ang) * r) > 0.1) return false;
  }
  return terrain.forestAt(x, z) < 0.08;
}

function fallLine(terrain, x, z) {
  const n = terrain.normalAt(x, z);
  const d = Math.hypot(n.x, n.z) || 1;
  return { dx: n.x / d, dz: n.z / d, deg: Math.acos(Math.min(1, n.y)) * 180 / Math.PI };
}

function freeKickers(terrain, rand, buildings) {
  const spots = [];
  const step = 140;
  for (let z = step / 2; z < terrain.sizeZ; z += step) {
    for (let x = step / 2; x < terrain.sizeX; x += step) {
      const px = x + (rand() - 0.5) * step * 0.8, pz = z + (rand() - 0.5) * step * 0.8;
      spots.push([px, pz, rand()]);
    }
  }
  spots.sort((a, b) => a[2] - b[2]);
  const out = [];
  for (const [x, z] of spots) {
    const elev = terrain.terrainHeight(x, z) + terrain.base;
    if (elev > 2050) continue;
    const f = fallLine(terrain, x, z);
    if (f.deg < 8 || f.deg > 22) continue;
    if (!openSnow(terrain, x, z, 22) || !openSnow(terrain, x + f.dx * 40, z + f.dz * 40, 18)) continue;
    if (!buildings.clear(x, z, 30)) continue;
    if (out.some(k => (k.x - x) ** 2 + (k.z - z) ** 2 < LAYOUT.freeJumpEvery ** 2)) continue;
    out.push({ x, z, dx: f.dx, dz: f.dz });
  }
  return out;
}

function freeStars(terrain, rand, buildings) {
  const stars = [];
  const step = LAYOUT.freeStarEvery;
  for (let z = step / 2; z < terrain.sizeZ; z += step) {
    for (let x = step / 2; x < terrain.sizeX; x += step) {
      let px = x + (rand() - 0.5) * step * 0.7, pz = z + (rand() - 0.5) * step * 0.7;
      if (!openSnow(terrain, px, pz, 8)) continue;
      const f0 = fallLine(terrain, px, pz);
      if (f0.deg < 5 || f0.deg > 35) continue;
      // A line of stars that follows the fall line, like a rider would.
      const wiggle = rand() < 0.4 ? 5 + rand() * 4 : 0;
      for (let i = 0; i < 7; i++) {
        const f = fallLine(terrain, px, pz);
        const off = Math.sin(i * 0.9) * wiggle;
        const sx = px - f.dz * off, sz = pz + f.dx * off;
        if (terrain.forestAt(sx, sz) > 0.15 || !buildings.clear(sx, sz, 3)) break;
        stars.push({ x: sx, z: sz, y: terrain.groundHeight(sx, sz) + 1.1 });
        px += f.dx * 5; pz += f.dz * 5;
      }
    }
  }
  return stars;
}

// Bamboo boundary poles with orange tops, only where the line crosses open alpine.
function boundaryPoles(terrain, route) {
  const spots = [];
  for (let s = 30; s < route.length - 40; s += LAYOUT.poleEvery) {
    const p = route.at(s), w = LAYOUT.poleOffset;
    for (const side of [-1, 1]) {
      const x = p.x - p.dz * side * w, z = p.z + p.dx * side * w;
      if (terrain.forestAt(x, z) > 0.05 || terrain.terrainHeight(x, z) + terrain.base < 1650) continue;
      spots.push({ x, z, y: terrain.groundHeight(x, z) });
    }
  }
  const geo = new THREE.CylinderGeometry(0.045, 0.045, 1.9, 5);
  geo.translate(0, 0.95, 0);
  const col = [];
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) col.push(...(pos.getY(i) > 1.4 ? [1, 0.42, 0.05] : [0.85, 0.75, 0.5]));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }), Math.max(1, spots.length));
  mesh.count = spots.length;
  const m = new THREE.Matrix4();
  spots.forEach((p, i) => { m.makeTranslation(p.x, p.y - 0.1, p.z); mesh.setMatrixAt(i, m); });
  mesh.computeBoundingSphere();
  return mesh;
}

// ---------- Gates ----------
function bannerTexture(text, bg) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, 512, 128);
  g.fillStyle = '#fff';
  g.font = 'bold 64px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function gate(terrain, p, text, bg) {
  const group = new THREE.Group();
  const width = 24;
  const pole = new THREE.CylinderGeometry(0.25, 0.25, 10, 8);
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x222831 });
  for (const sgn of [-1, 1]) {
    const x = p.x - p.dz * sgn * width / 2, z = p.z + p.dx * sgn * width / 2;
    const m = new THREE.Mesh(pole, poleMat);
    m.position.set(x, terrain.terrainHeight(x, z) + 5, z);
    group.add(m);
  }
  const y = terrain.terrainHeight(p.x, p.z) + 8.8;
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(width, 2.4),
    new THREE.MeshBasicMaterial({ map: bannerTexture(text, bg), side: THREE.DoubleSide }));
  banner.position.set(p.x, y, p.z);
  banner.lookAt(p.x - p.dx, y, p.z - p.dz);
  group.add(banner);
  return group;
}

// ---------- Put it all together ----------
export function buildCourse(terrain, scene) {
  const rand = rng(LAYOUT.seed);
  const free = terrain.meta.mode === 'free';
  const route = !free && terrain.meta.route.length ? new Route(terrain.meta.route) : null;
  const buildings = buildBuildings(terrain, scene);
  const lifts = buildLifts(terrain, scene);

  // Jumps: on a course, along the line where the slope is friendly;
  // in free ride, on open snow all over the mountain.
  const kickers = [];
  const addKicker = (x, z, dx, dz, s) => {
    const k = makeKicker(terrain, x, z, dx, dz, LAYOUT.jumpSize);
    k.s = s;
    kickers.push(k);
    terrain.bumps.push(k);
    scene.add(kickerMesh(terrain, k));
  };
  if (route) {
    for (let s = 220; s < route.length - 200; s += LAYOUT.jumpEvery) {
      for (let tryS = s; tryS < s + 120; tryS += 12) {
        const p = route.at(tryS);
        const a = terrain.terrainHeight(p.x, p.z);
        const b = terrain.terrainHeight(p.x + p.dx * 40, p.z + p.dz * 40);
        const deg = Math.atan2(a - b, 40) * 180 / Math.PI;
        if (deg < 7 || deg > 26) continue;
        addKicker(p.x, p.z, p.dx, p.dz, tryS);
        break;
      }
    }
  } else {
    for (const k of freeKickers(terrain, rand, buildings)) addKicker(k.x, k.z, k.dx, k.dz, 0);
  }

  const stars = (route ? placeStars(terrain, route, kickers, rand) : freeStars(terrain, rand, buildings).concat(kickerStars(terrain, kickers)))
    .filter(st => !buildings.hit(st.x, st.z, st.y, 2));
  const starMesh = new THREE.InstancedMesh(starGeometry(),
    new THREE.MeshLambertMaterial({ color: 0xffd23a, emissive: 0xb07800 }), Math.max(1, stars.length));
  starMesh.count = stars.length;
  starMesh.frustumCulled = false;
  scene.add(starMesh);

  // Keep trees off the course line, jumps and buildings. The real cleared runs
  // already come from the forest map; this just covers small mismatches.
  const lineHash = new Map();
  if (route) {
    for (const p of route.p) {
      const key = `${Math.floor(p.x / 20)},${Math.floor(p.z / 20)}`;
      if (!lineHash.has(key)) lineHash.set(key, []);
      lineHash.get(key).push(p);
    }
  }
  const nearLine = (x, z, r) => {
    const ci = Math.floor(x / 20), cj = Math.floor(z / 20);
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const list = lineHash.get(`${ci + a},${cj + b}`);
      if (list) for (const p of list) if ((p.x - x) ** 2 + (p.z - z) ** 2 < r * r) return true;
    }
    return false;
  };
  // Lift lines are cut through the forest too: keep trees off towers and stations.
  const liftSpots = [];
  for (const L of lifts.lifts) for (const p of L.pts) liftSpots.push(p);
  const nearLift = (x, z) => liftSpots.some(p => (p.x - x) ** 2 + (p.z - z) ** 2 < 14 * 14);
  const keepClear = (x, z) =>
    !buildings.clear(x, z, 2) || nearLift(x, z) ||
    kickers.some(k => (k.x - x) ** 2 + (k.z - z) ** 2 < 30 * 30) ||
    (route && nearLine(x, z, LAYOUT.clearing));
  const trees = new TreeField(terrain, scene, keepClear);

  let start, end;
  if (route) {
    start = route.at(0); end = route.at(route.length);
    scene.add(boundaryPoles(terrain, route));
    const [startLabel, endLabel] = terrain.meta.labels || ['START', 'FINISH'];
    scene.add(gate(terrain, route.at(14), startLabel, '#1d4ed8'));
    scene.add(gate(terrain, route.at(route.length - 25), endLabel, '#dc2626'));
  }

  return {
    free, route, kickers, stars, starMesh, trees, buildings, lifts, start, end,
    spawns: terrain.meta.spawns || [],
    treesNear: (x, z) => trees.near(x, z),
  };
}
