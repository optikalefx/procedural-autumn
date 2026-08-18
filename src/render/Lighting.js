// ─────────────────────────────────────────────────────────────────────────────
//  Lighting — the sun, the fills, the shadow camera, and the time-of-day arc.
//
//  `hour` is the single scrubbable control (0..24). Everything visual — sun
//  colour and intensity, ambient split, sky gradient, haze colour and density,
//  cloud shading — is interpolated from the keyframe table below. That table
//  *is* the art direction for light; if a time of day looks wrong, fix the
//  keyframe, not the code around it.
//
//  Sky.js and Clouds.js are constructed independently by main.js and never see
//  the Lighting instance, so the per-frame result is published on the shared
//  `SKY_STATE` record they import. One writer, several readers, no globals.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { TOD, QUALITY_PRESETS } from '../world/WorldConfig.js';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils.js';

const C = (hex) => new THREE.Color().setHex(hex, THREE.SRGBColorSpace);

// ── The day, as keyframes ────────────────────────────────────────────────────
//  sun/sunI      key light
//  hemiSky/Gnd   sky fill (cool) and ground bounce (warm) — the complementary
//                split that gives the reference art its depth
//  zen/hor       sky dome gradient endpoints
//  sunHor        horizon colour in the sun's azimuth (the "sunset wedge")
//  glow/glowI    colour + strength of the aureole around the sun disc
//  fog*/fogD     aerial perspective, consumed by Atmosphere
//  cloudLit/Dark cumulus top and shadow, consumed by Clouds
//
//  Colours are authored as display-referred sRGB and converted to the working
//  space on read; they land close to their hex after AgX because AgX keeps
//  middle grey. Anything whose *linear* luminance exceeds ~0.9 will clip to
//  white once bloom is applied, so the sky keys deliberately stay under it.
const KEYS = [
  { h: 0.0,  sun: 0x3b4a7a, sunI: 0.10, hemiSky: 0x5c6892, hemiGnd: 0x3a3c52, hemiI: 0.42,
    zen: 0x0d1226, hor: 0x1c2440, sunHor: 0x2e3050, glow: 0x2a3358, glowI: 0.12,
    fogNear: 0x1e2740, fogFar: 0x151b30, fogSun: 0x2a3358, fogD: 0.0030,
    cloudLit: 0x3a4468, cloudDark: 0x131a2e, cover: 0.35 },

  { h: 5.2,  sun: 0x3f5080, sunI: 0.12, hemiSky: 0x606c96, hemiGnd: 0x3c3e54, hemiI: 0.46,
    zen: 0x111834, hor: 0x2a3352, sunHor: 0x4b4468, glow: 0x50486e, glowI: 0.22,
    fogNear: 0x2a3350, fogFar: 0x1d2440, fogSun: 0x4b4468, fogD: 0.0031,
    cloudLit: 0x4a5074, cloudDark: 0x191f36, cover: 0.37 },

  // Blue hour — the sun is still under the horizon, the sky does the lighting.
  { h: 6.3,  sun: 0x9a7ea0, sunI: 0.55, hemiSky: 0x8d96b2, hemiGnd: 0x776a76, hemiI: 0.84,
    zen: 0x25407e, hor: 0xb59aa4, sunHor: 0xe0a088, glow: 0xf0ac82, glowI: 0.50,
    fogNear: 0x9c8a94, fogFar: 0x8a82a0, fogSun: 0xe0a088, fogD: 0.0036,
    cloudLit: 0xc9a8b0, cloudDark: 0x4a4a70, cover: 0.39 },

  // Cool dawn — long low light, pale horizon. Cool is a *relative* statement:
  // the zenith is the bluest of the day, but the haze itself stays peach, or
  // the frame measures out at a fifth of the reference's chroma.
  { h: 7.4,  sun: 0xffc08a, sunI: 2.60, hemiSky: 0xc0bcc6, hemiGnd: 0xc8a68c, hemiI: 1.14,
    zen: 0x6b9ad2, hor: 0xecccae, sunHor: 0xf9c79c, glow: 0xffd4ab, glowI: 0.95,
    fogNear: 0xe0b48c, fogFar: 0xd8c2c2, fogSun: 0xffd0a0, fogD: 0.0024,
    cloudLit: 0xffe0c4, cloudDark: 0x8c94b8, cover: 0.43 },

  { h: 9.5,  sun: 0xffdfae, sunI: 3.10, hemiSky: 0xc4cbdc, hemiGnd: 0xd8b380, hemiI: 0.96,
    zen: 0x63a0dc, hor: 0xe6cdb0, sunHor: 0xf4e2ca, glow: 0xffeed6, glowI: 0.72,
    fogNear: 0xdcbb92, fogFar: 0xdcc6ba, fogSun: 0xffe8c8, fogD: 0.0021,
    cloudLit: 0xfff6ec, cloudDark: 0xa4abc6, cover: 0.37 },

  { h: 12.5, sun: 0xffecc8, sunI: 3.40, hemiSky: 0xc8d2e4, hemiGnd: 0xdcb682, hemiI: 0.90,
    zen: 0x5fa0de, hor: 0xe0cdb6, sunHor: 0xeee6da, glow: 0xfff4e4, glowI: 0.62,
    fogNear: 0xd8c3a0, fogFar: 0xd6c4b6, fogSun: 0xf8ecd8, fogD: 0.0015,
    cloudLit: 0xfffaf4, cloudDark: 0xa6aecc, cover: 0.33 },

  { h: 15.5, sun: 0xffe0b0, sunI: 3.25, hemiSky: 0xc6cee2, hemiGnd: 0xd6b184, hemiI: 1.00,
    zen: 0x86b4de, hor: 0xeed6b6, sunHor: 0xf8d6ae, glow: 0xffe6bc, glowI: 0.80,
    fogNear: 0xe4bf92, fogFar: 0xe6cec3, fogSun: 0xffdfb4, fogD: 0.0021,
    cloudLit: 0xfff2e2, cloudDark: 0xa4a4c4, cover: 0.39 },

  // The money frame: deep golden hour.
  { h: 17.1, sun: 0xffbe72, sunI: 2.95, hemiSky: 0xbcc2d8, hemiGnd: 0xd2a066, hemiI: 0.98,
    zen: 0x93b6dc, hor: 0xf0cfa4, sunHor: 0xf8c184, glow: 0xffcf90, glowI: 1.00,
    fogNear: 0xeab77e, fogFar: 0xe8cdc0, fogSun: 0xffc98c, fogD: 0.0027,
    cloudLit: 0xffe2bc, cloudDark: 0x9c90b6, cover: 0.43 },

  { h: 18.3, sun: 0xff9c52, sunI: 2.05, hemiSky: 0xb4b4cc, hemiGnd: 0xcc9060, hemiI: 1.16,
    zen: 0x5b83c2, hor: 0xf3c8a0, sunHor: 0xf8a262, glow: 0xffae66, glowI: 1.20,
    fogNear: 0xe2a266, fogFar: 0xdfbcb4, fogSun: 0xffa860, fogD: 0.0035,
    cloudLit: 0xffcc9c, cloudDark: 0x8a80aa, cover: 0.47 },

  { h: 19.0, sun: 0xff8446, sunI: 1.50, hemiSky: 0xa8a6c2, hemiGnd: 0xb27a58, hemiI: 1.14,
    zen: 0x4a6bb4, hor: 0xeaae90, sunHor: 0xf28a4c, glow: 0xff9450, glowI: 1.32,
    fogNear: 0xd88a62, fogFar: 0xc09098, fogSun: 0xff8a48, fogD: 0.0040,
    cloudLit: 0xffb078, cloudDark: 0x766698, cover: 0.49 },

  { h: 19.8, sun: 0x9c5a76, sunI: 0.32, hemiSky: 0x8a92ae, hemiGnd: 0x7a6672, hemiI: 0.72,
    zen: 0x33508e, hor: 0xb890a0, sunHor: 0xd0756e, glow: 0xe07a62, glowI: 0.66,
    fogNear: 0xa8808e, fogFar: 0x92849e, fogSun: 0xd8756e, fogD: 0.0043,
    cloudLit: 0xd09aa0, cloudDark: 0x554f76, cover: 0.45 },

  { h: 21.0, sun: 0x4a4a80, sunI: 0.12, hemiSky: 0x64709a, hemiGnd: 0x40425a, hemiI: 0.48,
    zen: 0x151c3a, hor: 0x35395c, sunHor: 0x53476c, glow: 0x54486e, glowI: 0.22,
    fogNear: 0x333a58, fogFar: 0x232a48, fogSun: 0x53476c, fogD: 0.0034,
    cloudLit: 0x4a5074, cloudDark: 0x191f36, cover: 0.39 },

  { h: 24.0, sun: 0x3b4a7a, sunI: 0.10, hemiSky: 0x5c6892, hemiGnd: 0x3a3c52, hemiI: 0.42,
    zen: 0x0d1226, hor: 0x1c2440, sunHor: 0x2e3050, glow: 0x2a3358, glowI: 0.12,
    fogNear: 0x1e2740, fogFar: 0x151b30, fogSun: 0x2a3358, fogD: 0.0030,
    cloudLit: 0x3a4468, cloudDark: 0x131a2e, cover: 0.35 },
];

