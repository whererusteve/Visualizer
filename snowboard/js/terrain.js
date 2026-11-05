// The mountain: loads the real elevation grid and answers "how high is the
// snow here?" for the physics, and builds the 3D mesh you see.
import * as THREE from '../vendor/three.module.min.js';

async function loadPixels(url) {
  const blob = await fetch(url).then(r => { if (!r.ok) throw new Error(url); return r.blob(); });
  const img = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, px: ctx.getImageData(0, 0, img.width, img.height).data };
}

export async function loadTerrain(id) {
  const meta = await fetch(`data/${id}.json`).then(r => r.json());
  // Several courses share one mountain's height map (and forest map).
  const [hm, fm] = await Promise.all([
    loadPixels(`data/${meta.terrain || id}.png`),
    meta.forest ? loadPixels(`data/${meta.forest}.png`) : null,
  ]);
  // Heights are packed in the PNG's red (high byte) and green (low byte).
  const raw = new Uint16Array(hm.w * hm.h);
  for (let i = 0; i < raw.length; i++) raw[i] = hm.px[i * 4] * 256 + hm.px[i * 4 + 1];
  const t = new Terrain(meta, raw);
  if (fm) {
    const f = new Uint8Array(fm.w * fm.h);
    for (let i = 0; i < f.length; i++) f[i] = fm.px[i * 4];
    t.setForest(f, fm.w, fm.h);
  }
  return t;
}

