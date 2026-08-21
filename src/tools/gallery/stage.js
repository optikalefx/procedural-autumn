// ─────────────────────────────────────────────────────────────────────────────
//  Object Gallery — the stage.
//
//  A studio, not the valley. The valley's look is the product of Atmosphere,
//  Stylize, PostFX, a time-of-day sun and 2 km of aerial perspective, and none
//  of that belongs in a page whose job is to let you see one object clearly.
//  What IS carried over is the light the objects were authored under: a warm
//  key, a cool sky fill and a gold bounce off the ground, at roughly the ratios
//  Lighting.js uses. A prop that reads here will read there.
//
//  Two things on this stage exist because of specific mistakes this project has
//  already made:
//
//   · THE METRE GRID. camp_table.js spends a paragraph on a folding table that
//     was authored at desk height and read instantly as a scale error next to a
//     380 mm camp chair. Scale errors are invisible in an isolated capture and
//     obvious against a ruler, so the ground is a ruler.
//
//   · THE FIGURE. 1.70 m of translucent human, toggled on. The same paragraph
//     again: the thing that catches a scale error is a frame with something
//     known in it.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { SUN_TARGETS, TIME_TARGETS } from './registry.js';
import { clamp } from '../../core/MathUtils.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

/** Backdrops. Value matters more than hue when you are judging a silhouette. */
export const BACKDROPS = [
  { key: 'studio', label: 'Studio', color: 0x241a2b, ground: 0x2e2335 },
  { key: 'meadow', label: 'Meadow', color: 0xf0ad46, ground: 0xd8952f },
  { key: 'sky', label: 'Sky', color: 0x8fb6d8, ground: 0x7d9fbe },
  { key: 'value', label: 'Mid grey', color: 0x777777, ground: 0x6b6b6b },
];

/**
 * Where to put a camera to see the whole of a box.
 *
 * Two things this gets right that the obvious version does not:
 *
 *  · The radius is measured from the point the camera will LOOK AT, not from
 *    the box's centre. The subject is framed on its lower-middle (a tree framed
 *    on its centroid puts the trunk base off the bottom of the picture), and
 *    sizing the shot from a different point than you aim it at is how the top
 *    of a chair back ends up outside the frame.
 *  · The binding field of view is the smaller of the vertical and horizontal
 *    one, so a tall object in a wide viewport is fitted by height and a wide
 *    object in a narrow one is fitted by width.
 */
