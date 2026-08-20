// ─────────────────────────────────────────────────────────────────────────────
//  Sound Lab — metering.
//
//  Why a meter is in a parameter editor at all: three of the audio bugs found
//  on this project were *routing* bugs that no parameter value could reveal.
//  An LFO summing into a gain at 7x the level the mixer was writing; a music
//  duck node connected to nothing while its gain was driven correctly every
//  frame; tyres 4.3 dB louder on grass than on bare rock. Every one of those
//  reads as perfectly healthy in a list of numbers, and every one of them is
//  obvious the moment you look at RMS and a spectrum.
//
//  The approach is lifted from `tools/_scratch/mixprofile.mjs`, because the two
//  things it does are the two things that made those bugs tractable:
//
//   · **A long window.** The ambience gusts run at 0.037 and 0.029 Hz — 27 and
//     35 second periods. A single analyser read is a 340 ms window and lands
//     wherever it lands on that cycle. Percentiles over 30 s show the floor and
//     the peak, and "when the wind dies down it's nice" is a statement about
//     the floor.
//   · **A-weighting.** The wind was never loud in raw RMS; it was sitting where
//     the ear is most sensitive. A bus at -26 dBFS with its energy above 2 kHz
//     is fatiguing and the same bus at the same level with its energy at 200 Hz
//     is cozy, so every judgement about "too loud" is made on the weighted
//     number, not the flat one.
// ─────────────────────────────────────────────────────────────────────────────

