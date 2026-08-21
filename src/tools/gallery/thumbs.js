// ─────────────────────────────────────────────────────────────────────────────
//  Object Gallery — card thumbnails.
//
//  Every card gets a real render of the real object. Not a screenshot pasted
//  into the repo, which would go stale the first time somebody edits a form,
//  and not a second WebGL context, which would upload every geometry twice.
//
//  Instead: one renderer, one extra scene, and the thumbnail is drawn into a
//  corner of the SAME canvas the stage uses, then copied out with drawImage
//  before the browser composites the frame. Because it is the same renderer, a
//  thumbnail carries the same tone mapping, colour space and exposure as the
//  big view. A card that looks wrong is the object being wrong.
//
//  THE ORDERING IS THE WHOLE TRICK, and the first version of this file got it
//  wrong in a way worth recording. Building an object is asynchronous (a family
//  kit may still be importing), so the obvious `await build; render; copy` puts
//  the thumbnail's render in a LATER task than the frame that asked for it —
//  after the stage has already drawn, sometimes after the browser has already
//  composited. The result was a firepit sitting in the bottom-left corner of
//  the main view and a hard rectangle where the scissor had been, flickering at
//  frame rate. So the work is split: `prepare()` does the async part off the
//  frame and parks the result, and `flush()` is a SYNCHRONOUS render-and-copy
//  called at the top of the frame, immediately before the stage draws over it.
//  Nothing can land between the two.
//
//  The queue is budgeted. Building 120 objects at page load would freeze the
//  tab for several seconds; one a frame keeps the page usable while it fills
//  in, and cards that scroll into view jump the queue.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { framing } from './stage.js';

export const THUMB_W = 224;
export const THUMB_H = 168;

export class Thumbs {
  /**
   * @param stage      the Stage — its renderer and its sun are borrowed
   * @param getEntry   id -> registry entry
   * @param acquire    id -> Promise<{ root }>, the shared build cache
   */
  constructor(stage, acquire) {
    this.stage = stage;
    this.acquire = acquire;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, THUMB_W / THUMB_H, 0.02, 800);

    // The same three-part rig as the stage, at the same ratios, so a card is a
    // fair preview of what clicking it will show.
    this.key = new THREE.DirectionalLight(0xffe9c8, 2.6);
    this.hemi = new THREE.HemisphereLight(0xbcd4f0, 0xd8a35c, 0.85);
    this.fill = new THREE.DirectionalLight(0xcfe0ff, 0.35);
    this.fill.position.set(-4, 2, -3);
    this.scene.add(this.key, this.key.target, this.hemi, this.fill);

    this.holder = new THREE.Group();
    this.scene.add(this.holder);

