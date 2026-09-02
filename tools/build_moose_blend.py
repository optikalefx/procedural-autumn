"""Build the game's moose .blend from the bought pack, and save it.

    Blender -b assets/models/Animals_v3.0.blend --python tools/build_moose_blend.py

Writes `assets/models/moose_pack.blend`. Sixth mammal on this path; the shape of
it is `build_goat_blend.py` (one mesh, keep what the pack ships and solve the
rest) and the machinery is `pack_rig_kit.py`. Read the `add-new-animation-to-glb`
skill before changing anything here.

## One mesh: the BULL, and nothing else ships

The pack ships `Moose_01` (bull, 2682 tris, and the antlers are 2.069 units of
the 2.101-unit box), `Moose_Female_01` (cow, 1832 tris) and `Moose_Cub_01`
(calf, 1800). Only the bull is exported, and that is a decision rather than an
oversight (user: *"I want the moose with horns"*).

It is worth being precise about what the cow cost, because the arithmetic is the
argument. She shipped first as the COMMONER of two variants at weight 0.55, and
there are exactly **three** moose on the whole map — so the likely outcome was a
valley in which two of the three animals had no rack, and the perfectly possible
outcome was one in which none of them did. A variant weight is a distribution,
and a distribution over three samples is a coin toss. The antlers are the entire
reason this animal reads as a moose at 120 m rather than as a large dark deer.

`check_skeletons_match` still measures her and still prints the result, because
she is one line from being back: her armature is **identical** to the bull's —
same 32 bone names AND every bone head in the same place to four decimals, total
bone length ratio 1.000 — so re-parenting her onto his rig and letting
`variants[].hide` pick is the deer's trick and it works here. What it needs is a
reason, and "some moose are cows" is not one while there are three of them.

**The calf could not join even if it were wanted**, and it is the deer's fawn
again: same 32 bone names, 0.595 of the adult's total bone length, bone heads up
to 0.757 apart. A half-size rig; moving that mesh onto this skeleton stretches a
calf to bull proportions. Sharing a skeleton needs matching rest GEOMETRY and
names alone say it is fine.

## What is kept, and what is authored over the top

    Moose_Idle    320f -> idle    kept. Hind hooves dead still.
    Moose_Gesture 124f -> graze   kept, and it is a real graze: the muzzle drops
                                  1.624 -> 0.551 with all four hooves planted
                                  (duty 1.00/1.00/0.91/0.82, hoof travel
                                  <5 mm). Measured before it was given a slot —
                                  this pack's Gesture is a graze on the deer and
                                  the goat, a forage on the raccoon and a REAR
                                  on the bear, so which of graze/alert it can
                                  fill is per-animal.
    Moose_Run      18f -> run     kept, and it is the LEAP. Duty
                                  0.39/0.39/0.22/0.28 is an animal in the air,
                                  which is what a bound is; reading that as
                                  "badly planted" is what cost the deer a day
                                  and produced a worse animation.

    Moose_Walk     30f -> DROPPED, and solved from scratch. The measurement that
                                  decided it is on `KEEP` below, at length,
                                  because dropping a pack clip is a thing this
                                  repo has been wrong about twice.

    walk           28f            SOLVED here. Lateral sequence, duty 0.62.
    trot           13f            SOLVED here. Diagonal pairs, duty 0.45.
                                  Nothing in the pack has a trot — checked
                                  across all 233 actions.
    alert         120f            AUTHORED here. There is one Gesture per animal
                                  and it is the graze, so the alert has nowhere
                                  else to come from.

## The rig, surveyed rather than assumed

32 bones — one fewer than the deer's, and the missing one is in the NECK:
`spine.006 -> spine.007 -> scull` where the deer has `spine.006 -> spine.007 ->
spine.008 -> scull`. So the alert's chain is three bones and its shares are this
animal's, not the deer's copied across.

`front_shoulder.L/R` parent to `spine.005`, so the neck must start at
`spine.006` or the forelegs swing with the head — the deer's and the goat's
answer, and the opposite of the raccoon's. `shoulder.L/R` and `spine.002` are
siblings under `spine.003`, so the tail cannot disturb a hind leg.

Rest extension: **hind 0.735, fore 0.899**. Neither is in the 0.82-0.88 band
this work aims for and they miss it in opposite directions, which is a real fact
about a moose rather than a defect in the asset — the animal is built on long
straight forelegs and deeply folded hocks, and that is most of its silhouette.
The consequence for the solver is that the FORE leg binds the stride (it has
0.845 of reach limit against a 0.765 rest straight-line) and the hind has slack
it cannot spend, so `crouch` is worth more here than on any animal so far.
"""

