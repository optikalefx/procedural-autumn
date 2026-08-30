"""Build the stylized, rigged black-bear source asset.

Run with Blender, not the system Python::

    blender --factory-startup -b --python tools/build_bear_reference.py

The generated file is intentionally an editable source asset rather than a
shipping export.  It mirrors the conventions of ``fox_reference.blend``:

* +Y is forward, +Z is up, and the paws rest on Z=0.
* one fused, smooth-shaded low-poly body carries flat material regions;
* eyes and inner ears are small bone-parented detail meshes;
* the armature has a non-deforming root and an in-place looping action;
* the presentation floor, camera and lights are saved but are not rig children.

Only ``idle`` is authored now.  The neck, jaw, ears, scapulae, three-part legs
and tail are already separated in the deform rig so graze, alert, walk, trout
and run can be added without changing the skeleton.
"""

from pathlib import Path
import math

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
BLEND_PATH = ROOT / "assets" / "models" / "bear.blend"
RENDER_PATH = Path("/tmp/bear_reference.png")


def material(name, color, roughness=0.78):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    principled = mat.node_tree.nodes.get("Principled BSDF")
    if principled:
        principled.inputs["Base Color"].default_value = (*color, 1.0)
        principled.inputs["Roughness"].default_value = roughness
        specular = principled.inputs.get("Specular IOR Level")
        if specular:
            specular.default_value = 0.24
    return mat


def uv(name, location, scale, segments=16, rings=10):
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=segments,
        ring_count=rings,
        location=location,
    )
    ob = bpy.context.object
    ob.name = name
    ob.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return ob


def ellipsoid_between(name, a, b, width, depth=None, overlap=1.12):
    """Make a soft capsule volume whose local Z axis follows a -> b."""
    a, b = Vector(a), Vector(b)
    delta = b - a
    depth = width if depth is None else depth
    ob = uv(name, (a + b) * 0.5, (width, depth, delta.length * 0.5 * overlap))
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = delta.to_track_quat("Z", "Y")
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    ob.rotation_mode = "XYZ"
    return ob


def tapered_between(name, a, b, radius_a, radius_b, depth=None, vertices=14):
    """Make a tapered elliptical volume along a -> b."""
    a, b = Vector(a), Vector(b)
    delta = b - a
    depth = radius_a if depth is None else depth
    bpy.ops.mesh.primitive_cone_add(
        vertices=vertices,
        radius1=1.0,
        radius2=radius_b / radius_a,
        depth=delta.length,
        location=(a + b) * 0.5,
    )
    ob = bpy.context.object
    ob.name = name
    ob.scale = (radius_a, depth, 1.0)
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = delta.to_track_quat("Z", "Y")
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    ob.rotation_mode = "XYZ"
    return ob


def aim(ob, target):
    ob.rotation_euler = (Vector(target) - ob.location).to_track_quat("-Z", "Y").to_euler()


def add_area(name, location, energy, size, color, target=(0, 0.05, 1.15)):
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


def add_bone(armature, name, head, tail, parent=None, deform=True):
    bone = armature.edit_bones.new(name)
    bone.head = head
    bone.tail = tail
    bone.use_deform = deform
    if parent:
        bone.parent = armature.edit_bones[parent]
    return bone


def segment_distance(point, a, b):
    point, a, b = Vector(point), Vector(a), Vector(b)
    ab = b - a
    if ab.length_squared < 1e-9:
        return (point - a).length
    t = max(0.0, min(1.0, (point - a).dot(ab) / ab.length_squared))
    return (point - (a + ab * t)).length


def clear_scene():
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for data in (bpy.data.actions, bpy.data.armatures, bpy.data.cameras,
                 bpy.data.curves, bpy.data.lights, bpy.data.materials,
                 bpy.data.meshes):
        for block in list(data):
            if block.users == 0:
                data.remove(block)


