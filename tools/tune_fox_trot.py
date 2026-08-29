"""Turn Trot into an actual trot: fast cadence, suspension hop, exact cycle.

    Blender -b assets/models/fox_reference.blend --python tools/tune_fox_trot.py -- --write
    ... [--stride 16] [--hop 0.10] [--reach 1.8]

Run this against a Trot that is still one stride spread over 48 frames -- it
scales from whatever the action's current frame range says, so it is safe to
re-run from the pre-tune backup but not to stack on its own output.

* **Cadence.** ``--stride`` sets the frames per stride. 16 puts the fox at
  three times Walk's cadence (0.67s per stride at 24fps). The clip is
  deliberately shorter than Walk's rather than holding repeats of the stride:
  one stride per clip is what lets the game scale playback speed per gait.

* **Reach.** Leg rotations scale in angle space -- quaternions to axis-angle,
  angle multiplied, back again. Scaling raw quaternion components would tilt
  the axis instead of opening the swing.

* **The hop.** Nothing in this rig ever moved vertically. The channel that
  looks like a body bob, ``root.location[2]``, points along world -Y and is a
  fore-aft surge; world up is ``root.location[1]`` and it was unkeyed. This
  writes a ballistic arc there: lowest at the diagonal contacts, highest
  mid-suspension, with a corner at each landing and a float over the top. The
  corner is what reads as impact -- a smooth minimum just reads as a bob.

* **Exact periodicity.** Every handle is rebuilt from the *wrapped* neighbours,
  so the key at frame 0 is computed identically to the key at mid-cycle. Hand
  keying left the two beats slightly unequal (the motion into the mid-cycle
  landing ran 14% hotter than into the seam), which reads as a limp once the
  clip loops. Blender's own AUTO_CLAMPED cannot fix this: it has no notion of a
  cycle, so it always flattens the first and last key.
"""

import sys
import os
import math
import bpy
from mathutils import Quaternion

sys.path.insert(0, os.path.dirname(__file__))
from fix_fox_loops import fcurves  # noqa: E402

LEGS = ("scapula", "fore_upper", "fore_lower", "fore_foot", "fore_toe",
        "hind_upper", "hind_lower", "hind_foot", "hind_toe")
UP = 1          # root.location index pointing at world +Z
HOP_PATH = 'pose.bones["root"].location'


def bone_of(fc):
    return fc.data_path.split('"')[1] if '"' in fc.data_path else ""


def is_hop(fc):
    return fc.data_path == HOP_PATH and fc.array_index == UP


def retime(action, scale):
    for fc in fcurves(action):
        for kp in fc.keyframe_points:
            kp.handle_left[0] *= scale
            kp.handle_right[0] *= scale
            kp.co[0] *= scale
        fc.update()


def scale_leg_reach(action, factor):
    """Multiply each leg bone's rotation angle, keeping its axis intact."""
    groups = {}
    for fc in fcurves(action):
        if "rotation_quaternion" not in fc.data_path:
            continue
        if not any(bone_of(fc).startswith(p) for p in LEGS):
            continue
        groups.setdefault(fc.data_path, {})[fc.array_index] = fc

    peak = 0.0
    for comps in groups.values():
        if len(comps) != 4:
            continue
        for i in range(len(comps[0].keyframe_points)):
            q = Quaternion([comps[c].keyframe_points[i].co[1] for c in range(4)])
            q.normalize()
            if q.w < 0:                      # keep off the far side of the double cover
                q.negate()
            angle = q.angle
            if angle < 1e-6:
                continue
            scaled = Quaternion(q.axis, angle * factor)
            peak = max(peak, math.degrees(angle * factor))
            for c in range(4):
                comps[c].keyframe_points[i].co[1] = scaled[c]
    return len(groups), peak


def cyclic_auto_handles(action, period, skip=None):
    """Auto-tangents computed across the loop, so no key is a special case.

    Blender's AUTO_CLAMPED reads only the neighbours it can see, which means the
    first and last key of a cycle get flattened while their mid-cycle twins do
    not. Here the neighbour lookup wraps, so a key at frame 0 and the identical
    key at mid-cycle end up with identical tangents.
    """
    for fc in fcurves(action):
        if skip and skip(fc):
            continue
        pts = fc.keyframe_points
        n = len(pts) - 1                      # last key duplicates the first
        if n < 2:
            continue
        t = [kp.co[0] for kp in pts]
        v = [kp.co[1] for kp in pts]
        for i in range(len(pts)):
            j = i % n
            vp, vn = v[(j - 1) % n], v[(j + 1) % n]
            dt_prev = (t[j] - t[(j - 1) % n]) % period or period
            dt_next = (t[(j + 1) % n] - t[j]) % period or period
            # Flat at a local extremum, matching AUTO_CLAMPED's anti-overshoot.
            slope = 0.0 if (v[j] - vp) * (vn - v[j]) <= 0 else \
                (vn - vp) / (dt_prev + dt_next)
            lx, nx = dt_prev / 3.0, dt_next / 3.0
            kp = pts[i]
            kp.handle_left = (t[i] - lx, v[j] - slope * lx)
            kp.handle_right = (t[i] + nx, v[j] + slope * nx)
            kp.handle_left_type = kp.handle_right_type = "FREE"
            kp.interpolation = "BEZIER"
        fc.update()


