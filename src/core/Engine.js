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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.preset.pixelRatioCap));
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
    this.exposure = 2.15;
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

  setRenderCallback(fn) { this._render = fn; }

  _onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.preset.pixelRatioCap));
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
