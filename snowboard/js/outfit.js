// What the rider wears and rides. Choices are saved on this device.
import * as THREE from '../vendor/three.module.min.js';

export const COLORS = {
  jacket: { 'Glacier blue': 0x1e88e5, 'Signal red': 0xe53935, 'Avalanche orange': 0xfb8c00, 'Lime': 0x8bc34a,
    'Forest': 0x2e7d32, 'Purple': 0x7e57c2, 'Black': 0x212121, 'White': 0xeeeeee },
  pants: { 'Navy': 0x1f2a44, 'Black': 0x1b1b1b, 'Charcoal': 0x455a64, 'Tan': 0xa1887f, 'Olive': 0x556b2f, 'Red': 0xb71c1c },
  head: { 'Yellow': 0xffd23a, 'White': 0xf5f5f5, 'Black': 0x222222, 'Red': 0xd32f2f, 'Teal': 0x00897b, 'Pink': 0xec407a },
  lens: { 'Smoke': 0x0f172a, 'Gold mirror': 0xd4a017, 'Blue mirror': 0x1565c0, 'Rose': 0xd81b60, 'Green mirror': 0x2e7d32 },
  board: { 'Red': 0xff3b30, 'Black': 0x1b1b1b, 'White': 0xf2f2f2, 'Teal': 0x00acc1, 'Yellow': 0xffc531, 'Wood': 0xb07a4a },
  accent: { 'White': 0xffffff, 'Black': 0x111111, 'Orange': 0xff7a00, 'Blue': 0x1e88e5, 'Pink': 0xff4fa3, 'Green': 0x43a047 },
};

// Each board changes the feel a little. 1 = the all-mountain baseline.
//   turn: how quickly it turns   grip: how hard the edge holds in a carve
//   spin: spin speed in the air  drag: air drag (lower = faster)   pop: ollie height
export const BOARDS = {
  allmountain: {
    name: 'All-mountain', blurb: 'Does everything evenly. A good first board.',
    length: 1.55, width: 0.30, shape: 'twin',
    stats: { turn: 1, grip: 1, spin: 1, drag: 1, pop: 1 },
  },
  park: {
    name: 'Park twin', blurb: 'Short and soft: quick turns, faster spins, more pop. Lets go sooner in hard carves.',
    length: 1.45, width: 0.29, shape: 'twin',
    stats: { turn: 1.15, grip: 0.85, spin: 1.3, drag: 1.04, pop: 1.15 },
  },
  powder: {
    name: 'Powder swallowtail', blurb: 'Long, pointed nose and a split tail: a bit faster and steadier, slower to spin.',
    length: 1.62, width: 0.31, shape: 'swallow',
    stats: { turn: 0.9, grip: 1.05, spin: 0.85, drag: 0.93, pop: 0.95 },
  },
  carving: {
    name: 'Carving board', blurb: 'Narrow and stiff, like alpine racers ride: grips like a rail, not for tricks.',
    length: 1.65, width: 0.24, shape: 'carve',
    stats: { turn: 0.95, grip: 1.4, spin: 0.75, drag: 0.95, pop: 0.9 },
  },
};

export const DEFAULT_OUTFIT = {
  jacket: 'Glacier blue', pants: 'Navy', headwear: 'helmet', head: 'Yellow', lens: 'Smoke',
  pack: false, board: 'allmountain', boardColor: 'Red', accent: 'White', stance: 'regular',
};

const KEY = 'peakrush.outfit';
export function loadOutfit() {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) || '{}');
    const out = { ...DEFAULT_OUTFIT, ...o };
    if (!BOARDS[out.board]) out.board = DEFAULT_OUTFIT.board;
    return out;
  } catch { return { ...DEFAULT_OUTFIT }; }
}
export function saveOutfit(o) {
  try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* private mode: fine */ }
}

// The board's outline seen from above: x across, y along (nose at +y).
function boardShape(type, w, L) {
  const s = new THREE.Shape();
  const tip = 0.16;
  if (type === 'swallow') {
    s.moveTo(-w, -L + tip);
    s.quadraticCurveTo(-w * 0.9, 0, -w, L - tip * 1.6);
    s.quadraticCurveTo(-w * 0.9, L, 0, L + 0.05);            // pointed nose
    s.quadraticCurveTo(w * 0.9, L, w, L - tip * 1.6);
    s.quadraticCurveTo(w * 0.9, 0, w, -L + tip);
    s.quadraticCurveTo(w, -L, w * 0.45, -L);
    s.lineTo(0, -L + 0.2);                                   // swallowtail notch
    s.lineTo(-w * 0.45, -L);
    s.quadraticCurveTo(-w, -L, -w, -L + tip);
  } else if (type === 'carve') {
    s.moveTo(-w, -L + 0.06);
    s.quadraticCurveTo(-w * 0.94, 0, -w, L - tip);
    s.quadraticCurveTo(-w, L, 0, L);
    s.quadraticCurveTo(w, L, w, L - tip);
    s.quadraticCurveTo(w * 0.94, 0, w, -L + 0.06);
    s.lineTo(-w, -L + 0.06);                                 // square race tail
  } else {
    s.moveTo(-w, -L + tip);
    s.quadraticCurveTo(-w * 0.88, 0, -w, L - tip);          // sidecut
    s.quadraticCurveTo(-w, L, 0, L);
    s.quadraticCurveTo(w, L, w, L - tip);
    s.quadraticCurveTo(w * 0.88, 0, w, -L + tip);
    s.quadraticCurveTo(w, -L, 0, -L);
    s.quadraticCurveTo(-w, -L, -w, -L + tip);
  }
  return s;
}

