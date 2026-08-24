// Renderer, scene graph root, camera, resize handling and the frame loop.
import * as THREE from 'three';
import {
  ADAPTIVE_RESOLUTION,
  QUALITY_PRESETS,
  QUALITY_TIERS,
} from '../world/WorldConfig.js';

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
    this.targetFrameMs = 1000 / ADAPTIVE_RESOLUTION.targetFps;
    // ── internal render scale ──────────────────────────────────────────────
    // The scene and post chain render at `internalScale` times the canvas and
    // are reconstructed to it by PostFX's upscale pass (Catmull-Rom + CAS —
    // see UpscalePass.js). The canvas itself stays at basePixelRatio, so
    // changing this never reallocates the drawing buffer. It DOES resize the
    // composer's offscreen graph, though, and the corrected drive harness has
    // measured that transition at roughly 300 ms on ANGLE/Metal. The scaler is
    // therefore allowed to rescue a heavy frame and recover back to its boot
    // target, but never to opportunistically climb above that target.
    //
    // The quality policy is expressed as effective device pixels per CSS pixel
    // rather than a raw scale, so `high` at 1.35 and `ultra` at 1.5 settle to
    // the same perceived sharpness. Start above native, and keep the emergency
    // floor close to it: reconstruction improves a reduced frame, but player
    // feedback is clear that the old 0.78 floor still looked like potato mode.
    this.internalScale = 1;
    this.preferredEffectiveInternalRatio = ADAPTIVE_RESOLUTION.preferredEffectiveRatio;
    this.minEffectiveInternalRatio = ADAPTIVE_RESOLUTION.minEffectiveRatio;
    this.adaptDownscaleThreshold = ADAPTIVE_RESOLUTION.downscaleThreshold;
    this.adaptUpscaleHeadroom = ADAPTIVE_RESOLUTION.upscaleHeadroom;
    this.adaptMaxDownRungs = ADAPTIVE_RESOLUTION.maxDownRungs;
    this.onInternalScale = null;
    // Never render below one device pixel per CSS pixel. A scale that takes the
    // effective ratio under 1.0 is drawing fewer pixels than the display has and
    // upscaling them, which reads as a blurry game rather than a fast one — the
    // first version of this shipped at 1.5 x 0.55 = 0.825 and the player's
    // immediate reaction was "very blurry / fuzzy looking, even on ultra".
    // Below native, the honest move is to drop effects, not sharpness.
    this.minEffectivePixelRatio = 1.0;
    this.adaptive = true;
    this._frameTimes = [];
    this._lastAdapt = 0;

    // Automatic tier fallback. Resolution scaling alone cannot save a machine
    // that is short of frame time, because the image-quality floor is finite —
    // once it is pinned there and still missing the target, the only honest
    // lever left is fewer effects. Measured on the player's window:
    // ultra 32 fps, medium 75. A player should not have to find that menu.
    //
    // Never steps back up: recovering would re-enter the state that triggered
    // the step and oscillate. An explicit ?quality= is respected and never
    // overridden.
    //
    // Never fires under automation. Every capture tool in `tools/` drives a
    // headless Chromium at deviceScaleFactor 1 on a machine shared with the
    // other authors, so its frame times are contended rather than
    // representative — and a tier change part way through a capture silently
    // invalidates the plate and every number taken off it. Until the ordering
    // bug below was fixed that immunity was an accident (at 1x the resolution
    // ladder has no rungs, so the tier lever was unreachable for everyone,
    // players included); now it is stated. A harness that wants to exercise the
    // fallback sets `engine.autoQuality = true` after construction.
    this.autoQuality = !new URLSearchParams(location.search).get('quality')
                       && !navigator.webdriver;
    this._strainSince = 0;
    // How far over budget counts as strain, and for how long.
    //
    // 1.45x of a 20 ms target is 29 ms, i.e. 34 fps. The measurement this
    // feature exists for is the player's window at ultra 32 fps, so the trigger
    // has to sit just above it — and no lower. The previous 1.35x is 22.5 ms
    // (44 fps), which this scene reaches on a healthy machine whenever the
    // camera is over open water; demoting there would be wrong.
    //
    // The hold is longer than one adapt window on purpose: with the 6 s
    // cooldown it takes three consecutive windows to trip, so a stretch of
    // streaming, a shader compile or one heavy vista cannot demote a machine
    // that is otherwise making frame rate.
    this.strainRatio = 1.45;
    this.strainHoldMs = 10000;
    // Off by default — see the long note at its use in `_adapt`. Every shipped
    // build of this project has behaved as `false`, because the lever was
    // unreachable; keeping that the default means merging this branch cannot
    // introduce a freeze class main does not already have.
    this.autoTier = false;
    this._bootAt = performance.now();
    this.onQualityAutoChange = null;

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
    // PCFSoft, not VSM, because Lighting flips it to PCFSoft on the first frame
    // and every material in the scene then recompiles — five linkProgram calls
    // costing 62-702 ms, right when the player is first looking at the game.
    // Setting the final value here makes Lighting's switch a no-op.
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;

    // Shader-error checking OFF for players, ON under automation.
    //
    // three's `checkShaderErrors` calls `getProgramParameter(LINK_STATUS)` and
    // `getProgramInfoLog` immediately after `linkProgram`. Both are
    // synchronisation points: they force the driver to FINISH the link before
    // returning, on the main thread, in the frame that triggered it. A CPU
    // profile of a 2053 ms freeze on this scene put 1771 ms of it inside
    // `getProgramInfoLog` alone. With the check off, the link is not awaited at
    // the point it is issued, so the driver is free to overlap it.
    //
    // This is the SECOND layer. The first is not compiling programs during play
    // at all — see the shadow-caster invariant in render/Lighting.js, which was
    // relinking every shader in the game at each dawn and dusk. That fix took
    // the programs compiled over a full day/night cycle from 26 to 1 and the
    // worst frame at the crossing from 6150 ms to 57 ms. This one is what
    // remains for the handful that still compile the first time an object is
    // ever drawn.
    //
    // It stays ON under automation because tools/health.mjs depends on it: it
    // reads every program's `diagnostics.runnable` to catch a material that
    // silently failed to compile, and three only attaches diagnostics when the
    // check is on. A shader that does not link renders NOTHING, silently, while
    // lint passes — losing that alarm to save a stall the harness does not care
    // about would be a bad trade. `?shadercheck=0` forces the player path so
    // tools/stall.mjs can measure it.
    const scParam = new URLSearchParams(location.search).get('shadercheck');
    this.renderer.debug.checkShaderErrors =
      scParam !== null ? scParam !== '0' : !!navigator.webdriver;

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
  /**
   * @param {string} name
   * @param {{keepResolution?: boolean}} [opts] `keepResolution` holds the
   *   current resolution scale across the tier change instead of resetting to
   *   full. The automatic ladder passes it; a human picking a tier from the
   *   menu does not, because they asked for a fresh start.
   *
   * Resetting the scale to 1 here is what turned one demotion into four
   * freezes. `_stepQualityDown` only fires when resolution is PINNED AT ITS
   * FLOOR and still over budget — that is, after the machine has already paid
   * for and proven it needs every rung. Snapping back to full undid all of it
   * and made the ladder walk down again, at one buffer reallocation per rung.
   * Measured at dpr 2, ladder armed: rs 1 -> 0.85 -> 0.72 -> 0.667 costing
   * 1018 / 1128 / 970 ms, then the tier step reset it to 1.000 (913 ms) and it
   * walked 0.85 (1121 ms) and 0.741 (1013 ms) all over again. Six freezes near
   * a second each inside 52 s, of which three were pure repetition.
   */
  setQuality(name, opts = {}) {
    const preset = QUALITY_PRESETS[name];
    if (!preset) { console.warn(`[engine] unknown quality tier: ${name}`); return false; }
    const heldScale = this.resolutionScale;
    this.quality = name;
    this.preset = preset;
    this.basePixelRatio = Math.min(window.devicePixelRatio, preset.pixelRatioCap);
    // Clamp to the NEW tier's floor: a lower tier can cap the pixel ratio
    // differently, so the old scalar is not automatically legal here.
    const floor = Math.min(1, this.minEffectivePixelRatio / this.basePixelRatio);
    this.resolutionScale = opts.keepResolution ? Math.max(floor, Math.min(1, heldScale)) : 1;
    this.renderer.setPixelRatio(this.basePixelRatio * this.resolutionScale);
    // The internal-scale floor moves with basePixelRatio, so re-clamp; the
    // held scale itself is kept — a tier change never resets it (see the
    // note on keepResolution above for why resetting was four freezes).
    const iFloor = this._internalFloor();
    const iNext = Math.max(iFloor, Math.min(1, this.internalScale));
    if (Math.abs(iNext - this.internalScale) >= 1e-3) {
      this.internalScale = iNext;
      this.onInternalScale?.(iNext);
    }
    this._onResize();
    for (const fn of this._qualityCbs) {
      try { fn(preset, name); } catch (e) { console.error('[engine] onQuality handler threw', e); }
    }
    return true;
  }

  /** Register a quality-change handler. Systems' own onQuality is wired by main. */
  onQuality(fn) { this._qualityCbs.push(fn); return fn; }

  setRenderCallback(fn) { this._render = fn; }

  /** The lowest internal scale the sharpness floor permits on this display. */
  _internalFloor() {
    const presentedRatio = this.basePixelRatio * this.resolutionScale;
    return Math.min(1, this.minEffectiveInternalRatio / presentedRatio);
  }

  /**
   * Set the internal render scale. Clamped to [floor, 1]; PostFX resizes its
   * offscreen targets in response. Cheap — the drawing buffer never moves.
   */
  setInternalScale(s) {
    const next = Math.max(this._internalFloor(), Math.min(1, s || 1));
    if (Math.abs(next - this.internalScale) < 1e-3) return;
    this.internalScale = next;
    this.onInternalScale?.(next);
  }

  /**
   * Scale the INTERNAL render resolution to hold `targetFrameMs`.
   *
   * Judged on the 80th percentile of a rolling window rather than the mean, so
   * one streaming hitch does not drop the whole frame's resolution — and with a
   * wide dead band plus asymmetric rates (drop fast, recover slowly) so it
   * cannot oscillate visibly while driving.
   *
   * This used to move `resolutionScale`, which resizes the drawing buffer at a
   * measured 450–2500 ms per step — the scaler was itself the player's p95.
   * It now moves `internalScale`, which only resizes offscreen targets (see
   * PostFX.setInternalScale). That avoids the much larger drawing-buffer
   * freeze, but target reallocation is still visible on ANGLE/Metal; the rung
   * ladder below is capped at the preferred boot ratio so spare headroom does
   * not create a series of pointless upscale freezes.
   * `resolutionScale` remains as a manual/diagnostic lever and is no longer
   * touched by the automatic path.
   */
  _adapt(now) {
    if (!this.adaptive) return;
    if (this._frameTimes.length < 60) return;
    if (now - this._lastAdapt < 2000) return;
    if (now - this._bootAt < 8000) { this._frameTimes.length = 0; return; }

    const sorted = [...this._frameTimes].sort((a, b) => a - b);
    const p80 = sorted[Math.floor(sorted.length * 0.8)] * 1000;
    this._frameTimes.length = 0;
    this._lastAdapt = now;

    const target = this.targetFrameMs;
    const floorScale = this._internalFloor();
    // Build the ladder in EFFECTIVE pixel ratios, then translate it to this
    // tier's raw internal scale. That keeps a rung equally sharp on high,
    // ultra and a 1x display instead of making the same scalar mean three
    // different image qualities.
    const presentedRatio = this.basePixelRatio * this.resolutionScale;
    const ceilingScale = Math.min(1,
      this.preferredEffectiveInternalRatio / presentedRatio);
    const rungs = [...new Set([
      ceilingScale,
      ...ADAPTIVE_RESOLUTION.effectiveRungs.map((r) => Math.min(1, r / presentedRatio)),
      floorScale,
    ])]
      .filter((r) => r >= floorScale - 1e-6 && r <= ceilingScale + 1e-6)
      .sort((a, b) => b - a);
    let i = rungs.findIndex((r) => Math.abs(r - this.internalScale) < 0.02);
    if (i < 0) i = 0;

    let next = this.internalScale;
    if (p80 > target * this.adaptDownscaleThreshold && i < rungs.length - 1) {
      // Frame time is roughly proportional to pixel count and pixel count to
      // scale squared, so solve for the rung that lands on budget. Cap each
      // decision to a short descent: internal target resizes are cheap now, and
      // a transient vista should have to remain heavy before it earns potato.
      const want = this.internalScale * Math.sqrt(target / p80);
      let j = i + 1;
      while (j + 1 < rungs.length && rungs[j] > want) j++;
      j = Math.min(j, i + this.adaptMaxDownRungs);
      next = rungs[j];
    } else if (i > 0) {
      // Try the next sharper rung whenever its worst-case pixel-squared cost
      // still fits with a little headroom. The old fixed 0.70 threshold needed
      // 86 fps before it would recover, so a brief drop tended to stick for the
      // rest of the session even when a sharper rung would fit the budget.
      const sharper = rungs[i - 1];
      const predicted = p80 * (sharper / this.internalScale) ** 2;
      if (predicted <= target * this.adaptUpscaleHeadroom) next = sharper;
    }
    next = Math.max(floorScale, Math.min(1, next));
    const moving = Math.abs(next - this.internalScale) >= 0.005;

    // Resolution has nothing left to give: the ladder is on its last rung and
    // is not moving this window. This test runs BEFORE the early return — it
    // used to run after, which made the tier lever unreachable on every
    // display (the history is in git if the mechanism is ever revisited).
    //
    // The internal-scale floor (minEffectiveInternalRatio 0.90) is below 1 on
    // every display now, so the ladder always has rungs and the strain test is
    // reachable at 1x as well as 2x.
    //
    // `moving` also excludes the window that ARRIVES at the floor: that step
    // has not been given a frame to pay for itself yet, so strain starts
    // counting from the window after it.
    //
    // The TIER lever stays opt-in: `setQuality` rebuilds materials and the
    // post chain, and on this scene a relink is measured in seconds. The old
    // prerequisite for turning it on — dynamic resolution that does not
    // reallocate the drawing buffer (docs/FREEZE_ROUND.md) — is now met by the
    // internal-scale path, but the relink cost stands.
    const pinned = !moving && next <= floorScale + 1e-4;
    if (this.autoTier && pinned && p80 > target * this.strainRatio) {
      if (!this._strainSince) this._strainSince = now;
      else if (now - this._strainSince >= this.strainHoldMs) {
        this._strainSince = 0;
        if (this._stepQualityDown(p80)) return;
      }
    } else {
      this._strainSince = 0;
    }
    if (!moving) return;

    this.setInternalScale(next);
  }

  /** Drop one quality band. Returns whether it moved. */
  _stepQualityDown(p80) {
    if (!this.autoQuality) return false;
    const i = QUALITY_TIERS.indexOf(this.quality);
    if (i < 0 || i === QUALITY_TIERS.length - 1) return false;
    const next = QUALITY_TIERS[i + 1];
    console.warn(`[engine] ${p80.toFixed(0)} ms/frame at minimum resolution — ` +
                 `dropping quality ${this.quality} -> ${next}`);
    this._autoDropped = true;
    this.setQuality(next, { keepResolution: true });
    this.onQualityAutoChange?.(next, p80);
    return true;
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