import os
import sys

import bpy
from mathutils import Vector, Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pack_rig_kit import (                                        # noqa: E402
    open_animal, face_forward, point, clear, rx, rz, ease, key,
    new_action, sample, seam, set_linear, purge, frame_view, gait_rest,
    build_gait, LATERAL_WALK, DIAGONAL_TROT,
)

RIG = "Skeleton_Moose"
BULL, COW = "Moose_01", "Moose_Female_01"
# The bull alone. `COW` is named rather than deleted from this file because
# `check_skeletons_match` still measures her every build — see the header for
# why she does not ship and for what it would take to bring her back.
MESHES = [BULL]
HEAD = "scull"

# `Moose_Walk` is NOT here, and dropping a pack clip is a thing this repo has
# been wrong about twice, so the measurement is written out rather than asserted.
#
# Duty per hoof is 0.40 / 0.37 / **0.13** / 0.43, where a walk is DEFINED by a
# duty above 0.5 — but duty alone is not the argument, because the same reading
# on a RUN means the animal is airborne and the clip is a bound (which is what
# cost the deer a day). The argument is that there is no single ground speed in
# it. Measured through the game's own loader on the exported GLB, this clip
# reports a stride of **4.25 m** at 0.80 Hz — 3.29 m/s, on an animal 3.75 m long
# that trots at 5.0 and walks, in life, at about 1.4. `measureGround` takes the
# densest cluster of hoof velocities and on a clip with no stance the densest
# cluster is the SWING, which it then reports with total confidence.
#
# So the walk is solved here and the other three are the artist's. The deer and
# the goat both ship the pack's walk with the same shape of error at a quarter
# the size; at this size it is the difference between a walking moose and a
# moose skating at trotting pace.
KEEP = {"Moose_Idle": "idle", "Moose_Gesture": "graze", "Moose_Run": "run"}

# Model units to metres. The species file fits by the whole scene's bounding box
# and the bull's rest box is 2.101 units tall — the top of it is the ANTLER
# PALM, not the withers — so `glb.height` there is 4.50 and this is the same
# ratio, carried here only so the printed numbers are in the units a tape
# measure uses.
#
# At this fit the withers, at 1.405 units, stand at 3.01 m. That is half again
# the largest bull that has ever been measured and it is deliberate: the brief
# was "I want him to be taller then my car essentially", and the camper's roof
# is 1.87 m. See `mammals/moose.js`, which carries the whole table and says
# plainly that this animal is scaled to read rather than to be accurate.
FIT = 4.50 / 2.101

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

# The one solved gait, and the only clip here that has a speed in it.
#
# `frames` is CADENCE and it is the lever that was actually chosen: 13 frames at
# 24 fps is 1.85 Hz, against the deer's and the goat's 11 (2.18 Hz). A moose is
# twice a deer's height and big animals cycle slower — a trotting moose is a
# long, deliberate, high-stepping animal, and an 11-frame trot on this rig reads
# as a deer wearing antlers.
#
# `crouch` is worth more here than on any animal so far, and the rest extensions
# in the header say why: the fore leg rests at 0.899 of its own reach, so it
# binds the sweep long before the hind's 0.735 has spent anything. Lowering the
# body is what gives that leg somewhere to swing to.
# `lift` is the one number here that is about THIS animal rather than about its
# size. A moose picks its feet up — it lives in deadfall, willow scrub and
# snow, and the high-stepping foreleg is half of what the gait reads as. So both
# gaits carry a lift well above the proportional share of the deer's.
# 28 frames is 0.86 Hz, the slowest cadence in the cast by a distance, and it is
# the number that was actually tuned: the sweep is a FINDING (the largest the
# legs can carry, 0.760) and cadence is the only honest lever on speed. At 22
# frames the same stride made 1.91 m/s, which is a moose in a hurry. A horse
# walks at about one stride a second and a moose is bigger than a horse.
WALK = dict(flight=0.0, meshes=MESHES, frames=28, duty=0.62, lift=0.125,
            bob=0.011, crouch=0.075, scapula=13.0, phase=LATERAL_WALK)
