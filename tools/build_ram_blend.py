"""Build the game's ram .blend from the bought pack, and save it.

    Blender -b assets/models/Animals_v3.0.blend --python tools/build_ram_blend.py

Writes `assets/models/ram_pack.blend`. The shape of it is
`build_deer_blend.py` and the machinery is `pack_rig_kit.py`.

The ram replaces the procedural yak as the second alpine species. Same country,
same `rock` block, a much smaller animal — see `mammals/ram.js`.

## One mesh, and that is a measurement

The pack ships `Ram_01` and `Ram_02`, both already parented to `Skeleton_Ram`,
and they are **bit-identical**: 1377 vertices each, max local vertex delta
0.000000, the same 33 vertex groups, the same single `Color` material. `Ram_02`
is a duplicate the demo scene stands 0.996 m to the side, not a variant.

So there is no buck/doe trick to play here — the deer got two silhouettes off
one skeleton because its two meshes genuinely differed. Shipping both would be
2726 triangles and a second draw call for a copy of the same animal. `Ram_01`
alone goes in the GLB and the coats are scale variants; the material is one
textured palette, so they carry no colour of their own (the deer's file has the
same note for the same reason).

## What is kept, and what is solved over the top

    Ram_Idle     115f  -> idle    kept
    Ram_Walk      31f  -> walk    kept — duty 0.57 on all four hooves
    Ram_Gesture  131f  -> graze   kept; a real graze, muzzle 1.297 -> 0.259
    trot          --   -> SOLVED here. No animal in the pack has a trot.
    run           --   -> SOLVED here, to the GOAT's measured leap. See below.
    alert         --   -> authored here.

    Ram_Run       14f  -> DROPPED

## The one clip that had to go, and the number that says so

**Start by assuming the artist's clip is right**, and keep it wherever it can be
read: `Ram_Walk` is the best walk in this pack (duty 0.57 on every hoof, where a
walk is DEFINED by duty above 0.5 — the raccoon's is 0.47-0.53 and the deer's
0.25/0.30/0.23/0.10) and it is kept exactly as shipped.

`Ram_Run` is not kept, and the reason is not its duty. An airborne duty is what
a bound IS, and reading 0.38/0.23/0.23/0.23 as "badly planted" is the mistake
that cost a day on the deer. The reason is that **the clip has no single ground
speed in it at all**. Run `glb_rig.measureGround`'s arithmetic over it and each
hoof implies a different body speed:

    hoof        duty    stance velocity (u/s)   ground per cycle (u)
    toeL        0.35    0.63 .. 3.88 .. 4.59    0.79
    toeR        0.16    3.01 .. 3.57 .. 8.17    0.34
    front_toeL  0.22    0.00 .. 1.92 .. 9.31    0.24
    front_toeR  0.31    0.00 .. 5.14 .. 5.72    0.93

A factor of four between the fore left and the fore right. And because both fore
hooves dwell at a velocity of zero inside their own stance, the densest cluster
in the pooled distribution is **at 0.0000 u/s, over 14% of the samples** — so
`loadGlbSpecies` throws the clip out at boot with "moved none of the feet named
in glb.feet backwards". That is measured on the exported GLB by
`tools/_scratch/ramground.mjs`, not inferred.

There is nothing to keep. A solved bound goes in instead.
"""

import os
import sys

import bpy
from mathutils import Vector, Quaternion

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pack_rig_kit import (                                        # noqa: E402
    open_animal, face_forward, point, clear, rx, rz, ease, key,
    new_action, sample, seam, set_linear, purge, frame_view, gait_rest,
    build_gait, DIAGONAL_TROT,
)

RIG = "Skeleton_Ram"
RAM = "Ram_01"
MESHES = [RAM]
# `Ram_02` is deliberately NOT here. It is not a variant: max local vertex delta
# against `Ram_01` is 0.000000 over all 1377 vertices, the vertex groups match
# name for name, and both already ride `Skeleton_Ram`. It is the demo scene's
# second copy, standing 0.996 m to the side.
HEAD = "scull"
ROOT = "Root"
# The run is retargeted off this, not solved — see the block above it.
GOAT_RIG, GOAT_CLIP = "Skeleton_Goat", "Goat_Run"
CONTACTS = ["toe.L", "toe.R", "front_toe.L", "front_toe.R"]

# `Ram_Run` is deliberately absent — see the header. Everything not named here
# is deleted before anything is solved, which also means `new_action("run")`
# below cannot silently clobber a clip somebody decided to keep.
KEEP = {"Ram_Idle": "idle", "Ram_Walk": "walk", "Ram_Gesture": "graze"}