const COLOR_FIELDS = ['sun', 'hemiSky', 'hemiGnd', 'zen', 'hor', 'sunHor', 'glow',
                      'fogNear', 'fogFar', 'fogSun', 'cloudLit', 'cloudDark'];
const SCALAR_FIELDS = ['sunI', 'hemiI', 'glowI', 'fogD', 'cover'];

// The fogD curve below was authored while a wiring bug meant MeshStandardMaterial
// received no fog uniforms at all (see docs/INTEGRATION_REQUESTS.md). Only the
// opt-in ShaderMaterials were hazed, so the densities were pushed high to make
// trees recede — and once the terrain started receiving fog too, every distant
// view turned into a white-out. This scales the whole authored curve rather
// than flattening its time-of-day shape, which is still right.
// Recalibrated once the aerial perspective stopped bleeding toward grey: at
// 0.34 there was barely any haze left to layer with — `peaks` reached only
// fogFactor ~0.25 on its furthest ridge, so near, mid and far read as one
// plane. 0.34 was over-correcting for the fact that the old desaturation term
// was neutralising the frame, which is fixed at source in Atmosphere now.
const FOG_DENSITY_SCALE = 0.58;

// The hemisphere fill was authored to keep shadows off the floor while the
// Stylize diffuse floor was not running (same wiring bug as the fog). With both
// active it is doing the job twice, and a large near-white ambient is the
// classic way to flatten a stylised frame: it lifts the shaded side of every
// high-albedo surface — bare rock most of all — until form disappears. The
// reference's rock runs #c3bfcc lit against #5c5a75 shaded, a ratio of about
// 0.19 in linear; at full ambient ours measured 0.7. Scaling the whole authored
// curve keeps its time-of-day shape, which is right.
const AMBIENT_SCALE = 0.62;

