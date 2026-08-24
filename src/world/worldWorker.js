// Web-worker entry: bakes the world off the main thread.
import { TerrainGen } from './TerrainGen.js';
import { encodeBake } from './bakeFormat.js';

self.onmessage = (e) => {
  const opts = e.data;
  const gen = new TerrainGen({
    ...opts,
    onProgress: (p, label) => self.postMessage({ type: 'progress', p, label }),
  });
  const t0 = performance.now();
  const data = gen.generate();
  const ms = performance.now() - t0;

  // Encode here rather than on the main thread. main.js stores this buffer so
  // a seed is only ever generated once per device — a live bake costs a player
  // over a minute of loading screen — and serialising 44 MB on the main thread
  // would stall the very first frame it is trying to get to. Failure is not
  // fatal: caching is an optimisation, the world is already in `data`.
  let encoded = null;
  try { encoded = encodeBake(data); } catch (e) { console.warn('[worker] bake not encodable, will not be cached:', e.message); }

  const transfer = [
    data.height.buffer, data.water.buffer, data.riverMask.buffer,
    data.flow.buffer, data.moisture.buffer, data.hardness.buffer,
    data.sediment.buffer, data.slope.buffer, data.distToWaterM.buffer,
    data.flowVX.buffer, data.flowVZ.buffer, data.flowQ.buffer, data.flowT.buffer,
  ];
  if (encoded) transfer.push(encoded);
  self.postMessage({ type: 'done', data, ms, encoded }, transfer);
};