    this.queue = [];        // ids, in the order they will be drawn
    this.urgent = [];       // ids that scrolled into view
    this.done = new Set();
    this.targets = new Map();  // id -> HTMLCanvasElement
    this.onProgress = null;
    this._total = 0;
    this._pending = null;   // { id, built } — built and waiting for a flush
    this._preparing = false;
  }

  /** Register a card's canvas and put it in the queue. */
  add(id, canvas) {
    canvas.width = THUMB_W; canvas.height = THUMB_H;
    this.targets.set(id, canvas);
    this.queue.push(id);
    this._total++;
  }

  /** Draw this one next. Called by the IntersectionObserver. */
  prioritise(id) {
    if (this.done.has(id) || this.urgent.includes(id)) return;
    this.urgent.push(id);
  }

  get remaining() { return this._total - this.done.size; }

  /**
   * Build the next thumbnail's object, off the frame. Safe to call every frame;
   * it does nothing while one is already in flight or one is waiting to be
   * drawn. See the header: this half is allowed to be asynchronous, the other
   * half is not.
   */
  prepare() {
    if (this._preparing || this._pending) return;
    const id = this._next();
    if (!id) return;
    this._preparing = true;
    this.acquire(id)
      .then((built) => { this._pending = { id, built }; })
      .catch((e) => {
        this.done.add(id);
        failCard(this.targets.get(id), e.message);
        this.onProgress?.(this.done.size, this._total);
      })
      .finally(() => { this._preparing = false; });
  }

  /**
   * Render the prepared thumbnail and copy it out. SYNCHRONOUS, and the caller
   * must render the stage immediately afterwards in the same task.
   */
  flush() {
    const job = this._pending;
    if (!job) return;
    this._pending = null;
    try { this._draw(job.id, job.built); }
    catch (e) { failCard(this.targets.get(job.id), e.message); this.done.add(job.id); }
    this.onProgress?.(this.done.size, this._total);
  }

  _next() {
    while (this.urgent.length) {
      const id = this.urgent.shift();
      if (!this.done.has(id)) return id;
    }
    while (this.queue.length) {
      const id = this.queue.shift();
      if (!this.done.has(id)) return id;
    }
    return null;
  }

  _draw(id, built) {
    const canvas = this.targets.get(id);
    if (!canvas) { this.done.add(id); return; }

    const renderer = this.stage.renderer;
    const gl = renderer.domElement;
    const dpr = renderer.getPixelRatio();

    // CSS PIXELS IN, DEVICE PIXELS OUT, and mixing them up is a bug that hides
    // completely on a dpr-1 display — which is what the capture harness runs at
    // and what a Retina laptop does not. `setViewport` and `setScissor` take
    // CSS pixels and multiply by the renderer's pixel ratio themselves, so
    // passing device pixels rendered the thumbnail at twice the size of the
    // rectangle then copied out of it: every card showed the bottom-left
    // quarter of its object, which reads as the subject sitting in the corner.
    // `cw/ch` are what the viewport is told; `dw/dh` are the device-pixel rect
    // that lands on the canvas and therefore what drawImage must read.
    const fit = Math.min(1, gl.width / dpr / THUMB_W, gl.height / dpr / THUMB_H);
    const cw = Math.max(16, Math.floor(THUMB_W * fit));
    const ch = Math.max(12, Math.floor(THUMB_H * fit));
    const dw = Math.min(gl.width, Math.round(cw * dpr));
    const dh = Math.min(gl.height, Math.round(ch * dpr));

    // Borrow the object. It goes straight back afterwards — the same instance
    // is what the stage shows on click, so nothing is built twice.
    const parent = built.root.parent;
    this.holder.add(built.root);

    const box = boundsOf(this.holder);
    const f = framing(box, this.camera.fov, cw / ch);
    const { target } = f;
    const dist = f.dist * 1.16;

    // A fixed three-quarter view. Every card taken from the same angle is what
    // makes a grid of them comparable at a glance.
    const yaw = 0.72, pitch = f.pitch;
    const cp = Math.cos(pitch);
    this.camera.position.set(
      target.x + Math.sin(yaw) * cp * dist,
      target.y + Math.sin(pitch) * dist,
      target.z + Math.cos(yaw) * cp * dist,
    );
    this.camera.lookAt(target);
    this.camera.aspect = cw / ch;
    this.camera.updateProjectionMatrix();

    this.key.position.copy(this.stage.key.position);
    this.key.color.copy(this.stage.key.color);
    this.scene.background = this.stage.scene.background;

    const prevScissor = renderer.getScissorTest();
    renderer.setScissorTest(true);
    renderer.setViewport(0, 0, cw, ch);
    renderer.setScissor(0, 0, cw, ch);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(prevScissor);
    renderer.setViewport(0, 0, gl.width / dpr, gl.height / dpr);
    renderer.setScissor(0, 0, gl.width / dpr, gl.height / dpr);

    // GL's viewport origin is bottom-left; as an image source the canvas is
    // top-left, so the strip just drawn is at the BOTTOM of it.
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, THUMB_W, THUMB_H);
    try {
      ctx.drawImage(gl, 0, gl.height - dh, dw, dh, 0, 0, THUMB_W, THUMB_H);
    } catch { /* context lost mid-draw; the card simply stays blank */ }

    this.holder.remove(built.root);
    if (parent) parent.add(built.root);

    this.done.add(id);
    canvas.classList.add('ready');
  }
}

function boundsOf(root) {
  const box = new THREE.Box3();
  let has = false;
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine) return;
    const g = o.geometry;
    if (!g) return;
    if (!g.boundingBox) g.computeBoundingBox();
    box.union(g.boundingBox.clone().applyMatrix4(o.matrixWorld));
    has = true;
  });
  if (!has) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  return box;
}

function failCard(canvas, msg) {
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(209,104,122,.14)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#d1687a';
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('build failed', canvas.width / 2, canvas.height / 2 - 6);
  ctx.fillStyle = 'rgba(255,246,234,.55)';
  ctx.fillText(String(msg).slice(0, 34), canvas.width / 2, canvas.height / 2 + 10);
  canvas.classList.add('ready');
}
