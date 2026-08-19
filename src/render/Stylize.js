// ─────────────────────────────────────────────────────────────────────────────
//  Stylize — global non-photoreal lighting response.
//
//  The reference art is soft and nearly cel-shaded: lit and shaded areas sit
//  close together in value, the terminator is wide and diffuse, specular is
//  almost absent, and large surfaces read as flat masses of colour rather than
//  as smoothly-shaded geometry. A standard physical BRDF does the opposite —
//  it produces a hard terminator, a wide value range, and lots of high-frequency
//  shading detail. That mismatch is what makes an otherwise correct palette
//  still read as "realistic renderer" instead of "painted".
//
//  Rather than ask eleven authors to each hand-roll a stylised shader, this
//  patches Three's physical direct-lighting term once, globally, so every
//  material in the game — terrain, trees, grass, rock, water, the camper —
//  shares one lighting response. Same approach as Atmosphere.js takes for fog.
//
//  Three effects, all tunable at runtime:
//    wrap       light bleeds past the terminator, widening and softening it
//    banding    the diffuse ramp is quantised into a few soft steps
//    specular   direct specular is scaled down toward matte
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { injectUniforms, verifyUniforms, patchChunk, captureShader } from './uniformPatch.js';

const STYLIZED_DIRECT = /* glsl */`
	// ── stylised diffuse response ──────────────────────────────────────────
	float rawNL = dot( geometryNormal, directLight.direction );

	// Wrap: treat the surface as if lit by a large area source. This is what
	// removes the hard shadow terminator the reference does not have.
	float wrapNL = saturate( ( rawNL + uStyleWrap ) / ( 1.0 + uStyleWrap ) );

	// Quantise into soft bands so broad surfaces read as flat masses.
	float _s = wrapNL * uStyleSteps;
	float _f = floor( _s );
	float _fr = _s - _f;
	float _band = ( _f + smoothstep( 0.5 - uStyleSoft, 0.5 + uStyleSoft, _fr ) ) / uStyleSteps;

	float dotNL = mix( wrapNL, _band, uStyleBanding );

	// Never let a surface fall to zero direct light. Physically wrong, but it is
	// what keeps shaded areas as *tinted colour* rather than as holes, which is
	// the single clearest difference between the reference and a PBR render.
	dotNL = uStyleFloor + ( 1.0 - uStyleFloor ) * dotNL;

	// Slight desaturation of the key toward its own luminance in the darkest
	// band keeps shadowed colour from going muddy.
	vec3 irradiance = dotNL * directLight.color;

	// Specular is computed from the true geometric term, then scaled toward
	// matte — banding a highlight produces visible rings.
	vec3 specIrradiance = saturate( rawNL ) * directLight.color * uStyleSpecular;

	// ── golden-hour rim ──────────────────────────────────────────────────────
	// The brief budgets for backlight as one of four named items and the
	// backlit view exists to test it; it was measured with no rim, no bright
	// silhouette edge and 77.6% of its chromatic pixels in one hue band. This
	// is the global half of the fix, on the same argument the rest of this file
	// makes: eleven authors should not each hand-roll a rim, and one that only
	// some materials have reads as an inconsistency rather than as light.
	//
	// Two gates, multiplied. Fresnel puts it at the silhouette and nowhere
	// else, which is what makes it read as light wrapping an edge instead of as
	// a wash over the whole object. The back gate confines it to surfaces the
	// sun is actually behind — without it every grazing angle in the frame
	// glows and a front-lit vista gains a halo it should not have.
	//
	// It is added to directSpecular, not folded into irradiance, and that is
	// the point of it: irradiance is multiplied by albedo, so a rim through
	// that path on a near-black conifer would be near-black. Light coming past
	// an edge is not the surface's own colour.
	float _rimF = 1.0 - saturate( dot( geometryNormal, geometryViewDir ) );
	float _rimB = saturate( -dot( geometryViewDir, directLight.direction ) );
	vec3 rimIrradiance = directLight.color * ( uStyleRim
		* pow( _rimF, uStyleRimPow )
		* smoothstep( uStyleRimBack, 1.0, _rimB ) );
`;

