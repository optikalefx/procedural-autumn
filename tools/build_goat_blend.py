"""Build the game's goat .blend from the bought pack, and save it.

    Blender -b assets/models/Animals_v3.0.blend --python tools/build_goat_blend.py

Writes `assets/models/goat_pack.blend`. Fourth mammal on this path; the shape of
it is `build_deer_blend.py` / `build_bear_blend.py` and the machinery is
`pack_rig_kit.py`. Read the `add-new-animation-to-glb` skill before changing
anything here.

## Two meshes, one skeleton, and the variant is a TEXTURE

`Goat_01` and `Goat_02` are both already parented to `Skeleton_Goat`, so there
is none of the re-parenting the deer needed. What is unusual is *how* they
differ. Measured index-wise in their own local space, the two meshes' 828
vertices are **identical to 0.000000** — same silhouette, same weights, same 39
vertex groups. Only the UVs differ: `Goat_01` reads 38 distinct UVs off the
palette (a flat white goat) and `Goat_02` reads 328 (a brown one). So this pair
buys a genuine second COAT, not a second silhouette, which is the opposite of
what the deer's buck and doe buy — and worth stating, because `hide` looks the
same in the species file either way.

`Goat_02` also ships **offset 0.621 in x** relative to the rig. `open_animal`
re-origins the ARMATURE and any parentless mesh but not a child mesh, so the
offset is zeroed here — a placement transform on an object, which is squarely
inside what CLAUDE.md allows — and asserted afterwards by comparing the two
meshes' evaluated vertices under a clip.

The pair are both nannies: each carries an udder and a set of short backswept
horns. `billy` in the species file is therefore a LARGER NANNY and not a
different mesh, which the pack simply does not have.

## What is kept, and what is authored over the top

    Goat_Idle     150f -> idle    kept. Every hoof dead still (duty 1.00).
    Goat_Gesture  150f -> graze   kept, and it is a real graze: the muzzle drops
                                  0.640 -> 0.093 with all four hooves planted.
                                  Measured before it was assigned a slot — this
                                  pack's Gesture is a graze on the deer, a
                                  forage on the raccoon and a REAR on the bear.
    Goat_Walk      30f -> walk    kept. Duty 0.50/0.37/0.40/0.43 — marginal
                                  against the 0.5 that defines a walk, and much
                                  better than the deer's 0.25/0.30/0.23/0.10
                                  which ships. See the note in mammals/goat.js.
    Goat_Run       18f -> run     kept, and it is the LEAP. Duty
                                  0.06/0.11/0.28/0.44 is an animal in the air,
                                  which is what a bound is; the same reading
                                  saw the deer's leap dropped and rebuilt worse.

    trot                          SOLVED here. Nothing in the pack has one —
                                  checked across all 233 actions.
    alert                         AUTHORED here. There is one Gesture per animal
                                  and it is the graze, so the alert has nowhere
                                  else to come from.

## The rig, surveyed rather than assumed

35 bones. `front_shoulder.L/R` parent to `spine.005`, so the alert's neck chain
must start at `spine.006` or the forelegs swing with the head — the same result
the deer gave and the opposite of the raccoon's. `shoulder.L/R` and `spine.002`
are siblings under `spine.003`, so the tail cannot disturb a hind leg.

Rest extension: hind 0.815, fore 0.874. Both inside the 0.82-0.88 band this work
aims for, which is why the trot solves to a real stride with no heroics — the
bear's 0.97 is what made its stride nearly impossible.
"""

import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pack_rig_kit import (                                        # noqa: E402
    open_animal, face_forward, point, clear, rx, rz, ease, key,
    new_action, sample, seam, set_linear, purge, frame_view, gait_rest,
    build_gait, DIAGONAL_TROT,
)

RIG = "Skeleton_Goat"
WHITE, BROWN = "Goat_01", "Goat_02"
MESHES = [WHITE, BROWN]
HEAD = "scull"

# The reshape's numbers, in mesh units against a withers height H of 0.7216.
# Tuned to a measured `Oreamnos americanus` profile; `reshape_mountain_goat`
# explains each op and the research notes are in the commit message.
#
# The governing constraint is not anatomy, it is the PIXEL BUDGET. This animal
# is read at 20-90 m through a 52-degree camera, which at 1080p is 55 px of
# withers height at 20 m and 12 px at 90 m. A live mountain goat's hump stands
# about 0.07 H proud of its hip line — a fifth of a pixel at 90 m. So every cue
# here is deliberately pushed past life size, to about double, because a cue
# that does not survive being twelve pixels tall did not happen.
UDDER = dict(tuck=0.026, narrow=0.25)
# Asymmetric on purpose: a long ramp up from the rump, a short fall into the
# neck. A symmetric Gaussian reads as a camel's lump rather than a shoulder.
HUMP = dict(rise=0.125, at=-0.25, sigma_fore=0.13, sigma_aft=0.26)
BARREL = dict(drop=0.045, at=-0.25, sigma=0.30)
# The dairy wedge widens REARWARD (bred for udder capacity); Oreamnos widens
# FORWARD (it hauls itself up rock on its shoulders). Hence a negative hind
# term: the flank behind the last rib is narrowed, not merely left alone.
WIDTH = dict(fore=0.22, fore_at=-0.24, hind=-0.090, hind_at=0.20, sigma=0.22)
NECK_MASS = dict(at=-0.52, sigma=0.14, thicken=0.22, drop=0.042)
# A crest of erect hair up to 20 cm runs the spine, shoulders and rump. On a
# palette-flat model hair is not shading, it is mesh, so it is carried here.
# `rump_at` was 0.30, which put the wool directly over the hind-leg column: it
# lifted the HIP by 0.025 H, which both steepened the croup and ate a quarter of
# the hump's differential against it. Moved back onto the croup proper.
CREST = dict(spine=0.026, at=-0.10, sigma=0.34, rump=0.034, rump_at=0.44,
             rump_sigma=0.13)