def build_body(materials):
    coat, muzzle, charcoal, _inner_ear, _eye = materials
    parts = []

    # Trace the photograph rather than a mascot shorthand: a long continuous
    # back, slight shoulder rise, lower rump, shallow belly and a comparatively
    # small head carried forward and below the withers.
    parts.extend([
        uv("Bear deep barrel", (0, -0.18, 1.43), (0.70, 1.40, 0.68), 20, 12),
        uv("Bear full rump", (0, -1.04, 1.40), (0.69, 0.68, 0.62), 18, 11),
        uv("Bear shoulder mass", (0, 0.52, 1.43), (0.66, 0.62, 0.60), 18, 11),
        uv("Bear sloping brisket", (0, 0.55, 1.25), (0.48, 0.48, 0.42)),
        ellipsoid_between("Bear thick sloping neck", (0, 0.57, 1.53), (0, 1.05, 1.49), 0.47, 0.50, 1.42),
        uv("Bear compact head", (0, 1.18, 1.53), (0.37, 0.40, 0.32)),
        tapered_between("Bear short tapered muzzle", (0, 1.25, 1.48), (0, 1.73, 1.38), 0.245, 0.12, 0.18, 16),
        uv("Bear nose volume", (0, 1.78, 1.375), (0.095, 0.065, 0.065), 14, 9),
        uv("Bear chin", (0, 1.47, 1.335), (0.205, 0.245, 0.115), 14, 9),
        tapered_between("Bear ear left", (-0.245, 1.02, 1.75), (-0.29, 0.98, 2.03), 0.13, 0.035, 0.095, 10),
        tapered_between("Bear ear right", (0.245, 1.02, 1.75), (0.29, 0.98, 2.03), 0.13, 0.035, 0.095, 10),
        uv("Bear tail nub", (0, -1.62, 1.43), (0.14, 0.18, 0.14), 12, 8),
    ])

    # A planted neutral pose with visible joint bends gives the later walk/run
    # clips enough reach.  The source volumes follow the future bone segments,
    # so bending the rig keeps volume around elbows and hocks.
    fore = {
        "L": ((-0.40, 0.52, 1.49), (-0.52, 0.44, 0.77), (-0.40, 0.56, 0.21)),
        "R": ((0.40, 0.43, 1.49), (0.52, 0.35, 0.77), (0.40, 0.47, 0.21)),
    }
    hind = {
        "L": ((-0.42, -1.17, 1.48), (-0.56, -1.08, 0.82), (-0.42, -1.12, 0.24)),
        "R": ((0.42, -1.08, 1.48), (0.56, -0.99, 0.82), (0.42, -1.03, 0.24)),
    }
    for side, (shoulder, elbow, wrist) in fore.items():
        # Rounded capsules extend into the torso at the top. A frustum here
        # leaves its flat cap visible as a shelf where the limb meets the body.
        parts.append(ellipsoid_between(f"Bear fore upper {side}", shoulder, elbow, 0.26, 0.29, 1.32))
        parts.append(tapered_between(f"Bear fore lower {side}", elbow, wrist, 0.22, 0.165, 0.225))
        # Frustums that merely touch at an angled end plane remesh into a
        # pinched hourglass. Overlapping joint volumes carry flesh around the
        # elbow and carpus so the limb reads as one continuous anatomical form.
        parts.append(uv(f"Bear fore elbow {side}", elbow, (0.225, 0.245, 0.215), 14, 9))
        parts.append(uv(f"Bear fore wrist {side}", wrist, (0.17, 0.19, 0.155), 12, 8))
        x = shoulder[0]
        paw_y = 0.68 if side == "L" else 0.59
        parts.append(uv(f"Bear fore paw {side}", (x, paw_y, 0.105), (0.235, 0.35, 0.11), 14, 8))
    for side, (hip, stifle, hock) in hind.items():
        parts.append(ellipsoid_between(f"Bear hind upper {side}", hip, stifle, 0.30, 0.34, 1.36))
        parts.append(tapered_between(f"Bear hind lower {side}", stifle, hock, 0.27, 0.205, 0.28))
        parts.append(uv(f"Bear hind stifle {side}", stifle, (0.29, 0.32, 0.275), 14, 9))
        parts.append(uv(f"Bear hind hock {side}", hock, (0.21, 0.235, 0.19), 12, 8))
        x = hip[0]
        paw_y = -1.01 if side == "L" else -0.92
        parts.append(uv(f"Bear hind paw {side}", (x, paw_y, 0.105), (0.28, 0.36, 0.115), 14, 8))

    for ob in parts:
        ob.data.materials.append(coat)
        ob.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    body = bpy.context.object
    body.name = "Bear_Reference"

    remesh = body.modifiers.new("Fused organic silhouette", "REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = 0.042
    remesh.use_smooth_shade = True
    bpy.ops.object.modifier_apply(modifier=remesh.name)

    smooth = body.modifiers.new("Soften fused volume seams", "SMOOTH")
    smooth.factor = 0.28
    smooth.iterations = 4
    bpy.ops.object.modifier_apply(modifier=smooth.name)

    decimate = body.modifiers.new("Intentional low-poly facets", "DECIMATE")
    decimate.ratio = 0.34
    bpy.ops.object.modifier_apply(modifier=decimate.name)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    body.data.materials.clear()
    body.data.materials.append(coat)
    body.data.materials.append(muzzle)
    body.data.materials.append(charcoal)
    for poly in body.data.polygons:
        poly.use_smooth = True
        center = poly.center
        # In the photograph the coat continues uninterrupted down every limb.
        # Only the small nose cap and lower-front muzzle break that silhouette.
        if center.y > 1.745 and center.z < 1.44:
            poly.material_index = 2
        elif center.y > 1.45 and center.z < 1.50:
            poly.material_index = 1
        else:
            poly.material_index = 0
    body.data.name = "Bear_Body_Mesh"
    return body


def build_rig(body):
    armature = bpy.data.armatures.new("Bear_Rig_Data")
    rig = bpy.data.objects.new("Bear_Rig", armature)
    bpy.context.collection.objects.link(rig)
    rig.show_in_front = True
    armature.display_type = "BBONE"
    rig["forward_axis"] = "+Y"
    rig["up_axis"] = "+Z"
    rig["ground_z"] = 0.0
    rig["authored_fps"] = 24
    rig["current_actions"] = "idle"
    rig["planned_actions"] = "graze, alert, walk, trout, run"
    rig["animation_contract"] = "In-place loops; keep root at ground; preserve bone names."

    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    # Core chain.
    add_bone(armature, "root", (0, -0.14, 0.02), (0, -0.14, 0.94), deform=False)
    add_bone(armature, "pelvis", (0, -0.82, 1.35), (0, -0.34, 1.46), "root")
    add_bone(armature, "spine_01", (0, -0.34, 1.46), (0, 0.16, 1.50), "pelvis")
    add_bone(armature, "chest", (0, 0.16, 1.50), (0, 0.56, 1.53), "spine_01")
    add_bone(armature, "neck_01", (0, 0.56, 1.53), (0, 0.80, 1.51), "chest")
    add_bone(armature, "neck_02", (0, 0.80, 1.51), (0, 1.05, 1.50), "neck_01")
    add_bone(armature, "head", (0, 1.05, 1.50), (0, 1.57, 1.40), "neck_02")
    add_bone(armature, "jaw", (0, 1.25, 1.44), (0, 1.70, 1.35), "head")

    # Small, rear-set ears still keep independent alert/listening controls.
    add_bone(armature, "ear.L", (-0.24, 1.01, 1.74), (-0.29, 0.98, 2.04), "head")
    add_bone(armature, "ear.R", (0.24, 1.01, 1.74), (0.29, 0.98, 2.04), "head")

    # Forelimbs hang from the chest through scapula controls.
    fore_joints = {
        "L": ((-0.40, 0.52, 1.49), (-0.52, 0.44, 0.77), (-0.40, 0.56, 0.21), 0.68),
        "R": ((0.40, 0.43, 1.49), (0.52, 0.35, 0.77), (0.40, 0.47, 0.21), 0.59),
    }
    for side, (shoulder, elbow, wrist, toe_y) in fore_joints.items():
        x = shoulder[0]
        add_bone(armature, f"scapula.{side}", (x * 0.62, 0.18, 1.57), shoulder, "chest")
        add_bone(armature, f"fore_upper.{side}", shoulder, elbow, f"scapula.{side}")
        add_bone(armature, f"fore_lower.{side}", elbow, wrist, f"fore_upper.{side}")
        add_bone(armature, f"fore_foot.{side}", wrist, (x, toe_y, 0.075), f"fore_lower.{side}")
        add_bone(armature, f"fore_toe.{side}", (x, toe_y, 0.075), (x, toe_y + 0.25, 0.055), f"fore_foot.{side}", deform=False)

    # Reserve bend is carried mostly across the animal's width, preserving the
    # reference's columnar side silhouette without leaving a locked chain.
    hind_joints = {
        "L": ((-0.42, -1.17, 1.48), (-0.56, -1.08, 0.82), (-0.42, -1.12, 0.24), -1.01),
        "R": ((0.42, -1.08, 1.48), (0.56, -0.99, 0.82), (0.42, -1.03, 0.24), -0.92),
    }
    for side, (hip, stifle, hock, toe_y) in hind_joints.items():
        x = hip[0]
        add_bone(armature, f"hind_upper.{side}", hip, stifle, "pelvis")
        add_bone(armature, f"hind_lower.{side}", stifle, hock, f"hind_upper.{side}")
        add_bone(armature, f"hind_foot.{side}", hock, (x, toe_y, 0.075), f"hind_lower.{side}")
        add_bone(armature, f"hind_toe.{side}", (x, toe_y, 0.075), (x, toe_y + 0.28, 0.055), f"hind_foot.{side}", deform=False)

    add_bone(armature, "tail_01", (0, -1.40, 1.48), (0, -1.62, 1.44), "pelvis")
    add_bone(armature, "tail_02", (0, -1.62, 1.44), (0, -1.74, 1.40), "tail_01")
    bpy.ops.object.mode_set(mode="OBJECT")

    # Parent and deform exactly as the fox source does.
    body.parent = rig
    body.matrix_parent_inverse = rig.matrix_world.inverted()
    modifier = body.modifiers.new("Armature", "ARMATURE")
    modifier.object = rig

    # Region-aware nearest-segment weights keep the fused mesh organic while
    # preventing the belly from following a nearby thigh or a cheek from
    # following an ear.  Two or three neighbouring groups share joint rims.
    deform_bones = {b.name: b for b in armature.bones if b.use_deform}
    groups = {name: body.vertex_groups.new(name=name) for name in deform_bones}

    def weights_for(co):
        x, y, z = co
        side = "L" if x < 0 else "R"
        if z > 1.70 and y > 0.94 and abs(x) > 0.16:
            candidates = [f"ear.{side}", "head"]
            sigma = 0.30
        elif y > 1.00:
            if y > 1.26 and z < 1.48:
                candidates = ["jaw", "head"]
                sigma = 0.34
            else:
                candidates = ["head", "neck_02", "neck_01"]
                sigma = 0.43
        elif y < -1.46 and abs(x) < 0.28 and z > 1.16:
            candidates = ["tail_01", "tail_02", "pelvis"]
            sigma = 0.32
        elif z < 1.34 and abs(x) > 0.20:
            if y > -0.10:
                candidates = [f"scapula.{side}", f"fore_upper.{side}",
                              f"fore_lower.{side}", f"fore_foot.{side}"]
            else:
                candidates = [f"hind_upper.{side}", f"hind_lower.{side}",
                              f"hind_foot.{side}", "pelvis"]
            sigma = 0.34
        elif y > 0.52:
            candidates = ["chest", "neck_01", "neck_02"]
            sigma = 0.52
        else:
            candidates = ["pelvis", "spine_01", "chest"]
            sigma = 0.58

        scored = []
        for name in candidates:
            bone = deform_bones[name]
            d = segment_distance(co, bone.head_local, bone.tail_local)
            score = math.exp(-((d / sigma) ** 2)) + 1e-8
            scored.append((name, score))
        scored.sort(key=lambda item: item[1], reverse=True)
        scored = scored[:3]
        total = sum(score for _, score in scored)
        return [(name, score / total) for name, score in scored]

    for vertex in body.data.vertices:
        for name, weight in weights_for(vertex.co):
            groups[name].add([vertex.index], weight, "REPLACE")

    return rig


def bone_parent(ob, rig, bone_name, world_matrix=None):
    world_matrix = ob.matrix_world.copy() if world_matrix is None else world_matrix
    ob.parent = rig
    ob.parent_type = "BONE"
    ob.parent_bone = bone_name
    ob.matrix_world = world_matrix


def build_details(rig, materials):
    _coat, _muzzle, _charcoal, claw_mat, eye_mat = materials
    details = []

    # Small, side-set eyes rather than large front-facing mascot eyes.
    for side, x in (("L", -0.32), ("R", 0.32)):
        eye = uv(f"Bear eye {side}", (x, 1.34, 1.61), (0.018, 0.016, 0.018), 10, 7)
        eye.data.materials.append(eye_mat)
        bone_parent(eye, rig, "head")
        details.append(eye)

    # The reference has visible nails at the ends of otherwise uninterrupted
    # dark paws. Three restrained low-poly claws per foot carry that cue.
    paws = (
        ("fore", "L", -0.40, 0.98, 1.09), ("fore", "R", 0.40, 0.89, 1.00),
        ("hind", "L", -0.42, -0.70, -0.59), ("hind", "R", 0.42, -0.61, -0.50),
    )
    for leg, side, x, base_y, tip_y in paws:
        for index, dx in enumerate((-0.095, 0.0, 0.095)):
            claw = tapered_between(
                f"Bear {leg} claw {side}.{index + 1}",
                (x + dx, base_y, 0.105),
                (x + dx, tip_y, 0.070),
                0.022,
                0.006,
                0.018,
                8,
            )
            claw.data.materials.append(claw_mat)
            bone_parent(claw, rig, f"{leg}_foot.{side}")
            details.append(claw)
    return details


def build_idle(rig):
    scene = bpy.context.scene
    scene.render.fps = 24
    scene.frame_start, scene.frame_end = 0, 48
    scene.frame_preview_start, scene.frame_preview_end = 0, 48
    action = bpy.data.actions.new("idle")
    action.use_fake_user = True
    action["loop"] = True
    action["duration_frames"] = 48
    action["description"] = "Quiet breathing with a small head drift and one listening ear flick."
    rig.animation_data_create()
    rig.animation_data.action = action

    for pose_bone in rig.pose.bones:
        pose_bone.rotation_mode = "XYZ"

    def rotation_keys(name, keyed):
        bone = rig.pose.bones[name]
        for frame, degrees in keyed:
            scene.frame_set(frame)
            bone.rotation_euler = tuple(math.radians(value) for value in degrees)
            bone.keyframe_insert("rotation_euler", frame=frame, group=name)

    def location_keys(name, keyed):
        bone = rig.pose.bones[name]
        for frame, value in keyed:
            scene.frame_set(frame)
            bone.location = value
            bone.keyframe_insert("location", frame=frame, group=name)

    # The loop is subdued: weight settles through the pelvis while breath rolls
    # forward through spine/chest and is compensated in the short neck.
    location_keys("root", [
        (0, (0, 0, 0)), (12, (0, 0, 0.010)), (24, (0, 0, 0)),
        (36, (0, 0, -0.006)), (48, (0, 0, 0)),
    ])
    rotation_keys("pelvis", [
        (0, (0, 0, 0)), (12, (-0.35, 0, 0.18)), (24, (0, 0, 0)),
        (36, (0.25, 0, -0.14)), (48, (0, 0, 0)),
    ])
    rotation_keys("spine_01", [
        (0, (0, 0, 0)), (12, (0.65, 0, -0.18)), (24, (0, 0, 0)),
        (36, (-0.45, 0, 0.14)), (48, (0, 0, 0)),
    ])
    rotation_keys("chest", [
        (0, (0, 0, 0)), (12, (1.05, 0, 0.24)), (24, (0, 0, 0)),
        (36, (-0.72, 0, -0.18)), (48, (0, 0, 0)),
    ])
    rotation_keys("neck_01", [
        (0, (0, 0, 0)), (12, (-0.55, 0, -0.18)), (24, (0.15, 0, 0.15)),
        (36, (0.42, 0, 0.10)), (48, (0, 0, 0)),
    ])
    rotation_keys("neck_02", [
        (0, (0, 0, 0)), (12, (-0.30, 0.20, 0.12)), (24, (0.12, -0.20, -0.10)),
        (36, (0.18, 0.10, -0.08)), (48, (0, 0, 0)),
    ])
    rotation_keys("head", [
        (0, (0, 0, 0)), (12, (0.22, -0.45, 0.18)), (24, (-0.12, 0.30, -0.12)),
        (36, (-0.08, 0.18, -0.10)), (48, (0, 0, 0)),
    ])
    rotation_keys("ear.L", [
        (0, (0, 0, 0)), (25, (0, 0, 0)), (29, (-4.0, 2.0, -7.5)),
        (33, (1.5, -1.0, 3.0)), (38, (0, 0, 0)), (48, (0, 0, 0)),
    ])
    rotation_keys("ear.R", [
        (0, (0, 0, 0)), (12, (0.4, -0.2, 0.5)), (24, (0, 0, 0)),
        (36, (-0.3, 0.2, -0.4)), (48, (0, 0, 0)),
    ])

    scene.timeline_markers.new("idle_start", frame=0)
    scene.timeline_markers.new("breath_high", frame=12)
    scene.timeline_markers.new("ear_flick", frame=29)
    scene.timeline_markers.new("idle_loop", frame=48)
    scene.frame_set(0)
    return action


def build_presentation(materials):
    ground_mat = material("Presentation ground", (0.075, 0.070, 0.060), 0.88)
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, -0.035))
    ground = bpy.context.object
    ground.name = "Presentation Ground"
    ground.data.materials.append(ground_mat)

    camera_data = bpy.data.cameras.new("Bear presentation camera")
    camera = bpy.data.objects.new("Bear presentation camera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (-9.0, 0.20, 2.40)
    camera.data.lens = 68
    aim(camera, (0, 0.05, 1.02))

    add_area("Bear key", (-4.5, 2.4, 5.6), 1200, 4.5, (0.78, 0.86, 1.0))
    add_area("Bear fill", (4.0, 1.8, 3.4), 700, 4.0, (0.62, 0.68, 0.82))
    add_area("Bear rim", (0.2, -4.8, 4.3), 760, 3.5, (1.0, 0.58, 0.34))

    scene = bpy.context.scene
    scene.camera = camera
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 720
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(RENDER_PATH)
    scene.world.color = (0.22, 0.22, 0.22)
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    return camera, ground


def add_readme():
    text = bpy.data.texts.new("Bear_Rig_README")
    text.write(
        "STYLIZED BLACK BEAR — RIG NOTES\n\n"
        "+Y forward, +Z up, ground at Z=0. 24 fps.\n"
        "Current action: idle (frames 0-48, seamless in-place loop).\n"
        "Planned actions: graze, alert, walk, trout, run.\n\n"
        "Keep action names lowercase. Keep locomotion in place; derive travel "
        "from planted paw displacement after export. The root is a non-deforming "
        "ground control. Pelvis/spine/chest carry body motion. Two neck joints "
        "support graze/alert, jaw supports the future trout pose, separate ears "
        "support listening, and every leg retains upper/lower/foot/toe controls.\n"
    )


def validate(body, rig, action):
    expected = {
        "root", "pelvis", "spine_01", "chest", "neck_01", "neck_02", "head", "jaw",
        "ear.L", "ear.R", "scapula.L", "scapula.R",
        "fore_upper.L", "fore_lower.L", "fore_foot.L", "fore_toe.L",
        "fore_upper.R", "fore_lower.R", "fore_foot.R", "fore_toe.R",
        "hind_upper.L", "hind_lower.L", "hind_foot.L", "hind_toe.L",
        "hind_upper.R", "hind_lower.R", "hind_foot.R", "hind_toe.R",
        "tail_01", "tail_02",
    }
    actual = {bone.name for bone in rig.data.bones}
    assert actual == expected, (expected - actual, actual - expected)
    assert rig.data.bones["root"].use_deform is False
    assert body.find_armature() == rig
    assert action.name == "idle"
    assert tuple(round(v) for v in action.frame_range) == (0, 48)
    assert min((body.matrix_world @ v.co).z for v in body.data.vertices) > -0.08
    assert max((body.matrix_world @ v.co).z for v in body.data.vertices) > 1.85
    unweighted = [
        vertex.index for vertex in body.data.vertices
        if not any(group.weight > 0 for group in vertex.groups)
    ]
    assert not unweighted, f"Unweighted body vertices: {len(unweighted)}"
    print(
        "BEAR_VALID",
        f"verts={len(body.data.vertices)}",
        f"faces={len(body.data.polygons)}",
        f"bones={len(rig.data.bones)}",
        f"action={action.name}",
        f"range={tuple(action.frame_range)}",
    )


def main():
    clear_scene()
    materials = (
        material("Bear black-brown coat", (0.018, 0.020, 0.025), 0.86),
        material("Bear warm muzzle", (0.048, 0.036, 0.030), 0.84),
        material("Bear charcoal", (0.008, 0.006, 0.004), 0.86),
        material("Bear claws", (0.080, 0.060, 0.045), 0.74),
        material("Bear eye", (0.003, 0.002, 0.001), 0.20),
    )
    body = build_body(materials)
    rig = build_rig(body)
    details = build_details(rig, materials)
    action = build_idle(rig)
    build_presentation(materials)
    add_readme()
    validate(body, rig, action)

    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    body.select_set(True)
    for detail in details:
        detail.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.context.scene.frame_set(0)
    BLEND_PATH.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PATH), compress=True)

    # Render a breathing pose without changing the frame stored in the file.
    bpy.context.scene.frame_set(12)
    bpy.ops.render.render(write_still=True)
    bpy.context.scene.frame_set(0)
    print("BEAR_COMPLETE", BLEND_PATH, RENDER_PATH)


if __name__ == "__main__":
    main()