function flatPiece(shape, depth, y) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 8 });
  g.rotateX(Math.PI / 2);         // lie flat: shape's y becomes the board's length (z)
  g.translate(0, y + depth, 0);
  return g;
}

export function buildRiderModel(o) {
  const root = new THREE.Group();
  const lean = new THREE.Group();          // tilts into turns
  root.add(lean);
  const mat = c => new THREE.MeshLambertMaterial({ color: c });
  const C = (group, name) => COLORS[group][name] ?? Object.values(COLORS[group])[0];

  // Board, with a two-tone top sheet
  const b = BOARDS[o.board];
  const w = b.width / 2, L = b.length / 2;
  lean.add(new THREE.Mesh(flatPiece(boardShape(b.shape, w, L), 0.035, 0.0),
    [mat(C('board', o.boardColor)), mat(0x2a2a2a)]));
  const deco = new THREE.Shape();
  deco.moveTo(-w * 0.35, -L * 0.62); deco.lineTo(w * 0.35, -L * 0.62);
  deco.lineTo(w * 0.35, L * 0.62); deco.lineTo(-w * 0.35, L * 0.62); deco.closePath();
  lean.add(new THREE.Mesh(flatPiece(deco, 0.004, 0.035), mat(C('accent', o.accent))));
  // Bindings
  for (const z of [-0.24, 0.24]) {
    const bind = new THREE.Mesh(new THREE.BoxGeometry(b.width * 0.95, 0.05, 0.2), mat(0x1a1a1a));
    bind.position.set(0, 0.06, z);
    bind.rotation.y = z > 0 ? 0.25 : -0.15;
    lean.add(bind);
  }

  // Legs (scaled when crouching)
  const legs = new THREE.Group();
  const pants = mat(C('pants', o.pants));
  for (const z of [-0.24, 0.24]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.6, 8), pants);
    leg.position.set(0, 0.38, z);
    legs.add(leg);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.12, 0.16), mat(0x111111));
    boot.position.set(0, 0.13, z);
    legs.add(boot);
  }
  lean.add(legs);

  // Upper body faces the toe edge, like a real rider. Regular = left foot forward.
  const body = new THREE.Group();
  const jacket = mat(C('jacket', o.jacket));
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.45, 4, 10), jacket);
  torso.position.y = 0.3;
  body.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 14, 10), mat(0xf1c27d));
  head.position.y = 0.8;
  body.add(head);
  const headColor = mat(C('head', o.head));
  if (o.headwear === 'beanie') {
    const hat = new THREE.Mesh(new THREE.SphereGeometry(0.185, 14, 10, 0, Math.PI * 2, 0, Math.PI / 1.9), headColor);
    hat.position.y = 0.83; hat.scale.y = 1.15;
    body.add(hat);
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.06, 14), headColor);
    cuff.position.y = 0.84;
    body.add(cuff);
    const pom = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), mat(0xffffff));
    pom.position.y = 1.06;
    body.add(pom);
  } else {
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.195, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), headColor);
    helmet.position.y = 0.82;
    body.add(helmet);
  }
  const strap = new THREE.Mesh(new THREE.CylinderGeometry(0.182, 0.182, 0.05, 14, 1, true), mat(0x111111));
  strap.position.y = 0.8;
  body.add(strap);
  const goggles = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.09, 0.27), new THREE.MeshLambertMaterial({
    color: C('lens', o.lens), emissive: C('lens', o.lens), emissiveIntensity: 0.25 }));
  goggles.position.set(-0.16, 0.81, 0);
  body.add(goggles);
  if (o.pack) {
    // Avalanche airbag pack, with the red trigger handle on the shoulder strap.
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.42, 0.3), mat(0xd84315));
    pack.position.set(0.23, 0.36, 0);
    body.add(pack);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.05), mat(0xff1744));
    handle.position.set(-0.17, 0.48, 0.12);
    body.add(handle);
  }
  const arms = new THREE.Group();
  for (const z of [-0.3, 0.3]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.42, 4, 8), jacket);
    arm.position.set(0, 0.35, z);
    arm.rotation.x = z > 0 ? -1.1 : 1.1;
    arms.add(arm);
    const glove = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), mat(0x1a1a1a));
    glove.position.set(0, 0.22, Math.sign(z) * 0.56); // at the hand end of the arm
    arms.add(glove);
  }
  arms.position.y = 0.05;
  body.add(arms);
  body.position.y = 0.95;
  // Goofy riders lead with the right foot, so they face the other edge.
  if (o.stance === 'goofy') body.rotation.y = Math.PI;
  lean.add(body);
  return { root, lean, body, legs, arms, up: new THREE.Vector3(0, 1, 0) };
}