# Legs are thickened ABOUT THEIR OWN AXIS, not by scaling x from the origin —
# that splays the stance instead of fattening the limb, which is what the first
# pass did. Fat at the top and tapering is a limb; uniform is a sausage.
LEG_FAT = dict(top=0.30, low=0.12, z_lo=0.12, z_hi=0.52)
# "Pantaloons": the long hair on the thigh that makes the hind leg read as a
# skirted column rather than a stick. At 20-50 m this is worth as much as the
# hump, and it sits at the bottom of the frame where the ground line gives the
# eye something to measure against.
PANTS = dict(add=0.055, z_lo=0.24, z_hi=0.58)
# The horns are the highest-value-per-vertex change on the model: a dark spike
# above the head is unambiguous at every range and nothing else in the valley
# silhouette has one. A dairy horn sweeps back immediately and adds nothing
# above the head outline; Oreamnos rises near-vertical off the poll and curls
# only in the top third, with the bases close together.
# Measured before touching it, which changed the plan: the pack's horn already
# rises near-vertical (base centre y -0.739, tip -0.712 — a 10 degree backward
# lean over its whole length) and its base is 0.049 wide, i.e. 0.068 H against
# the 0.045-0.055 H a records-class billy carries. It did not need
# straightening or thickening. It needed to be LONGER, and the bases brought
# together — and `narrow` as a scale about the mesh origin is what turned it
# into a wire on the first attempt, because scaling x about x=0 squashes a horn
# centred at x=0.052 to half its own thickness. Bases move by TRANSLATION.
HORN = dict(poll=0.80, tall=1.40, inward=0.010, straighten=0.25, curl_from=0.60,
            # The PAINT band is lower than the geometry band on purpose. The
            # horn's base ring sits below `poll`, so painting on the same
            # threshold leaves a white collar between skull and horn — the horn
            # reads as floating clear of the head and loses the bottom 15% of
            # its apparent length, on the one cue the whole pass was spent
            # buying. Lengthening from here instead would drag the skull cap up.
            paint_from=0.775)

KEEP = {"Goat_Idle": "idle", "Goat_Gesture": "graze", "Goat_Run": "run",
        "Goat_Walk": "walk"}

# The shipped size, and every solved speed is multiplied by it. The procedural
# goat this replaces measures 1.306 m horn-tip to hoof off its own built mesh
# (`tools/_scratch/_goatheight.mjs`), and `glb.height` scales a model by its
# whole bounding box — so matching that number is what makes this a drop-in in
# the frame, with the four variant scales unchanged. The pack model is 0.938
# units tall, so the fit is 1.392.
#
# Tune cadence against THIS number and not against the model's own units: the
# bear was cadenced in model units once and landed 25% low in the game.
FIT = 1.306 / 0.938

LEGS = {
    ("hind", "L"): dict(scap="shoulder.L", a="thigh.L", b="shin.L",
                        target="foot.L", below=["foot.L", "toe.L"], contact="toe.L"),
    ("hind", "R"): dict(scap="shoulder.R", a="thigh.R", b="shin.R",
                        target="foot.R", below=["foot.R", "toe.R"], contact="toe.R"),
    ("fore", "L"): dict(scap="front_shoulder.L", a="front_thigh.L", b="front_shin.L",
                        target="front_foot.L", below=["front_foot.L", "front_toe.L"],
                        contact="front_toe.L"),
    ("fore", "R"): dict(scap="front_shoulder.R", a="front_thigh.R", b="front_shin.R",
                        target="front_foot.R", below=["front_foot.R", "front_toe.R"],
                        contact="front_toe.R"),
}

# The one solved gait. Diagonal pairs, and the numbers are the deer's trot taken
# down to this animal's size — the goat model is 0.938 units against the deer's
# 1.892, so every LENGTH here is roughly half the deer's while the angles and
# the duty, which are shape rather than size, are not.
#
# `crouch` is the lever that buys stride, and it is cheap on a leg that is not
# already straight: 4.5 cm of model crouch is 6.3 cm shipped, on an animal whose
# back stands a metre up. `duty` is the other one — a hoof down 0.45 of the cycle
# spends its sweep more than twice as fast as one down all of it.
TROT = dict(tuck=0.12, pitch=3.0, flight=0.020, meshes=MESHES, frames=11,
            duty=0.45, lift=0.058, bob=0.008, crouch=0.045, scapula=17.0,
            phase=DIAGONAL_TROT)

# ── the alert ────────────────────────────────────────────────────────────────
# A mountain goat's alarm is not a deer's. It does not flee — `brain.fleeDist`
# is 9 m, the shortest in the cast after the bear's — it stands on its rock and
# LOOKS at you, which the species file already says is the whole encounter. So
# the pose is head up and ears forward, held, with a slow scan either way; the
# tail lifts a little because a goat's does, but it is 40 degrees on a 6 cm tail
# rather than the white-tail's 58 on a flag, and nothing at range reads it.
#
# Starts at `spine.006`: `front_shoulder` parents to `spine.005` on THIS rig, so
# a neck beginning any lower swings the forelegs. Surveyed, not inherited.
NECK = [("spine.006", 0.24, 0.16), ("spine.007", 0.26, 0.24),
        ("spine.008", 0.24, 0.28), ("scull", 0.26, 0.32)]
TAIL = [("spine.002", 0.52), ("spine.001", 0.30), ("spine", 0.18)]
EARS = ["ear.L", "ear.R"]
ALERT_FRAMES, ALERT_LIFT, ALERT_YAW, TAIL_DEG = 120, 24.0, 62.0, 40.0
ALERT_BONES = [n for n, _, _ in NECK] + [n for n, _ in TAIL] + EARS


def stack_meshes():
    """Put `Goat_02` back on the rig's origin.

    The pack lays its cast out on a grid and this animal carries a second grid
    step INSIDE its own group — `Goat_02` sits 0.621 along x from the armature it
    is parented to. `open_animal` re-origins the armature and any parentless
    mesh, so this one is left, and an un-zeroed variant exports a coat that
    stands beside the goat instead of on it.
    """
    ob = bpy.data.objects[BROWN]
    ob.location = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()


