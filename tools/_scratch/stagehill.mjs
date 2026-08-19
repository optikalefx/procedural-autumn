import { TerrainGen } from '../../src/world/TerrainGen.js';
import { writeFileSync } from 'node:fs';
import zlib from 'node:zlib';
const RES=1536, W=3072;
const g = new TerrainGen({res:RES, worldSize:W});
const DISABLE = process.argv.includes('--nodeflute');
if (DISABLE) g._deflute = () => {};
g.height=new Float32Array(RES*RES); g.hardness=new Float32Array(RES*RES); g.sediment=new Float32Array(RES*RES);
const shots={};
const snap=(n)=>{ shots[n]=Float32Array.from(g.height); console.log('snap',n); };
g._tectonic(); snap('tectonic');
g._erode(Math.round(RES*RES*0.22)); snap('eroded');
g._relax(); snap('relaxed');
g._fillDepressions(); g._flowAccumulation(); g._carveChannels(); snap('carved');
const texel=W/RES, cx=20, cz=155, WIN=380, S=2;
const crcT=[...Array(256)].map((_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc=b=>{let c=0xffffffff;for(const B of b)c=crcT[(c^B)&255]^(c>>>8);return (c^0xffffffff)>>>0;};
const chunk=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);
  const c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([l,td,c]);};
for(const [name,h] of Object.entries(shots)){
  const at=(x,y)=>h[Math.min(RES-1,Math.max(0,y))*RES+Math.min(RES-1,Math.max(0,x))];
  const Wp=WIN*S,Hp=WIN*S,px=Buffer.alloc(Wp*Hp*3);
  for(let j=0;j<Hp;j++)for(let i=0;i<Wp;i++){
    const x=cx+Math.floor(i/S),y=cz+Math.floor(j/S);
    const gx=(at(x+1,y)-at(x-1,y))/(2*texel), gz=(at(x,y+1)-at(x,y-1))/(2*texel);
    const n=1/Math.hypot(gx,1,gz);
    const d=Math.max(0,(-gx*n)*-0.55 + n*0.62 + (-gz*n)*-0.56);
    const v=Math.round(255*Math.min(1,0.10+0.95*Math.pow(d,0.9)));
    const o=(j*Wp+i)*3;px[o]=v;px[o+1]=v;px[o+2]=v;
  }
  const raw=Buffer.alloc(Hp*(Wp*3+1));
  for(let j=0;j<Hp;j++){raw[j*(Wp*3+1)]=0;px.copy(raw,j*(Wp*3+1)+1,j*Wp*3,(j+1)*Wp*3);}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(Wp,0);ihdr.writeUInt32BE(Hp,4);ihdr[8]=8;ihdr[9]=2;
  const f=`shots/terrain/crop/stage_${name}${DISABLE?'_off':''}.png`;
  writeFileSync(f,Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),
    chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
  console.log('wrote',f);
}
