// The snowboarder: physics (how the board moves on snow and through the air)
// and the little 3D figure you see.
import * as THREE from '../vendor/three.module.min.js';

// All the feel of the game lives in these numbers. Units: metres, seconds.
export const PHYSICS = {
  gravity: 9.81,
  snowFriction: 0.035,  // gliding friction on groomed snow
  brakeFriction: 0.45,  // skidding sideways to slow down
  drag: 0.0056,         // air resistance; sets top speed (~100 km/h on a steep pitch)
  tuckDrag: 0.0036,     // crouched "tuck" for more speed
  edgeGrip: 7,          // how hard the edge stops sideways sliding (higher = sharper carve)
  carveKeep: 0.55,      // share of sideways speed turned into forward speed in a carve
  turnSlow: 2.4,        // turn rate (radians/s) at low speed
  turnFast: 1.15,       // turn rate at high speed
  push: 3,              // skating push on flats (m/s²)
  ollie: 4.2,           // basic jump pop (m/s)
  ollieCharged: 3.2,    // extra pop when the jump is held for a moment
  airSpin: 6.5,         // spin speed in the air (radians/s)
  crashImpact: 21,      // landing this hard (m/s into the slope) is a wipeout
  crashAngle: 0.45,     // land more than ~63° sideways and you wipe out
};

const UP = new THREE.Vector3(0, 1, 0);

export class Rider {
  constructor(terrain, scene) {
    this.terrain = terrain;
    this.p = new THREE.Vector3();
    this.lastSafe = new THREE.Vector3();
    this.v = new THREE.Vector3();
    this.yaw = 0;
    this.n = new THREE.Vector3(0, 1, 0);
    this.contact = true;
    this.airTime = 0;
    this.spin = 0;          // how far we've rotated in this air (radians)
    this.charge = 0;        // jump charge 0..1
    this.crashed = 0;       // seconds left in a wipeout
    this.lean = 0;
    this.crouch = 0;
    this.carve = 0;         // how much snow we're spraying
    this.events = [];       // 'land', 'crash', 'jump', 'trick' for sound & HUD
    this.model = buildModel();
    scene.add(this.model.root);
    this.shadow = new THREE.Mesh(new THREE.CircleGeometry(0.9, 20),
      new THREE.MeshBasicMaterial({ color: 0x0b1530, transparent: true, opacity: 0.32, depthWrite: false }));
    this.shadow.renderOrder = 1;
    scene.add(this.shadow);
  }

  place(x, z, dirX, dirZ, speed = 0) {
    this.p.set(x, this.terrain.groundHeight(x, z), z);
    this.yaw = Math.atan2(dirX, dirZ);
    this.v.set(dirX * speed, 0, dirZ * speed);
    this.crashed = 0;
    this.airTime = 0;
    this.contact = true;
  }

  forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  speed() { return this.v.length(); }

