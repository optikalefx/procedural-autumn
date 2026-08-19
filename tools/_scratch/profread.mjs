import { readFileSync } from 'node:fs';
const p=JSON.parse(readFileSync('/tmp/autumn-cpu.cpuprofile','utf8'));
const byId=new Map(p.nodes.map(n=>[n.id,n]));
const parent=new Map(); for(const n of p.nodes) for(const c of n.children||[]) parent.set(c,n.id);
const lab=n=>{const f=n.callFrame;const u=(f.url||'').replace(/^https?:\/\/[^/]+/,'').replace(/\?.*$/,'').replace('/node_modules/.vite/deps/','dep:');return `${f.functionName||'(anon)'}@${u}:${f.lineNumber+1}`;};
const dt={};for(let i=0;i<p.samples.length;i++){const id=p.samples[i];dt[id]=(dt[id]||0)+(p.timeDeltas[i]||0);}
const total=p.timeDeltas.reduce((a,b)=>a+b,0);
const target=process.argv[2]||'uniformMatrix4fv';
// aggregate self time of nodes named target, grouped by their ancestor chain
const groups={};
for(const n of p.nodes){ if(!lab(n).startsWith(target))continue; const t=dt[n.id]||0; if(!t)continue;
  let c=n,chain=[],g=0; while(parent.has(c.id)&&g++<6){c=byId.get(parent.get(c.id));chain.push(lab(c));}
  const k=chain.slice(0,4).join(' < '); groups[k]=(groups[k]||0)+t; }
console.log(`callers of ${target} (self ms, %):`);
for(const [k,v] of Object.entries(groups).sort((a,b)=>b[1]-a[1]).slice(0,12)) console.log(`  ${(v/1000).toFixed(0).padStart(6)} ms ${(100*v/total).toFixed(1).padStart(5)}%  ${k}`);
