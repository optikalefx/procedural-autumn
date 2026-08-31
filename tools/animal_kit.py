"""animal_kit — the shared Blender toolbox for the hand-authored cast.

`build_bear_reference.py` and `build_fox_reference.py` each carried their own
copy of the same twelve helpers, and the two copies had already drifted. This
module is that toolbox, extracted once, so a new animal is a page of numbers
about THAT animal and nothing else.

Run every build script headlessly, never against a file the artist has open::

    /Applications/Blender.app/Contents/MacOS/Blender --factory-startup -b \\
        --python tools/build_<species>_reference.py

Conventions, and they are not negotiable — `glb_rig.js` and every harness in
`tools/` assume them:

* **+Y is forward, +Z is up**, and the feet rest on Z = 0.
* **24 fps.** Clip lengths are whole frames at 24.
* Bone names are the canonical set (`BONES`). Blender's glTF exporter strips
  the dots, so `hind_foot.L` reaches three.js as `hind_footL` — which is what
  a species file's `glb.feet` has to name.
* `root` is a **non-deforming** ground control. Locomotion is authored **in
  place**: the feet cycle, the body does not travel. `glb_rig.js` measures how
  much ground one cycle covers off the planted foot and derives the species'
  speed from it.
* Every clip **closes**: the pose at `frame_end` is the pose at `frame_start`,
  key for key. That closing duplicate is what lets an engine wrap without a
  hitch.

Blender 5.2 note: `Action.fcurves` is gone. Actions are layered/slotted now,
and `fcurves_of(action)` below is the replacement — reach for it rather than
the 4.x attribute, which raises `AttributeError` and looks like a missing
action.
"""

from __future__ import annotations

import math
import re
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

ROOT = Path(__file__).resolve().parents[1]
FPS = 24

# ── the canonical skeleton ───────────────────────────────────────────────────
#
# Every hand-authored mammal wears the same bone names. That is what lets one
# gait generator, one exporter, one species-file shape and one set of harnesses
# serve the whole cast — and it is why `glb.feet` reads the same in every file.
#
# `root` does not deform. `*_toe.*` do not deform either: they exist so the
# paw can roll over its toe through a stance without dragging the mesh.
CORE = ["root", "pelvis", "spine_01", "chest", "neck_01", "neck_02", "head", "jaw"]
EARS = ["ear.L", "ear.R"]
LEGS = [f"{a}_{b}.{s}"
        for s in ("L", "R")
        for a in ("fore", "hind")
        for b in ("upper", "lower", "foot", "toe")]
SCAPS = ["scapula.L", "scapula.R"]
TAIL2 = ["tail_01", "tail_02"]
BONES = CORE + EARS + SCAPS + LEGS + TAIL2


def bones_for(tail_links=2):
    """The expected bone set for a rig with a tail of `tail_links` links.
    Pass the result to `validate(..., expect_bones=...)`."""
    return CORE + EARS + SCAPS + LEGS + [f"tail_{i + 1:02d}" for i in range(tail_links)]

NON_DEFORM = {"root"} | {b for b in LEGS if b.endswith("toe.L") or b.endswith("toe.R")}


# ── scene ────────────────────────────────────────────────────────────────────

def clear_scene():
    """Start from a known-empty file. Safe to call at the top of any build."""
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for data in (bpy.data.actions, bpy.data.armatures, bpy.data.cameras,
                 bpy.data.curves, bpy.data.lights, bpy.data.materials,
                 bpy.data.meshes, bpy.data.texts):
        for block in list(data):
            if block.users == 0:
                data.remove(block)


def material(name, color, roughness=0.78, specular=0.24):
    """A flat Principled material.

    The whole cast ships **untextured** — one `baseColorFactor` per material —
    because that is what makes a coat variant a recolour of one mesh instead of
    a second export. See `buildCoat` in `glb_rig.js`.

    `color` is **linear** RGB, which is what glTF stores and what three hands
    back. Writing sRGB hex here shifts every morph quietly.
    """
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color, 1.0)
        bsdf.inputs["Roughness"].default_value = roughness
        s = bsdf.inputs.get("Specular IOR Level")
        if s:
            s.default_value = specular
    return mat


# ── primitives ───────────────────────────────────────────────────────────────
#
# Volumes deliberately OVERLAP. The finished animal is one continuous fused
# silhouette, not a bag of primitives, and two shapes that merely touch at an
# angled end plane remesh into a pinched hourglass.

def uv(name, location, scale, segments=16, rings=10):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings,
                                         location=location)
    ob = bpy.context.object
    ob.name = name
    ob.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return ob


def cone(name, location, radius1, radius2, depth, rotation=(0, 0, 0), vertices=14):
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius1,
                                    radius2=radius2, depth=depth,
                                    location=location, rotation=rotation)
    ob = bpy.context.object
    ob.name = name
    return ob


def ellipsoid_between(name, a, b, width, depth=None, overlap=1.12, segments=16, rings=10):
    """A soft capsule whose local Z follows a -> b. Rounded, so it buries into
    the torso without leaving a flat cap as a visible shelf."""
    a, b = Vector(a), Vector(b)
    delta = b - a
    depth = width if depth is None else depth
    ob = uv(name, (a + b) * 0.5, (width, depth, delta.length * 0.5 * overlap), segments, rings)
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = delta.to_track_quat("Z", "Y")
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    ob.rotation_mode = "XYZ"
    return ob


def tapered_between(name, a, b, radius_a, radius_b, depth=None, vertices=14):
    """A tapered elliptical volume along a -> b. Use for shanks, muzzles,
    horns and antler tines; pair it with a `uv` at each end for the joint."""
    a, b = Vector(a), Vector(b)
    delta = b - a
    depth = radius_a if depth is None else depth
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=1.0,
                                    radius2=radius_b / max(radius_a, 1e-6),
                                    depth=delta.length, location=(a + b) * 0.5)
    ob = bpy.context.object
    ob.name = name
    ob.scale = (radius_a, depth, 1.0)
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = delta.to_track_quat("Z", "Y")
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    ob.rotation_mode = "XYZ"
    return ob


def limb(prefix, joints, radii, overlap=1.30, joint_pad=1.06):
    """One leg as a chain of capsules WITH a ball at every interior joint.

    `joints` is [shoulder, elbow, wrist, toe], `radii` the radius at each. The
    balls are the point: a frustum that merely meets another at an angle
    remeshes into a pinched hourglass, and flesh around an elbow is what makes
    a limb read as one continuous anatomical form rather than two sticks.
    """
    out = []
    for i in range(len(joints) - 1):
        a, b = joints[i], joints[i + 1]
        ra, rb = radii[i], radii[i + 1]
        out.append(tapered_between(f"{prefix} seg{i}", a, b, ra, rb, ra))
    for i in range(1, len(joints) - 1):
        r = radii[i] * joint_pad
        out.append(uv(f"{prefix} joint{i}", joints[i], (r, r, r), 12, 8))
    return out


def aim(ob, target):
    ob.rotation_euler = (Vector(target) - ob.location).to_track_quat("-Z", "Y").to_euler()


def add_area(name, location, energy, size, color, target=(0, 0.05, 1.0)):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    data.color = color
    ob = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(ob)
    ob.location = location
    aim(ob, target)
    return ob


def mirror_x(ob, name):
    """Duplicate a part across the centreline. Cheaper than authoring both, and
    it makes a left/right mismatch impossible."""
    new = ob.copy()
    new.data = ob.data.copy()
    new.name = name
    bpy.context.collection.objects.link(new)
    new.matrix_world = Matrix.Scale(-1, 4, (1, 0, 0)) @ ob.matrix_world
    bpy.context.view_layer.objects.active = new
    bpy.ops.object.select_all(action="DESELECT")
    new.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    # A negative scale flips the winding; recover outward normals.
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    return new


