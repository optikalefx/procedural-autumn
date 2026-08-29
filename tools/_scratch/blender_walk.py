import bpy, math, sys
from mathutils import Vector
OUT = sys.argv[-1]
rig = bpy.data.objects["Fox_Rig"]
scn = bpy.context.scene
rig.animation_data.action = bpy.data.actions["Walk"]
for slot in bpy.data.actions["Walk"].slots:
    rig.animation_data.action_slot = slot
    break
# Broadside, the only angle a gait can be judged from. The fox faces +Y in
# Blender, so the camera stands off along -X and looks across.
cam = scn.camera
cam.data.lens = 60
cam.location = (9.5, 0.2, 1.55)
def aim(ob, t):
    ob.rotation_euler = (Vector(t) - ob.location).to_track_quat('-Z', 'Y').to_euler()
aim(cam, (0, 0.2, 1.35))
scn.render.resolution_x = 640
scn.render.resolution_y = 420
# Frames 1..49 is one full cycle; take six evenly across it.
for i, f in enumerate([1, 9, 17, 25, 33, 41]):
    scn.frame_set(f)
    scn.render.filepath = f"{OUT}/blender_{i}.png"
    bpy.ops.render.render(write_still=True)
    print("BLENDER FRAME", i, "at", f)
