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

import os
import sys

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
