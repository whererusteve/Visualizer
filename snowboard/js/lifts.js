// Lifts: towers, cables, terminals and moving chairs or gondola cabins, all
// placed from the real lift lines. You can ride them: stop near a lift's
// bottom station and the HUD offers a ride to the top.
import * as THREE from '../vendor/three.module.min.js';

const TOWER_EVERY = 110;   // metres between towers
const CLEAR = 9;           // cable height above the snow at each tower
const CARRIER_EVERY = 45;  // metres between chairs or cabins
const RIDE_SECONDS = 14;   // any ride takes about this long (real rides take 5-20 minutes)
const SPEED = 5;           // metres per second the carriers visibly move

function makeLift(terrain, def) {
  const st = def.stations.map(s => ({ ...s, y: terrain.terrainHeight(s.x, s.z) }));
  // Cable path: a point on every tower, terminals at the ends and mid-stations.
  const pts = [];
  for (let i = 0; i < st.length - 1; i++) {
    const a = st[i], b = st[i + 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(len / TOWER_EVERY));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const t = k / n;
      const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const end = k === 0 || k === n;
      pts.push({ x, z, ground: terrain.terrainHeight(x, z), terminal: end });
    }
  }
  // Cable height: towers stand CLEAR m tall, terminals a bit lower.
  pts.forEach(p => { p.y = p.ground + (p.terminal ? 5 : CLEAR); });
  // Cumulative distance along the cable
  let s = 0;
  pts.forEach((p, i) => {
    if (i) s += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y, p.z - pts[i - 1].z);
    p.s = s;
  });
  const dir = new THREE.Vector3(st[st.length - 1].x - st[0].x, 0, st[st.length - 1].z - st[0].z).normalize();
  return { ...def, st, pts, length: s, dir, rideable: !/Peak 2 Peak/.test(def.name) };
}

// Position on one side of the cable loop at distance s (0 = bottom).
function cableAt(lift, s, side, out) {
  const p = lift.pts;
  s = Math.max(0, Math.min(lift.length, s));
  let i = 1;
  while (i < p.length - 1 && p[i].s < s) i++;
  const a = p[i - 1], b = p[i], f = (s - a.s) / ((b.s - a.s) || 1);
  const off = side * 2.2; // the up and down cables are a few metres apart
  out.set(a.x + (b.x - a.x) * f - lift.dir.z * off, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f + lift.dir.x * off);
  return out;
}

function tubeBetween(a, b, r, mat) {
  const d = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 4, 1, true), mat);
  m.position.copy(a).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}

