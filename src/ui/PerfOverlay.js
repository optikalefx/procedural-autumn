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

    const lines = [
      `<span style="color:${tint};font-size:15px;font-weight:600">${fps.toFixed(0)} fps</span>` +
      `  <span style="opacity:.75">${p50.toFixed(1)} ms  p95 ${p95.toFixed(1)}</span>`,
    ];

    if (this.detail >= 1) {
      const soft = eff < 0.999;
      lines.push(
        `res  ${eff.toFixed(2)}x  (${(e.resolutionScale * 100).toFixed(0)}% of ${e.basePixelRatio.toFixed(2)})` +
        (soft ? '  <span style="color:#ff7a6b">BELOW NATIVE</span>' : ''),
        `px   ${mp.toFixed(2)} MP   dpr ${window.devicePixelRatio}   ${e.quality}`,
      );
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
