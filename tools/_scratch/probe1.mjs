import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const FROZEN = JSON.parse(readFileSync('review/anchors.json','utf8'));
const b = await chromium.launch();
const p = await b.newPage({ viewport:{width:1600,height:900} });
p.on('console',m=>{if(m.type()==='error')console.error('CONSOLE',m.text().slice(0,200));});
p.on('pageerror',e=>console.error('PAGEERR',String(e).slice(0,300)));
  // Vite's HMR client will reload the page under us the moment anything in the
  // tree is touched — and a measurement run edits shaders by definition. Same
  // stub shot.mjs installs.
  await p.addInitScript(() => {
    const RealWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      if (typeof url === 'string' && /[?&]token=|vite-hmr|__vite/.test(url)) {
        return { readyState: 3, url, close() {}, send() {}, addEventListener() {},
                 removeEventListener() {}, set onopen(_) {}, set onclose(_) {},
                 set onerror(_) {}, set onmessage(_) {} };
      }
      return new RealWS(url, protocols);
    };
    window.WebSocket.prototype = RealWS.prototype;
    Object.assign(window.WebSocket, RealWS);
  });
await p.goto(process.env.AUTUMN_URL, { waitUntil:'domcontentloaded' });
await p.waitForFunction(()=>window.__ready===true,null,{timeout:240000,polling:250});
const r = await p.evaluate(async (F)=>{
  const THREE=window.__THREE,e=window.__engine,wd=window.__world;
  const v={anchor:'river',height:6,dist:30,pitch:-0.18,fov:54,hour:16.9,yawOffset:0.42,index:3};
  window.__lighting.hour=v.hour; window.__lighting.cycleSpeed=0;
  const a=F[v.anchor];
  const yaw=a.yaw+v.yawOffset;
  const gy=wd.getHeight(a.x,a.z)+v.height;
  const pos=new THREE.Vector3(a.x,gy,a.z);
  const look=new THREE.Vector3(a.x+Math.sin(yaw)*v.dist,gy+Math.tan(v.pitch)*v.dist,a.z+Math.cos(yaw)*v.dist);
  e.camera.fov=v.fov;e.camera.updateProjectionMatrix();e.camera.position.copy(pos);e.camera.lookAt(look);
  window.__forceCamera=true;window.dispatchEvent(new Event('resize'));
  if(window.__settleStable) await window.__settleStable();
  for(const n of ['Trees','Grass','GroundCover','Weather']){const o=e.scene.getObjectByName(n);if(o)o.visible=false;}
  await window.__settle?.(30);
  const W=window.__world;
  const grp=e.scene.getObjectByName('Water');
  let meshes=0, names=new Set();
  grp?.traverse(o=>{if(o.isMesh){meshes++;names.add(o.name+':'+(o.visible?'v':'h')+':'+(o.geometry?.attributes?.position?.count||0));}});
  const ray=new THREE.Raycaster(); ray.far=3000;
  const hits=[];
  for(let i=0;i<12;i++){
    const sx=(i%4+0.5)/4, sy=(Math.floor(i/4)+0.5)/3;
    ray.setFromCamera(new THREE.Vector2(sx*2-1,1-sy*2), e.camera);
    const h=ray.intersectObjects(e.scene.children,true).filter(x=>x.object.visible&&x.object.name!=='Sky'&&!x.object.isPoints);
    hits.push(h.slice(0,2).map(x=>x.object.name+'@'+x.distance.toFixed(1)).join(' | '));
  }
  return {meshes, names:[...names].slice(0,6), hits};
}, FROZEN);
console.log(JSON.stringify(r,null,1));
await b.close();
