"""Build the game's deer .blend from the bought pack, and save it.

    Blender -b assets/models/Animals_v3.0.blend --python tools/build_deer_blend.py

Writes `assets/models/deer_pack.blend`. Second animal on this path; the shape of
it is `build_raccoon_blend.py` and the machinery is `pack_rig_kit.py`.

## Three meshes, one skeleton — which is what makes the variants real

The pack ships `Deer_01` (buck, 1914 tris), `Deer_Female_01` (doe, 1278) and
`Deer_Cub_01` (fawn, 1310) as separate models with separate armatures. Measured,
those three armatures are **identical**: same 33 bone names, and every bone head
in the same place to four decimals.

So the doe and fawn are re-parented onto the buck's skeleton and all three ride
one rig in one GLB, and `variants` picks between them with `hide`. That recovers
the thing the free pack cost us — every deer being the same buck at four sizes —
and it is better than the authored deer managed: three genuinely different
silhouettes rather than one mesh with its antlers dropped.

## What is kept, and what is solved over the top

    Deer_Idle     331f  -> idle    kept
    Deer_Gesture  392f  -> graze   kept; a real graze, muzzle 1.430 -> 0.385
    Deer_Run       25f  -> run     kept, and see the note in mammals/deer.js
    Deer_Walk      31f  -> DROPPED, and replaced by a solved walk

The pack's walk is not usable here and that is a measurement, not a preference:
duty per foot 0.25 / 0.30 / 0.23 / 0.10, where a walk is *defined* by a duty
above 0.5, and the fore paws travel 0.52 over a cycle while the hind travel 0.63.
There is no single ground speed in that clip, so whichever number you take, some
hoof skates.

The raccoon's walk from the same pack measures 0.47-0.53 and is kept as shipped.
Clip quality varies per animal: measure before trusting.

`walk` and `trot` are therefore solved, and `alert` authored. The run is kept —
a bound gets most of its ground from a ballistic flight phase that a duty-cycle
sweep does not model, so solving it would make it worse, not better.
"""

import math
import os
import sys

import bpy
from mathutils import Vector, Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pack_rig_kit import (                                        # noqa: E402
    open_animal, face_forward, play, point, clear, rx, rz, ease, key,
    new_action, sample, seam, purge, frame_view, gait_rest, build_gait,
    LATERAL_WALK, DIAGONAL_TROT,
)

RIG = "Skeleton_Deer"
BUCK, DOE, FAWN = "Deer_01", "Deer_Female_01", "Deer_Cub_01"
MESHES = [BUCK, DOE, FAWN]
HEAD = "scull"

KEEP = {"Deer_Idle": "idle", "Deer_Gesture": "graze", "Deer_Run": "run"}

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

# Cadence and crouch are the two levers, and both are stated rather than tuned
# by eye. A short stride has to cycle fast to cover ground, and crouching buys
# stride: the first pass at 0.02 m of crouch solved to a 0.530 sweep against a
# geometric maximum of 0.790, and 0.49 m/s where a white-tail walks at 1.15.
# 6-7 cm on a 1.08 m animal is not visible and is most of the gap.
WALK = dict(frames=18, duty=0.62, lift=0.075, bob=0.010, crouch=0.060,
            scapula=13.0, phase=LATERAL_WALK)
TROT = dict(frames=11, duty=0.45, lift=0.105, bob=0.014, crouch=0.075,
            scapula=17.0, phase=DIAGONAL_TROT)

# Alert. Starts at spine.006: on THIS rig `front_shoulder` parents to spine.005,
# so a neck beginning any lower swings the forelegs. That is a survey result and
# it differs per animal — the raccoon's had to start at spine.008.
NECK = [("spine.006", 0.24, 0.16), ("spine.007", 0.26, 0.24),
        ("spine.008", 0.24, 0.28), ("scull", 0.26, 0.32)]
TAIL = [("spine.002", 0.52), ("spine.001", 0.30), ("spine", 0.18)]
EARS = ["ear.L", "ear.R"]
ALERT_FRAMES, ALERT_LIFT, ALERT_YAW, TAIL_DEG = 120, 26.0, 70.0, 58.0
ALERT_BONES = [n for n, _, _ in NECK] + [n for n, _ in TAIL] + EARS


