// ─────────────────────────────────────────────────────────────────────────────
//  Injecting custom uniforms into Three's built-in materials.
//
//  Mutating `THREE.UniformsLib.fog` is NOT enough. Three builds every entry in
//  `THREE.ShaderLib` at module-init time by merging (and cloning) the relevant
//  UniformsLib blocks. Any key added afterwards exists in UniformsLib but is
//  absent from ShaderLib.physical, so every MeshStandardMaterial declares the
//  uniform in its shader and is never given a value.
//
//  The failure is silent and nasty: the uniform reads as zero, so a global
//  effect looks like it is "just subtle" rather than like it is not running.
//  We shipped exactly that bug — terrain, rock, grass and the camper received
//  no atmospheric fog at all for several hours, while the opt-in ShaderMaterials
//  did, which made trees look wrong rather than making the bug look like a bug.
//
//  So: write to UniformsLib (for anything built later) *and* to every already
//  built ShaderLib entry, then verify.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';

/**
 * @param {string} libName   key in THREE.UniformsLib, e.g. 'fog' or 'lights'
 * @param {object} uniforms  { name: { value } } — fresh objects, not shared
 */
export function injectUniforms(libName, uniforms) {
  const lib = THREE.UniformsLib[libName];
  if (!lib) throw new Error(`UniformsLib.${libName} does not exist`);

  Object.assign(lib, uniforms);

  // Every ShaderLib entry was cloned before we got here — patch them too.
  for (const key of Object.keys(THREE.ShaderLib)) {
    const entry = THREE.ShaderLib[key];
    if (!entry?.uniforms) continue;
    for (const [name, u] of Object.entries(uniforms)) {
      if (entry.uniforms[name] !== undefined) continue;
      // Clone per entry: sharing one uniform object across materials means one
      // material's write silently changes every other material.
      entry.uniforms[name] = { value: cloneValue(u.value) };
    }
  }
}

function cloneValue(v) {
  if (v && typeof v.clone === 'function') return v.clone();
  if (Array.isArray(v)) return v.slice();
  return v;
}

/**
 * Assert a patch actually reached the built-in materials. Call after injecting;
 * a loud failure at boot beats a global effect that quietly does nothing.
 */
export function verifyUniforms(label, names, shaderLibKeys = ['physical', 'standard', 'lambert']) {
  const missing = [];
  for (const key of shaderLibKeys) {
    const entry = THREE.ShaderLib[key];
    if (!entry?.uniforms) continue;
    for (const n of names) {
      if (entry.uniforms[n] === undefined) missing.push(`${key}.${n}`);
    }
  }
  if (missing.length) {
    console.error(`[${label}] uniform injection FAILED for: ${missing.join(', ')}. ` +
                  `The effect will render as if disabled.`);
    return false;
  }
  return true;
}

/**
 * Make a material's compiled uniform block reachable from JS.
 *
 * `injectUniforms` gets a *value* into every built-in material, but only at
 * compile time — three clones the ShaderLib block per material, so afterwards
 * there is no path from the material back to the live uniforms unless someone
 * stashed the shader. Materials with a custom `onBeforeCompile` (terrain,
 * grass, rock) stash it themselves; plain `MeshStandardMaterial`s do not, and
 * measured in the running game 19 of 36 fogged materials were in that state —
 * the camper and every prop rendering a *static* atmosphere, with a sun
 * direction frozen at the (0,1,0) it was injected with, so their inscattering
 * pointed at the zenith regardless of the time of day.
 *
 * Chains onto any existing hook rather than replacing it, and is idempotent.
 */
export function captureShader(material) {
  if (!material || material.userData?.shader || material.__shaderCaptured) return material;
  material.__shaderCaptured = true;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    this.userData.shader = shader;
  };
  // Changing onBeforeCompile changes three's program cache key, so a material
  // that already compiled needs one recompile to pick the hook up. Once per
  // material at harvest time; callers guard against re-registering.
  material.needsUpdate = true;
  return material;
}

/**
 * Replace a snippet inside a ShaderChunk, tolerating the whitespace differences
 * between three's source tree and its bundled build (the build strips blank
 * lines, which silently broke an exact-string match here once already).
 *
 * @returns {boolean} whether the replacement was applied
 */
export function patchChunk(chunkName, pattern, replacement, label = chunkName) {
  const src = THREE.ShaderChunk[chunkName];
  if (src === undefined) {
    console.error(`[${label}] no such ShaderChunk: ${chunkName}`);
    return false;
  }
  if (!pattern.test(src)) {
    console.error(`[${label}] pattern did not match ShaderChunk.${chunkName}. ` +
                  `Three's shader source has probably changed shape; the effect is NOT active.`);
    return false;
  }
  THREE.ShaderChunk[chunkName] = src.replace(pattern, replacement);
  return true;
}