TROT = dict(tuck=0.14, pitch=3.0, flight=0.030, meshes=MESHES, frames=13,
            duty=0.45, lift=0.135, bob=0.014, crouch=0.105, scapula=16.0,
            phase=DIAGONAL_TROT)

# ── the alert ────────────────────────────────────────────────────────────────
# A moose's alarm is not a deer's and it is not a goat's. It does not bolt and
# it does not flag: it raises its head — which on this animal is a metre of neck
# and a metre of antler going up — turns its ears, and looks at you. That is
# also the most legible thing it can do, which is the whole reason the pose
# exists: `noticeDist` is 120 m and a frozen animal has to read at 120 m.
#
# THREE neck bones, not the deer's four. `spine.008` is not on this rig and
# copying the deer's chain across would have thrown on a missing bone — which is
# the good failure. The shares are re-derived for a three-link chain rather than
# scaled from the deer's.
#
# Starts at `spine.006`: `front_shoulder` parents to `spine.005` on THIS rig, so
# a neck beginning any lower swings the forelegs. Surveyed, not inherited.
NECK = [("spine.006", 0.32, 0.26), ("spine.007", 0.34, 0.34), ("scull", 0.34, 0.40)]
# The tail lifts, but barely. A moose's tail is a 10 cm stub and there is no
# white-tail flag in it — 22 degrees where the deer gets 58, because the pose
# has to be honest at the range it is read from and nothing at 120 m sees this.
TAIL = [("spine.002", 0.52), ("spine.001", 0.30), ("spine", 0.18)]
EARS = ["ear.L", "ear.R"]
ALERT_FRAMES, ALERT_LIFT, ALERT_YAW, TAIL_DEG = 120, 22.0, 52.0, 22.0
ALERT_BONES = [n for n, _, _ in NECK] + [n for n, _ in TAIL] + EARS


def check_skeletons_match():
    """Assert the claim `unify_skeleton` is made on, before it is acted on.

    The deer's fawn passed a name check and failed this one. Printing the number
    rather than only asserting it is deliberate: if the vendor ships v3.1 with a
    re-rigged cow, the build should say so in the log rather than merely stop.
    """
    a = bpy.data.objects[RIG].data
    b = bpy.data.objects["Skeleton_Moose_Female"].data
    names_a = {x.name for x in a.bones}
    names_b = {x.name for x in b.bones}
    assert names_a == names_b, f"cow rig differs by {names_a ^ names_b}"
    d = max((a.bones[n].head_local - b.bones[n].head_local).length for n in names_a)
    ratio = sum(x.length for x in b.bones) / sum(x.length for x in a.bones)
    print(f"[build] cow rig: {len(names_a)} shared bones, max head delta {d:.4f}, "
          f"length ratio {ratio:.3f} — she COULD share this skeleton; she is not "
          f"exported, and the header says why")
    assert d < 1e-3 and abs(ratio - 1.0) < 1e-3, "the cow is not on the bull's skeleton"
    # And the calf, so the reason it is excluded is in the log rather than only
    # in a comment above.
    c = bpy.data.objects["Skeleton_Moose_Cub"].data
    dc = max((a.bones[n].head_local - c.bones[n].head_local).length for n in names_a)
    rc = sum(x.length for x in c.bones) / sum(x.length for x in a.bones)
    print(f"[build] calf rig: max head delta {dc:.4f}, length ratio {rc:.3f} "
          f"— excluded; it is a half-size rig wearing the same names")