# The same 33-bone rig the pack gives the deer, name for name — `front_shoulder`
# hangs off `spine.005` and the hind `shoulder` off `spine.003`, so the neck
# chain has to start at `spine.006` or lifting the head drags the forelegs.
# Surveyed rather than assumed; it differs per animal in this pack (the
# raccoon's neck has to start at `spine.008`).
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

SPINE = [("spine.004", 0.42), ("spine.005", 0.34), ("spine.003", 0.24)]

# The trot, and the only gait authored here. Diagonal pairs, each hoof given a
# path over the ground and the leg solved to reach it.
#
# Cadence and crouch are the two levers. 11 frames at 24 fps is 2.18 Hz, which
# is a trotting sheep's stride rate; the crouch buys the stride, and 6 cm on a
# 1.10 m withers is not visible and is most of the gap. `flight` is small — a
# trot has only the brief suspension at each diagonal handover, not a bound's
# sail — and `pitch` smaller still, because a trotting animal's back is level
# and that levelness is half of what says "trot" rather than "canter".
TROT = dict(tuck=0.12, pitch=3.0, flight=0.030, meshes=MESHES, frames=11,
            duty=0.45, lift=0.090, bob=0.013, crouch=0.062, scapula=17.0,
            phase=DIAGONAL_TROT)

# ── the run: the goat's leap, RETARGETED ─────────────────────────────────────
#
# Not solved. `Goat_Run` is the pack's own bound, it is the one gait in this
# game that reads correctly, and the ram is given THAT MOTION rather than a
# procedural imitation of it.
#
# Two earlier attempts were both solved by `build_gait`, and both read stiff:
# legs stayed extended where a bound folds them. The reason is structural — a
# gait spec is six scalars (duty, lift, flight, pitch, crouch, tuck) and an
# animator's curves are not six scalars. Measuring the goat's leap and feeding
# the numbers back in gets the cadence right and the shape wrong.
#
# ## Why the curves cannot simply be copied
#
# The two rigs share all 33 of the ram's bone names and the same topology, so a
# straight copy of `Goat_Run`'s fcurves is the obvious move and it is wrong: a
# Blender action stores each bone's rotation RELATIVE TO ITS OWN REST POSE, and
# these two rests are not the same. Measured, the shared bones' rest
# orientations differ by a median of 10.1 degrees, by 20.6 at the shins and by
# 54.3 at `spine.006`. The same numbers on a differently-oriented rest bone make
# a different pose.
#
# ## What is copied instead
#
# The rest-RELATIVE world rotation, which is the thing that is actually the
# animation. Per frame, per bone:
#
#     delta      = goat_posed_world_rotation @ goat_rest_world_rotation^-1
#     ram_target = delta @ ram_rest_world_rotation
#
# Rest differences cancel: whatever the goat's shin does relative to where its
# shin starts, the ram's shin does relative to where its shin starts. The bones
# are then walked parent-first and each one's local basis solved from its
# parent's already-known world rotation, so nothing depends on Blender's
# evaluation order and no depsgraph round-trip is needed.
#
# ## The two things that do NOT transfer, and are handled
#
# * **`Root`.** Its rest-relative delta is a constant 180 degrees — the pack's
#   own facing convention, not motion. Applying it would turn the ram around
#   and it would bound tail-first, which is exactly the fault `face_forward`
#   exists to prevent and which no downstream measurement can catch (see
#   `pack_rig_kit`'s header). `Root` is excluded and keeps the ram's rest.
# * **Ground height.** The ram's legs are longer than the goat's (hind reach
#   0.5517 against 0.4897) so the same joint angles put its hooves elsewhere:
#   retargeted raw, the lowest hoof of the cycle sits at +0.0433 where this
#   rig's rest contact is +0.1205. The whole body is therefore raised by one
#   constant offset so the deepest planted hoof meets the same ground plane the
#   solved walk and trot were solved against. A uniform translation of the body
#   is placement, not posing — it changes where the animal is, not what it does.
#
# What this is NOT: the pack's `Ram_Run` edited. That clip is untouched and
# unused (see the header). This is a new clip on the ram's rig carrying the
# goat's authored motion, rebuilt from the pack by this script every time.

# ── the alert ────────────────────────────────────────────────────────────────
#
# Head up, ears forward, dead still, and a stiff scan to each side. Starts at
# `spine.006` for the reason in the LEGS note above.
#
# A ram is not a white-tail and the tail is not the tell. `Ram_01`'s tail is
# three short bones totalling 0.234 units — a sheep's stub — so the flag that
# carries a deer's alert past 60 m is simply not on this animal. What carries
# instead is the HEAD: a curl-horned skull raised and turned broadside is a
# heavy, unmistakable shape, so the lift is bigger than the deer's (34 deg
# against 26) and the scan wider (84 deg against 70). The tail still cocks,
# because a startled sheep does cock it, but it is worth nothing at range and
# the assertions below say so.
NECK = [("spine.006", 0.24, 0.16), ("spine.007", 0.26, 0.24),
        ("spine.008", 0.24, 0.28), ("scull", 0.26, 0.32)]
