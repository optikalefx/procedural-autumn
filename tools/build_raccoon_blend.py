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
    open_animal, face_forward, play, point, clear, ik2, reach_limit, rx, rz, purge, frame_view,
    ease, key, new_action, sample, seam, local_translation,
)

RIG = "Skeleton_Raccoon"
MESH = ["Raccoon_01"]
HEAD = "scull"

RENAME = {"Raccoon_Idle": "idle", "Raccoon_Walk": "walk",
          "Raccoon_Run": "run", "Raccoon_Gesture": "graze"}

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

# Diagonal pairs — the definition of a trot, not a tuning value.
PHASE = {("hind", "L"): 0.0, ("fore", "R"): 0.0,
         ("hind", "R"): 0.5, ("fore", "L"): 0.5}

TROT_FRAMES = 9         # 0.375 s at 24 fps -> 2.67 Hz, a real trotting cadence
TROT_DUTY = 0.45        # below 0.5 by definition; a trot has suspension
TROT_LIFT = 0.055
TROT_BOB = 0.008
TROT_CROUCH = 0.035     # metres the body sits below standing height
SCAPULA_DEG = 12.0
SAFETY = 0.955          # of reach_limit; a leg at 1.0 is a locked leg
PROBE = 64              # reach is a property of the geometry, not of the keying

ALERT_FRAMES = 96       # 4.0 s, looping
ALERT_LIFT = 22.0
ALERT_YAW = 62.0

TROT_BONES = ["Root"] + [n for L in LEGS.values()
                         for n in ([L["scap"], L["a"], L["b"]] + L["below"])]


def rest_frame(rig):
    clear(rig)
    d = {}
    for k, L in LEGS.items():
        a = rig.pose.bones[L["a"]].head.copy()
        b = rig.pose.bones[L["b"]].head.copy()
        t = rig.pose.bones[L["target"]].head.copy()
        u = (t - a).normalized()
        knee = b - a
        perp = knee - u * knee.dot(u)
        d[k] = dict(
            target=t, l1=(b - a).length, l2=(t - b).length,
            reach=reach_limit((b - a).length, (t - b).length) * SAFETY,
            bend=(perp.normalized() if perp.length > 1e-5 else Vector((0, -1, 0))),
            scap_dir=(rig.pose.bones[L["scap"]].tail
                      - rig.pose.bones[L["scap"]].head).normalized(),
            below_dirs=[(rig.pose.bones[n].tail - rig.pose.bones[n].head).normalized()
                        for n in L["below"]],
            contact=rig.pose.bones[L["contact"]].head.copy(),
        )
    d["muzzle"] = rig.pose.bones[HEAD].tail.copy()
    return d


def foot_at(rest_target, phase, t, sweep):
    """Where this paw is at cycle position `t`.

    The animal faces -Y in the .blend, so a PLANTED paw travels toward +Y: it
    lands forward at -half and is driven back under the body to +half.
    """
    half = sweep * 0.5
    k = (t + phase) % 1.0
    if k < TROT_DUTY:
        u = k / TROT_DUTY
        return Vector((rest_target.x, rest_target.y - half + sweep * u,
                       rest_target.z)), True
    v = (k - TROT_DUTY) / (1.0 - TROT_DUTY)
    return Vector((rest_target.x, rest_target.y + half - sweep * v,
                   rest_target.z + TROT_LIFT * math.sin(math.pi * v))), False


def trot_pose(rig, rest, t, sweep):
    """One instant of the trot. Returns the worst load on a WEIGHTED leg."""
    clear(rig)
    # Crouch, then bob about it. The crouch is the stride lever on this animal:
    # measured on the two IK links alone the fore leg stands at 0.94 of its own
    # reach limit, so at standing height there is almost nothing left to swing
    # with. Dropping the body buys bend, and bend is stride. A trotting raccoon
    # is low-slung anyway, so this costs nothing in the read.
    root = rig.pose.bones["Root"]
    dz = -TROT_CROUCH + math.sin(t * math.tau * 2.0) * TROT_BOB
    root.location = local_translation(root, (0.0, 0.0, dz))

    worst = 0.0
    for k, L in LEGS.items():
        R = rest[k]
        goal, planted = foot_at(R["target"], PHASE[k], t, sweep)

        # The scapula swings in phase with its own paw. This is where most of a
        # quadruped's stride comes from: it carries the hip fore-and-aft rather
        # than asking the two links below to reach further than they can.
        # `lead` is +0.5 with the paw at its most forward and -0.5 at its most
        # rearward. The sign was checked by measurement rather than reasoned:
        # inverting it drops the solved sweep from 0.127 to 0.036, so this is
        # the direction that carries the hip toward its own paw.
        lead = (R["target"].y - goal.y) / max(sweep, 1e-6)
        point(rig.pose.bones[L["scap"]], rx(-SCAPULA_DEG * lead) @ R["scap_dir"])

        a = rig.pose.bones[L["a"]]
        if planted:
            worst = max(worst, (goal - a.head).length / R["reach"])
        knee = ik2(a.head.copy(), goal, R["l1"], R["l2"], R["bend"])
        point(a, knee - a.head)
        point(rig.pose.bones[L["b"]], goal - rig.pose.bones[L["b"]].head)
        # Keep the paw flat: everything below inherits the shin's rotation, so
        # it is re-aimed at the world direction it holds while standing.
        for n, d in zip(L["below"], R["below_dirs"]):
            point(rig.pose.bones[n], d)
    return worst


