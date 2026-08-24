// ─────────────────────────────────────────────────────────────────────────────
//  The present pass: internal-resolution rendering, upscaled properly.
//
//  WHY THIS EXISTS. docs/PERF_FINDINGS.md establishes that the frame is
//  GPU-fragment-bound and that nearly every millisecond in it — the post chain,
//  the terrain shader, the grass canopy, SSAO — is a per-pixel cost. At the
//  pixel count a Retina display asks for (3.78 MP at the `high` cap of 1.35)
//  the frame cannot reach 60 fps by removing effects: the tier ladder's own
//  measurement shows even `low` missing the target. The one lever big enough is
//  the pixel count, and the project's own numbers say so: rendering at an
//  effective device ratio of 1.0 instead of 1.35 was measured at −9.6 ms.
//
//  The reason that lever was "already pinned" is a rule, not a law of nature:
//  `Engine.minEffectivePixelRatio = 1.0` exists because rendering below native
//  and letting the BROWSER stretch the canvas is a bilinear upscale, and a
//  bilinear upscale of a detailed frame reads as a broken, blurry game. That
//  judgement was correct — about bilinear.
//
//  This pass changes what "below the cap" looks like. The scene and the whole
//  post chain render into buffers at an internal resolution; the canvas stays
//  at the full presented size; and this pass reconstructs the frame with a
//  9-tap Catmull-Rom filter plus a contrast-adaptive sharpen (the same recipe
//  as AMD's FSR1/CAS generation of upscalers, minus the patent-encumbered lobe
//  analysis). Catmull-Rom's negative lobes keep edges from smearing the way
//  bilinear does, and the sharpen term restores the local contrast the
//  reconstruction loses. On this game's painterly, SMAA-antialiased output it
//  makes moderate scaling much less conspicuous — and at DPR 2 it is *sharper*
//  than the older path, because that path presented a reduced canvas through
//  browser bilinear. It does not make extreme undersampling free; Engine's
//  preferred ratio and floor still keep the source image from looking soft in
//  motion.
//
//  The second thing it buys is freedom from the reallocation freeze. The old
//  adaptive ladder resized the DRAWING BUFFER, measured at 450–2500 ms per
//  rung (see Engine._adapt's notes, and docs/FREEZE_ROUND.md's open item).
//  With the canvas size fixed, changing the internal scale only resizes
//  offscreen render targets, which is milliseconds — so the scaler can afford
//  to move often and in small steps.
//
//  COST: one full-screen pass at the presented resolution, 9 bilinear taps of
//  a small texture that stays resident in cache. Only runs when the internal
//  scale is actually below 1; at scale 1 the chain presents exactly as before.
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { ShaderPass } from 'postprocessing';

const VERT = /* glsl */`
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4(position.xy, 1.0, 1.0);
}`;