const SHADOW_COOL = /* glsl */`
{
	// Reach, not depth. Straight ( 1.0 - gSunShadow ) makes the cool proportional
	// to how shadowed a pixel is, which sounds right and produces stipple: our
	// meadow is thin blades standing on ground, the ground is fully occluded and
	// the blades in the same shadow are only half occluded, so the cool landed in
	// the gaps and the frame stayed a warm field with blue speckle between the
	// grass. The reference's shadow is one flat mass with gold strokes over it.
	// So saturate the mask early — anything meaningfully occluded joins the mass
	// at full strength — and let the amount alone say how blue the mass is.
	float _coolM = smoothstep( 0.0, uShadowCoolReach, 1.0 - gSunShadow ) * uShadowCoolAmt;

	// ── and it is a near-field effect ────────────────────────────────────────
	// The brief is explicit that eye-level views are judged against plate 3 and
	// vistas against plate 1, and the two plates disagree about this exact
	// thing: plate 3's cast shadows are blue, plate 1's are warm dark gold and
	// its distance is pink-lavender haze instead. Applied at one strength
	// everywhere, the amount that makes "meadow" right turns the whole
	// foreground ridge of "hero" violet — measured, 33% of hero's chromatic
	// pixels went cool against plate 1's 1.5%.
	//
	// Distance is the discriminator, and not arbitrarily: past a few hundred
	// metres aerial perspective owns the colour of everything, which is what
	// plate 1 shows and what Atmosphere already does to the value and the
	// chroma. So hand the far field over to the haze and keep the painted blue
	// for the ground the player is actually driving on.
	//
	// Read off the fog varyings rather than vViewPosition, deliberately:
	// vViewPosition exists only in the physical program, and this chunk is
	// shared with lambert and phong. Same reasoning as the uniform declarations
	// living in "common". A material with fog off keeps the full effect, which
	// is the right default — everything in this game that has no fog is either
	// unlit or in the near field.
	float _coolDist = 0.0;
	#ifdef USE_FOG
		_coolDist = length( vFogWorldPos - vFogCamPos );
	#endif
	_coolM *= 1.0 - smoothstep( uShadowCoolNear, uShadowCoolFar, _coolDist );

	// ── and it belongs to the ground ─────────────────────────────────────────
	// The brief's word for what this draws is a cast-shadow *mass*, and in every
	// plate that mass lies on the ground. Applied to all orientations, the same
	// amount that makes the meadow right turned the camper's flanks navy in the
	// vehicle view — a red vehicle arriving at the frame as dark slate is not a
	// style, it is a broken asset — and it does the same to trunks and cliff
	// faces, which the brief separately says keep their own hue.
	//
	// So taper it off toward vertical. This is also the physical story rather
	// than a fudge: the blue in a real cast shadow is skylight, a wall sees half
	// the dome that a floor does, and the reference paints it that way.
	// geometryNormal is view-space and viewMatrix is a rotation, so the
	// transpose-multiply below is its world-space form; viewMatrix is declared
	// in three's own fragment prefix for every program.
	vec3 _coolWN = normalize( ( vec4( geometryNormal, 0.0 ) * viewMatrix ).xyz );
	_coolM *= mix( uShadowCoolUp, 1.0, smoothstep( 0.20, 0.70, _coolWN.y ) );

	vec3 _d = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
	// The brief's words for the mass are "soft, HIGH-VALUE violet-blue", and that
	// last part is the half this term was missing. Measured over every blue-led
	// pixel in the frame (tools/_scratch/coolstat.mjs), plate 3's shadow mass
	// averages srgb(64,85,119) at luma 0.326 against sunlit gold at 0.47 — a
	// ratio of 0.69 — while ours came back at luma 0.20-0.24 against sunlit 0.61,
	// a ratio of 0.40. Same hue, same coverage, half the value: which is exactly
	// why the frames read as cobalt spilled on the ground rather than as shade.
	//
	// Note this is NOT sun.shadow.intensity's job after all, and that was worth
	// finding out by sweeping it: 0.82 / 0.70 / 0.58 moved the blue mass from
	// luma 0.236 to 0.235 to 0.235. Lightening the shadow lets more sun into the
	// pixel, the rotation then has more warm to cancel, and the two effects
	// almost exactly annul. The value has to be put back on the cool side of the
	// rotation, which is where the reference has it.
	vec3 _cool = uShadowCool * ( dot( _d, vec3( 0.2126, 0.7152, 0.0722 ) ) * uShadowCoolLift );
	reflectedLight.indirectDiffuse += ( _cool - _d ) * _coolM;
}
`;

