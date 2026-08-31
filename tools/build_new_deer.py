"""Build the hand-authored white-tailed DOE: one mesh, one rig, one rest pose.

    /opt/homebrew/bin/blender --factory-startup -b \
        --python tools/build_new_deer.py

Idempotent and total: it clears the scene and rebuilds everything, every time.
The script is the source of truth; `assets/models/new_deer.blend` is an output,
and any edit made by hand in an open session is destroyed by the next run.

The species is *Odocoileus virginianus*, the northern woodland white-tail, and
this is the FEMALE — a doe, so no antlers and no pedicles, a finer skull and a
neck that is slender the whole way rather than swelling at the crest. The build
is authored **at true scale: one Blender unit is one metre**, which is the only
reason the numbers below read as anatomy rather than as taste.

Three objects leave with the rig:

* `Doe_Body`   the fused, skinned animal — coat / white / dark
* `Doe eyes`   both eyes as one object, bone-parented to `head`
* `Doe_Rig`    the canonical quadruped skeleton every hand-authored mammal wears

The pose is the NEUTRAL SYMMETRIC STAND and nothing else. No clips are authored
here; `animal_kit.rest_pose` is what guarantees the saved file holds the rest
transform rather than whatever frame happened to be evaluated last.
"""

from pathlib import Path
import math
import sys

import bpy
from mathutils import Matrix, Vector, kdtree

sys.path.append(str(Path(__file__).resolve().parent))
import animal_kit as K  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
BLEND_PATH = ROOT / "assets" / "models" / "new_deer.blend"
GLB_PATH = ROOT / "public" / "models" / "new_deer.glb"
SHOT_DIR = ROOT / "tools" / "_scratch"

# ── the animal, as a page of numbers ─────────────────────────────────────────
#
# +Y forward, +Z up, hooves on Z = 0, one unit = one metre.
#
# Withers 0.90 m and ear tip about 1.45 m. A northern white-tail doe stands
# 0.81-0.95 m at the shoulder; this sits in the middle of that band, which is
# deliberately BELOW where a mature buck would go.
WITHERS = 0.900

# The thinnest feature that must survive the fuse is the cannon bone, about
# 40 mm across. Divide by three.
VOXEL = 0.013

# The reduction is a planar DISSOLVE, not a collapse, and the choice is forced
# twice over. A collapse decimator is not mirror-symmetric — it merges whichever
# edge is cheapest and takes the left flank apart differently from the right, so
# this exact build measured 41.8% mirror-paired vertices at ratio 0.32 against
# 100% before it. And a collapse has no notion of a material boundary, so it
# walks straight across the edge of the throat patch and returns it as a
# staircase. A dissolve delimited by MATERIAL can do neither: 8 degrees takes
# 16146 faces to 3546 and still measures 98.8% symmetric.
DISSOLVE_ANGLE = 8.0


def srgb(hexval):
    """sRGB hex -> LINEAR RGB, which is the space glTF stores and three reads.

    Writing an sRGB triple straight into a Principled base colour is the quiet
    way to ship a coat two stops too bright.
    """
    out = []
    for shift in (16, 8, 0):
        c = ((hexval >> shift) & 0xFF) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return tuple(out)


# Three solid blocks and nothing else — no fur, no texture, albedo only.
COAT = srgb(0xB07A4C)   # warm caramel-tan: body, legs, outer neck, head
WHITE = srgb(0xF4F1EC)  # underbelly, throat, inner ear, under-tail plume
DARK = srgb(0x26221F)   # hooves, nose pad, eyes
HORN = srgb(0x9C8763)   # the stag's antlers, worn by one variant only
ROUGH = 0.35            # the brief's satin band is 0.30-0.40

# ── joints ───────────────────────────────────────────────────────────────────
#
# The canonical skeleton gives each limb FOUR points (upper / lower / foot, plus
# a non-deforming toe). On an ungulate that is one joint short of the anatomy —
# shoulder, elbow, carpus, fetlock, hoof is five — so the chain is mapped to the
# joint that actually carries the swing and the fetlock is modelled but not
# boned. See the note in the report at the bottom of this file.
#
# `rest_extension` is checked against these before anything is rendered: a leg
# standing at 97% of its own reach has nothing left for a stride. Both chains
# below land inside the 0.82-0.88 band on purpose.

SHOULDER = (0.082, 0.350, 0.660)     # glenohumeral joint
# The elbow sits 19 mm further back than the silhouette alone would ask for,
# and the reason is stride rather than looks. The two-link IK that solves a
# gait spans shoulder -> elbow -> CARPUS; the cannon below it is rigid, so the
# whole fore-aft reach of a foreleg is `sqrt(reach^2 - drop^2)`. At the
# original elbow that was 0.461 m of excursion against the hind leg's 0.632,
# and the foreleg alone would have clamped every gait in the file. Deepening
# the zigzag takes it to 0.537 m (+16%) and leaves rest extension at 0.833 —
# still inside the 0.82-0.88 band a standing quadruped wants.
ELBOW = (0.090, 0.196, 0.442)
CARPUS = (0.094, 0.315, 0.248)       # the foreleg's "knee" — anatomically a wrist
FETLOCK = (0.094, 0.320, 0.085)      # mesh only; no bone lands on it
FORE_HOOF = (0.094, 0.322, 0.000)

HIP = (0.090, -0.340, 0.782)
STIFLE = (0.096, -0.182, 0.568)
HOCK = (0.098, -0.345, 0.316)
HIND_HOOF = (0.098, -0.295, 0.000)

NECK_BASE = (0, 0.328, 0.830)
NECK_MID = (0, 0.430, 0.998)
POLL = (0, 0.568, 1.178)             # atlas / base of the skull
NOSE = (0, 0.800, 1.072)

EAR_BASE = (0.047, 0.578, 1.202)
EAR_TIP = (0.146, 0.556, 1.358)

# The scut hangs 0.247 m from root to tip, and every one of these numbers is
# set against the BUTTOCK rather than against the pelvis. Two passes were lost
# here. First the tail ran to y = -0.556 while the rump ellipsoid reached back
# to -0.596, so the tip finished 34 mm inside the animal and all that emerged
# was a nub. Then it was lengthened but left hugging the rump, which hid it a
# second way: from dead astern a tail that sweeps BACKWARD is foreshortened to
# a bump, however long it is. It has to clear the backside at every height —
# the buttock was pulled in to -0.550 and the scut swept out behind it, so it
# stands 10 to 115 mm proud from root to tip and reads as a hanging blade from
# every angle. A tail is only as long as the part of it that clears the rump.
TAIL_BASE = (0, -0.505, 0.834)
TAIL_MID = (0, -0.580, 0.766)
TAIL_TIP = (0, -0.600, 0.610)
TAIL_CHAIN = (TAIL_BASE, TAIL_MID, TAIL_TIP)
# The neck and head as one polyline, for skinning: what makes a vertex
# 'neck' is being NEAR the neck, not being in front of some plane.
NECK_CHAIN = (NECK_BASE, NECK_MID, POLL, NOSE)

EYE = (0.053, 0.653, 1.177)          # the eye mesh's own centre

FORE_CHAIN = (SHOULDER, ELBOW, CARPUS, FORE_HOOF)
HIND_CHAIN = (HIP, STIFLE, HOCK, HIND_HOOF)
FORE_MESH_CHAIN = (SHOULDER, ELBOW, CARPUS, FETLOCK, FORE_HOOF)

RIG_SPEC = {
    # A ground control lying along +Y at Z = 0: a horizontal +Y root has the
    # identity basis, which keeps every other reading of this rig literal.
    "root": ((0, -0.20, 0.0), (0, 0.35, 0.0)),
    "pelvis": ((0, -0.410, 0.814), (0, -0.150, 0.834)),
    "spine_01": ((0, -0.150, 0.834), (0, 0.090, 0.840)),
    "chest": ((0, 0.090, 0.840), NECK_BASE),
    "neck_01": (NECK_BASE, NECK_MID),
    "neck_02": (NECK_MID, POLL),
    "head": (POLL, NOSE),
    "jaw": ((0, 0.610, 1.134), (0, 0.788, 1.056)),
    "ear": (EAR_BASE, EAR_TIP),
    "scapula": ((0.058, 0.288, 0.850), SHOULDER),
    "fore": {"L": FORE_CHAIN},
    "hind": {"L": HIND_CHAIN},
    "tail_01": (TAIL_BASE, TAIL_MID),
    "tail_02": (TAIL_MID, TAIL_TIP),
}

# The ear's own frame: which way the cup faces. Mostly forward, canted out.
EAR_FACE = (0.60, 0.74, 0.26)


def mirror(p, sgn):
    return (sgn * p[0], p[1], p[2])


def chain_distance(co, chain):
    return min(K.segment_distance(co, chain[i], chain[i + 1])
               for i in range(len(chain) - 1))


def oriented_blob(name, a, b, half_width, half_thick, face, overlap=1.10,
                  segments=18, rings=12):
    """A flattened ellipsoid running a -> b, thin along `face`.

    `ellipsoid_between` and `tapered_between` both orient with
    `to_track_quat("Z", "Y")`, which picks the flat axis for you off a world
    up-hint. That is fine for a shank, whose cross-section is round, and wrong
    for the two parts of a deer that are deliberately PLANAR: the ear and the
    scut. Both need their thin axis pointed somewhere specific, so this takes it
    as an argument.

    Mirroring is exact. Negating x in `a`, `b` and `face` flips y and z of the
    basis; deriving x as `y cross z` then flips the width axis back, and since
    the blob is symmetric about that axis the result is the true mirror — which
    is what `check_symmetry` is going to insist on.
    """
    a, b = Vector(a), Vector(b)
    delta = b - a
    z = delta.normalized()
    y = Vector(face)
    y = (y - z * y.dot(z))          # orthogonalise against the long axis
    y.normalize()
    x = y.cross(z)
    ob = K.uv(name, (a + b) * 0.5,
              (half_width, half_thick, delta.length * 0.5 * overlap),
              segments, rings)
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = Matrix((x, y, z)).transposed().to_4x4().to_quaternion()
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    ob.rotation_mode = "XYZ"
    return ob


# ── body ─────────────────────────────────────────────────────────────────────