# ── fusing ───────────────────────────────────────────────────────────────────

def fuse(parts, name, voxel=0.042, smooth=(0.28, 4), decimate=0.34):
    """Join, voxel-remesh, soften and decimate a pile of volumes into one
    continuous smooth-shaded body.

    This is the house look and the whole reason the primitives overlap. Voxel
    size is the one number to tune per animal: it has to be small enough that
    an ear or a shank survives, and large enough that the seams fuse. Divide
    the thinnest feature you must keep by about three.
    """
    bpy.ops.object.select_all(action="DESELECT")
    for ob in parts:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    body = bpy.context.object
    body.name = name

    m = body.modifiers.new("Fused organic silhouette", "REMESH")
    m.mode = "VOXEL"
    m.voxel_size = voxel
    m.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=m.name)

    if smooth:
        m = body.modifiers.new("Soften fused volume seams", "SMOOTH")
        m.factor, m.iterations = smooth
        bpy.ops.object.modifier_apply(modifier=m.name)

    if decimate:
        m = body.modifiers.new("Intentional low-poly facets", "DECIMATE")
        m.ratio = decimate
        bpy.ops.object.modifier_apply(modifier=m.name)

    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    for poly in body.data.polygons:
        poly.use_smooth = True
    return body


def decimate_planar(body, angle_deg=10.0, delimit=("MATERIAL",)):
    """Reduce a fused body WITHOUT destroying its markings.

    Call this **after** `paint`, with `fuse(..., decimate=None)`.

    The ordinary `DECIMATE` modifier is a COLLAPSE, and a collapse has no notion
    of a material boundary: it merges whichever edge is cheapest, cheerfully
    across the edge of a bib or a mask, and it is free to make one long thin
    triangle spanning two pieces of anatomy. That is the single root cause of
    two defects reported independently on four different animals in this cast —
    every marking boundary coming back as a polygon staircase, and flank facets
    that read as damage rather than as style. Painting before the decimate does
    not help, because the collapse does not know the paint is there.

    A planar DISSOLVE delimited by `MATERIAL` cannot cross a marking, and only
    removes an edge between faces already within `angle_deg` of coplanar — so it
    never invents a crease the form does not have. It is not a ratio, so it
    reduces less predictably than a collapse; `angle_deg` is the dial, and a
    couple of degrees is worth a lot of triangles.

    One thing it does NOT fix: the boundary is then crisp but sits on the voxel
    grid, which reads as a regular staircase. Wobble the marking threshold in
    `paint`'s rule by about one voxel, at two frequencies, and the steps stop
    lining up — which is also what a real fur margin looks like.
    """
    m = body.modifiers.new("Planar dissolve", "DECIMATE")
    m.decimate_type = "DISSOLVE"
    m.angle_limit = math.radians(angle_deg)
    m.delimit = set(delimit)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.modifier_apply(modifier=m.name)
    return len(body.data.polygons)


def shell_count(body):
    """How many disconnected islands the mesh is in.

    A fused animal is **one**. Anything more is a volume that grazed its
    neighbour instead of intersecting it and remeshed as its own blob — which is
    invisible in every measurement and obvious in every render. The fox grew two
    loose ellipsoids on the ground under it this way, from paw volumes placed
    just forward of the toe joint.

    Assert on it: `assert shell_count(body) == 1`.
    """
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(body.data)
    seen, islands = set(), 0
    for v in bm.verts:
        if v.index in seen:
            continue
        islands += 1
        stack = [v]
        seen.add(v.index)
        while stack:
            cur = stack.pop()
            for e in cur.link_edges:
                o = e.other_vert(cur)
                if o.index not in seen:
                    seen.add(o.index)
                    stack.append(o)
    bm.free()
    return islands


def paint(body, mats, rule):
    """Assign material regions by face centre.

    `mats` is the ordered material list; `rule(center, normal) -> index` picks
    one per face. Painting after the fuse is what keeps a mask (a fox's bib, a
    raccoon's mask, an eagle's white head) a crisp region on a continuous mesh.
    """
    body.data.materials.clear()
    for m in mats:
        body.data.materials.append(m)
    for poly in body.data.polygons:
        poly.use_smooth = True
        poly.material_index = max(0, min(len(mats) - 1, rule(poly.center, poly.normal)))


# ── rig ──────────────────────────────────────────────────────────────────────

def add_bone(arm, name, head, tail, parent=None, deform=True):
    b = arm.edit_bones.new(name)
    b.head, b.tail = Vector(head), Vector(tail)
    b.use_deform = deform
    if parent:
        b.parent = arm.edit_bones[parent]
    return b


def build_rig(body, prefix, spec):
    """The canonical quadruped skeleton, from a page of joint positions.

    `spec` keys, every one a world-space point in the build's own units:

        root        (head, tail)      non-deforming ground control
        pelvis spine chest neck_01 neck_02 head jaw   (head, tail) each
        ear         (head, tail) for .L; .R is mirrored in X
        fore/hind   {"L": (shoulder, elbow, wrist, toe_tip), ...}
        scapula     (head, tail) for .L, mirrored — attaches fore to chest
        tail_01/02  (head, tail) each

    Bone names are fixed (`BONES`) because everything downstream reads them.
    """
    arm = bpy.data.armatures.new(f"{prefix}_Rig_Data")
    rig = bpy.data.objects.new(f"{prefix}_Rig", arm)
    bpy.context.collection.objects.link(rig)
    rig.show_in_front = True
    arm.display_type = "BBONE"
    rig["forward_axis"] = "+Y"
    rig["up_axis"] = "+Z"
    rig["ground_z"] = 0.0
    rig["authored_fps"] = FPS
    rig["animation_contract"] = (
        "In-place loops; root is a ground control; every clip closes on its "
        "first pose; preserve bone names (the glTF exporter strips the dots).")

    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    add_bone(arm, "root", *spec["root"], deform=False)
    chain = [("pelvis", "root"), ("spine_01", "pelvis"), ("chest", "spine_01"),
             ("neck_01", "chest"), ("neck_02", "neck_01"), ("head", "neck_02"),
             ("jaw", "head")]
    for name, parent in chain:
        add_bone(arm, name, *spec[name], parent)

    eh, et = spec["ear"]
    add_bone(arm, "ear.L", eh, et, "head")
    add_bone(arm, "ear.R", (-eh[0], eh[1], eh[2]), (-et[0], et[1], et[2]), "head")

    sh, st = spec["scapula"]
    add_bone(arm, "scapula.L", sh, st, "chest")
    add_bone(arm, "scapula.R", (-sh[0], sh[1], sh[2]), (-st[0], st[1], st[2]), "chest")

    for side in ("L", "R"):
        sgn = 1 if side == "L" else -1
        for kind, parent in (("fore", f"scapula.{side}"), ("hind", "pelvis")):
            a, b, c, t = [Vector((sgn * p[0], p[1], p[2])) for p in spec[kind]["L"]]
            add_bone(arm, f"{kind}_upper.{side}", a, b, parent)
            add_bone(arm, f"{kind}_lower.{side}", b, c, f"{kind}_upper.{side}")
            add_bone(arm, f"{kind}_foot.{side}", c, t, f"{kind}_lower.{side}")
            add_bone(arm, f"{kind}_toe.{side}", t,
                     t + Vector((0, (t - c).y * 0.6 + 0.10, -0.02)),
                     f"{kind}_foot.{side}", deform=False)

    # The tail is the one chain whose length is the animal's business. Two
    # links carry a bear's nub or a deer's flag; a fox's brush and a squirrel's
    # plume need four, or the whole tail swings as one rigid paddle. Pass
    # `spec["tail"]` as a list of (head, tail) pairs; `spec["tail_01"]` /
    # `spec["tail_02"]` remain as the two-link shorthand.
    tail = spec.get("tail")
    if tail is None:
        tail = [spec["tail_01"], spec["tail_02"]]
    for i, (h, t) in enumerate(tail):
        name = f"tail_{i + 1:02d}"
        add_bone(arm, name, h, t, "pelvis" if i == 0 else f"tail_{i:02d}")
    rig["tail_links"] = len(tail)
    bpy.ops.object.mode_set(mode="OBJECT")

    body.parent = rig
    body.matrix_parent_inverse = rig.matrix_world.inverted()
    mod = body.modifiers.new("Armature", "ARMATURE")
    mod.object = rig
    for pb in rig.pose.bones:
        pb.rotation_mode = "XYZ"
    return rig


