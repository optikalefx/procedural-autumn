// Renderer, scene graph root, camera, resize handling and the frame loop.
import * as THREE from 'three';
import { QUALITY_PRESETS } from '../world/WorldConfig.js';

export class Engine {
  constructor(canvas, quality = 'ultra') {
    this.canvas = canvas;
    this.quality = QUALITY_PRESETS[quality] ? quality : 'high';
    this.preset = QUALITY_PRESETS[this.quality];

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,           // handled by SMAA/TAA in the post chain
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
      logarithmicDepthBuffer: false,
    });
    // ── adaptive resolution ────────────────────────────────────────────────
    // The renderer draws `min(devicePixelRatio, cap)` device pixels per CSS
    // pixel, and the post chain is fixed cost per pixel. A display difference
    // the harness never simulated was therefore worth 3x the frame time. Rather
    // than pick one number and hope, measure and hold a target.
    this.basePixelRatio = Math.min(window.devicePixelRatio, this.preset.pixelRatioCap);
    this.resolutionScale = 1;
    this.targetFrameMs = 1000 / 60;
    this.minResolutionScale = 0.55;   // below this it reads as soft, not fast
    this.adaptive = true;
    this._frameTimes = [];
    this._lastAdapt = 0;

    this.renderer.setPixelRatio(this.basePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Tone mapping happens in the post chain (after bloom, before the grade),
    // not here — see PostFX. Leaving it on would tone map into the HDR buffer
    // and bloom would then work on already-compressed values.
    this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.toneMappingExposure = 1.0;
    // Scene exposure, applied by the tone mapping effect in the post chain.
    // Measured target: the reference plates sit at ~0.56 mean luminance with a
    // 0.16–0.87 range.
    this.exposure = 1.28;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.25, 6000);
    this.camera.position.set(0, 40, 60);

    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.frame = 0;
    this._updaters = [];
    this._lateUpdaters = [];
    this._resizeCbs = [];
    this._qualityCbs = [];
    this._running = false;

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    this._loop = this._loop.bind(this);

    // Smoothed dt so physics never explodes after a tab stall.
    this._dtSmooth = 1 / 60;
  }

  get width() { return this.renderer.domElement.width / this.renderer.getPixelRatio(); }
  get height() { return this.renderer.domElement.height / this.renderer.getPixelRatio(); }

  onUpdate(fn) { this._updaters.push(fn); return fn; }
  onLateUpdate(fn) { this._lateUpdaters.push(fn); return fn; }
  onResize(fn) { this._resizeCbs.push(fn); return fn; }

  /**
   * Change the quality tier at runtime and tell everyone who cares.
   *
   * Previously the settings panel assigned `engine.preset` directly, which
   * changed pixel ratio and per-system scatter density but never reached the
   * things that actually cost the most — shadow map size, SSAO, depth of field.
   * Systems opt in by implementing `onQuality(preset, name)`; those that do not
   * are simply skipped, so this is safe to call before they all support it.
   */
  setQuality(name) {
    const preset = QUALITY_PRESETS[name];
    if (!preset) { console.warn(`[engine] unknown quality tier: ${name}`); return false; }
    this.quality = name;
    this.preset = preset;
    this.basePixelRatio = Math.min(window.devicePixelRatio, preset.pixelRatioCap);
    this.resolutionScale = 1;
    this.renderer.setPixelRatio(this.basePixelRatio);
    this._onResize();
    for (const fn of this._qualityCbs) {
      try { fn(preset, name); } catch (e) { console.error('[engine] onQuality handler threw', e); }
    }
    return true;
  }

  /** Register a quality-change handler. Systems' own onQuality is wired by main. */
  onQuality(fn) { this._qualityCbs.push(fn); return fn; }

  setRenderCallback(fn) { this._render = fn; }

  /**
   * Scale the render resolution to hold `targetFrameMs`.
   *
   * Judged on the 80th percentile of a rolling window rather than the mean, so
   * one streaming hitch does not drop the whole frame's resolution — and with a
   * wide dead band plus asymmetric rates (drop fast, recover slowly) so it
   * cannot oscillate visibly while driving.
   */
  _adapt(now) {
    if (!this.adaptive) return;
    if (this._frameTimes.length < 45 || now - this._lastAdapt < 900) return;

    const sorted = [...this._frameTimes].sort((a, b) => a - b);
    const p80 = sorted[Math.floor(sorted.length * 0.8)] * 1000;
    this._frameTimes.length = 0;
    this._lastAdapt = now;

    const target = this.targetFrameMs;
    let next = this.resolutionScale;

    if (p80 > target * 1.25) next = this.resolutionScale * 0.90;
    else if (p80 < target * 0.80) next = this.resolutionScale * 1.04;
    else return;

    next = Math.max(this.minResolutionScale, Math.min(1, next));
    if (Math.abs(next - this.resolutionScale) < 0.005) return;

    this.resolutionScale = next;
    this._applyResolution();
  }

  _applyResolution() {
    this.renderer.setPixelRatio(this.basePixelRatio * this.resolutionScale);
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    for (const cb of this._resizeCbs) cb(w, h);
  }

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.basePixelRatio = Math.min(window.devicePixelRatio, this.preset.pixelRatioCap);
    this.renderer.setPixelRatio(this.basePixelRatio * this.resolutionScale);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const cb of this._resizeCbs) cb(w, h);
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(this._loop);
  }

  stop() {
    this._running = false;
    this.renderer.setAnimationLoop(null);
  }

  _loop() {
    let dt = this.clock.getDelta();
    dt = Math.min(dt, 1 / 20);                  // hard clamp against stalls
    this._dtSmooth += (dt - this._dtSmooth) * 0.15;
    this.elapsed += dt;
    this.frame++;
    this._frameTimes.push(dt);
    this._adapt(performance.now());

    for (const fn of this._updaters) fn(dt, this.elapsed);
    for (const fn of this._lateUpdaters) fn(dt, this.elapsed);

    this.renderer.info.reset();
    if (this._render) this._render(dt, this.elapsed);
    else this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.stop();
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
