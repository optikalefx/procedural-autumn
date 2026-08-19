// Hillshade a window of the baked heightfield at full res, no renderer.
import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { decodeBake } from '../../src/world/bakeFormat.js';
const [file, cxs, czs, ws, outp] = process.argv.slice(2);
const b = decodeBake(readFileSync(file).buffer);
const R=b.res, texel=b.worldSize/R, h=b.height;
const cx=+cxs, cz=+czs, WIN=+ws;
const at=(x,y)=>h[Math.min(R-1,Math.max(0,y))*R+Math.min(R-1,Math.max(0,x))];
const S=2; // upscale
const W=WIN*S, H=WIN*S;
const px=Buffer.alloc(W*H*3);
const lx=-0.55, ly=0.62, lz=-0.56;
for(let j=0;j<H;j++)for(let i=0;i<W;i++){
  const x=cx+Math.floor(i/S), y=cz+Math.floor(j/S);
  const gx=(at(x+1,y)-at(x-1,y))/(2*texel), gz=(at(x,y+1)-at(x,y-1))/(2*texel);
  const n=1/Math.hypot(gx,1,gz);
  const d=Math.max(0,(-gx*n)*lx + n*ly + (-gz*n)*lz);
  const v=Math.round(255*Math.min(1,0.10+0.95*Math.pow(d,0.9)));
  const o=(j*W+i)*3; px[o]=v;px[o+1]=v;px[o+2]=v;
}
// minimal PNG
const raw=Buffer.alloc(H*(W*3+1));
for(let j=0;j<H;j++){raw[j*(W*3+1)]=0;px.copy(raw,j*(W*3+1)+1,j*W*3,(j+1)*W*3);}
const crcT=[...Array(256)].map((_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc=buf=>{let c=0xffffffff;for(const B of buf)c=crcT[(c^B)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
const chunk=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);
  const c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([l,td,c]);};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(W,0);ihdr.writeUInt32BE(H,4);ihdr[8]=8;ihdr[9]=2;
writeFileSync(outp,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),
  chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
console.log('wrote',outp,W+'x'+H);