def segment_distance(p, a, b):
    p, a, b = Vector(p), Vector(a), Vector(b)
    ab = b - a
    if ab.length_squared < 1e-9:
        return (p - a).length
    t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (p - (a + ab * t)).length


def weight_body(body, rig, regions, sigma_default=0.42, top=3):
    """Region-aware nearest-segment skinning.

    Pure nearest-bone weighting makes a belly follow a nearby thigh and a cheek
    follow an ear. `regions(co) -> (candidate bone names, sigma)` narrows the
    field first; distance then picks among them, so joint rims still share two
    or three groups and the deform stays organic.
    """
    deform = {b.name: b for b in rig.data.bones if b.use_deform}
    groups = {n: body.vertex_groups.new(name=n) for n in deform}
    for v in body.data.vertices:
        cands, sigma = regions(v.co)
        sigma = sigma or sigma_default
        scored = []
        for n in cands:
            b = deform.get(n)
            if not b:
                continue
            d = segment_distance(v.co, b.head_local, b.tail_local)
            scored.append((n, math.exp(-((d / sigma) ** 2)) + 1e-8))
        if not scored:
            scored = [("pelvis", 1.0)]
        scored.sort(key=lambda x: x[1], reverse=True)
        scored = scored[:top]
        total = sum(s for _, s in scored)
        for n, s in scored:
            groups[n].add([v.index], s / total, "REPLACE")


def default_regions(spec, body_split=None):
    """A serviceable `regions` for a standard quadruped, derived from the rig
    spec. Override per animal where the silhouette needs it — a fox's brush and
    a bear's hump want different fields."""
    neck_y = spec["neck_01"][0][1]
    head_y = spec["head"][0][1]
    jaw_y = spec["jaw"][0][1]
    chest_y = spec["chest"][0][1]
    pelvis_y = spec["pelvis"][0][1]
    ear_z = spec["ear"][0][2]
    tail_y = spec["tail_01"][0][1]
    belly_z = body_split if body_split is not None else spec["fore"]["L"][1][2]
    fore_x = abs(spec["fore"]["L"][0][0])

    def regions(co):
        x, y, z = co
        side = "L" if x > 0 else "R"
        if z > ear_z and y > neck_y and abs(x) > fore_x * 0.35:
            return [f"ear.{side}", "head"], 0.28
        if y > head_y:
            if y > jaw_y and z < spec["head"][0][2]:
                return ["jaw", "head"], 0.30
            return ["head", "neck_02", "neck_01"], 0.38
        if y < tail_y and abs(x) < fore_x * 0.7 and z > belly_z:
            return ["tail_01", "tail_02", "pelvis"], 0.28
        if z < belly_z and abs(x) > fore_x * 0.45:
            if y > (chest_y + pelvis_y) * 0.5:
                return [f"scapula.{side}", f"fore_upper.{side}",
                        f"fore_lower.{side}", f"fore_foot.{side}"], 0.30
            return [f"hind_upper.{side}", f"hind_lower.{side}",
                    f"hind_foot.{side}", "pelvis"], 0.30
        if y > chest_y:
            return ["chest", "neck_01", "neck_02"], 0.46
        return ["pelvis", "spine_01", "chest"], 0.50

    return regions


def bone_parent(ob, rig, bone_name, world=None):
    world = ob.matrix_world.copy() if world is None else world
    ob.parent = rig
    ob.parent_type = "BONE"
    ob.parent_bone = bone_name
    ob.matrix_world = world


# ── actions ──────────────────────────────────────────────────────────────────

def fcurves_of(action):
    """Blender 5.x actions are layered and slotted; `Action.fcurves` is gone."""
    out = []
    for layer in action.layers:
        for strip in layer.strips:
            for bag in getattr(strip, "channelbags", []):
                out.extend(bag.fcurves)
    return out


def new_action(rig, name, start, end, description=""):
    """Make `name` the rig's live action, with its own manual frame range.

    The manual range is not decoration: the exporter reads it, and without it
    every clip comes out the length of the SCENE range instead of its own.
    """
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    act.use_frame_range = True
    act.frame_start, act.frame_end = start, end
    act["loop"] = True
    act["duration_frames"] = end - start
    act["description"] = description
    if not rig.animation_data:
        rig.animation_data_create()
    rig.animation_data.action = act
    sc = bpy.context.scene
    sc.render.fps = FPS
    sc.frame_start, sc.frame_end = int(start), int(end)
    return act


def rot_path(pb):
    """Which rotation property this bone actually uses.

    `rotation_mode` belongs to the pose BONE, not to the action, and a rig can
    mix modes freely. The shipped fox has 18 quaternion bones and 13 euler ones,
    and all six of its clips key both properties.

    This matters because writing the wrong one is **silent**. Forcing every bone
    to XYZ so a new clip could key eulers left `rotation_quaternion` inert on
    those 18 bones: the signed-off `Stand`, `graze` and `alert` came back with
    their legs holding stale euler values, and the idle fox floated 5.1 cm off
    the ground. Nothing threw. Never set `rotation_mode` in a build — read it.
    """
    return "rotation_quaternion" if pb.rotation_mode == "QUATERNION" else "rotation_euler"


def set_rot(pb, deg):
    """Pose a bone from an XYZ euler in DEGREES, whatever mode it is in."""
    e = Euler([math.radians(v) for v in deg], "XYZ")
    if pb.rotation_mode == "QUATERNION":
        pb.rotation_quaternion = e.to_quaternion()
    elif pb.rotation_mode == "AXIS_ANGLE":
        q = e.to_quaternion()
        pb.rotation_axis_angle = (q.angle, *q.axis)
    else:
        # Honour ZYX, YXZ and the rest rather than assuming XYZ.
        pb.rotation_euler = e.to_matrix().to_euler(pb.rotation_mode)


def key_rot(pb, frame):
    """Key whichever rotation channel this bone actually drives."""
    pb.keyframe_insert(rot_path(pb), frame=frame, group=pb.name)


def unwrap_quaternions(action):
    """Fix quaternion double-cover across a clip's keys.

    q and -q are the same orientation, and Blender hands back whichever it likes
    when you read `pose_bone.matrix`. Two neighbouring keys that land on opposite
    sides slerp **the long way**: a limb takes a 300 degree detour between two
    frames that look a quarter-turn apart, which reads as the rig snapping.

    Walk each 4-channel group in key order and negate any key whose dot with its
    predecessor is negative. Run this BEFORE `close_action` and `cyclic_handles`,
    so the seam is fixed against the unwrapped values.
    """
    groups = {}
    for fc in fcurves_of(action):
        if not fc.data_path.endswith("rotation_quaternion"):
            continue
        groups.setdefault(fc.data_path, {})[fc.array_index] = fc
    for path, chans in groups.items():
        if len(chans) != 4:
            continue
        kps = [chans[i].keyframe_points for i in range(4)]
        n = min(len(k) for k in kps)
        for i in range(1, n):
            dot = sum(kps[c][i].co.y * kps[c][i - 1].co.y for c in range(4))
            if dot >= 0:
                continue
            for c in range(4):
                k = kps[c][i]
                k.co.y = -k.co.y
                k.handle_left.y = -k.handle_left.y
                k.handle_right.y = -k.handle_right.y
        for c in range(4):
            chans[c].update()


