// ─────────────────────────────────────────────────────────────────────────────
//  camp_ui — the placement reticle and the one line of text that explains it.
//
//  The reticle is a world-space ring that follows the heightfield, not a screen
//  overlay. That is the whole point: the player is choosing a *place*, and a
//  flat circle drawn over a slope tells them nothing about whether the ground
//  there is flat, while a ring that visibly buckles over a hummock tells them
//  immediately. It is the same argument the game's own minimap loses to a
//  compass — the diegetic version carries information the abstract one cannot.
//
//  There is deliberately no red X, no "invalid location" banner, and no error
//  sound. A place that will not work simply never firms up, and the prompt
//  quietly says why in three words. This game has no fail state and the
//  placement UI should not invent one.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { clamp01, lerp } from '../core/MathUtils.js';
import { campCoverAt } from './camp_clearing.js';

const TAU = Math.PI * 2;
const SEGS = 96;

export class CampReticle {
  constructor(scene, world, radius) {
    this.scene = scene;
    this.world = world;
    this.radius = radius;
    this.ok = false;
    this.score = 0;
    this._fade = 0;
    this._firm = 0;

    // ── the ring ──────────────────────────────────────────────────────────
    // A ribbon rather than a LineLoop: `gl_LineWidth` is 1 on every desktop
    // GL implementation regardless of what you ask for, so a line ring is a
    // one-pixel thread that disappears against grass and aliases into dashes
    // as it recedes. A 12 cm ribbon lying on the ground is legible at 20 m and
    // reads as light thrown on the dirt rather than as a UI element.
    const g = new THREE.BufferGeometry();
    const verts = new Float32Array((SEGS + 1) * 2 * 3);
    const uv = new Float32Array((SEGS + 1) * 2 * 2);
    const idx = [];
    for (let i = 0; i <= SEGS; i++) {
      uv[(i * 2) * 2] = i / SEGS;     uv[(i * 2) * 2 + 1] = 0;
      uv[(i * 2 + 1) * 2] = i / SEGS; uv[(i * 2 + 1) * 2 + 1] = 1;
      if (i < SEGS) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    this.geo = g;

    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime:  { value: 0 },
        uFade:  { value: 0 },
        uFirm:  { value: 0 },
        uWarm:  { value: new THREE.Color(0xffc98a) },
        uCool:  { value: new THREE.Color(0x9fd8c4) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */`
        uniform float uTime, uFade, uFirm;
        uniform vec3 uWarm, uCool;
        varying vec2 vUv;
        void main() {
          // Soft across the ribbon, so the ring has no hard outer edge.
          float across = 1.0 - abs( vUv.y * 2.0 - 1.0 );
          across = pow( across, 1.6 );
          // A slow chase around the ring while the site is unsettled; it stops
          // dead when the ground is good. Motion is the only signal, and it
          // going still is a far calmer "yes" than a colour change.
          float chase = 0.62 + 0.38 * sin( vUv.x * 18.0 - uTime * 2.4 );
          float dashes = mix( chase, 1.0, uFirm );
          vec3 col = mix( uCool, uWarm, uFirm );
          gl_FragColor = vec4( col * dashes * ( 0.95 + 1.25 * uFirm ), across * uFade );
        }`,
    });

    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = 'camp_reticle';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    scene.add(this.mesh);

    // ── the occluded pass ─────────────────────────────────────────────────
    //
    // The same ring again, much fainter, with the depth test off, sharing the
    // same geometry. It is what you see of the ring where a grass blade, a
    // shrub or the camper's flank is in front of it.
    //
    // The clearing already ghosts open under the reticle (see uCampFloor in
    // camp_clearing.js) and that does most of the work — but "most" is not
    // enough for a targeting affordance. The far arc of a six-metre ring on
    // sloping ground genuinely goes behind a hummock, and a ring that
    // disappears into the terrain reads as broken rather than as occluded.
    // Drawing the hidden part at a fifth of the strength is the standard
    // answer and it costs one extra draw call while the player is aiming and
    // nothing at all otherwise.
    this.matBehind = this.mat.clone();
    this.matBehind.depthTest = false;
    this.matBehind.uniforms = THREE.UniformsUtils.clone(this.mat.uniforms);
    this.behind = new THREE.Mesh(g, this.matBehind);
    this.behind.name = 'camp_reticle_occluded';
    this.behind.frustumCulled = false;
    this.behind.renderOrder = 2;
    this.behind.visible = false;
    scene.add(this.behind);
  }