def alert_scan(f):
    """Where the head is looking at frame `f`, -1..1.

    Longer holds than the deer's and a slower turn between them. A deer's scan
    is nervous; a moose's is a big animal taking its time about you.
    """
    moves = [(0, 22, 0.0, 0.0), (22, 34, 0.0, -1.0), (34, 58, -1.0, -1.0),
             (58, 72, -1.0, 1.0), (72, 96, 1.0, 1.0), (96, 108, 1.0, 0.0),
             (108, 120, 0.0, 0.0)]
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
        lift = ease(min(1.0, f / 12.0)) if f < 12 else 1.0
        for name, l_share, y_share in NECK:
            pb = rig.pose.bones[name]
            point(pb, rz(ALERT_YAW * y_share * yaw)
                  @ rx(-ALERT_LIFT * l_share * lift) @ (pb.tail - pb.head).normalized())
        for name, share in TAIL:
            pb = rig.pose.bones[name]
            point(pb, rx(TAIL_DEG * share * lift) @ (pb.tail - pb.head).normalized())
        for name in EARS:
            pb = rig.pose.bones[name]
            point(pb, rz(14.0 * yaw) @ (pb.tail - pb.head).normalized())
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
    # Tied to what the pose is FOR, and scaled to this animal: the head has to
    # come up far enough to read at 120 m, the tail has to move at all, and the
    # scan has to reach both sides.
    assert max(mz) > muzzle0.z + 0.04, "the head never comes up"
    assert max(tz) > tail0.z + 0.01, "the tail never comes up"
    assert min(xs) < -0.05 and max(xs) > 0.05, "the head does not look both ways"
    assert hoof < 1e-4, f"a hoof moved {hoof*1000:.3f} mm; alert must not"


def main():
    check_skeletons_match()
    rig = open_animal(RIG, MESHES, "Moose_")
    face_forward(rig, HEAD)

    for act in list(bpy.data.actions):
        if act.name in KEEP:
            act.name = KEEP[act.name]
            act.use_fake_user = True
            act.use_frame_range = True
        else:
            # Every `Moose_Cub_*` clip, and `Moose_Walk` — see KEEP.
            bpy.data.actions.remove(act, do_unlink=True)

    # `clear` FIRST. `open_animal` flips `pose_position` from REST to POSE, which
    # applies whatever stale pose the pack's bones happen to carry — and the box
    # measured through it is not the box the GLB ships. It reads 2.170 units
    # here against the rest pose's 2.101, which is a 3% error in `glb.height`
    # and 6 cm of shoulder, arrived at silently.
    clear(rig)
    for name in MESHES:
        ob = bpy.data.objects[name]
        bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
        h = max(p.z for p in bb) - min(p.z for p in bb)
        w = max(p.x for p in bb) - min(p.x for p in bb)
        print(f"[build] {name}: {h:.3f} u tall ({h*FIT:.3f} m), {w:.3f} u wide "
              f"({w*FIT:.3f} m), {max(p.y for p in bb)-min(p.y for p in bb):.3f} u long "
              f"({(max(p.y for p in bb)-min(p.y for p in bb))*FIT:.3f} m)")
    for b in ("spine.005", "spine.003"):
        print(f"[build] {b} z {rig.pose.bones[b].head.z:.3f} u = "
              f"{rig.pose.bones[b].head.z*FIT:.3f} m shipped")

    rest = gait_rest(rig, LEGS)
    for k, L in LEGS.items():
        R = rest[k]
        print(f"[rest] {k[0]}.{k[1]} l1 {R['l1']:.3f} l2 {R['l2']:.3f} "
              f"reach(safe) {R['reach']:.3f} hip z {R['hip'].z:.3f}")
    # `walk` and `trot` are solved; `idle`, `graze` and `run` are the pack's and
    # are kept as shipped — see KEEP above, which carries the measurement that
    # decided the walk. `new_action` deletes any action of the same name, so
    # solving "run" here would silently clobber the artist's leap with a worse
    # one, which has happened on another animal and cost a day.
    build_gait(rig, LEGS, rest, "walk", WALK, unit_m=FIT)
    build_gait(rig, LEGS, rest, "trot", TROT, unit_m=FIT)
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
    out = os.path.join(root, "assets", "models", "moose_pack.blend")
    bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
    print(f"[build] saved {out} ({os.path.getsize(out)} bytes); clips "
          f"{sorted(a.name for a in bpy.data.actions)}; meshes "
          f"{[o.name for o in bpy.data.objects if o.type == 'MESH']}")


main()