def build_body(mats):
    """One fused doe from deliberately overlapping volumes.

    The silhouette is the whole job, and a doe is read at distance off four
    things: a back line that is level and lifts a touch to the croup, a barrel
    that is DEEP and NARROW, legs that are long and thin, and a long neck
    leaving the withers at a clear angle with the head carried well above the
    back.

    Every volume spans at least twice the gap to its neighbour. That is not
    decoration: a union of shapes that merely meet at a waist scallops, and a
    row of evenly spaced rings comes back as a string of sausages down the back
    where a deer has one continuous rib cage. Overlap is measured against the
    SPACING, not against zero.
    """
    parts = []

    # The barrel. Depth 0.37 m against width 0.29: a deer's rib cage is
    # laterally compressed, and a barrel as wide as it is deep is a pig.
    #
    # The brisket sits at 0.50 m against withers of 0.90 — a chest depth of 44%
    # of standing height. The first pass had it at 0.53 and the animal read as
    # an antelope: on a white-tail the barrel is deep and the daylight under it
    # is a little less than half the height, and a few centimetres either way is
    # the whole difference between a deer and something built for the savannah.
    for name, loc, scale in (
        # The rib cage as ONE mass, spanning shoulder to loin.
        ("Doe barrel", (0, 0.010, 0.710), (0.152, 0.380, 0.192)),
        # The two rises in the back line. A deer is level to slightly higher at
        # the rump; the withers volume is what sets 0.90 m.
        ("Doe withers", (0, 0.235, 0.716), (0.142, 0.255, 0.196)),
        # The loin. Measured, not guessed: the back line was sampled in 4 cm
        # slices and came back with a 19 mm saddle at y = -0.20, exactly where
        # the barrel and croup ellipsoids cross. Two ellipsoids that overlap in
        # SPACE still scallop between their centres, because each one's top
        # falls away as sqrt(1 - t^2) — so the fix is a third volume centred on
        # the saddle, not more overlap between the first two.
        ("Doe loin", (0, -0.140, 0.716), (0.140, 0.230, 0.186)),
        ("Doe croup", (0, -0.285, 0.744), (0.144, 0.238, 0.164)),
        ("Doe rump", (0, -0.425, 0.778), (0.112, 0.125, 0.100)),
        # The underline: brisket low and forward, flank tucked up behind it,
        # which is the line that says "runs for a living".
        ("Doe brisket", (0, 0.332, 0.632), (0.106, 0.172, 0.132)),
        ("Doe belly", (0, 0.010, 0.598), (0.122, 0.310, 0.090)),
        ("Doe flank tuck", (0, -0.245, 0.660), (0.124, 0.172, 0.108)),
        # The point of shoulder. Without it the brisket and the base of the neck
        # leave a concave notch across the front of the chest, which catches a
        # hard shadow and reads as a dent in the animal.
        ("Doe chest front", (0, 0.364, 0.752), (0.100, 0.124, 0.116)),
    ):
        parts.append(K.uv(name, loc, scale, 24, 14))

    # The two places a deer is widest. Without them the barrel is a tube on four
    # sticks and the animal reads as an alpaca. The haunch is the brief's "large,
    # smoothed hip joint" and it has to be genuinely large: it is the single
    # volume that tells a viewer the back legs drive and the front legs steer.
    #
    # The mid-flank volume is not optional and it was added after a render.
    # Without it the widest points front and back — shoulder at 0.150 m, haunch
    # at 0.164 — are separated by a barrel only 0.152 m wide over a 0.19 m gap
    # where nothing else reaches, and the union scallops into a waist. The
    # three-quarter view came back as three distinct lumps down the flank with
    # a crease between each, which is the "string of sausages" defect in its
    # other form: it is not enough that neighbouring volumes OVERLAP in space,
    # their outer extents have to form a smooth progression too.
    for side, sgn in (("L", 1), ("R", -1)):
        parts.append(K.uv(f"Doe shoulder mass {side}",
                          (sgn * 0.066, 0.250, 0.728), (0.084, 0.180, 0.160), 18, 11))
        parts.append(K.uv(f"Doe flank {side}",
                          (sgn * 0.050, -0.030, 0.700), (0.106, 0.265, 0.152), 20, 12))
        parts.append(K.uv(f"Doe haunch {side}",
                          (sgn * 0.072, -0.292, 0.700), (0.092, 0.196, 0.186), 20, 12))

    # The neck: a graceful sweeping arch, and the arch is real geometry rather
    # than a taper. The lower segment leaves the withers at 61 degrees and the
    # upper leans forward at 55, so the back of the neck is convex and the
    # throat is concave — which is the line the brief asks for.
    #
    # It is also THICK at the base. The first pass ran 0.084 half-width into
    # 0.060 and the animal came back a gazelle: a doe's neck is slender for a
    # deer, not slender for an antelope, and the taper has to start from a base
    # that is visibly continuous with the chest.
    # The neck root. The neck leaves the chest at 61 degrees, so an ellipsoid
    # ending there meets the barrel at a sharp angle and leaves a crease across
    # the front of the shoulder — visible in the three-quarter as a hard line
    # between neck and body. A ball buried in the junction is what turns it
    # into the continuous sweep the brief asks for.
    parts.append(K.uv("Doe neck root", (0, 0.292, 0.778), (0.118, 0.156, 0.128), 18, 11))
    # Depth 0.126, not 0.150. `ellipsoid_between` carries ONE thickness the
    # whole length, and a neck standing at 61 degrees turns that thickness into
    # height: at 0.150 the volume's back reached z = 0.962, six centimetres
    # over the withers, and the profile came back with a camel's hump behind
    # the poll and a dip after it. The neck is thick where it meets the chest
    # because the neck ROOT ball is there, not because the shaft is fat.
    parts.append(K.ellipsoid_between("Doe neck lower", (0, 0.330, 0.752),
                                     NECK_MID, 0.112, 0.126, 1.18))
    parts.append(K.ellipsoid_between("Doe neck upper", (0, 0.406, 0.958),
                                     POLL, 0.086, 0.110, 1.28))
    parts.append(K.uv("Doe nape", (0, 0.386, 0.910), (0.078, 0.098, 0.104), 16, 10))

    # The skull is a mass of its own, narrower than the neck it sits on, with a
    # tapering muzzle. Make it a ball on a stalk and the animal is a llama
    # however good the body is. The doe's skull is finer than a buck's and
    # carries no pedicle, so the crown stays a clean dome.
    parts.append(K.uv("Doe skull", (0, 0.620, 1.170), (0.062, 0.082, 0.074), 16, 10))
    parts.append(K.uv("Doe cheek", (0, 0.674, 1.132), (0.056, 0.070, 0.060), 14, 9))
    parts.append(K.tapered_between("Doe muzzle", (0, 0.680, 1.142),
                                   (0, 0.796, 1.078), 0.050, 0.035, 0.046, 14))
    parts.append(K.uv("Doe nose", (0, 0.800, 1.074), (0.035, 0.030, 0.029), 14, 9))
    parts.append(K.uv("Doe jawline", (0, 0.712, 1.100), (0.042, 0.072, 0.033), 14, 9))

    # Ears. Large, upright and teardrop, built as PLANAR shells rather than
    # cones: a cone tapering to a small top radius reads as a fox from every
    # angle, and a wafer vanishes from every angle except dead side-on. Width
    # 0.11 m across against 0.032 through — the first pass was half that wide
    # and the pair read as two spikes rising off the skull rather than as ears.
    for side, sgn in (("L", 1), ("R", -1)):
        base, tip = mirror(EAR_BASE, sgn), mirror(EAR_TIP, sgn)
        face = mirror(EAR_FACE, sgn)
        parts.append(oriented_blob(f"Doe ear {side}", base, tip,
                                   0.056, 0.022, face, overlap=1.02))
        parts.append(K.uv(f"Doe ear root {side}", base, (0.033, 0.044, 0.038), 12, 8))

    # The scut: broad and FLAT rather than a rope, thin fore-aft, because the
    # flash is the only signal a fleeing deer gives and a thin tail flashes
    # nothing. It hangs at rest; lifting it is a clip's job, not the mesh's.
    # Two shells of decreasing width plus a ball at the end, because a single
    # ellipsoid cannot taper and the brief asks for a plume "tapering to a
    # rounded tip". Roughly 2:1 across against through at every station, so it
    # stays a flattened blade the whole way down rather than becoming a rope.
    # Built on TAIL_CHAIN — the SAME polyline the two tail bones run along, and
    # the same one the coat rule measures against. The first pass had three
    # different tails: bones on a straight base-to-tip line, mesh on a faster
    # sweep, and a paint rule testing the straight line. The line ran 40 mm
    # forward of the blade at mid-height, straight through the buttock, so the
    # rule painted a hand's width of backside as "outer face of the tail" and
    # the white patch never got near the scut it was supposed to frame.
    for name, a, b, hw, ht in (
        ("Doe tail upper", TAIL_BASE, TAIL_MID, 0.052, 0.020),
        ("Doe tail lower", TAIL_MID, TAIL_TIP, 0.042, 0.017),
    ):
        parts.append(oriented_blob(name, a, b, hw, ht, (0, 1, 0), overlap=1.14))
    # A ball at the bend, for the reason `limb` puts one at every interior
    # joint: two blades meeting at an angle remesh into a pinched hourglass.
    parts.append(K.uv("Doe tail joint", TAIL_MID, (0.046, 0.020, 0.030), 14, 9))
    parts.append(K.uv("Doe tail tip", TAIL_TIP, (0.033, 0.015, 0.028), 14, 9))

    # Four long thin legs. A ball at every interior joint is what keeps an elbow
    # reading as flesh around a joint rather than two frustums meeting at an
    # angle — the brief asks for exactly that, "defined, smoothed spheres" at
    # the elbows and wrists. The foreleg is built over its FIVE anatomical
    # points, not the rig's four, so the fetlock stays in the silhouette even
    # though no bone lands on it.
    fore_r = [0.058, 0.043, 0.026, 0.021, 0.019]
    hind_r = [0.086, 0.050, 0.028, 0.020]
    for side, sgn in (("L", 1), ("R", -1)):
        fore = [mirror(p, sgn) for p in FORE_MESH_CHAIN]
        hind = [mirror(p, sgn) for p in HIND_CHAIN]
        for i in range(len(fore) - 1):
            parts.append(K.tapered_between(f"Doe fore {side} seg{i}", fore[i],
                                           fore[i + 1], fore_r[i], fore_r[i + 1],
                                           fore_r[i]))
        for i in range(1, len(fore) - 1):
            r = fore_r[i] * 1.08
            parts.append(K.uv(f"Doe fore {side} joint{i}", fore[i], (r, r, r), 12, 8))
        parts += K.limb(f"Doe hind {side}", hind, hind_r)

        # The hooves. Two lobes side by side, each a cone with a flat cap,
        # running from the pastern to just below Z = 0 so the flat bottom is
        # still flat after the remesh has rounded everything by half a voxel.
        # At this voxel the lobes fuse into one peanut cross-section, which is
        # the honest read of a split hoof at the size it occupies on screen.
        for tag, hoof in (("fore", fore[-1]), ("hind", hind[-1])):
            for lobe, off in (("in", -0.013), ("out", 0.013)):
                x = hoof[0] + sgn * off
                parts.append(K.tapered_between(
                    f"Doe {tag} hoof {lobe} {side}",
                    (x, hoof[1] - 0.014, 0.082), (x, hoof[1], -0.006),
                    0.013, 0.016, 0.015, 10))

    body = K.fuse(parts, "Doe_Body", voxel=VOXEL, smooth=(0.30, 6), decimate=None)
    body.data.name = "Doe_Body_Mesh"
    # The remesh can leave a handful of degenerate faces, which the glTF
    # exporter reports as "Mesh ... is not valid, and may be exported wrongly".
    body.data.validate(verbose=False)
    # One fused animal, not a bag of blobs. Anything above 1 is a volume that
    # grazed its neighbour instead of intersecting it and remeshed as its own
    # island — invisible in every measurement and obvious in every render.
    assert K.shell_count(body) == 1, "the doe fused into more than one island"

    # Subdivide before painting, and only before painting.
    #
    # A marking can be no finer than the faces it is drawn on, and the faces
    # here are the 13 mm voxel grid — which puts a 6-to-8 PIXEL staircase down
    # the edge of the throat patch at the size these stills are rendered. It is
    # the most visible defect in the whole build and no amount of moving the
    # threshold fixes it, because the threshold is not what is quantised.
    #
    # Two simple (non-smoothing) subdivisions quarter that step twice without
    # moving a single vertex of the form. They cost almost nothing in the end:
    # the dissolve below is delimited by MATERIAL, so it merges the new faces
    # straight back together everywhere except along a marking edge — which is
    # precisely where they were wanted.
    sub = body.modifiers.new("Marking resolution", "SUBSURF")
    sub.subdivision_type = "SIMPLE"
    sub.levels = sub.render_levels = 2
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.modifier_apply(modifier=sub.name)

    K.paint(body, mats, coat_rule())
    K.decimate_planar(body, angle_deg=DISSOLVE_ANGLE)
    return body