TAIL = [("spine.002", 0.52), ("spine.001", 0.30), ("spine", 0.18)]
EARS = ["ear.L", "ear.R"]
ALERT_FRAMES, ALERT_LIFT, ALERT_YAW, TAIL_DEG = 120, 34.0, 84.0, 46.0
ALERT_BONES = [n for n, _, _ in NECK] + [n for n, _ in TAIL] + EARS


def alert_scan(f):
    """Fast turns separated by long freezes.

    "Stiff" is a property of the schedule, not of the angles: the same pose
    range driven as a sine wave reads as grazing-curious. A frightened animal
    snaps to a heading and holds it, so the holds are the whole tell — 24 frames
    of stillness at each end against 9-11 frames of movement between them.
    """
    moves = [(0, 18, 0.0, 0.0), (18, 27, 0.0, -1.0), (27, 51, -1.0, -1.0),
             (51, 62, -1.0, 1.0), (62, 86, 1.0, 1.0), (86, 96, 1.0, 0.0),
             (96, 120, 0.0, 0.0)]
    for a, b, u, v in moves:
        if a <= f <= b:
            return u + (v - u) * ease(0.0 if b == a else (f - a) / (b - a))
    return 0.0


def sample_goat_leap():
    """`Goat_Run` as rest-relative world rotations, one dict per frame.

    Read BEFORE `open_animal` isolates the ram, because that deletes every other
    object in the file. Plain quaternions come back, so nothing here depends on
    the goat surviving.
    """
    goat = bpy.data.objects[GOAT_RIG]
    goat.data.pose_position = 'POSE'          # the pack ships every rig in REST
    if goat.animation_data:
        for t in goat.animation_data.nla_tracks:
            t.is_solo = False                 # ...with Idle SOLOED over everything
    act = bpy.data.actions[GOAT_CLIP]
    goat.animation_data_create()
    goat.animation_data.action = act
    for slot in act.slots:
        goat.animation_data.action_slot = slot
        break

    f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
    rest = {b.name: b.matrix_local.to_quaternion() for b in goat.data.bones}
    dep = bpy.context.evaluated_depsgraph_get()
    out = []
    for f in range(f0, f1):                   # f1 repeats f0: drop it, we loop
        bpy.context.scene.frame_set(f)
        dep.update()
        out.append({n: goat.pose.bones[n].matrix.to_quaternion() @ rest[n].inverted()
                    for n in rest})
    print(f"[run] sampled {GOAT_CLIP}: {len(out)} frames of {len(rest)} bones")
    return out


