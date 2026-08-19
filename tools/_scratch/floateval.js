(() => {
  const T = window.__THREE;
  const rocks = Object.values(window.__systems).find(s => s && s.name === "Rocks");
  const terrain = window.__terrain;
  const world = window.__world;
  const cam = window.__engine.camera;
  const rc = new T.Raycaster(); rc.far = 5000;
  const meshes = terrain.group.children.filter(c => c.isMesh);
  const down = new T.Vector3(0, -1, 0), org = new T.Vector3();
  const hitY = (x, z) => { org.set(x, 900, z); rc.set(org, down); const hs = rc.intersectObjects(meshes, false); return hs.length ? hs[0].point.y : null; };
  const m = new T.Matrix4(), v = new T.Vector3(), c = new T.Vector3();
  const rows = [];
  const CRAG = ['cliff', 'tower', 'prow', 'bench', 'ledge'];
  for (const mesh of rocks.meshes) {
    if (!mesh.count) continue;
    const arch = mesh.userData.arch;
    if (!CRAG.includes(arch)) continue;
    const pos = mesh.geometry.attributes.position.array;
    const nv = pos.length / 3;
    const stride = 3 * Math.max(1, Math.floor(nv / 30));
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      let clear = Infinity, clearA = Infinity;
      for (let k = 0; k < pos.length; k += stride) {
        v.set(pos[k], pos[k + 1], pos[k + 2]).applyMatrix4(m);
        const gy = hitY(v.x, v.z);
        if (gy !== null) { const g = v.y - gy; if (g < clear) clear = g; }
        const ga = v.y - world.getHeight(v.x, v.z); if (ga < clearA) clearA = ga;
      }
      if (!isFinite(clear)) continue;
      c.setFromMatrixPosition(m);
      const lodC = terrain.lodForDistance(Math.hypot(c.x - cam.position.x, c.z - cam.position.z));
      rows.push({ clear, clearA, arch, d: c.distanceTo(cam.position), lod: lodC, x: c.x, y: c.y, z: c.z });
    }
  }
  rows.sort((a, b) => b.clear - a.clear);
  const fmt = (l) => { if (!l.length) return 'none'; const f = l.filter(r => r.clear > 0).length; const s = l.reduce((a, r) => a + (r.clear - r.clearA), 0) / l.length; return `n=${l.length} float>0 ${f}(${(100 * f / l.length) | 0}%) >3m ${l.filter(r => r.clear > 3).length} worstRendered ${l[0].clear.toFixed(1)} worstAnalytic ${Math.max(...l.map(r => r.clearA)).toFixed(1)} meanSag ${s.toFixed(1)}`; };
  const out = { total: rows.length };
  for (const [a, b] of [[0, 400], [400, 700], [700, 1000], [1000, 2000]]) out[`d${a}_${b}`] = fmt(rows.filter(r => r.d >= a && r.d < b));
  for (const L of [0, 1, 2, 3, 4]) { const l = rows.filter(r => r.lod === L); if (l.length) out[`lod${L}`] = fmt(l); }
  out.worst = rows.slice(0, 10).map(r => `${r.arch} clr${r.clear.toFixed(1)} ana${r.clearA.toFixed(1)} d${r.d | 0} lod${r.lod} @${r.x | 0},${r.z | 0}`);
  console.error('FLOATREPORT ' + JSON.stringify(out));
})()
