/**
 * A notice halo around a *small* leftover (paddle, canoe, cairn, tin,
 * rope, tree-note, bike, …).
 *
 * Split: the burned-out start camp keeps its dirt pad as the cue —
 * that reads as their leftover pitch, not as player camp-placement UI.
 * Small crumbs do not get a dirt disc; this is how you know they are
 * an AOI.
 *
 * It has to read in tall autumn grass. A flat ribbon on the dirt is
 * the grass's colour and is gone. The cue is a short ice-white wall
 * that stands above the blades, with a brighter ring at the foot and
 * a few soft shafts — the found-spot silhouette, not a sci-fi pad.
 * Close only: a drive-by still does not see it. No pin, compass POI,
 * `!`, or pulse.
 *
 * Colour is cream-white over a cool ice, not neon cyan. Additive HDR
 * (ONE, ONE, energy in rgb — same as the camp fire) so gold meadow
 * lightens toward ice instead of the ribbon crushing into a dirt line.
 * A depth-test-off ghost keeps the wall visible where grass wins the
 * z-buffer.
 */
import * as THREE from 'three';

const SEGS = 64;
const RIBBON = 0.20;
const LIFT = 0.05;
/** Tall enough to clear meadow grass and peek through shoreline reeds. */
const WALL_H = 1.22;
const MOTES = 20;
/** Soft ice — periwinkle of the game's own cool shadows, not a LED cyan. */
const ICE = new THREE.Color(0xb9d4ea);
const HOT = new THREE.Color(0xeef4fb);

/** Full notice once the player is this close. */
export const HALO_NEAR = 8;
/** Start fading in. A drive-by past this does not see it. */
export const HALO_FAR = 16;

const ADD = {
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendEquation: THREE.AddEquation,
};

const RING_VERT = /* glsl */`
  attribute float along;
  varying float vAlong;
  void main() {
    vAlong = along;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RING_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uOpacity;
  varying float vAlong;
  void main() {
    float across = 1.0 - smoothstep(0.10, 1.0, abs(vAlong));
    across = pow(across, 1.25);
    float a = across * uOpacity;
    if (a < 0.004) discard;
    vec3 col = mix(uColor, uHot, across);
    gl_FragColor = vec4(col * a, 1.0);
  }
`;

const WALL_VERT = /* glsl */`
  attribute float along;
  attribute float angle;
  varying float vH;
  varying float vAngle;
  void main() {
    vH = along;
    vAngle = angle;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const WALL_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uOpacity;
  varying float vH;
  varying float vAngle;
  void main() {
    // Body falls off fast so the foot reads as a ring. Shafts keep a
    // little height — four soft columns, not hard beams.
    float body = pow(1.0 - vH, 1.55);
    float pillar = pow(abs(sin(vAngle * 2.0 + 0.4)), 4.8);
    float shaft = pillar * pow(1.0 - vH, 0.48);
    float a = (body * 0.82 + shaft * 0.95) * uOpacity;
    if (a < 0.004) discard;
    vec3 col = mix(uColor, uHot, pillar * (1.0 - vH * 0.55));
    gl_FragColor = vec4(col * a, 1.0);
  }
`;

const MOTE_VERT = /* glsl */`
  attribute float seed;
  attribute float radius;
  attribute float spin;
  uniform float uTime;
  uniform float uHeight;
  varying float vFade;
  void main() {
    float life = fract(seed + uTime * 0.055);
    float y = life * uHeight;
    vFade = sin(life * 3.14159);
    vec3 p = position;
    float a = spin + uTime * 0.18 * (0.4 + seed);
    p.x += cos(a) * radius * 0.08;
    p.z += sin(a) * radius * 0.08;
    p.y += y;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float dist = max(0.8, -mv.z);
    gl_PointSize = (3.2 + 3.8 * vFade) * (160.0 / dist);
  }
`;

const MOTE_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform vec3 uHot;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float spot = 1.0 - smoothstep(0.12, 0.5, d);
    float a = spot * vFade * uOpacity;
    if (a < 0.004) discard;
    vec3 col = mix(uColor, uHot, vFade);
    gl_FragColor = vec4(col * a, 1.0);
  }