const DEFAULTS = {
  // Tuned against the reference plates: a very wide terminator, gentle
  // banding, and almost no direct specular. The reference's shaded meadow sits
  // only slightly below its lit meadow in value — the shading does very little
  // work, and colour does the rest.
  // 0.48, up from 0.36. Widening the terminator is the cheapest way to stop a
  // back-facing conifer card or a shaded shrub from arriving at the grade as a
  // silhouette with nothing in it, and it is what the reference does: its
  // shaded masses are lit masses in a different key, not absences.
  wrap: 0.48,        // 0 = physical, 1 = fully wrapped
  // Banding is the direct expression of the brief's "large areas of uniform
  // colour with few shading gradients". At 0.45/3.0 the quantisation was a
  // suggestion — a smooth terrain normal still produced a smooth ramp, which is
  // exactly the "realistic renderer" tell the art director called out. Fewer,
  // firmer, still-soft-edged steps make a mountain flank read as two or three
  // painted masses instead of a gradient.
  steps: 2.6,        // number of quantisation bands
  // Softer and weaker than the 0.24 / 0.62 the terrain-only era wanted. The
  // same quantisation that reads as painted masses on a mountain flank reads as
  // a hard step across a leaf card, and foliage is now on this path too.
  soft: 0.30,        // band edge softness (0.5 = no banding at all)
  banding: 0.52,     // blend between smooth wrap and hard bands
  specular: 0.14,    // direct specular scale
  // Minimum diffuse response — nothing goes fully unlit. Raised back to 0.13
  // once foliage adopted stylizeDiffuse: the note that used to sit here said
  // the floor was irrelevant to foliage because trees are ShaderMaterials that
  // never ran this term, and that stopped being true. Trees, ground cover and
  // grass are now the largest consumers of it, and they are the surfaces that
  // were reading as black holes. It still has to stay modest, because it is
  // also what decides how much *form* a big terrain mass keeps: pushed much
  // past this the shaded flank of the hero massif closes to within a few
  // percent of its lit flank and the mountain reads as one smooth beige lump.
  floor: 0.13,

  // ── golden-hour rim ──────────────────────────────────────────────────────
  // Strength is generous because it is gated hard: the fresnel exponent keeps
  // it inside a few degrees of the silhouette and the back gate switches it off
  // entirely on anything the sun is not behind, so it costs nothing in the
  // front-lit views and everything it does show up in is a backlit edge.
  //
  // Note it rides on directLight.color, which carries the shadow factor, so a
  // silhouette edge that the shadow map calls occluded gets 1 - intensity of
  // it (0.18 at the shipping value). That is the right sign — a rim needs the
  // light to actually reach the edge — and it is why the strength reads high.
  // 0.50, not the 1.30 the first pass wanted. Swept on the backlit view at
  // 0 / 1.3 / 2.4, and the failure mode is specific to what this game's near
  // field is made of: a grass blade is a thin card seen edge-on, so
  // 1 - dot(N,V) is near 1 across the *whole* field, and a rim strong enough
  // to draw a tree edge instead lifts every blade at once. At 1.3 the backlit
  // field went pale pink and lost the blue shadow structure underneath it; at
  // 2.4 it blew out. The rim is therefore priced for the surfaces that have a
  // real silhouette — rock, terrain ridges, the camper, animals — and the
  // grass keeps getting its backlight from its own translucency term, which is
  // the right owner of it.
  //
  // The tree canopy, which is what the backlit view is actually for, is on raw
  // ShaderMaterials and gets none of this. stylizeRim() below is the opt-in for
  // it, matching the stylizeDiffuse() pattern; adopting it is the trees
  // author's call and is written up in docs/INTEGRATION_REQUESTS.md.
  // Down again to 0.22 after a full-res round at 0.50. It did widen the value
  // range on paper — hero lumaP95 0.754 -> 0.847, lumaRange 0.407 -> 0.493 —
  // but every bit of that was bought at the *top* end, by lifting grazing
  // terrain and grass, and the frames read paler rather than deeper. A range
  // bought by blowing highlights is not the range the reference has; plate 1
  // gets its 0.705 from a black point at 0.161. So the rim keeps only the job
  // it does honestly: a defined edge on rock, ridgelines and the camper.
  rim: 0.22,
  rimPow: 3.4,       // fresnel exponent: higher = tighter edge
  rimBack: 0.10,     // how far behind the surface the sun has to be

  // ── the cool cast-shadow mass ────────────────────────────────────────────
  // Plate 3 — the plate the brief says to judge eye-level views by — puts about
  // 40% of its ground under one large, soft cast shadow, and that shadow is not
  // a darker gold. Measured on the plate itself: sunlit grass runs
  // srgb(149,100,45) / srgb(130,91,56) at luma 0.34-0.42, and the shadow mass
  // beside it runs srgb(24,60,99) and srgb(47,66,102) at luma 0.22-0.25. It is
  // a saturated blue at three quarters of the sunlit value, and it is what
  // draws every shape in the picture.
  //
  // No amount of physically correct blue *light* reaches that, and it is worth
  // being explicit about why, because two authors have now tried: our gold
  // ground has a linear blue reflectance of 0.068. Lighting it with a
  // periwinkle sky multiplies that 0.068; it cannot make the pixel blue-led.
  // The plate's shadow is painted, not simulated. So this rotates the hue of
  // the shadowed fraction toward the plate's blue at constant luminance, which
  // is the same move a painter makes and costs no value structure — the value
  // drop is still sun.shadow.intensity's job, and the two are independent.
  //
  // It applies to the *cast* shadow only, never to the terminator: a surface
  // simply turned away from the sun keeps its own hue, which is what the brief
  // means by shaded foliage staying olive and shaded ground staying warm
  // srgb(76,64,48). Both things are true at once and this is the seam between
  // them.
  //
  // shadowCool is the target hue, normalised to luminance 1 at construction so
  // the amount below is a pure hue rotation. Authored from the plate's own
  // srgb(47,66,102), which in linear is 1 : 2.04 : 4.81 about its own luma.
  //
  // RE-AUTHORED after seeing it at full strength. The old triple was read off
  // the *deepest* blue in plate 3, srgb(47,66,102), which is the darkest corner
  // of the shadow and not the mass. Rotated all the way onto it, our meadow and
  // drive frames came back with a royal-blue paint between the grass — the
  // right shape and the wrong pigment; it read as spilled water, not as shade.
  //
  // The mass itself, sampled across plate 3's shadowed meadow on a 12x8 grid,
  // is much quieter: srgb(41,63,77) chroma 0.14 and srgb(42,65,87) chroma 0.18,
  // against sunlit gold beside it at srgb(177,109,44) chroma 0.52. So it is a
  // *desaturated* slate at about half the sunlit value, and the previous triple
  // was three times its chroma.
  //
  // The amount cannot fix that, and this is the trap worth writing down: our
  // shadowed gold starts at G/R 0.52, B/R 0.14, so a partial rotation does not
  // give a paler blue — it gives grey, because the path from that gold to any
  // blue passes through neutral. The plate's shadow is unambiguously blue-led,
  // i.e. a full rotation. The saturation therefore has to come out of the
  // *target*, with the amount left high. Landing colour, computed at our
  // shadow's own luminance: srgb(39,50,61) before the grade, which the grade's
  // vibrance and cool lift then carry to about the plate.
  // Trimmed once more to (0.70, 1.00, 1.51) after seeing a full-res round where
  // a whole hillside was inside one cast shadow. At (0.62, 1.00, 1.60) the mass
  // measured chroma 0.213 — the number plate 3 gives if you average its shadow
  // together with its river, which is not the comparison that matters. The
  // shadow *alone* in that plate is chroma 0.14-0.18, and at this game's scale
  // (a low golden-hour sun puts entire slopes in shadow, not just tree shapes)
  // the difference between those two numbers is the difference between shade
  // and a hill painted cornflower. Swept: 0.213 / 0.178 / 0.144 chroma at three
  // desaturations; 0.178 is the plate.
  shadowCool: new THREE.Color(0.70, 1.00, 1.51),
  // How far a fully shadowed pixel goes.
  //
  // 0.42 was picked on the reasoning that 1.0 would put a cast shadow exactly on
  // the plate's blue and read as a hole. Swept and measured, that reasoning was
  // wrong in an important way: the rotation is a *mix*, so between about 0.4 and
  // 0.6 a gold pixel is not part-way to blue, it is sitting on the crossing
  // point where no channel leads — a neutral. Measured across 0.42 / 0.65 / 0.85
  // / 1.0 on meadow and drive, cool pixels went 0.6% / 1.4% / 5.2% / 8.0%: the
  // whole first half of the range buys nothing at all, because it is spent
  // walking the gold down to grey rather than up to blue. A value under ~0.7 is
  // not a subtle version of this effect, it is the effect switched off with the
  // saturation cost still paid.
  //
  // So it sits in the upper half, and the ceiling is held by the *grade*
  // instead: the cool lift tint in PostFX lands a fully-rotated shadow on
  // srgb(44,60,96) against plate 3's srgb(47,66,102), which is the plate rather
  // than an overshoot of it. The guardrail that matters (an earlier build was
  // rejected at ~20% blue *everywhere*) is held by the gSunShadow mask, not by
  // this number — a surface merely turned away from the sun is untouched at any
  // amount.
  // Swept against plate 3 at 0.92 / 0.55 / 0.35 on the meadow anchor with cloud
  // shadow frozen. 0.92 was measurably closer on blue-led pixel COUNT but read
  // as blue paint laid over the ground rather than as shadowed grass — the
  // reference's shadow mass is soft and high-value, and ours was arriving hard
  // and saturated. 0.55 keeps the gold reading as gold underneath, which is the
  // thing the count cannot see. A case where the frame overrules the metric.
  shadowCoolAmt: 0.55,
  // Where the shadow mask saturates. 1.0 is the old linear behaviour; lower
  // values pull partially-occluded pixels into the mass at full strength, which
  // is what turns speckle into a shape. Swept — see the note in SHADOW_COOL.
  shadowCoolReach: 0.30,
  // Where the painted blue hands over to aerial perspective. See the note in
  // SHADOW_COOL: eye-level ground is inside `near`, a vista's mid and far
  // ground is past `far`, and the crossfade between them is wide enough that
  // driving toward a shadow never shows a moving edge.
  // How much of it a vertical surface keeps. Not zero: a cliff face or a trunk
  // in a big shadow does pick up some sky, and cutting it to nothing puts a
  // visible seam where the ground meets anything standing on it.
  shadowCoolUp: 0.30,
  // Value gain applied as the pixel rotates. 1.0 is the luminance-preserving
  // rotation this started as. See the note beside _cool.
  // Swept at 1.0 / 1.4 / 1.8, measured over the blue-led population of the
  // meadow frame against plate 3's own:
  //           blue mass                luma   chroma   frame lumaP05
  //   1.0     srgb( 43, 53, 80)        0.208   0.150      0.186
  //   1.4     srgb( 47, 66,101)        0.254   0.214      0.211
  //   1.8     srgb( 54, 80,118)        0.303   0.253      0.231
  //   plate3  srgb( 64, 85,119)        0.326   0.221      0.195
  // 1.8 lands the mass almost exactly on the plate and costs 0.045 of the
  // frame's black point to do it, which is the wrong trade in a round whose
  // other ship-blocker is that the blacks are too high. 1.55 keeps the mass
  // recognisably the plate's colour and the black point at the plate's.
  shadowCoolLift: 1.45,
  shadowCoolNear: 110.0,
  shadowCoolFar: 520.0,
  // NOT A KNOB, DELIBERATELY. A shaped floor — one that fades across the back
  // hemisphere so a surface 70 degrees past the terminator sits below one at 40
  // — was built here and reverted, because it measured as a no-op. The river
  // view's foreground bank, which is the surface the whole idea was for, moved
  // from luma 0.299 to 0.290 at backFloor 0.46 and 0.288 at 0.30, and the
  // forest frame moved 0.003 of lumaMean. The reason is arithmetic: on a
  // back-facing surface the floor supplies only about a third of the light and
  // ambient supplies the rest, so halving the floor moves the pixel by a sixth
  // of a sixth. Anything that wants form on the dark side of a mass has to come
  // from the ambient term's orientation response, not from here.
};

