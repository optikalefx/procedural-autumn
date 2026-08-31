"""Shared machinery for authoring clips onto the bought animal pack's rigs.

`assets/models/Animals_v3.0.blend` is 103 MB of licensed third-party source,
kept out of the repo (see .gitignore). These scripts read it from that path,
work entirely in memory, and never write to it — so the .blend stays pristine
and every animal is reproducible from one command, which is the build script
`import-animal` demands without our owning the asset.

Read the `add-new-animation-to-glb` skill before using this. What lives here is
the machinery; the skill is the argument for why it is shaped this way.

## Three traps the pack ships with, all handled by `open_animal()`

Each of these produced confidently wrong measurements, and they mask each other
— fix one and the symptom merely changes.

* **Every armature is in REST position.** All 57. The clips animate the bone
  channels and a rest-position armature ignores its pose entirely, so nothing
  moves and nothing says why. This is not an animation setting and appears
  nowhere in the NLA or Action editors: it is `armature.pose_position`.
* **Every rig has its Idle NLA track SOLOED.** Solo overrides the other tracks
  *and* any action you assign, so every clip you measure is silently the idle.
  The tell is different clips reporting identical numbers.
* **The cast is laid out on a grid**, so an animal sits at some large X (the
  raccoon at -50.9). Re-origin it or the exported GLB carries the offset.

## And one the repo imposes

The game authors **+Y forward, +Z up** (`build_new_deer.py`). The pack faces -Y.
`face_forward()` turns the rig and asserts the result, because nothing
downstream can catch it: `measureExcursion` reports a foot's absolute range and
an absolute range has no sign, so a backwards animal measures perfectly and
gallops tail-first.
"""

import math
import bpy
from mathutils import Vector, Matrix

MIN_KNEE_DEG = 14.0     # a limb flatter than this reads as locked


# ─────────────────────────────────────────────────────────────────────────────
#  Opening the pack
# ─────────────────────────────────────────────────────────────────────────────

def open_animal(rig_name, mesh_names, keep_actions_prefix):
    """Isolate one animal and put it in a state that can actually be measured.

    Returns the rig object. Deletes every other object and action, which is not
    only tidiness: `ACTIONS`-mode export tries every action in the file against
    the selected rig, so a Tiger_Run left in `bpy.data` becomes a garbage clip
    on your raccoon. It also shrinks the depsgraph, which matters — with all 845
    objects present the armature was not re-evaluated on frame change at all.
    """
    keep = {rig_name} | set(mesh_names)
    for ob in list(bpy.data.objects):
        if ob.name not in keep:
            bpy.data.objects.remove(ob, do_unlink=True)
    for act in list(bpy.data.actions):
        if not act.name.startswith(keep_actions_prefix):
            bpy.data.actions.remove(act, do_unlink=True)

    rig = bpy.data.objects[rig_name]
    rig.data.pose_position = 'POSE'          # trap 1
    if rig.animation_data:                    # trap 2
        for t in list(rig.animation_data.nla_tracks):
            rig.animation_data.nla_tracks.remove(t)
    rig.location = (0.0, 0.0, 0.0)            # trap 3
    for ob in bpy.data.objects:
        if ob.type == 'MESH' and ob.parent is None:
            ob.location = (0.0, 0.0, 0.0)
    rig.animation_data_create()
    bpy.context.view_layer.update()
    return rig


def purge(keep_mesh_names):
    """Drop every datablock the isolated animal does not use.

    Deleting the OBJECTS is not enough. The pack is one big demo scene, and its
    materials and images survive as unreferenced datablocks that Blender happily
    writes out — the raccoon's working .blend came to 34 MB, of which 33 was
    twenty packed textures for ground, grass, snow, water and a file called
    Cat_Litter.png. The animal itself is 619 vertices.

    Run this immediately before saving, after the clips are authored.
    """
    keep_mats = set()
    for name in keep_mesh_names:
        for m in bpy.data.objects[name].data.materials:
            if m:
                keep_mats.add(m.name)
    for mat in list(bpy.data.materials):
        if mat.name not in keep_mats:
            bpy.data.materials.remove(mat, do_unlink=True)
    keep_imgs = set()
    for mat in bpy.data.materials:
        if mat.use_nodes:
            for n in mat.node_tree.nodes:
                if n.type == 'TEX_IMAGE' and n.image:
                    keep_imgs.add(n.image.name)
    for img in list(bpy.data.images):
        if img.name not in keep_imgs:
            bpy.data.images.remove(img, do_unlink=True)
    for ng in list(bpy.data.node_groups):
        if ng.users == 0:
            bpy.data.node_groups.remove(ng, do_unlink=True)
    # Anything left unreferenced, recursively.
    bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
    return sorted(keep_mats), sorted(keep_imgs)