def check_meshes_agree(rig):
    """The two coats must be the same animal, deformed the same way.

    Cheap, and it is the assertion that makes `hide` legal: if the meshes did
    not sit on top of each other the species file would be picking between two
    goats standing 62 cm apart, which looks in every still exactly like one goat
    — the other one is simply off the side of the card.
    """
    dg = bpy.context.evaluated_depsgraph_get()
    a = bpy.data.objects[WHITE].evaluated_get(dg)
    b = bpy.data.objects[BROWN].evaluated_get(dg)
    ma, mb = a.to_mesh(), b.to_mesh()
    assert len(ma.vertices) == len(mb.vertices), "the two coats are not one mesh"
    worst = max((a.matrix_world @ va.co - b.matrix_world @ vb.co).length
                for va, vb in zip(ma.vertices, mb.vertices))
    a.to_mesh_clear(); b.to_mesh_clear()
    print(f"[build] the two coats agree to {worst*1000:.4f} mm in world space")
    assert worst < 1e-5, f"{WHITE} and {BROWN} are {worst:.4f} apart"


# ─────────────────────────────────────────────────────────────────────────────
#  Making the dairy goat a mountain goat
#
#  The pack's model is a domestic dairy goat: a level back, a light neck, a
#  shallow barrel on long legs, and an udder. `Oreamnos americanus` is a
#  different silhouette on the same skeleton — a hump over the shoulders with
#  the head carried BELOW it, a deep blocky barrel, and heavy forequarters,
#  because it is an animal that hauls itself up rock rather than one bred to
#  carry milk.
#
#  Every change here is a VERTEX move on the rest mesh. Nothing touches the
#  armature, the weights or a single clip — which is what makes it legal to do
#  at all (CLAUDE.md), and it is also why it is cheap: a vertex moved in the
#  rest pose is moved in all six clips for free, because they are bone
#  rotations and the skin follows.
#
#  Two consequences worth stating, because they decide the whole approach:
#
#  * **The legs cannot be shortened.** Their length is in the bones, the clips
#    are solved against those bones, and the hooves would leave the floor. So
#    the legs are made to READ shorter the way an animal actually differs —
#    by deepening the body above them. Same trick a stockman uses by eye.
#  * **There is no texture to help.** 3,238 triangles and one flat palette
#    colour, seen mostly at 20-90 m. Silhouette and mass are the only tools,
#    so every op below is about the outline.
#
#  The ops are declarative on purpose: each is a smooth field over the rest
#  mesh, so the result stays a mesh the deformer can carry and there are no
#  creases at region edges. `sigma` is a Gaussian falloff along the body axis
#  in mesh units. In THIS mesh's local space the animal faces -y (the muzzle is
#  at -0.882 and the tail at +0.525) and the withers sit at z 0.7216.
# ─────────────────────────────────────────────────────────────────────────────

# The one dark block in `ColorPalette_1`, found by scanning it: 50 px wide,
# centred here in BLENDER uv space. Its sRGB is (101, 101, 101) against the
# white coat's (249, 249, 249) — a mid grey rather than a true black, because
# that is the darkest colour this palette contains.
#
# Beware the two conventions. glTF flips V against Blender, and Blender's
# `image.pixels` are LINEAR: read those bytes raw and this swatch reports as
# (33, 33, 33), which is the same texel described in a colour space nothing
# ever displays it in. Sample through the gamma or compare the wrong numbers.
DARK_UV = (0.8521, 0.5005)

# ── the coat ─────────────────────────────────────────────────────────────────
#
# A mountain goat's coat is not a texture on a barrel — it IS the barrel, and at
# the range this animal is seen the shag reads entirely as OUTLINE: the skirt on
# the legs, the chest fringe, the ruff welding head to shoulder, the ragged hem.
# So it is built as geometry, as tufts, and every parameter below is aimed at
# the silhouette rather than at the surface.
#
# Three things carried over from the procedural track's `ripple`, which was
# written for the yak and went unused the moment these two went GLB. They cost
# a round each there and they apply unchanged here:
#
#   * hair HANGS. `droop` mixes the surface normal toward straight down, and
#     without it a coat is a pincushion of radial spikes.
#   * a coat needs two scales. One even field of identical tufts reads as
#     upholstery; `jitter` on direction and `vary` on length break it.
#   * it belongs on the flank and the hem, not the spine. The back gets the
#     shortest, most upright tufts of any region for exactly that reason —
#     shagging a spine turns a smooth back into corrugated iron.
#
# `dens` is tufts per square unit of the surface they sit on, so a region's
# count follows its area and does not need hand-balancing.
FUR_SEED = 20260901
TUFT_TRIS = 3                    # a 4-vertex lock: 3 sides, base left open
FUR_DENSITY = 1.0                # global multiplier; the triangle budget lever

