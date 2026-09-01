"""Build the game's raccoon .blend from the bought pack, and SAVE it.

    Blender -b assets/models/Animals_v3.0.blend --python tools/build_raccoon_blend.py

Writes `assets/models/raccoon_pack.blend`: the pack's raccoon, isolated, turned
to face +Y, with the four clips it ships renamed to the game's slots and the two
it does not ship SOLVED onto its rig.

Two stages, the same split `build_bear_reference.py` and `export_bear_glb.py`
already use. This is the slow one — it solves gaits and validates them — and it
runs when the animal changes. `export_raccoon_glb.py` reads the .blend this
writes and is fast.

**The 103 MB pack is never written to.** It is licensed third-party source kept
out of the repo, so it stays exactly as downloaded and can be re-derived if the
vendor ships a new version. The working .blend this produces is small, is the
file to open and scrub, and is where hand-tweaks belong.

## What the pack ships and what it does not

    Raccoon_Idle     289f  -> idle
    Raccoon_Walk      19f  -> walk       duty 0.53/0.47/0.47/0.53, a real walk
    Raccoon_Run       15f  -> run        duty 0.40/0.33/0.20/0.27
    Raccoon_Gesture  110f  -> graze      rears up and works its front paws

`Gesture` becoming the graze is the one substantive remapping. It is not a
compromise: `raccoon.js` says "nose down almost all the time — foraging IS the
raccoon pose" and sets `grazeChance: 0.70`, and this clip lifts the fore toes to
z=0.114 while the hind feet stay planted and the muzzle drops below its idle
range. That is a raccoon foraging, which is the pose the species file is asking
for.

Missing, and solved below: **trot** and **alert**.

## This rig is not the deer's

Written out because the deer solvers hardcode the deer's shape and this one
would silently mis-solve:

* **The fore leg has no `foot` bone.** It is
  `front_shoulder -> front_thigh -> front_shin -> front_toe`, four bones, where
  the hind has five. So the two-link IK targets a different bone per pair and
  each foot keeps its own standing height (hind toe 0.0442, fore toe 0.0081).
* **Rest extension is 0.657 hind / 0.705 fore** — far bendier than the pack
  deer's 0.843, so there is real stride to be had here. A leg with bend in it
  has stride in it.
* Fore still caps the shared sweep, at 0.335 model units against the hind's
  0.417. Every hoof of a gait travels the same ground or they scrub.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pack_rig_kit import (                                        # noqa: E402
    open_animal, face_forward, point, clear, rx, rz, purge, frame_view,
    ease, key, new_action, sample, seam, gait_rest, build_gait,
    LATERAL_WALK, DIAGONAL_TROT, BOUND,
)

RIG = "Skeleton_Raccoon"
MESH = ["Raccoon_01"]
HEAD = "scull"

# Only the two the game uses as shipped. The pack's Walk and Run are dropped and
# solved instead — not because they are bad (this walk measures duty 0.47-0.53
# and is a genuine walk, unlike the deer's 0.25/0.30/0.23/0.10) but because
# `measure: 'contact'` is a claim about EVERY moving clip. One solved gait beside
# two inherited ones means the claim does not hold, and the species falls back to
# excursion, which underreports by the duty factor.
RENAME = {"Raccoon_Idle": "idle", "Raccoon_Gesture": "graze"}

# One entry per leg: the scapula, the two IK links, the bone the IK places, and
# the bones below it that must be re-aimed so the paw stays flat.
LEGS = {
    ("hind", "L"): dict(scap="shoulder.L", a="thigh.L", b="shin.L",
                        target="foot.L", below=["foot.L", "toe.L"], contact="toe.L"),
    ("hind", "R"): dict(scap="shoulder.R", a="thigh.R", b="shin.R",
                        target="foot.R", below=["foot.R", "toe.R"], contact="toe.R"),
    ("fore", "L"): dict(scap="front_shoulder.L", a="front_thigh.L", b="front_shin.L",
                        target="front_toe.L", below=["front_toe.L"], contact="front_toe.L"),
    ("fore", "R"): dict(scap="front_shoulder.R", a="front_thigh.R", b="front_shin.R",
                        target="front_toe.R", below=["front_toe.R"], contact="front_toe.R"),
}

WALK = dict(meshes=MESH, frames=14, duty=0.60, lift=0.040, bob=0.006, crouch=0.030,
            scapula=11.0, phase=LATERAL_WALK)
TROT = dict(meshes=MESH, frames=9, duty=0.45, lift=0.055, bob=0.008, crouch=0.045,
            scapula=13.0, phase=DIAGONAL_TROT)
# A raccoon flees in a bounding lope rather than a flat gallop, and duty is what
# makes that quick: the same reach spent in a fifth of the cycle covers roughly
# three times the ground per cycle a walk's duty does. See the skill.
RUN = dict(meshes=MESH, frames=7, duty=0.22, lift=0.090, bob=0.014, crouch=0.060,
           scapula=16.0, phase=BOUND)

ALERT_FRAMES = 96       # 4.0 s, looping
ALERT_LIFT = 22.0
ALERT_YAW = 62.0


# ── alert ────────────────────────────────────────────────────────────────────
# A raccoon's alarm is not a deer's. There is no white tail to flag, and
# `graze` already owns rearing onto the haunches, so this is the other thing it
# does: drop low, freeze, and turn the head. Stiffness is in the TIMING — snaps
# separated by long holds. Authored as a smooth sweep the identical pose range
# reads as merely curious.
# Starts at spine.008, NOT spine.007, and that is a survey result rather than a
# style choice: on this rig `front_shoulder` parents to **spine.007**, so
# including it in the neck swings the forelegs and moved the paws 44 mm. The
# deer's neck starts lower because its forelegs hang off spine.005. Carrying one
# animal's hierarchy to another is exactly what the assertion below is for.
NECK = [("spine.008", 0.30, 0.28), ("spine.009", 0.34, 0.34),
        ("scull", 0.36, 0.38)]
EARS = ["ear.L", "ear.R"]
ALERT_BONES = [n for n, _, _ in NECK] + EARS


def alert_scan(f):
    moves = [(0, 14, 0.0, 0.0), (14, 22, 0.0, -1.0), (22, 42, -1.0, -1.0),
             (42, 52, -1.0, 1.0), (52, 72, 1.0, 1.0), (72, 80, 1.0, 0.0),
             (80, 96, 0.0, 0.0)]
    for a, b, u, v in moves:
        if a <= f <= b:
            return u + (v - u) * ease(0.0 if b == a else (f - a) / (b - a))
    return 0.0


def alert_pose(rig, f):
    clear(rig)
    yaw = alert_scan(f)
    lift = ease(min(1.0, f / 8.0)) if f < 8 else 1.0
    for name, l_share, y_share in NECK:
        pb = rig.pose.bones[name]
        point(pb, rz(ALERT_YAW * y_share * yaw)
              @ rx(-ALERT_LIFT * l_share * lift) @ (pb.tail - pb.head).normalized())
    for name in EARS:
        pb = rig.pose.bones[name]
        point(pb, rz(14.0 * yaw) @ (pb.tail - pb.head).normalized())


def build_alert(rig, rest):
    clear(rig)
    muzzle0 = rig.pose.bones[HEAD].tail.copy()
    act = new_action(rig, "alert", ALERT_FRAMES)
    for i in range(ALERT_FRAMES + 1):
        alert_pose(rig, i % ALERT_FRAMES)
        key(rig, ALERT_BONES, 1 + i)
    rig.animation_data.action = None
    clear(rig)

    mz, xs, paw = [], [], 0.0
    for i in range(ALERT_FRAMES + 1):
        sample(rig, act, 1 + i)
        mz.append(rig.pose.bones[HEAD].tail.z)
        xs.append(rig.pose.bones[HEAD].tail.x)
        for k, L in LEGS.items():
            paw = max(paw, (rig.pose.bones[L["contact"]].head - rest[k]["contact"]).length)
    s = seam(rig, act, ALERT_FRAMES)
    rig.animation_data.action = None
    clear(rig)
    print(f"[alert] muzzle z {muzzle0.z:.3f} -> {max(mz):.3f} "
          f"(+{max(mz)-muzzle0.z:.3f}); scan x {min(xs):+.3f}..{max(xs):+.3f}")
    print(f"[alert]   paw movement  {paw*1000:7.3f} mm")
    print(f"[alert]   cycle seam    {s*1000:7.3f} mm")
    assert max(mz) > muzzle0.z + 0.02, "the head never comes up"
    assert min(xs) < -0.02 and max(xs) > 0.02, "the head does not look both ways"
    # The alert touches nothing below spine.007, so the paws cannot move by
    # construction. Asserted anyway: "by construction" is a claim about code.
    assert paw < 1e-4, f"a paw moved {paw*1000:.3f} mm; alert must not move the feet"


def main():
    rig = open_animal(RIG, MESH, "Raccoon_")
    face_forward(rig, HEAD)
    for act in list(bpy.data.actions):
        if act.name in RENAME:
            act.name = RENAME[act.name]
            act.use_fake_user = True
            act.use_frame_range = True
        else:
            bpy.data.actions.remove(act, do_unlink=True)

    mesh = bpy.data.objects[MESH[0]]
    bb = [mesh.matrix_world @ Vector(c) for c in mesh.bound_box]
    height = max(p.z for p in bb) - min(p.z for p in bb)
    print(f"[build] raccoon {height:.3f} units tall, authored at 1 unit = 1 m")

    rest = gait_rest(rig, LEGS)
    for name, spec in (("walk", WALK), ("trot", TROT), ("run", RUN)):
        build_gait(rig, LEGS, rest, name, spec)
    build_alert(rig, rest)

    # Lay every clip out as a soloable NLA track, the way the pack lays itself
    # out, so the saved file is consistent with the source and can be scrubbed.
    rig.animation_data.action = None
    for act in sorted(bpy.data.actions, key=lambda a: a.name):
        track = rig.animation_data.nla_tracks.new()
        track.name = act.name
        track.strips.new(act.name, int(act.frame_start), act)
        track.is_solo = False

    # Opens framed on the animal, in Material shading, with the trot soloed —
    # the clip this file exists to let you judge.
    trot = bpy.data.actions["trot"]
    frame_view(rig, MESH, clip="trot",
               clip_range=(int(trot.frame_start), int(trot.frame_end)))

    mats, imgs = purge(MESH)
    print(f"[build] kept materials {mats} and images {imgs}")

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "assets", "models", "raccoon_pack.blend")
    bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
    print(f"[build] saved {out} ({os.path.getsize(out)} bytes); clips: "
          f"{sorted(a.name for a in bpy.data.actions)}")


main()
