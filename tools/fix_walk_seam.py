"""Stop Walk stalling at its loop point. Leaves Stand and Trot untouched.

    Blender -b assets/models/fox_reference.blend --python tools/fix_walk_seam.py -- --write

Walk never popped at the seam -- measured on the deformed mesh, its velocity
discontinuity there (0.004122 at a 0.4-frame probe) matched the mid-cycle
control (0.004151) almost exactly, and both shrank linearly with the probe
width, which is curvature rather than a broken tangent.

What Walk did was *stall*. Blender's auto handles flatten the first and last key
of every channel by construction, not because those keys turn around, so at the
loop point the whole rig decelerated at once: seam speed 0.0012 against 0.0463
at the equivalent mid-cycle moment, a 38x slowdown that reads as a hitch every
cycle. Mid-cycle keys escape this because there Blender flattens only the
channels genuinely at a turning point and everything else keeps moving.

So only the two seam keys need touching, and they get the tangent the cycle
implies -- taken from the last key before the loop and the first one after it.
Every interior handle is left exactly as authored, which matters because Walk's
interior motion was already right. Rebuilding all handles also worked, but it
dragged the mid-cycle velocity from 0.0463 down to 0.0393; this does not.

Stand is deliberately excluded: its seam already measured clean (curvature
1.19x the mid-cycle control, tangents continuous), so there is nothing here to
fix. Both it and Trot are fingerprinted to prove they did not move.
"""

import sys
import os
import json
import bpy

sys.path.insert(0, os.path.dirname(__file__))
from fix_fox_loops import fcurves  # noqa: E402

TARGET = "Walk"
KEEP = ("Stand", "Trot")


def fingerprint(action):
    rows = [(fc.data_path, fc.array_index, [
        (round(k.co[0], 6), round(k.co[1], 6),
         round(k.handle_left[0], 6), round(k.handle_left[1], 6),
         round(k.handle_right[0], 6), round(k.handle_right[1], 6))
        for k in fc.keyframe_points]) for fc in fcurves(action)]
    rows.sort(key=lambda r: (r[0], r[1]))
    return json.dumps(rows)


def seam_tangents(action, period):
    """Give the two seam keys the tangent the cycle implies; touch nothing else."""
    fixed = 0
    for fc in fcurves(action):
        pts = fc.keyframe_points
        n = len(pts) - 1              # last key repeats the first
        if n < 2:
            continue
        t = [k.co[0] for k in pts]
        v = [k.co[1] for k in pts]
        dt_prev = period - t[n - 1]   # gap from the last distinct key to the loop
        dt_next = t[1] - t[0]
        if dt_prev <= 0 or dt_next <= 0:
            continue
        slope = (v[1] - v[n - 1]) / (dt_prev + dt_next)
        lx, nx = dt_prev / 3.0, dt_next / 3.0
        for kp in (pts[0], pts[n]):
            base = kp.co[0]
            kp.handle_left = (base - lx, v[0] - slope * lx)
            kp.handle_right = (base + nx, v[0] + slope * nx)
            kp.handle_left_type = kp.handle_right_type = "FREE"
            kp.interpolation = "BEZIER"
        fc.update()
        fixed += 1
    return fixed


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    before = {n: fingerprint(bpy.data.actions[n]) for n in KEEP}

    act = bpy.data.actions[TARGET]
    n = seam_tangents(act, act.frame_end - act.frame_start)
    act.use_fake_user = True
    print(f"[walk] seam tangents rebuilt on {n} channels; interior handles untouched")

    for name in KEEP:
        same = before[name] == fingerprint(bpy.data.actions[name])
        print(f"[walk] {name} untouched: {same}")
        if not same:
            raise SystemExit(f"refusing to save: {name} changed")

    # Walk and Stand run 0-48 with frame 48 repeating frame 0 as the closing key,
    # so the preview stops one short. Trot is 16 frames and needs 0-15 -- one
    # scene range cannot serve both, and reviewing a 48-frame clip while the
    # range is still set for Trot makes it look badly broken.
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 0, 47
    print("[walk] preview range 0-47 for Walk/Stand (set 0-15 to review Trot)")

    if "--write" in argv:
        bpy.ops.wm.save_mainfile()
        print(f"[walk] saved {bpy.data.filepath}")
    else:
        print("[walk] dry run; pass -- --write to save")


if __name__ == "__main__":
    main()
