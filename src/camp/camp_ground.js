// ─────────────────────────────────────────────────────────────────────────────
//  camp_ground — the scuffed dirt the camp stands on.
//
//  PLACEHOLDER. Scaffolding only; see docs/CAMP_BRIEF.md.
//
//  API contract (Camp.js depends on exactly this):
//    new CampGround(scene, world) -> { build(x, z, radius, rnd), setReveal(k),
//                                      dispose() }
//
//  Approach: a mesh that samples the heightfield on its own grid and sits a
//  few centimetres above it, rather than a projected decal. Polygon offset on a
//  surface this large z-fights at distance, and a projected decal needs a
//  second render of the terrain. A conforming mesh with a soft alpha edge is
//  both cheaper and better behaved on a slope.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { campCoverAt } from './camp_clearing.js';
import { clamp01, lerp } from '../core/MathUtils.js';

export class CampGround {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.mesh = null;
    this.reveal = 1;
  }

  build(x, z, radius, rnd = Math.random) {
    this.dispose();
    const N = 48;
    const span = radius * 2.6;
    const g = new THREE.PlaneGeometry(span, span, N, N);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const alpha = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const wx = x + pos.getX(i), wz = z + pos.getZ(i);
      pos.setY(i, this.world.getHeight(wx, wz) + 0.035);
      // The dirt is exactly the inverse of the vegetation cover, so the two
      // can never disagree about where the clearing edge is.
      const bare = 1 - campCoverAt(wx, wz);
      alpha[i] = bare;
      // Dry trodden earth, not a burn scar. The first pass authored this at
      // 0.40/0.31/0.22 and the capture came back with a black-brown blob that
      // read as an oil spill: vertex colour multiplies the material's own
      // albedo in LINEAR space, so a value that looks like "brown" as an sRGB
      // hex lands about two stops darker than intended once it is lit.
      const t = 0.88 + 0.16 * Math.sin(wx * 1.7) * Math.cos(wz * 2.1);
      col[i * 3] = 0.86 * t; col[i * 3 + 1] = 0.68 * t; col[i * 3 + 2] = 0.47 * t;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aBare', new THREE.BufferAttribute(alpha, 1));
    g.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.96, metalness: 0.0,
      transparent: true, depthWrite: false, polygonOffset: true,
      polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = 'attribute float aBare;\nvarying float vBare;\n' +
        sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBare = aBare;');
      sh.fragmentShader = 'varying float vBare;\n' +
        sh.fragmentShader.replace('#include <dithering_fragment>',
          '#include <dithering_fragment>\n  gl_FragColor.a *= vBare;');
    };
    this.mat = mat;
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.name = 'camp_ground';
    this.mesh.position.set(x, 0, z);
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    this.scene.add(this.mesh);
    this.setReveal(this.reveal);
  }

  setReveal(k) {
    this.reveal = clamp01(k);
    if (this.mat) this.mat.opacity = this.reveal;
    if (this.mesh) this.mesh.visible = this.reveal > 0.01;
  }

  dispose() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mat?.dispose();
    this.mesh = null;
  }
}
