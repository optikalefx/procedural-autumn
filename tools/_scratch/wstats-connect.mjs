import { chromium } from 'playwright';
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist']});
const p = await b.newPage({viewport:{width:800,height:450}});
await p.goto('http://localhost:5178');
await p.waitForFunction(()=>window.__ready===true,{timeout:180000});
console.log(JSON.stringify(await p.evaluate(()=>{
  const w=window.__systems?.find?.(s=>s.name==='Water') ?? window.__systems?.water;
  const list = Array.isArray(window.__systems)?window.__systems:Object.values(window.__systems||{});
  const wt = list.find(s=>s?.name==='Water');
  return { riverTriangles: wt?.riverTriangles, lakeTriangles: wt?.lakeTriangles, lakeQuads: wt?.lakeQuads,
           meshes: wt?._meshes?.length, polys: window.__world?.riverPolylines?.length };
}),null,1));
await b.close();
