// Find the hard-edged black rectangle, then take it apart in the same frame.
//
// The artefact is a solid, axis-aligned, pure-black rectangle sitting on top of
// a completely correct render. It survives an immediate re-render, so once a
// frame has one it can be bisected: hide one system, render the identical
// frame again, and see whether the rectangle is still there. Hiding the object
// is the test — a material override only proves one material path is not the
// one drawing it.
import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { acquire } from '../_lock.mjs';
const argv=process.argv.slice(2); const arg=(n,d=null)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const RES=arg('res','768'), VIEW=arg('view','drive');
const W=parseInt(arg('w','1280'),10), H=parseInt(arg('h','720'),10);
const TRIES=parseInt(arg('tries','400'),10), OUT=arg('out','shots/perf/square');
const VIEWS={
  hero:{anchor:'vista',height:62,dist:150,pitch:-0.16,fov:46,hour:16.7},
  drive:{anchor:'road',height:4.2,dist:12,pitch:-0.10,fov:55,hour:16.7,standOff:16},
  meadow:{anchor:'meadow',height:1.6,dist:6,pitch:-0.05,fov:58,hour:17.2},
  forest:{anchor:'forest',height:3.0,dist:14,pitch:0.02,fov:60,hour:16.4},
  river:{anchor:'river',height:5.2,dist:26,pitch:-0.16,fov:54,hour:16.9,yawOffset:0.42},
  waterfall:{anchor:'waterfall',height:11,dist:58,pitch:0.08,fov:50,hour:16.2,yawOffset:-0.55},
  backlit:{anchor:'meadow',height:2.4,dist:10,pitch:0.04,fov:52,hour:17.9,faceSun:true},
};
const frozen = existsSync('shots/_anchors.json') ? JSON.parse(readFileSync('shots/_anchors.json','utf8')) : {};
await acquire('squarehunt');
const browser=await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--enable-gpu-rasterization','--disable-frame-rate-limit']});
const page=await browser.newPage({viewport:{width:W,height:H},deviceScaleFactor:1});
page.on('pageerror',e=>console.log('PAGEERROR',String(e.message).slice(0,160)));
await page.routeWebSocket(/^wss?:\/\/(localhost|127\.0\.0\.1):5178\//, () => {});
await page.goto(`http://localhost:5178/?res=${RES}`,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__ready===true,null,{timeout:300000,polling:250});
await page.evaluate(async ({v,frozen})=>{
  const THREE=window.__THREE, e=window.__engine, wd=window.__world, api=window.__cameraAnchors||{};
  window.__lighting.hour=v.hour; window.__lighting.cycleSpeed=0;
  const anchor = frozen[v.anchor] ?? (api[v.anchor]||api.vista)();
  let yaw=(anchor.yaw??0)+(v.yawOffset??0);
  if(v.faceSun){const sd=window.__lighting.sunDir; yaw=Math.atan2(sd.x,sd.z);}
  const back=v.standOff??0; const gx=anchor.x-Math.sin(yaw)*back, gz=anchor.z-Math.cos(yaw)*back;
  const gy=wd.getHeight(gx,gz)+v.height;
  e.camera.fov=v.fov; e.camera.updateProjectionMatrix();
  e.camera.position.set(gx,gy,gz);
  e.camera.lookAt(gx+Math.sin(yaw)*v.dist, gy+Math.tan(v.pitch)*v.dist, gz+Math.cos(yaw)*v.dist);
  window.__forceCamera=true; window.dispatchEvent(new Event('resize'));
  if(window.__settle) await window.__settle(120);
},{v:VIEWS[VIEW],frozen});
const r=await page.evaluate((TRIES)=>new Promise((resolve)=>{
  const e=window.__engine, ctx=window.__ctx, pf=ctx.postfx, r=e.renderer, gl=r.getContext();
  // readPixels does not scale: asking for 200x112 reads a 200x112 CORNER of the
  // frame, which is how an earlier pass of this tool looked at 600 frames and
  // saw nothing. Read the whole buffer, then subsample in JS.
  const FW=gl.drawingBufferWidth, FH=gl.drawingBufferHeight;
  const full=new Uint8Array(FW*FH*4);
  const STEP=4;
  const GW=Math.floor(FW/STEP), GH=Math.floor(FH/STEP);
  const scan=()=>{ gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    gl.readPixels(0,0,FW,FH,gl.RGBA,gl.UNSIGNED_BYTE,full);
    let n=0,x0=1e9,y0=1e9,x1=-1,y1=-1;
    for(let y=0;y<GH;y++){ const fy=y*STEP;
      for(let x=0;x<GW;x++){ const i=(fy*FW+x*STEP)*4;
        if(full[i]+full[i+1]+full[i+2] < 10){ n++; if(x<x0)x0=x; if(x>x1)x1=x; if(y<y0)y0=y; if(y>y1)y1=y; } } }
    if(!n) return {n:0};
    const bw=x1-x0+1, bh=y1-y0+1;
    return {n, frac:n/(GW*GH), box:[x0*STEP,y0*STEP,bw*STEP,bh*STEP], fill:n/(bw*bh)}; };
  const hide=(o)=>{ if(!o) return ()=>{}; const was=o.visible; o.visible=false; return ()=>{o.visible=was;}; };
  const S=window.__systems;
  // Post-chain trials: a single NaN pixel in the HDR buffer comes back out of a
  // blur as an axis-aligned block, which is what this artefact looks like. If
  // shortening the bloom chain removes it, the square is one bad pixel being
  // spread, not something that is actually drawn square.
  const postTrials=()=>{
    const b=window.__ctx.postfx.bloom, ao=window.__ctx.postfx.ao, dof=window.__ctx.postfx.dof;
    const L=b.mipmapBlurPass.levels;
    return [
      ['post: bloom levels 1', ()=>{b.mipmapBlurPass.levels=1;}, ()=>{b.mipmapBlurPass.levels=L;}],
      ['post: bloom opacity 0', ()=>{b.blendMode.opacity.value=0;}, ()=>{b.blendMode.opacity.value=1;}],
      ['post: dof opacity 0', ()=>{if(dof)dof.blendMode.opacity.value=0;}, ()=>{if(dof)dof.blendMode.opacity.value=1;}],
      ['post: ao off', ()=>{if(ao)ao.enabled=false;}, ()=>{if(ao)ao.enabled=true;}],
    ]; };
  const candidates=()=>[
    ['weather.leaves', S.weather?.leaves?.mesh],
    ['weather.motes', S.weather?.motes?.points],
    ['weather.shafts', S.weather?.shafts?.mesh ?? S.weather?.shafts?.group],
    ['vehicleFX particles', e.scene.getObjectByName('vehicleParticles')],
    ['vehicleFX tracks', e.scene.getObjectByName('tyreTracks')],
    ['vehicle whole rig', S.vehicle?.group ?? e.scene.getObjectByName('vehicleRig')],
    ['trees near+mid', S.trees?.group],
    ['trees impostors only', S.trees?.farMesh],
    ['wildlife', S.wildlife?.group],
    ['birds', S.wildlife?.birds?.group],
    ['grass', S.grass?.group],
    ['groundCover', S.groundCover?.group],
    ['rocks', S.rocks?.group],
    ['water', S.water?.group ?? e.scene.getObjectByName('Water')],
    ['waterfalls', S.waterfalls?.group],
    ['clouds', S.clouds?.group],
    ['sky', ctx.sky?.mesh ?? e.scene.getObjectByName('Sky')],
    ['terrain', ctx.terrain?.group],
  ];
  let tries=0;
  const input=ctx.input; const t0=performance.now();
  const drive=()=>{ if(!window.__squareDone){ const t=(performance.now()-t0)/1000;
    input.axes.throttle=1; input.axes.brake=0; input.axes.steer=Math.sin(t*0.42)*0.75;
    requestAnimationFrame(drive); } };
  if(window.__squareDrive){ window.__forceCamera=false; drive(); }
  const step=()=>{
    const a=scan();
    // A solid rectangle covering between 0.05% and 60% of the frame, not the
    // whole picture going dark.
    if(a.n && a.fill>0.85 && a.frac>0.0005 && a.frac<0.6){
      const trials=[];
      const verdict=()=>{ const b=scan(); return b.n && b.fill>0.85 && b.frac>0.0005
        ? `still there ${JSON.stringify(b.box)}` : 'GONE'; };
      for(const [label,on,off] of postTrials()){
        on(); pf.render(0.016); const v=verdict(); off(); trials.push([label,v]);
      }
      for(const [label,obj] of candidates()){
        if(!obj){ trials.push([label,'not found']); continue; }
        const undo=hide(obj); pf.render(0.016); const v=verdict(); undo();
        trials.push([label, v]);
      }
      // Narrow inside grass: one ring, then one tile.
      const rings=S.grass?.rings ?? [];
      for(let ri=0; ri<rings.length; ri++){
        const undo=hide(rings[ri].group ?? rings[ri].mesh);
        if(rings[ri].group||rings[ri].mesh){ pf.render(0.016); trials.push([`grass ring ${ri}`, verdict()]); }
        undo();
      }
      // Where is the bad value? The composer buffer is half-float, so it has to
      // be read as uint16 and decoded: exponent 31 is Inf or NaN.
      const hdrProbe=()=>{ try{
        const rt=pf.composer.inputBuffer;
        const w=rt.width, h=rt.height;
        const buf=new Uint16Array(w*h*4);
        r.readRenderTargetPixels(rt,0,0,w,h,buf);
        let bad=0; const where=[];
        for(let i=0;i<buf.length;i++){ if(((buf[i]>>10)&0x1f)===0x1f){ bad++;
          if(where.length<8){ const px=(i>>2); where.push([px%w, (px/w)|0, ['r','g','b','a'][i&3],
            (buf[i]&0x3ff)?'NaN':'Inf']); } } }
        return {w,h,bad,where};
      }catch(err){ return {err:String(err).slice(0,80)}; } };
      const hdr=hdrProbe();
      // The count of non-finite channels is a far sharper probe than the black
      // block: it survives any change to the post chain, and it says whether a
      // term produced the NaN rather than whether the bloom happened to spread
      // it this frame.
      const gm=S.grass?.rings?.[0]?.material;
      const gu=gm?.userData?.uniforms ?? S.grass?.uniforms;
      const nanTrials=[];
      if(gu){
        const probe=(label,set,unset)=>{ set(); pf.render(0.016);
          nanTrials.push([label, hdrProbe().bad]); unset(); };
        for(const d of [1,2,3,4,5]){
          if(!gu.uDebug) break;
          probe(`grass uDebug=${d}`, ()=>{gu.uDebug.value=d;}, ()=>{gu.uDebug.value=0;});
        }
      }
      window.__squareDone=true;
      pf.render(0.016);
      const again=scan();
      resolve({found:true, tries, box:a.box, frac:a.frac, fill:a.fill, grid:[FW,FH], hdr,
        reproducible:!!(again.n&&again.fill>0.85), trials, nanTrials, hasUniforms:!!gu});
      return;
    }
    if(++tries>=TRIES){ window.__squareDone=true; resolve({found:false, tries}); return; }
    requestAnimationFrame(step);
  };
  step();
}),TRIES);
if(r.found){ mkdirSync(OUT,{recursive:true}); writeFileSync(`${OUT}/hit-${VIEW}.png`, await page.screenshot()); }
await browser.close();
if(!r.found){ console.log(`no black rectangle in ${r.tries} frames of view ${VIEW}`); process.exit(0); }
console.log(`black rectangle found after ${r.tries} frames of view ${VIEW}`);
console.log(`  frame ${r.grid[0]}x${r.grid[1]}  box ${JSON.stringify(r.box)}  ${(100*r.frac).toFixed(2)}% of frame, fill ${r.fill.toFixed(2)}`);
console.log(`  survives an immediate re-render: ${r.reproducible}`);
if(r.hdr) console.log(`  scene HDR buffer ${r.hdr.w}x${r.hdr.h}: ${r.hdr.bad} non-finite channels${r.hdr.err?' '+r.hdr.err:''}`
  + (r.hdr.where&&r.hdr.where.length?`\n    first few: ${r.hdr.where.map(w=>`(${w[0]},${w[1]}).${w[2]}=${w[3]}`).join('  ')}`:''));
if(r.nanTrials&&r.nanTrials.length){ console.log('\n  non-finite HDR channels with the grass debug output forced:');
  for(const [k,v] of r.nanTrials) console.log(`    ${k.padEnd(24)} ${v}`); }
else console.log(`\n  (grass uniforms reachable: ${r.hasUniforms})`);
console.log('\n  hide one object, render the same frame again:');
for(const [k,v] of r.trials) console.log(`    ${k.padEnd(24)} ${v}`);
