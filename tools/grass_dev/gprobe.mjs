import { chromium } from 'playwright';
const view = process.argv[2] || 'meadow';
const VIEWS = {
  hero:{anchor:'vista',height:62,dist:150,pitch:-0.16,fov:46,hour:16.7},
  drive:{anchor:'road',height:4.2,dist:12,pitch:-0.10,fov:55,hour:16.7},
  meadow:{anchor:'meadow',height:1.6,dist:6,pitch:-0.05,fov:58,hour:17.2},
  river:{anchor:'river',height:3.4,dist:16,pitch:-0.12,fov:54,hour:16.9},
  backlit:{anchor:'meadow',height:2.4,dist:10,pitch:0.04,fov:52,hour:17.9,faceSun:true},
};
const b = await chromium.launch({args:['--use-gl=angle','--use-angle=metal','--ignore-gpu-blocklist','--disable-frame-rate-limit']});
const p = await b.newPage({viewport:{width:1600,height:900},deviceScaleFactor:1});
p.on('pageerror', e=>console.log('ERR',e.message));
await p.goto('http://localhost:5178');
await p.waitForFunction(()=>window.__ready===true,null,{timeout:200000,polling:300});
console.log(await p.evaluate(async (v)=>{
  const THREE=window.__THREE, e=window.__engine, wd=window.__world;
  window.__lighting.hour=v.hour; window.__lighting.cycleSpeed=0;
  const a=(window.__cameraAnchors[v.anchor]||window.__cameraAnchors.vista)();
  let yaw=a.yaw??0;
  if(v.faceSun){const sd=window.__lighting.sunDir; yaw=Math.atan2(sd.x,sd.z);}
  const gy=wd.getHeight(a.x,a.z)+v.height;
  e.camera.fov=v.fov; e.camera.updateProjectionMatrix();
  e.camera.position.set(a.x,gy,a.z);
  e.camera.lookAt(a.x+Math.sin(yaw)*v.dist, gy+Math.tan(v.pitch)*v.dist, a.z+Math.cos(yaw)*v.dist);
  window.__forceCamera=true;
  await window.__settle(90);
  const inf=e.renderer.info.render;
  const total={calls:inf.calls,tris:inf.triangles};
  // grass-only pass
  const g=window.__systems.grass;
  let gc=0,gt=0,inst=0;
  const fr=new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(e.camera.projectionMatrix,e.camera.matrixWorldInverse));
  const sp=new THREE.Sphere();
  for(const r of g.rings) for(const t of r.tiles){
    if(!t.mesh.visible) continue;
    sp.copy(t.geo.boundingSphere).applyMatrix4(t.mesh.matrixWorld);
    if(!fr.intersectsSphere(sp)) continue;
    gc++; gt += t.geo.instanceCount*(t.geo.index.count/3); inst+=t.geo.instanceCount;
  }
  await window.__settle(60);
  return JSON.stringify({fps:window.__fps,total,grassCalls:gc,grassTris:gt,grassInstances:inst,err:window.__bootError});
}, VIEWS[view]));
await b.close();
