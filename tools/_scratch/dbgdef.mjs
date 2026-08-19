import { TerrainGen } from '../../src/world/TerrainGen.js';
globalThis.__DEFLUTE_DEBUG = { n:0, w:0, d:0 };
const RES=768,W=3072;
const g=new TerrainGen({res:RES,worldSize:W});
g.height=new Float32Array(RES*RES);g.hardness=new Float32Array(RES*RES);g.sediment=new Float32Array(RES*RES);
g._tectonic();g._erode(Math.round(RES*RES*0.22));g._relax();
const D=globalThis.__DEFLUTE_DEBUG;
console.log('cells touched', D.n, (100*D.n/(RES*RES)).toFixed(1)+'%', 'mean w', (D.w/D.n).toFixed(3), 'mean |delta| m', (D.d/D.n).toFixed(3));