def retarget_run(rig, delta, name="run"):
    """Put the goat's leap on the ram's skeleton. See the block above."""
    bones = {b.name: b for b in rig.data.bones}
    rest = {n: b.matrix_local.to_quaternion() for n, b in bones.items()}

    order, seen = [], set()
    def visit(b):
        if b.name in seen:
            return
        if b.parent:
            visit(b.parent)
        seen.add(b.name)
        order.append(b.name)
    for b in bones.values():
        visit(b)

    def rest_local(n):
        b = bones[n]
        if b.parent:
            return (b.parent.matrix_local.inverted() @ b.matrix_local).to_quaternion()
        return b.matrix_local.to_quaternion()

    missing = sorted(n for n in bones if n not in delta[0])
    assert not missing, f"the goat's clip does not animate {missing}"
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'

    def pose(d):
        world = {}
        for n in order:
            world[n] = rest[n] if n == ROOT else d[n] @ rest[n]
        for n in order:
            b = bones[n]
            parent = world[b.parent.name] if b.parent else Quaternion((1, 0, 0, 0))
            rig.pose.bones[n].rotation_quaternion = (
                (parent @ rest_local(n)).inverted() @ world[n])
        bpy.context.view_layer.update()

    # The lift, measured on the retargeted pose rather than assumed: how far the
    # body must rise for the deepest planted hoof to meet the rest ground plane.
    floor = min(bones[c].head_local.z for c in CONTACTS)
    low = None
    for d in delta:
        pose(d)
        z = min(rig.pose.bones[c].head.z for c in CONTACTS)
        low = z if low is None else min(low, z)
    lift = floor - low
    print(f"[run] retargeted: lowest hoof {low:+.4f}, rest contact {floor:+.4f}, "
          f"raising the body {lift:+.4f}")

    # `Root`'s location is in ITS OWN bone space — a bone's local Y runs along
    # the bone — so a world-Z lift has to be rotated into that basis first.
    # Assigning it to `.location.z` raises the animal along whatever direction
    # the root happens to point, which here was not up at all.
    root_lift = rest[ROOT].inverted() @ Vector((0.0, 0.0, lift))

    act = new_action(rig, name, len(delta))
    for i in range(len(delta) + 1):
        pose(delta[i % len(delta)])
        rig.pose.bones[ROOT].location = root_lift
        key(rig, order, i, loc={ROOT})
    set_linear(act)
    rig.animation_data.action = None
    clear(rig)

    # What the game will read off it: ground covered by a planted hoof.
    lows = []
    for i in range(len(delta)):
        sample(rig, act, i)
        lows.append({c: (rig.pose.bones[c].head.z, rig.pose.bones[c].head.y)
                     for c in CONTACTS})
    for c in CONTACTS:
        zs = [f[c][0] for f in lows]
        lo, hi = min(zs), max(zs)
        band = lo + 0.12 * (hi - lo)
        down = [i for i, z in enumerate(zs) if z <= band]
        ys = [lows[i][c][1] for i in down]
        print(f"[run]   {c:14s} z {lo:.4f}..{hi:.4f} lift {hi-lo:.4f}  "
              f"duty {len(down)/len(zs):.2f}  stance sweep {max(ys)-min(ys):.4f}")
    return act


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
    print(f"[alert] muzzle z {muzzle0.z:.3f} -> {max(mz):.3f} (+{max(mz)-muzzle0.z:.3f}); "
          f"tail z {tail0.z:.3f} -> {max(tz):.3f} (+{max(tz)-tail0.z:.3f}); "
          f"scan x {min(xs):+.3f}..{max(xs):+.3f}")
    print(f"[alert]   hoof movement {hoof*1000:7.3f} mm    cycle seam {s*1000:7.3f} mm")
    assert max(mz) > muzzle0.z + 0.03, "the head never comes up"
    # A stub tail, so the bar is a third of the deer's. It still has to move.
    assert max(tz) > tail0.z + 0.015, "the tail never comes up"
    assert min(xs) < -0.04 and max(xs) > 0.04, "the head does not look both ways"
    assert hoof < 1e-4, f"a hoof moved {hoof*1000:.3f} mm; alert must not"


def main():
    leap = sample_goat_leap()      # BEFORE open_animal deletes the goat
    rig = open_animal(RIG, MESHES, "Ram_")
    face_forward(rig, HEAD)

    for act in list(bpy.data.actions):
        if act.name in KEEP:
            act.name = KEEP[act.name]
            act.use_fake_user = True
            act.use_frame_range = True
        else:
            bpy.data.actions.remove(act, do_unlink=True)

    ob = bpy.data.objects[RAM]
    bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    lo, hi = min(p.z for p in bb), max(p.z for p in bb)
    clear(rig)
    withers = rig.pose.bones["front_shoulder.L"].head.z
    print(f"[build] {RAM} {hi - lo:.4f} units tall (z {lo:.4f}..{hi:.4f}); "
          f"withers {withers:.4f}; a 0.95 m ram wants glb.height "
          f"{(hi - lo) * 0.95 / withers:.3f}")

    rest = gait_rest(rig, LEGS)
    for k, L in LEGS.items():
        R = rest[k]
        print(f"[rest] {k[0]}.{k[1]:1s} l1 {R['l1']:.4f} l2 {R['l2']:.4f} "
              f"reach {R['reach']:.4f} hip z {R['hip'].z:.4f} "
              f"ankle z {R['target'].z:.4f} hoof z {R['contact'].z:.4f} "
              f"extension {(R['target'] - R['hip']).length / (R['l1'] + R['l2']):.3f}")

    # The walk, the idle and the graze are the artist's and are not touched.
    # `new_action` deletes any action of the same name, so solving "walk" here
    # would silently clobber the clip that was decided on above.
    build_gait(rig, LEGS, rest, "trot", TROT)
    retarget_run(rig, leap)
    build_alert(rig, rest)

    rig.animation_data.action = None
    for act in sorted(bpy.data.actions, key=lambda a: a.name):
        t = rig.animation_data.nla_tracks.new()
        t.name = act.name
        t.strips.new(act.name, int(act.frame_start), act)
        t.is_solo = False

    trot = bpy.data.actions["trot"]
    frame_view(rig, MESHES, clip="trot",
               clip_range=(int(trot.frame_start), int(trot.frame_end)))
    mats, imgs = purge(MESHES)
    print(f"[build] kept materials {mats} images {imgs}")

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "assets", "models", "ram_pack.blend")
    bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
    print(f"[build] saved {out} ({os.path.getsize(out)} bytes); clips "
          f"{sorted(a.name for a in bpy.data.actions)}; meshes "
          f"{[o.name for o in bpy.data.objects if o.type == 'MESH']}")


main()
