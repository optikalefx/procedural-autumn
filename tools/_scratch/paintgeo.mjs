// Third stage: camper_paint draws the NaN. Is it the geometry or the material?
import { chromium } from 'playwright';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const PORT=arg('port','5178');
await acquire('nanhunt');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization']});
const page=await browser.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,200)));
await page.routeWebSocket(new RegExp(`^wss?://(localhost|127\\.0\\.0\\.1):${PORT}/`),()=>{});
await page.goto(`http://127.0.0.1:${PORT}/?res=768`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
await page.waitForTimeout(1200);
const out=await page.evaluate(()=>{
  const e=window.__engine;
  const S=window.__systems??window.__ctx.systems??{};
  const rig=S.vehicle?.group ?? e.scene.getObjectByName('vehicleRig');
  const report={};
  rig.traverse(o=>{
    if(!(o.isMesh||o.isInstancedMesh)) return;
    const g=o.geometry; const pos=g.getAttribute('position'), nor=g.getAttribute('normal');
    const idx=g.getIndex();
    let nanPos=0,nanNor=0,zeroNor=0,degen=0,shortNor=0;
    if(pos) for(let i=0;i<pos.count;i++){ const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);
      if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z)) nanPos++; }
    if(nor) for(let i=0;i<nor.count;i++){ const x=nor.getX(i),y=nor.getY(i),z=nor.getZ(i);
      if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(z)){nanNor++;continue;}
      const L=Math.hypot(x,y,z); if(L===0) zeroNor++; else if(L<0.5) shortNor++; }
    // degenerate triangles: zero area
    const tri=(a,b,c)=>{ const ax=pos.getX(a),ay=pos.getY(a),az=pos.getZ(a);
      const bx=pos.getX(b),by=pos.getY(b),bz=pos.getZ(b), cx=pos.getX(c),cy=pos.getY(c),cz=pos.getZ(c);
      const ux=bx-ax,uy=by-ay,uz=bz-az, vx=cx-ax,vy=cy-ay,vz=cz-az;
      const nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
      return Math.hypot(nx,ny,nz)*0.5; };
    const n=idx?idx.count:pos.count;
    for(let i=0;i+2<n;i+=3){ const a=idx?idx.getX(i):i,b=idx?idx.getX(i+1):i+1,c=idx?idx.getX(i+2):i+2;
      if(tri(a,b,c)<1e-12) degen++; }
    const key=o.name||'(unnamed)';
    const r=report[key]??={verts:0,tris:0,nanPos:0,nanNor:0,zeroNor:0,shortNor:0,degen:0,meshes:0};
    r.meshes++; r.verts+=pos?pos.count:0; r.tris+=Math.floor(n/3);
    r.nanPos+=nanPos; r.nanNor+=nanNor; r.zeroNor+=zeroNor; r.shortNor+=shortNor; r.degen+=degen;
  });
  return report;
});
console.log('geometry scan of the vehicle rig (per material name):');
for(const [k,v] of Object.entries(out)){
  const flag=(v.nanPos||v.nanNor||v.zeroNor||v.degen)?'  <<<':'';
  console.log(`  ${k.padEnd(20)} meshes=${String(v.meshes).padStart(2)} verts=${String(v.verts).padStart(6)} tris=${String(v.tris).padStart(6)}  nanPos=${v.nanPos} nanNor=${v.nanNor} zeroNor=${v.zeroNor} shortNor=${v.shortNor} degenTris=${v.degen}${flag}`);
}
await browser.close();