def local_translation(pb, world_delta):
    """A world-space offset expressed in a bone's own `location` channel.

    **Do not write `location` directly.** A bone's local axes run head-to-tail,
    so a `root` authored standing on end (head->tail along +Z, as the fox's and
    the bear's both are) has local Y along world +Z and local Z along world -Y.
    Writing a vertical bob to `location[2]` then translates the animal
    BACKWARDS out of its own feet — and because the reach budget is measured
    from the posed hip, every stride afterwards fits at 0.000 units. It looks
    like a rig that cannot walk rather than like a typo.

    Going through the rest matrix is right for any orientation, axis-aligned or
    not, which picking the nearest axis is not.
    """
    return pb.bone.matrix_local.to_3x3().inverted() @ Vector(world_delta)


class Keyer:
    """Keyframe helper. Angles are DEGREES — radians in a page of pose numbers
    is how a 0.3 becomes a shrug instead of a twitch.

    Mode-aware: it keys `rotation_quaternion` on a quaternion bone and
    `rotation_euler` on an euler one, and it never changes a bone's mode. See
    `rot_path` for why that is not a nicety.
    """

    def __init__(self, rig):
        self.rig = rig
        self.scene = bpy.context.scene

    def rot(self, bone, keys):
        pb = self.rig.pose.bones[bone]
        for frame, deg in keys:
            self.scene.frame_set(int(frame))
            set_rot(pb, deg)
            key_rot(pb, frame)

    def loc(self, bone, keys):
        pb = self.rig.pose.bones[bone]
        for frame, val in keys:
            self.scene.frame_set(int(frame))
            pb.location = val
            pb.keyframe_insert("location", frame=frame, group=bone)

    def hold(self, bone, deg, frames):
        self.rot(bone, [(f, deg) for f in frames])


def cyclic_handles(action, period=None):
    """Rebuild every bezier handle from **wrapped** neighbours.

    Blender's auto handles cannot see across a loop, so it flattens the first
    and last key of every channel by construction. The whole rig then
    decelerates at the seam at once — a hitch every cycle with no discontinuity
    anywhere to point at. Measured on the fox's walk: 0.0012 across the seam
    against 0.0459 mid-cycle, 38x slower.

    Prefer the narrowest fix that works: rebuilding all handles fixed that seam
    but dragged mid-cycle velocity from 0.0463 to 0.0393, a change to motion
    already signed off. Use `seam_handles` when only the ends are wrong.
    """
    for fc in fcurves_of(action):
        kps = fc.keyframe_points
        n = len(kps)
        if n < 3:
            continue
        p = period or (kps[-1].co.x - kps[0].co.x)
        for i in range(n):
            prev = kps[(i - 1) % n]
            nxt = kps[(i + 1) % n]
            px, pv = prev.co.x, prev.co.y
            nx, nv = nxt.co.x, nxt.co.y
            if i == 0:
                px -= p
            if i == n - 1:
                nx += p
            span = max(nx - px, 1e-6)
            slope = (nv - pv) / span
            k = kps[i]
            k.handle_left_type = k.handle_right_type = "FREE"
            dl = (k.co.x - px) / 3.0
            dr = (nx - k.co.x) / 3.0
            k.handle_left = (k.co.x - dl, k.co.y - slope * dl)
            k.handle_right = (k.co.x + dr, k.co.y + slope * dr)


def seam_handles(action, period=None):
    """The seam-only version of `cyclic_handles`: touch the first and last key
    of each channel and leave every interior frame bit-identical."""
    for fc in fcurves_of(action):
        kps = fc.keyframe_points
        n = len(kps)
        if n < 3:
            continue
        p = period or (kps[-1].co.x - kps[0].co.x)
        for i in (0, n - 1):
            prev = kps[(i - 1) % n]
            nxt = kps[(i + 1) % n]
            px, nx = prev.co.x, nxt.co.x
            if i == 0:
                px -= p
            else:
                nx += p
            slope = (nxt.co.y - prev.co.y) / max(nx - px, 1e-6)
            k = kps[i]
            k.handle_left_type = k.handle_right_type = "FREE"
            dl = (k.co.x - px) / 3.0
            dr = (nx - k.co.x) / 3.0
            k.handle_left = (k.co.x - dl, k.co.y - slope * dl)
            k.handle_right = (k.co.x + dr, k.co.y + slope * dr)


# ── the gait generator ───────────────────────────────────────────────────────
#
# This is the piece that makes eight animals tractable. Hand-keying four legs
# by eye produces feet that skate and knees that lock; solving a foot path
# against a two-link IK produces a leg that is planted while it is planted and
# swings through a real arc when it is not, for any leg geometry.

def rest_extension(rig):
    """How much of each leg's reach the REST pose has already spent.

    This is the first number to look at when a gait comes out short, and it is
    the one that is invisible in a render. A leg standing at 97% of its own
    reach has 3% left to spend on a stride, so every step asks for ground the
    chain cannot cover — the solver clamps, the knee goes dead straight, and the
    animal shuffles. The shipped Blender bear measured exactly that: 97.7%, and
    a 1.25 m stride collapsed to 0.28 m.

    **Aim for 0.82-0.88.** That is not a style preference; it is where a
    quadruped's standing pose actually sits, and it leaves the half-span
    `sqrt(L^2 - h^2)` that a real stride needs. `src/wildlife/mammals/bear.js`
    tells the same story from the procedural side — its blueprint was corrected
    from 0.94 to 0.82 for this exact reason.

    Lower the body or lengthen the legs; do not shorten the stride and call it
    a slow animal.
    """
    out = {}
    for kind in ("fore", "hind"):
        for side in ("L", "R"):
            up = rig.pose.bones[f"{kind}_upper.{side}"]
            lo = rig.pose.bones[f"{kind}_lower.{side}"]
            ft = rig.pose.bones[f"{kind}_foot.{side}"]
            h = up.bone.head_local
            k = lo.bone.head_local
            a = ft.bone.head_local
            l1, l2 = (k - h).length, (a - k).length
            d1 = (k - h).normalized()
            d2 = (a - k).normalized()
            knee = math.degrees(d1.angle(d2))
            out[f"{kind}{side}"] = dict(
                extension=(a - h).length / max(l1 + l2, 1e-6),
                knee=knee, l1=l1, l2=l2, drop=(a - h).length)
    out["extension"] = max(v["extension"] for v in out.values() if isinstance(v, dict))
    return out


def reach_limit(l1, l2, min_knee_deg):
    """The furthest a two-link leg may be extended and still keep `min_knee_deg`
    of bend at the knee.

    Knee angle here is the angle BETWEEN the two bone directions, so 0 is dead
    straight — the same convention `author_gait`'s diagnostics report. Law of
    cosines on the interior angle (180 - knee) gives

        d^2 = l1^2 + l2^2 + 2*l1*l2*cos(knee)

    which is `l1 + l2` at knee 0, as it must be. Below about 12 degrees a leg
    reads as locked, and a locked chain is the defect that made the procedural
    bear's forelegs rake back until they were inside its own barrel.
    """
    c = math.cos(math.radians(min_knee_deg))
    return math.sqrt(l1 * l1 + l2 * l2 + 2 * l1 * l2 * c)