`;

/**
 * One leftover's notice ring. `radius` is metres from the leftover's
 * centre to the ribbon midline — big enough to read as "this patch"
 * without swallowing the next tree.
 */
export function buildNoticeHalo(world, x, z, radius) {
  const y = (world.getHeight?.(x, z) ?? 0) + LIFT;
  const ringGeo = _ribbon(world, x, y, z, radius);
  const wallGeo = _wall(world, x, z, radius);
  const moteGeo = _motes(x, y, z, radius);

  const uColor = { value: ICE.clone() };
  const uHot = { value: HOT.clone() };
  const uTime = { value: 0 };

  const ringVis = _addMat(RING_VERT, RING_FRAG, { uColor, uHot, uOpacity: { value: 0 } }, {
    side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const ringHid = _ghost(ringVis);
  const wallVis = _addMat(WALL_VERT, WALL_FRAG, { uColor, uHot, uOpacity: { value: 0 } }, {
    side: THREE.DoubleSide,
  });
  const wallHid = _ghost(wallVis);
  const moteVis = _addMat(MOTE_VERT, MOTE_FRAG, {
    uColor, uHot, uTime, uHeight: { value: WALL_H * 0.92 }, uOpacity: { value: 0 },
  });

  const ring = new THREE.Mesh(ringGeo, ringVis);
  ring.frustumCulled = false;
  ring.renderOrder = 4;
  ring.name = 'trace-halo';
  const ringGhost = new THREE.Mesh(ringGeo, ringHid);
  ringGhost.frustumCulled = false;
  ringGhost.renderOrder = 3;
  ringGhost.name = 'trace-halo-ghost';

  const wall = new THREE.Mesh(wallGeo, wallVis);
  wall.frustumCulled = false;
  wall.renderOrder = 5;
  wall.name = 'trace-halo-wall';
  const wallGhost = new THREE.Mesh(wallGeo, wallHid);
  wallGhost.frustumCulled = false;
  wallGhost.renderOrder = 3;
  wallGhost.name = 'trace-halo-wall-ghost';

  const motes = new THREE.Points(moteGeo, moteVis);
  motes.frustumCulled = false;
  motes.renderOrder = 6;
  motes.name = 'trace-halo-motes';

  const group = new THREE.Group();
  group.add(ring, ringGhost, wall, wallGhost, motes);
  group.userData.notice = {
    vis: ringVis, hid: ringHid,
    wallVis, wallHid, moteVis,
    ringGeo, wallGeo, moteGeo,
    uTime, x, z, radius,
  };
  return group;
}

/**
 * Fade the halo for this frame. `dist` is player-to-centre xz metres;
 * `onScreen` is 0..1 (1 = roughly in view). `gain` > 1 is for crumbs of
 * the *current* beat — a slightly longer close falloff and a brighter
 * peak, still metres, not a drive-by billboard. Returns the applied
 * visible opacity so a caller can skip work if it wants.
 */
export function updateNoticeHalo(group, dist, onScreen, elapsed, gain = 1) {
  const n = group.userData.notice;
  if (!n) return 0;
  const far = HALO_FAR + (gain > 1 ? 7 : 0);
  const near = 1 - THREE.MathUtils.smoothstep(dist, HALO_NEAR, far);
  // A 9 s breathe, 5 % of peak — not a pulse.
  const breath = 0.95 + 0.05 * (0.5 + 0.5 * Math.sin((elapsed ?? 0) * Math.PI * 2 / 9));
  const a = near * onScreen * breath * gain;
  n.vis.uniforms.uOpacity.value = a * 0.62;
  n.hid.uniforms.uOpacity.value = a * 0.22;
  n.wallVis.uniforms.uOpacity.value = a * 0.48;
  // Through-grass veil: stronger than the ring ghost, still quieter than
  // the depth-tested wall so it does not x-ray the camper.
  n.wallHid.uniforms.uOpacity.value = a * 0.28;
  n.moteVis.uniforms.uOpacity.value = a * 0.40;
  n.uTime.value = elapsed ?? 0;
  return a;
}

export function disposeNoticeHalo(group) {
  const n = group.userData.notice;
  if (!n) return;
  n.ringGeo.dispose();
  n.wallGeo.dispose();
  n.moteGeo.dispose();
  n.vis.dispose();
  n.hid.dispose();
  n.wallVis.dispose();
  n.wallHid.dispose();
  n.moteVis.dispose();
}

function _addMat(vert, frag, uniforms, extra = {}) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    ...ADD,
    ...extra,
  });
}

function _ghost(src) {
  const hid = src.clone();
  hid.depthTest = false;
  hid.uniforms = { ...src.uniforms, uOpacity: { value: 0 } };
  return hid;
}

function _wobble(t, radius) {
  return 1 + 0.035 * Math.sin(t * 3 + radius * 4.1)
    + 0.02 * Math.sin(t * 7 + 1.7);
}

function _ribbon(world, cx, cy, cz, radius) {
  const pos = [];
  const along = [];
  const idx = [];
  for (let i = 0; i <= SEGS; i++) {
    const t = (i / SEGS) * Math.PI * 2;
    const r = radius * _wobble(t, radius);
    const x = cx + Math.cos(t) * r;
    const z = cz + Math.sin(t) * r;
    const y = (world.getHeight?.(x, z) ?? cy) + LIFT;
    const tx = -Math.sin(t);
    const tz = Math.cos(t);
    pos.push(
      x + tx * RIBBON, y, z + tz * RIBBON,
      x - tx * RIBBON, y, z - tz * RIBBON,
    );
    along.push(1, -1);
    if (i < SEGS) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('along', new THREE.Float32BufferAttribute(along, 1));
  geo.setIndex(idx);
  return geo;
}

function _wall(world, cx, cz, radius) {
  const pos = [];
  const along = [];
  const angle = [];
  const idx = [];
  for (let i = 0; i <= SEGS; i++) {
    const t = (i / SEGS) * Math.PI * 2;
    const r = radius * _wobble(t, radius);
    const x = cx + Math.cos(t) * r;
    const z = cz + Math.sin(t) * r;
    const y0 = (world.getHeight?.(x, z) ?? 0) + LIFT;
    pos.push(x, y0, z, x, y0 + WALL_H, z);
    along.push(0, 1);
    angle.push(t, t);
    if (i < SEGS) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('along', new THREE.Float32BufferAttribute(along, 1));
  geo.setAttribute('angle', new THREE.Float32BufferAttribute(angle, 1));
  geo.setIndex(idx);
  return geo;
}

function _motes(cx, cy, cz, radius) {
  const pos = [];
  const seed = [];
  const rad = [];
  const spin = [];
  for (let i = 0; i < MOTES; i++) {
    const t = (i / MOTES) * Math.PI * 2 + 0.37;
    const u = ((i * 17) % MOTES) / MOTES;
    const r = radius * (0.18 + 0.62 * u * u);
    pos.push(cx + Math.cos(t) * r, cy, cz + Math.sin(t) * r);
    seed.push((i * 0.173 + 0.11) % 1);
    rad.push(r);
    spin.push(t);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('seed', new THREE.Float32BufferAttribute(seed, 1));
  geo.setAttribute('radius', new THREE.Float32BufferAttribute(rad, 1));
  geo.setAttribute('spin', new THREE.Float32BufferAttribute(spin, 1));
  return geo;
}