# `lift` is the whole difference between a coat and a pincushion, and the first
# attempt got it wrong: a tuft aimed along the surface NORMAL is a thorn. Hair
# lies against the body and only lifts away at the hem, so the direction is
# built the other way round — `comb` is combed flat into the tangent plane
# first, and `lift` then mixes a little of the normal back in. 0.09 is a lock
# lying on the flank; 0.26 is the fringe at the brisket standing off the body.
#
# `comb` is the direction hair falls before projection: down, and swept toward
# the tail. `width` is the base half-width as a fraction of length; `curl`
# droops the tip under gravity so a lock hangs rather than pointing.
#
# The second attempt covered only the hindquarters — the chest caught seven
# tufts and the forelegs none — because the region test was a ladder of
# y-bands that left holes. `_fur_region` now returns a region for EVERY point
# on the animal except the four places hair does not belong: the face, the
# horns, the ears and the cannons.
FUR = [
    # name          dens  length  lift  comb              width jitter vary curl
    dict(name="ruff",     dens=1500, length=0.066, lift=0.15,
         comb=(0.0, 0.45, -1.0), width=0.34, jitter=0.10, vary=0.35, curl=0.22,
         back_only=True),
    dict(name="throat",   dens=1600, length=0.070, lift=0.16,
         comb=(0.0, 0.25, -1.0), width=0.34, jitter=0.10, vary=0.35, curl=0.26,
         back_only=True),
    # The beard is the one region built from MANY SMALL locks rather than a few
    # big ones. At the body's tuft size it came out as a handful of slabs the
    # width of the jaw, hanging like a bib; a beard is a dense stack of short
    # hairs. So: a fifth of the length, and forty times the density to fill it.
    dict(name="beard",    dens=17000, length=0.034, lift=0.05,
         comb=(0.0, 0.05, -1.0), width=0.26, jitter=0.06, vary=0.30, curl=0.10,
         back_only=True),
    dict(name="brisket",  dens=1500, length=0.070, lift=0.24,
         comb=(0.0, 0.20, -1.0), width=0.34, jitter=0.12, vary=0.35, curl=0.26),
    dict(name="belly",    dens=1400, length=0.058, lift=0.18,
         comb=(0.0, 0.30, -1.0), width=0.32, jitter=0.12, vary=0.35, curl=0.24),
    dict(name="flank",    dens=1500, length=0.046, lift=0.09,
         comb=(0.0, 0.55, -1.0), width=0.30, jitter=0.14, vary=0.40, curl=0.18),
    dict(name="shoulder", dens=1500, length=0.050, lift=0.11,
         comb=(0.0, 0.45, -1.0), width=0.30, jitter=0.14, vary=0.38, curl=0.20),
    dict(name="spine",    dens=1000, length=0.036, lift=0.10,
         comb=(0.0, 1.00, -0.25), width=0.28, jitter=0.14, vary=0.35, curl=0.10),
    dict(name="rump",     dens=1400, length=0.060, lift=0.18,
         comb=(0.0, 0.85, -0.60), width=0.32, jitter=0.12, vary=0.35, curl=0.20),
    dict(name="pants",    dens=1500, length=0.070, lift=0.22,
         comb=(0.0, 0.25, -1.0), width=0.34, jitter=0.12, vary=0.40, curl=0.24),
    dict(name="forepants",dens=1400, length=0.052, lift=0.20,
         comb=(0.0, 0.20, -1.0), width=0.32, jitter=0.12, vary=0.40, curl=0.22),
]
HORN_TOP = 0.938
HORN_BASE_Y = -0.73
WITHERS_Z = 0.7216          # spine.005's head; the unit every amplitude is in
BELLY_Z = 0.3269            # lowest trunk vertex beside the udder, not under it


def _gauss(v, c, sigma):
    return math.exp(-0.5 * ((v - c) / sigma) ** 2)


def _updown(z, lo, hi):
    """0 at `lo`, 1 at `hi`, smooth — 'how much of the back is this vertex'."""
    t = max(0.0, min(1.0, (z - lo) / (hi - lo)))
    return t * t * (3.0 - 2.0 * t)


def _fur_region(co, n, leg, hind, scull):
    """Which coat region a point belongs to. Everything is covered but four.

    A mountain goat in winter is haired over essentially all of itself, so the
    default here is "coat" and the exceptions are named: the face, the horns and
    the ears (all `scull`-weighted, and only the jaw under them grows a beard),
    and the cannons below the hock, where tufts read as mud rather than as hair.

    The BEARD is the one region that cannot be described by a box. A band on
    y and z catches the cheeks and the sides of the muzzle as well as the chin,
    and the result is a goat with fur fanning off its whole face — so the test
    is the surface NORMAL instead: a beard grows where the jaw faces DOWN.
    Held near the midline as well, because a goat's beard is a hanging tuft and
    not a pair of sideburns.
    """
    y, z = co.y, co.z
    if scull > 0.5:
        # UNDER THE CHIN and nowhere else. Three separate clamps, because each
        # one alone leaks: the normal test keeps it off the cheeks, the y band
        # keeps it off the muzzle (it was reaching past the nose), and the x
        # clamp keeps it a hanging tuft rather than a bib the width of the jaw.
        chin = (n.z < -0.35 and -0.82 < y < -0.68 and z < 0.60
                and abs(co.x) < 0.050)
        return "beard" if chin else None
    if leg > 0.5:
        if z < 0.26:
            return None                       # cannon and hoof stay clean
        return "pants" if hind else "forepants"
    if y < -0.64:
        # Forward of the jaw line and not on the skull group: the cheek and the
        # side of the muzzle. Left bare on purpose — a mountain goat's face is
        # smooth and its chin hangs a beard, and letting the ruff creep forward
        # of here is what put fur across the animal's own cheekbone.
        return None
    if y > 0.34:
        return "rump"
    if z > 0.74:
        return "spine"
    if y < -0.30:
        return "throat" if z < 0.55 else "ruff"
    if z < 0.44:
        return "brisket" if y < -0.05 else "belly"
    return "shoulder" if y < -0.08 else "flank"