/** shadowCool, scaled to luminance 1 so the amount is a pure hue rotation. */
function normalisedCool(src = DEFAULTS.shadowCool) {
  const c = src.clone();
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return c.multiplyScalar(1 / Math.max(l, 1e-4));
}

let patched = false;

export function patchStylizedLighting() {
  if (patched) return;
  patched = true;

  const CHUNK = 'lights_physical_pars_fragment';

  // Whitespace-tolerant: three's bundled build strips the blank line that its
  // source tree has between these two statements, and an exact-string match
  // against the source form silently no-ops against the build.
  const ok = patchChunk(
    CHUNK,
    /float dotNL = saturate\( dot\( geometryNormal, directLight\.direction \) \);\s*vec3 irradiance = dotNL \* directLight\.color;/,
    STYLIZED_DIRECT,
    'Stylize'
  );
  if (!ok) return;

  // ── capture the sun's shadow factor ──────────────────────────────────────
  // three multiplies it straight into directLight.color and then forgets it, so
  // by the time any of our code runs there is no way to tell a pixel that is in
  // a cast shadow from one that is merely dim. The cool shadow mass needs
  // exactly that distinction, so stash it on the way past. The line only exists
  // for light indices below NUM_DIR_LIGHT_SHADOWS, which in this game is the
  // sun and nothing else; when shadows are off the line is not emitted at all
  // and gSunShadow keeps its declared 1.0, i.e. no shadow anywhere.
  patchChunk(
    'lights_fragment_begin',
    /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ i \],([\s\S]*?)\) : 1\.0;/,
    'float _dirSh = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ],$1) : 1.0;\n\t\tgSunShadow = min( gSunShadow, _dirSh );\n\t\tdirectLight.color *= _dirSh;',
    'Stylize'
  );

  // ── the cool cast-shadow mass ────────────────────────────────────────────
  // Rotated at the end of lighting rather than inside the direct term, because
  // it has to act on the *total* — a shadowed pixel is mostly ambient, and
  // tinting only the sun's contribution would leave the mass it is meant to
  // draw almost untouched. Luminance-preserving, so value structure is entirely
  // sun.shadow.intensity's business and the two can be tuned independently.
  THREE.ShaderChunk.lights_fragment_end += SHADOW_COOL;

  // Direct specular must use the unbanded term — banding a highlight rings.
  patchChunk(
    CHUNK,
    /reflectedLight\.directSpecular \+= irradiance \* BRDF_GGX\(/,
    'reflectedLight.directSpecular += rimIrradiance + specIrradiance * BRDF_GGX(',
    'Stylize'
  );

  // Guarded, and it declares stylizeDiffuse() as well as the uniforms. A
  // MeshStandardMaterial already receives the stylised response through the
  // patched RE_Direct_Physical, but its author may also include STYLIZE_PARS
  // (there is no way to tell from inside a shader which path you are on).
  // Without the guard that is a redefinition error and the material silently
  // fails to compile.
  THREE.ShaderChunk[CHUNK] =
    STYLIZE_PARS + '\nuniform float uStyleSpecular;\n' + THREE.ShaderChunk[CHUNK];

  // The cool-shadow declarations go in `common`, not in the physical pars,
  // because lights_fragment_begin and lights_fragment_end are shared with the
  // lambert and phong programs. Declaring them only alongside the physical
  // lighting would compile fine today — this game has no Lambert material — and
  // take the build down the day someone adds one. gSunShadow is a global with a
  // constant initialiser, so a material whose shadows are off reads 1.0 rather
  // than an undefined value. Unused declarations in the vertex and depth
  // programs cost nothing; the compiler drops them.
  THREE.ShaderChunk.common =
    'uniform vec3 uShadowCool;\nuniform float uShadowCoolAmt;\nuniform float uShadowCoolReach;\nuniform float uShadowCoolUp;\nuniform float uShadowCoolLift;\nuniform float uShadowCoolNear;\nuniform float uShadowCoolFar;\nfloat gSunShadow = 1.0;\n'
    + THREE.ShaderChunk.common;

  injectUniforms('lights', {
    uStyleWrap:     { value: DEFAULTS.wrap },
    uStyleSteps:    { value: DEFAULTS.steps },
    uStyleSoft:     { value: DEFAULTS.soft },
    uStyleBanding:  { value: DEFAULTS.banding },
    uStyleSpecular: { value: DEFAULTS.specular },
    uStyleFloor:    { value: DEFAULTS.floor },
    uStyleRim:      { value: DEFAULTS.rim },
    uStyleRimPow:   { value: DEFAULTS.rimPow },
    uStyleRimBack:  { value: DEFAULTS.rimBack },
    uShadowCool:    { value: normalisedCool() },
    uShadowCoolAmt: { value: DEFAULTS.shadowCoolAmt },
    uShadowCoolReach: { value: DEFAULTS.shadowCoolReach },
    uShadowCoolUp: { value: DEFAULTS.shadowCoolUp },
    uShadowCoolLift: { value: DEFAULTS.shadowCoolLift },
    uShadowCoolNear: { value: DEFAULTS.shadowCoolNear },
    uShadowCoolFar: { value: DEFAULTS.shadowCoolFar },
  });
  verifyUniforms('Stylize', ['uStyleWrap', 'uStyleSpecular', 'uStyleFloor', 'uShadowCool']);
}