  step(dt, input) {
    const P = PHYSICS, T = this.terrain;
    const p = this.p, v = this.v;
    const n = T.normalAt(p.x, p.z, this.n);
    const gap = p.y - T.groundHeight(p.x, p.z);
    this.contact = gap < 0.15;
    const steer = this.crashed > 0 ? 0 : input.steer;

    v.y -= P.gravity * dt;

    if (this.crashed > 0) {
      this.crashed -= dt;
      v.multiplyScalar(Math.exp(-2.5 * dt));
      if (this.crashed <= 0) this.recover();
    } else if (this.contact) {
      // Board axes on the slope
      const f = this.forward(_f);
      const bf = _bf.copy(f).addScaledVector(n, -f.dot(n)).normalize();
      const side = _side.crossVectors(n, bf);
      const vn = v.dot(n);
      let vf = v.dot(bf), vs = v.dot(side);

      // Riding backwards? Swap ends (we're riding switch).
      if (vf < -0.8) { this.yaw += Math.PI; vf = -vf; vs = -vs; bf.negate(); side.negate(); }

      const speed = Math.hypot(vf, vs);
      const turnRate = P.turnFast + (P.turnSlow - P.turnFast) / (1 + speed / 10);
      this.yaw -= steer * turnRate * dt;

      // Edge grip: kill sideways sliding, keep part of it as forward speed.
      const grip = input.brake ? 2.2 : P.edgeGrip;
      const vs2 = vs * Math.exp(-grip * dt);
      const lost = Math.abs(vs) - Math.abs(vs2);
      vf += lost * (input.brake ? 0 : P.carveKeep);
      this.carve = Math.min(1, lost / dt / 25 + (input.brake ? speed / 20 : 0));

      // Snow friction and air drag slow you along the board.
      const normalAcc = P.gravity * Math.max(0.2, n.y);
      const mu = input.brake ? P.brakeFriction : P.snowFriction;
      const cd = input.brake ? P.drag * 3 : input.tuck && speed > 6 ? P.tuckDrag : P.drag;
      const slow = (mu * normalAcc + cd * speed * speed) * dt;
      vf = vf > 0 ? Math.max(0, vf - slow) : Math.min(0, vf + slow);

      // Push along on the flats.
      if (input.tuck && speed < 7) vf += P.push * dt;

      // Jump: hold to charge, release to pop.
      if (input.jump) this.charge = Math.min(1, this.charge + dt / 0.5);
      let pop = 0;
      if (!input.jump && this.charge > 0) {
        pop = P.ollie + P.ollieCharged * this.charge;
        this.charge = 0;
        this.events.push('jump');
      }

      v.copy(bf).multiplyScalar(vf).addScaledVector(side, vs2).addScaledVector(n, vn + pop);
      this.spin = 0;
      this.lean += ((steer * Math.min(1, speed / 12)) * 0.55 - this.lean) * Math.min(1, dt * 8);
    } else {
      // In the air: spin with left/right, keep the jump charge for landing.
      const spin = steer * P.airSpin * dt;
      this.yaw -= spin;
      this.spin += spin;
      v.multiplyScalar(1 - 0.0006 * v.length() * dt);
      this.charge = 0;
      this.lean *= 1 - Math.min(1, dt * 4);
    }

    if (gap > 0.3) this.airTime += dt;

    this.lastSafe.copy(p);
    p.addScaledVector(v, dt);

    // Keep inside the map.
    const pad = 4;
    if (p.x < pad || p.x > T.sizeX - pad) { p.x = THREE.MathUtils.clamp(p.x, pad, T.sizeX - pad); v.x = 0; }
    if (p.z < pad || p.z > T.sizeZ - pad) { p.z = THREE.MathUtils.clamp(p.z, pad, T.sizeZ - pad); v.z = 0; }

    // Touching down: stop at the surface and lose the speed going into it.
    const ground = T.groundHeight(p.x, p.z);
    if (p.y < ground) {
      const n2 = T.normalAt(p.x, p.z, _n2);
      const into = v.dot(n2);
      p.y = ground;
      if (into < 0) v.addScaledVector(n2, -into);
      if (this.airTime > 0.35) this.land(-into);
      this.airTime = 0;
    }

    const crouchTarget = this.crashed > 0 ? 0 : this.charge > 0 ? 0.35 + this.charge * 0.35
      : input.tuck ? 0.55 : input.brake ? 0.25 : this.contact ? 0.15 : 0.3;
    this.crouch += (crouchTarget - this.crouch) * Math.min(1, dt * 10);
  }

  land(impact) {
    const P = PHYSICS;
    const f = this.forward(_f);
    const h = _h.set(this.v.x, 0, this.v.z);
    const hs = h.length();
    const align = hs > 1 ? Math.abs(f.dot(h) / hs) : 1;
    const turns = Math.round(Math.abs(this.spin) / Math.PI) * 180;
    this.spin = 0;
    if (impact > P.crashImpact || align < P.crashAngle) {
      this.crash();
      return;
    }
    // Snap the board to the direction of travel (forwards or switch).
    if (hs > 1) {
      let target = Math.atan2(h.x, h.z);
      if (f.dot(h) < 0) target += Math.PI;
      this.yaw = target;
    }
    this.events.push(turns >= 180 ? { type: 'trick', spin: turns } : 'land');
  }

  crash() {
    this.crashed = 1.6;
    this.charge = 0;
    this.spin = 0;
    this.events.push('crash');
  }

  recover() {
    // Get up facing downhill.
    const n = this.terrain.normalAt(this.p.x, this.p.z);
    const dx = n.x, dz = n.z;
    if (Math.hypot(dx, dz) > 0.02) this.yaw = Math.atan2(dx, dz);
    this.v.multiplyScalar(0.2);
    this.p.y = this.terrain.groundHeight(this.p.x, this.p.z);
  }