def add_fur(report=True):
    """Grow the coat as tufts welded into the body mesh.

    Built here rather than with a Geometry Nodes tree, and the reasons are
    practical rather than dogmatic: a node tree authored from Python is verbose
    and moves between versions, `export_pack_glb.py` STRIPS `NODES` modifiers
    (so an unapplied one would vanish silently at export and look perfect in
    Blender), and generating the tufts directly lets each one inherit the skin
    weights of the body vertex it grows from. That last point is the one that
    matters: a tuft is small, so binding it rigidly to its root's weights makes
    it ride the skin exactly, through all six clips, with no stretching and no
    transfer step to get wrong.

    Both coats get the SAME geometry — same seed, same input mesh — so
    `check_meshes_agree` still holds. Only the UVs differ, and each mesh's tufts
    take that mesh's own body colour.
    """
    rig = bpy.data.objects[RIG]
    hind_groups = {"thigh.L", "thigh.R", "shin.L", "shin.R", "foot.L", "foot.R",
                   "toe.L", "toe.R"}
    counts = {}

    for ob in MESHES:
        obj = bpy.data.objects[ob]
        me = obj.data
        gi = {g.name: g.index for g in obj.vertex_groups}
        leg_idx = {gi[n] for n in gi if n.split(".")[0] in (
            "thigh", "shin", "foot", "toe",
            "front_thigh", "front_shin", "front_foot", "front_toe")}
        hind_idx = {gi[n] for n in hind_groups if n in gi}
        scull_idx = gi.get("scull", -1)

        bm = bmesh.new()
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        bm.faces.ensure_lookup_table()
        dvert = bm.verts.layers.deform.active or bm.verts.layers.deform.new()
        uvl = bm.loops.layers.uv.active
        body_uv = _body_uv(me)

        rnd = random.Random(FUR_SEED)
        source = list(bm.faces)
        made = {}
        for f in source:
            n = f.normal.copy()
            if n.length < 1e-9:
                continue
            n.normalize()
            c = f.calc_center_median()
            vs = list(f.verts)
            near = min(vs, key=lambda v: (v.co - c).length)
            w = near[dvert]
            leg = sum(w.get(i, 0.0) for i in leg_idx)
            hind = sum(w.get(i, 0.0) for i in hind_idx) > 0.5
            scull = w.get(scull_idx, 0.0)
            reg = _fur_region(c, n, leg, hind, scull)
            if reg is None:
                continue
            spec = next(r for r in FUR if r["name"] == reg)

            area = f.calc_area()
            exact = area * spec["dens"] * FUR_DENSITY
            k = int(exact) + (1 if rnd.random() < (exact - int(exact)) else 0)
            for _ in range(k):
                # Barycentric point on the face, and the nearest corner's
                # weights: a tuft rides one body vertex rigidly.
                a, b = rnd.random(), rnd.random()
                if a + b > 1.0:
                    a, b = 1.0 - a, 1.0 - b
                p = vs[0].co + (vs[1].co - vs[0].co) * a + (vs[2].co - vs[0].co) * b
                root = min(vs, key=lambda v: (v.co - p).length)

                # Comb flat FIRST, then lift. The reverse — normal, then bend
                # toward gravity — is what makes thorns.
                comb = Vector(spec["comb"])
                comb.x += rnd.uniform(-1, 1) * spec["jitter"]
                tangent = comb - n * comb.dot(n)
                if tangent.length < 1e-6:
                    tangent = Vector((0.0, 1.0, 0.0)) - n * n.y
                tangent.normalize()
                d = tangent * (1.0 - spec["lift"]) + n * spec["lift"]
                d += Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1),
                             rnd.uniform(-1, 1))) * spec["jitter"] * 0.5
                if d.length < 1e-6:
                    continue
                d.normalize()
                # Nothing on the head or throat may point FORWARD. Those
                # surfaces face the muzzle, so `lift` — which mixes the normal
                # back in — aims their tufts straight across the face, and the
                # goat ends up with fur growing past its own nose. Hair on a
                # throat hangs down and sweeps back; it never leads.
                if spec.get("back_only") and d.y < 0.0:
                    d.y *= 0.10
                    if d.length < 1e-6:
                        continue
                    d.normalize()
                ln = spec["length"] * (1.0 + rnd.uniform(-1, 1) * spec["vary"])
                rad = max(ln * spec["width"], 0.005)
                # A lock is a flat ribbon, not a needle: wide ACROSS the fall,
                # thin through it. A round base is what made the first two
                # attempts read as grass stuck to a goat.
                across = d.cross(n)
                if across.length < 1e-6:
                    across = d.cross(Vector((0.0, 1.0, 0.0)))
                across.normalize()
                thick = d.cross(across).normalized()

                # A base triangle in the plane across the tuft, sunk slightly so
                # the join never gaps, and one tip. Three side faces.
                base0 = p - d * (rad * 0.5)
                corners = (across * rad,
                           across * -rad,
                           thick * (rad * 0.55))
                ring = []
                for off in corners:
                    nv = bm.verts.new(base0 + off)
                    nv[dvert].clear()
                    for gidx, gw in root[dvert].items():
                        nv[dvert][gidx] = gw
                    ring.append(nv)
                # The tip falls away under its own weight, which is what makes
                # a lock hang instead of point.
                tip = bm.verts.new(p + d * ln + Vector((0.0, 0.0, -1.0))
                                   * ln * spec["curl"])
                tip[dvert].clear()
                for gidx, gw in root[dvert].items():
                    tip[dvert][gidx] = gw

                for j in range(3):
                    nf = bm.faces.new((ring[j], ring[(j + 1) % 3], tip))
                    nf.smooth = False       # faceted, like the rest of the world
                    nf.material_index = f.material_index
                    if uvl:
                        for lp in nf.loops:
                            lp[uvl].uv = body_uv
                made[reg] = made.get(reg, 0) + 1

        bm.normal_update()
        bm.to_mesh(me)
        bm.free()
        me.update()
        counts[ob] = made

    if report:
        for ob, made in counts.items():
            total = sum(made.values())
            print(f"[fur] {ob}: {total} tufts (+{total * TUFT_TRIS} tris) "
                  + " ".join(f"{k}:{v}" for k, v in sorted(made.items())))


def _body_uv(me):
    """The commonest UV on the mesh — its body colour."""
    uv = me.uv_layers.active.data
    tally = {}
    for poly in me.polygons:
        for li in poly.loop_indices:
            k = tuple(round(c, 4) for c in uv[li].uv)
            tally[k] = tally.get(k, 0) + 1
    return max(tally.items(), key=lambda kv: kv[1])[0]


def _find_eyes(ob):
    """The eye vertices, found by colour on the white coat.

    The pack paints them a pale yellow (255, 241, 194) with a light grey ring —
    a domestic goat's slot pupil. A mountain goat's eye is black, and on a white
    head at range it is one of only three dark marks the animal has, alongside
    the horns and the nose.

    Found here rather than by a bounding box because a box around the eye also
    catches the brow and the cheek, and found ONCE on `Goat_01` because the two
    coats differ precisely in their UVs — the same trap the nose fell into.
    """
    me = ob.data
    uv = me.uv_layers.active.data
    out = set()
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            co = me.vertices[vi].co
            if not (-0.82 < co.y < -0.72 and 0.66 < co.z < 0.74 and abs(co.x) > 0.03):
                continue
            u, v = round(uv[li].uv[0], 3), round(uv[li].uv[1], 3)
            if (u, v) in ((0.677, 0.383), (0.875, 0.720)):
                out.add(vi)
    return out


def _find_nose(ob):
    """The muzzle vertices that are actually painted pink, on the white coat."""
    me = ob.data
    uv = me.uv_layers.active.data
    out = set()
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            if me.vertices[vi].co.y < -0.80 and uv[li].uv[0] < 0.10:
                out.add(vi)
    return out