export const BAND_LABELS = ['63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

// A-weighting at each octave centre, dB. Same table as mixprofile.mjs.
export const AWEIGHT = [-26.2, -16.1, -8.6, -3.2, 0, 1.2, 1.0, -1.1, -6.6];

export const dB = (v) => (v > 1e-7 ? 20 * Math.log10(v) : -Infinity);
export const fmtDb = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-inf');

/**
 * Live meter over one of `Audio`'s analyser taps.
 *
 * `audio.measure(bus)` and `audio.spectrumBins(bus)` are the game's own
 * measurement entry points — the same ones `tools/audiotest.mjs` reads — so
 * nothing here is a second implementation that can drift from what ships.
 */
export class Meter {
  constructor(audio, canvas, windowSeconds = 30) {
    this.audio = audio;
    this.canvas = canvas;
    this.cctx = canvas.getContext('2d');
    this.bus = 'master';
    this.windowSeconds = windowSeconds;
    this.env = [];                       // rolling rms samples, newest last
    this.bands = new Array(BAND_LABELS.length).fill(0);   // smoothed power
    this.centroid = 0;
    this.rms = 0;
    this.peak = 0;
    this.peakHold = 0;
    this._holdAt = 0;
    this._n = 0;
    this.stats = null;
    this._statAt = 0;
  }

  setBus(b) {
    if (b === this.bus) return;
    this.bus = b;
    this.reset();
  }

  reset() {
    this.env.length = 0;
    this.bands.fill(0);
    this.centroid = 0;
    this.peakHold = 0;
    this.stats = null;
  }

  /** One frame of measurement. Cheap; the FFT is taken every sixth frame. */
  sample(now = performance.now()) {
    const a = this.audio;
    if (!a?.started) return;
    const m = a.measure(this.bus);
    if (m) {
      this.rms = m.rms;
      this.peak = m.peak;
      if (m.peak >= this.peakHold || now - this._holdAt > 1500) {
        this.peakHold = m.peak;
        this._holdAt = now;
      }
      this.env.push(m.rms);
      const cap = Math.max(60, this.windowSeconds * 60);
      if (this.env.length > cap) this.env.splice(0, this.env.length - cap);
    }

    if ((++this._n % 6) === 0) {
      const s = a.spectrumBins(this.bus);
      if (s) {
        const acc = new Array(BAND_LABELS.length).fill(0);
        let num = 0, den = 0;
        for (let i = 1; i < s.db.length; i++) {
          const hz = i * s.hzPerBin;
          if (hz > 20000) break;
          const pw = Math.pow(10, s.db[i] / 10);      // power, not amplitude
          const k = Math.round(Math.log2(hz / 63));   // 63 Hz is band 0
          if (k >= 0 && k < acc.length) acc[k] += pw;
          num += pw * hz; den += pw;
        }
        // Exponential smoothing rather than mixprofile's cumulative average:
        // this display has to follow a slider being dragged.
        const alpha = 0.18;
        for (let k = 0; k < acc.length; k++) {
          this.bands[k] = this.bands[k] * (1 - alpha) + acc[k] * alpha;
        }
        if (den > 0) this.centroid = this.centroid * 0.85 + (num / den) * 0.15;
      }
    }

    if (now - this._statAt > 120) {
      this._statAt = now;
      this.stats = this._computeStats();
    }
  }

  _computeStats() {
    const a = [...this.env].sort((x, y) => x - y);
    const q = (f) => (a.length ? a[Math.min(a.length - 1, Math.floor(f * a.length))] : 0);
    const floor = dB(q(0.02));
    const pk = dB(q(0.98));

    const total = this.bands.reduce((x, y) => x + y, 0);
    let flat = -Infinity, dBA = -Infinity, bite = 0;
    if (total > 0) {
      flat = 10 * Math.log10(total);
      let aSum = 0;
      for (let i = 0; i < this.bands.length; i++) aSum += this.bands[i] * 10 ** (AWEIGHT[i] / 10);
      dBA = 10 * Math.log10(Math.max(aSum, 1e-30));
      bite = this.bands.slice(6).reduce((x, y) => x + y, 0) / total;   // >= 2 kHz
    }

    return {
      rms: dB(this.rms),
      peak: dB(this.peak),
      hold: dB(this.peakHold),
      floor,
      p10: dB(q(0.10)),
      p50: dB(q(0.50)),
      p90: dB(q(0.90)),
      pk,
      range: pk - floor,
      flat,
      dBA,
      tilt: dBA - flat,
      bite: bite * 100,
      centroid: this.centroid,
      samples: a.length,
      silent: !(this.rms > 1e-5),
    };
  }

  /** Spectrum bars plus the RMS/peak bar underneath them. */
  draw() {
    const c = this.cctx;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (this.canvas.width !== (w * dpr | 0) || this.canvas.height !== (h * dpr | 0)) {
      this.canvas.width = w * dpr | 0;
      this.canvas.height = h * dpr | 0;
    }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    // A gutter on the left for the dB scale, so the grid labels never sit on
    // top of the 63 Hz bar, and room under the bars for the band labels.
    const padL = 28, padR = 6, padT = 10;
    const barsH = h - 56;
    const n = BAND_LABELS.length;
    const bw = (w - padL - padR) / n;

    // dB grid: -90 at the floor, 0 at the top.
    const TOP = 0, BOT = -90;
    const y = (v) => padT + (TOP - Math.max(BOT, Math.min(TOP, v))) / (TOP - BOT) * barsH;
    c.strokeStyle = 'rgba(255,246,234,.10)';
    c.fillStyle = 'rgba(255,246,234,.34)';
    c.font = '9px ui-monospace, Menlo, monospace';
    c.lineWidth = 1;
    c.textAlign = 'right';
    for (let v = 0; v >= BOT; v -= 15) {
      const yy = Math.round(y(v)) + 0.5;
      c.beginPath(); c.moveTo(padL, yy); c.lineTo(w - padR, yy); c.stroke();
      c.fillText(String(v), padL - 4, yy + 3);
    }
    c.textAlign = 'left';

    for (let i = 0; i < n; i++) {
      const p = this.bands[i];
      const lvl = p > 0 ? 10 * Math.log10(p) : -Infinity;
      const aw = p > 0 ? lvl + AWEIGHT[i] : -Infinity;
      const x0 = padL + i * bw;
      // Flat band, then the A-weighted band drawn over it: where the two
      // diverge is where the ear disagrees with the number.
      if (Number.isFinite(lvl)) {
        const yy = y(lvl);
        c.fillStyle = 'rgba(243,176,119,.30)';
        c.fillRect(x0 + 1, yy, bw - 2, padT + barsH - yy);
      }
      if (Number.isFinite(aw)) {
        const yy = y(aw);
        c.fillStyle = '#f3b077';
        c.fillRect(x0 + 1, yy, bw - 2, Math.max(2, padT + barsH - yy));
      }
      c.fillStyle = 'rgba(255,246,234,.45)';
      c.textAlign = 'center';
      c.fillText(BAND_LABELS[i], x0 + bw / 2, h - 32);
      c.textAlign = 'left';
    }

    // Level bar: rms fill, held peak as a tick. It is labelled by the rms and
    // peak-hold figures directly under the canvas, so it carries no text of its
    // own — the scale legend used to collide with the 16 kHz band label.
    const bx = padL, bw2 = w - padL - padR, by = h - 20;
    c.fillStyle = 'rgba(255,246,234,.08)';
    c.fillRect(bx, by, bw2, 14);
    const norm = (v) => Math.max(0, Math.min(1, (v + 90) / 90));
    const rw = bw2 * norm(dB(this.rms));
    c.fillStyle = dB(this.peakHold) > -1 ? '#d1687a' : '#8fd1a0';
    c.fillRect(bx, by, rw, 14);
    const px = bx + bw2 * norm(dB(this.peakHold));
    c.fillStyle = '#fff6ea';
    c.fillRect(px - 1, by, 2, 14);
  }
}