def _ik2(hip, target, l1, l2, bend, hi=None):
    """Two-link IK. `bend` is the direction the knee is pushed toward."""
    u = target - hip
    d = u.length
    lo = abs(l1 - l2) + 1e-4
    hi = (l1 + l2 - 1e-4) if hi is None else min(hi, l1 + l2 - 1e-4)
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


def _point_bone(pb, direction):
    """Aim a pose bone's +Y down `direction` (armature space), preserving roll.

    Rotating the REST orientation by the minimal turn from rest-forward to the
    new forward is what preserves roll. Building a fresh track-quat instead
    would spin the bone about its own axis wherever the world up flips.
    """
    rest = pb.bone.matrix_local
    d_rest = (rest.to_3x3() @ Vector((0, 1, 0))).normalized()
    q = d_rest.rotation_difference(direction.normalized())
    m = (q.to_matrix() @ rest.to_3x3()).to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m
    bpy.context.view_layer.update()


LATERAL_WALK = {"hindL": 0.00, "foreL": 0.25, "hindR": 0.50, "foreR": 0.75}
DIAGONAL_TROT = {"hindL": 0.00, "foreR": 0.00, "hindR": 0.50, "foreL": 0.50}
# A gallop's TYPE is decided by which side leads front and back. The lead limb
# is the one that lands SECOND of its pair, so here the lead hind is R (0.12
# after L's 0.00) — and for a **rotary** gallop the lead fore must therefore be
# the opposite side, L. An earlier cut had the fores the other way round, which
# put both leads on the same side: that is a **transverse** gallop, the slower
# cantering pattern a horse uses, and it shipped under this name for the whole
# first round of the cast. Dogs, foxes, cats and every fast quadruped in this
# valley gallop rotary. One swapped pair is the difference between an animal
# fleeing and an animal loping.
ROTARY_GALLOP = {"hindL": 0.00, "hindR": 0.12, "foreR": 0.48, "foreL": 0.60}

# The transverse gallop, kept because it is a real gait and not a mistake: both
# leads on the same side, which is what a horse does and what a canid does at a
# slow canter rather than at speed.
TRANSVERSE_GALLOP = {"hindL": 0.00, "hindR": 0.12, "foreL": 0.48, "foreR": 0.60}
BOUND = {"hindL": 0.00, "hindR": 0.03, "foreL": 0.42, "foreR": 0.45}
PACE = {"hindL": 0.00, "foreL": 0.05, "hindR": 0.50, "foreR": 0.55}


