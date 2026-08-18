// Sun, sky fill, ground bounce, and a shadow camera that tracks the player.
import * as THREE from 'three';
import { PALETTE, TOD, QUALITY_PRESETS } from '../world/WorldConfig.js';
import { clamp01, lerp, smoothstep } from '../core/MathUtils.js';

export class Lighting {
  constructor(scene, quality = 'ultra') {
    this.scene = scene;
    this.preset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.high;
    this.hour = TOD.hour;
    this.azimuth = TOD.sunAzimuth;
    this.cycleSpeed = TOD.cycleSpeed;

    this.sunDir = new THREE.Vector3();

    this.sun = new THREE.DirectionalLight(PALETTE.sunLight.clone(), 4.2);
    this.sun.castShadow = true;
    const S = this.preset.shadowMapSize;
    this.sun.shadow.mapSize.set(S, S);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 620;
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.9;
    this.sun.shadow.radius = 3.0;
    this.sun.shadow.blurSamples = 12;
    this._setShadowExtent(190);
    scene.add(this.sun);
    scene.add(this.sun.target);

    // Sky fill (cool) + ground bounce (warm) — the complementary split that
    // gives the reference art its depth.
    this.hemi = new THREE.HemisphereLight(PALETTE.ambientSky.clone(), PALETTE.ambientGround.clone(), 1.35);
    scene.add(this.hemi);

    // A weak fill from the opposite side stops silhouettes going to mud.
    this.fill = new THREE.DirectionalLight(PALETTE.ambientSky.clone(), 0.42);
    scene.add(this.fill);

    // Fog is owned by Atmosphere (height-based aerial perspective).

    this._tmp = new THREE.Vector3();
    this.update(0, new THREE.Vector3());
  }

  _setShadowExtent(e) {
    const c = this.sun.shadow.camera;
    c.left = -e; c.right = e; c.top = e; c.bottom = -e;
    c.updateProjectionMatrix();
    this.shadowExtent = e;
  }

  /** Sun direction from hour-of-day + azimuth. */
  computeSunDir(hour) {
    // Map 6:00 -> horizon east, 12:00 -> peak, 18:00 -> horizon west
    const t = (hour - 6) / 12;                 // 0..1 across the day
    const elev = Math.sin(clamp01(t) * Math.PI) * 1.02 - 0.06;
    const az = this.azimuth + (t - 0.5) * 2.1;
    const cosE = Math.cos(Math.asin(clamp01(elev)));
    return this._tmp.set(Math.cos(az) * cosE, Math.max(elev, -0.25), Math.sin(az) * cosE).normalize();
  }

  update(dt, focus) {
    if (this.cycleSpeed) this.hour = (this.hour + dt * this.cycleSpeed) % 24;

    const dir = this.computeSunDir(this.hour);
    this.sunDir.copy(dir);

    // Sun colour & intensity ramp with elevation — deep amber at the horizon.
    const elev = clamp01(dir.y);
    const golden = 1 - smoothstep(0.02, 0.42, elev);
    const sunCol = new THREE.Color().lerpColors(
      new THREE.Color(0xff9d4a),      // horizon amber
      new THREE.Color(0xfff1d6),      // high noon
      smoothstep(0.0, 0.55, elev)
    );
    this.sun.color.copy(sunCol);
    this.sun.intensity = lerp(0.9, 3.5, smoothstep(-0.06, 0.30, dir.y)) * lerp(1.0, 1.14, golden);

    // Ambient shifts cool as the sun drops — the violet shadow signature.
    // Ambient must stay close to neutral. A strongly saturated hemisphere light
    // drives every unlit face to pure hue; the violet in the reference art is a
    // subtle *tint*, not the base colour of the shadow.
    const skyAmb = new THREE.Color().lerpColors(
      new THREE.Color(0x9aa2c4), new THREE.Color(0xbcc9e2), smoothstep(0.0, 0.45, elev));
    const gndAmb = new THREE.Color().lerpColors(
      new THREE.Color(0xb0937a), new THREE.Color(0xd4b892), smoothstep(0.0, 0.45, elev));
    this.hemi.color.copy(skyAmb);
    this.hemi.groundColor.copy(gndAmb);
    this.hemi.intensity = lerp(0.75, 1.35, smoothstep(-0.1, 0.35, dir.y));

    this.fill.position.copy(dir).multiplyScalar(-1).setY(0.35).normalize().multiplyScalar(300);
    this.fill.color.copy(skyAmb);
    this.fill.intensity = 0.30;

    // Publish the atmosphere palette for the current sun elevation.
    this.fogNear = new THREE.Color().lerpColors(
      new THREE.Color(0xf7d3ac), new THREE.Color(0xe9ddd2), smoothstep(0.05, 0.5, elev));
    this.fogFar = new THREE.Color().lerpColors(
      new THREE.Color(0xd8b7c4), new THREE.Color(0xbcc9de), smoothstep(0.05, 0.5, elev));
    this.fogSun = sunCol.clone().lerp(new THREE.Color(0xffe0b0), 0.4);
    this.fogDensity = lerp(0.0082, 0.0044, smoothstep(0.05, 0.5, elev));

    // Track the shadow camera to the focus point, snapped to texel steps so
    // shadows do not shimmer while driving.
    if (focus) {
      const texelWorld = (this.shadowExtent * 2) / this.preset.shadowMapSize;
      const sx = Math.round(focus.x / texelWorld) * texelWorld;
      const sz = Math.round(focus.z / texelWorld) * texelWorld;
      this.sun.target.position.set(sx, focus.y, sz);
      this.sun.position.copy(this.sun.target.position).addScaledVector(dir, 320);
      this.sun.target.updateMatrixWorld();
    }
  }

  dispose() {
    this.scene.remove(this.sun, this.sun.target, this.hemi, this.fill);
  }
}
