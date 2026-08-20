/**
 * Shared camera posing for the capture tools.
 *
 * shot.mjs, skystrip.mjs and now tod.mjs each had their own copy of "resolve
 * the anchor, stand on it, clear the near field". The copies drifted — skystrip
 * never got the near-field raycast, so a strip could be shot from inside a
 * thicket while the still of the same view was clear. One implementation.
 *
 * Runs inside the page. Import it for POSE_SRC and hand that to
 * `page.evaluate(new Function('P', src), payload)`.
 */
export const POSE_SRC = `
const THREE = window.__THREE;
const e = window.__engine, wd = window.__world;
const api = window.__cameraAnchors || {};
const v = P.v;

let yaw, pos, look;
const cached = (P.frozen && !P.dynamic.includes(v.anchor)) ? P.frozen[v.anchor] : null;
const anchor = cached ?? (
  (v.index && window.__anchorAt)
    ? window.__anchorAt(v.anchor, v.index)
    : (api[v.anchor] || api.vista || (() => ({ x: 0, z: 0, yaw: 0 })))()
);
yaw = (anchor.yaw ?? 0) + (v.yawOffset ?? 0);
if (v.faceSun) { const sd = window.__lighting.sunDir; yaw = Math.atan2(sd.x, sd.z); }
if (v.faceMoon) {
  // Lighting does not keep a moonDir field on the instance the way it keeps
  // sunDir — the moon is published on SKY_STATE, which is a module export and
  // not on window. Ask the instance to compute it; fall back to anti-solar so
  // a faceMoon view is never silently the same shot as a faceSun one.
  const L = window.__lighting;
  const md = L.moonDir ?? (L.computeMoonDir ? L.computeMoonDir(L.hour) : null);
  if (md) yaw = Math.atan2(md.x, md.z);
  else { const sd = L.sunDir; yaw = Math.atan2(-sd.x, -sd.z); }
}

if (v.subject) {
  const gx = anchor.x - Math.sin(yaw) * v.dist;
  const gz = anchor.z - Math.cos(yaw) * v.dist;
  const gy = wd.getHeight(gx, gz) + v.height;
  pos = new THREE.Vector3(gx, gy, gz);
  const ty = wd.getHeight(anchor.x, anchor.z) + (anchor.lookY ?? 1.4);
  look = new THREE.Vector3(anchor.x, ty, anchor.z);
} else {
  const back = v.standOff ?? 0;
  const gx = anchor.x - Math.sin(yaw) * back;
  const gz = anchor.z - Math.cos(yaw) * back;
  const gy = wd.getHeight(gx, gz) + v.height;
  pos = new THREE.Vector3(gx, gy, gz);
  look = new THREE.Vector3(
    gx + Math.sin(yaw) * v.dist,
    gy + Math.tan(v.pitch) * v.dist,
    gz + Math.cos(yaw) * v.dist
  );
}

// Clear the near field: anchors are scored on terrain and happily land inside
// a thicket or behind a trunk.
if (window.__THREE) {
  const ray = new THREE.Raycaster();
  ray.far = 6;
  const dir = new THREE.Vector3();
  for (let attempt = 0; attempt < 6; attempt++) {
    dir.copy(look).sub(pos).normalize();
    ray.set(pos, dir);
    const hits = ray.intersectObjects(e.scene.children, true)
      .filter((h) => h.distance > 0.05 && h.object.visible &&
                     h.object.name !== 'Sky' && !h.object.isPoints);
    if (!hits.length || hits[0].distance > 3.0) break;
    pos.y += 2.2;
    pos.addScaledVector(dir, -2.0);
    look.y += 0.7;
  }
  const g = wd.getHeight(pos.x, pos.z) + 1.4;
  if (pos.y < g) pos.y = g;
}

e.camera.fov = v.fov ?? 50;
e.camera.updateProjectionMatrix();
e.camera.position.copy(pos);
e.camera.lookAt(look);
window.__forceCamera = true;
window.__posedYaw = yaw;
window.dispatchEvent(new Event('resize'));
return { x: pos.x, y: pos.y, z: pos.z, yaw };
`;