def frame_view(rig, mesh_names, clip=None, clip_range=None):
    """Leave the saved .blend framed on the animal and ready to play.

    A per-animal file is only useful if opening it puts the animal in front of
    you. The pack lays its cast out on a grid and inherits whatever view was
    last saved, so without this you open a 1.6 MB file containing one raccoon
    and still have to go hunting for it.

    Three things, each of which cost time earlier in this work:

    * **Centre and zoom every 3D view** on the animal's bounding box.
    * **Set the shading to MATERIAL.** Solid shading ignores materials entirely,
      which is why the pack's animals first came up flat grey and looked
      untextured when they were not.
    * **Solo one clip and set the frame range to it.** Every track unmuted means
      the topmost silently wins, which is the confusion the pack itself ships
      with; and a scene range that does not match the clip plays past its end.
    """
    pts = []
    for name in mesh_names:
        ob = bpy.data.objects[name]
        pts += [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    centre = sum(pts, Vector()) / len(pts)
    size = max((max(p[i] for p in pts) - min(p[i] for p in pts)) for i in range(3))

    # Look from front-right-above. `view_rotation` orients the viewpoint, whose
    # +Z points back toward the eye.
    eye = Vector((1.0, -1.5, 0.75)).normalized()
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type != 'VIEW_3D':
                continue
            for sp in area.spaces:
                if sp.type != 'VIEW_3D':
                    continue
                sp.shading.type = 'MATERIAL'
                sp.region_3d.view_location = centre
                sp.region_3d.view_distance = size * 2.6
                sp.region_3d.view_rotation = eye.to_track_quat('Z', 'Y')
                sp.region_3d.view_perspective = 'PERSP'

    for ob in bpy.context.selected_objects:
        ob.select_set(False)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig

    if clip:
        # `is_solo` is EXCLUSIVE, so assigning False to a track after assigning
        # True to another clears the whole solo state. Set the others down
        # first and the one you want LAST. A one-line loop reads correctly and
        # silently does nothing; this is the second time it has bitten.
        for t in rig.animation_data.nla_tracks:
            if t.name != clip:
                t.is_solo = False
        rig.animation_data.nla_tracks[clip].is_solo = True
        if clip_range:
            bpy.context.scene.frame_start, bpy.context.scene.frame_end = clip_range
            bpy.context.scene.frame_set(clip_range[0])
    return centre, size


def face_forward(rig, head_bone):
    """Turn the animal to +Y and assert it. See the module docstring."""
    rig.rotation_euler.z += math.pi
    bpy.context.view_layer.update()
    head = rig.matrix_world @ rig.data.bones[head_bone].head_local
    assert head.y > 0, f"still faces -Y after the turn ({head_bone} y={head.y:.3f})"
    return head


def play(rig, action_name):
    """Assign an action so it actually evaluates.

    In Blender 4.4+ an action carries SLOTS and assigning `action` alone leaves
    `action_slot` at None, which evaluates to nothing. Assigning the slot is not
    optional, and its absence looks exactly like a broken clip.
    """
    act = bpy.data.actions[action_name]
    rig.animation_data.action = act
    if act.slots:
        rig.animation_data.action_slot = act.slots[0]
    return act


# ─────────────────────────────────────────────────────────────────────────────
#  Posing
# ─────────────────────────────────────────────────────────────────────────────

def rx(deg):
    """Rotation about world +X. With the animal facing -Y in the .blend, a
    positive angle pitches a forward-pointing bone DOWN and a backward-pointing
    one (a tail) UP — the same rotation seen from either end."""
    return Matrix.Rotation(math.radians(deg), 3, 'X')


def rz(deg):
    return Matrix.Rotation(math.radians(deg), 3, 'Z')


def point(pb, direction):
    """Aim a pose bone's +Y down `direction`, preserving roll.

    Rotating the REST orientation by the minimal turn from rest-forward to the
    new forward is what keeps the roll; a fresh track quaternion spins the bone
    about its own axis wherever world up flips. It also means the bone's own
    local axes never enter the arithmetic — which is the only reason a thigh
    whose local X is 180 degrees off world X causes no trouble.
    """
    rest = pb.bone.matrix_local
    d_rest = (rest.to_3x3() @ Vector((0, 1, 0))).normalized()
    q = d_rest.rotation_difference(direction.normalized())
    m = (q.to_matrix() @ rest.to_3x3()).to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m
    bpy.context.view_layer.update()


def clear(rig):
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix()
    bpy.context.view_layer.update()


def reach_limit(l1, l2):
    """Furthest a two-link chain may extend and keep MIN_KNEE_DEG of bend."""
    return math.sqrt(l1 * l1 + l2 * l2
                     + 2 * l1 * l2 * math.cos(math.radians(MIN_KNEE_DEG)))


def ik2(hip, target, l1, l2, bend):
    """Two-link IK; `bend` is the direction the knee is pushed toward.

    Clamps the TARGET, never the chain. Clamping the hip-to-ankle vector
    shortens the drop as well as the reach, so the foot rises off the ground at
    the extremes of its own stance — a skate that looks like a solver bug and is
    really a reach shortfall being hidden.
    """
    u = target - hip
    d = u.length
    lo = abs(l1 - l2) + 1e-4
    hi = reach_limit(l1, l2)
    if d < lo:
        u = u.normalized() * lo if d > 1e-6 else Vector((0, 0, -lo))
        d = lo
    elif d > hi:
        u = u.normalized() * hi
        d = hi
    un = u / d
    a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
    h = math.sqrt(max(l1 * l1 - a * a, 0.0))
    b = bend - un * bend.dot(un)
    if b.length < 1e-6:
        b = Vector((0, 0, -1)) - un * un.z
    return hip + un * a + b.normalized() * h


def local_translation(pb, world_delta):
    """Convert a WORLD offset into the value `pose_bone.location` wants.

    `location` is in the bone's own space, and a bone's local axes are almost
    never world axes — a `Root` that points straight up has its local Y along
    world Z, so writing `location.z` slides the animal sideways instead of
    lowering it. That bug is invisible in a still and reads as a solver that
    will not converge: crouching the body to buy stride made the solved sweep
    go DOWN, because the body was never coming down.
    """
    m = pb.bone.matrix_local.to_3x3()
    return m.inverted() @ Vector(world_delta)


def ease(t):
    """Smoothstep, so a move starts and stops rather than snapping into a
    constant rate the instant the clip begins."""
    return t * t * (3.0 - 2.0 * t)


# ─────────────────────────────────────────────────────────────────────────────
#  Keying
# ─────────────────────────────────────────────────────────────────────────────

def key(rig, bones, frame, loc=()):
    """Key rotation on `bones` at `frame`, and location on any in `loc`.

    Key EVERY frame you solve. Blender interpolates JOINT ANGLES between keys,
    and an angle midway between two solved poses does not put the foot midway
    between two solved positions — at one key in four a planted paw sank 55 mm
    through the floor. It is free downstream: `export_bake_animation` resamples
    per frame whatever the .blend holds.
    """
    for name in bones:
        pb = rig.pose.bones[name]
        pb.keyframe_insert(
            "rotation_quaternion" if pb.rotation_mode == 'QUATERNION'
            else "rotation_euler", frame=frame, group=name)
        if name in loc:
            pb.keyframe_insert("location", frame=frame, group=name)


def new_action(rig, name, length):
    """A fresh action with its OWN frame range.

    Without `use_frame_range` the exporter stamps the scene's range onto every
    clip and a 9-frame trot arrives as long as a 289-frame idle.
    """
    old = bpy.data.actions.get(name)
    if old:
        bpy.data.actions.remove(old, do_unlink=True)
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data_create()
    rig.animation_data.action = act
    if act.slots:
        rig.animation_data.action_slot = act.slots[0]
    act.use_frame_range = True
    act.frame_start, act.frame_end = 1, 1 + length
    return act


def sample(rig, act, frame):
    """Evaluate `act` at `frame` and return the posed rig. Assigns the slot."""
    rig.animation_data.action = act
    if act.slots and rig.animation_data.action_slot is None:
        rig.animation_data.action_slot = act.slots[0]
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    return rig


def seam(rig, act, length):
    """How far the pose at the last frame is from the pose at the first."""
    sample(rig, act, 1)
    first = {pb.name: pb.matrix.copy() for pb in rig.pose.bones}
    sample(rig, act, 1 + length)
    last = {pb.name: pb.matrix.copy() for pb in rig.pose.bones}
    return max((first[k].translation - last[k].translation).length for k in first)