def _repaint(ob, verts, uv_to, label):
    """Point every loop of `verts` at one palette texel."""
    if not verts:
        return
    uv = ob.data.uv_layers.active.data
    n = 0
    for poly in ob.data.polygons:
        for li in poly.loop_indices:
            if ob.data.loops[li].vertex_index in verts:
                uv[li].uv = uv_to
                n += 1
    print(f"[shape] {ob.name}: {label} -> uv {uv_to} ({len(verts)} verts, {n} loops)")


def _darken_details(ob, gi, wof, paint_ids, nose_ids, eye_ids):
    """Horns, nose and hooves are the wrong colour, and the horns matter most.

    A mountain goat's horns, nose and hooves are black, and that contrast is the
    whole reason the horn is worth lengthening: a dark spike above a pale head,
    against pale rock and pale sky, is the one identity cue that survives every
    range, every pose and every terrain tilt — because unlike the back line it
    does not rotate away.

    As shipped, the pack paints all three the colour of the animal: the horn
    (244, 225, 218), the nose (255, 231, 233) bubblegum pink, the hooves
    (222, 212, 209) — against a (249, 249, 249) coat. The horn was within 5% of
    the coat's value, so at 45 m the model's best cue was not merely weak, it
    was invisible, and lengthening it bought nothing.
    """
    me = ob.data
    hoof = {v.index for v in me.vertices
            if sum(wof(v, n) for n in gi
                   if n.split(".")[0] in ("toe", "front_toe")) > 0.5}
    _repaint(ob, paint_ids, DARK_UV, "horns")
    _repaint(ob, nose_ids, DARK_UV, "nose")
    _repaint(ob, eye_ids, DARK_UV, "eyes")
    _repaint(ob, hoof, DARK_UV, "hooves")


def _repaint_udder(ob, gi, wof):
    """Give the flattened udder the body's colour.

    Tucking the udder into the belly moves the GEOMETRY and leaves the PAINT,
    and on a palette-mapped model that is not subtle: the udder's 25 UVs sit
    around (0.074, 0.41) — a pink swatch — while the belly around it maps to
    (0.86, 0.93). The result is a goat with a pink smear under it where the
    udder used to hang, which is arguably worse than the udder.

    The two coats have DIFFERENT UVs — that is what makes them two coats — so
    the body colour is found per mesh rather than hard-coded.
    """
    me = ob.data
    uv = me.uv_layers.active.data
    leg_groups = [n for n in gi if n.split(".")[0] in (
        "thigh", "shin", "foot", "toe",
        "front_thigh", "front_shin", "front_foot", "front_toe")]

    # ANY weight at all, not a majority. At a 0.25 threshold the teats survived
    # as a pink smudge under the rear belly: their vertices are mostly weighted
    # to the belly bones and only slightly to `udder`, so they read as body by
    # weight and as udder by PAINT. The geometry test that matters here is the
    # UV, not the skinning.
    udder = {v.index for v in me.vertices if wof(v, "udder") > 0.0}
    if not udder:
        return
    # The body's dominant colour: the commonest UV over trunk vertices that are
    # not the udder, not a leg and not the head (which carries its own swatches).
    body = {}
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            v = me.vertices[vi]
            if vi in udder or v.co.y < -0.55:
                continue
            if min(1.0, sum(wof(v, n) for n in leg_groups)) > 0.5:
                continue
            k = tuple(round(c, 4) for c in uv[li].uv)
            body[k] = body.get(k, 0) + 1
    target = max(body.items(), key=lambda kv: kv[1])[0]

    # The udder's own swatches, to catch faces the weights do not reach.
    swatch = {tuple(round(c, 4) for c in uv[li].uv)
              for poly in me.polygons for li in poly.loop_indices
              if me.loops[li].vertex_index in udder}
    swatch.discard(target)

    n = 0
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            v = me.vertices[vi]
            here = tuple(round(c, 4) for c in uv[li].uv)
            # Under the belly and painted udder-colour is udder, however it is
            # weighted. Bounded to the belly so a swatch shared with the muzzle
            # or the ears is not repainted along with it.
            belly = v.co.y > -0.10 and v.co.z < 0.55
            if vi in udder or (belly and here in swatch):
                uv[li].uv = target
                n += 1
    print(f"[shape] {ob.name}: repainted {n} udder loops to the body colour "
          f"at uv {target}")


