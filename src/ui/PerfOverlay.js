// ─────────────────────────────────────────────────────────────────────────────
//  Always-on performance readout.
//
//  Deliberately independent of the HUD: the HUD hides itself during captures,
//  and this must be visible exactly when the player is judging how the game
//  feels. It reports the numbers that actually explain a bad frame rate —
//  including the effective pixel ratio, because adaptive resolution can buy a
//  healthy fps by quietly drawing fewer pixels, and you should be able to see
//  that happening rather than only notice the picture got soft.
//
//  Toggle with F3. Shift+F3 cycles detail.
// ─────────────────────────────────────────────────────────────────────────────
export class PerfOverlay {
  constructor(engine) {
    this.engine = engine;
    this.visible = true;
    this.detail = 1;

    this._times = [];
    this._last = performance.now();
    this._acc = 0;

    // ── the number this overlay used to get wrong ────────────────────────────
    //
    // Every figure above is a CPU-side frame interval, and WebGL commands are
    // QUEUED. When the GPU is the bottleneck the main thread hands over a frame
    // and returns immediately, so this read 55-60 fps on a machine the player
    // was watching run at about 10. That is not a rounding error, it is the
    // overlay measuring the wrong side of the pipe, and it made every
    // performance judgement in the project — mine included — too optimistic.
    // Measured with a forced sync: CPU-side p50 25.1 ms (40 fps) against a true
    // 34.3 ms (29 fps) on the same 75 s drive.
    //
    // A 1x1 readPixels blocks until the GPU has drained, so it turns the CPU
    // clock into an honest end-to-end one. `gl.finish()` is a no-op under
    // ANGLE-Metal and `clientWaitSync` deadlocks when busy-polled; readPixels is
    // the one that works here.
    //
    // It has to be a BURST of consecutive synced frames, not one sample. A lone
    // sync waits for however deep the queue happens to be, which is the backlog
    // and not the frame: the first version of this did `readPixels_time + dt`
    // once a second and read 152.8 ms / 7 fps where a fully-synced drive of the
    // same scene measured 34.3 ms / 29 fps. That is wrong by 4x in the pessimistic
    // direction, which is no more useful than the optimistic lie it replaced.
    //
    // So: sync every frame for six frames, discard the first (it pays off the
    // existing backlog), and take the median interval of the rest. During the
    // burst CPU/GPU overlap is gone, so this still reads slightly high — it is
    // an upper bound, and it is the right one to show a player asking why the
    // game feels slower than the headline says.
    this._gpuMs = 0;
    this._gpuAcc = 0;
    this._gpuPx = new Uint8Array(4);
    this._burst = 0;
    this._burstTimes = [];

    // ── freeze watchdog ─────────────────────────────────────────────────────
    //
    // A player hit a six-second freeze about two minutes into ordinary play
    // that a 360 s profiled drive, with camp pitching and a full sun sweep,
    // could not reproduce even once. An unreproducible freeze is not going to
    // be caught by driving at it harder — so the shipped build records its own.
    // Every frame over a second is kept with the state that explains the two
    // causes already found this round (a shader relink shows as a jump in
    // `prog`; an adaptive-resolution reallocation shows as a change in `res`),
    // and `__freezes()` prints them for pasting into a bug report.
    this._freezes = [];
    this._prevProg = 0;
    this._prevRes = 1;
    window.__freezes = () => {
      if (!this._freezes.length) return 'no freezes over 1000 ms recorded this session';
      const rows = this._freezes.map((f) =>
        `  ${(f.t / 1000).toFixed(1)}s  ${f.ms.toFixed(0)} ms  prog ${f.prog0}->${f.prog1}` +
        `  res ${f.res0.toFixed(3)}->${f.res1.toFixed(3)}  q=${f.q}  calls ${f.calls}  tris ${(f.tris / 1e6).toFixed(2)}M`);
      return [`${this._freezes.length} freeze(s) over 1000 ms:`, ...rows,
        'prog jump => shader relink.  res change => drawing-buffer realloc.  neither => see docs/FREEZE_ROUND.md'].join('\n');
    };

    const el = document.createElement('div');
    el.id = 'perf-overlay';
    el.style.cssText = [
      'position:fixed', 'top:10px', 'left:10px', 'z-index:9999',
      'font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
      'color:#ffe9c8', 'background:rgba(24,16,22,.72)',
      'padding:7px 10px', 'border-radius:8px',
      'border:1px solid rgba(255,214,150,.22)',
      'pointer-events:none', 'white-space:pre', 'letter-spacing:.02em',
      'backdrop-filter:blur(6px)', '-webkit-backdrop-filter:blur(6px)',
      'text-shadow:0 1px 2px rgba(0,0,0,.5)',
    ].join(';');
    document.body.appendChild(el);
    this.el = el;

    window.addEventListener('keydown', (e) => {
      if (e.code !== 'F3') return;
      e.preventDefault();
      if (e.shiftKey) this.detail = (this.detail + 1) % 3;
      else this.visible = !this.visible;
      this.el.style.display = this.visible ? 'block' : 'none';
    });
  }