// Pre-convert the table once; per-frame we only lerp.
const BAKED = KEYS.map((k) => {
  const o = { h: k.h };
  for (const f of COLOR_FIELDS) o[f] = C(k[f]);
  for (const f of SCALAR_FIELDS) o[f] = k[f];
  return o;
});

/**
 * Per-frame atmosphere state, written by Lighting, read by Sky and Clouds.
 * Mutated in place — never reassign the objects, consumers hold references.
 */
export const SKY_STATE = {
  sunDir: new THREE.Vector3(0, 1, 0),
  sunElev: 0,          // sin(elevation), -1..1
  dayFactor: 0,        // 0 night … 1 full day, useful for fading effects
  hour: TOD.hour,
  zenith: new THREE.Color(),
  horizon: new THREE.Color(),
  sunHorizon: new THREE.Color(),
  glow: new THREE.Color(),
  glowIntensity: 1,
  sunColor: new THREE.Color(),
  sunIntensity: 1,
  cloudLit: new THREE.Color(),
  cloudDark: new THREE.Color(),
  cloudAmbient: new THREE.Color(),
  cloudCover: 0.5,
  fogNear: new THREE.Color(),
  fogFar: new THREE.Color(),
};

export class Lighting {
  constructor(scene, quality = 'ultra') {
    this.scene = scene;
    this.quality = quality;
    this.preset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.high;
    this.hour = TOD.hour;
    this.azimuth = TOD.sunAzimuth;
    this.cycleSpeed = TOD.cycleSpeed;

    // Sunrise / sunset in hours. The elevation curve is shaped so that the
    // canonical golden-hour views (16.4 … 17.9) sit between 5° and 18° — a
    // symmetric sine puts the sun far too high there.
    this.sunrise = 6.2;
    this.sunset = 18.9;

    this.sunDir = new THREE.Vector3();

    this.sun = new THREE.DirectionalLight(0xffffff, 3.0);
    this.sun.castShadow = true;
    const S = this.preset.shadowMapSize;
    this.sun.shadow.mapSize.set(S, S);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 1400;
    // PCF-soft wants a small constant bias and most of the work done by the
    // normal offset; a large normalBias is what produced the visible
    // peter-panning gap under ridgelines in the first pass.
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.35;
    this.sun.shadow.radius = 3.5;
    this.sun.shadow.blurSamples = 10;
    // A cast shadow in the reference is a warm, semi-transparent shape on gold
    // meadow, not a hole. Three defaults `shadow.intensity` to 1 — fully black
    // — and that default was in force: measured, the near-field views were
    // running lumaP05 0.00–0.08 against a reference band of 0.16–0.42, i.e.
    // crushed. At 0.55 the shadow removes just over half the key and the
    // ambient plus the diffuse floor keep the shaded ground coloured.
    this.sun.shadow.intensity = 0.72;
    this._setShadowExtent(220);
    scene.add(this.sun);
    scene.add(this.sun.target);

    // Sky fill (cool) + ground bounce (warm). Kept close to neutral: the
    // violet in the reference is a *tint* on a still-warm shadow, so a
    // saturated hemisphere light is a bug, not the style.
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.1);
    scene.add(this.hemi);