def coat_rule():
    """Where the three colour blocks sit, as a face-centre test.

    The brief asks for solid blocks mapped to the geometric forms, and the
    lesson every one of these tests encodes is the same: cut the surface SQUARE
    ON, never at a grazing angle. A gate that runs almost parallel to the
    surface it is cutting puts neighbouring faces on either side of itself, and
    the boundary arrives as a staircase of white shrapnel instead of a line.

    So the throat is a cone about the neck's own axis rather than a normal test
    (a neck standing at 60 degrees is the worst possible case for a normal
    gate), the muzzle is a band perpendicular to the MUZZLE, and the belly is a
    height plane — which is the clean cut there precisely because the underline
    is horizontal.
    """
    n0 = Vector(NECK_BASE)
    naxis = (Vector(POLL) - n0)
    naxis.normalize()
    nvent = Vector((0.0, naxis.z, -naxis.y))   # perpendicular, down-and-forward

    m0 = Vector(POLL)
    maxis = (Vector(NOSE) - m0)
    mlen = maxis.length
    maxis.normalize()
    t0 = Vector(TAIL_BASE)
    taxis = (Vector(TAIL_TIP) - t0)
    taxis.normalize()
    tvent = Vector((0.0, -taxis.z, taxis.y))   # perpendicular, forward and under

    eye_at = Vector(EYE)
    ear_face = Vector(EAR_FACE).normalized()

    def wobble(a, b, amp=VOXEL):
        """About one voxel of two-frequency noise on a marking threshold.

        A dissolve keeps a boundary crisp, but crisp ON THE REMESH GRID reads as
        a regular staircase — the eye finds the period instantly. Two
        incommensurate frequencies break the period, and a real coat margin is
        not a straight line either. Keep the amplitude near one voxel: pushed
        past that it stops reading as a soft margin and starts reading as
        damage.
        """
        return amp * (0.6 * math.sin(a * 37.0) + 0.4 * math.sin(b * 61.0 + 1.7))

    def rule(c, n):
        x, y, z = c.x, c.y, c.z
        ax = abs(x)
        sgn = 1 if x > 0 else -1

        # Distance along the muzzle, 0 at the poll and 1 at the nose — and ONLY
        # for points actually on the head. A projection onto an infinite axis is
        # defined everywhere: a hoof at z = 0.09 projects to mt = 1.0, and the
        # rule meant for the nose duly paints a black toecap on every leg.
        on_head = K.segment_distance(c, POLL, NOSE) < 0.108 and z > 0.985
        mt = ((Vector((0.0, y - m0.y, z - m0.z)).dot(maxis)) / mlen
              if on_head else -1.0)

        # ── dark ────────────────────────────────────────────────────────────
        if z < 0.080:                                   # hooves
            return 2
        if mt > 0.905:                                  # the black nose pad
            return 2
        # The eye socket, as a disc around the eye itself. The separate eye
        # meshes sit inside it, so the eye never reads as a sticker stuck on a
        # flat cheek. Kept tight: a wide disc reads as a mask, not an eye.
        if (Vector((ax, y, z)) - eye_at).length < 0.029:
            return 2

        # ── white ───────────────────────────────────────────────────────────
        # The inner ear, tested against the ear's OWN facing direction. The
        # threshold is high on purpose. An ear is a thin shell, so most of its
        # faces point within 60 degrees of the cup direction one way or the
        # other; at 0.30 the first pass painted the whole ear white and the pair
        # read as two antlers, which is the one thing a doe must not have.
        if z > 1.212 and ax > 0.032:
            d_ear = K.segment_distance(c, mirror(EAR_BASE, sgn), mirror(EAR_TIP, sgn))
            if d_ear < 0.066:
                # Inset from the rim as well as facing the right way. A facing
                # test alone paints the whole shell, rim included, and a doe
                # with two solid white blades on her head reads as a buck in
                # velvet — the one thing this animal must not be.
                return 1 if (d_ear < 0.038
                             and n.dot(Vector(mirror(ear_face, sgn))) > 0.55) else 0

        # The throat patch: a cone about the neck axis, cut square on, and only
        # over the UPPER neck. The first pass ran it the whole length of the
        # neck at a 53-degree half-angle and the doe came back in a white
        # turtleneck down to the brisket.
        p = Vector((0.0, y - n0.y, z - n0.z))
        along = p.dot(naxis)
        if 0.05 < along < 0.46:
            # The cone's half-angle NARROWS as it descends, so the bib comes to
            # a point at the base of the neck. A fixed angle over a fixed range
            # of `along` is what the first pass used, and it cut the patch off
            # with a hard horizontal line a third of the way down the neck —
            # the white read as a bib pasted on rather than as the animal's own
            # throat.
            radial = Vector((ax, p.y - naxis.y * along, p.z - naxis.z * along))
            gate = 0.74 + 2.0 * max(0.0, 0.28 - along) + wobble(along, ax, 0.03)
            if radial.length > 1e-5 and radial.dot(nvent) / radial.length > gate:
                return 1
        # The chin and the underside of the jaw, carrying the throat forward on
        # to the head so the two do not meet in a hard line at the poll.
        if 0.36 < mt < 0.86 and n.z < -0.22:
            return 1

        # The underbelly, as a plane under a convex form, following the real
        # underline: brisket low and forward, flank tucked up behind.
        #
        # The limb gate is not optional. A doe's belly sits at 0.51 m and her
        # legs pass straight through that height, so the plane alone paints all
        # four of them white to the knee and the animal comes back in stockings.
        if (ax < 0.128 and -0.46 < y < 0.44
                and z < 0.562 + 0.150 * y * y + wobble(y, ax, 0.006)
                and min(chain_distance(c, [mirror(q, sgn) for q in FORE_CHAIN]),
                        chain_distance(c, [mirror(q, sgn) for q in HIND_CHAIN])) > 0.068):
            return 1

        # The inside of the legs, where the two of them face each other. Kept
        # off the pastern deliberately: a white-tail has no socks, and a pale
        # band just above a dark hoof reads as one from every angle.
        if 0.180 < z < 0.520 and ax > 0.050 and (x * n.x) < -0.60:
            return 1

        # The scut, tested FIRST of everything back here and returned from,
        # because the rump patch below is an ellipsoid centred near the tail
        # root and would otherwise paint the tail along with it.
        #
        # A white-tail's flag is white UNDERNEATH ONLY. The outer face — the one
        # showing the whole time the tail hangs — is coat-coloured, and the
        # white is the signal she gives by lifting it. Painting the outer face
        # white spends the animal's one alarm signal on a doe standing still.
        # `chain_distance`, not `segment_distance`: measured against the bent
        # chain the blade actually follows, 0.058 clears the buttock beside the
        # tail (which measures 0.061 away) while still catching the blade.
        # Against the straight chord it was 0.05 and indistinguishable.
        if chain_distance(c, TAIL_CHAIN) < 0.058 and z < 0.856:
            # A RADIAL test about the tail's own axis, for the same reason the
            # throat is a cone: the scut hangs 18 degrees off vertical, so a
            # normal gate like `n.y > 0.28` runs almost parallel to the surface
            # it is cutting and neighbouring faces fall either side of it. That
            # is exactly what it did — a staircase of white shrapnel the whole
            # length of the tail. A radial cut crosses the shaft square on and
            # comes out as one clean line at any polygon count.
            tp = Vector((0.0, y - t0.y, z - t0.z))  # noqa: E501
            talong = tp.dot(taxis)
            radial = Vector((ax, tp.y - taxis.y * talong, tp.z - taxis.z * talong))
            if radial.length > 1e-5 and radial.dot(tvent) / radial.length > 0.34:
                return 1
            return 0

        # The rump patch, as ONE ELLIPSOID rather than a pair of half-spaces.
        # `y < a and z < b` is two perpendicular planes, and two perpendicular
        # planes meet in a corner: the first pass put a hard right-angled
        # staircase across the back of the haunch, which is a shape no marking
        # on an animal has ever had.
        # Centred ON the buttock skin, not inside the animal. The surface was
        # sampled rather than assumed: the rearmost face at x = 0.06, z = 0.76
        # sits at y = -0.566, and against a patch centred at y = -0.450 that
        # measured 1.047 — just outside, so the white stopped short and left a
        # band of coat between the patch and the scut. The tail then hung
        # against caramel and disappeared from dead astern. An ellipsoid gate
        # has to be placed against the surface it is cutting, and on a rump
        # that is 12 cm behind where the pelvis suggests.
        # Top of the patch stops at z = 0.831, just under the tail root at
        # 0.834, so no thin white lens surfaces above the scut.
        rump = Vector((ax / 0.150, (y + 0.500) / 0.135, (z - 0.705) / 0.126))
        if rump.length < 1.0 + wobble(y, z, 0.012):
            return 1
        return 0

    return rule


