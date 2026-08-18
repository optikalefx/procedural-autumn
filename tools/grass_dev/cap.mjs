// Multi-view capture in ONE browser session, resilient to Vite full-reloads
// (peers are editing the same tree, which reloads the page mid-run).
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const VIEWS = {
  hero:{anchor:'vista',height:62,dist:150,pitch:-0.16,fov:46,hour:16.7},
  drive:{anchor:'road',height:4.2,dist:12,pitch:-0.10,fov:55,hour:16.7},
  meadow:{anchor:'meadow',height:1.6,dist:6,pitch:-0.05,fov:58,hour:17.2},
  forest:{anchor:'forest',height:3.0,dist:14,pitch:0.02,fov:60,hour:16.4},
  river:{anchor:'river',height:3.4,dist:16,pitch:-0.12,fov:54,hour:16.9},
  backlit:{anchor:'meadow',height:2.4,dist:10,pitch:0.04,fov:52,hour:17.9,faceSun:true},
  dawn:{anchor:'vista',height:48,dist:130,pitch:-0.13,fov:46,hour:7.4},
  // grass-specific: eye height in the meadow, and a shallow raking look
  low:{anchor:'meadow',height:1.2,dist:8,pitch:-0.02,fov:60,hour:17.2},
  lowsun:{anchor:'meadow',height:1.15,dist:8,pitch:0.02,fov:60,hour:17.9,faceSun:true},
  riverlow:{anchor:'river',height:1.4,dist:12,pitch:-0.02,fov:58,hour:16.9},
};

const argv = process.argv.slice(2);
const arg=(n,d)=>{const i=argv.indexOf('--'+n);return i===-1?d:argv[i+1];};
const dir = arg('dir','shots/grass/tmp');
const list = (arg('views','hero drive meadow forest river backlit dawn low lowsun riverlow')).split(/[\s,]+/);
const W=parseInt(arg('w','1600'),10), H=parseInt(arg('h','900'),10);
const pause = parseFloat(arg('pause','0'));
const hourOv = arg('hour', null);

mkdirSync(resolve(dir),{recursive:true});
const browser = await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--disable-frame-rate-limit']});
const page = await browser.newPage({viewport:{width:W,height:H},deviceScaleFactor:1});
page.on('pageerror', e=>console.log('PAGEERR', e.message));
page.on('console', m=>{ if(m.type()==='error') console.log('CONSOLE', m.text().slice(0,200)); });

async function ready(){
  await page.goto('http://localhost:5178',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
}
await ready();

const stats=[];
for(const name of list){
  const v={...VIEWS[name]}; if(!VIEWS[name]){console.log('skip',name);continue;}
  if(hourOv) v.hour=parseFloat(hourOv);
  for(let attempt=0;attempt<4;attempt++){
    try{
      const s = await page.evaluate(async (v)=>{
        const THREE=window.__THREE,e=window.__engine,wd=window.__world;
        window.__lighting.hour=v.hour; window.__lighting.cycleSpeed=0;
        const a=(window.__cameraAnchors[v.anchor]||window.__cameraAnchors.vista)();
        let yaw=a.yaw??0;
        if(v.faceSun){const sd=window.__lighting.sunDir;yaw=Math.atan2(sd.x,sd.z);}
        const gy=wd.getHeight(a.x,a.z)+v.height;
        e.camera.fov=v.fov;e.camera.updateProjectionMatrix();
        e.camera.position.set(a.x,gy,a.z);
        e.camera.lookAt(a.x+Math.sin(yaw)*v.dist,gy+Math.tan(v.pitch)*v.dist,a.z+Math.cos(yaw)*v.dist);
        window.__forceCamera=true;
        await window.__settle(70);
        const g=window.__systems.grass; let gc=0,gt=0,gi=0;
        if(g&&g.rings){
          const fr=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(e.camera.projectionMatrix,e.camera.matrixWorldInverse));
          const sp=new THREE.Sphere();
          for(const r of g.rings) for(const t of r.tiles){
            if(!t.mesh.visible) continue;
            sp.copy(t.geo.boundingSphere).applyMatrix4(t.mesh.matrixWorld);
            if(!fr.intersectsSphere(sp)) continue;
            gc++; gt+=t.geo.instanceCount*(t.geo.index.count/3); gi+=t.geo.instanceCount;
          }
        }
        const inf=e.renderer.info.render;
        return {fps:window.__fps,calls:inf.calls,tris:inf.triangles,gCalls:gc,gTris:gt,gInst:gi};
      }, v);
      if(pause) await page.waitForTimeout(pause*1000);
      await page.waitForTimeout(900);
      const out=resolve(dir,name+'.png');
      mkdirSync(dirname(out),{recursive:true});
      await page.screenshot({path:out});
      if(argv.includes('--twin')){ await page.waitForTimeout(1000); await page.screenshot({path:resolve(dir,name+'_b.png')}); }
      stats.push({view:name,...s});
      console.log('ok',name,JSON.stringify(s));
      break;
    }catch(err){
      console.log('retry',name,String(err.message).slice(0,90));
      await new Promise(r=>setTimeout(r,1500));
      try{ await ready(); }catch(e2){ /* keep trying */ }
    }
  }
}
console.log('STATS '+JSON.stringify(stats));
await browser.close();
