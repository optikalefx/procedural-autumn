// Offline winding audit for the cover library only. Same test as tools/winding.mjs.
import { buildCoverLibrary, COVER_ARCHETYPES } from '../../src/vegetation/cover_forms.js';
const lib = buildCoverLibrary(1337);
let bad = 0, totalTris = 0;
for (let ai = 0; ai < COVER_ARCHETYPES.length; ai++) {
  const arch = COVER_ARCHETYPES[ai];
  for (let v = 0; v < arch.variants; v++) {
    const g = lib.geoms[ai][v];
    const pos = g.attributes.position, nor = g.attributes.normal, idx = g.index;
    const triCount = idx.count / 3;
    totalTris += triCount;
    const step = Math.max(1, Math.floor(triCount / 400));
    let agree = 0, tested = 0;
    for (let t = 0; t < triCount; t += step) {
      const i0 = idx.getX(t*3), i1 = idx.getX(t*3+1), i2 = idx.getX(t*3+2);
      const ax=pos.getX(i0), ay=pos.getY(i0), az=pos.getZ(i0);
      const bx=pos.getX(i1), by=pos.getY(i1), bz=pos.getZ(i1);
      const cx=pos.getX(i2), cy=pos.getY(i2), cz=pos.getZ(i2);
      const ux=bx-ax, uy=by-ay, uz=bz-az, vx=cx-ax, vy=cy-ay, vz=cz-az;
      const gx=uy*vz-uz*vy, gy=uz*vx-ux*vz, gz=ux*vy-uy*vx;
      const gl=Math.hypot(gx,gy,gz); if (gl<1e-12) continue;
      const sx=nor.getX(i0)+nor.getX(i1)+nor.getX(i2);
      const sy=nor.getY(i0)+nor.getY(i1)+nor.getY(i2);
      const sz=nor.getZ(i0)+nor.getZ(i1)+nor.getZ(i2);
      const sl=Math.hypot(sx,sy,sz); if (sl<1e-9) continue;
      if ((gx*sx+gy*sy+gz*sz)/(gl*sl) > 0) agree++;
      tested++;
    }
    const ratio = agree/tested;
    const mark = ratio >= 0.5 ? ' ' : '✗';
    if (ratio < 0.5) bad++;
    console.log(`${mark} cover_${arch.key}_${v}  ${(ratio*100).toFixed(1)}% of ${tested}  (${triCount} tris)`);
  }
}
console.log(`\nlibrary base tris ${totalTris}, failing ${bad}`);
process.exit(bad ? 1 : 0);