def find_or_make(action, path, index):
    for fc in fcurves(action):
        if fc.data_path == path and fc.array_index == index:
            return fc
    return action.layers[0].strips[0].channelbags[0].fcurves.new(path, index=index)


def write_hop(action, height, period):
    """Ballistic vertical hop: corner at each landing, arc over each apex."""
    fc = find_or_make(action, HOP_PATH, UP)
    base = fc.keyframe_points[0].co[1] if len(fc.keyframe_points) else 0.0
    for i in range(len(fc.keyframe_points) - 1, -1, -1):
        fc.keyframe_points.remove(fc.keyframe_points[i], fast=True)
    fc.update()

    beat = period / 2.0                       # one diagonal beat
    contacts = (0.0, beat, period)
    apexes = (beat / 2.0, beat * 1.5)
    step = period / 8.0
    lo = base

    plan = []
    for k in range(9):
        f = k * step
        if f in contacts:
            plan.append((f, lo))
        elif f in apexes:
            plan.append((f, lo + height))
        else:
            # A parabola through contact and apex sits at 3/4 height a quarter
            # of the way along; that is what floats the top and snaps the bottom.
            plan.append((f, lo + 0.75 * height))

    fc.keyframe_points.add(len(plan))
    for kp, (f, val) in zip(fc.keyframe_points, plan):
        kp.co = (f, val)
        kp.interpolation = "BEZIER"
    fc.update()

    reach = (beat / 2.0) / 3.0
    slope = height / (beat / 2.0) * (2.0 / 3.0)   # parabola's slope at the landing
    for kp in fc.keyframe_points:
        f = kp.co[0]
        if f in contacts:
            # Both handles rise away from the landing: a V, not a smooth dip.
            kp.handle_left = (f - reach, lo + slope * reach)
            kp.handle_right = (f + reach, lo + slope * reach)
        else:
            kp.handle_left = (f - reach, kp.co[1])
            kp.handle_right = (f + reach, kp.co[1])
        kp.handle_left_type = kp.handle_right_type = "FREE"
    fc.update()
    return contacts, apexes


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []

    def opt(name, default):
        return float(argv[argv.index(name) + 1]) if name in argv else default

    stride = opt("--stride", 16.0)
    hop = opt("--hop", 0.10)
    reach = opt("--reach", 1.8)

    trot = bpy.data.actions["Trot"]
    was = trot.frame_end
    retime(trot, stride / was)
    print(f"[trot] stride {was:g} -> {stride:g} frames "
          f"({stride / 24:.2f}s, {48 / stride:g}x Walk's cadence)")

    n, peak = scale_leg_reach(trot, reach)
    print(f"[trot] leg reach x{reach} over {n} bones, peak swing {peak:.1f} deg")

    contacts, apexes = write_hop(trot, hop, stride)
    print(f"[trot] hop {hop} on root.location[{UP}] (world up); "
          f"contacts {contacts}, apexes {apexes}")

    cyclic_auto_handles(trot, stride, skip=is_hop)
    print("[trot] handles rebuilt across the loop (hop keeps its landing corners)")

    trot.use_fake_user = True
    trot.use_frame_range = True
    trot.frame_start, trot.frame_end = 0.0, stride

    # The key at `stride` repeats frame 0 so the exporter emits a closing sample.
    # Playing up to it shows that pose twice and stutters once per loop, so the
    # preview range stops one frame short.
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 0, int(stride) - 1
    print(f"[trot] action range 0-{stride:g} (frame {stride:g} is the closing "
          f"duplicate); preview range set to 0-{int(stride) - 1}")

    if "--write" in argv:
        bpy.ops.wm.save_mainfile()
        print(f"[trot] saved {bpy.data.filepath}")
    else:
        print("[trot] dry run; pass -- --write to save")


if __name__ == "__main__":
    main()