def unify_skeleton():
    """Put the doe and fawn on the buck's rig.

    Legal because the three armatures are identical — same names, same rest
    geometry to four decimals — so the vertex groups bind to the same bones and
    the buck's clips drive all three. Done BEFORE `open_animal` deletes the
    other two armatures, or the meshes would be orphaned.
    """
    rig = bpy.data.objects[RIG]
    for name in (DOE, FAWN):
        ob = bpy.data.objects[name]
        ob.parent = rig
        ob.matrix_parent_inverse = Matrix()
        ob.location = (0.0, 0.0, 0.0)
        ob.rotation_euler = (0.0, 0.0, 0.0)
        for m in ob.modifiers:
            if m.type == 'ARMATURE':
                m.object = rig
    bpy.context.view_layer.update()


def alert_scan(f):
    moves = [(0, 18, 0.0, 0.0), (18, 27, 0.0, -1.0), (27, 51, -1.0, -1.0),
             (51, 62, -1.0, 1.0), (62, 86, 1.0, 1.0), (86, 96, 1.0, 0.0),
             (96, 120, 0.0, 0.0)]
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
        key(rig, ALERT_BONES, 1 + i)
    rig.animation_data.action = None
    clear(rig)

    mz, xs, tz, hoof = [], [], [], 0.0
    for i in range(ALERT_FRAMES + 1):
        sample(rig, act, 1 + i)
        mz.append(rig.pose.bones[HEAD].tail.z)
        xs.append(rig.pose.bones[HEAD].tail.x)
        tz.append(rig.pose.bones["spine"].tail.z)
        for k, L in LEGS.items():
            hoof = max(hoof, (rig.pose.bones[L["contact"]].head - rest[k]["contact"]).length)
    s = seam(rig, act, ALERT_FRAMES)
    rig.animation_data.action = None
    clear(rig)
    print(f"[alert] muzzle z {muzzle0.z:.3f} -> {max(mz):.3f} (+{max(mz)-muzzle0.z:.3f}); "
          f"tail z {tail0.z:.3f} -> {max(tz):.3f} (+{max(tz)-tail0.z:.3f}); "
          f"scan x {min(xs):+.3f}..{max(xs):+.3f}")
    print(f"[alert]   hoof movement {hoof*1000:7.3f} mm    cycle seam {s*1000:7.3f} mm")
    assert max(mz) > muzzle0.z + 0.03, "the head never comes up"
    assert max(tz) > tail0.z + 0.05, "the tail never comes up"
    assert min(xs) < -0.04 and max(xs) > 0.04, "the head does not look both ways"
    assert hoof < 1e-4, f"a hoof moved {hoof*1000:.3f} mm; alert must not"


def main():
    unify_skeleton()
    rig = open_animal(RIG, MESHES, "Deer_")
    face_forward(rig, HEAD)

    for act in list(bpy.data.actions):
        if act.name in KEEP:
            act.name = KEEP[act.name]
            act.use_fake_user = True
            act.use_frame_range = True
        else:
            # Deer_Walk (unusable, see the header) and every Deer_Cub_* /
            # Deer_Female_* clip: the buck's drive all three meshes.
            bpy.data.actions.remove(act, do_unlink=True)

    bb = [bpy.data.objects[BUCK].matrix_world @ Vector(c)
          for c in bpy.data.objects[BUCK].bound_box]
    print(f"[build] buck {max(p.z for p in bb) - min(p.z for p in bb):.3f} units tall")

    rest = gait_rest(rig, LEGS)
    build_gait(rig, LEGS, rest, "walk", WALK)
    build_gait(rig, LEGS, rest, "trot", TROT)
    build_alert(rig, rest)

    rig.animation_data.action = None
    for act in sorted(bpy.data.actions, key=lambda a: a.name):
        t = rig.animation_data.nla_tracks.new()
        t.name = act.name
        t.strips.new(act.name, int(act.frame_start), act)
        t.is_solo = False

    trot = bpy.data.actions["trot"]
    frame_view(rig, [BUCK], clip="trot",
               clip_range=(int(trot.frame_start), int(trot.frame_end)))
    mats, imgs = purge(MESHES)
    print(f"[build] kept materials {mats} images {imgs}")

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "assets", "models", "deer_pack.blend")
    bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
    print(f"[build] saved {out} ({os.path.getsize(out)} bytes); clips "
          f"{sorted(a.name for a in bpy.data.actions)}; meshes "
          f"{[o.name for o in bpy.data.objects if o.type == 'MESH']}")


main()
