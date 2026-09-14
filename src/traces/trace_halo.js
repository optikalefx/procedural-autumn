/**
 * A faint notice halo around a *small* leftover (paddle, canoe, cairn,
 * tin, rope, tree-note, bike, …).
 *
 * Split: the burned-out start camp keeps its dirt pad as the cue —
 * that reads as their leftover pitch, not as player camp-placement UI.
 * Small crumbs do not get a dirt disc; this ribbon is how you know
 * they are an AOI. Pretty faint (you have to look) and pretty close
 * (a drive-by does not see it). No pin, compass POI, `!`, or pulse.
 * Cool white-blue, not cream — a warm ribbon read as a dirt ring
 * on autumn grass.
 *
 * `gl_LineWidth` is a 1 px no-op on most browsers, so the ring is a
 * flat ribbon (camp's trick) rather than a GL line. Normal blend, not
 * additive — on gold autumn grass an add wash disappears. Do not
 * premultiply RGB by alpha here: NormalBlending already does, and
 * `uColor * a` crushed the ribbon into a dark pencil line that still
 * read as dirt.
 */
import * as THREE from 'three';

const SEGS = 56;
const RIBBON = 0.14;
const LIFT = 0.07;
/** Soft white-blue notice glow — not a cream/dirt ring. */
const COLOR = new THREE.Color(0xd4eafc);
/** Have to look at it — not a billboard. */
const PEAK = 0.20;

/** Full notice once the player is this close. */
export const HALO_NEAR = 8;
/** Start fading in. A drive-by past this does not see it. */
export const HALO_FAR = 16;

const VERT = /* glsl */`
  attribute float along;
  varying float vAlong;
  void main() {
    vAlong = along;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vAlong;
  void main() {
    // Soft across the ribbon so the ring has no hard outer edge.
    float across = 1.0 - smoothstep(0.15, 1.0, abs(vAlong));
    float a = across * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

/**
 * One leftover's notice ring. `radius` is metres from the leftover's
 * centre to the ribbon midline — big enough to read as "this patch"
 * without swallowing the next tree.
 */
export function buildNoticeHalo(world, x, z, radius) {
  const y = (world.getHeight?.(x, z) ?? 0) + LIFT;
  const { geo } = _ribbon(world, x, y, z, radius);

  const vis = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: COLOR.clone() },
      uOpacity: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, vis);
  mesh.frustumCulled = false;
  mesh.renderOrder = 4;
  mesh.name = 'trace-halo';

  // A much fainter occluded pass so grass doesn't eat the cue when
  // the player is standing in it. Camp does the same at 1/5.
  const hid = vis.clone();
  hid.depthTest = false;
  hid.uniforms = {
    uColor: vis.uniforms.uColor,
    uOpacity: { value: 0 },
  };
  const ghost = new THREE.Mesh(geo, hid);
  ghost.frustumCulled = false;
  ghost.renderOrder = 3;
  ghost.name = 'trace-halo-ghost';

  const group = new THREE.Group();
  group.add(mesh, ghost);
  group.userData.notice = { vis, hid, geo, x, z, radius };
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
  const peak = PEAK * gain;
  const near = 1 - THREE.MathUtils.smoothstep(dist, HALO_NEAR, far);
  // A 9 s breathe, 5 % of peak — not a pulse.
  const breath = 0.95 + 0.05 * (0.5 + 0.5 * Math.sin((elapsed ?? 0) * Math.PI * 2 / 9));
  const a = near * onScreen * breath * peak;
  n.vis.uniforms.uOpacity.value = a;
  n.hid.uniforms.uOpacity.value = a * 0.38;
  return a;
}

export function disposeNoticeHalo(group) {
  const n = group.userData.notice;
  if (!n) return;
  n.geo.dispose();
  n.vis.dispose();
  n.hid.dispose();
}

function _ribbon(world, cx, cy, cz, radius) {
  const pos = [];
  const nor = [];
  const along = [];
  const idx = [];
  // Tiny authored wobble so the ring isn't a perfect quest circle.
  // Same seed every leftover of the same radius — it's a drawing
  // choice, not a per-instance fingerprint.
  for (let i = 0; i <= SEGS; i++) {
    const t = (i / SEGS) * Math.PI * 2;
    const wobble = 1 + 0.035 * Math.sin(t * 3 + radius * 4.1)
      + 0.02 * Math.sin(t * 7 + 1.7);
    const r = radius * wobble;
    const x = cx + Math.cos(t) * r;
    const z = cz + Math.sin(t) * r;
    const y = (world.getHeight?.(x, z) ?? cy) + LIFT;
    const tx = -Math.sin(t);
    const tz = Math.cos(t);
    pos.push(
      x + tx * RIBBON, y, z + tz * RIBBON,
      x - tx * RIBBON, y, z - tz * RIBBON,
    );
    nor.push(0, 1, 0, 0, 1, 0);
    along.push(1, -1);
    if (i < SEGS) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('along', new THREE.Float32BufferAttribute(along, 1));
  geo.setIndex(idx);
  return { geo };
}