export function buildLifts(terrain, scene) {
  const defs = terrain.meta.lifts || [];
  const lifts = defs.map(d => makeLift(terrain, d));
  const steel = new THREE.MeshLambertMaterial({ color: 0x5b6470 });
  const cableMat = new THREE.LineBasicMaterial({ color: 0x1f2937 });
  const group = new THREE.Group();
  scene.add(group);

  // Towers: one instanced mesh (pole + cross-arm) for every lift.
  const towerGeo = new THREE.CylinderGeometry(0.35, 0.5, 1, 6);
  towerGeo.translate(0, 0.5, 0);
  const armGeo = new THREE.BoxGeometry(0.4, 0.4, 6.2);
  const towers = [];
  for (const L of lifts) for (const p of L.pts) if (!p.terminal) towers.push({ L, p });
  const towerMesh = new THREE.InstancedMesh(towerGeo, steel, Math.max(1, towers.length));
  const armMesh = new THREE.InstancedMesh(armGeo, steel, Math.max(1, towers.length));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), sc = new THREE.Vector3();
  towers.forEach(({ L, p }, i) => {
    m.compose(v.set(p.x, p.ground - 0.5, p.z), q.identity(), sc.set(1, p.y - p.ground + 1.3, 1));
    towerMesh.setMatrixAt(i, m);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(L.dir.x, L.dir.z));
    m.compose(v.set(p.x, p.y + 0.6, p.z), q, sc.set(1, 1, 1));
    armMesh.setMatrixAt(i, m);
  });
  towerMesh.count = armMesh.count = towers.length;
  group.add(towerMesh, armMesh);

  // Cables (thin lines) and terminal buildings
  const termMat = new THREE.MeshLambertMaterial({ color: 0x8a6d4b });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0xeef3f8 });
  const signs = [];
  for (const L of lifts) {
    for (const side of [-1, 1]) {
      const pts = [];
      for (let s = 0; s <= L.length; s += 20) pts.push(cableAt(L, s, side, new THREE.Vector3()).add(new THREE.Vector3(0, 0.6, 0)));
      pts.push(cableAt(L, L.length, side, new THREE.Vector3()).add(new THREE.Vector3(0, 0.6, 0)));
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cableMat));
    }
    for (const s of L.st) {
      const big = L.type === 'gondola';
      const w = big ? 12 : 8, d = big ? 16 : 10, h = big ? 7 : 5;
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), termMat);
      box.position.set(s.x, s.y + h / 2 - 0.5, s.z);
      box.rotation.y = Math.atan2(L.dir.x, L.dir.z);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(w + 1.2, 0.6, d + 1.2), roofMat);
      roof.position.set(0, h / 2 + 0.3, 0);
      box.add(roof);
      group.add(box);
      signs.push({ x: s.x, z: s.z, r: Math.max(w, d) / 2 + 0.5, top: s.y + h });
    }
  }

  // Moving carriers: a chair (bench + bar) or a gondola cabin.
  const chairGeo = new THREE.BoxGeometry(2.2, 0.25, 0.7);
  chairGeo.translate(0, -2.6, 0);
  const cabinGeo = new THREE.BoxGeometry(2.0, 2.2, 2.0);
  cabinGeo.translate(0, -2.8, 0);
  const hangerGeo = new THREE.BoxGeometry(0.08, 2.5, 0.08);
  hangerGeo.translate(0, -1.25, 0);
  const carriers = [];
  for (const L of lifts) {
    const n = Math.floor(L.length / CARRIER_EVERY);
    for (let i = 0; i < n; i++) for (const side of [-1, 1]) carriers.push({ L, s0: i * CARRIER_EVERY, side });
  }
  const chairMat = new THREE.MeshLambertMaterial({ color: 0x263238 });
  const cabinMat = new THREE.MeshLambertMaterial({ color: 0xc62828 });
  const nChairs = carriers.filter(c => c.L.type !== 'gondola').length;
  const nCabins = carriers.length - nChairs;
  const chairMesh = new THREE.InstancedMesh(chairGeo, chairMat, Math.max(1, nChairs));
  const cabinMesh = new THREE.InstancedMesh(cabinGeo, cabinMat, Math.max(1, nCabins));
  const hangerMesh = new THREE.InstancedMesh(hangerGeo, steel, Math.max(1, carriers.length));
  for (const mesh of [chairMesh, cabinMesh, hangerMesh]) { mesh.frustumCulled = false; group.add(mesh); }

  const lastFrame = { t: -1 };
  function update(t, near) {
    if (t - lastFrame.t < 1 / 30) return; // 30 updates a second is plenty
    lastFrame.t = t;
    let ci = 0, ki = 0, hi = 0;
    for (const c of carriers) {
      const L = c.L;
      // up on one side, down on the other
      let s = (c.s0 + t * SPEED) % L.length;
      if (c.side < 0) s = L.length - s;
      cableAt(L, s, c.side, v);
      if ((v.x - near.x) ** 2 + (v.z - near.z) ** 2 > 1500 * 1500) continue;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(L.dir.x, L.dir.z) + Math.PI / 2);
      m.compose(v, q, sc.set(1, 1, 1));
      hangerMesh.setMatrixAt(hi++, m);
      if (L.type === 'gondola') cabinMesh.setMatrixAt(ki++, m); else chairMesh.setMatrixAt(ci++, m);
    }
    chairMesh.count = ci; cabinMesh.count = ki; hangerMesh.count = hi;
    for (const mesh of [chairMesh, cabinMesh, hangerMesh]) mesh.instanceMatrix.needsUpdate = true;
  }

  // Lift you could ride from here: a bottom (or mid) station within 30 m.
  function boardable(x, z) {
    for (const L of lifts) {
      if (!L.rideable) continue;
      for (let i = 0; i < L.st.length - 1; i++) {
        const s = L.st[i];
        if ((s.x - x) ** 2 + (s.z - z) ** 2 < 30 * 30) return { lift: L, from: i };
      }
    }
    return null;
  }

  // A ride from station `from` to the top, squeezed into about RIDE_SECONDS.
  function ride(lift, from) {
    const start = lift.pts.find(p => Math.hypot(p.x - lift.st[from].x, p.z - lift.st[from].z) < 1)?.s ?? 0;
    const dist = lift.length - start;
    return {
      lift, start, dist, t: 0,
      duration: Math.min(RIDE_SECONDS, Math.max(6, dist / 60)),
      pos(out) { return cableAt(lift, start + dist * Math.min(1, this.t / this.duration), 1, out); },
    };
  }

  // The chair or cabin you are riding in, drawn at your position.
  const myChair = new THREE.Group();
  myChair.add(new THREE.Mesh(chairGeo, chairMat), new THREE.Mesh(hangerGeo, steel));
  const back = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.8, 0.12), chairMat);
  back.position.set(0, -2.15, 0.35);
  myChair.add(back);
  const myCabin = new THREE.Group();
  const glass = new THREE.MeshLambertMaterial({ color: 0x9ec5e8, transparent: true, opacity: 0.35 });
  const shell = new THREE.Mesh(cabinGeo, glass);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.15, 2.0), cabinMat);
  floor.position.y = -3.85;
  const roof = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.25, 2.1), cabinMat);
  roof.position.y = -1.6;
  myCabin.add(shell, floor, roof, new THREE.Mesh(hangerGeo, steel));
  myChair.visible = myCabin.visible = false;
  group.add(myChair, myCabin);
  function carry(lift, pos) {
    const gondola = lift && lift.type === 'gondola';
    myChair.visible = !!lift && !gondola;
    myCabin.visible = !!lift && gondola;
    if (!lift) return;
    const c = gondola ? myCabin : myChair;
    c.position.copy(pos);
    c.rotation.set(0, Math.atan2(lift.dir.x, lift.dir.z) + Math.PI / 2, 0);
  }
  // Seat height below the cable: on the chair bench, or standing on the cabin floor.
  const seatDrop = lift => (lift.type === 'gondola' ? 3.75 : 2.6);

  return { lifts, update, boardable, ride, carry, seatDrop, keepClear: signs };
}