def build_eyes(mat):
    """Both eyes as ONE object, so the pair costs one primitive rather than two.

    Large, dark and set high on the SIDE of the skull. A deer's eye is placed
    for a 300-degree field of view, and moving it onto the front-upper quadrant
    where a predator's belongs is the fastest way to make a deer look wrong —
    this is the one animal in the cast for which the equator is correct.

    The centre is the surface point scaled to 0.95, so the lens beds into the
    face instead of balancing on it, and the shell is smooth-shaded: flat
    shading breaks the single highlight on the one feature anyone looks at into
    a blocky square.
    """
    eyes = [K.uv(f"Doe eye {side}", mirror(EYE, sgn), (0.018, 0.020, 0.020), 14, 10)
            for side, sgn in (("L", 1), ("R", -1))]
    bpy.ops.object.select_all(action="DESELECT")
    for e in eyes:
        e.select_set(True)
    bpy.context.view_layer.objects.active = eyes[0]
    bpy.ops.object.join()
    ob = bpy.context.object
    ob.name = "Doe eyes"
    ob.data.name = "Doe_Eye_Mesh"
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    for poly in ob.data.polygons:
        poly.use_smooth = True
    # Bake the transform so the eye vertices live in the same space as the
    # body's; `skin_detail` reads both and has no business converting between
    # them.
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return ob


def skin_detail(ob, body, rig, k=24):
    """Skin a separate detail mesh to the armature rather than bone-parenting
    it, with ONE weight set per left/right island.

    Used for both the eyes and the antlers, because both fail the same way.

    A bone parent is RIGID: the eyes follow `head` exactly and nothing else.
    The face around them does not — it is skinned, so an eye socket is a blend
    of `head`, `neck_02` and `jaw`. The two agree in the rest pose and diverge
    the instant those bones disagree, which is precisely what the graze does:
    `head` swings +72 degrees while `neck_02` goes -62 the other way. The
    sockets deform away and the eyes, following `head` alone, sail straight out
    of the animal's skull.

    Sampling the body's weights fixes the seating, but doing it PER VERTEX
    trades one defect for another: the socket's weights vary across the eye, so
    the lens deforms differentially. Measured on the graze, an 18 mm eyeball
    changed radius by 12.9 mm — squashed into a teardrop. An eye is small and
    rigid and has no business deforming at all.

    So every vertex of one eye gets the SAME weights, sampled once at that
    eye's centre. Under linear blending that makes the eye a single affine
    unit: it goes where the socket goes and keeps its shape on the way.
    """
    gname = {g.index: g.name for g in body.vertex_groups}
    kd = kdtree.KDTree(len(body.data.vertices))
    for i, v in enumerate(body.data.vertices):
        kd.insert(v.co, i)
    kd.balance()
    groups = {}
    for sgn in (1, -1):
        idx = [v.index for v in ob.data.vertices if v.co.x * sgn > 0.0]
        if not idx:
            continue
        centre = sum((ob.data.vertices[i].co for i in idx), Vector()) / len(idx)
        acc, wsum = {}, 0.0
        for _co, bi, dist in kd.find_n(centre, k):
            w = 1.0 / (dist + 1e-4)
            wsum += w
            for g in body.data.vertices[bi].groups:
                acc[gname[g.group]] = acc.get(gname[g.group], 0.0) + g.weight * w
        for name, val in acc.items():
            if name not in groups:
                groups[name] = ob.vertex_groups.new(name=name)
            groups[name].add(idx, val / wsum, "REPLACE")
    ob.parent = rig
    ob.matrix_parent_inverse = rig.matrix_world.inverted()
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = rig
    return ob


def doe_regions():
    """Skinning fields, written for THIS animal.

    Two things break a default field on a deer, and both are the same shape of
    bug: a candidate list that is too generous lets flesh follow a bone it has
    no business following.

    * The neck is half a metre long. One wide sigma over chest/neck/head drags
      the shoulder around every time the head turns.
    * The barrel is deep and NARROW over long legs, so a half-space test like
      "below the elbow and off the centreline" catches the lower flank and the
      brisket, and then the barrel visibly collapses onto the thigh at the
      extremes of a gait. Limb membership is therefore a distance to the limb's
      own polyline, and the band where a limb enters the body offers only the
      limb's TOP bone against the trunk's — never the shank or the foot.
    """
    def regions(co):
        x, y, z = co
        side = "L" if x > 0 else "R"
        sgn = 1 if x > 0 else -1
        # The ears first: they are the one part of the front end far enough
        # off the head's own axis that a distance test would miss them.
        if z > 1.212 and y > 0.470 and abs(x) > 0.030:
            return [f"ear.{side}", "head"], 0.068

        # Everything else forward of the withers is decided by distance to the
        # neck-and-head CHAIN, never by a bare `y >` gate.
        #
        # This is where "the chest is hollowed out" came from, and it was a
        # one-line bug that survived every other fix. The band read
        # `if y > 0.424: return ["neck_02", "neck_01", "head"]` with no height
        # limit whatsoever — and the brisket reaches forward to y = 0.50. So
        # the entire front of the chest, all the way down to z = 0.54, was
        # weighted 0.98 to `neck_01`: measured, 188 chest vertices driven by a
        # neck bone. Folding the neck to graze then dragged the chest with it
        # and the surface tore itself into flaps.
        #
        # A vertex 29 cm BELOW the root of the neck is not neck, however far
        # forward it happens to sit. Distance to the chain says so; `y` alone
        # cannot.
        dn = chain_distance(co, NECK_CHAIN)
        if dn < 0.190:
            if y > 0.648 and z < 1.148:
                return ["jaw", "head"], 0.105
            if y > 0.570:
                return ["head", "neck_02"], 0.115
            if y > 0.424:
                return ["neck_02", "neck_01", "chest"], 0.150
            return ["neck_01", "chest", "neck_02"], 0.200

        if chain_distance(co, TAIL_CHAIN) < 0.080 and y < -0.460:
            return ["tail_01", "tail_02", "pelvis"], 0.075

        df = chain_distance(co, [mirror(p, sgn) for p in FORE_CHAIN])
        dh = chain_distance(co, [mirror(p, sgn) for p in HIND_CHAIN])

        # Below the brisket there is nothing but leg, so the whole limb chain
        # is fair game and the sigma is tight enough to keep a hoof off a shank.
        if z < 0.470:
            if df < dh:
                return [f"fore_upper.{side}", f"fore_lower.{side}",
                        f"fore_foot.{side}"], 0.075
            return [f"hind_upper.{side}", f"hind_lower.{side}",
                    f"hind_foot.{side}"], 0.075

        # How far a limb's claim reaches INTO the body, and it tapers: 13 cm
        # down at the foot, 5 cm up at the hip.
        #
        # A flat radius is what tore the animal apart. The femur runs from the
        # hip to the stifle INSIDE the haunch, and the pelvis bone is a short
        # stub on the centreline — so plain distance-to-segment says the lower
        # flank is nearer the thigh than the spine, which it is, and the whole
        # barrel binds to a leg. Measured on the run before this taper: 2378 of
        # 4682 trunk vertices weighted 1.00 to a limb bone, with `spine_01 0.00,
        # pelvis 0.00`, and the belly tore off in every clip that swings a leg.
        # Distance alone cannot separate flank from thigh; height has to.
        t = max(0.0, min(1.0, (z - 0.200) / 0.600))
        r_limb = 0.130 * (1.0 - t) + 0.050 * t

        # Where the limb enters the body: the shoulder and the haunch. Only the
        # limb's TOP bone competes here, against the trunk's, and the sigma is
        # deliberately WIDE. The scoring is `exp(-(d/sigma)^2)`, which saturates
        # hard: at sigma 0.105 a vertex 8 cm from the femur and 29 cm from the
        # pelvis scores them 1300:1 and the trunk contributes nothing at all.
        # At 0.22 it is 1.5:1, so the seam stretches instead of tearing.
        if min(df, dh) < r_limb:
            if df < dh:
                return [f"fore_upper.{side}", f"scapula.{side}", "chest"], 0.220
            return [f"hind_upper.{side}", "pelvis", "spine_01"], 0.220
        if y > 0.180:
            return ["chest", f"scapula.{side}", "spine_01"], 0.220
        if y < -0.230:
            return ["pelvis", "spine_01"], 0.220
        return ["spine_01", "chest", "pelvis"], 0.240

    return regions

# ── the buck's rack ──────────────────────────────────────────────────────────
#
# Carried by the STAG variant only. The three antlerless coats drop it through
# `variants[].hide` in the species file, which is why it is a separate object
# with its own material rather than part of the body: one mesh, one skeleton
# and one set of clips still serve the whole cast.
#
# A typical 8-point white-tail. The main beam leaves the pedicle up and BACK,
# sweeps out around the ear and then forward over the muzzle, with unbranched
# tines rising vertically off the top of it. That forward-sweeping single beam
# is what separates a white-tail from a mule deer, whose beams fork, and it is
# the most recognisable shape in the whole cast.
#
# Thickened well past life. A real beam is 36 mm at the burr, which at the size
# a deer occupies on screen is a scratch.
BEAM = [
    (0.042, 0.628, 1.238),      # the pedicle, on the frontal bone
    (0.066, 0.586, 1.330),      # up and back, behind the ear
    (0.102, 0.606, 1.402),      # out, still rising
    (0.124, 0.678, 1.444),      # the sweep turns forward
    (0.120, 0.762, 1.450),      # forward over the muzzle
    (0.098, 0.828, 1.430),      # the beam tip, dropping away
]
BEAM_R = [0.028, 0.023, 0.019, 0.016, 0.013, 0.009]
# Each tine is (base, tip, radius at base, radius at tip). Three of them plus
# the beam tip makes four points a side: an 8-point rack.
TINES = [
    ((0.062, 0.596, 1.322), (0.058, 0.628, 1.462), 0.017, 0.007),   # brow tine
    ((0.122, 0.672, 1.440), (0.128, 0.686, 1.580), 0.016, 0.007),
    ((0.120, 0.758, 1.448), (0.124, 0.774, 1.556), 0.014, 0.006),
]