export class Terrain {
  constructor(meta, raw) {
    this.meta = meta;
    this.W = meta.width;
    this.H = meta.height;
    this.cell = meta.cellSize;
    this.base = meta.minElevation; // game height 0 = lowest point on the map
    this.h = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) this.h[i] = raw[i] * meta.heightScale - this.base;
    this.sizeX = (this.W - 1) * this.cell;
    this.sizeZ = (this.H - 1) * this.cell;
    this.bumps = []; // jumps and other shapes added on top of the snow
    this.forest = null;
  }

  // Forest map: twice the resolution of the height grid, 0 = open, 255 = forest.
  setForest(data, w, h) {
    this.forest = data; this.fw = w; this.fh = h;
    this.fstep = this.cell / 2;
  }

  // How forested a spot is, 0 (open snow) to 1 (dense forest).
  forestAt(x, z) {
    if (!this.forest) return 0;
    const gx = Math.min(Math.max(x / this.fstep - 0.5, 0), this.fw - 1.001);
    const gz = Math.min(Math.max(z / this.fstep - 0.5, 0), this.fh - 1.001);
    const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j, w = this.fw, f = this.forest;
    const a = f[j * w + i] + (f[j * w + i + 1] - f[j * w + i]) * fx;
    const b = f[(j + 1) * w + i] + (f[(j + 1) * w + i + 1] - f[(j + 1) * w + i]) * fx;
    return (a + (b - a) * fz) / 255;
  }

  at(i, j) {
    i = i < 0 ? 0 : i >= this.W ? this.W - 1 : i;
    j = j < 0 ? 0 : j >= this.H ? this.H - 1 : j;
    return this.h[j * this.W + i];
  }

  // Height of the snow surface exactly as drawn (two triangles per cell).
  terrainHeight(x, z) {
    const gx = Math.min(Math.max(x / this.cell, 0), this.W - 1.0001);
    const gz = Math.min(Math.max(z / this.cell, 0), this.H - 1.0001);
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    const h00 = this.at(i, j), h10 = this.at(i + 1, j);
    const h01 = this.at(i, j + 1), h11 = this.at(i + 1, j + 1);
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  // Smoothly blended height, used for slope direction so the board
  // doesn't twitch at every triangle edge.
  smoothHeight(x, z) {
    const gx = Math.min(Math.max(x / this.cell, 0), this.W - 1.0001);
    const gz = Math.min(Math.max(z / this.cell, 0), this.H - 1.0001);
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    const a = this.at(i, j) + (this.at(i + 1, j) - this.at(i, j)) * fx;
    const b = this.at(i, j + 1) + (this.at(i + 1, j + 1) - this.at(i, j + 1)) * fx;
    return a + (b - a) * fz;
  }

  bumpHeight(x, z) {
    let best = 0;
    for (const b of this.bumps) {
      const dx = x - b.x, dz = z - b.z;
      if (dx * dx + dz * dz > b.r2) continue;
      const v = b.height(dx, dz);
      if (v > best) best = v;
    }
    return best;
  }

  onBump(x, z) {
    return this.bumpHeight(x, z) > 0;
  }

  // What the rider actually stands on: snow plus any jump.
  groundHeight(x, z) {
    return this.terrainHeight(x, z) + this.bumpHeight(x, z);
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    if (this.onBump(x, z)) {
      const e = 0.35;
      const dx = this.groundHeight(x + e, z) - this.groundHeight(x - e, z);
      const dz = this.groundHeight(x, z + e) - this.groundHeight(x, z - e);
      return out.set(-dx, 2 * e, -dz).normalize();
    }
    const e = this.cell * 0.5;
    const dx = this.smoothHeight(x + e, z) - this.smoothHeight(x - e, z);
    const dz = this.smoothHeight(x, z + e) - this.smoothHeight(x, z - e);
    return out.set(-dx, 2 * e, -dz).normalize();
  }

  slopeDegrees(x, z) {
    const n = this.normalAt(x, z);
    return THREE.MathUtils.radToDeg(Math.acos(Math.min(1, n.y)));
  }

  // Build the visible mountain in square chunks so the camera only draws the
  // parts in view. Each chunk has a full-detail and a half-detail version; the
  // half-detail one is drawn when the chunk is far away (Three.js LOD).
  buildMesh(colorFn, material, chunk = 64, farDistance = 450) {
    const group = new THREE.Group();
    const { W, H } = this;
    for (let j0 = 0; j0 < H - 1; j0 += chunk) {
      for (let i0 = 0; i0 < W - 1; i0 += chunk) {
        const i1 = Math.min(i0 + chunk, W - 1), j1 = Math.min(j0 + chunk, H - 1);
        const lod = new THREE.LOD();
        lod.addLevel(new THREE.Mesh(this.chunkGeometry(i0, j0, i1, j1, 1, colorFn), material), 0);
        lod.addLevel(new THREE.Mesh(this.chunkGeometry(i0, j0, i1, j1, 2, colorFn), material), farDistance);
        // LOD measures distance from the object's position: put it at the chunk's centre.
        const c = lod.levels[0].object.geometry.boundingSphere.center.clone();
        lod.position.copy(c);
        for (const l of lod.levels) l.object.position.copy(c).negate();
        group.add(lod);
      }
    }
    return group;
  }

  chunkGeometry(i0, j0, i1, j1, step, colorFn) {
    const { cell } = this;
    const n = new THREE.Vector3();
    const col = new THREE.Color();
    // Columns and rows to use; always include the chunk's last edge so chunks meet.
    const cols = [], rows = [];
    for (let i = i0; i < i1; i += step) cols.push(i);
    cols.push(i1);
    for (let j = j0; j < j1; j += step) rows.push(j);
    rows.push(j1);
    const cw = cols.length, chh = rows.length;
    const pos = new Float32Array(cw * chh * 3);
    const nor = new Float32Array(cw * chh * 3);
    const clr = new Float32Array(cw * chh * 3);
    const uv = new Float32Array(cw * chh * 2);
    let k = 0;
    for (const j of rows) {
      for (const i of cols) {
        const x = i * cell, z = j * cell, y = this.at(i, j);
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        n.set(this.at(i - 1, j) - this.at(i + 1, j), 2 * cell,
          this.at(i, j - 1) - this.at(i, j + 1)).normalize();
        nor[k * 3] = n.x; nor[k * 3 + 1] = n.y; nor[k * 3 + 2] = n.z;
        colorFn(x, y, z, n, col);
        clr[k * 3] = col.r; clr[k * 3 + 1] = col.g; clr[k * 3 + 2] = col.b;
        uv[k * 2] = x / this.sizeX; uv[k * 2 + 1] = z / this.sizeZ; // whole-map texture
        k++;
      }
    }
    const idx = [];
    for (let j = 0; j < chh - 1; j++) {
      for (let i = 0; i < cw - 1; i++) {
        const a = j * cw + i, b = a + 1, c = a + cw, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(clr, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeBoundingSphere();
    return g;
  }
}