def author_gait(rig, keyer, *, frames, phases, duty, stride, lift,
                body=None, samples=None, foot_pitch=(-14.0, 16.0),
                reach_bias=0.0, hip_drop=0.0, min_knee=12.0):
    """Author one locomotion cycle by solving each foot against the ground.

    frames   length of the cycle, in frames at 24 fps. The cycle CLOSES: the
             pose at `frames` is the pose at 0.
    phases   fraction of the cycle at which each foot touches down, keyed
             'foreL' 'foreR' 'hindL' 'hindR'. Use LATERAL_WALK / DIAGONAL_TROT
             / ROTARY_GALLOP / BOUND, or a species' own footfall.
    duty     fraction of the cycle a foot spends on the ground. ~0.65 walk,
             ~0.45 trot, ~0.30 gallop. Below 0.5 the animal has airborne
             moments, which is what makes a gallop read as a gallop.
    min_knee degrees of bend the knee must keep at full extension. The foot's
             fore-aft travel is clamped to what the leg can reach WITHOUT
             straightening past this and without leaving the ground; the
             diagnostics report whether it had to.
    stride   metres of ground one foot covers per cycle. THIS is the number the
             game reads back: `glb_rig.js` measures it off the exported clip
             and derives the species' speed from it. Author the real animal's
             stride and the paws keep pace at any playback rate.
    lift     peak height of the swinging foot, in metres.
    body     optional dict of body motion, all amplitudes in metres/degrees:
             bob, pitch, roll, yaw, head, tail, neck, shoulder.

    Everything is in place: the feet cycle, the body does not travel.
    """
    scene = bpy.context.scene
    samples = samples or max(8, int(frames))
    defaults = dict(bob=0.0, pitch=0.0, roll=0.0, yaw=0.0, head=0.0,
                    tail=0.0, neck=0.0, shoulder=0.0)
    defaults.update(body or {})
    body = defaults

    legs = {}
    for key, (kind, side) in (("foreL", ("fore", "L")), ("foreR", ("fore", "R")),
                              ("hindL", ("hind", "L")), ("hindR", ("hind", "R"))):
        up = rig.pose.bones[f"{kind}_upper.{side}"]
        lo = rig.pose.bones[f"{kind}_lower.{side}"]
        ft = rig.pose.bones[f"{kind}_foot.{side}"]
        h = up.bone.head_local.copy()
        k = lo.bone.head_local.copy()
        a = ft.bone.head_local.copy()
        t = ft.bone.tail_local.copy()
        # Which way this knee folds, read off the rest pose rather than assumed:
        # a foreleg's elbow goes back and a hind leg's hock goes back too, but
        # the stifle above it goes forward, and no rule covers every animal.
        u = (a - h).normalized()
        bend = (k - h) - u * (k - h).dot(u)
        l1, l2 = (k - h).length, (a - k).length
        # How far fore-and-aft this foot may travel and still be BOTH on the
        # ground and bent at the knee.
        #
        # This is the whole reason the fit is computed rather than assumed. Ask
        # a leg for more stride than it has and a naive solver clamps the
        # hip-to-ankle VECTOR, which shortens the drop as well as the reach —
        # so the foot rises off the ground at the extremes of its own stance and
        # the animal skims along on tiptoe. Measured on the bear: a 1.25 m
        # stride asked of a 0.9 m leg gave a stance duty of 0.22 against the
        # 0.66 that was authored, and every foot left the ground twice a cycle.
        #
        # Clamping the STRIDE instead keeps the foot planted and makes the
        # shortfall visible in the diagnostics, where it belongs: a stride the
        # leg cannot carry is a finding about the animal's proportions, not
        # something for the solver to hide.
        legs[key] = dict(up=up, lo=lo, ft=ft, hip=h, ankle=a, toe=t,
                         l1=l1, l2=l2,
                         reach=reach_limit(l1, l2, min_knee),
                         half=0.0,
                         bend=bend if bend.length > 1e-5 else Vector((0, -1, 0)),
                         foot_len=(t - a).length)

    tails = [b.name for b in rig.pose.bones if b.name.startswith("tail_")]
    tails.sort()
    core = ["root", "pelvis", "spine_01", "chest", "neck_01", "neck_02", "head",
            "scapula.L", "scapula.R"] + tails

    # Snap every footfall onto the sample grid. A phase that falls between two
    # samples puts the extremes of the foot path between them too, so the clip
    # silently loses stride — no warning, no clamp, just a shorter step than the
    # one that was asked for. Reported rather than done quietly, because a
    # footfall pattern that will not express at this frame count is a reason to
    # change the frame count.
    snapped = {}
    for k, ph in phases.items():
        q = round(ph * samples) / samples
        if abs(q - ph) > 1e-9:
            print(f"KIT_PHASE {k} {ph:.4f} -> {q:.4f} (snapped to 1/{samples})")
        snapped[k] = q
    phases = snapped

    diag = {k: dict(knee=[], travel=[], lift=[]) for k in legs}
    for i in range(samples + 1):
        f = frames * i / samples
        u = i / samples                       # cycle fraction, 0..1
        scene.frame_set(int(round(f)))

        # ── body ────────────────────────────────────────────────────────────
        # Two bobs per stride: the body rises over each supporting diagonal.
        tau = 2 * math.pi
        bob = math.sin(tau * 2 * u) * body["bob"]
        pitch = math.sin(tau * 2 * u + 0.9) * body["pitch"]
        roll = math.sin(tau * u) * body["roll"]
        yaw = math.sin(tau * u + 1.2) * body["yaw"]

        root_pb = rig.pose.bones["root"]
        root_pb.location = local_translation(root_pb, (0, 0, bob - hip_drop))
        # ── which local axis is which, and why this order ───────────────────
        # A spine bone runs head-to-tail along its own +Y, so for the body chain
        # local Y is FORWARD, local X is lateral and local Z is up. That makes
        # the euler triple (pitch about X, ROLL about Y, YAW about Z) — and an
        # earlier cut had the last two the other way round, so a `roll` of 10
        # degrees swung the shoulder 0.22 u sideways instead of banking it. It
        # cost the bear 8% of its walk before anybody noticed, because the yaw
        # moved the hip out from under the foot and the stride quietly clamped.
        set_rot(rig.pose.bones["pelvis"], (pitch, roll, yaw * 0.5))
        set_rot(rig.pose.bones["spine_01"], (-pitch * 0.5, -roll * 0.4, yaw * 0.4))
        set_rot(rig.pose.bones["chest"],
                (pitch * 0.7 + body["shoulder"] * math.sin(tau * 2 * u + 2.2),
                 roll * 0.5, yaw * 0.6))
        set_rot(rig.pose.bones["neck_01"],
                (-pitch * 0.6 + body["neck"] * math.sin(tau * 2 * u + 3.6),
                 0, -yaw * 0.5))
        set_rot(rig.pose.bones["neck_02"], (-pitch * 0.3, 0, -yaw * 0.4))
        set_rot(rig.pose.bones["head"],
                (body["head"] * math.sin(tau * 2 * u + 4.4), 0, -yaw * 0.6))
        # Every link of whatever tail this animal has, each lagging the one in
        # front of it. The lag is what makes a brush or a plume read as
        # something with weight being dragged along rather than a rigid paddle.
        for ti, tname in enumerate(tails):
            set_rot(rig.pose.bones[tname],
                    (-pitch * 0.8 if ti == 0 else 0, 0,
                     body["tail"] * (0.8 ** ti) * math.sin(tau * u - 0.7 * ti)))
        for side in ("L", "R"):
            s = 1 if side == "L" else -1
            ph = phases[f"fore{side}"]
            set_rot(rig.pose.bones[f"scapula.{side}"],
                    (body["shoulder"] * math.sin(tau * (u - ph)), 0, 0))
        bpy.context.view_layer.update()

        # ── feet ────────────────────────────────────────────────────────────
        for key, L in legs.items():
            ph = phases[key]
            t = (u - ph) % 1.0                # 0 at touchdown
            if t < duty:                      # stance: planted, sliding back
                s = t / duty
                y = stride * (0.5 - s) + reach_bias
                z = 0.0
                pitch_f = foot_pitch[0] * (1 - s) + foot_pitch[1] * s
            else:                             # swing: forward through an arc
                s = (t - duty) / (1 - duty)
                y = stride * (s - 0.5) + reach_bias
                z = lift * math.sin(math.pi * s) ** 0.85
                # The foot picks up first and reaches out last: a flat foot
                # through a swing is the single loudest tell of a fake walk.
                pitch_f = foot_pitch[1] * (1 - s) ** 2 + foot_pitch[0] * s ** 2 - 10 * math.sin(math.pi * s)
            # Clamp the fore-aft reach, never the whole vector — see the
            # `half` note above. The foot stays on the ground and a stride the
            # leg cannot carry shows up as a short `travel` in the diagnostics.
            #
            # Solved against the hip WHERE IT IS THIS FRAME, not where it rests.
            # The body bobs, and `hip_drop` lowers it deliberately — an animal
            # crouched 8% has materially more reach than one standing, and a
            # limit computed once off the rest pose would throw that away and
            # report a shortfall that lowering the body had already fixed.
            hip = L["up"].head.copy()
            drop = Vector((L["ankle"].x - hip.x, 0.0, L["ankle"].z - hip.z)).length
            span = L["reach"] ** 2 - drop * drop
            half = math.sqrt(span) if span > 0 else 0.0
            L["half"] = max(L["half"], half)
            y = max(-half, min(half, y))
            target = L["ankle"] + Vector((0, y, z))
            knee = _ik2(hip, target, L["l1"], L["l2"], L["bend"], L["reach"])
            _point_bone(L["up"], knee - hip)
            _point_bone(L["lo"], target - L["lo"].head)
            # Keep the paw flat on the ground through the stance: aim the foot
            # bone along the rest toe direction rolled by `pitch_f`.
            rest_dir = (L["toe"] - L["ankle"]).normalized()
            q = Quaternion(Vector((1, 0, 0)), math.radians(pitch_f))
            _point_bone(L["ft"], q @ rest_dir)

            d1 = (L["up"].tail - L["up"].head).normalized()
            d2 = (L["lo"].tail - L["lo"].head).normalized()
            diag[key]["knee"].append(math.degrees(d1.angle(d2)))
            diag[key]["travel"].append(L["ft"].head.y)
            diag[key]["lift"].append(L["ft"].head.z)

        for name in core:
            key_rot(rig.pose.bones[name], f)
        rig.pose.bones["root"].keyframe_insert("location", frame=f, group="root")
        for L in legs.values():
            for pb in (L["up"], L["lo"], L["ft"]):
                pb.location = (0, 0, 0)
                key_rot(pb, f)

    scene.frame_set(0)

    # What the clip ACTUALLY does, which is not always what was asked for. A
    # foot whose travel falls short of `stride` hit the leg's reach limit and
    # the IK clamped; a knee whose minimum angle approaches 0 went dead
    # straight, which is the locked-chain defect that made the procedural
    # bear's forelegs vanish into its own barrel. Assert on these in the
    # build script rather than discovering them in the game.
    out = {}
    for k, d in diag.items():
        out[k] = dict(travel=max(d["travel"]) - min(d["travel"]),
                      knee_min=min(d["knee"]), knee_max=max(d["knee"]),
                      lift=max(d["lift"]) - min(d["lift"]))
    out["travel"] = min(v["travel"] for v in out.values() if isinstance(v, dict))
    out["knee_min"] = min(v["knee_min"] for k, v in out.items() if isinstance(v, dict))
    out["stride_asked"] = stride
    out["stride_fits"] = 2 * min(L["half"] for L in legs.values())
    out["clamped"] = stride > out["stride_fits"] + 1e-4

    # ── the number that is not the foot's travel ────────────────────────────
    #
    # A foot's fore-aft EXCURSION is not the ground the animal covers, and
    # conflating the two is worth a factor of 1/duty — 1.5x at a walk, 3x at a
    # gallop. During stance the foot must move backward at exactly the body's
    # forward speed, so over `duty * T` seconds it sweeps the excursion E; the
    # body therefore travels at `E / (duty * T)` and covers `E / duty` in a full
    # cycle. `glb_rig.js` divides by the measured stance duty for this reason.
    #
    # So: author the excursion your leg can carry, and read the speed off HERE
    # rather than off `travel / duration`.
    # An ESTIMATE of the duty the engine will measure, computed the way
    # `glb_rig.measureStride` computes it: the fraction of samples within 12% of
    # a foot's own lift range of its lowest point.
    #
    # **It is quantised to this function's own sample grid and reads high.** The
    # engine samples the exported clip 64 times; this samples it `samples + 1`,
    # which for an 8-frame bound is 9 — a resolution of 0.11 in duty. Measured
    # against real exports it predicted 0.71 / 0.55 / 0.33 where the GLB read
    # 0.672 / 0.438 / 0.234, so solving a bound's excursion against it ships the
    # animal 30% slow.
    #
    # Treat it as an upper bound and a sanity check, not as the number to solve
    # against. For that, measure the EXPORTED GLB — `tools/_scratch/_glbinfo.mjs`
    # reads one without a browser, and the in-game boot line
    # (`tools/_scratch/_glbboot.mjs`) is the final word.
    read = []
    for d in diag.values():
        zs = d["lift"]
        floor = min(zs)
        rng = max(max(zs) - floor, 1e-9)
        read.append(sum(1 for z in zs if z - floor < rng * 0.12) / len(zs))
    read.sort()
    engine_duty = read[len(read) >> 1] if read else duty

    period = frames / FPS
    out["duty"] = duty
    out["engine_duty"] = engine_duty
    out["excursion"] = out["travel"]
    out["ground_per_cycle"] = out["travel"] / max(duty, 1e-3)
    out["speed_units"] = out["ground_per_cycle"] / period
    if out["clamped"]:
        print(f"KIT_STRIDE_CLAMPED asked {stride:.3f}u, this leg carries "
              f"{out['stride_fits']:.3f}u at {min_knee:.0f} deg of knee bend. "
              f"Shorten the stride, lengthen the legs, or lower the body — do "
              f"not raise it and hope. Check rest_extension(rig): a standing "
              f"quadruped wants 0.82-0.88 of its reach, not 0.97.")
    print(f"KIT_GAIT excursion {out['travel']:.3f}u over {period:.2f}s at duty "
          f"{duty:.2f} (engine reads <= {engine_duty:.2f}, quantised to "
          f"1/{samples + 1}; measure the export) "
          f"-> {out['ground_per_cycle']:.3f}u per cycle, "
          f"{out['speed_units']:.3f}u/s, knee {out['knee_min']:.0f}-"
          f"{max(v['knee_max'] for v in out.values() if isinstance(v, dict)):.0f} deg")
    return out


