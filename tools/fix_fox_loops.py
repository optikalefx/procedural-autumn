"""Make the fox clips true 48-frame cycles.

Run headlessly against the asset:

    Blender -b assets/models/fox_reference.blend --python tools/fix_fox_loops.py -- --write

Two defects, both found by sampling the rig pose every frame:

* ``Trot`` held a 24-frame stride duplicated to fill the 48-frame clip
  (``pose(k) == pose(k + 24)`` for every k). The second half carried nothing
  new, so the clip "stopped" at frame 24. The first half is retimed 2x to span
  the whole clip, which lands the keys on 6-frame spacing -- the same cadence
  ``Walk`` already uses -- and keeps every phase relationship intact: the
  diagonal pairs stay paired, and the body bob stays at two beats per stride.

* ``Stand`` closed in position at the seam (frame 48 == frame 0) but not in
  velocity. Both endpoints carried AUTO_CLAMPED handles, which Blender flattens
  at the ends of a curve, so the idle decelerated to a standstill at frame 48
  and lurched away from frame 0 -- most visibly the ear.R twitch, which ramps
  0 -> 14 degrees starting exactly on the loop point.

``Walk`` is left alone; ``--check-walk`` runs the same tangent maths over it as
a control, and reports how little it would move.
"""

import sys
import bpy

SEAM_TOL = 1e-6


def fcurves(action):
    """Blender 5.x slotted actions: fcurves hang off layer/strip/channelbag."""
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for fc in bag.fcurves:
                    yield fc


def retime_first_half(action, half=24.0, scale=2.0):
    """Drop the duplicated second half and stretch the first half over the clip."""
    dropped = 0
    for fc in fcurves(action):
        pts = fc.keyframe_points
        for i in range(len(pts) - 1, -1, -1):
            if pts[i].co[0] > half + SEAM_TOL:
                pts.remove(pts[i], fast=True)
                dropped += 1
        for kp in pts:
            # Handles sit at absolute frames, so the whole timeline scales alike
            # and the curve keeps its shape.
            kp.handle_left[0] *= scale
            kp.handle_right[0] *= scale
            kp.co[0] *= scale
        fc.update()
    return dropped


def cyclic_tangents(action, first=0.0, last=48.0, apply=True, skip=None):
    """Give frame 0 and frame 48 a shared tangent taken across the seam.

    The slope is the central difference the curve would have if the cycle ran
    on past the seam: the key before frame 48 on one side, the key after frame
    0 on the other. Handles go to FREE so Blender stops flattening them.
    Returns the largest value correction the pass made, per purpose.
    """
    worst_pos = 0.0
    worst_slope = 0.0
    for fc in fcurves(action):
        pts = fc.keyframe_points
        if len(pts) < 3:
            continue
        if skip and skip(fc):
            continue
        k0, kn = pts[0], pts[-1]
        if abs(k0.co[0] - first) > SEAM_TOL or abs(kn.co[0] - last) > SEAM_TOL:
            continue

        # The cycle only closes if the two endpoints hold the same value.
        worst_pos = max(worst_pos, abs(kn.co[1] - k0.co[1]))
        value = k0.co[1]

        prev, nxt = pts[-2], pts[1]
        d_prev = last - prev.co[0]
        d_next = nxt.co[0] - first
        if d_prev <= 0 or d_next <= 0:
            continue
        slope = (nxt.co[1] - prev.co[1]) / (d_prev + d_next)

        def old_slope(kp, handle):
            dx = handle[0] - kp.co[0]
            return (handle[1] - kp.co[1]) / dx if abs(dx) > 1e-9 else 0.0

        worst_slope = max(
            worst_slope,
            abs(slope - old_slope(k0, k0.handle_right)),
            abs(slope - old_slope(kn, kn.handle_left)),
        )
        if not apply:
            continue

        kn.co[1] = value
        # Blender's own auto-tangent reach: a third of the gap to the neighbour.
        lx, nx = d_prev / 3.0, d_next / 3.0
        k0.handle_left = (first - lx, value - slope * lx)
        k0.handle_right = (first + nx, value + slope * nx)
        kn.handle_left = (last - lx, value - slope * lx)
        kn.handle_right = (last + nx, value + slope * nx)
        for kp in (k0, kn):
            kp.handle_left_type = "FREE"
            kp.handle_right_type = "FREE"
            kp.interpolation = "BEZIER"
        fc.update()
    return worst_pos, worst_slope


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    write = "--write" in argv

    acts = {a.name: a for a in bpy.data.actions}

    dropped = retime_first_half(acts["Trot"])
    print(f"[fix] Trot: dropped {dropped} duplicated keys, stretched 0-24 over 0-48")

    for name in ("Trot", "Stand"):
        pos, slope = cyclic_tangents(acts[name])
        print(f"[fix] {name}: seam value gap {pos:.6g}, tangent correction {slope:.6g}")

    if "--check-walk" in argv:
        pos, slope = cyclic_tangents(acts["Walk"], apply=False)
        print(f"[check] Walk (untouched control): seam value gap {pos:.6g}, "
              f"tangent it would move {slope:.6g}")

    for act in bpy.data.actions:
        # A zero-user action without a fake user is dropped silently on save.
        act.use_fake_user = True
        act.use_frame_range = True
        act.frame_start, act.frame_end = 0.0, 48.0

    # Frame 48 is the cycle's closing key: the same pose as frame 0, kept so the
    # exporter emits a final sample at t=2.0s. Playing 0-48 in the viewport
    # therefore shows that pose twice in a row and stutters once per loop. Park
    # the playback range on 0-47 so what you watch matches what ships; the
    # exporter forces 0-48 back on regardless of this setting.
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 0, 47

    if write:
        bpy.ops.wm.save_mainfile()
        print(f"[fix] saved {bpy.data.filepath}")
    else:
        print("[fix] dry run; pass -- --write to save")


if __name__ == "__main__":
    main()
