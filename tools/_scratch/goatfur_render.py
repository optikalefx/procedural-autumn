"""Render the built goat from Blender, headless, to look at the coat.

    Blender -b assets/models/goat_pack.blend --python tools/_scratch/goatfur_render.py

Workbench, because it needs no lights and no shader compile. Two traps:
  * `bpy.ops.render.opengl` needs a GUI; under -b there is no OpenGL context.
    A real engine is the only headless option, and WORKBENCH is the cheap one.
  * In Blender 5, `image_settings.media_type` must be set to 'IMAGE' BEFORE
    `file_format`, or assigning 'PNG' fails with
    `enum "PNG" not found in ('FFMPEG')`.
"""
import math
import os
import bpy
from mathutils import Vector

OUT = "/Users/sean/htdocs/procedural-fall/shots/goatfur"
os.makedirs(OUT, exist_ok=True)

rig = [o for o in bpy.data.objects if o.type == 'ARMATURE'][0]
rig.data.pose_position = 'REST'          # NLA strips still evaluate otherwise
for ob in bpy.data.objects:
    if ob.type == 'MESH':
        ob.hide_render = (ob.name != "Goat_01")

sc = bpy.context.scene
sc.render.engine = 'BLENDER_WORKBENCH'
sh = sc.display.shading
sh.light = 'STUDIO'
sh.color_type = 'TEXTURE'
sh.show_cavity = True
sh.cavity_type = 'BOTH'
sh.curvature_ridge_factor = 1.0
sh.curvature_valley_factor = 1.0
sc.render.film_transparent = False
sc.world = bpy.data.worlds.new("w") if not bpy.data.worlds else bpy.data.worlds[0]
sc.world.color = (0.55, 0.68, 0.82)
sc.render.resolution_x, sc.render.resolution_y = 1100, 800
sc.render.image_settings.media_type = 'IMAGE'      # BEFORE file_format
sc.render.image_settings.file_format = 'PNG'

ob = bpy.data.objects["Goat_01"]
bb = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
ctr = sum(bb, Vector()) / 8.0
size = max((max(p[i] for p in bb) - min(p[i] for p in bb)) for i in range(3))

cam_data = bpy.data.cameras.new("cam")
cam_data.type = 'ORTHO'
cam_data.ortho_scale = size * 1.25
cam = bpy.data.objects.new("cam", cam_data)
sc.collection.objects.link(cam)
sc.camera = cam

VIEWS = {
    "side":    (0.0, 0.0),
    "front34": (52.0, 8.0),
    "front":   (90.0, 0.0),
    "rear34":  (-128.0, 10.0),
    "top34":   (40.0, 55.0),
}
for name, (az, el) in VIEWS.items():
    a, e = math.radians(az), math.radians(el)
    d = Vector((math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)))
    cam.location = ctr + d * (size * 3.0)
    direction = (ctr - cam.location).normalized()
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = os.path.join(OUT, f"{name}.png")
    bpy.ops.render.render(write_still=True)
    print(f"[render] {sc.render.filepath}")