def build_antlers(mat):
    """The stag's rack as one fused object, skinned like the eyes.

    NOT bone-parented, even though antlers are rigid bone and a bone parent is
    the obvious choice. The pedicle sits on the frontal bone barely 3 cm
    forward of the poll, and the poll is exactly where `head` and `neck_02`
    meet — so the skull surface there is a ~50/50 blend of the two. A rack
    following `head` alone would part company with the skull it is growing out
    of the moment those two bones disagree, which is what the graze does by 134
    degrees. Sampling the skull's own weights keeps the rack welded to the
    pedicle whatever the neck does.
    """
    parts = []
    for side, sgn in (("L", 1), ("R", -1)):
        beam = [mirror(p, sgn) for p in BEAM]
        for i in range(len(beam) - 1):
            parts.append(K.tapered_between(f"Doe antler {side} beam{i}", beam[i],
                                           beam[i + 1], BEAM_R[i], BEAM_R[i + 1],
                                           BEAM_R[i], 10))
        for i in range(1, len(beam) - 1):
            r = BEAM_R[i] * 1.06
            parts.append(K.uv(f"Doe antler {side} joint{i}", beam[i], (r, r, r), 10, 7))
        parts.append(K.uv(f"Doe antler {side} burr", beam[0], (0.031, 0.031, 0.021), 12, 8))
        for j, (a, b, r0, r1) in enumerate(TINES):
            parts.append(K.tapered_between(f"Doe antler {side} tine{j}", mirror(a, sgn),
                                           mirror(b, sgn), r0, r1, r0, 9))
    # A finer voxel than the body's: the thinnest tine is 12 mm across, and the
    # body's 13 mm grid would eat it entirely.
    rack = K.fuse(parts, "Doe antlers", voxel=0.0055, smooth=(0.18, 2), decimate=None)
    rack.data.name = "Doe_Antler_Mesh"
    rack.data.validate(verbose=False)
    rack.data.materials.clear()
    rack.data.materials.append(mat)
    for poly in rack.data.polygons:
        poly.use_smooth = True
    K.decimate_planar(rack, angle_deg=20.0)
    return rack


# ── the clips ────────────────────────────────────────────────────────────────
#
# Eight, because eight is what `GlbRig` resolves: `stand`, three locomotion
# cycles, the three-phase graze and `alert`. Those slot names are a contract —
# `src/wildlife/glb_rig.js` looks each one up by the name the species file
# gives it and throws at load if one is missing — and the three graze phases
# exist because the Brain holds a graze for a variable number of seconds, so a
# single long clip would raise the head every time it repeated.
#
# The arithmetic that decides whether a gait works is not the obvious one. A
# planted hoof sweeps its WHOLE excursion during the stance alone, and the
# stance lasts `duty * T`. So the ground one cycle covers is `E / duty`, not
# `E`, and
#
#     speed = E / (duty * T) * rate
#
# `rate` is a playback speed and never an edit: every pose the doe strikes is a
# pose that is in this file. Cadence is the free variable; reach is not.
#
# `foot_pitch` is (touchdown, lift-off), and on an UNGULATE the sign is the
# opposite of a paw's. The foot bone runs DOWN the cannon, so rolling it by a
# positive angle about its local X swings the hoof FORWARD — the toe reaches
# out ahead at touchdown and trails at breakover, which is `(+p, -p)`. The
# kit's default `(-14, +16)` is for a paw, whose foot bone points forward.
#
# The roll is not free either, and it is worth having: it moves the hoof
# fore-aft relative to the ankle by `(sin p0 + sin p1) * foot_len` over a
# stance, which on a 0.25 m cannon is another 9-13 cm of real ground. The
# solver reports the ANKLE's travel; `measure_clip` below reads the TOE, which
# is what the game reads and what actually touches.

# A bound, phase-shifted by +0.875 of a cycle, and the shift is the whole
# reason the leap reads.
#
# `author_gait` raises the root on `sin(2*tau*u)`, which peaks at u = 0.125 and
# 0.625. Against the kit's `BOUND` (hinds down at 0.00) the first of those
# peaks lands in the MIDDLE of the hind stance — the body lifts while a hoof is
# still planted, which stretches the leg, spends its reach and clamps the
# stride. So a bound authored straight off `K.BOUND` has to keep `bob` near
# zero, and a bound with no bob is a deer skimming along on castors.
#
# Shifted so both stances sit on the body's LOW points, the same bob works the
# other way: the doe compresses onto the planted hinds, throws herself up, and
# sails with the feet tucked. Reach goes UP during stance rather than down,
# because the hip is closer to the ground, so the leap costs no ground at all.
BOUND_PHASE = {"hindL": 0.875, "hindR": 0.905, "foreL": 0.295, "foreR": 0.325}

GAITS = {
    # One lateral-sequence stride per 36 frames — 0.67 Hz as authored, which
    # 2.0x lifts to 1.33 Hz. A walking quadruped runs 1.0-1.8 Hz.
    "walk": dict(
        name="walk", rate=2.0,
        frames=36, phases=K.LATERAL_WALK, duty=0.63, stride=0.44,
        lift=0.052, foot_pitch=(10.0, -12.0), min_knee=14.0,
        body=dict(bob=0.013, pitch=1.4, roll=1.2, yaw=1.5, head=1.1,
                  tail=2.4, neck=1.0, shoulder=2.6)),
    # One diagonal-pair stride per 18 frames — 1.33 Hz, and 1.8x puts it at
    # 2.4 Hz, a real trotting cadence for a deer.
    "trot": dict(
        name="trot", rate=2.0,
        frames=18, phases=K.DIAGONAL_TROT, duty=0.50, stride=0.50,
        lift=0.095, foot_pitch=(13.0, -15.0), min_knee=13.0,
        body=dict(bob=0.030, pitch=2.3, roll=0.9, yaw=1.1, head=1.9,
                  tail=3.8, neck=1.7, shoulder=4.2)),
    # A BOUND, not a gallop, because that is what a frightened white-tail
    # actually does: both hinds drive together, the body sails, both fores
    # catch, and it goes again. It is the species' signature and the reason
    # people call them "jumping deer".
    #
    # It is also what fixes the run being short. Ground per cycle is `E / duty`
    # and `E` is capped by leg length — 0.53 m is all the foreleg has. The
    # denominator is the free variable, and a bound's stance is brief: at the
    # rotary gallop's duty 0.22 this clip carried 2.34 m per cycle and 7.5 m/s,
    # which is a deer jogging away. At 0.15 the same legs carry half again as
    # much ground for nothing.
    #
    # Duty 0.12 is what finally paid for the speed. Ground per cycle is
    # `E / duty`, and with `E` capped near 0.5 m by the leg the denominator is
    # the only lever: 0.22 gave 2.34 m per cycle, 0.15 gave 3.16, and 0.12
    # gives 3.97 — which is a real white-tail's bound, 4 m of ground in one
    # leap. A bounding deer really is barely in contact with the ground.
    #
    # So 2.35x on a 1.00 Hz clip is 2.35 bounds a second, and the engine
    # measures the leap at 5.08 m, which puts her at 11.9 m/s — 43 km/h, a real
    # fleeing white-tail. Reached by covering more ground per leap rather than
    # by winding the playback up. 24 frames rather than 20 because the footfall
    # offsets have to survive the sample grid: at 1/20 both hinds snapped to
    # the same frame and both fores to another, and a perfectly paired bound
    # reads as a pogo stick.
    #
    # `foot_pitch` is GENTLE here, and that is a measurement rather than a
    # taste. `measureGround` reads a clip's speed as the densest cluster of paw
    # velocities within 2% of the whole range, which works because a planted
    # hoof holds one velocity. A hard roll breaks that promise: at (18, -20)
    # over a stance this short the hoof's own velocity swept 5.4 to 6.3 u/s —
    # an 8% spread against a 2% band — so the stance shattered into sub-clusters
    # of 3% each, the long steady swing formed one cluster of 40% and won, and
    # the loader rejected the asset with "moved none of the feet backwards".
    # The roll is worth real ground, but not at the price of being unmeasurable.
    #
    # `lift` is capped at 0.18 m by the animal's own belly. The kit raises the
    # ANKLE, and on a hind leg the ankle is the hock, so a 0.36 m lift puts the
    # hock at 0.68 m — inside a barrel whose floor is 0.51 m, and the swinging
    # shank rendered straight through the flank. Lift costs nothing in speed
    # (it is the swing, not the stance) so there is no reason to push it.
    #
    # `bob` is 0.075 — a 15 cm rise and fall of the whole animal — and it is
    # only affordable because `BOUND_PHASE` above put the stances on the low
    # points. On the unshifted pattern the same number clamped a 0.53 m stride
    # to 0.436.
    "run": dict(
        name="run", rate=2.35,
        frames=24, phases=BOUND_PHASE, duty=0.12, stride=0.53,
        lift=0.18, foot_pitch=(7.0, -8.0), min_knee=12.0,
        body=dict(bob=0.075, pitch=6.0, roll=0.4, yaw=0.5, head=3.4,
                  tail=7.0, neck=3.4, shoulder=7.0)),
}

LIMB_BONES = [f"{a}_{b}.{s}" for s in ("L", "R")
              for a in ("fore", "hind") for b in ("upper", "lower", "foot")]
POSE_CHAIN = (["pelvis", "spine_01", "chest", "neck_01", "neck_02", "head",
               "jaw", "ear.L", "ear.R", "scapula.L", "scapula.R",
               "tail_01", "tail_02"] + LIMB_BONES)
TOES = [f"{a}_toe.{s}" for s in ("L", "R") for a in ("fore", "hind")]