// ── Opt-in for custom ShaderMaterials ───────────────────────────────────────
// The chunk patch above only reaches materials that use Three's physical
// lighting. Trees, water and waterfalls roll their own, so they get none of it
// — and it shows: a near, shadowed conifer card in the `waterfall` view renders
// at literal zero, where the reference's darkest foliage sits at luma 0.37.
// This is the `fogUniforms()` pattern: merge the uniforms, call the function,
// and a custom shader lands on the same lighting response as everything else.
//
//   import { stylizeUniforms, STYLIZE_PARS } from '../render/Stylize.js';
//   uniforms: THREE.UniformsUtils.merge([stylizeUniforms(), { … }])
//   fragmentShader: STYLIZE_PARS + `… float nl = stylizeDiffuse( dot(N, L) ); …`
export const STYLIZE_PARS = /* glsl */`
#ifndef STYLIZE_DECLARED
#define STYLIZE_DECLARED
uniform float uStyleWrap;
uniform float uStyleSteps;
uniform float uStyleSoft;
uniform float uStyleBanding;
uniform float uStyleFloor;
uniform float uStyleRim;
uniform float uStyleRimPow;
uniform float uStyleRimBack;

// rawNL is the unclamped dot(normal, lightDir). Returns the stylised diffuse
// response: wide soft terminator, gently banded, floored so nothing goes to a
// hole. Multiply by your light colour and shadow mask as usual.
float stylizeDiffuse( float rawNL ) {
  float wrapNL = clamp( ( rawNL + uStyleWrap ) / ( 1.0 + uStyleWrap ), 0.0, 1.0 );
  float s  = wrapNL * uStyleSteps;
  float f  = floor( s );
  float fr = s - f;
  float band = ( f + smoothstep( 0.5 - uStyleSoft, 0.5 + uStyleSoft, fr ) ) / uStyleSteps;
  float nl = mix( wrapNL, band, uStyleBanding );
  return uStyleFloor + ( 1.0 - uStyleFloor ) * nl;
}

// Golden-hour rim, for a shader that does its own lighting. rawNV is
// dot(normal, viewDir) and rawVL is dot(viewDir, lightDir), both unclamped
// and both with viewDir pointing from the surface toward the camera. Returns a
// scalar to multiply by the light colour and ADD — never multiply it by albedo,
// or a dark conifer gets a dark rim, which is the one thing a rim must not do.
float stylizeRim( float rawNV, float rawVL ) {
  float f = 1.0 - clamp( rawNV, 0.0, 1.0 );
  float b = clamp( -rawVL, 0.0, 1.0 );
  return uStyleRim * pow( f, uStyleRimPow ) * smoothstep( uStyleRimBack, 1.0, b );
}
#endif`;