// The chain is linear right up to this pass (the composer's buffers are
// HalfFloat and the sRGB encode happens on write to the canvas), so:
//  - the Catmull-Rom reconstruction runs in linear, where filtering is correct;
//  - the sharpen weight is computed on a gamma-2 approximation (sqrt), because
//    "local contrast" is a perceptual quantity — in linear the same edge
//    measures very differently in a highlight than in a shadow;
//  - `colorspace_fragment` at the end applies the same output encode every
//    other renderToScreen material in three gets.
const FRAG = /* glsl */`
uniform sampler2D inputBuffer;
uniform vec2  uSrcSize;      // internal buffer, in texels
uniform vec2  uSrcTexel;     // 1.0 / uSrcSize
uniform float uSharpness;    // 0 = reconstruction only, 1 = maximum CAS peak
varying vec2 vUv;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
	// ── Catmull-Rom, 9 taps ─────────────────────────────────────────────────
	// The classic optimisation: a 4x4 bicubic collapses to a 3x3 of bilinear
	// taps because the middle two rows/columns share one fetch at a weighted
	// offset. All arithmetic in texel space.
	vec2 samplePos = vUv * uSrcSize;
	vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
	vec2 f = samplePos - texPos1;

	vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
	vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
	vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
	vec2 w3 = f * f * (-0.5 + 0.5 * f);
	vec2 w12 = w1 + w2;
	vec2 offset12 = w2 / w12;

	vec2 tc0  = (texPos1 - 1.0) * uSrcTexel;
	vec2 tc3  = (texPos1 + 2.0) * uSrcTexel;
	vec2 tc12 = (texPos1 + offset12) * uSrcTexel;

	vec3 a = texture2D(inputBuffer, vec2(tc12.x, tc0.y )).rgb;   // N
	vec3 b = texture2D(inputBuffer, vec2(tc0.x,  tc12.y)).rgb;   // W
	vec3 c = texture2D(inputBuffer, vec2(tc12.x, tc12.y)).rgb;   // centre
	vec3 d = texture2D(inputBuffer, vec2(tc3.x,  tc12.y)).rgb;   // E
	vec3 e = texture2D(inputBuffer, vec2(tc12.x, tc3.y )).rgb;   // S

	vec3 col = vec3(0.0);
	col += texture2D(inputBuffer, vec2(tc0.x,  tc0.y)).rgb * (w0.x  * w0.y);
	col += a * (w12.x * w0.y);
	col += texture2D(inputBuffer, vec2(tc3.x,  tc0.y)).rgb * (w3.x  * w0.y);
	col += b * (w0.x  * w12.y);
	col += c * (w12.x * w12.y);
	col += d * (w3.x  * w12.y);
	col += texture2D(inputBuffer, vec2(tc0.x,  tc3.y)).rgb * (w0.x  * w3.y);
	col += e * (w12.x * w3.y);
	col += texture2D(inputBuffer, vec2(tc3.x,  tc3.y)).rgb * (w3.x  * w3.y);

	// Catmull-Rom's negative lobes can overshoot on a hard edge; against an HDR
	// value that is not a ring, it is a firework. Clamp to the cross
	// neighbourhood, which keeps the sharpening character and bounds the ring
	// to values the source actually contains.
	vec3 mn4 = min(min(a, b), min(d, e));
	vec3 mx4 = max(max(a, b), max(d, e));
	col = clamp(col, min(mn4, c), max(mx4, c));

	// ── contrast-adaptive sharpen (CAS shape) ───────────────────────────────
	// The five cross taps above are the plus-neighbourhood CAS wants, already
	// paid for. The amount term turns the sharpen OFF where the neighbourhood
	// already spans most of the display range (a hard edge needs no help, and
	// sharpening it rings) and ON in low-contrast texture, which is exactly
	// what an upscale softened. Computed in gamma-2 (sqrt) because contrast is
	// perceptual; applied in linear.
	float lmn = min(min(luma(a), luma(e)), min(min(luma(b), luma(d)), luma(c)));
	float lmx = max(max(luma(a), luma(e)), max(max(luma(b), luma(d)), luma(c)));
	float gmn = sqrt(clamp(lmn, 0.0, 1.0));
	float gmx = sqrt(clamp(lmx, 0.0, 1.0));
	float amp = clamp(min(gmn, 1.0 - gmx) / max(gmx, 1e-4), 0.0, 1.0);
	// Peak negative lobe weight. -0.20 is CAS's own ceiling; uSharpness scales
	// it back. sqrt(amp) softens the transition so the weight does not flicker
	// between adjacent texels.
	float w = sqrt(amp) * (-0.20 * uSharpness);
	vec3 sharp = (col + (a + b + d + e) * w) / (1.0 + 4.0 * w);

	gl_FragColor = vec4(max(sharp, 0.0), 1.0);
	#include <colorspace_fragment>
}`;

export function createUpscalePass() {
	const material = new THREE.ShaderMaterial({
		name: 'AutumnUpscaleMaterial',
		uniforms: {
			inputBuffer: { value: null },
			uSrcSize:    { value: new THREE.Vector2(1, 1) },
			uSrcTexel:   { value: new THREE.Vector2(1, 1) },
			uSharpness:  { value: 0.4 },
		},
		vertexShader: VERT,
		fragmentShader: FRAG,
		depthWrite: false,
		depthTest: false,
	});
	const pass = new ShaderPass(material, 'inputBuffer');
	pass.name = 'UpscalePass';
	/** Tell the filter what it is reading. Called by PostFX._applySizes. */
	pass.setSourceSize = (w, h) => {
		material.uniforms.uSrcSize.value.set(w, h);
		material.uniforms.uSrcTexel.value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
	};
	return pass;
}
