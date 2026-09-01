"""Export the rigged fox to public/models/fox_reference.glb.

    Blender -b assets/models/fox_reference.blend --python tools/export_fox_glb.py

**This is no longer the asset the game loads.** Since the pack's fox clips were
retargeted onto this mesh, the shipped GLB is `fox_packanim.glb`, exported from
the derived `fox_packanim.blend` by `export_pack_glb.py` — see
`tools/retarget_fox_from_pack.py` and `mammals/fox.js`. What this script writes
is `fox_reference.blend` as it stands: our mesh carrying the ARTIST'S original
six clips. That output is deliberately not kept in the tree (it shipped 523 KB
of dist/ that nothing loaded), so run this when you want to compare the old
clips against the new ones, and expect an untracked file.

Exports only the ``Fox_Rig`` hierarchy -- the presentation camera, the three
studio lights and the ground plane stay out of the shipped file. Animations are
baked over the scene range (0-48 at 24 fps, i.e. one 2-second cycle per clip),
which is what the glTF exporter samples pose matrices across.
"""

import os
import bpy

TARGET = "Fox_Rig"


def main():
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 0, 48

    rig = bpy.data.objects[TARGET]
    bpy.ops.object.select_all(action="DESELECT")
    wanted = [rig] + [o for o in bpy.data.objects if o.parent and o.parent == rig]
    for obj in wanted:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig

    root = os.path.dirname(os.path.dirname(os.path.dirname(bpy.data.filepath)))
    out = os.path.join(root, "public", "models", "fox_reference.glb")

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
    print(f"[export] {out} ({os.path.getsize(out)} bytes), objects: "
          f"{[o.name for o in wanted]}")


main()