def units_per_metre(body, target_height_m):
    """Build units per game metre, for authoring a stride the real animal has.

    A build is modelled at whatever size reads well in Blender; the species
    file's `glb.height` is what scales it to metres in the game. So a stride
    authored in build units becomes `stride * height / model_height` metres —
    which means the honest way to ask for a real animal's stride is::

        upm = units_per_metre(body, 1.05)      # a black bear stands ~1.05 m
        stride = 1.30 * upm                    # a bear walks a 1.3 m stride

    Get this wrong and the animal is not slow because its legs are slow; it is
    slow because the clip covers a tenth of the ground it should. That was the
    fox's finding and it is the one number worth checking twice.
    """
    zs = [(body.matrix_world @ v.co).z for v in body.data.vertices]
    return (max(zs) - min(zs)) / target_height_m


def close_action(rig, action, start, end):
    """Copy the pose at `start` onto `end`, key for key.

    An engine wraps a clip by sampling past its end; the closing duplicate is
    what makes that wrap continuous. It is also the cheapest guard against the
    class of bug where a cycle was authored a half-stride short.
    """
    for fc in fcurves_of(action):
        kps = fc.keyframe_points
        first = next((k for k in kps if abs(k.co.x - start) < 1e-4), None)
        last = next((k for k in kps if abs(k.co.x - end) < 1e-4), None)
        if first is None:
            continue
        if last is None:
            fc.keyframe_points.insert(end, first.co.y)
        else:
            last.co.y = first.co.y
            last.handle_left.y = first.handle_left.y
            last.handle_right.y = first.handle_right.y
        fc.update()


# ── presentation, save, export ───────────────────────────────────────────────

def presentation(prefix, target=(0, 0.05, 1.0), distance=9.0, lens=68,
                 ground=(0.075, 0.070, 0.060)):
    """The studio: a ground plane, a broadside camera and a three-point rig.

    Broadside is the only angle a gait can be judged from, so that is where the
    camera sits. None of this is a child of the rig, so none of it exports.
    """
    gm = material("Presentation ground", ground, 0.88)
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, -0.02))
    g = bpy.context.object
    g.name = "Presentation Ground"
    g.data.materials.append(gm)

    cd = bpy.data.cameras.new(f"{prefix} presentation camera")
    cam = bpy.data.objects.new(f"{prefix} presentation camera", cd)
    bpy.context.collection.objects.link(cam)
    cam.location = (-distance, target[1] + 0.15, target[2] * 2.2)
    cam.data.lens = lens
    aim(cam, target)

    add_area(f"{prefix} key", (-distance * 0.5, distance * 0.27, distance * 0.62),
             1200, 4.5, (0.78, 0.86, 1.0), target)
    add_area(f"{prefix} fill", (distance * 0.45, distance * 0.20, distance * 0.38),
             700, 4.0, (0.62, 0.68, 0.82), target)
    add_area(f"{prefix} rim", (0.2, -distance * 0.53, distance * 0.48),
             760, 3.5, (1.0, 0.58, 0.34), target)

    sc = bpy.context.scene
    sc.camera = cam
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x = sc.render.resolution_y = 720
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = "PNG"
    if sc.world is None:
        sc.world = bpy.data.worlds.new("World")
    sc.world.color = (0.22, 0.22, 0.22)
    try:
        sc.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    return cam, g


def _deformed_points(body, depsgraph=None):
    """World-space vertices of `body` as the modifier stack actually leaves it."""
    dg = depsgraph or bpy.context.evaluated_depsgraph_get()
    ev = body.evaluated_get(dg)
    me = ev.to_mesh()
    pts = [body.matrix_world @ v.co for v in me.vertices]
    ev.to_mesh_clear()
    return pts


def check_symmetry(body, tol=0.02, min_pairs=0.97):
    """Every vertex off the centreline must have a partner across it.

    This exists because of a bug that shipped: a build mirrored its joint
    positions once when it placed the legs and **again** when it placed the
    paws, and `sgn * sgn` is 1 — so both plantigrade soles were built on the
    animal's left and the right feet ended in bare balls 5 cm off the ground,
    with three claws hanging in the air under each. It survived every existing
    check, because the foot-contact report samples BONES and the bones were
    fine. Only the mesh was wrong.

    Returns the fraction of off-centre vertices that found a partner. A
    bilaterally symmetric animal should be at 1.0; a deliberate asymmetry (a
    tucked leg, a turned head in a rest pose) lowers it honestly.
    """
    # Measure the REST pose. `_deformed_points` reads the mesh as the modifier
    # stack leaves it, and after a build has authored clips the rig is still
    # holding whatever frame was evaluated last — so a perfectly symmetric
    # animal caught mid-stride fails this for the obvious reason. Reset first.
    rig = body.find_armature()
    if rig:
        rest_pose(rig)
    pts = _deformed_points(body)
    span = max((p.x for p in pts), default=1.0) - min((p.x for p in pts), default=0.0)
    eps = max(span * 0.02, 1e-4)
    grid = {}
    q = max(span * tol, 1e-4)
    for p in pts:
        grid.setdefault((round(abs(p.x) / q), round(p.y / q), round(p.z / q)), [0, 0])[
            0 if p.x > 0 else 1] += 1
    off = paired = 0
    for p in pts:
        if abs(p.x) <= eps:
            continue
        off += 1
        cell = grid.get((round(abs(p.x) / q), round(p.y / q), round(p.z / q)))
        if cell and cell[0] and cell[1]:
            paired += 1
    frac = paired / off if off else 1.0
    if frac < min_pairs:
        print(f"KIT_ASYMMETRY {frac * 100:.1f}% of off-centre vertices have a "
              f"mirror partner (wanted {min_pairs * 100:.0f}%). If this animal is "
              f"not deliberately asymmetric, look for a value mirrored twice — "
              f"`sgn * sgn` is 1, and the second mirror is silent.")
    return frac