# The head-down pose the three graze phases share, and the trunk is at REST in
# it. That is the third answer to this pose and the first one that holds.
#
# Piling all ~110 degrees onto `neck_01` (the first cut, 84 degrees on one
# bone) crumpled the neck into the shoulder. Dropping the forehand instead —
# `chest` -12, `spine_01` -3, scapulae countering — spread the load nicely and
# broke the animal a different way: the shoulder drops 67 mm, `plant_feet`
# folds the elbow 47 mm BACK to keep the hoof planted, and the armpit it folds
# into is about 40 mm of brisket. The surface has nowhere to go, so it crumples
# through itself and renders as a stack of flaps hanging out of the chest.
#
# A dropped forehand ALWAYS folds the foreleg — the hoof is already on the
# ground, so a shoulder that comes down has only the elbow to give. There is no
# offset that avoids it. So the trunk stays put and the bend is split near
# evenly between the two neck bones instead, which is what stops either of them
# crumpling. The muzzle finishes a few cm higher for it, which is the right
# thing to trade.
GRAZE_POSE = {
    "neck_01": (-70.0, 0.0, 0.0),
    "neck_02": (-62.0, 0.0, 0.0),
    "head": (72.0, 0.0, 0.0),
    "jaw": (5.0, 0.0, 0.0),
    "ear.L": (-16.0, 0.0, -10.0),
    "ear.R": (-16.0, 0.0, 10.0),
    "tail_01": (-4.0, 0.0, 0.0),
}

# Head up, neck raised, ears pricked forward, tail half-lifted. This is the
# whole sighting from the player's side: `animal_brain.js` drives `alert` to 1
# the moment the doe notices you, and `GlbRig` blends this pose over whatever
# else she is doing — so it has to read as tension at 60 m without moving.
ALERT_POSE = {
    "neck_01": (12.0, 0.0, 0.0),
    "neck_02": (9.0, 0.0, 0.0),
    "head": (-13.0, 0.0, 0.0),
    "ear.L": (6.0, 0.0, 14.0),
    "ear.R": (6.0, 0.0, -14.0),
    "tail_01": (17.0, 0.0, 0.0),
    "tail_02": (9.0, 0.0, 0.0),
}



