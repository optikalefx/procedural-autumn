// Replicate the shader's vnoise/fbm exactly and measure the plane-break field.
const fract=(x)=>x-Math.floor(x);
function hash22(px,py){
  let x=px*127.1+py*311.7, y=px*269.5+py*183.3;
  return [fract(Math.sin(x)*43758.5453123)*2-1, fract(Math.sin(y)*43758.5453123)*2-1];
}
function vnoise(px,py){
  const ix=Math.floor(px), iy=Math.floor(py), fx=px-ix, fy=py-iy;
  const ux=fx*fx*(3-2*fx), uy=fy*fy*(3-2*fy);
  const d=(gx,gy)=>{const h=hash22(ix+gx,iy+gy); return h[0]*(fx-gx)+h[1]*(fy-gy);};
  const a=d(0,0),b=d(1,0),c=d(0,1),e=d(1,1);
  return (a+(b-a)*ux)+((c+(e-c)*ux)-(a+(b-a)*ux))*uy;
}
function fbm(px,py,oct){
  let a=0.5,s=0,n=0,x=px,y=py;
  for(let i=0;i<oct;i++){ s+=a*vnoise(x,y); n+=a; a*=0.5; x*=2.07; y*=2.07; }
  return s/n;
}
const L=Number(process.argv[2]||160), K=Number(process.argv[3]||2.0), E=13.0;
let vals=[], grads=[];
for(let i=0;i<20000;i++){
  const x=(Math.random()-0.5)*3000, z=(Math.random()-0.5)*3000;
  const b0=fbm(x/L,z/L,2);
  const bX=fbm((x+E)/L,z/L,2), bZ=fbm(x/L,(z+E)/L,2);
  const gx=(bX-b0)*K/E, gz=(bZ-b0)*K/E;
  vals.push(b0*K); grads.push(Math.hypot(gx,gz));
}
vals.sort((a,b)=>a-b); grads.sort((a,b)=>a-b);
const q=(arr,p)=>arr[Math.floor(p*(arr.length-1))];
console.log('field u range', q(vals,0.01).toFixed(3), q(vals,0.99).toFixed(3), 'p50', q(vals,0.5).toFixed(3));
console.log('|grad u| per m: p10',q(grads,0.1).toFixed(4),'p50',q(grads,0.5).toFixed(4),'p90',q(grads,0.9).toFixed(4),'p99',q(grads,0.99).toFixed(4));
console.log('pitch m: p90',(1/q(grads,0.1)).toFixed(1),'p50',(1/q(grads,0.5)).toFixed(1),'p10',(1/q(grads,0.9)).toFixed(1),'min',(1/q(grads,0.99)).toFixed(1));
// count band crossings along a 300 m transect
let tot=0, n=0;
for(let t=0;t<400;t++){
  const x0=(Math.random()-0.5)*2500, z0=(Math.random()-0.5)*2500;
  const ang=Math.random()*6.283; let prev=null,c=0;
  for(let s=0;s<=300;s+=2){
    const u=fbm((x0+Math.cos(ang)*s)/L,(z0+Math.sin(ang)*s)/L,2)*K;
    const f=Math.floor(u); if(prev!==null&&f!==prev)c++; prev=f;
  }
  tot+=c;n++;
}
console.log('band crossings per 300 m transect:',(tot/n).toFixed(2));
