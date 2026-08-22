// The nine hostile terrains, factored out of tools/waterlab.mjs so a second
// instrument can drive the same ground. waterlab.mjs remains the definition of
// what they MEAN; this file is only the shapes.
//
// Each takes (noise, x, z, u, v, helpers) where helpers = { smooth01, valley }.
export const CASES_SRC = 1;
export const CASES = {
  // A near-flat floodplain. The pathological case for placing a waterline: the
  // bed gradient is 1:60, so every centimetre of bed noise is six centimetres
  // of waterline. Nothing about this is exotic — most of this map's basin is
  // exactly this.
  flat: (n, x, z, u, v, H) => {
    const tilt = -v * 9.0;
    const swale = n.fbm(u * 2.0, v * 2.0, 3, 2, 0.5) * 5.0;
    const micro = n.fbm(u * 26.0, v * 26.0, 3, 2, 0.5) * 0.35;
    return 40 + tilt + swale + micro - H.valley(u, 0.5, 0.16) * 5.5;
  },
  // The case in the screenshot: a strong high-frequency roughness on gentle
  // ground. Scree, hummock, boulder field, the debris an erosion pass leaves.
  // The channel through it is real; whether the water's edge survives it is the
  // whole question.
  talus: (n, x, z, u, v, H) => {
    const tilt = -v * 16.0;
    const swale = n.fbm(u * 2.2, v * 2.2, 3, 2, 0.5) * 7.0;
    const rough = (n.fbm(u * 34.0, v * 34.0, 4, 2.1, 0.55) * 1.9
                 + n.fbm(u * 70.0, v * 70.0, 3, 2.0, 0.5) * 0.9);
    return 46 + tilt + swale + rough - H.valley(u, 0.5, 0.13) * 7.0;
  },
  // Benched ground — the terrace operator's output, and every lip is a place
  // for a surface to be bridged across two levels.
  bench: (n, x, z, u, v, H) => {
    const tilt = -v * 30.0;
    const swale = n.fbm(u * 1.8, v * 1.8, 3, 2, 0.5) * 6.0;
    const q = (60 + tilt + swale) / 4.0;
    const stepped = (Math.floor(q) + H.smooth01(q - Math.floor(q), 0.30, 0.72)) * 4.0;
    return stepped + n.fbm(u * 30.0, v * 30.0, 3, 2, 0.5) * 0.45 - H.valley(u, 0.5, 0.11) * 6.0;
  },
  // A steep, narrow, incised gorge. Tests the other end: the bed gradient is
  // enormous, so the waterline is well conditioned, and what fails instead is
  // the level-step cull and anything that assumes a level surface.
  gorge: (n, x, z, u, v, H) => {
    const tilt = -v * 52.0;
    const walls = Math.pow(Math.abs(u - 0.5) * 2, 1.6) * 96.0;
    return 30 + tilt + walls + n.fbm(u * 16.0, v * 16.0, 4, 2, 0.5) * 1.6;
  },
  // A basin with a rough rim: a lake, and a shoreline that has to hold against
  // ground that is not smooth anywhere near it.
  bowl: (n, x, z, u, v, H) => {
    const r = Math.hypot(u - 0.5, v - 0.45) * 2.1;
    const bowl = H.smooth01(r, 0.12, 0.92) * 46.0;
    const rim = n.fbm(u * 9.0, v * 9.0, 4, 2, 0.5) * 6.5 * H.smooth01(r, 0.30, 0.80);
    const rough = n.fbm(u * 40.0, v * 40.0, 4, 2, 0.5) * 1.4;
    // A notch in the rim, so it spills and there is an outlet reach as well.
    const notch = Math.exp(-Math.pow((u - 0.78) / 0.06, 2) - Math.pow((v - 0.95) / 0.22, 2)) * 22.0;
    return 24 + bowl + rim + rough - notch - v * 5.0;
  },
  // Two reaches meeting standing water, which is the junction the whole
  // `mouth` framing exists for — flare, level handover, delta.
  delta: (n, x, z, u, v, H) => {
    const pond = H.smooth01(Math.hypot(u - 0.5, v - 0.82) * 2.4, 0.10, 0.62) * 26.0;
    const tilt = -v * 26.0;
    const feedA = H.valley(u, 0.34, 0.09) * 9.0 * H.smooth01(v, 0.72, 0.06);
    const feedB = H.valley(u, 0.68, 0.08) * 8.0 * H.smooth01(v, 0.70, 0.05);
    return 34 + tilt + pond * 0.0 + Math.min(pond, 26) - feedA - feedB
         + n.fbm(u * 28.0, v * 28.0, 4, 2, 0.5) * 1.1;
  },
  // A wide, shallow, braided run — many threads, none of them deep. The mask
  // that draws it is one texel wide in places and every rejection rule in the
  // splat gets to bite.
  braid: (n, x, z, u, v, H) => {
    const tilt = -v * 11.0;
    const pan = -H.smooth01(Math.abs(u - 0.5), 0.34, 0.02) * 4.5;
    const bars = Math.abs(n.fbm(u * 7.0, v * 3.0, 3, 2, 0.5)) * 1.5;
    return 38 + tilt + pan + bars + n.fbm(u * 32.0, v * 32.0, 4, 2, 0.5) * 0.7;
  },
  // A bedrock step across the line of drainage: a waterfall, and the lip and
  // plunge pool either side of it.
  step: (n, x, z, u, v, H) => {
    const tilt = -v * 18.0;
    const drop = H.smooth01(v, 0.46, 0.54) * 26.0;
    return 52 + tilt - drop - H.valley(u, 0.5, 0.12) * 8.0
         + n.fbm(u * 24.0, v * 24.0, 4, 2, 0.5) * 1.6;
  },
  // A meander belt on a flat floor: the case where two limbs of one channel
  // pass within a dilation ring of each other.
  meander: (n, x, z, u, v, H) => {
    const tilt = -v * 8.0;
    const belt = Math.abs(u - (0.5 + Math.sin(v * 11.0) * 0.16));
    const cut = H.smooth01(belt, 0.10, 0.01) * 6.0;
    return 42 + tilt - cut + n.fbm(u * 30.0, v * 30.0, 4, 2, 0.5) * 0.6;
  },
};