/** Uniform block a custom ShaderMaterial merges in to use `stylizeDiffuse`. */
export function stylizeUniforms() {
  return {
    uStyleWrap:    { value: DEFAULTS.wrap },
    uStyleSteps:   { value: DEFAULTS.steps },
    uStyleSoft:    { value: DEFAULTS.soft },
    uStyleBanding: { value: DEFAULTS.banding },
    uStyleFloor:   { value: DEFAULTS.floor },
    uStyleRim:     { value: DEFAULTS.rim },
    uStyleRimPow:  { value: DEFAULTS.rimPow },
    uStyleRimBack: { value: DEFAULTS.rimBack },
  };
}

export class Stylize {
  constructor(scene) {
    patchStylizedLighting();
    this.scene = scene;
    this.params = { ...DEFAULTS };
    this._materials = new Set();
  }

  register(material) {
    if (!material || material.lights === false) return material;
    if (this._materials.has(material)) return material;
    this._materials.add(material);
    // Same reason as Atmosphere.register: built-in materials keep the values
    // they were compiled with unless the shader is stashed, so any runtime
    // tuning of the stylised response would reach only the custom shaders.
    captureShader(material);
    return material;
  }

  harvest() {
    this.scene.traverse((o) => {
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) this.register(m);
    });
  }

  update() {
    const p = this.params;
    for (const m of this._materials) {
      const u = m.userData?.shader?.uniforms ?? m.uniforms;
      if (!u || !u.uStyleWrap) continue;
      u.uStyleWrap.value = p.wrap;
      u.uStyleSteps.value = p.steps;
      u.uStyleSoft.value = p.soft;
      u.uStyleBanding.value = p.banding;
      u.uStyleSpecular.value = p.specular;
      u.uStyleFloor.value = p.floor;
      if (u.uStyleRim) u.uStyleRim.value = p.rim;
      if (u.uStyleRimPow) u.uStyleRimPow.value = p.rimPow;
      if (u.uStyleRimBack) u.uStyleRimBack.value = p.rimBack;
      if (u.uShadowCoolAmt) u.uShadowCoolAmt.value = p.shadowCoolAmt;
      if (u.uShadowCoolReach) u.uShadowCoolReach.value = p.shadowCoolReach;
      if (u.uShadowCoolUp) u.uShadowCoolUp.value = p.shadowCoolUp;
      if (u.uShadowCoolLift) u.uShadowCoolLift.value = p.shadowCoolLift;
      if (u.uShadowCoolNear) u.uShadowCoolNear.value = p.shadowCoolNear;
      if (u.uShadowCoolFar) u.uShadowCoolFar.value = p.shadowCoolFar;
      if (u.uShadowCool) u.uShadowCool.value.copy(normalisedCool(p.shadowCool));
    }
  }
}
