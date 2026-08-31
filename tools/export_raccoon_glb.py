"""Export the game's raccoon to public/models/raccoon_pack.glb.

    Blender -b assets/models/raccoon_pack.blend --python tools/export_raccoon_glb.py

The fast half of the pair. `build_raccoon_blend.py` does the slow work — it
opens the bought pack, isolates the raccoon, solves the trot and the alert, and
saves the .blend this reads. Same split as build_bear_reference.py /
export_bear_glb.py.

Two things it has to do that the bear's does not:

* **Strip the NLA tracks.** The working .blend lays every clip out as a soloable
  track so the file can be scrubbed the way the pack lays itself out. `ACTIONS`
  export mode reads `bpy.data.actions`, so leaving the strips on risks each clip
  being emitted twice — once as an action, once as a track.
* **Drop the geometry-nodes modifier.** The pack's meshes carry an empty NODES
  modifier alongside the armature one. It contributes nothing and does not
  survive glTF.

The animations are not touched here. See CLAUDE.md.
"""

import os
import bpy

RIG = "Skeleton_Raccoon"
MESH = "Raccoon_01"


def main():
    rig = bpy.data.objects[RIG]
    if rig.animation_data:
        rig.animation_data.action = None
        for t in list(rig.animation_data.nla_tracks):
            rig.animation_data.nla_tracks.remove(t)

    mesh = bpy.data.objects[MESH]
    for m in [m for m in mesh.modifiers if m.type == 'NODES']:
        mesh.modifiers.remove(m)

    for act in bpy.data.actions:
        assert act.use_frame_range, f"{act.name} has no manual frame range"

    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = rig

    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, "public", "models", "raccoon_pack.glb")
    bpy.ops.export_scene.gltf(
        filepath=out, export_format="GLB", use_selection=True,
        export_apply=True, export_animations=True,
        export_animation_mode="ACTIONS", export_bake_animation=True,
        export_frame_range=False, export_optimize_animation_size=True,
        export_yup=True,
    )
    mesh.data.calc_loop_triangles()
    print(f"[export] {out} ({os.path.getsize(out)} bytes); "
          f"{len(mesh.data.loop_triangles)} tris; clips "
          f"{sorted(a.name for a in bpy.data.actions)}")


main()
