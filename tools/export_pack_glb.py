"""Export a per-animal working .blend to public/models/<name>.glb.

    Blender -b assets/models/<x>_pack.blend --python tools/export_pack_glb.py

The fast half of the pair, and generic: it takes the single armature in the file
and every mesh parented to it, so one script serves every animal built by a
`build_*_blend.py`. The output name is derived from the .blend's own name.

Two things it must do, both consequences of how the working .blend is laid out:

* **Strip the NLA tracks.** The working file lays every clip out as a soloable
  track so it can be scrubbed the way the pack lays itself out. `ACTIONS` export
  mode reads `bpy.data.actions`, so leaving strips on risks each clip being
  emitted twice — once as an action and once as a track.
* **Drop the geometry-nodes modifiers.** The pack's meshes carry an empty NODES
  modifier beside the armature one. It contributes nothing and does not survive
  glTF.

The animations are not touched. See CLAUDE.md.
"""

import os
import bpy


def main():
    rigs = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    assert len(rigs) == 1, f"expected one armature, found {[r.name for r in rigs]}"
    rig = rigs[0]
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.parent is rig]
    assert meshes, "no meshes parented to the armature"

    if rig.animation_data:
        rig.animation_data.action = None
        for t in list(rig.animation_data.nla_tracks):
            rig.animation_data.nla_tracks.remove(t)

    for ob in meshes:
        for m in [m for m in ob.modifiers if m.type == 'NODES']:
            ob.modifiers.remove(m)

    for act in bpy.data.actions:
        assert act.use_frame_range, f"{act.name} has no manual frame range"

    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    for ob in meshes:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = rig

    stem = os.path.splitext(os.path.basename(bpy.data.filepath))[0]
    root = os.path.dirname(os.path.dirname(os.path.dirname(bpy.data.filepath)))
    out = os.path.join(root, "public", "models", f"{stem}.glb")
    bpy.ops.export_scene.gltf(
        filepath=out, export_format="GLB", use_selection=True,
        export_apply=True, export_animations=True,
        export_animation_mode="ACTIONS", export_bake_animation=True,
        export_frame_range=False,
        # MUST be False for solved clips. The optimiser drops keys that look
        # collinear ON EACH ROTATION CHANNEL INDEPENDENTLY, and that is not
        # lossless for the position those rotations put a foot in: it took the
        # deer's 10-frame bound down to ~3.4 samples per channel and flattened
        # the first three quarters of the hind stance to zero velocity, so
        # `measureGround` found its densest cluster at 0 and the loader rejected
        # the clip as covering no ground.
        #
        # These clips are solved and keyed at EVERY frame precisely because the
        # pose between frames is not derivable from the channels. There is
        # nothing redundant in them to optimise away.
        export_optimize_animation_size=False,
        export_yup=True,
    )
    tris = 0
    for ob in meshes:
        ob.data.calc_loop_triangles()
        tris += len(ob.data.loop_triangles)
    print(f"[export] {out} ({os.path.getsize(out)} bytes); {len(meshes)} meshes "
          f"{[o.name for o in meshes]}; {tris} tris; clips "
          f"{sorted(a.name for a in bpy.data.actions)}")


main()
