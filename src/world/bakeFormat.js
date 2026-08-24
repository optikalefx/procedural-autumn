// ─────────────────────────────────────────────────────────────────────────────
//  Baked-world container format.
//
//  Baking the 1536² world costs ~25 s of CPU. Every headless capture paying
//  that again is what turns a handful of concurrent authors into a melted
//  laptop, so the bake is done once offline and loaded from disk.
//
//  Layout:  magic "PAB1" | u32 headerLen | utf8 JSON header | payload
//
//  height and water keep full float precision because geometry and physics
//  read them directly. The rest are 0..1-ish fields only ever used for
//  blending and density, so they are quantised to u8 with a recorded scale —
//  33 MB instead of 75 MB, with no visible difference.
// ─────────────────────────────────────────────────────────────────────────────

export const MAGIC = 0x31424150; // "PAB1" little-endian

/** Fields stored as raw Float32. */
export const F32_FIELDS = ['height', 'water'];

/** Fields quantised to u8, with the value range they are mapped from. */
export const U8_FIELDS = [
  { name: 'riverMask', min: 0, max: 1 },
  { name: 'moisture',  min: 0, max: 1 },
  { name: 'hardness',  min: 0, max: 1 },
  { name: 'sediment',  min: 0, max: 1 },
  { name: 'slope',     min: 0, max: 6 },
  // Metres to the nearest water, capped at 48 by the generator. u8 over that
  // range is 19 cm, finer than the 2 m grid it is derived from. See the note
  // at the end of TerrainGen._climate for why this had to become a real
  // field: the two-valued stub it replaces made the terrain's sand term a
  // step function, on at 0.992 inside the river mask and off at 0.004
  // outside it, with no gradient anywhere and no knowledge of lakes at all.
  { name: 'distToWaterM', min: 0, max: 48 },
  // The flow field — see TerrainGen._flowField. VX/VZ are a direction times a
  // coherence, so they live in -1..1 and u8 resolves them to 1/128, which is
  // half a degree of bearing at full coherence and finer than the field's own
  // 9 m smoothing can justify. Q and T are 0..1 and are only ever used to scale
  // a scroll rate and a foam drive.
  { name: 'flowVX', min: -1, max: 1 },
  { name: 'flowVZ', min: -1, max: 1 },
  { name: 'flowQ',  min: 0,  max: 1 },
  { name: 'flowT',  min: 0,  max: 1 },
];

/** flow spans many orders of magnitude, so it is stored log-compressed. */
export const FLOW_LOG_SCALE = 16;

export function encodeBake(data) {
  const N = data.res * data.res;
  const header = {
    version: 1,
    res: data.res,
    worldSize: data.worldSize,
    minHeight: data.minHeight,
    maxHeight: data.maxHeight,
    waterfalls: data.waterfalls,
    riverPolylines: data.riverPolylines,
    lakes: data.lakes,
    f32: F32_FIELDS,
    u8: U8_FIELDS,
    flowLogScale: FLOW_LOG_SCALE,
  };
  const raw = new TextEncoder().encode(JSON.stringify(header));
  // Pad so the float payload starts 4-byte aligned; typed-array views require it.
  const headerLen = (raw.length + 3) & ~3;

  const payloadLen = F32_FIELDS.length * N * 4 + (U8_FIELDS.length + 1) * N;
  const buf = new ArrayBuffer(8 + headerLen + payloadLen);
  const dv = new DataView(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, headerLen, true);
  new Uint8Array(buf, 8, raw.length).set(raw);   // tail stays zero-filled

  let off = 8 + headerLen;
  for (const f of F32_FIELDS) {
    new Float32Array(buf, off, N).set(data[f]);
    off += N * 4;
  }
  for (const { name, min, max } of U8_FIELDS) {
    const src = data[name], dst = new Uint8Array(buf, off, N);
    const s = 255 / (max - min);
    for (let i = 0; i < N; i++) {
      const v = (src[i] - min) * s;
      dst[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
    off += N;
  }
  {
    const src = data.flow, dst = new Uint8Array(buf, off, N);
    for (let i = 0; i < N; i++) {
      const v = (Math.log(1 + src[i]) / FLOW_LOG_SCALE) * 255;
      dst[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
    off += N;
  }
  return buf;
}

export function decodeBake(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('not a Camping Season bake');
  const headerLen = dv.getUint32(4, true);
  const text = new TextDecoder().decode(new Uint8Array(buf, 8, headerLen)).replace(/\0+$/, '');
  const header = JSON.parse(text);
  const N = header.res * header.res;

  const out = {
    res: header.res,
    worldSize: header.worldSize,
    minHeight: header.minHeight,
    maxHeight: header.maxHeight,
    waterfalls: header.waterfalls,
    riverPolylines: header.riverPolylines,
    lakes: header.lakes,
  };

  let off = 8 + headerLen;
  for (const f of header.f32) {
    // Copy rather than view: the source buffer is not 4-byte aligned in general.
    out[f] = new Float32Array(buf.slice(off, off + N * 4));
    off += N * 4;
  }
  for (const { name, min, max } of header.u8) {
    const src = new Uint8Array(buf, off, N);
    const dst = new Float32Array(N);
    const s = (max - min) / 255;
    for (let i = 0; i < N; i++) dst[i] = min + src[i] * s;
    out[name] = dst;
    off += N;
  }
  {
    const src = new Uint8Array(buf, off, N);
    const dst = new Float32Array(N);
    const k = header.flowLogScale / 255;
    for (let i = 0; i < N; i++) dst[i] = Math.exp(src[i] * k) - 1;
    out.flow = dst;
    off += N;
  }
  return out;
}

/**
 * FNV-1a over the generator source. The cache key includes it so that the
 * moment TerrainGen.js changes, every stale bake simply misses and the world
 * is regenerated — an author tuning erosion can never be fooled into judging
 * a screenshot of the previous algorithm.
 */
export function sourceHash(src) {
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export const bakeFilename = (seed, res, hash) => `bakes/world-${seed}-${res}-${hash}.pab`;