def reshape_mountain_goat(report=True):
    """Move the dairy goat's vertices onto a mountain goat's silhouette.

    Applied to BOTH coats identically — they are the same 828 vertices with
    different UVs, and `check_meshes_agree` is what proves it stayed that way.
    """
    obs = [bpy.data.objects[n] for n in MESHES]
    gi = {g.name: g.index for g in obs[0].vertex_groups}

    leg_groups = [n for n in gi if n.split(".")[0] in (
        "thigh", "shin", "foot", "toe",
        "front_thigh", "front_shin", "front_foot", "front_toe")]

    def wof(v, name):
        j = gi.get(name)
        return 0.0 if j is None else sum(w.weight for w in v.groups if w.group == j)

    # The horn's own extents, measured rather than assumed: the tip's height
    # sets the parameter t along the horn, and the base's y is what the lower
    # two thirds are straightened toward.
    horns = [v for v in obs[0].data.vertices
             if v.co.z > HORN["poll"] and wof(v, "scull") > 0.5
             and v.co.y > -0.80 and abs(v.co.x) > 0.015]
    global HORN_TOP, HORN_BASE_Y
    HORN_TOP = max(v.co.z for v in horns)
    base = [v for v in horns if v.co.z < HORN["poll"] + 0.02]
    HORN_BASE_Y = (sum(v.co.y for v in base) / len(base)) if base else -0.73
    horn_ids = {v.index for v in horns}
    paint_ids = {v.index for v in obs[0].data.vertices
                 if v.co.z > HORN["paint_from"] and wof(v, "scull") > 0.5
                 and v.co.y > -0.80 and abs(v.co.x) > 0.015}
    print(f"[shape] horns: {len(horns)} verts, poll {HORN['poll']:.3f} -> tip "
          f"{HORN_TOP:.3f}, base y {HORN_BASE_Y:+.3f}")

    # Leg vertices are thickened about their own bone, so the centres are
    # needed before the sweep.
    rig = bpy.data.objects[RIG]
    axis = {n: (rig.data.bones[n].head_local.x, rig.data.bones[n].head_local.y)
            for n in leg_groups if n in rig.data.bones}
    hind = {n for n in leg_groups if not n.startswith("front_")}

    horn_z0 = HORN["poll"]

    moved = []
    for ob in obs:
        for v in ob.data.vertices:
            co = v.co
            x, y, z = co.x, co.y, co.z
            wl = {n: wof(v, n) for n in leg_groups}
            leg = min(1.0, sum(wl.values()))
            trunk = 1.0 - leg
            up = _updown(z, BELLY_Z, WITHERS_Z)          # how much of the back
            dx = dy = dz = 0.0

            # ── 1. the udder goes ────────────────────────────────────────────
            # Not deleted — deleting leaves a hole in a closed mesh and there is
            # no topology to spare. The 76 udder vertices are drawn up into the
            # belly line and squeezed toward the midline, so the surface closes
            # over itself. `_repaint_udder` then deals with the paint, which is
            # a separate problem and bit once already.
            u = wof(v, "udder")
            if u > 0.0:
                dz += u * (BELLY_Z + UDDER["tuck"] - z)
                dx += u * (UDDER["narrow"] - 1.0) * x

            # ── 2. the shoulder hump, asymmetric ─────────────────────────────
            # THE cue, and it has to be a RAMP rather than a lump: at twelve
            # pixels tall the eye reads the whole top edge, so a continuous
            # rise from the tail head to the shoulder moves far more of the
            # outline than a local bulge over the scapula does.
            sig = HUMP["sigma_fore"] if y < HUMP["at"] else HUMP["sigma_aft"]
            dz += HUMP["rise"] * trunk * up * _gauss(y, HUMP["at"], sig)

            # ── 3. the hair crest, spine and rump ────────────────────────────
            dz += trunk * up * (CREST["spine"] * _gauss(y, CREST["at"], CREST["sigma"])
                                + CREST["rump"] * _gauss(y, CREST["rump_at"],
                                                         CREST["rump_sigma"]))

            # ── 4. the barrel deepens and the wedge turns round ──────────────
            # Dropping the chest floor is what makes the legs read short
            # without touching a bone, and the fore/hind width terms reverse
            # the dairy wedge: heavy in front of the diaphragm, plain behind.
            dz -= BARREL["drop"] * trunk * (1.0 - up) * _gauss(y, BARREL["at"], BARREL["sigma"])
            dx += x * trunk * (WIDTH["fore"] * _gauss(y, WIDTH["fore_at"], WIDTH["sigma"])
                               + WIDTH["hind"] * _gauss(y, WIDTH["hind_at"], WIDTH["sigma"]))

            # ── 5. the neck thickens and slants DOWN out of the hump ─────────
            # A dairy goat carries a light neck high and its poll sits above the
            # back line. On this animal the poll belongs BELOW the top of the
            # hump, and that inverted relationship is the loudest single tell.
            n = _gauss(y, NECK_MASS["at"], NECK_MASS["sigma"]) * trunk
            dx += x * NECK_MASS["thicken"] * n
            dz -= NECK_MASS["drop"] * n * up

            # ── 6. the legs: columns, fat at the top ─────────────────────────
            if leg > 0.01:
                bone = max(wl.items(), key=lambda kv: kv[1])[0]
                cx, cy = axis.get(bone, (x, y))
                t = _updown(z, LEG_FAT["z_lo"], LEG_FAT["z_hi"])
                fat = LEG_FAT["low"] + (LEG_FAT["top"] - LEG_FAT["low"]) * t
                if bone in hind:
                    fat += PANTS["add"] * _updown(z, PANTS["z_lo"], PANTS["z_hi"])
                dx += (x - cx) * fat * leg
                dy += (y - cy) * fat * leg

            # ── 7. the horns rise before they curl ───────────────────────────
            # Everything above the poll on the skull. The lower two thirds are
            # pulled back toward vertical and the whole horn lengthened; the
            # top third keeps the sweep the artist drew, which is where a
            # mountain goat's curl actually lives. Bases drawn together.
            # `abs(x) > 0.015` keeps the four midline vertices of the skull
            # cap out of it — they sit at the same height as the horn bases and
            # straightening them dents the top of the head.
            if (z > horn_z0 and wof(v, "scull") > 0.5 and y > -0.80
                    and abs(x) > 0.015):
                t = min(1.0, (z - horn_z0) / max(HORN_TOP - horn_z0, 1e-6))
                dz += (z - horn_z0) * (HORN["tall"] - 1.0)
                keep = _updown(t, HORN["curl_from"], 1.0)
                dy -= (y - HORN_BASE_Y) * HORN["straighten"] * (1.0 - keep)
                dx -= math.copysign(HORN["inward"], x) * (1.0 - keep)

            v.co = (x + dx, y + dy, z + dz)
            if ob is obs[0]:
                moved.append(((dx * dx + dy * dy + dz * dz) ** 0.5, y, z))

    # The nose is found ONCE, on the white coat, and applied to both by vertex
    # index. The two coats differ only in their UVs, so a test that asks "which
    # loops are painted pink" finds the nose on `Goat_01` and nothing at all on
    # `Goat_02` — which is how the brown goat kept a pink nose for one build.
    nose_ids = _find_nose(obs[0])
    eye_ids = _find_eyes(obs[0])
    for ob in obs:
        _repaint_udder(ob, gi, wof)
        _darken_details(ob, gi, wof, paint_ids, nose_ids, eye_ids)

    if report:
        moved.sort(reverse=True)
        print(f"[shape] moved {sum(1 for d, *_ in moved if d > 1e-6)} of "
              f"{len(moved)} vertices; largest {moved[0][0]:.4f} "
              f"({moved[0][0]/WITHERS_Z*100:.1f}% of withers height)")


def alert_scan(f):
    """Fast turns separated by long holds.

    Stiffness is a property of the SCHEDULE, not of the angles: the identical
    pose range driven as a sine wave reads as grazing-curious. The hold is the
    tell, and a goat holds longer than a deer does — it has nothing to run from.
    """
    moves = [(0, 20, 0.0, 0.0), (20, 29, 0.0, -1.0), (29, 54, -1.0, -1.0),
             (54, 64, -1.0, 1.0), (64, 89, 1.0, 1.0), (89, 98, 1.0, 0.0),
             (98, 120, 0.0, 0.0)]
    for a, b, u, v in moves:
        if a <= f <= b:
            return u + (v - u) * ease(0.0 if b == a else (f - a) / (b - a))
    return 0.0


