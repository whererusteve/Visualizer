// The forest, from the satellite forest map.
//
// A whole mountain of trees is far too many to draw, so 3D trees exist only
// within NEAR metres of the rider; further away the forest is painted on the
// ground. Tree positions come from a fixed pattern (a hash of each spot), so
// the same tree is always in the same place, and collisions match what you see.
import * as THREE from '../vendor/three.module.min.js';

const SPACING = 7.5;     // metres between possible tree spots
const BLOCK = 10;        // tree spots per block side (blocks are 75 m squares)
const NEAR = 450;        // draw 3D trees this far around the rider
const MAX_TREES = 14000;
// Coast Mountain firs and hemlocks are tall and narrow: 16-33 m here.
// The model is ~10.6 m at scale 1, so it is stretched upward by TALL.
export const TALL = 2.2;

function hash(i, j, k) {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

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
  add(new THREE.ConeGeometry(2.2, 5, 6), 4, [0.1, 0.26, 0.19]);
  add(new THREE.ConeGeometry(1.6, 4.2, 6), 6.6, [0.13, 0.30, 0.22]);
  add(new THREE.ConeGeometry(0.95, 3.2, 6), 9, [0.85, 0.9, 0.95]);
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

export class TreeField {
  // keepClear(x, z) returns true where no tree may stand (buildings, jumps, the course line).
  constructor(terrain, scene, keepClear = () => false) {
    this.terrain = terrain;
    this.keepClear = keepClear;
    this.blocks = new Map();
    this.mesh = new THREE.InstancedMesh(treeGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), MAX_TREES);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // it always surrounds the camera
    scene.add(this.mesh);
    this.centre = null;
  }

  // The tree at spot (i, j), or null.
  spot(i, j) {
    const T = this.terrain;
    const x = (i + 0.5 + (hash(i, j, 1) - 0.5) * 0.8) * SPACING;
    const z = (j + 0.5 + (hash(i, j, 2) - 0.5) * 0.8) * SPACING;
    if (x < 0 || z < 0 || x > T.sizeX || z > T.sizeZ) return null;
    const d = T.forestAt(x, z);
    if (d < 0.05 || hash(i, j, 3) > d * 0.9) return null;
    if (this.keepClear(x, z)) return null;
    const scale = 0.7 + hash(i, j, 4) * 0.7;
    return { x, z, y: T.terrainHeight(x, z), scale, yaw: hash(i, j, 5) * Math.PI * 2 };
  }

  block(bi, bj) {
    const key = bi * 100000 + bj;
    let list = this.blocks.get(key);
    if (!list) {
      list = [];
      for (let j = bj * BLOCK; j < (bj + 1) * BLOCK; j++) {
        for (let i = bi * BLOCK; i < (bi + 1) * BLOCK; i++) {
          const t = this.spot(i, j);
          if (t) list.push(t);
        }
      }
      this.blocks.set(key, list);
    }
    return list;
  }

  // Rebuild the drawn trees when the rider moves into a new block.
  update(x, z) {
    const size = SPACING * BLOCK;
    const bi = Math.floor(x / size), bj = Math.floor(z / size);
    if (this.centre && this.centre[0] === bi && this.centre[1] === bj) return;
    this.centre = [bi, bj];
    const r = Math.ceil(NEAR / size);
    const order = [];
    for (let b = -r; b <= r; b++) for (let a = -r; a <= r; a++) {
      const d2 = a * a + b * b;
      if (d2 <= r * r) order.push([d2, bi + a, bj + b]);
    }
    order.sort((p, q) => p[0] - q[0]); // nearest first, in case we hit the limit
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const v = new THREE.Vector3(), s = new THREE.Vector3();
    let n = 0;
    for (const [, a, b] of order) {
      for (const t of this.block(a, b)) {
        if (n >= MAX_TREES) break;
        q.setFromAxisAngle(up, t.yaw);
        m.compose(v.set(t.x, t.y - 0.3, t.z), q, s.set(t.scale, t.scale * TALL, t.scale));
        this.mesh.setMatrixAt(n++, m);
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // Trees close enough to bump into.
  near(x, z) {
    const out = [];
    const ci = Math.floor(x / SPACING), cj = Math.floor(z / SPACING);
    for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const t = this.spot(ci + a, cj + b);
      if (t) out.push(t);
    }
    return out;
  }
}
