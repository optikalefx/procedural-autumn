"""Survey the pack's Goat before building anything. Read-only on the pack.

    /opt/homebrew/bin/blender -b assets/models/Animals_v3.0.blend \
        --python tools/_scratch/survey_goat.py
"""
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from pack_rig_kit import open_animal, face_forward, play, clear   # noqa: E402

RIG = "Skeleton_Goat"
MESHES = ["Goat_01", "Goat_02"]

print("== objects named Goat / Skeleton_Goat ==")
for ob in bpy.data.objects:
    if "goat" in ob.name.lower():
        print(f"  {ob.name:28s} {ob.type:9s} parent={ob.parent.name if ob.parent else None} "
              f"loc={tuple(round(v,3) for v in ob.location)} "
              f"mods={[ (m.type, getattr(m,'object',None) and m.object.name) for m in ob.modifiers ]}")
print("== actions ==")
for a in bpy.data.actions:
    if a.name.startswith("Goat"):
        print(f"  {a.name:24s} range {a.frame_range[0]:.0f}..{a.frame_range[1]:.0f}")

rig = open_animal(RIG, MESHES, "Goat_")
print("\n== armature ==")
print(f"  {len(rig.data.bones)} bones")
for b in sorted(rig.data.bones, key=lambda b: b.name):
    print(f"    {b.name:20s} parent={b.parent.name if b.parent else '-':20s} "
          f"head={tuple(round(v,3) for v in b.head_local)} len={b.length:.4f}")

print("\n== mesh stats (before face_forward) ==")
for m in MESHES:
    ob = bpy.data.objects[m]
    ob.data.calc_loop_triangles()
    bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    print(f"  {m}: {len(ob.data.loop_triangles)} tris, {len(ob.data.vertices)} verts, "
          f"mats={[mm.name if mm else None for mm in ob.data.materials]}, loc={tuple(round(v,3) for v in ob.location)}")
    print(f"     bbox x {min(p.x for p in bb):+.3f}..{max(p.x for p in bb):+.3f} "
          f"y {min(p.y for p in bb):+.3f}..{max(p.y for p in bb):+.3f} "
          f"z {min(p.z for p in bb):+.3f}..{max(p.z for p in bb):+.3f}")

head = face_forward(rig, "scull" if "scull" in rig.data.bones else rig.data.bones[0].name)
print(f"\n  face_forward -> head at {tuple(round(v,3) for v in head)}")

print("\n== mesh stats (after face_forward) ==")
for m in MESHES:
    ob = bpy.data.objects[m]
    bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    print(f"  {m}: bbox x {min(p.x for p in bb):+.3f}..{max(p.x for p in bb):+.3f} "
          f"y {min(p.y for p in bb):+.3f}..{max(p.y for p in bb):+.3f} "
          f"z {min(p.z for p in bb):+.3f}..{max(p.z for p in bb):+.3f}")

# ── duty per foot, per clip ──────────────────────────────────────────────────
CANDIDATE_FEET = ["toe.L", "toe.R", "front_toe.L", "front_toe.R"]
FEET = [n for n in CANDIDATE_FEET if n in rig.pose.bones]
print(f"\n== contact bones present: {FEET}")

for act in sorted(bpy.data.actions, key=lambda a: a.name):
    play(rig, act.name)
    f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
    n = f1 - f0
    tracks = {f: [] for f in FEET}
    for i in range(n + 1):
        bpy.context.scene.frame_set(f0 + i)
        bpy.context.view_layer.update()
        for f in FEET:
            tracks[f].append(rig.pose.bones[f].head.copy())
    print(f"\n  {act.name} ({n} frames, {n/24.0:.3f}s)")
    for f in FEET:
        zs = [p.z for p in tracks[f]]
        lo, hi = min(zs), max(zs)
        band = lo + max(0.12 * (hi - lo), 1e-4)
        duty = sum(1 for z in zs[:-1] if z <= band) / max(n, 1)
        ys = [p.y for p in tracks[f]]
        print(f"    {f:14s} z {lo:+.3f}..{hi:+.3f}  y-excursion {max(ys)-min(ys):.3f}  duty {duty:.2f}")

# rest extension per limb
clear(rig)
print("\n== rest extension ==")
for pair, a, b, t in (("hind.L", "thigh.L", "shin.L", "foot.L"),
                      ("hind.R", "thigh.R", "shin.R", "foot.R"),
                      ("fore.L", "front_thigh.L", "front_shin.L", "front_foot.L"),
                      ("fore.R", "front_thigh.R", "front_shin.R", "front_foot.R")):
    if a not in rig.pose.bones:
        print(f"  {pair}: MISSING {a}")
        continue
    A = rig.pose.bones[a].head
    B = rig.pose.bones[b].head
    T = rig.pose.bones[t].head
    l1, l2 = (B - A).length, (T - B).length
    print(f"  {pair}: hip z {A.z:.3f} foot z {T.z:.3f} l1 {l1:.3f} l2 {l2:.3f} "
          f"straight {(T-A).length:.3f} ext {(T-A).length/(l1+l2):.3f}")