def smooth_weights(body, factor=0.55, repeat=8):
    """Blur the skin weights across the whole mesh, and normalise after.

    `weight_body` assigns from a REGION FUNCTION, and a region function returns
    DISJOINT candidate sets: a vertex just inside the shoulder band is scored
    against `fore_upper`, and its neighbour a millimetre outside never sees
    that bone at all. So the weight field has a step in it exactly where two
    bands meet — and a weight field with a step in it does not stretch, it
    TEARS. That is what shredded the brisket in the graze and the belly in the
    run and the trot: not a bad assignment, a discontinuous one.

    No amount of retuning the band edges fixes this, because the discontinuity
    is not at any particular edge — it is inherent in choosing candidates by
    region. The fix belongs to the FIELD: smoothing makes neighbouring vertices
    hold neighbouring weights, so the seam behaves like skin.

    It also cannot be skipped by making the bands overlap. Distance-to-segment
    is a poor metric on a barrel: the trunk bones are thin sticks on the
    centreline while a femur or a humerus runs out INTO the flesh, so a belly
    vertex is always nearer a leg bone than a spine bone however the candidate
    list is written.
    """
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.select_all(action="DESELECT")
    body.select_set(True)
    # A paint mask would silently limit the smooth to the selected faces.
    body.data.use_paint_mask = False
    body.data.use_paint_mask_vertex = False
    for g in body.vertex_groups:
        g.lock_weight = False
    bpy.ops.object.mode_set(mode="WEIGHT_PAINT")
    bpy.ops.object.vertex_group_smooth(group_select_mode="ALL", factor=factor,
                                       repeat=repeat, expand=0.0)
    # Smoothing does not preserve the partition of unity; without this the
    # animal quietly shrinks wherever the weights now sum to less than one.
    bpy.ops.object.vertex_group_normalize_all(group_select_mode="ALL",
                                              lock_active=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def plant_feet(rig):
    """Re-solve all four legs so the hooves stay where they rest.

    A pose clip has no gait solver, so any rotation of `chest` or `spine_01`
    drags the legs with it: the whole foreleg hangs off the chest through
    `scapula`, so dropping the forehand 20 degrees to graze swings both front
    hooves about 7 cm through the floor.

    This is the same two-link solve `author_gait` runs every frame of every
    gait, aimed at the leg's own REST ankle instead of at a moving foot path.
    Having it is what lets a pose clip move the trunk at all.
    """
    for kind in ("fore", "hind"):
        for side in ("L", "R"):
            up = rig.pose.bones[f"{kind}_upper.{side}"]
            lo = rig.pose.bones[f"{kind}_lower.{side}"]
            ft = rig.pose.bones[f"{kind}_foot.{side}"]
            h0, k0 = up.bone.head_local, lo.bone.head_local
            a0, t0 = ft.bone.head_local, ft.bone.tail_local
            l1, l2 = (k0 - h0).length, (a0 - k0).length
            u = (a0 - h0).normalized()
            bend = (k0 - h0) - u * (k0 - h0).dot(u)
            if bend.length < 1e-5:
                bend = Vector((0, -1, 0))
            hip = up.head.copy()        # where the hip IS, after the trunk moved
            knee = K._ik2(hip, a0, l1, l2, bend)
            K._point_bone(up, knee - hip)
            K._point_bone(lo, a0 - lo.head)
            K._point_bone(ft, t0 - a0)


def lerp_pose(a, b, t):
    """Blend two pose dicts, treating a bone missing from either as rest."""
    out = {}
    for k in set(a) | set(b):
        va, vb = a.get(k, (0.0, 0.0, 0.0)), b.get(k, (0.0, 0.0, 0.0))
        out[k] = tuple(va[i] + (vb[i] - va[i]) * t for i in range(3))
    return out


def pose_clip(rig, name, start, end, keys, description=""):
    """A pose clip, keyed frame by frame with the feet re-planted at each one.

    `keys` is [(frame, pose_dict), ...] where a bone the dict omits is at rest.

    EVERY bone of the chain is keyed at every frame, and that is not tidiness.
    `GlbRig` blends these poses over the locomotion cycles by weight, and a
    bone with no track in `alert` keeps whatever the clip underneath left it
    holding — so a pose that looks right on its own comes apart the moment it
    is blended, and nothing throws. The fox lost three clips to exactly that.
    """
    act = K.new_action(rig, name, start, end, description)
    scene = bpy.context.scene
    for frame, pose in keys:
        scene.frame_set(int(frame))
        for bone in POSE_CHAIN:
            K.set_rot(rig.pose.bones[bone], pose.get(bone, (0.0, 0.0, 0.0)))
        rig.pose.bones["root"].location = (0.0, 0.0, 0.0)
        bpy.context.view_layer.update()
        plant_feet(rig)
        for bone in POSE_CHAIN:
            K.key_rot(rig.pose.bones[bone], frame)
        rig.pose.bones["root"].keyframe_insert("location", frame=frame,
                                               group="root")
    scene.frame_set(int(start))
    return act


def build_stand(rig):
    """The idle: standing at ease, breathing, with a slow tail and an ear.

    Four seconds. Long enough that three does on screen do not read as one
    animal copied, short enough to stay cheap. The breath lives in the chest
    and the neck rather than in the root, because an idle that bobs the whole
    animal reads as a float rather than as breathing.
    """
    breathe = {"chest": (1.0, 0, 0), "neck_01": (-1.2, 0, 0)}
    act = pose_clip(
        rig, "idle", 0, 96, description="standing at ease, breathing",
        keys=[
            (0, {}),
            (16, {**breathe, "head": (0.8, 0, -1.2),
                  "tail_01": (0, 0, 2.0), "tail_02": (0, 0, 3.0)}),
            (32, {"ear.L": (-9, 0, 6),
                  "tail_01": (0, 0, 3.5), "tail_02": (0, 0, 5.0)}),
            (48, {}),
            (64, {**breathe, "head": (0.8, 0, 1.2), "ear.R": (-9, 0, -6),
                  "tail_01": (0, 0, -3.5), "tail_02": (0, 0, -5.0)}),
            (80, {"tail_01": (0, 0, -2.0), "tail_02": (0, 0, -3.0)}),
            (96, {}),
        ])
    K.close_action(rig, act, 0, 96)
    K.cyclic_handles(act, 96)
    return act


def build_alert(rig):
    """Head up, ears forward, body locked. A held pose that barely moves.

    The only motion is a two-degree scan of the head and a twitch of the ears,
    because a frozen deer is not a still image — it tracks you — and because a
    perfectly static clip blended over a walk makes the head the one rigid part
    of a moving animal, which reads as a bug rather than as tension.
    """
    h = ALERT_POSE["head"]

    def scan(z, ear):
        return {**ALERT_POSE, "head": (h[0], 0.0, z),
                "ear.L": (8.0, 0.0, ear), "ear.R": (8.0, 0.0, -ear)}

    act = pose_clip(
        rig, "alert", 0, 72, description="frozen, head up, ears forward",
        keys=[(0, ALERT_POSE), (24, scan(-2.2, 16.0)), (48, scan(2.2, 16.0)),
              (72, ALERT_POSE)])
    K.close_action(rig, act, 0, 72)
    K.cyclic_handles(act, 72)
    return act


def build_graze(rig):
    """The three phases, authored so they meet exactly.

    `graze_in`'s last frame IS `graze`'s first, and `graze_out` opens on that
    same pose and closes on the exact idle rest. `GlbRig._grazeAdvance`
    sequences them off nothing but that promise, which is why
    `check_graze_seams` asserts it rather than trusting it.

    Only `graze` loops. The other two are LoopOnce and clamped in the engine,
    which is why they are kept out of `validate`'s closing check: a clip meant
    to end somewhere other than it started would fail it, correctly.
    """
    def g(**over):
        p = dict(GRAZE_POSE)
        p.update(over)
        return p

    chew = g(jaw=(11.0, 0.0, 0.0))
    down = pose_clip(
        rig, "graze_in", 0, 26, description="head down into the grass",
        keys=[(0, {}), (10, lerp_pose({}, GRAZE_POSE, 0.30)), (26, GRAZE_POSE)])

    hold = pose_clip(
        rig, "graze", 0, 84, description="feeding, muzzle in the sward",
        keys=[
            (0, GRAZE_POSE),
            (7, chew), (14, GRAZE_POSE), (21, chew),
            # A slow sweep across the grass. The yaw is what stops a long graze
            # reading as a freeze-frame; the Brain holds one for seconds.
            (30, g(head=(69.0, 0.0, 7.0), neck_02=(-64.5, 0.0, 4.0))),
            (56, g(head=(74.0, 0.0, -6.0), neck_02=(-60.5, 0.0, -3.5))),
            (63, g(head=(74.0, 0.0, -6.0), neck_02=(-60.5, 0.0, -3.5),
                   jaw=(11.0, 0.0, 0.0))),
            (70, g(head=(73.0, 0.0, -3.0), neck_02=(-61.0, 0.0, -1.5))),
            (84, GRAZE_POSE),
        ])
    K.close_action(rig, hold, 0, 84)
    K.cyclic_handles(hold, 84)

    up = pose_clip(
        rig, "graze_out", 0, 22, description="head back up to the idle rest",
        keys=[(0, GRAZE_POSE), (9, lerp_pose(GRAZE_POSE, {}, 0.45)), (22, {})])

    # What the pose actually achieves, which is the only number that says
    # whether she is grazing or gesturing at the ground.
    rig.animation_data.action = hold
    bpy.context.scene.frame_set(0)
    bpy.context.view_layer.update()
    nose = rig.matrix_world @ rig.pose.bones["head"].tail
    print(f"DOE_GRAZE muzzle at y={nose.y:.3f} z={nose.z:.3f} "
          f"(rest z=1.072); largest single bone rotation "
          f"{max(abs(v[0]) for v in GRAZE_POSE.values()):.0f} deg")
    return down, hold, up


def build_locomotion(rig, keyer, name, cfg):
    """One solved cycle, plus the seam fix its loop needs."""
    act = K.new_action(rig, cfg["name"], 0, cfg["frames"],
                       f"{name}, solved against the ground")
    out = K.author_gait(
        rig, keyer,
        frames=cfg["frames"], phases=cfg["phases"], duty=cfg["duty"],
        stride=cfg["stride"], lift=cfg["lift"], body=cfg["body"],
        foot_pitch=cfg["foot_pitch"], min_knee=cfg["min_knee"])
    K.close_action(rig, act, 0, cfg["frames"])
    K.unwrap_quaternions(act)
    # Seam only. Blender's auto handles cannot see across a loop, so it
    # flattens the first and last key of every channel and the whole rig
    # decelerates at the seam at once — a hitch every cycle with no
    # discontinuity anywhere to point at. `cyclic_handles` fixes that too but
    # rewrites mid-cycle velocity as well, which is motion the solver already
    # got right.
    K.seam_handles(act, cfg["frames"])
    out["name"] = cfg["name"]
    out["frames"] = cfg["frames"]
    out["rate"] = cfg["rate"]
    return act, out


# ── measurement ──────────────────────────────────────────────────────────────

PLANTED = 0.12          # glb_rig.PLANTED: within 12% of a foot's lift range


def measure_clip(rig, act, n=96):
    """Ground per cycle, read the way the game reads it.

    Samples the TOE bones, not the ankles the solver reports. The two differ by
    the foot roll, which moves the hoof fore-aft relative to the ankle through
    the stance — real ground the animal covers, and `measureGround` in
    `glb_rig.js` sees it because it samples `glb.feet`, which are these bones.

    A foot counts as planted when it is within 12% of its own lift range of its
    lowest point, which is the engine's own test. Ground per cycle is then the
    planted excursion divided by the measured duty, because a planted hoof
    sweeps its whole excursion during the stance alone.
    """
    scene = bpy.context.scene
    rig.animation_data.action = act
    s, e = act.frame_start, act.frame_end
    tracks = {b: [] for b in TOES}
    for i in range(n):
        scene.frame_set(int(round(s + (e - s) * i / n)))
        bpy.context.view_layer.update()
        for b in TOES:
            pb = rig.pose.bones[b]
            tracks[b].append(rig.matrix_world @ pb.head)
    per_foot, grounds, duties = {}, [], []
    for b, pts in tracks.items():
        zs = [p.z for p in pts]
        lo = min(zs)
        rng = max(max(zs) - lo, 1e-9)
        down = [p for p, z in zip(pts, zs) if z - lo < rng * PLANTED]
        duty = len(down) / len(pts)
        exc = (max(p.y for p in down) - min(p.y for p in down)) if down else 0.0
        per_foot[b] = dict(excursion=exc, duty=duty)
        grounds.append(exc / max(duty, 1e-6))
        duties.append(duty)
    grounds.sort()
    duties.sort()
    mid = len(grounds) >> 1
    return per_foot, dict(ground=grounds[mid], duty=duties[mid])


def check_graze_seams(rig, phases, tol=1e-3):
    """`graze_in` must END where `graze` BEGINS, and `graze_out` must end at rest.

    `GlbRig` sequences the three phases on nothing but this promise, and a
    mismatch shows up in the game as a head that jumps at the handover — which
    looks like a blending bug and is not one.
    """
    down, hold, up = phases

    def pose_at(act, frame):
        rig.animation_data.action = act
        return {fc.data_path + str(fc.array_index): fc.evaluate(frame)
                for fc in K.fcurves_of(act)}

    for label, a, fa, b, fb in (
        ("graze_in end -> graze start", down, down.frame_end, hold, hold.frame_start),
        ("graze end -> graze_out start", hold, hold.frame_end, up, up.frame_start),
    ):
        pa, pb_ = pose_at(a, fa), pose_at(b, fb)
        worst = max((abs(pa[k] - pb_.get(k, 0.0)) for k in pa), default=0.0)
        assert worst < tol, f"{label}: channels differ by {worst:.5f}"
    rest = pose_at(up, up.frame_end)
    worst = max((abs(v) for k, v in rest.items()
                 if "quaternion" not in k or not k.endswith("0")), default=0.0)
    assert worst < tol, f"graze_out does not end on the idle rest: {worst:.5f}"
    print("DOE_GRAZE_SEAMS ok — in->hold, hold->out, out->rest all within "
          f"{tol}")


# ── the studio ───────────────────────────────────────────────────────────────

# Front / rear / profile are the sheet the brief asks for. The three-quarter
# is here because it is the angle that actually finds defects: a flank that is
# three lumps and a neck that crests over the withers are both invisible dead
# side-on and obvious at 42 degrees.
VIEWS = (("front", 0.0, 760), ("rear", 180.0, 760),
         ("profile", 90.0, 1150), ("three_quarter", 42.0, 1000))
CAM_DIST, CAM_LENS, CAM_Z = 5.5, 70.0, 0.95
TARGET = (0.0, 0.05, 0.80)


def studio(prefix):
    """A white infinity box: warm backlight, a shadowed front, no horizon.

    Two decisions carry this and both were forced by the brief.

    **The background is composited, not lit.** "Pure, seamless white" and
    "the front falls into soft, heavy shadows" cannot both come from one world:
    a white world bright enough to render as pure white also floods the animal
    from every direction and every shadow the brief asks for goes flat. So the
    film is transparent, the world is a dim WARM ambient that exists only to
    shape the form, and the compositor lays the result over pure white. The
    view transform is Standard for the same reason — under AgX a 1.0 white
    renders about 0.86 and the "seamless" background quietly becomes grey.

    **The lights are parented to a pivot, and the pivot is what turns.** The
    camera and the whole three-light rig rotate together, so the rim lands in
    the same place relative to the lens in all three views. Bolt the lights to
    the world instead and the front view is backlit while the rear view is
    frontlit, and the sheet reads as three different animals.
    """
    pivot = bpy.data.objects.new(f"{prefix} studio pivot", None)
    pivot.location = (0.0, TARGET[1], 0.0)
    bpy.context.collection.objects.link(pivot)

    cd = bpy.data.cameras.new(f"{prefix} studio camera")
    cam = bpy.data.objects.new(f"{prefix} studio camera", cd)
    bpy.context.collection.objects.link(cam)
    cam.location = (0.0, TARGET[1] + CAM_DIST, CAM_Z)
    cd.lens = CAM_LENS
    # Fit the frame to the SHORT axis so the animal is the same height in a
    # 760-wide front view and an 1150-wide profile; only the margin changes.
    cd.sensor_fit = "VERTICAL"
    cd.sensor_height = 24.0
    K.aim(cam, TARGET)

    lights = [
        # The two warm backlights. These are the brief's "high-contrast warm
        # ambient backlighting": strong, behind the subject, wide enough that
        # the rim is a soft band down the silhouette rather than a hot wire.
        (f"{prefix} rim warm", (1.35, -3.30, 2.35), 900, 3.2, (1.0, 0.62, 0.33)),
        (f"{prefix} rim fill", (-1.55, -2.95, 1.55), 520, 3.0, (1.0, 0.70, 0.44)),
        # A weak front fill. Without it the caramel goes to black and the
        # "soft, heavy shadows" become no shadows at all, just an absence.
        (f"{prefix} front fill", (0.75, 2.95, 1.85), 130, 4.0, (1.0, 0.94, 0.88)),
    ]
    for name, loc, energy, size, colour in lights:
        lamp = K.add_area(name, loc, energy, size, colour, TARGET)
        lamp.parent = pivot
        lamp.matrix_parent_inverse = pivot.matrix_world.inverted()
    cam.parent = pivot
    cam.matrix_parent_inverse = pivot.matrix_world.inverted()

    sc = bpy.context.scene
    sc.camera = cam
    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            sc.render.engine = engine
            break
        except TypeError:
            continue
    sc.render.resolution_y = 940
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    sc.render.filter_size = 1.6
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"

    # The deep ambient occlusion the brief asks for. EEVEE moved this from
    # `use_gtao` to the raytracing stack somewhere in the 4.x line, so set
    # whichever this build actually has rather than guessing.
    ee = sc.eevee
    for attr, value in (("use_raytracing", True), ("use_gtao", True),
                        ("gtao_distance", 0.45), ("use_shadows", True),
                        ("taa_render_samples", 128)):
        if hasattr(ee, attr):
            try:
                setattr(ee, attr, value)
            except (AttributeError, TypeError):
                pass

    # A dim WARM environment. It is doing the job an overhead bounce would do
    # in a real studio: keeping the shadow side readable and warm.
    world = bpy.data.worlds.new(f"{prefix} studio world")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (1.0, 0.86, 0.72, 1.0)
    bg.inputs["Strength"].default_value = 0.42
    sc.world = world

    sc.view_settings.view_transform = "Standard"
    try:
        sc.view_settings.look = "None"
    except TypeError:
        pass

    # Composite the transparent render over pure white.
    #
    # Blender 5 moved the scene compositor out of an embedded `scene.node_tree`
    # and into a real node-group datablock on `scene.compositing_node_group`,
    # and dropped `CompositorNodeComposite` for a plain group output. Both of
    # those raise rather than warn, so this is written against the new API.
    ng = bpy.data.node_groups.new(f"{prefix} studio composite", "CompositorNodeTree")
    ng.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    rl = ng.nodes.new("CompositorNodeRLayers")
    rl.scene = sc
    white = ng.nodes.new("CompositorNodeRGB")
    white.outputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
    over = ng.nodes.new("CompositorNodeAlphaOver")
    out = ng.nodes.new("NodeGroupOutput")
    ng.links.new(white.outputs["Color"], over.inputs["Background"])
    ng.links.new(rl.outputs["Image"], over.inputs["Foreground"])
    ng.links.new(over.outputs["Image"], out.inputs[0])
    sc.compositing_node_group = ng
    sc.render.use_compositing = True
    return pivot, cam


def render_views(pivot):
    """One PNG per view, framed the way the brief's reference sheet is."""
    sc = bpy.context.scene
    SHOT_DIR.mkdir(parents=True, exist_ok=True)
    made = []
    for name, azimuth, width in VIEWS:
        pivot.rotation_euler = (0.0, 0.0, math.radians(azimuth))
        bpy.context.view_layer.update()
        sc.render.resolution_x = width
        path = SHOT_DIR / f"new_deer_{name}.png"
        sc.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        made.append(path)
        print("DOE_VIEW", name, path)
    pivot.rotation_euler = (0.0, 0.0, math.radians(VIEWS[-1][1]))
    return made



def write_readme(rig, actions):
    """Leave the clip list inside the file, where a person will find it.

    Every action carries its own manual frame range — the exporter reads it —
    but Blender does not sync the SCENE range to the action you pick, so
    opening the file and pressing Play shows one clip's worth of frames and
    then whatever silence follows. The table goes here, in the Text Editor,
    rather than only in a build log nobody has open.
    """
    txt = bpy.data.texts.new("README - clips")
    rows = [f"  {a.name:10s} {int(a.frame_start):>3d}-{int(a.frame_end):<3d}"
            f"  {a.get('description', '')}" for a in actions]
    txt.write("\n".join([
        "new_deer.blend - white-tailed doe (Odocoileus virginianus), 8 clips.",
        "",
        "THIS FILE IS AN OUTPUT. It is rebuilt from scratch by",
        "    blender --factory-startup -b --python tools/build_new_deer.py",
        "which clears the scene first, so any edit made here is destroyed by",
        "the next build. Change tools/build_new_deer.py instead.",
        "",
        "To watch a clip:",
        "  1. Switch to the Animation workspace (or any Dope Sheet in",
        "     Action Editor mode).",
        "  2. Pick the action from the browse dropdown at the top.",
        "  3. Set the scene End frame from the table below.",
        "  4. Space to play. The camera is on the broadside, which is the only",
        "     angle a gait can honestly be judged from.",
        "",
        "clip        frames   what it is",
        *rows,
        "",
        "graze_in / graze / graze_out are a sequence, not loops: in ends on",
        "graze's first pose and out ends on the exact idle rest. The other six",
        "close on their own first frame and loop.",
    ]))
    return txt


# ── build ────────────────────────────────────────────────────────────────────

def main():
    K.clear_scene()
    coat = K.material("Doe coat", COAT, ROUGH)
    white = K.material("Doe white", WHITE, ROUGH)
    dark = K.material("Doe dark", DARK, ROUGH)
    # The eye sits at the bottom of the brief's roughness band so the one
    # highlight on the one feature anyone looks at actually forms.
    eye = K.material("Doe eye", DARK, 0.30)
    horn = K.material("Doe horn", HORN, 0.42)

    body = build_body((coat, white, dark))
    rig = K.build_rig(body, "Doe", RIG_SPEC)
    K.weight_body(body, rig, doe_regions(), sigma_default=0.20, top=3)
    smooth_weights(body)

    eyes = build_eyes(eye)
    skin_detail(eyes, body, rig)
    rack = build_antlers(horn)
    skin_detail(rack, body, rig)

    # How much of each leg's reach the standing pose has already spent. This is
    # invisible in every render and it is the first number to check: a leg at
    # 0.97 has three percent left to spend on a stride, and every clip authored
    # against it will clamp with the knee dead straight.
    ext = K.rest_extension(rig)
    print("DOE_REST_EXTENSION "
          + " ".join(f"{k}={v['extension']:.3f}/knee{v['knee']:.0f}"
                     for k, v in ext.items() if isinstance(v, dict))
          + f" worst={ext['extension']:.3f} (want 0.82-0.88)")

    # ── the clips ───────────────────────────────────────────────────────────
    keyer = K.Keyer(rig)
    loops = [build_stand(rig)]
    diags = []
    for name, cfg in GAITS.items():
        act, d = build_locomotion(rig, keyer, name, cfg)
        loops.append(act)
        diags.append(d)
    graze_in, graze_hold, graze_out = build_graze(rig)
    loops.append(graze_hold)
    loops.append(build_alert(rig))
    every = loops + [graze_in, graze_out]

    check_graze_seams(rig, (graze_in, graze_hold, graze_out))

    # What the clips ACTUALLY carry, measured off the toes the way the game
    # measures them — not what was asked for. A foot whose travel falls short
    # of `stride` hit the leg's reach limit and the IK clamped.
    print()
    for d in diags:
        act = bpy.data.actions[d["name"]]
        per_foot, m = measure_clip(rig, act)
        period = d["frames"] / K.FPS
        speed = m["ground"] / period * d["rate"]
        print(f"DOE_CLIP {d['name']:5s} {d['frames']:3d}f {period:.3f}s "
              f"{1 / period:.2f}Hz x{d['rate']:.2f} -> {d['rate'] / period:.2f}Hz | "
              f"ankle E={d['travel']:.3f} toe E={m['ground'] * m['duty']:.3f} "
              f"| duty asked {d['duty']:.2f} measured "
              f"{m['duty']:.2f} | ground/cycle {m['ground']:.3f} m "
              f"-> {speed:.2f} m/s"
              + ("  CLAMPED" if d.get("clamped") else ""))
        print("          " + "  ".join(
            f"{b.replace('_toe.', '')}: E{v['excursion']:.3f} duty{v['duty']:.2f}"
            for b, v in per_foot.items()))

    under = K.check_grounded(body, rig, every)
    bad = {k: v for k, v in under.items() if v < -0.02}
    assert not bad, f"clips go through the floor: {bad}"

    # The pose has to be put back EXPLICITLY. Leaving it to chance is how a
    # file gets saved holding a stale evaluated frame, and every measurement
    # taken off it is then taken from a pose nobody chose.
    K.rest_pose(rig)
    # Only the LOOPING clips go through the closing check. `graze_in` and
    # `graze_out` are supposed to end somewhere other than they started, and
    # `check_graze_seams` above is what verifies them instead.
    K.validate(body, rig, loops, min_height=1.30, grounded=False)

    pivot, _ = studio("Doe")

    pts = [body.matrix_world @ v.co for v in body.data.vertices]
    zs = [p.z for p in pts]
    ys = [p.y for p in pts]
    xs = [p.x for p in pts]
    # The withers is the top of the shoulder, so measure it there rather than
    # trusting the constant the volumes were aimed at.
    # The window stops at y = 0.24 on purpose: past that the neck's own crest
    # rises into frame and the "withers" reads 0.96, which is the neck, not the
    # shoulder.
    withers = max(p.z for p in pts if 0.12 < p.y < 0.24 and abs(p.x) < 0.06)
    parts = (body, eyes, rack)
    tris = sum(len(p.vertices) - 2 for o in parts for p in o.data.polygons)
    slots = {m.name for o in parts for m in o.data.materials}
    # `glb.height` scales the model by its WHOLE bounding box, and the stag's
    # rack is now the tallest thing on it — so the number the species file
    # needs is the box INCLUDING antlers, not the ear tip. Printed rather than
    # derived by hand, because getting it wrong shrinks every doe in the valley
    # by the height of a rack she is not wearing.
    tops = {o.name: max((o.matrix_world @ v.co).z for v in o.data.vertices)
            for o in parts}
    full = max(tops.values())
    print(f"DOE_SIZE withers={withers:.3f} (aimed {WITHERS:.3f}) ear_tip={max(zs):.3f} "
          f"nose_to_rump={max(ys) - min(ys):.3f} width={max(xs) - min(xs):.3f}")
    print(f"DOE_HEIGHT full={full:.3f} (glb.height) "
          + " ".join(f"{k.replace('Doe ', '')}={v:.3f}" for k, v in sorted(tops.items())))
    print(f"DOE_COST tris={tris} body={len(body.data.polygons)}f "
          f"eyes={len(eyes.data.polygons)}f antlers={len(rack.data.polygons)}f "
          f"bones={len(rig.data.bones)} "
          f"materials={sorted(slots)} "
          f"actions={[a.name for a in bpy.data.actions]}")

    render_views(pivot)

    # Leave the file ready to WATCH, not just ready to export. `rest_pose`
    # above unlinks the action so the saved pose is the rest pose — correct for
    # the renders and the measurements, and useless to a person who opens the
    # file and presses Play. So hand it back an action, a matching scene range
    # and a broadside camera.
    pivot.rotation_euler = (0.0, 0.0, math.radians(90.0))
    idle = bpy.data.actions["idle"]
    if not rig.animation_data:
        rig.animation_data_create()
    rig.animation_data.action = idle
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = int(idle.frame_start), int(idle.frame_end)
    sc.frame_set(int(idle.frame_start))
    order = ["idle", "walk", "trot", "run", "graze_in", "graze", "graze_out",
             "alert"]
    write_readme(rig, [bpy.data.actions[n] for n in order])

    K.save_blend(BLEND_PATH)
    K.export_glb("Doe_Rig", GLB_PATH)
    print("DOE_COMPLETE", BLEND_PATH, GLB_PATH)


if __name__ == "__main__":
    main()