  // Bump into trees.
  checkTrees(course) {
    // Buildings: step back out and wipe out (unless already down).
    if (course.buildings.hit(this.p.x, this.p.z, this.p.y, 0.4)) {
      this.p.copy(this.lastSafe);
      this.v.multiplyScalar(this.crashed > 0 ? 0 : 0.1);
      if (this.crashed <= 0) this.crash();
      return;
    }
    if (this.crashed > 0) return;
    for (const t of course.treesNear(this.p.x, this.p.z)) {
      const dx = this.p.x - t.x, dz = this.p.z - t.z;
      const r = 0.55 + 0.9 * t.scale;
      if (dx * dx + dz * dz < r * r && this.p.y < t.y + 9 * t.scale) {
        const d = Math.hypot(dx, dz) || 1;
        this.p.x = t.x + dx / d * r; this.p.z = t.z + dz / d * r;
        this.v.multiplyScalar(0.15);
        this.crash();
        return;
      }
    }
  }

  // Put the 3D figure where the physics says it is.
  updateModel(dt, time) {
    const m = this.model;
    const n = this.contact && this.crashed <= 0 ? this.n : UP;
    // Board tilts to the slope smoothly.
    m.up.lerp(n, Math.min(1, dt * 12)).normalize();
    const f = this.forward(_f);
    const fwd = _bf.copy(f).addScaledVector(m.up, -f.dot(m.up)).normalize();
    const side = _side.crossVectors(m.up, fwd);
    _mat.makeBasis(side, m.up, fwd);
    m.root.quaternion.setFromRotationMatrix(_mat);
    m.root.position.copy(this.p);

    m.lean.rotation.z = this.lean;
    const c = this.crouch;
    m.body.position.y = 0.95 - c * 0.45;
    m.legs.scale.y = 1 - c * 0.5;
    m.body.rotation.x = 0;
    if (this.crashed > 0) {
      m.lean.rotation.z = Math.sin(time * 9) * 1.2;
      m.lean.rotation.x = time * 7;
    } else {
      m.lean.rotation.x = 0;
    }
    m.arms.rotation.z = this.contact ? -this.lean * 0.8 : Math.sin(time * 6) * 0.3;

    const g = this.terrain.groundHeight(this.p.x, this.p.z);
    const sn = this.terrain.normalAt(this.p.x, this.p.z);
    this.shadow.position.set(this.p.x, g + 0.06, this.p.z);
    this.shadow.quaternion.setFromUnitVectors(_z.set(0, 0, 1), sn);
    const height = Math.max(0, this.p.y - g);
    this.shadow.scale.setScalar(1 / (1 + height * 0.08));
    this.shadow.material.opacity = 0.32 / (1 + height * 0.15);
  }
}

const _f = new THREE.Vector3(), _bf = new THREE.Vector3(), _side = new THREE.Vector3();
const _n2 = new THREE.Vector3(), _h = new THREE.Vector3(), _z = new THREE.Vector3();
const _mat = new THREE.Matrix4();

function buildModel() {
  const root = new THREE.Group();
  const lean = new THREE.Group();          // tilts into turns
  root.add(lean);
  const mat = c => new THREE.MeshLambertMaterial({ color: c });
  const board = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.05, 1.55), mat(0xff3b30));
  board.position.y = 0.03;
  lean.add(board);
  for (const z of [-0.78, 0.78]) {
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.05, 12, 1, false, 0, Math.PI), mat(0xff3b30));
    tip.position.set(0, 0.03, z);
    tip.rotation.y = z > 0 ? -Math.PI / 2 : Math.PI / 2;
    lean.add(tip);
  }
  // Legs (scaled when crouching)
  const legs = new THREE.Group();
  for (const z of [-0.24, 0.24]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.6, 8), mat(0x1f2a44));
    leg.position.set(0, 0.35, z);
    legs.add(leg);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.12, 0.16), mat(0x111111));
    boot.position.set(0, 0.1, z);
    legs.add(boot);
  }
  lean.add(legs);
  // Upper body faces the toe edge, like a real rider.
  const body = new THREE.Group();
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.45, 4, 10), mat(0x1e88e5));
  torso.position.y = 0.3;
  body.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), mat(0xf1c27d));
  head.position.y = 0.8;
  body.add(head);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xffd23a));
  helmet.position.y = 0.82;
  body.add(helmet);
  const goggles = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.26), mat(0x0f172a));
  goggles.position.set(-0.15, 0.82, 0);
  body.add(goggles);
  const arms = new THREE.Group();
  for (const z of [-0.3, 0.3]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.42, 4, 8), mat(0x1e88e5));
    arm.position.set(0, 0.35, z);
    arm.rotation.x = z > 0 ? -1.1 : 1.1;
    arms.add(arm);
  }
  arms.position.y = 0.05;
  body.add(arms);
  body.position.y = 0.95;
  lean.add(body);
  root.traverse(o => { o.castShadow = false; });
  return { root, lean, body, legs, arms, up: new THREE.Vector3(0, 1, 0) };
}