def check_grounded(body, rig, actions, tol=0.004, airborne=()):
    """No part of the animal may go through the floor, in any frame of any clip.

    `airborne` names the clips this does not apply to. A bird in level flight is
    posed about its own body origin and its wing tip legitimately passes below
    that origin on the downstroke — there is no floor for it to go through. Pass
    `airborne=("Flap", "Glide", "Takeoff", "Land")` for a flying animal and keep
    the check on the clips that really do stand on something.

    `validate` used to check this on the REST pose only, which is exactly the
    pose that is always fine. A graze that drops the root and pitches the spine
    without a compensating lift put all four feet 15 cm underground for a whole
    clip, and the legs simply stopped at the floor line in every rendered frame.
    """
    scene = bpy.context.scene
    worst = {}
    for act in actions:
        if act.name in airborne:
            continue
        s, e = ((act.frame_start, act.frame_end) if act.use_frame_range
                else act.curve_frame_range)
        rig.animation_data.action = act
        deep = 0.0
        for i in range(17):
            scene.frame_set(int(round(s + (e - s) * i / 16)))
            bpy.context.view_layer.update()
            deep = min(deep, min((p.z for p in _deformed_points(body)), default=0.0))
        worst[act.name] = deep
        if deep < -tol:
            print(f"KIT_UNDERGROUND {act.name}: {deep * 1000:.1f} mm below the "
                  f"floor. A clip that drops the body has to lift the feet by "
                  f"the same amount.")
    scene.frame_set(int(scene.frame_start))
    return worst


def validate(body, rig, actions, min_height, expect_bones=None,
             symmetric=True, grounded=True, airborne=()):
    """Fail loudly here rather than in the game.

    Every one of these has been a real defect: a mesh sunk under the ground
    plane, a vertex with no weight that stays behind when the animal walks off,
    a clip whose first and last pose differ so the loop pops.
    """
    expect = set(expect_bones or BONES)
    actual = {b.name for b in rig.data.bones}
    assert actual == expect, (sorted(expect - actual), sorted(actual - expect))
    assert rig.data.bones["root"].use_deform is False
    assert body.find_armature() == rig
    zs = [(body.matrix_world @ v.co).z for v in body.data.vertices]
    assert min(zs) > -0.08, f"body sinks below the ground plane: {min(zs):.3f}"
    assert max(zs) > min_height, f"body is short: {max(zs):.3f} < {min_height}"
    loose = [v.index for v in body.data.vertices
             if not any(g.weight > 0 for g in v.groups)]
    assert not loose, f"{len(loose)} unweighted vertices"
    # Every clip must key the channel its bone actually drives. A build that
    # wrote `rotation_euler` onto a quaternion bone leaves that bone inert: the
    # pose it was given never reaches the mesh, nothing throws, and the animal
    # ships holding a stale rest value. The fox lost `Stand`, `graze` and
    # `alert` to exactly this and floated 5 cm off the ground.
    modes = {b.name: b.rotation_mode for b in rig.pose.bones}
    for act in actions:
        for fc in fcurves_of(act):
            m = re.match(r'pose\.bones\["(.+?)"\]\.(rotation_\w+)$', fc.data_path)
            if not m:
                continue
            bone, path = m.group(1), m.group(2)
            want = ("rotation_quaternion" if modes.get(bone) == "QUATERNION"
                    else "rotation_axis_angle" if modes.get(bone) == "AXIS_ANGLE"
                    else "rotation_euler")
            assert path == want, (
                f"{act.name}: keys {bone}.{path} but that bone is "
                f"{modes.get(bone)} — the channel is inert and the pose never "
                f"reaches the mesh. Key through animal_kit.key_rot.")

    for act in actions:
        s, e = act.frame_start, act.frame_end
        for fc in fcurves_of(act):
            a = fc.evaluate(s)
            b = fc.evaluate(e)
            assert abs(a - b) < 2e-3, (
                f"{act.name}: {fc.data_path}[{fc.array_index}] does not close "
                f"({a:.5f} at {s} vs {b:.5f} at {e})")
    if symmetric:
        frac = check_symmetry(body)
        assert frac >= 0.90, (
            f"only {frac * 100:.1f}% of off-centre vertices have a mirror "
            f"partner — the animal is lopsided. Pass symmetric=False if that is "
            f"deliberate.")
    if grounded:
        worst = check_grounded(body, rig, actions, airborne=airborne)
        bad = {k: v for k, v in worst.items() if v < -0.02}
        assert not bad, (
            f"clips go through the floor: "
            + ", ".join(f"{k} {v * 1000:.0f} mm" for k, v in bad.items()))

    print("KIT_VALID",
          f"verts={len(body.data.vertices)}",
          f"faces={len(body.data.polygons)}",
          f"bones={len(rig.data.bones)}",
          f"height={max(zs):.3f}",
          f"actions={[a.name for a in actions]}")


def rest_pose(rig):
    """Put every bone back to its rest transform and unlink the action.

    **Clearing `animation_data.action` does not do this.** Blender leaves the
    pose holding whatever the last evaluated frame put there, so a .blend saved
    after authoring clips saves the animal mid-stride — and every still rendered
    from it, every bounding box measured off it, and the rest pose the exporter
    writes are all taken from a frame nobody chose. It cost the eagle build a
    whole round: the sheet showed a bird mid-downstroke while every measurement
    said the wings were level.

    Call it after the last clip is authored and before `save_blend` /
    `export_glb` / any measurement of the standing animal.
    """
    if rig.animation_data:
        rig.animation_data.action = None
    for pb in rig.pose.bones:
        pb.location = (0.0, 0.0, 0.0)
        pb.scale = (1.0, 1.0, 1.0)
        if pb.rotation_mode == "QUATERNION":
            pb.rotation_quaternion = (1.0, 0.0, 0.0, 0.0)
        elif pb.rotation_mode == "AXIS_ANGLE":
            pb.rotation_axis_angle = (0.0, 0.0, 1.0, 0.0)
        else:
            pb.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()


def save_blend(path):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(p), compress=True)
    return p


def export_glb(rig_name, out_path):
    """Export the rig hierarchy and every action to one GLB.

    Two things matter and both have bitten. Only the rig and its children are
    selected, so the studio lights, the camera and the ground plane stay out of
    the shipped file. And every action carries its own **manual** frame range,
    so each clip exports over its own length instead of the scene's — without
    it a 16-frame trot comes out padded to 144 and plays at a ninth of its
    authored tempo.
    """
    rig = bpy.data.objects[rig_name]
    for act in bpy.data.actions:
        if not act.use_frame_range:
            act.use_frame_range = True
            act.frame_start, act.frame_end = act.curve_frame_range
    bpy.ops.object.select_all(action="DESELECT")
    wanted = [rig] + [o for o in bpy.data.objects if o.parent == rig]
    for o in wanted:
        o.select_set(True)
    bpy.context.view_layer.objects.active = rig
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(out), export_format="GLB", use_selection=True,
        export_apply=True, export_animations=True,
        export_animation_mode="ACTIONS", export_bake_animation=True,
        export_frame_range=False, export_optimize_animation_size=True,
        export_yup=True)
    print(f"[export] {out} ({out.stat().st_size} bytes) "
          f"objects={[o.name for o in wanted]} "
          f"actions={[a.name for a in bpy.data.actions]}")
    return out
