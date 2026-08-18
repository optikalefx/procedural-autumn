// Web-worker entry: bakes the world off the main thread.
import { TerrainGen } from './TerrainGen.js';

self.onmessage = (e) => {
  const opts = e.data;
  const gen = new TerrainGen({
    ...opts,
    onProgress: (p, label) => self.postMessage({ type: 'progress', p, label }),
  });
  const t0 = performance.now();
  const data = gen.generate();
  const ms = performance.now() - t0;

  const transfer = [
    data.height.buffer, data.water.buffer, data.riverMask.buffer,
    data.flow.buffer, data.moisture.buffer, data.hardness.buffer,
    data.sediment.buffer, data.slope.buffer,
  ];
  self.postMessage({ type: 'done', data, ms }, transfer);
};
