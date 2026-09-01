"""Second goat survey: mesh difference, what the Gesture is, and renders."""
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from pack_rig_kit import open_animal, face_forward, play, clear   # noqa: E402

RIG = "Skeleton_Goat"
MESHES = ["Goat_01", "Goat_02"]
OUT = "/private/tmp/claude-502/-Users-sean-htdocs-procedural-fall/3ea57bc1-be60-42ac-9aa5-f5ab42a7ab4c/scratchpad"
os.makedirs(OUT, exist_ok=True)

# ── how do the two meshes differ, in their own local space ──────────────────
a, b = bpy.data.objects["Goat_01"], bpy.data.objects["Goat_02"]
va = [v.co.copy() for v in a.data.vertices]
vb = [v.co.copy() for v in b.data.vertices]
print(f"[mesh] verts {len(va)} vs {len(vb)}")
if len(va) == len(vb):
    d = [(x - y).length for x, y in zip(va, vb)]
    print(f"[mesh] index-wise local vertex delta: max {max(d):.6f} mean {sum(d)/len(d):.6f}")
# UVs
for ob in (a, b):
    uv = ob.data.uv_layers.active
    us = [tuple(round(c, 4) for c in uv.data[i].uv) for i in range(len(uv.data))]
    print(f"[uv] {ob.name}: {len(set(us))} distinct uvs, first 6 {sorted(set(us))[:6]}")
# vertex groups
print(f"[vg] Goat_01 groups {len(a.vertex_groups)}, Goat_02 groups {len(b.vertex_groups)}")

rig = open_animal(RIG, MESHES, "Goat_")
bpy.data.objects["Goat_02"].location = (0.0, 0.0, 0.0)
bpy.context.view_layer.update()
face_forward(rig, "scull")

clear(rig)
muz0 = rig.pose.bones["scull"].tail.copy()
tail0 = rig.pose.bones["spine"].tail.copy()
print(f"\n[rest] muzzle {tuple(round(v,3) for v in muz0)}  tail-tip z {tail0.z:.3f}")
print(f"[rest] ear.L head z {rig.pose.bones['ear.L'].head.z:.3f}")
withers = rig.pose.bones["spine.005"].head.z
print(f"[rest] withers (spine.005 head) z {withers:.3f}")

for name in ("Goat_Idle", "Goat_Gesture"):
    act = play(rig, name)
    f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
    mz, my, tz, hy = [], [], [], []
    for f in range(f0, f1 + 1):
        bpy.context.scene.frame_set(f)
        bpy.context.view_layer.update()
        t = rig.pose.bones["scull"].tail
        mz.append(t.z); my.append(t.y)
        tz.append(rig.pose.bones["spine"].tail.z)
        hy.append(rig.pose.bones["scull"].head.x)
    print(f"\n[{name}] muzzle z {min(mz):.3f}..{max(mz):.3f} (rest {muz0.z:.3f})  "
          f"y {min(my):.3f}..{max(my):.3f} (rest {muz0.y:.3f})")
    print(f"[{name}] tail-tip z {min(tz):.3f}..{max(tz):.3f} (rest {tail0.z:.3f})  "
          f"head x {min(hy):+.3f}..{max(hy):+.3f}")

rig.animation_data.action = None
clear(rig)

# ── renders: workbench, side-on, one per mesh ───────────────────────────────
sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'
sc.render.image_settings.media_type = 'IMAGE'
sc.render.image_settings.file_format = 'PNG'
sc.render.resolution_x, sc.render.resolution_y = 900, 620
sc.display.shading.type = 'SOLID'
sc.display.shading.color_type = 'TEXTURE'
sc.display.shading.light = 'STUDIO'
cam_data = bpy.data.cameras.new("cam")
cam = bpy.data.objects.new("cam", cam_data)
sc.collection.objects.link(cam)
sc.camera = cam
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 1.9


def shot(path, eye, look):
    cam.location = Vector(look) + Vector(eye)
    cam.rotation_euler = (Vector(eye)).to_track_quat('Z', 'Y').to_euler()
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


for m in MESHES:
    for other in MESHES:
        bpy.data.objects[other].hide_render = (other != m)
    shot(os.path.join(OUT, f"{m}_side"), (4.0, 0.0, 0.35), (0, 0.18, 0.45))
    shot(os.path.join(OUT, f"{m}_front"), (0.0, 4.0, 0.35), (0, 0.18, 0.45))
print("[render] done")
