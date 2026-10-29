// Course design: where the stars, jumps and trees go.
// Everything is placed along the guide line ("route") that the build script
// found down the real mountain. Change the numbers in LAYOUT to reshape the
// course without touching the physics.
import * as THREE from '../vendor/three.module.min.js';

export const LAYOUT = {
  starEvery: 85,        // metres between star patterns
  jumpEvery: 300,       // metres between jumps
  jumpSize: { length: 12, width: 8, height: 2.4 },
  treeline: 1720,       // metres above sea level; no trees above this
  treeSpacing: 15,      // metres between tree candidates
  forestDepth: 380,     // how far from the run the forest is drawn
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
  const side = (p, off) => ({ x: p.x - p.dz * off, z: p.z + p.dx * off });
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
  // Stars in the air over each jump, along a typical flight path.
  for (const k of kickers) {
    for (let i = 0; i < 3; i++) {
      const a = { x: k.x - k.dx * (k.L / 2 + 14 - i * 5), z: k.z - k.dz * (k.L / 2 + 14 - i * 5) };
      add(a.x, a.z);
    }
    const lipY = terrain.terrainHeight(k.lip.x, k.lip.z) + k.Hh;
    const ahead = terrain.terrainHeight(k.lip.x + k.dx * 10, k.lip.z + k.dz * 10);
    const slope = Math.atan2(lipY - k.Hh - ahead, 10);       // ground falls away
    const pitch = Math.atan(2 * k.Hh / k.L) - slope;         // launch angle
    const v = 23;
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

// ---------- Trees ----------
function treeGeometry() {
  const parts = [];
  const add = (geo, y, color) => {
    geo.translate(0, y, 0);
    const g = geo.toNonIndexed();
    const c = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < c.length; i += 3) { c[i] = color[0]; c[i + 1] = color[1]; c[i + 2] = color[2]; }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.deleteAttribute('uv');
    parts.push(g);
  };
  add(new THREE.CylinderGeometry(0.22, 0.3, 2.2, 5), 1.1, [0.32, 0.22, 0.15]);
  add(new THREE.ConeGeometry(2.3, 5, 6), 4, [0.1, 0.27, 0.19]);
  add(new THREE.ConeGeometry(1.7, 4.2, 6), 6.6, [0.13, 0.31, 0.22]);
  add(new THREE.ConeGeometry(1.0, 3.2, 6), 9, [0.85, 0.9, 0.95]);
  let n = 0;
  for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array, o);
    nor.set(p.attributes.normal.array, o);
    col.set(p.attributes.color.array, o);
    o += p.attributes.position.array.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function placeTrees(terrain, route, rand) {
  const trees = [];
  const step = LAYOUT.treeSpacing;
  const samples = [];
  for (let s = 0; s <= route.length; s += 20) samples.push({ ...route.at(s), s });
  // The cleared run is wider in some places than others, like a real trail.
  // Extra room after each jump for wobbly landings.
  const kickerS = route.kickerS || [];
  const runHalfWidth = s => {
    let w = 30 + 10 * Math.sin(s / 170) + 5 * Math.sin(s / 47 + 1.3);
    for (const k of kickerS) if (s > k - 20 && s < k + 110) w += 16;
    return w;
  };
  const D = LAYOUT.forestDepth;
  const minX = Math.max(0, Math.min(...samples.map(p => p.x)) - D);
  const maxX = Math.min(terrain.sizeX, Math.max(...samples.map(p => p.x)) + D);
  const minZ = Math.max(0, Math.min(...samples.map(p => p.z)) - D);
  const maxZ = Math.min(terrain.sizeZ, Math.max(...samples.map(p => p.z)) + D);
  for (let z = minZ; z < maxZ; z += step) {
    for (let x = minX; x < maxX; x += step) {
      const tx = x + (rand() - 0.5) * step * 0.9, tz = z + (rand() - 0.5) * step * 0.9;
      let bd = Infinity, bs = 0;
      for (const p of samples) {
        const d = (p.x - tx) ** 2 + (p.z - tz) ** 2;
        if (d < bd) { bd = d; bs = p.s; }
      }
      bd = Math.sqrt(bd);
      if (bd > LAYOUT.forestDepth || bd < runHalfWidth(bs)) continue;
      const y = terrain.terrainHeight(tx, tz);
      const elev = y + terrain.base;
      const line = LAYOUT.treeline + Math.sin(tx / 90) * 50 + Math.cos(tz / 120) * 40;
      if (elev > line) continue;
      if (terrain.slopeDegrees(tx, tz) > 40) continue;
      // Thin the forest near the treeline and in random glades.
      const thin = Math.min(1, (line - elev) / 150);
      if (rand() > 0.35 + 0.6 * thin) continue;
      const scale = 0.75 + rand() * 0.75;
      trees.push({ x: tx, y, z: tz, scale, yaw: rand() * Math.PI * 2 });
    }
  }
  return trees;
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
  const route = new Route(terrain.meta.route);

  // Jumps: only where the slope is friendly (not flat, not a cliff).
  const kickers = [];
  for (let s = 220; s < route.length - 200; s += LAYOUT.jumpEvery) {
    let placed = false;
    for (let tryS = s; tryS < s + 120 && !placed; tryS += 12) {
      const p = route.at(tryS);
      const a = terrain.terrainHeight(p.x, p.z);
      const b = terrain.terrainHeight(p.x + p.dx * 40, p.z + p.dz * 40);
      const deg = Math.atan2(a - b, 40) * 180 / Math.PI;
      if (deg < 7 || deg > 26) continue;
      const k = makeKicker(terrain, p.x, p.z, p.dx, p.dz, LAYOUT.jumpSize);
      k.s = tryS;
      kickers.push(k);
      terrain.bumps.push(k);
      scene.add(kickerMesh(terrain, k));
      placed = true;
    }
  }

  route.kickerS = kickers.map(k => k.s);
  const stars = placeStars(terrain, route, kickers, rand);
  const starMesh = new THREE.InstancedMesh(starGeometry(),
    new THREE.MeshLambertMaterial({ color: 0xffd23a, emissive: 0x6b4a00 }), stars.length);
  starMesh.frustumCulled = false;
  scene.add(starMesh);

  const trees = placeTrees(terrain, route, rand);
  // Trees are drawn in patches so patches out of view are skipped.
  const treeGeo = treeGeometry();
  const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const patches = new Map();
  const grid = new Map();
  for (const t of trees) {
    const pk = `${Math.floor(t.x / 300)},${Math.floor(t.z / 300)}`;
    if (!patches.has(pk)) patches.set(pk, []);
    patches.get(pk).push(t);
    const key = `${Math.floor(t.x / 10)},${Math.floor(t.z / 10)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(t);
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  for (const list of patches.values()) {
    const mesh = new THREE.InstancedMesh(treeGeo, treeMat, list.length);
    list.forEach((t, i) => {
      q.setFromAxisAngle(up, t.yaw);
      m.compose(new THREE.Vector3(t.x, t.y - 0.3, t.z), q, new THREE.Vector3(t.scale, t.scale, t.scale));
      mesh.setMatrixAt(i, m);
    });
    mesh.computeBoundingSphere();
    scene.add(mesh);
  }

  const start = route.at(0), end = route.at(route.length);
  scene.add(gate(terrain, route.at(14), 'WHISTLER PEAK', '#1d4ed8'));
  scene.add(gate(terrain, route.at(route.length - 25), 'FINISH', '#dc2626'));

  return {
    route, kickers, stars, starMesh, trees, start, end,
    treesNear(x, z) {
      const out = [];
      const ci = Math.floor(x / 10), cj = Math.floor(z / 10);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const list = grid.get(`${ci + a},${cj + b}`);
        if (list) out.push(...list);
      }
      return out;
    },
  };
}