    // Weak counter-key. Real golden hour has enough bounce off the valley that
    // shadowed faces never go to mud; without it the terminator reads as a
    // hard black edge, which is the single most "amateur" lighting tell.
    this.fill = new THREE.DirectionalLight(0xffffff, 0.34);
    scene.add(this.fill);

    // Fog is owned by Atmosphere (height-based aerial perspective).

    this._tmp = new THREE.Vector3();
    this._k = { sun: new THREE.Color(), hemiSky: new THREE.Color(), hemiGnd: new THREE.Color() };
    this._shadowsConfigured = false;
    this.update(0, new THREE.Vector3());
  }

  // ── time of day ────────────────────────────────────────────────────────────

  /** Sample the keyframe table at an arbitrary hour into `out`. */
  sampleKeys(hour, out = {}) {
    const h = ((hour % 24) + 24) % 24;
    let i = 0;
    while (i < BAKED.length - 2 && BAKED[i + 1].h <= h) i++;
    const a = BAKED[i], b = BAKED[i + 1];
    // Smoothstep between keys: linear ramps make the sunset visibly "kink"
    // as it crosses a keyframe when the cycle is running.
    const t = smoothstep(a.h, b.h, h);
    for (const f of COLOR_FIELDS) {
      (out[f] ??= new THREE.Color()).lerpColors(a[f], b[f], t);
    }
    for (const f of SCALAR_FIELDS) out[f] = lerp(a[f], b[f], t);
    return out;
  }

  /**
   * Sun direction from hour-of-day. Returns a shared temporary — copy it if
   * you need to keep it.
   */
  computeSunDir(hour) {
    const span = this.sunset - this.sunrise;
    const t = (hour - this.sunrise) / span;
    // pow > 1 flattens the ends of the arc, so "late afternoon" is genuinely
    // low-angle light rather than the 45° a plain sine would give.
    let elev;
    if (t < 0 || t > 1) {
      const night = t < 0 ? -t : t - 1;
      elev = -0.06 - Math.min(night * 1.6, 1) * 0.24;
    } else {
      elev = Math.pow(Math.sin(t * Math.PI), 1.6) * 0.95 - 0.015;
    }
    const az = this.azimuth + (clamp(t, -0.15, 1.15) - 0.5) * 2.4;
    const cosE = Math.sqrt(Math.max(1 - elev * elev, 0));
    return this._tmp.set(Math.cos(az) * cosE, elev, Math.sin(az) * cosE).normalize();
  }

  // ── shadows ────────────────────────────────────────────────────────────────

  _setShadowExtent(e) {
    if (Math.abs(e - this.shadowExtent) < 0.5) return;
    const c = this.sun.shadow.camera;
    c.left = -e; c.right = e; c.top = e; c.bottom = -e;
    c.updateProjectionMatrix();
    this.shadowExtent = e;
  }

  /**
   * VSM gave a soft edge for free but light-bleeds badly across a heightfield:
   * long shallow-slope receivers produced a regular plaid of half-lit texels
   * on every shaded mountain face. PCF-soft with a real normal offset is both
   * cheaper and clean. The renderer belongs to Engine, which system authors do
   * not edit, so this is a one-shot late binding via the debug surface.
   * See docs/INTEGRATION_REQUESTS.md.
   */
  _configureShadows() {
    if (this._shadowsConfigured) return;
    const r = globalThis.__engine?.renderer;
    if (!r) return;
    this._shadowsConfigured = true;
    if (r.shadowMap.type !== THREE.PCFSoftShadowMap) {
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      // Materials compiled before the switch carry the old shadow defines.
      this.scene.traverse((o) => {
        const m = o.material;
        if (!m) return;
        if (Array.isArray(m)) m.forEach((x) => { x.needsUpdate = true; });
        else m.needsUpdate = true;
      });
    }
  }

  // ── per frame ──────────────────────────────────────────────────────────────

  update(dt, focus) {
    this._configureShadows();
    if (this.cycleSpeed) this.hour = (this.hour + dt * this.cycleSpeed) % 24;

    const dir = this.computeSunDir(this.hour);
    this.sunDir.copy(dir);

    const k = this.sampleKeys(this.hour, this._keys ??= {});
    const elev = dir.y;
    // 0 while the sun is under the horizon, 1 once it is properly up.
    const day = smoothstep(-0.08, 0.10, elev);

    this.sun.color.copy(k.sun);
    this.sun.intensity = k.sunI;
    this.sun.castShadow = k.sunI > 0.35;

    this.hemi.color.copy(k.hemiSky);
    this.hemi.groundColor.copy(k.hemiGnd);
    this.hemi.intensity = k.hemiI * AMBIENT_SCALE;

    // Counter-key sits opposite the sun and slightly above, so it fills the
    // shadow side without flattening the form.
    this.fill.position.copy(dir).multiplyScalar(-1).setY(0.42).normalize().multiplyScalar(400);
    // Warm the counter-key toward the key when the sun is low: at golden hour
    // the bounce off a gold valley floor is the dominant fill, and a purely
    // cool one drives every shaded face to the saturated blue the brief calls
    // out as a bug.
    const lowSun = 1 - smoothstep(0.06, 0.34, elev);
    this.fill.color.copy(k.hemiSky).lerp(k.hemiGnd, 0.30 + 0.35 * lowSun);
    this.fill.intensity = lerp(0.10, 0.24, day);

    // Atmosphere palette for this hour (main.js copies these into Atmosphere).
    (this.fogNear ??= new THREE.Color()).copy(k.fogNear);
    (this.fogFar ??= new THREE.Color()).copy(k.fogFar);
    (this.fogSun ??= new THREE.Color()).copy(k.fogSun);
    this.fogDensity = k.fogD * FOG_DENSITY_SCALE;

    // Publish for Sky / Clouds.
    const s = SKY_STATE;
    s.sunDir.copy(dir);
    s.sunElev = elev;
    s.dayFactor = day;
    s.hour = this.hour;
    s.zenith.copy(k.zen);
    s.horizon.copy(k.hor);
    s.sunHorizon.copy(k.sunHor);
    s.glow.copy(k.glow);
    s.glowIntensity = k.glowI;
    s.sunColor.copy(k.sun);
    s.sunIntensity = k.sunI;
    s.cloudLit.copy(k.cloudLit);
    s.cloudDark.copy(k.cloudDark);
    s.cloudAmbient.copy(k.hemiSky).lerp(k.cloudDark, 0.45);
    s.cloudCover = k.cover;
    s.fogNear.copy(k.fogNear);
    s.fogFar.copy(k.fogFar);

    // ── shadow camera ────────────────────────────────────────────────────────
    if (focus) {
      // Grow the covered area when the camera climbs: a vista shot needs the
      // whole massif in frustum, an eye-level drive shot wants every texel it
      // can get.
      //
      // The old 520 m cap was the reason `peaks` had no value structure. From
      // a 350 m camera the mountains that fill the frame sit 600–1300 m out —
      // entirely outside the shadow frustum — so a 28° sun threw no ridge
      // shadows on them at all and the massif rendered as one flat tan mass
      // (contrastStd 0.087 against a reference band of 0.13–0.22). Terrain
      // already casts out to LOD 2 (~720 m); this is what lets those casters
      // land. At 900 m and a 4096 map that is 0.44 m per texel, which is soft
      // but perfectly clean at the distance the extent only reaches from.
      const ground = focus.y - 6;
      this._setShadowExtent(clamp(150 + Math.max(ground, 0) * 2.4, 150, 900));

      const texelWorld = (this.shadowExtent * 2) / this.preset.shadowMapSize;
      const sx = Math.round(focus.x / texelWorld) * texelWorld;
      const sz = Math.round(focus.z / texelWorld) * texelWorld;
      // Push the target slightly down-sun so more of the frustum lands in
      // front of the camera rather than behind it.
      this.sun.target.position.set(sx, focus.y, sz);
      this.sun.position.copy(this.sun.target.position)
        .addScaledVector(dir, Math.max(this.shadowExtent * 2.4, 420));
      this.sun.target.updateMatrixWorld();
      this.sun.shadow.camera.far = Math.max(this.shadowExtent * 2.4, 420) + this.shadowExtent * 2;
      this.sun.shadow.camera.updateProjectionMatrix();
    }
  }

  dispose() {
    this.scene.remove(this.sun, this.sun.target, this.hemi, this.fill);
  }
}
