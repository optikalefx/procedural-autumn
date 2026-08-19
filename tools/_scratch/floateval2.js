(() => {
  const T = window.__THREE;
  const rocks = Object.values(window.__systems).find(s => s && s.name === "Rocks");
  const terrain = window.__terrain;
  const cam = window.__engine.camera;
  const rc = new T.Raycaster(); rc.far = 6000;
  const meshes = terrain.group.children.filter(c => c.isMesh);
  const dir = new T.Vector3(), m = new T.Matrix4(), v = new T.Vector3(), c = new T.Vector3();
  const rows = [];
  const CRAG = ['cliff', 'tower', 'prow', 'bench', 'ledge'];
  for (const mesh of rocks.meshes) {
    if (!mesh.count) continue;
    const arch = mesh.userData.arch;
    if (!CRAG.includes(arch)) continue;
    const pos = mesh.geometry.attributes.position.array;
    const nv = pos.length / 3;
    const stride = 3 * Math.max(1, Math.floor(nv / 40));
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      c.setFromMatrixPosition(m);
      // Only blocks actually inside the frustum matter.
      const ndc = c.clone().project(cam);
      if (Math.abs(ndc.x) > 1.1 || Math.abs(ndc.y) > 1.1 || ndc.z > 1) continue;
      let occluded = 0, tested = 0, minBehind = Infinity, sky = 0;
      for (let k = 0; k < pos.length; k += stride) {
        v.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(m);
        dir.copy(v).sub(cam.position);
        const dv = dir.length(); dir.divideScalar(dv);
        rc.set(cam.position, dir);
        const hs = rc.intersectObjects(meshes, false);
        tested++;
        if (!hs.length) { sky++; continue; }
        const behind = hs[0].distance - dv;
        if (behind <= 0) occluded++;
        if (behind < minBehind) minBehind = behind;
      }
      if (!tested) continue;
      rows.push({ arch, occ: occluded, tested, sky, minBehind: isFinite(minBehind) ? minBehind : 9999,
        d: c.distanceTo(cam.position), x: c.x, y: c.y, z: c.z });
    }
  }
  const detached = rows.filter(r => r.occ === 0);
  detached.sort((a, b) => b.minBehind - a.minBehind);
  const out = {
    inFrustum: rows.length,
    noVisibleContact: detached.length,
    pct: rows.length ? +(100 * detached.length / rows.length).toFixed(0) : 0,
    gapBands: [10, 25, 50, 100, 200].map(g => `>${g}m:${detached.filter(r => r.minBehind > g).length}`).join(' '),
    worst: detached.slice(0, 12).map(r => `${r.arch} gap${r.minBehind | 0}m sky${r.sky}/${r.tested} d${r.d | 0} @${r.x | 0},${r.y | 0},${r.z | 0}`),
  };
  console.error('CONTACT ' + JSON.stringify(out));
})()
