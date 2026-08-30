"""Export the rigged bear to public/models/bear_reference.glb.

    Blender -b assets/models/bear.blend --python tools/export_bear_glb.py

Exports only the ``Bear_Rig`` hierarchy -- the presentation camera, the three
studio lights and the ground plane stay out of the shipped file.

Two things this does that ``export_fox_glb.py`` does not, both because the bear
is built from more pieces than the fox:

* **It merges the rigid detail meshes first.** The source asset keeps twelve
  claws and two eyes as separate objects because that is what is editable in
  Blender, but glTF gives every object its own primitive and every primitive
  its own draw call. Seventeen primitives per bear against the fox's six is not
  a cost the frame can carry at ``CFG.bear.live = 3``. The claws all share one
  material and one bone each, and the eyes likewise, so joining them is free:
  ``join`` merges vertex groups by name, and each claw's vertices keep the
  weight to their own foot bone. The merge happens here, in memory, and is
  never saved -- the .blend stays as editable as it was.

* **It leaves the frame range to the actions.** The fox's clips are all one
  scene length; the bear's are not (Trot is 16 frames, alert is 144), so each
  action carries its own manual ``use_frame_range`` and the exporter is told to
  honour it rather than stamping the scene's 0-48 onto all eight.

The animations are the artist's work and this script does not touch them. See
CLAUDE.md: a GLB's animations are read-only.
"""

import os
import bpy

TARGET = "Bear_Rig"
BODY = "Bear_Reference"

# name of the merged result -> the objects folded into it
MERGES = {
    "Bear eyes": "Bear eye ",
    "Bear claws": "Bear ",
}


def merge(name, members):
    """Join *members* into one mesh object called *name*.

    Every member is bone-parented by a single full-weight vertex group and
    carries the same armature modifier, so the join keeps each piece welded to
    the bone it was welded to before.
    """
    bpy.ops.object.select_all(action="DESELECT")
    for ob in members:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = members[0]
    bpy.ops.object.join()
    joined = bpy.context.object
    joined.name = name
    return joined


def main():
    scene = bpy.context.scene
    rig = bpy.data.objects[TARGET]
    kids = [o for o in bpy.data.objects if o.parent == rig and o.type == "MESH"]

    claws = sorted((o for o in kids if "claw" in o.name), key=lambda o: o.name)
    eyes = sorted((o for o in kids if o.name.startswith("Bear eye")), key=lambda o: o.name)
    assert len(claws) == 12 and len(eyes) == 2, (len(claws), len(eyes))
    before = len(kids)
    merge("Bear claws", claws)
    merge("Bear eyes", eyes)

    wanted = [rig] + [o for o in bpy.data.objects if o.parent == rig]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in wanted:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig

    # Every action states its own length; without this the exporter stamps the
    # scene range onto all of them and Trot arrives three times too long.
    for action in bpy.data.actions:
        assert action.use_frame_range, f"{action.name} has no manual frame range"

    root = os.path.dirname(os.path.dirname(os.path.dirname(bpy.data.filepath)))
    out = os.path.join(root, "public", "models", "bear_reference.glb")

    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_bake_animation=True,
        export_frame_range=False,
        export_optimize_animation_size=True,
        export_yup=True,
    )
    body = bpy.data.objects[BODY]
    print(f"[export] {out} ({os.path.getsize(out)} bytes); "
          f"objects {before} -> {len(wanted) - 1}: "
          f"{[o.name for o in wanted if o is not rig]}; "
          f"body tris {len(body.data.loop_triangles) or len(body.data.polygons)}")


main()
