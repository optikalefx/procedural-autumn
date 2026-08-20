#!/usr/bin/env node
// Scratch: crop + upscale a region of a capture so a defect can be looked at.
import { chromium } from 'playwright';
const a=process.argv.slice(2); const g=(n,d)=>{const i=a.indexOf('--'+n);return i<0?d:a[i+1];};
const src=g('in'), out=g('out'), x=+g('x',0), y=+g('y',0), w=+g('w',400), h=+g('h',300), s=+g('scale',3);
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:w*s,height:h*s}});
const fs=await import('node:fs');
const dataUrl='data:image/png;base64,'+fs.readFileSync(src).toString('base64');
await p.setContent(`<style>html,body{margin:0;background:#000;image-rendering:pixelated}
img{position:absolute;left:${-x*s}px;top:${-y*s}px;width:${1600*s}px;height:auto}</style><img src="${dataUrl}">`);
await p.waitForTimeout(400);
await p.screenshot({path:out});
await b.close(); console.log('crop:',out);
