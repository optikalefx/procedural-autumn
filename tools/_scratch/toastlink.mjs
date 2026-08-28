// ─────────────────────────────────────────────────────────────────────────────
//  toastlink — does marshmallowMaterial's program actually LINK?
//
//  node --check proves the JavaScript parses. It says nothing at all about the
//  GLSL, and the GLSL is where a material like this dies: one undeclared
//  varying, one uniform declared in the fragment shader and used in the vertex
//  shader, one chunk name that three renamed two releases ago, and the material
//  silently fails to compile and the prop is invisible. Stylize.js has a whole
//  paragraph about exactly that happening to three materials at once.
//
//  So: a throwaway static server (NOT the dev server — this takes no lock and
//  touches no port anyone else is using), a headless Chromium with a real
//  WebGL2 context, the material on a sphere, one render, and the shader
//  compiler's own opinion. It also renders with the toast map at several
//  doneness levels so the ladder's uniform writes are exercised.
//
//    node tools/_scratch/toastlink.mjs
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve(process.cwd());
const NODE_MODULES = path.resolve(ROOT, '../../../node_modules');

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };

const PAGE = `<!doctype html><meta charset="utf-8">
<script type="importmap">{"imports":{
  "three":"/nm/three/build/three.module.js",
  "three/addons/":"/nm/three/examples/jsm/"
}}</script>
<canvas id="c" width="256" height="256"></canvas>
<script type="module">
import * as THREE from 'three';
import { ToastMap, marshmallowMaterial, RESULTS } from '/src/camp/marshmallow_toast.js';
import { patchStylizedLighting } from '/src/render/Stylize.js';
import { patchFogChunks } from '/src/render/Atmosphere.js';

const out = { errors: [], notes: [] };
window.__done = null;
try {
  // The game patches the physical shader globally — Atmosphere for fog,
  // Stylize for the lighting response and the cool cast-shadow mass — before
  // any material compiles. Linking without BOTH is testing a shader nobody
  // ships: Stylize's shadow-cool block reads Atmosphere's vFogWorldPos, so
  // patching only one of them fails to compile for a reason that has nothing to
  // do with the material under test.
  patchFogChunks();
  patchStylizedLighting();

  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.shadowMap.enabled = true;
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x223344, 1, 60);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 10);
  camera.position.set(0, 0, 0.2);

  // Dusk-ish, and deliberately modest. The first cut of this harness lit the
  // marshmallow with a point light of intensity 3 at 250 mm, which under this
  // decay is about 20x — every channel clipped and the ladder came back reading
  // as a rising ORANGE instead of a falling value. The numbers below put a raw
  // marshmallow at roughly half of white, which is the range the frame will
  // actually be judged in.
  const key = new THREE.DirectionalLight(0xffddbb, 0.35);
  key.castShadow = true;
  key.position.set(1, 2, 1);
  scene.add(key, new THREE.AmbientLight(0x334455, 0.4));
  const fire = new THREE.PointLight(0xffa259, 0.30, 8, 1.4);
  fire.position.set(0, -0.30, 0.05);
  scene.add(fire);

  const map = new ToastMap();
  const mat = marshmallowMaterial(map.texture, { radius: 0.021 });
  const geo = new THREE.CylinderGeometry(0.021, 0.021, 0.025, 32, 24);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);

  const u = mat.userData.roastUniforms;
  out.notes.push('roastUniforms keys: ' + Object.keys(u).sort().join(','));
  out.notes.push('RESULTS keys: ' + RESULTS.map(r => r.key).join(','));

  const gl0 = renderer.getContext();
  // The MEAN of a block, not one pixel. Every pattern in this material is
  // procedural and sparse — the crack network covers maybe a sixth of the
  // surface — so a single pixel reports whether it happened to land on a crack,
  // which is a coin toss rather than a measurement. (Found the hard way: a
  // one-pixel probe reported the live-heat channel as having no effect at all.)
  const N = 96;
  const buf = new Uint8Array(N * N * 4);
  const readCentre = () => {
    gl0.readPixels(128 - N / 2, 128 - N / 2, N, N, gl0.RGBA, gl0.UNSIGNED_BYTE, buf);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < buf.length; i += 4) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
    const n = buf.length / 4;
    return (r / n).toFixed(1) + ',' + (g / n).toFixed(1) + ',' + (b / n).toFixed(1);
  };
  // The ladder, as pixels. A ramp that is correct in source and wrong in the
  // frame is the usual outcome of authoring colour stops blind, so read it back:
  // it has to climb from pale cream through gold and amber and then fall off a
  // cliff into char over the last fifth.
  u.uGlow.value = 1.2;
  u.uFireDir.value.set(0, -1, 0.2).normalize();
  for (const k of [0, 0.2, 0.4, 0.6, 0.8, 0.9, 1.0]) {
    map.setDoneness(k);
    u.uSag.value = k * 0.8;
    u.uSwell.value = k * 0.4;
    u.uTime.value = k * 3;
    renderer.render(scene, camera);
    out.notes.push('  ladder t=' + k.toFixed(2) + '  centre rgb ' + readCentre());
  }
  // And the twirl: the same state at four rolls. The procedural grain is sampled
  // in object space, so these must be four different pixels (the pattern turns
  // with the object) rather than four identical ones (the pattern painted on the
  // screen, which is the swimming failure).
  map.setDoneness(0.6);
  const spun = [];
  for (const r of [0, 1, 2, 3]) { mesh.rotation.z = r; renderer.render(scene, camera); spun.push(readCentre()); }
  out.notes.push('  twirl, t=0.60: ' + spun.join('  |  '));
  mesh.rotation.z = 0;
  // Translucency: the same marshmallow with the fire behind it and beside it.
  // If these two are the same pixel the back-scatter term is not running.
  map.setDoneness(0.15);
  u.uFireDir.value.set(0, 0, -1); renderer.render(scene, camera);
  const behind = readCentre();
  u.uFireDir.value.set(1, 0, 0); renderer.render(scene, camera);
  out.notes.push('  translucency, fire behind ' + behind + '  vs beside ' + readCentre());
  // Char with and without live heat. The live channel is the ONLY thing that
  // separates "burnt, still over the flame" from "burnt, cooling on the stick",
  // and if the two read the same the channel is not earning its byte.
  map.setDoneness(1.0);
  u.uFireDir.value.set(0, -1, 0.2).normalize();
  renderer.render(scene, camera);
  const hotChar = readCentre();
  map.live.fill(0); map._recompute();
  renderer.render(scene, camera);
  out.notes.push('  char t=1.0: live 0.85 ' + hotChar + '   vs live 0.00 ' + readCentre());
  map.setDoneness(1.0);
  renderer.render(scene, camera);

  // Ask the driver directly rather than trusting the absence of a console
  // message: three logs a shader error through console.error, and a page that
  // swallows console would report a clean run on a broken shader.
  const gl = renderer.getContext();
  const progs = renderer.info.programs;
  out.notes.push('programs linked: ' + progs.length);
  for (const p of progs) {
    const ok = gl.getProgramParameter(p.program, gl.LINK_STATUS);
    if (!ok) out.errors.push('LINK FAILED: ' + gl.getProgramInfoLog(p.program));
  }
  out.notes.push('gl errors: ' + gl.getError());
  // Something must actually have been drawn.
  const centre = readCentre();
  out.notes.push('centre block mean: ' + centre);
  if (centre === '0.0,0.0,0.0') out.errors.push('centre block is black - nothing drew');
} catch (e) {
  out.errors.push('THREW: ' + (e && e.stack || e));
}
window.__done = out;
</script>`;

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
    return;
  }
  const file = url.startsWith('/nm/')
    ? path.join(NODE_MODULES, url.slice(4))
    : path.join(ROOT, url);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end('no ' + file); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(buf);
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const console_ = [];
page.on('console', (m) => console_.push(m.type() + ': ' + m.text()));
page.on('pageerror', (e) => console_.push('pageerror: ' + e.message));
await page.goto('http://127.0.0.1:' + port + '/');
await page.waitForFunction('window.__done !== null', null, { timeout: 30000 });
const out = await page.evaluate('window.__done');

console.log('── console ──');
for (const l of console_) console.log('  ' + l);
console.log('── notes ──');
for (const n of out.notes) console.log('  ' + n);
console.log('── errors ──');
if (out.errors.length) { for (const e of out.errors) console.log('  ' + e); }
else console.log('  none');

await browser.close();
server.close();
const bad = out.errors.length
  || console_.some((l) => /error|THREE.WebGLProgram|shader/i.test(l) && !/deprecat/i.test(l));
console.log(bad ? '\nFAIL' : '\nPASS — the program links and draws.');
process.exit(bad ? 1 : 0);