def solve_sweep(rig, rest):
    """Largest sweep no weighted leg has to clamp for, anywhere in the cycle.

    Probed at a fixed PROBE resolution rather than at the keyframes. Sampling
    the reach check at the frame count made the answer depend on it — the same
    rig reported 0.593 at 8 frames and 0.524 at 10 — because a coarse cycle
    never lands on the worst instant.
    """
    lo, hi = 0.02, 0.9
    for _ in range(26):
        mid = (lo + hi) * 0.5
        if max(trot_pose(rig, rest, i / PROBE, mid) for i in range(PROBE)) <= 1.0:
            lo = mid
        else:
            hi = mid
    return lo


def build_trot(rig, rest, unit_m):
    sweep = solve_sweep(rig, rest)
    act = new_action(rig, "trot", TROT_FRAMES)
    for i in range(TROT_FRAMES + 1):
        trot_pose(rig, rest, (i % TROT_FRAMES) / TROT_FRAMES, sweep)
        key(rig, TROT_BONES, 1 + i, loc={"Root"})
    rig.animation_data.action = None
    clear(rig)

    cycle = TROT_FRAMES / 24.0
    speed = sweep * unit_m / cycle
    print(f"[trot] sweep {sweep:.3f} units ({sweep * unit_m:.3f} m) over "
          f"{cycle:.3f}s = {1/cycle:.2f} Hz -> {speed:.3f} m/s")

    # Validate the KEYED result against the path it was solved for. This is the
    # phase-independent question — while planted, is the paw where the gait says
    # it should be? Comparing travel BETWEEN keyframes instead measures the
    # sampling, not the animal: at an odd frame count the diagonal pairs get
    # sampled at different points of their stance and report different distances
    # while both track perfectly.
    worst, where, drift = 0.0, None, 0.0
    for i in range(TROT_FRAMES + 1):
        sample(rig, act, 1 + i)
        t = (i % TROT_FRAMES) / TROT_FRAMES
        for k, L in LEGS.items():
            goal, planted = foot_at(rest[k]["target"], PHASE[k], t, sweep)
            if not planted:
                continue
            got = rig.pose.bones[L["target"]].head
            if (got - goal).length > worst:
                worst, where = (got - goal).length, f"f{i} {k}"
            drift = max(drift, abs(got.z - rest[k]["target"].z))
    s = seam(rig, act, TROT_FRAMES)
    rig.animation_data.action = None
    clear(rig)
    print(f"[trot]   planted paw off its path  {worst*1000:7.3f} mm ({where})")
    print(f"[trot]   planted paw height drift  {drift*1000:7.3f} mm")
    print(f"[trot]   cycle seam                {s*1000:7.3f} mm")
    assert worst < 0.001, f"a planted paw left its path by {worst*1000:.2f} mm"
    assert drift < 0.001, f"a planted paw left the ground by {drift*1000:.2f} mm"
    assert s < 1e-4, f"the cycle does not close: {s*1000:.3f} mm"
    return speed


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
    print(f"[alert] muzzle z {rest['muzzle'].z:.3f} -> {max(mz):.3f} "
          f"(+{max(mz)-rest['muzzle'].z:.3f}); scan x {min(xs):+.3f}..{max(xs):+.3f}")
    print(f"[alert]   paw movement  {paw*1000:7.3f} mm")
    print(f"[alert]   cycle seam    {s*1000:7.3f} mm")
    assert max(mz) > rest["muzzle"].z + 0.02, "the head never comes up"
    assert min(xs) < -0.02 and max(xs) > 0.02, "the head does not look both ways"
    # The alert touches nothing below spine.007, so the paws cannot move by
    # construction. Asserted anyway: "by construction" is a claim about code.
    assert paw < 1e-4, f"a paw moved {paw*1000:.3f} mm; alert must not move the feet"


def main():
    rig = open_animal(RIG, MESH, "Raccoon_")
    face_forward(rig, HEAD)
    for old, new in RENAME.items():
        bpy.data.actions[old].name = new
        bpy.data.actions[new].use_fake_user = True
        bpy.data.actions[new].use_frame_range = True

    mesh = bpy.data.objects[MESH[0]]
    bb = [mesh.matrix_world @ Vector(c) for c in mesh.bound_box]
    height = max(p.z for p in bb) - min(p.z for p in bb)
    print(f"[build] raccoon {height:.3f} units tall, authored at 1 unit = 1 m")

    rest = rest_frame(rig)
    build_trot(rig, rest, 1.0)
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
