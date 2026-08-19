#!/usr/bin/env node
// Region pixel sampler for tree iteration. Minimal PNG decoder (no deps, no
// capture slot) so it can be run freely alongside captures.
import fs from 'node:fs'; import zlib from 'node:zlib';

function decode(buf) {
  let p = 8, w=0,h=0,bd=0,ct=0; const idat=[];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p+4, p+8);
    const data = buf.subarray(p+8, p+8+len);
    if (type === 'IHDR') { w=data.readUInt32BE(0); h=data.readUInt32BE(4); bd=data[8]; ct=data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8) throw new Error('bit depth ' + bd);
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 4 ? 2 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let o = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[o++]; const line = raw.subarray(o, o + stride); o += stride;
    const cur = out.subarray(y*stride, (y+1)*stride);
    const prev = y ? out.subarray((y-1)*stride, y*stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i-ch] : 0, b = prev ? prev[i] : 0, c = (prev && i>=ch) ? prev[i-ch] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a+b)>>1;
      else if (f === 4) { const pa=Math.abs(b-c), pb=Math.abs(a-c), pc=Math.abs(a+b-2*c);
        v += (pa<=pb && pa<=pc) ? a : (pb<=pc ? b : c); }
      cur[i] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

const [, , file, ...regs] = process.argv;
const img = decode(fs.readFileSync(file));
console.log(file, img.w + 'x' + img.h);
const hex = (r,g,b) => '#' + [r,g,b].map((v)=>(v|0).toString(16).padStart(2,'0')).join('');
for (const r of regs) {
  const [x0,y0,x1,y1] = r.split(',').map(Number);
  let n=0,R=0,G=0,B=0, minL=1e9, min=[0,0,0], maxL=-1, max=[0,0,0];
  const ls=[];
  for (let y=y0;y<Math.min(y1,img.h);y++) for (let x=x0;x<Math.min(x1,img.w);x++) {
    const i=(y*img.w+x)*img.ch; const rr=img.data[i],gg=img.data[i+1],bb=img.data[i+2];
    R+=rr;G+=gg;B+=bb;n++; const L=(0.2126*rr+0.7152*gg+0.0722*bb)/255; ls.push(L);
    if(L<minL){minL=L;min=[rr,gg,bb];} if(L>maxL){maxL=L;max=[rr,gg,bb];}
  }
  ls.sort((a,b)=>a-b);
  const q=(t)=>ls[Math.min(ls.length-1,Math.max(0,Math.round(t*(ls.length-1))))].toFixed(3);
  console.log(`  [${r}] n=${n} mean ${hex(R/n,G/n,B/n)} srgb(${(R/n)|0},${(G/n)|0},${(B/n)|0})`
    + `  L p05=${q(0.05)} p50=${q(0.5)} p95=${q(0.95)}  darkest ${hex(...min)} brightest ${hex(...max)}`);
}