  update() {
    const now = performance.now();
    const dt = now - this._last;
    this._last = now;
    this._times.push(dt);
    if (this._times.length > 120) this._times.shift();

    // Watchdog first, and deliberately before every early return below: a
    // freeze must be recorded whether or not the overlay is visible.
    const eng = this.engine, rr = eng.renderer;
    const prog = rr.info.programs?.length ?? 0;
    if (dt > 1000) {
      this._freezes.push({
        t: now, ms: dt, prog0: this._prevProg, prog1: prog,
        res0: this._prevRes, res1: eng.resolutionScale, q: eng.quality,
        calls: rr.info.render.calls, tris: rr.info.render.triangles,
      });
      if (this._freezes.length > 40) this._freezes.shift();
      console.warn(`[perf] ${dt.toFixed(0)} ms freeze — prog ${this._prevProg}->${prog}, ` +
                   `res ${this._prevRes.toFixed(3)}->${eng.resolutionScale.toFixed(3)}. ` +
                   `Run __freezes() for the full list.`);
    }
    this._prevProg = prog;
    this._prevRes = eng.resolutionScale;

    // A six-frame synced burst — every TEN seconds, only while someone can
    // actually read the number, and never under automation.
    //
    // THIS BURST WAS THE ANSWER TO PERF_FINDINGS' OPEN QUESTION ("p95 is 74 ms
    // while p50 is 36, parked, with nothing moving"). The first synced frame
    // pays off the entire queued GPU backlog — that is by design, it is what
    // makes the number honest — but it pays it ON the render thread, in a
    // frame the player sees. At a healthy queue that is a ~2x frame; on a
    // loaded GPU it measured 850-966 ms, and at the old two-second cadence it
    // put a wall of >100 ms "freezes" into every perf.mjs run and every
    // player session, overlay visible or not (the old code ran the burst even
    // when hidden). Diagnosed by pinning the internal scale and watching the
    // worst frames land exactly on the burst cadence with adaptation frozen
    // (review/perf/opt-drive-pinned.json).
    //
    // Ten seconds keeps the honest end-to-end column alive for a player who
    // has the overlay open, at a twentieth of the hitch budget. Hidden or
    // under webdriver there is no reader, so there is no burst — and the
    // harnesses stop measuring their own instrument.
    this._gpuAcc += dt;
    const capturing = !!window.__forceCamera;
    const wantBurst = this.visible && !capturing && !navigator.webdriver;
    if (this._burst === 0 && this._gpuAcc >= 10000 && wantBurst) {
      this._gpuAcc = 0;
      this._burst = 6;
      this._burstTimes.length = 0;
    }
    if (this._burst > 0) {
      try {
        const gl = rr.getContext();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._gpuPx);
        // `dt` here is the interval between this synced frame and the previous
        // one — both synced except the first, which is why the first is dropped.
        this._burstTimes.push(dt);
        this._burst--;
        if (this._burst === 0 && this._burstTimes.length > 2) {
          const g = this._burstTimes.slice(1).sort((a, b) => a - b);
          this._gpuMs = g[Math.floor(g.length / 2)];
        }
      } catch { this._burst = 0; this._gpuMs = 0; }
    }

    // Hide during captures, the same way the HUD does. Otherwise every review
    // sheet carries a readout in the corner of all ten tiles, which is both
    // noise and a small lie — the fps shown is the harness's, not a player's.
    if (capturing !== this._wasCapturing) {
      this._wasCapturing = capturing;
      this.el.style.display = (this.visible && !capturing) ? 'block' : 'none';
    }
    if (capturing) return;

