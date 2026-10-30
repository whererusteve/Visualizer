// Wires everything together: scene, camera, controls, the game loop and the HUD.
import * as THREE from '../vendor/three.module.min.js';
import { loadTerrain } from './terrain.js';
import { buildCourse } from './course.js';
import { Rider } from './rider.js';
import { Sound } from './audio.js';

// Pick a run with #whistler or ?course=whistler; Peak to Creek by default.
const COURSE_ID = location.hash.slice(1) || new URLSearchParams(location.search).get('course') || 'peak-to-creek';
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
const game = { state: 'loading', time: 0, stars: 0, routeIndex: 0, toastTimer: 0 };
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
  const s = course.route.at(0), a = course.route.at(25);
  const dx = a.x - s.x, dz = a.z - s.z, d = Math.hypot(dx, dz);
  rider.place(s.x, s.z, dx / d, dz / d, 0);
  course.stars.forEach(st => { st.got = -1; });
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
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
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
function updateStars(now) {
  bodyNow.copy(rider.p).addScaledVector(rider.n, 0.9);
  if (!havePrev) { bodyPrev.copy(bodyNow); havePrev = true; }
  const mesh = course.starMesh;
  _q.setFromAxisAngle(_yAxis, now * 3);
  course.stars.forEach((st, i) => {
    if (st.got < 0 && rider.crashed <= 0 && game.state === 'playing') {
      if (distToPath(st, bodyPrev, bodyNow) < STAR_REACH) {
        st.got = now;
        game.stars++;
        sound.star();
      }
    }
    if (st.got >= 0) {
      const e = now - st.got;
      if (e > 0.22) { mesh.setMatrixAt(i, _zero); return; }
      _s.setScalar(1.35 + e * 5);
      _m.compose(_v.set(st.x, st.y + e * 8, st.z), _q, _s);
    } else {
      _s.setScalar(1.35);
      _m.compose(_v.set(st.x, st.y + Math.sin(now * 2 + i) * 0.12, st.z), _q, _s);
    }
    mesh.setMatrixAt(i, _m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  bodyPrev.copy(bodyNow);
}

// ---------- HUD ----------
function updateHud() {
  $('stars').textContent = `${game.stars} / ${course.stars.length}`;
  $('speed').textContent = Math.round(rider.speed() * 3.6);
  $('elev').textContent = Math.round(rider.p.y + terrain.base);
  $('clock').textContent = fmtTime(game.time);
  const left = Math.max(0, course.route.length - course.route.s[game.routeIndex]);
  $('togo').textContent = left > 1000 ? `${(left / 1000).toFixed(1)} km` : `${Math.round(left)} m`;
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
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const t = now / 1000;
  if (game.state === 'playing' || game.state === 'finished') {
    acc += dt;
    const input = readInput();
    let n = 0;
    while (acc >= STEP && n++ < 10) {
      rider.step(STEP, input);
      rider.checkTrees(course);
      acc -= STEP;
    }
    if (game.state === 'playing') {
      game.time += dt;
      const near = course.route.nearest(rider.p.x, rider.p.z, game.routeIndex);
      game.routeIndex = near.index;
      if (near.s > course.route.length - 30 && near.distance < 60) finish();
    }
    handleEvents();
    if (rider.contact && rider.carve > 0.15 && rider.crashed <= 0) spray.emit(rider.p, rider.v, rider.carve, dt);
    sound.update(rider.speed(), rider.carve, rider.contact);
  }
  spray.update(dt);
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
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, map: snowTexture() });
  scene.add(terrain.buildMesh(snowColor, mat));
  course = buildCourse(terrain, scene);
  rider = new Rider(terrain, scene);
  spray = new Spray();
  restart();
  game.state = 'intro';
  $('loading').hidden = true;
  $('drop').disabled = false;
  $('drop').addEventListener('click', begin);
  $('again').addEventListener('click', () => { restart(); begin(); });
  $('restart').addEventListener('click', () => { restart(); });
  requestAnimationFrame(frame);
  // Handy for tuning from the browser console.
  window.game = { game, rider, course, terrain, camera, snapCamera };
}
init();