export function framing(box, fovDeg, aspect = 1) {
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const target = new THREE.Vector3(centre.x, box.min.y + size.y * 0.45, centre.z);

  let radius = 0.05;
  const c = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    c.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    radius = Math.max(radius, c.distanceTo(target));
  }

  const vFov = (fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const dist = radius / Math.sin(Math.min(vFov, hFov) / 2);
  // Look down on a squat object, level at a tall one.
  const pitch = size.y > radius * 1.4 ? 0.14 : 0.34;
  return { size, centre, target, radius, dist, pitch };
}

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = C(BACKDROPS[0].color);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.02, 800);

    // ── light ────────────────────────────────────────────────────────────────
    // Key, sky fill, ground bounce. The hemisphere pair is the same idea as
    // Lighting.js's ambient: a cool sky above and a warm gold bounce below, so
    // an unlit face is never a dead grey.
    this.key = new THREE.DirectionalLight(0xffe9c8, 2.6);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0006;
    this.key.shadow.normalBias = 0.02;
    this.scene.add(this.key, this.key.target);

    this.hemi = new THREE.HemisphereLight(0xbcd4f0, 0xd8a35c, 0.85);
    this.scene.add(this.hemi);

    // A dim opposite-side fill so a turntable never swings a face into pure
    // ambient. Deliberately weak — two keys flatten form, which is the one
    // thing a form gallery must not do.
    this.fill = new THREE.DirectionalLight(0xcfe0ff, 0.35);
    this.fill.position.set(-4, 2, -3);
    this.scene.add(this.fill);

    // ── ground, grid, figure ────────────────────────────────────────────────
    this.groundMat = new THREE.MeshStandardMaterial({ color: C(BACKDROPS[0].ground), roughness: 1.0, metalness: 0 });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), this.groundMat);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(40, 40, 0xf3b077, 0xffffff);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.16;
    this.grid.position.y = 0.001;
    this.scene.add(this.grid);

    this.figure = makeFigure();
    this.figure.visible = false;
    this.scene.add(this.figure);

    // The subject lives under a holder the page swaps contents on.
    this.holder = new THREE.Group();
    this.scene.add(this.holder);

    // ── orbit state ─────────────────────────────────────────────────────────
    this.target = new THREE.Vector3();
    this.yaw = 0.75; this.pitch = 0.28; this.dist = 5;
    this.minDist = 0.1; this.maxDist = 200;
    this.turntable = true;
    this.sunAz = 0.9; this.sunEl = 0.62;
    this._t = 0;

    this._bindInput();
    this.setSun(this.sunAz, this.sunEl);
  }

  // ── input ──────────────────────────────────────────────────────────────────
  _bindInput() {
    const el = this.canvas;
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
      this.turntable = false;
      this.onTurntable?.(false);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) {
        // Pan in the camera's own plane, scaled by distance so the subject
        // tracks the cursor at any zoom.
        const k = this.dist * 0.0016;
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
        this.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      } else {
        this.yaw -= dx * 0.006;
        this.pitch = clamp(this.pitch + dy * 0.006, -1.45, 1.45);
      }
    });
    const end = (e) => { if (drag) { el.releasePointerCapture?.(e.pointerId); drag = null; } };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = clamp(this.dist * Math.exp(e.deltaY * 0.0012), this.minDist, this.maxDist);
    }, { passive: false });
  }

  // ── what is on the stage ───────────────────────────────────────────────────

  /** Put an object on the turntable and frame it. Returns its measurements. */
  show(root) {
    this.holder.clear();
    if (root) this.holder.add(root);
    return this.frame();
  }

  /** Fit the camera to the subject's bounds. */
  frame() {
    const box = new THREE.Box3();
    let has = false;
    this.holder.traverse((o) => {
      if (!o.isMesh && !o.isPoints && !o.isLine) return;
      const g = o.geometry;
      if (!g) return;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox.clone().applyMatrix4(o.matrixWorld);
      box.union(b); has = true;
    });
    if (!has) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));

    const f = framing(box, this.camera.fov, this.camera.aspect || 1);
    const { size, centre, radius } = f;
    this.target.copy(f.target);
    this.dist = f.dist * 1.12;
    this.minDist = radius * 0.12;
    this.maxDist = radius * 24;
    this.pitch = f.pitch;

    // The ruler adapts: 1 m squares for a chair, 5 m for a tree.
    const span = Math.max(size.x, size.z, size.y);
    const step = span > 24 ? 5 : span > 8 ? 2 : span > 2.5 ? 1 : 0.5;
    this._setGrid(step, Math.max(8, Math.ceil(span * 2.4 / step) * step));

    // Stand the figure clear of the subject on the -X side. Which side is not
    // arbitrary: the default camera looks in from +X/+Z, so a figure placed at
    // +X stands between the lens and the prop, and a half-transparent card in
    // front of a tent reads as a ghost lying over it rather than as a person
    // standing beside it. On the far side it is simply occluded when the
    // turntable swings the subject in front of it, which is correct.
    this.figure.position.set(box.min.x - Math.max(0.5, size.x * 0.24), 0, centre.z);

    return { box, size, centre, radius };
  }

  _setGrid(step, extent) {
    if (this._gridStep === step && this._gridExtent === extent) return;
    this._gridStep = step; this._gridExtent = extent;
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    this.grid = new THREE.GridHelper(extent, Math.round(extent / step), 0xf3b077, 0xffffff);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.16;
    this.grid.position.y = 0.001;
    this.grid.visible = this._gridVisible !== false;
    this.scene.add(this.grid);
  }

  // ── controls the page drives ───────────────────────────────────────────────

  setBackdrop(key) {
    const b = BACKDROPS.find((x) => x.key === key) ?? BACKDROPS[0];
    this.scene.background = C(b.color);
    this.groundMat.color = C(b.ground);
  }

  setGridVisible(v) { this._gridVisible = v; this.grid.visible = v; this.ground.visible = v; }
  setFigureVisible(v) { this.figure.visible = v; }

  setWireframe(v) {
    this._wire = v;
    this.holder.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m) m.wireframe = v;
    });
  }

  /**
   * Sun by azimuth and elevation, in radians. Drives the real key light AND
   * every custom uniform block the registry's adapters put on SUN_TARGETS, so
   * a standard-material chair and a shader-lit tree agree about where the sun
   * is — which is the whole point of having them on one stage.
   */
  setSun(az, el) {
    this.sunAz = az; this.sunEl = el;
    const dir = new THREE.Vector3(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    ).normalize();
    this.key.position.copy(dir).multiplyScalar(60);
    this.key.target.position.set(0, 0, 0);
    // Low sun goes warm, the way the valley's does.
    const warmth = 1 - Math.min(1, Math.max(0, el / 0.9));
    const col = new THREE.Color().setRGB(1, 0.92 - warmth * 0.14, 0.80 - warmth * 0.28);
    this.key.color.copy(col);
    for (const set of SUN_TARGETS) { try { set(dir, col); } catch { /* a family without a sun */ } }
  }

  setExposure(v) { this.renderer.toneMappingExposure = v; }

  // ── the loop ───────────────────────────────────────────────────────────────

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width === w * this.renderer.getPixelRatio() && this.camera.aspect === w / h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(dt) {
    this._t += dt;
    if (this.turntable) this.yaw += dt * 0.35;

    for (const u of TIME_TARGETS) if (u.uTime) u.uTime.value = this._t;

    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    this.camera.lookAt(this.target);

    // Keep the shadow camera tight on the subject, or a 0.4 m cooler gets four
    // texels of shadow map out of a frustum sized for a spruce.
    const r = Math.max(1.2, this.dist * 0.55);
    const s = this.key.shadow.camera;
    s.left = -r; s.right = r; s.top = r; s.bottom = -r;
    s.near = 1; s.far = 200;
    s.updateProjectionMatrix();

    this.resize();
    this.renderer.render(this.scene, this.camera);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The 1.70 m figure
// ─────────────────────────────────────────────────────────────────────────────
//
// Two crossed cards rather than a model: it has to read from any angle on the
// turntable and it must never be mistaken for one of the props. Flat, unlit,
// half-transparent, and drawn from an outline rather than a photo.

function makeFigure() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff';
  const H = 256, u = H / 1.70;                // pixels per metre

  const blob = (x, y, w, h) => {              // x,y,w,h in metres, y from feet
    g.beginPath();
    g.ellipse(64 + x * u, H - y * u, (w * 0.5) * u, (h * 0.5) * u, 0, 0, Math.PI * 2);
    g.fill();
  };
  blob(0, 1.60, 0.19, 0.23);                  // head
  blob(0, 1.32, 0.15, 0.14);                  // neck/shoulders knot
  g.fillRect(64 - 0.21 * u, H - 1.42 * u, 0.42 * u, 0.52 * u);   // torso
  g.fillRect(64 - 0.30 * u, H - 1.38 * u, 0.10 * u, 0.56 * u);   // arms
  g.fillRect(64 + 0.20 * u, H - 1.38 * u, 0.10 * u, 0.56 * u);
  g.fillRect(64 - 0.19 * u, H - 0.90 * u, 0.16 * u, 0.90 * u);   // legs
  g.fillRect(64 + 0.03 * u, H - 0.90 * u, 0.16 * u, 0.90 * u);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0.30, depthWrite: false,
    side: THREE.DoubleSide, color: 0x101018,
  });
  const geo = new THREE.PlaneGeometry(0.85, 1.70);
  geo.translate(0, 0.85, 0);
  const a = new THREE.Mesh(geo, mat);
  const b = new THREE.Mesh(geo, mat);
  b.rotation.y = Math.PI / 2;
  const grp = new THREE.Group();
  grp.name = 'scale_figure_1m70';
  grp.add(a, b);
  return grp;
}