    this._acc += dt;
    if (this._acc < 250 || !this.visible) return;   // refresh 4x a second
    this._acc = 0;

    const s = [...this._times].sort((a, b) => a - b);
    const p = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
    const p50 = p(0.5), p95 = p(0.95);

    const e = this.engine;
    const r = e.renderer;
    const info = r.info.render;
    const eff = e.basePixelRatio * e.resolutionScale;
    const mp = (r.domElement.width * r.domElement.height) / 1e6;

    // Colour the headline by how it actually feels to play.
    const fps = 1000 / p50;
    const tint = fps >= 55 ? '#9fe08a' : fps >= 40 ? '#ffd98a' : fps >= 25 ? '#ffab6b' : '#ff7a6b';

    // The headline stays the CPU number because that is what the frame pacing
    // feels like when the GPU is keeping up; the GPU column is what tells you it
    // is not. When they diverge, believe the second one.
    const gpuFps = this._gpuMs > 0 ? 1000 / this._gpuMs : 0;
    const gpuTint = gpuFps >= 55 ? '#9fe08a' : gpuFps >= 40 ? '#ffd98a' : gpuFps >= 25 ? '#ffab6b' : '#ff7a6b';
    const lines = [
      `<span style="color:${tint};font-size:15px;font-weight:600">${fps.toFixed(0)} fps</span>` +
      `  <span style="opacity:.75">${p50.toFixed(1)} ms  p95 ${p95.toFixed(1)}</span>`,
    ];
    if (this._gpuMs > 0) {
      lines.push(
        `gpu  <span style="color:${gpuTint};font-weight:600">${gpuFps.toFixed(0)} fps</span>` +
        `  <span style="opacity:.75">${this._gpuMs.toFixed(1)} ms end-to-end</span>`,
      );
    }

    if (this.detail >= 1) {
      const soft = eff < 0.999;
      // Internal render scale: the scene + post chain render at this fraction
      // of the canvas and are reconstructed by the upscale pass. This is where
      // the adaptive scaler now buys frame time, so it must be visible for the
      // same reason `res` always was.
      const is = e.internalScale ?? 1;
      const imp = mp * is * is;
      lines.push(
        `res  ${eff.toFixed(2)}x  (${(e.resolutionScale * 100).toFixed(0)}% of ${e.basePixelRatio.toFixed(2)})` +
        (soft ? '  <span style="color:#ff7a6b">BELOW NATIVE</span>' : ''),
        `int  ${(is * 100).toFixed(0)}%  ${imp.toFixed(2)} of ${mp.toFixed(2)} MP` +
        (is < 0.999 ? '  <span style="opacity:.75">upscaled</span>' : ''),
        `px   dpr ${window.devicePixelRatio}   ${e.quality}${e._autoDropped ? ' (auto)' : ''}`,
      );
    }
    // Audio state. "The sound is gone" is otherwise undiagnosable: the context
    // needs a gesture before it can start, and the mute flag is PERSISTED to
    // localStorage — so one stray click on the speaker chip silences the game
    // across every future reload with no visible cause.
    const a = window.__systems?.audio;
    if (a) {
      let tag, colour;
      if (a.failed) { tag = 'failed'; colour = '#ff7a6b'; }
      else if (!a.started) { tag = 'waiting for input'; colour = '#ffab6b'; }
      else if (a.muted) { tag = 'MUTED'; colour = '#ff7a6b'; }
      else if (a.actx?.state !== 'running') { tag = a.actx?.state ?? 'no context'; colour = '#ffab6b'; }
      else { tag = `on  vol ${Math.round((a.volume ?? 0) * 100)}%`; colour = '#9fe08a'; }
      lines.push(`snd  <span style="color:${colour}">${tag}</span>`);
    }

    if (this.detail >= 2) {
      lines.push(
        `draw ${info.calls}   tris ${(info.triangles / 1e6).toFixed(2)}M`,
        `geo  ${r.info.memory.geometries}   tex ${r.info.memory.textures}   prog ${r.info.programs?.length ?? 0}`,
      );
    }

    this.el.innerHTML = lines.join('\n');
  }

  dispose() { this.el?.remove(); }
}