  /** Move the ring to a site and reshape it to the ground under it. */
  place(x, z, ok, score) {
    this.ok = ok;
    this.score = score;
    const p = this.geo.attributes.position.array;
    const W = 0.22;
    for (let i = 0; i <= SEGS; i++) {
      const a = (i / SEGS) * TAU;
      // The ring is the *clearing's* outline, wobble and all, so what the
      // player aims with is exactly the shape they get. A perfect circle here
      // that resolved into an irregular blob would be a small lie, and the kind
      // that erodes trust in every other affordance in the game.
      const wob = Math.sin(a * 2 + 1.7) * 0.115
                + Math.sin(a * 3 - 0.6) * 0.075
                + Math.sin(a * 7 + 2.3) * 0.038;
      const R = this.radius * (1 + wob);
      for (const s of [-1, 1]) {
        const rr = R + s * W * 0.5;
        const wx = x + Math.cos(a) * rr, wz = z + Math.sin(a) * rr;
        const j = (i * 2 + (s > 0 ? 1 : 0)) * 3;
        p[j] = wx;
        p[j + 1] = this.world.getHeight(wx, wz) + 0.06;
        p[j + 2] = wz;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.computeBoundingSphere();
  }

  update(dt, t, active) {
    // Fade, never cut. The ring appearing on the frame the handbrake latches is
    // a UI popping in; over 0.18 s it is a light coming up.
    const want = active ? 1 : 0;
    this._fade += (want - this._fade) * Math.min(1, dt * 9);
    const firmWant = this.ok ? clamp01(0.35 + this.score * 0.65) : 0;
    this._firm += (firmWant - this._firm) * Math.min(1, dt * 6);
    this.mat.uniforms.uTime.value = t;
    this.mat.uniforms.uFade.value = this._fade;
    this.mat.uniforms.uFirm.value = this._firm;
    this.mesh.visible = this._fade > 0.01;

    const b = this.matBehind.uniforms;
    b.uTime.value = t;
    b.uFade.value = this._fade * 0.20;
    b.uFirm.value = this._firm;
    this.behind.visible = this.mesh.visible;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.scene.remove(this.behind);
    this.geo.dispose();
    this.mat.dispose();
    this.matBehind.dispose();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  The prompt
//
//  One line, bottom centre, in the HUD's own panel styling so it does not read
//  as a different game's UI. It hides itself under `window.__forceCamera` for
//  the same reason the rest of the HUD does — eleven authors judge art through
//  the capture harness and none of them asked for a key hint in the frame.
// ─────────────────────────────────────────────────────────────────────────────
export class CampPrompt {
  constructor() {
    const el = document.createElement('div');
    el.className = 'pa-camp-prompt pa-panel';
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:11%', 'transform:translate(-50%, 8px)',
      'pointer-events:none', 'opacity:0', 'transition:opacity .22s ease, transform .22s ease',
      'font:500 13px/1.35 system-ui,-apple-system,sans-serif', 'letter-spacing:.02em',
      'padding:7px 13px', 'border-radius:8px', 'white-space:nowrap',
      'color:#f4ece0', 'background:rgba(24,20,17,.52)',
      'backdrop-filter:blur(7px)', '-webkit-backdrop-filter:blur(7px)',
      'border:1px solid rgba(244,236,224,.13)', 'z-index:40',
    ].join(';');
    document.body.appendChild(el);
    this.el = el;
    this._text = '';
  }

  set(text) {
    if (text === this._text) return;
    this._text = text;
    if (text) this.el.innerHTML = text;
    const on = !!text && !window.__forceCamera;
    this.el.style.opacity = on ? '1' : '0';
    this.el.style.transform = `translate(-50%, ${on ? '0' : '8px'})`;
  }

  dispose() { this.el.remove(); }
}