def build_alert(rig, rest):
    clear(rig)
    muzzle0 = rig.pose.bones[HEAD].tail.copy()
    tail0 = rig.pose.bones["spine"].tail.copy()

    act = new_action(rig, "alert", ALERT_FRAMES)
    for i in range(ALERT_FRAMES + 1):
        f = i % ALERT_FRAMES
        clear(rig)
        yaw = alert_scan(f)
        lift = ease(min(1.0, f / 10.0)) if f < 10 else 1.0
        for name, l_share, y_share in NECK:
            pb = rig.pose.bones[name]
            point(pb, rz(ALERT_YAW * y_share * yaw)
                  @ rx(-ALERT_LIFT * l_share * lift) @ (pb.tail - pb.head).normalized())
        for name, share in TAIL:
            pb = rig.pose.bones[name]
            point(pb, rx(TAIL_DEG * share * lift) @ (pb.tail - pb.head).normalized())
        for name in EARS:
            pb = rig.pose.bones[name]
            point(pb, rz(15.0 * yaw) @ (pb.tail - pb.head).normalized())
        key(rig, ALERT_BONES, i)
    set_linear(act)
    rig.animation_data.action = None
    clear(rig)

    mz, xs, tz, hoof = [], [], [], 0.0
    for i in range(ALERT_FRAMES + 1):
        sample(rig, act, i)
        mz.append(rig.pose.bones[HEAD].tail.z)
        xs.append(rig.pose.bones[HEAD].tail.x)
        tz.append(rig.pose.bones["spine"].tail.z)
        for k, L in LEGS.items():
            hoof = max(hoof, (rig.pose.bones[L["contact"]].head - rest[k]["contact"]).length)
    s = seam(rig, act, ALERT_FRAMES)
    rig.animation_data.action = None
    clear(rig)
    print(f"[alert] muzzle z {muzzle0.z:.3f} -> {max(mz):.3f} (+{max(mz)-muzzle0.z:.3f}, "
          f"{(max(mz)-muzzle0.z)*FIT*100:.1f} cm shipped); "
          f"tail z {tail0.z:.3f} -> {max(tz):.3f} (+{max(tz)-tail0.z:.3f}); "
          f"scan x {min(xs):+.3f}..{max(xs):+.3f} ({(max(xs)-min(xs))*FIT*100:.1f} cm shipped)")
    print(f"[alert]   hoof movement {hoof*1000:7.3f} mm    cycle seam {s*1000:7.3f} mm")
    # Tied to what the pose is FOR, and scaled to this animal rather than
    # inherited from the deer's: the head has to come up, the tail has to come
    # up, and the scan has to reach both sides far enough to read.
    assert max(mz) > muzzle0.z + 0.02, "the head never comes up"
    assert max(tz) > tail0.z + 0.02, "the tail never comes up"
    assert min(xs) < -0.03 and max(xs) > 0.03, "the head does not look both ways"
    assert hoof < 1e-4, f"a hoof moved {hoof*1000:.3f} mm; alert must not"


def main():
    rig = open_animal(RIG, MESHES, "Goat_")
    stack_meshes()
    face_forward(rig, HEAD)
    # Before ANYTHING is solved: the trot is solved against this mesh and its
    # edge-stretch check is only meaningful on the mesh that ships.
    reshape_mountain_goat()
    add_fur()
    check_meshes_agree(rig)

    for act in list(bpy.data.actions):
        if act.name in KEEP:
            act.name = KEEP[act.name]
            act.use_fake_user = True
            act.use_frame_range = True
        else:
            bpy.data.actions.remove(act, do_unlink=True)

    bb = [bpy.data.objects[WHITE].matrix_world @ Vector(c)
          for c in bpy.data.objects[WHITE].bound_box]
    h = max(p.z for p in bb) - min(p.z for p in bb)
    print(f"[build] goat {h:.3f} units tall, {max(p.y for p in bb) - min(p.y for p in bb):.3f} "
          f"long; ships at {h*FIT:.3f} m (fit x{FIT:.3f})")
    # The back line, which is the proportion a goat is READ by — the withers
    # hump is the whole silhouette. Reported rather than fitted to: `glb.height`
    # matches the box, and where the back then lands is a finding.
    clear(rig)
    withers = rig.pose.bones["spine.005"].head.z
    print(f"[build] withers (spine.005) {withers:.3f} units = {withers*FIT:.3f} m shipped")

    rest = gait_rest(rig, LEGS)
    for k, L in LEGS.items():
        R = rest[k]
        print(f"[rest] {k[0]}.{k[1]} l1 {R['l1']:.3f} l2 {R['l2']:.3f} "
              f"reach(safe) {R['reach']:.3f} hip z {R['hip'].z:.3f}")
    # Only the trot is solved. `idle`, `graze`, `walk` and `run` are the pack's
    # and are kept as shipped — see KEEP above. `new_action` deletes any action
    # of the same name, so solving "walk" or "run" here would silently clobber
    # the artist's clip.
    build_gait(rig, LEGS, rest, "trot", TROT, unit_m=FIT)
    build_alert(rig, rest)

    rig.animation_data.action = None
    for act in sorted(bpy.data.actions, key=lambda a: a.name):
        t = rig.animation_data.nla_tracks.new()
        t.name = act.name
        t.strips.new(act.name, int(act.frame_start), act)
        t.is_solo = False

    trot = bpy.data.actions["trot"]
    frame_view(rig, [WHITE], clip="trot",
               clip_range=(int(trot.frame_start), int(trot.frame_end)))
    mats, imgs = purge(MESHES)
    print(f"[build] kept materials {mats} images {imgs}")

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "assets", "models", "goat_pack.blend")
    bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
    print(f"[build] saved {out} ({os.path.getsize(out)} bytes); clips "
          f"{sorted(a.name for a in bpy.data.actions)}; meshes "
          f"{[o.name for o in bpy.data.objects if o.type == 'MESH']}")


main()
