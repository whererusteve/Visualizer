// Wires everything together: scene, camera, controls, the game loop and the HUD.
import * as THREE from '../vendor/three.module.min.js';
import { loadTerrain } from './terrain.js';
import { buildCourse } from './course.js';
import { Rider } from './rider.js';
import { Sound } from './audio.js';

// Pick a run with #peak-to-creek or ?course=peak-to-creek; free ride by default.
const COURSE_ID = location.hash.slice(1) || new URLSearchParams(location.search).get('course') || 'freeride';
const $ = id => document.getElementById(id);

// ---------- Renderer, scene, camera ----------
const renderer = new THREE.WebGLRenderer({ canvas: $('game'), antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.1;
const scene = new THREE.Scene();
const SKY = new THREE.Color(0xc9def2);
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 250, 1400);
// Nothing past the fog is drawn, which keeps phones fast.
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1700);

scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x8c9fc4, 1.25));
const sun = new THREE.DirectionalLight(0xfff1dc, 1.6);
sun.position.set(0.7, 0.55, -0.45);
scene.add(sun);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// Sky dome: deep blue overhead fading to pale at the horizon.
function skyDome() {
  const g = new THREE.SphereGeometry(1500, 24, 16);
  const c = [], top = new THREE.Color(0x3b78c4), low = SKY;
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = Math.max(0, p.getY(i) / 1500);
    const col = low.clone().lerp(top, Math.pow(t, 0.6));
    c.push(col.r, col.g, col.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  m.renderOrder = -1;
  return m;
}
const sky = skyDome();
scene.add(sky);

// Fine snow texture so you can feel the speed up close.
function snowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const v = 214 + Math.random() * 36;
    g.fillStyle = `rgb(${v},${v + 3},${Math.min(255, v + 10)})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
  // Faint corduroy lines from the groomer
  for (let y = 0; y < 256; y += 4) {
    g.fillStyle = 'rgba(150,170,200,0.06)';
    g.fillRect(0, y, 256, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// The ground's colour across the whole mountain: snow, with the real forest
// (from the satellite forest map) painted in darker green-grey. Up close the 3D
// trees stand on it; far away it is what makes the forest visible.
function groundTexture(terrain) {
  const c = document.createElement('canvas');
  const w = terrain.fw || 2, h = terrain.fh || 2;
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  const img = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const f = terrain.forest ? terrain.forest[i] / 255 : 0;
    const k = Math.min(1, f * 1.1);
    const n = (Math.random() - 0.5) * 10 * k;
    img.data[i * 4] = 255 + (70 - 255) * k + n;
    img.data[i * 4 + 1] = 255 + (98 - 255) * k + n;
    img.data[i * 4 + 2] = 255 + (90 - 255) * k + n;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = false; // row 0 is the north edge, like the map
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}

// Ground material: whole-map colour (above) times a fine repeating snow texture.
function groundMaterial(terrain) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: groundTexture(terrain) });
  const detail = snowTexture();
  mat.onBeforeCompile = sh => {
    sh.uniforms.detailMap = { value: detail };
    sh.uniforms.detailRepeat = { value: new THREE.Vector2(terrain.sizeX / 7, terrain.sizeZ / 7) };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D detailMap;\nuniform vec2 detailRepeat;')
      .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb *= texture2D(detailMap, vMapUv * detailRepeat).rgb;');
  };
  return mat;
}

function snowColor(x, y, z, n, out) {
  const slope = Math.acos(Math.min(1, n.y)) * 180 / Math.PI;
  const rock = THREE.MathUtils.smoothstep(slope, 36, 50);
  const hash = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
  const jitter = (hash - Math.floor(hash) - 0.5) * 0.04;
  const sr = 0.86 + jitter, sg = 0.9 + jitter, sb = 0.97;
  out.setRGB(
    sr + (0.40 - sr) * rock,
    sg + (0.40 - sg) * rock,
    sb + (0.44 - sb) * rock,
  );
  return out;
}

// ---------- Snow spray ----------
class Spray {
  constructor(count = 400) {
    this.n = count;
    this.pos = new Float32Array(count * 3).fill(-1e5);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const dot = document.createElement('canvas');
    dot.width = dot.height = 32;
    const dg = dot.getContext('2d');
    const grad = dg.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    dg.fillStyle = grad; dg.fillRect(0, 0, 32, 32);
    this.points = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xffffff, size: 0.45, map: new THREE.CanvasTexture(dot),
      transparent: true, opacity: 0.9, depthWrite: false,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.acc = 0;
  }
  emit(p, v, amount, dt) {
    this.acc += amount * 260 * dt;
    while (this.acc > 1) {
      this.acc--;
      const i = this.next = (this.next + 1) % this.n;
      this.pos[i * 3] = p.x + (Math.random() - 0.5) * 0.8;
      this.pos[i * 3 + 1] = p.y + 0.1;
      this.pos[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.8;
      this.vel[i * 3] = v.x * 0.35 + (Math.random() - 0.5) * 3;
      this.vel[i * 3 + 1] = 1.5 + Math.random() * 2.5;
      this.vel[i * 3 + 2] = v.z * 0.35 + (Math.random() - 0.5) * 3;
      this.life[i] = 0.5 + Math.random() * 0.5;
    }
  }
  update(dt) {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -1e5; continue; }
      this.vel[i * 3 + 1] -= 6 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

// ---------- Controls ----------
const keys = new Set();
const touch = { left: false, right: false, jump: false, brake: false, tuck: false };
const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'tuck', KeyW: 'tuck', ArrowDown: 'brake', KeyS: 'brake', Space: 'jump',
};
window.addEventListener('keydown', e => {
  if (KEYMAP[e.code]) { keys.add(KEYMAP[e.code]); e.preventDefault(); }
  if (e.code === 'KeyR') restart();
  if (e.code === 'Enter' && game.state !== 'playing') begin();
});
window.addEventListener('keyup', e => { if (KEYMAP[e.code]) keys.delete(KEYMAP[e.code]); });
window.addEventListener('blur', () => keys.clear());
document.querySelectorAll('[data-touch]').forEach(btn => {
  const k = btn.dataset.touch;
  const on = e => { touch[k] = true; btn.classList.add('down'); e.preventDefault(); };
  const off = e => { touch[k] = false; btn.classList.remove('down'); e.preventDefault(); };
  btn.addEventListener('pointerdown', on);
  btn.addEventListener('pointerup', off);
  btn.addEventListener('pointercancel', off);
  btn.addEventListener('pointerleave', off);
});
function readInput() {
  const held = k => keys.has(k) || touch[k];
  return {
    steer: (held('right') ? 1 : 0) - (held('left') ? 1 : 0),
    jump: held('jump'),
    brake: held('brake') || game.state === 'finished',
    tuck: held('tuck'),
  };
}

// ---------- Game state ----------
const sound = new Sound();
const game = { state: 'loading', time: 0, stars: 0, routeIndex: 0, toastTimer: 0, spawn: 0 };
let terrain, course, rider, spray;

function fmtTime(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

function restart() {
  if (!course) return;
  if (course.route) {
    const s = course.route.at(0), a = course.route.at(25);
    const dx = a.x - s.x, dz = a.z - s.z, d = Math.hypot(dx, dz);
    rider.place(s.x, s.z, dx / d, dz / d, 0);
  } else {
    // Free ride: drop in at the chosen spot, facing downhill.
    const sp = course.spawns[game.spawn] || course.spawns[0];
    const n = terrain.normalAt(sp.x, sp.z);
    const d = Math.hypot(n.x, n.z) || 1;
    rider.place(sp.x, sp.z, n.x / d || 0, n.z / d || 1, 0);
  }
  resetStarMatrices();
  game.stars = 0; game.time = 0; game.routeIndex = 0;
  havePrev = false;
  $('finish').hidden = true;
  if (game.state === 'finished') game.state = 'playing';
  snapCamera();
}

function begin() {
  sound.start();
  document.activeElement?.blur();
  $('intro').hidden = true;
  if (game.state === 'finished') restart();
  game.state = 'playing';
}

// ---------- Camera ----------
const camDir = new THREE.Vector3(0, 0, 1);
const camTarget = new THREE.Vector3();
function snapCamera() {
  rider.forward(camDir);
  updateCamera(1, true);
}
function updateCamera(dt, snap = false) {
  const p = rider.p, v = rider.v;
  const hs = Math.hypot(v.x, v.z);
  const want = hs > 2 ? new THREE.Vector3(v.x / hs, 0, v.z / hs) : rider.forward();
  camDir.lerp(want, snap ? 1 : 1 - Math.exp(-2.5 * dt)).normalize();
  const speed = v.length();
  const dist = 6.5 + Math.min(speed, 40) * 0.06;
  const height = 2.4 + Math.min(speed, 40) * 0.025;
  const desired = new THREE.Vector3(p.x - camDir.x * dist, p.y + height, p.z - camDir.z * dist);
  const floor = terrain.groundHeight(desired.x, desired.z) + 1.4;
  if (desired.y < floor) desired.y = floor;
  if (snap) camera.position.copy(desired);
  else camera.position.lerp(desired, 1 - Math.exp(-7 * dt));
  const gMin = terrain.groundHeight(camera.position.x, camera.position.z) + 1.0;
  if (camera.position.y < gMin) camera.position.y = gMin;
  camTarget.set(p.x + camDir.x * 5, p.y + 1.1, p.z + camDir.z * 5);
  camera.lookAt(camTarget);
  // A narrow lens keeps slopes looking as steep as they are; a wide one flattens them.
  const fov = 55 + Math.min(10, speed * 0.25);
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); }
  sky.position.copy(camera.position);
}

// ---------- Stars ----------
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _v = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
// Where the rider's body was last frame. Stars are collected anywhere along the
// path between then and now, so fast riders on slow phones don't skip past them.
const bodyNow = new THREE.Vector3(), bodyPrev = new THREE.Vector3();
let havePrev = false;
const STAR_REACH = 2.5;
function distToPath(st, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  let t = len2 > 0 ? ((st.x - a.x) * abx + (st.y - a.y) * aby + (st.z - a.z) * abz) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(a.x + abx * t - st.x, a.y + aby * t - st.y, a.z + abz * t - st.z);
}
// Stars are sorted into 100 m squares so each frame only the ones near the
// rider are checked and animated; the rest keep their last position.
let starGrid = null;
function starsNear(x, z, r) {
  if (!starGrid) {
    starGrid = new Map();
    course.stars.forEach((st, i) => {
      st.i = i;
      const k = `${Math.floor(st.x / 100)},${Math.floor(st.z / 100)}`;
      if (!starGrid.has(k)) starGrid.set(k, []);
      starGrid.get(k).push(st);
    });
  }
  const out = [], n = Math.ceil(r / 100), ci = Math.floor(x / 100), cj = Math.floor(z / 100);
  for (let b = -n; b <= n; b++) for (let a = -n; a <= n; a++) {
    const list = starGrid.get(`${ci + a},${cj + b}`);
    if (list) out.push(...list);
  }
  return out;
}
function resetStarMatrices() {
  course.stars.forEach(st => { st.got = -1; });
}
// Only stars within STAR_DRAW metres are drawn (packed into the first slots of
// the instanced mesh); further ones are too small to see through the haze anyway.
const STAR_DRAW = 450;
function updateStars(now) {
  bodyNow.copy(rider.p).addScaledVector(rider.n, 0.9);
  if (!havePrev) { bodyPrev.copy(bodyNow); havePrev = true; }
  const mesh = course.starMesh;
  _q.setFromAxisAngle(_yAxis, now * 3);
  let n = 0;
  for (const st of starsNear(rider.p.x, rider.p.z, STAR_DRAW)) {
    if (st.got < 0 && rider.crashed <= 0 && game.state === 'playing') {
      if (distToPath(st, bodyPrev, bodyNow) < STAR_REACH) {
        st.got = now;
        game.stars++;
        sound.star();
      }
    }
    if (st.got >= 0) {
      const e = now - st.got;
      if (e > 0.22) continue; // collected: gone
      _s.setScalar(1.35 + e * 5);
      _m.compose(_v.set(st.x, st.y + e * 8, st.z), _q, _s);
    } else {
      _s.setScalar(1.35);
      _m.compose(_v.set(st.x, st.y + Math.sin(now * 2 + st.i) * 0.12, st.z), _q, _s);
    }
    mesh.setMatrixAt(n++, _m);
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  bodyPrev.copy(bodyNow);
}

// ---------- Minimap ----------
// A small map of the whole mountain: shaded relief, forest, the course line
// and drop-in spots, with your position and heading on top.
let mini = null;
function buildMinimap() {
  const cv = $('minimap');
  const scale = 4; // terrain cells per minimap pixel
  const w = Math.floor(terrain.W / scale), h = Math.floor(terrain.H / scale);
  cv.width = w; cv.height = h;
  const base = document.createElement('canvas');
  base.width = w; base.height = h;
  const g = base.getContext('2d');
  const img = g.createImageData(w, h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const ti = i * scale, tj = j * scale;
      const dx = terrain.at(ti + 1, tj) - terrain.at(ti - 1, tj);
      const dz = terrain.at(ti, tj + 1) - terrain.at(ti, tj - 1);
      const shade = Math.max(0.35, Math.min(1.1, 0.8 + (-dx + dz) * 0.02));
      const f = terrain.forestAt(ti * terrain.cell, tj * terrain.cell);
      const k = (j * w + i) * 4;
      img.data[k] = (235 - 165 * f) * shade;
      img.data[k + 1] = (240 - 140 * f) * shade;
      img.data[k + 2] = (250 - 160 * f) * shade;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const px = v => v / terrain.cell / scale;
  if (course.route) {
    g.strokeStyle = '#ff2d95'; g.lineWidth = 2; g.beginPath();
    course.route.p.forEach((p, i) => (i ? g.lineTo(px(p.x), px(p.z)) : g.moveTo(px(p.x), px(p.z))));
    g.stroke();
  }
  g.fillStyle = '#1d4ed8';
  for (const sp of course.spawns) { g.beginPath(); g.arc(px(sp.x), px(sp.z), 2.5, 0, Math.PI * 2); g.fill(); }
  mini = { cv, ctx: cv.getContext('2d'), base, px };
}
function drawMinimap() {
  if (!mini) return;
  const { ctx, base, px } = mini;
  ctx.drawImage(base, 0, 0);
  const x = px(rider.p.x), z = px(rider.p.z);
  const f = rider.forward();
  ctx.fillStyle = '#ffc531'; ctx.strokeStyle = '#0f172a'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + f.x * 7, z + f.z * 7);
  ctx.lineTo(x - f.x * 4 - f.z * 4, z - f.z * 4 + f.x * 4);
  ctx.lineTo(x - f.x * 4 + f.z * 4, z - f.z * 4 - f.x * 4);
  ctx.closePath(); ctx.fill(); ctx.stroke();
}

// ---------- HUD ----------
function updateHud() {
  $('stars').textContent = course.route ? `${game.stars} / ${course.stars.length}` : `${game.stars}`;
  $('speed').textContent = Math.round(rider.speed() * 3.6);
  $('elev').textContent = Math.round(rider.p.y + terrain.base);
  $('clock').textContent = fmtTime(game.time);
  if (course.route) {
    const left = Math.max(0, course.route.length - course.route.s[game.routeIndex]);
    $('togo').textContent = left > 1000 ? `${(left / 1000).toFixed(1)} km` : `${Math.round(left)} m`;
  } else {
    // Free ride: name the nearest landmark instead of distance to go.
    let best = null, bd = Infinity;
    for (const sp of course.spawns) {
      const d = (sp.x - rider.p.x) ** 2 + (sp.z - rider.p.z) ** 2;
      if (d < bd) { bd = d; best = sp; }
    }
    $('togo').textContent = best ? best.name : '';
    $('togo-label').textContent = '';
    $('togo-pre').textContent = 'near';
  }
  drawMinimap();
  $('charge').style.transform = `scaleX(${rider.charge})`;
  $('charge').parentElement.style.opacity = rider.charge > 0 ? 1 : 0;
}

function handleEvents() {
  for (const e of rider.events) {
    if (e === 'jump') sound.jump();
    else if (e === 'land') sound.land();
    else if (e === 'crash') { sound.crash(); toast('Wipeout!'); }
    else if (e.type === 'trick') { sound.land(); toast(`${e.spin}!`); }
  }
  rider.events.length = 0;
}

// ---------- Main loop ----------
const STEP = 1 / 120;
let acc = 0, last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  // Cap at 0.25 s (e.g. after switching tabs), but otherwise always keep up with real
  // time, so a slow phone never plays in slow motion.
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  if (game.state === 'playing' || game.state === 'finished') {
    acc += dt;
    const input = readInput();
    let n = 0;
    while (acc >= STEP && n++ < 30) {
      rider.step(STEP, input);
      rider.checkTrees(course);
      acc -= STEP;
    }
    if (game.state === 'playing') {
      game.time += dt;
      if (course.route) {
        const near = course.route.nearest(rider.p.x, rider.p.z, game.routeIndex);
        game.routeIndex = near.index;
        if (near.s > course.route.length - 30 && near.distance < 60) finish();
      }
    }
    handleEvents();
    if (rider.contact && rider.carve > 0.15 && rider.crashed <= 0) spray.emit(rider.p, rider.v, rider.carve, dt);
    sound.update(rider.speed(), rider.carve, rider.contact);
  }
  spray.update(dt);
  course.trees.update(rider.p.x, rider.p.z);
  rider.updateModel(dt, t);
  updateStars(t);
  updateCamera(dt);
  updateHud();
  renderer.render(scene, camera);
}

function finish() {
  game.state = 'finished';
  sound.finish();
  $('f-time').textContent = fmtTime(game.time);
  $('f-stars').textContent = `${game.stars} of ${course.stars.length}`;
  $('finish').hidden = false;
}

// ---------- Start up ----------
async function init() {
  try {
    terrain = await loadTerrain(COURSE_ID);
  } catch (err) {
    $('loading').textContent = 'Could not load the mountain. If you opened the file directly, run it from a web server (see README).';
    throw err;
  }
  $('course-name').textContent = terrain.meta.name;
  const pick = $('course-pick');
  pick.value = COURSE_ID;
  pick.addEventListener('change', () => { location.hash = pick.value; location.reload(); });
  scene.add(terrain.buildMesh(snowColor, groundMaterial(terrain)));
  course = buildCourse(terrain, scene);
  rider = new Rider(terrain, scene);
  spray = new Spray();
  const spawnPick = $('spawn-pick');
  if (course.spawns.length && !course.route) {
    course.spawns.forEach((sp, i) => spawnPick.add(new Option(sp.name, i)));
    spawnPick.addEventListener('change', () => { game.spawn = +spawnPick.value; restart(); });
    $('spawn-row').hidden = false;
  }
  buildMinimap();
  restart();
  game.state = 'intro';
  $('loading').hidden = true;
  $('drop').disabled = false;
  $('drop').addEventListener('click', begin);
  $('again').addEventListener('click', () => { restart(); begin(); });
  $('restart').addEventListener('click', () => { restart(); });
  requestAnimationFrame(frame);
  // Handy for tuning from the browser console.
  window.game = { game, rider, course, terrain, camera, snapCamera, restart, renderer };
}
init();
