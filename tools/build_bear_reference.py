"""Build the stylized, rigged black-bear source asset.

Run with Blender, not the system Python::

    blender --factory-startup -b --python tools/build_bear_reference.py

The generated file is intentionally an editable source asset rather than a
shipping export.  It mirrors the conventions of ``fox_reference.blend``:

* +Y is forward, +Z is up, and the paws rest on Z=0.
* one fused, smooth-shaded low-poly body carries flat material regions;
* eyes and claws are small rigid-skinned detail meshes;
* the armature has a non-deforming root and an in-place looping action;
* the presentation floor, camera and lights are saved but are not rig children.

The source carries ``idle``, the variable-duration ``graze_in`` -> ``graze``
-> ``graze_out`` behavior, ``alert``, ``Walk``, ``Trot`` and ``run``. The
neck, jaw, ears, scapulae, three-part legs and tail remain separate in the
deform rig so ``trout`` can be added without changing it.
"""

from pathlib import Path
import math

import bpy
from mathutils import Vector, Matrix


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


def rounded_ear(name, center, scale, tilt, segments=16, rings=12):
    """Make a rounded ear: a flattened ellipsoid tilted out of the skull.

    A black bear's ear is a short rounded fan -- wide across, shallow front to
    back, blunt at the top.  Building it from a cone gave it a point, which
    reads as a fox from every angle the game ever shows.  The tilt leans the
    top outboard so the pair does not sit on the crown like two flat discs.
    """
    ob = uv(name, center, scale, segments, rings)
    ob.rotation_euler = (0.0, math.radians(tilt), 0.0)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
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
        # Rounded, not pointed.  The base is sunk well under the skull surface
        # -- at this y the head only reaches z=1.70 out at x=0.245 -- so the
        # remesh fuses ear to head instead of leaving a disc perched on it.
        rounded_ear("Bear ear left", (-0.255, 1.02, 1.84), (0.130, 0.085, 0.225), -15),
        rounded_ear("Bear ear right", (0.255, 1.02, 1.84), (0.130, 0.085, 0.225), 15),
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


MAX_INFLUENCES = 4      # glTF stores four joints per vertex
WEIGHT_EPSILON = 1e-4

# How far each bone's influence carries.  Distal bones hold a tight field so a
# paw cannot claim a belly; core bones hold a broad one so the torso deforms as
# one surface instead of three.
BONE_REACH = (
    ("ear.", 0.16), ("jaw", 0.26), ("head", 0.34), ("neck_", 0.34),
    ("chest", 0.44), ("spine_", 0.46), ("pelvis", 0.50), ("tail_", 0.20),
    ("scapula.", 0.30),
    ("fore_upper.", 0.28), ("fore_lower.", 0.24), ("fore_foot.", 0.20),
    ("hind_upper.", 0.32), ("hind_lower.", 0.27), ("hind_foot.", 0.22),
)


def smoothstep(value, lo, hi):
    """0 below *lo*, 1 above *hi*, with a smooth ramp in between.

    Every anatomical rule in :func:`anatomical_bias` is written with this
    rather than a comparison, so no rule can hand two neighbouring vertices
    a different set of bones.
    """
    if hi <= lo:
        return 0.0 if value < lo else 1.0
    t = min(1.0, max(0.0, (value - lo) / (hi - lo)))
    return t * t * (3.0 - 2.0 * t)


def bone_reach(name):
    for prefix, reach in BONE_REACH:
        if name.startswith(prefix):
            return reach
    return 0.34


def anatomical_bias(name, co):
    """A smooth prior in [0, 1] for one bone at one point.

    This carries the same anatomy the old region gates encoded — ears drive
    ears, a forepaw is not a jaw, a hind leg does not drive the shoulder — but
    every rule is a ramp instead of a threshold.  A threshold is what put two
    vertices sharing an edge on bones with nothing in common.
    """
    x, y, z = co
    lateral = -x if name.endswith(".L") else x

    if name.startswith("ear."):
        # Ears reach the ear cones only; the skull beneath hands over gradually.
        return (smoothstep(z, 1.56, 1.80)
                * smoothstep(y, 0.82, 1.00)
                * smoothstep(lateral, 0.06, 0.20))
    if name == "jaw":
        return smoothstep(y, 1.08, 1.34) * (1.0 - smoothstep(z, 1.44, 1.62))
    if name == "head":
        # Held above the forepaws, which reach past Y=1 at ground level.
        return smoothstep(y, 0.82, 1.10) * smoothstep(z, 0.52, 0.86)
    if name.startswith("neck_"):
        return smoothstep(y, 0.30, 0.70) * smoothstep(z, 0.60, 0.95)
    if name.startswith("tail_"):
        return (1.0 - smoothstep(y, -1.52, -1.24)) * smoothstep(z, 1.00, 1.24)
    if name in ("chest", "spine_01", "pelvis"):
        # The core owns anything not clearly a limb, so it needs no bias.
        return 1.0

    # Limb chains.  Two ramps replace two hard planes: a same-side ramp in
    # place of ``x < 0``, and a fore/hind crossfade across the flank in place
    # of ``y > -0.10``.  The flank is where the old split tore worst.
    bias = smoothstep(lateral, -0.04, 0.22)
    if name.startswith("fore_") or name.startswith("scapula."):
        # A forelimb claims the flank behind it and nothing in front of the
        # brisket.  Without the forward cutoff the upper arm competes with the
        # neck over the shoulder crease, which is where the two surfaces of
        # the fused body run closest and a disagreement shows soonest.
        bias *= smoothstep(y, -0.62, 0.10) * (1.0 - smoothstep(y, 0.60, 1.02))
        # And nothing over the top of the withers.  The scapula belongs under
        # the hump, not on its crown; the ramp starts above the shoulder joint
        # rather than through it, which is where the old z<1.34 plane cut.
        bias *= 1.0 - smoothstep(z, 1.58, 1.96)
    else:
        bias *= 1.0 - smoothstep(y, -0.66, -0.04)
        bias *= 1.0 - smoothstep(z, 1.52, 1.90)
    if "_foot." in name:
        # The plantigrade paw is still rigid: the foot owns the sole outright
        # and its field dies out through the ankle rather than at a plane.
        bias *= 1.0 - smoothstep(z, 0.26, 0.74)
    elif "_lower." in name:
        bias *= smoothstep(z, 0.24, 0.58)
    return bias


def normalize_influences(scores, limit=MAX_INFLUENCES):
    """Keep the strongest *limit* bones and make them sum to one.

    Shrinking each weight by the largest one that missed the cut was tried
    here and made the field measurably worse: relaxation leaves a broad,
    nearly flat set of influences, and subtracting a floor from a flat set
    magnifies the small differences between neighbours instead of hiding
    them.  A plain rank cut on an already-relaxed field is the gentler one.
    """
    ranked = sorted(scores.items(), key=lambda item: item[1], reverse=True)[:limit]
    kept = [item for item in ranked if item[1] > WEIGHT_EPSILON] or ranked[:1]
    total = sum(weight for _, weight in kept) or 1.0
    return {name: weight / total for name, weight in kept}


def relax_weight_field(mesh, field, iterations=12, factor=0.55, polish=3):
    """Laplacian-relax the weight field across mesh topology.

    Any rule written in world space is blind to the surface it is painting.
    Averaging each vertex against its edge neighbours works in the only space
    that matters for skinning — the mesh itself — and turns whatever step
    survived the smooth bias into a ramp spread over several edge rings.  It
    moves no vertex, so the rest silhouette the remesh/decimate pass produced
    is untouched and the modelling work is unchanged.
    """
    neighbours = [[] for _ in mesh.vertices]
    for edge in mesh.edges:
        i, j = edge.vertices
        neighbours[i].append(j)
        neighbours[j].append(i)

    def relax(field, rounds):
        for _ in range(rounds):
            updated = []
            for index, scores in enumerate(field):
                linked = neighbours[index]
                if not linked:
                    updated.append(scores)
                    continue
                # A convex combination of normalised dicts is still normalised.
                blended = {name: weight * (1.0 - factor)
                           for name, weight in scores.items()}
                share = factor / len(linked)
                for other in linked:
                    for name, weight in field[other].items():
                        blended[name] = blended.get(name, 0.0) + weight * share
                updated.append(blended)
            field = updated
        return field

    field = relax(field, iterations)
    # Cutting to four influences is itself a step.  Where the fourth and fifth
    # bones are nearly tied, two neighbours keep different ones and disagree
    # about the tail of the distribution even though they agree about its
    # head.  Alternating the cut with short relaxations lets them converge on
    # the same four bones rather than settling on different ones.
    for _ in range(polish):
        field = relax([normalize_influences(scores) for scores in field], 2)
    return [normalize_influences(scores) for scores in field]


def assign_weights(body, deform_bones):
    """Skin the fused body with a field that is continuous across the surface.

    The failure this exists to prevent shipped once already.  When a rule
    picks a *candidate list* per vertex, two vertices sharing an edge can end
    up with lists that have no bone in common.  At rest the mesh looks
    perfect.  The moment those bones disagree by a few degrees the edge
    between them shears, and the surface creases, buckles, and finally folds
    through itself — worst at the withers, where the old ``z < 1.34`` and
    ``abs(x) > 0.20`` planes crossed.  Scoring every bone against a smooth
    bias removes the steps; relaxing the field afterwards guarantees it.
    """
    groups = {name: body.vertex_groups.new(name=name) for name in deform_bones}
    mesh = body.data

    field = []
    for vertex in mesh.vertices:
        co = vertex.co
        scores = {}
        for name, bone in deform_bones.items():
            bias = anatomical_bias(name, co)
            if bias <= 0.0:
                continue
            distance = segment_distance(co, bone.head_local, bone.tail_local)
            score = bias * math.exp(-((distance / bone_reach(name)) ** 2))
            if score > 1e-9:
                scores[name] = score
        if not scores:
            # Never leave a vertex unweighted; fall back to the nearest bone.
            nearest = min(deform_bones, key=lambda name: segment_distance(
                co, deform_bones[name].head_local, deform_bones[name].tail_local))
            scores = {nearest: 1.0}
        # Relaxation needs more than the final four to average over.
        field.append(normalize_influences(scores, limit=8))

    for index, scores in enumerate(relax_weight_field(mesh, field)):
        for name, weight in scores.items():
            groups[name].add([index], weight, "REPLACE")


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
    rig["planned_actions"] = "trout"
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
        # The contact point, named so it can be measured. A paw's tip is the one
        # part of the leg that is stationary on the ground through a stance --
        # the ankle arcs over it as the foot rolls, which reads 23% fast at a
        # walk -- and glTF has no way to refer to a leaf bone's tail. A zero-
        # weight child bone whose ORIGIN sits there gives the loader the exact
        # point to sample. See `glb.feet` in mammals/bear.js.
        add_bone(armature, f"fore_tip.{side}", (x, toe_y + 0.25, 0.055), (x, toe_y + 0.33, 0.055), f"fore_toe.{side}", deform=False)

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
        add_bone(armature, f"hind_tip.{side}", (x, toe_y + 0.28, 0.055), (x, toe_y + 0.36, 0.055), f"hind_toe.{side}", deform=False)

    add_bone(armature, "tail_01", (0, -1.40, 1.48), (0, -1.62, 1.44), "pelvis")
    add_bone(armature, "tail_02", (0, -1.62, 1.44), (0, -1.74, 1.40), "tail_01")
    bpy.ops.object.mode_set(mode="OBJECT")

    # Parent and deform exactly as the fox source does.
    body.parent = rig
    body.matrix_parent_inverse = rig.matrix_world.inverted()
    modifier = body.modifiers.new("Armature", "ARMATURE")
    modifier.object = rig

    # Continuous skin weights.  Every vertex scores every deform bone and the
    # anatomy is a smooth bias, never a hard candidate list; see
    # ``assign_weights`` for why that distinction is the whole ballgame.
    deform_bones = {b.name: b for b in armature.bones if b.use_deform}
    assign_weights(body, deform_bones)

    return rig


def bone_parent(ob, rig, bone_name, world_matrix=None):
    """Rigid-skin a detail mesh to one bone while preserving its rest pose.

    Blender's direct BONE parenting adds the bone-tail transform to an
    object's existing transform.  That is easy to miss on tiny eyes, but it
    pulled the claws away from the paw as soon as a locomotion action was
    evaluated.  A one-group armature skin uses the same rest-to-pose matrix as
    the fused body and therefore keeps each rigid detail welded to its paw.
    """
    world_matrix = ob.matrix_world.copy() if world_matrix is None else world_matrix
    # Armature deformation is evaluated in the armature's coordinate space.
    # Bake the detail's construction transform into its mesh first; otherwise
    # a claw whose object origin is near the world origin is treated as though
    # its vertices live there and sweeps through a long arc when the paw bends.
    ob.matrix_world = world_matrix
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    ob.parent = rig
    ob.parent_type = "OBJECT"
    ob.matrix_parent_inverse = rig.matrix_world.inverted()
    group = ob.vertex_groups.new(name=bone_name)
    group.add([vertex.index for vertex in ob.data.vertices], 1.0, "REPLACE")
    modifier = ob.modifiers.new("Rigid bone skin", "ARMATURE")
    modifier.object = rig


def build_details(rig, materials):
    _coat, _muzzle, _charcoal, claw_mat, eye_mat = materials
    details = []

    # A bear faces its eyes forward.  The old pair sat at x=+-0.32, which is
    # the head ellipsoid's equator: the surface normal there points almost
    # straight out to the side, so they read as two beads on the widest part
    # of the silhouette -- a deer's eye placement, not a predator's.
    #
    # These sit on the front-upper quadrant instead, on the brow just above
    # where the muzzle springs from the face.  (0.165, 1.518, 1.625) is on the
    # skull surface; the stored centre is that offset scaled to 0.945 so the
    # lens beds into the face rather than balancing on it.
    for side, x in (("L", -0.156), ("R", 0.156)):
        eye = uv(f"Bear eye {side}", (x, 1.499, 1.620), (0.030, 0.024, 0.027), 12, 8)
        # The fused body is smooth-shaded; a flat-shaded eye broke the
        # catchlight into a blocky square, which is the one highlight on the
        # whole animal a viewer actually looks at.
        for poly in eye.data.polygons:
            poly.use_smooth = True
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
    action.use_frame_range = True
    action.frame_start, action.frame_end = 0, 48
    action["loop"] = True
    action["duration_frames"] = 48
    action["description"] = "Quiet breathing with a small head drift and one listening ear flick."
    rig.animation_data_create()
    rig.animation_data.action = action

    for pose_bone in rig.pose.bones:
        pose_bone.rotation_mode = "XYZ"
    reset_pose(rig)
    key_rest_channels(rig, 0)

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
        (0, (0, 0, 0)), (12, (0, 0.010, 0)), (24, (0, 0, 0)),
        (36, (0, -0.006, 0)), (48, (0, 0, 0)),
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
    set_action_handles(action, loop=True)
    scene.frame_set(0)
    return action


def action_fcurves(action):
    """Yield Blender 5.x f-curves from a slotted action."""
    for layer in action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                yield from bag.fcurves


def set_action_handles(action, loop=False):
    """Set smooth handles; looped clips get matching tangents at the seam."""
    if not loop:
        for curve in action_fcurves(action):
            for key in curve.keyframe_points:
                key.interpolation = "BEZIER"
                key.handle_left_type = "AUTO_CLAMPED"
                key.handle_right_type = "AUTO_CLAMPED"
            curve.update()
        return

    first, last = action.frame_range
    period = last - first
    for curve in action_fcurves(action):
        points = curve.keyframe_points
        count = len(points) - 1  # the final key duplicates the first
        if count < 2:
            continue
        times = [key.co[0] for key in points]
        values = [key.co[1] for key in points]
        for index, key in enumerate(points):
            wrapped = index % count
            previous = (wrapped - 1) % count
            following = (wrapped + 1) % count
            dt_previous = (times[wrapped] - times[previous]) % period or period
            dt_following = (times[following] - times[wrapped]) % period or period
            before, here, after = values[previous], values[wrapped], values[following]
            slope = 0.0 if (here - before) * (after - here) <= 0 else \
                (after - before) / (dt_previous + dt_following)
            left_reach, right_reach = dt_previous / 3.0, dt_following / 3.0
            key.handle_left = (times[index] - left_reach, here - slope * left_reach)
            key.handle_right = (times[index] + right_reach, here + slope * right_reach)
            key.handle_left_type = "FREE"
            key.handle_right_type = "FREE"
            key.interpolation = "BEZIER"
        curve.update()


def reset_pose(rig):
    for bone in rig.pose.bones:
        bone.rotation_mode = "XYZ"
        bone.location = (0, 0, 0)
        bone.rotation_euler = (0, 0, 0)
        bone.scale = (1, 1, 1)


def key_rest_channels(rig, frame):
    """Give an action explicit ownership of every pose transform channel.

    Blender deliberately preserves channels that the newly selected action
    does not animate.  Without these constant rest keys, switching directly
    from run to idle could leave a hind leg gathered or an alert ear pinned
    back.  Selective authored keys replace the matching rest keys below.
    """
    bpy.context.scene.frame_set(frame)
    for bone in rig.pose.bones:
        bone.keyframe_insert("rotation_euler", frame=frame, group=bone.name)
        bone.keyframe_insert("location", frame=frame, group=bone.name)


def new_action(rig, name, end_frame, loop, description):
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    action.use_frame_range = True
    action.frame_start = 0
    action.frame_end = end_frame
    action["loop"] = loop
    action["duration_frames"] = end_frame
    action["description"] = description
    rig.animation_data.action = action
    reset_pose(rig)
    key_rest_channels(rig, 0)
    return action


def key_pose(rig, frame, rotations=None, locations=None):
    """Key one complete authored pose. Rotation values are degrees."""
    bpy.context.scene.frame_set(frame)
    for name, degrees in (rotations or {}).items():
        bone = rig.pose.bones[name]
        bone.rotation_euler = tuple(math.radians(value) for value in degrees)
        bone.keyframe_insert("rotation_euler", frame=frame, group=name)
    for name, value in (locations or {}).items():
        bone = rig.pose.bones[name]
        bone.location = value
        bone.keyframe_insert("location", frame=frame, group=name)


# ─────────────────────────────────────────────────────────────────────────────
#  The locomotion clips.
#
#  Walk, Trot and run are SOLVED rather than hand-keyed in degrees, and they are
#  the only clips in this file that are. The bear stands at 0.97 of its own leg
#  reach, so a few degrees at the hip is the difference between a planted paw
#  and a paw 40 cm in the air. Hand-keyed, none of the three found the ground:
#
#      Walk   front paws 112 mm BELOW the floor, travelling FORWARD while down
#      Trot   in contact for 1 frame in 16
#      run    every paw airborne 14 frames in 16, both legs of a pair in lockstep
#
#  A foot that is not on the ground cannot be measured, and a clip that cannot
#  be measured cannot drive an animal at the right speed -- which is what made
#  the bear skate. Below, the PAW is authored in world space on the ground and
#  the joint angles are whatever reach it.
# ─────────────────────────────────────────────────────────────────────────────

GROUND = 0.055                   # world Z of a planted toe tip, from the rest pose


# ── curve evaluation ─────────────────────────────────────────────────────────
def hermite(points, u):
    """Evaluate a periodic Hermite spline at *u*.

    Each point is ``(u, value, tangent)``; a tangent of ``None`` takes the
    Catmull-Rom centred difference. Pinning the tangent is what keeps a planted
    paw honest: through the stance the tip's fore-aft track is three collinear
    points carrying the ground slope, so the spline is exactly linear there and
    the paw cannot creep. Everywhere else the free tangents give the swing ease.
    """
    n = len(points)
    us = [p[0] for p in points]
    vs = [p[1] for p in points]
    tangents = []
    for i in range(n):
        if points[i][2] is not None:
            tangents.append(points[i][2])
            continue
        before, after = (i - 1) % n, (i + 1) % n
        span = (us[after] - us[before]) % 1.0 or 1.0
        tangents.append((vs[after] - vs[before]) / span)

    u %= 1.0
    for i in range(n):
        span = (us[(i + 1) % n] - us[i]) % 1.0 or 1.0
        t = (u - us[i]) % 1.0
        if t > span + 1e-9:
            continue
        t /= span
        v0, v1 = vs[i], vs[(i + 1) % n]
        m0, m1 = tangents[i] * span, tangents[(i + 1) % n] * span
        t2, t3 = t * t, t * t * t
        return ((2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0
                + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1)
    return vs[-1]


def track(duty, stance, swing, tangent=None):
    """Build a limb-phase track from stance-fraction and swing-fraction parts.

    Written this way so duty stays a knob rather than a number baked into every
    table: the stance keys are placed across 0..duty and the swing keys across
    the rest, so changing how long a pair stays down does not desynchronise its
    paw lift from its ankle roll.
    """
    return ([(f * duty, v, tangent) for f, v in stance]
            + [(duty + f * (1.0 - duty), v, None) for f, v in swing])


def paw_tracks(gait):
    """Turn one gait's spec into the four per-limb curves the solver reads."""
    out = {}
    for kind in ("hind", "fore"):
        duty = gait["duty"][kind]
        reach = gait["sweep"] * duty
        plant = gait["plant"][kind]
        out[kind] = {
            # The stance is generated, never typed: the plant point sweeping
            # backwards at `sweep`, tangent pinned so the paw cannot creep
            # between keys. Every paw of every gait uses the same `sweep`, or
            # the feet scrub against each other.
            "y": track(duty,
                       [(0.0, plant), (0.5, plant - reach / 2), (1.0, plant - reach)],
                       [(f, plant + reach * v) for f, v in gait["y_swing"][kind]],
                       tangent=-gait["sweep"]),
            "z": track(duty, [(0.0, GROUND), (0.5, GROUND), (1.0, GROUND)],
                       gait["z_swing"][kind], tangent=0.0),
            "x": track(duty, gait["x_stance"][kind], gait["x_swing"][kind]),
            "foot": track(duty, gait["foot_stance"][kind], gait["foot_swing"][kind]),
            "toe": track(duty, gait["toe_stance"][kind], gait["toe_swing"][kind]),
        }
    return out


# ── kinematics ───────────────────────────────────────────────────────────────
def two_bone(hip, target, l1, l2, pole):
    """Return world directions for an upper/lower pair reaching *target*.

    Straight trigonometry in the plane through the hip, the target and the pole
    hint. Returns the unclamped ratio alongside, so the caller can tell a leg
    that reached from a leg that ran out of leg -- the second one slides.
    """
    to = target - hip
    span = to.length
    ratio = span / (l1 + l2)
    limit = (l1 + l2) * 0.985
    if span > limit:
        to *= limit / span
        span = limit
    floor = abs(l1 - l2) + 1e-3
    if span < floor:
        to *= floor / max(span, 1e-6)
        span = floor
    axis = to / span

    side = Vector(pole) - axis * Vector(pole).dot(axis)
    if side.length < 1e-6:
        side = Vector((0.0, 1.0, 0.0)) - axis * axis.y
    side.normalize()

    cosine = max(-1.0, min(1.0, (l1 * l1 + span * span - l2 * l2) / (2 * l1 * span)))
    angle = math.acos(cosine)
    upper = (axis * math.cos(angle) + side * math.sin(angle)).normalized()
    knee = hip + upper * l1
    lower = (hip + to - knee).normalized()
    return upper, lower, ratio


class GaitPoser:
    """Poses the rig one frame at a time, in world space."""

    def __init__(self, rig, gait):
        self.rig = rig
        self.arm = rig.data
        self.gait = gait
        self.tracks = paw_tracks(gait)

    def sync(self):
        bpy.context.view_layer.update()

    def rest_dir(self, name):
        return self.arm.bones[name].matrix_local.to_3x3().col[1].normalized()

    def euler(self, name, degrees):
        pb = self.rig.pose.bones[name]
        pb.rotation_euler = tuple(math.radians(v) for v in degrees)
        self.sync()

    def aim(self, name, world_dir):
        """Point a posed bone along *world_dir*, minimal twist from its rest.

        Writes the bone's own rotation only -- the head keeps following the
        parent's tail, so the chain stays the chain. Solving in world space and
        converting back is what stops the legs splaying: these bones' local X
        axes sit up to 16 degrees off world X, so a plain `rotation.x` swings a
        leg sideways as it swings it forward, and the old hind paws tracked
        39 cm out and back across one stride.
        """
        pb = self.rig.pose.bones[name]
        bone = self.arm.bones[name]
        rest = bone.matrix_local.to_3x3()
        heading = Vector(world_dir).normalized()
        desired = rest.col[1].normalized().rotation_difference(heading).to_matrix() @ rest
        if bone.parent:
            parent = self.rig.pose.bones[bone.parent.name]
            relative = (bone.parent.matrix_local.inverted() @ bone.matrix_local).to_3x3()
            basis = (parent.matrix.to_3x3() @ relative).inverted() @ desired
        else:
            basis = rest.inverted() @ desired
        pb.rotation_euler = basis.to_euler("XYZ", pb.rotation_euler)
        self.sync()

    def leg(self, kind, side, phase):
        """Place one limb's paw and solve the joints that reach it."""
        curves = self.tracks[kind]
        limb = (phase - self.gait["contact"][(kind, side)]) % 1.0

        upper, lower = f"{kind}_upper.{side}", f"{kind}_lower.{side}"
        foot, toe = f"{kind}_foot.{side}", f"{kind}_toe.{side}"
        outward = -1.0 if side == "L" else 1.0

        rest_tip = self.arm.bones[toe].tail_local
        tip = Vector((rest_tip.x + outward * hermite(curves["x"], limb),
                      hermite(curves["y"], limb),
                      hermite(curves["z"], limb)))

        toe_dir = (Matrix.Rotation(math.radians(hermite(curves["toe"], limb)), 3, "X")
                   @ self.rest_dir(toe))
        toe_base = tip - toe_dir * self.arm.bones[toe].length
        foot_dir = (Matrix.Rotation(math.radians(hermite(curves["foot"], limb)), 3, "X")
                    @ self.rest_dir(foot))
        ankle = toe_base - foot_dir * self.arm.bones[foot].length

        hip = self.rig.pose.bones[upper].head.copy()
        # The stifle leads forward and the elbow trails back; both track a
        # little outboard so the knees never cross under the belly.
        pole = Vector((outward * 0.14, 1.0 if kind == "hind" else -1.0, 0.15))
        up_dir, low_dir, ratio = two_bone(
            hip, ankle, self.arm.bones[upper].length, self.arm.bones[lower].length, pole)

        self.aim(upper, up_dir)
        self.aim(lower, low_dir)
        self.aim(foot, foot_dir)
        self.aim(toe, toe_dir)
        return ratio

    def frame(self, phase, clip_phase):
        """Pose the whole animal for one cycle phase.

        *clip_phase* runs 0..1 across the WHOLE clip rather than one stride and
        carries a slow head sweep: identical repeated strides read as a loop,
        and one drifting look across all of them is what breaks that up.
        """
        g = self.gait
        b = g["body"]
        flex = hermite(g["flex"], phase)
        pump = hermite(g["head_pump"], phase)
        roll = hermite(g["roll"], phase) if g.get("roll") else 0.0
        sweep = b["look"] * math.sin(2 * math.pi * clip_phase)

        root = self.rig.pose.bones["root"]
        root.location = (0.0, hermite(g["root_lift"], phase),
                         -hermite(g["root_surge"], phase))
        self.euler("root", (hermite(g["root_pitch"], phase), 0, 0))

        # The loin does most of the arching and the chest takes it back out, so
        # the back rounds over the middle instead of the whole front of the
        # animal being levered upward -- the shoulder is what the forelimbs hang
        # from, and it has to hold still while they carry weight.
        self.euler("pelvis", (b["pelvis"] * flex, 0, 0.8 * sweep + roll))
        self.euler("spine_01", (b["spine"] * flex, 0, 0.5 * sweep - 0.35 * roll))
        self.euler("chest", (b["chest"] * flex, 0, -0.4 * sweep - 0.45 * roll))
        # The neck carries flex with the OPPOSITE sign to the trunk, and that
        # sign is the whole point. A moving animal stabilises its head: the body
        # oscillates underneath and the eyes stay level. Carried the same way as
        # the trunk the terms compound down a 1.3 m chain of neck and skull, and
        # in the gallop the muzzle swung 82 cm and ploughed the ground.
        # Counter-rotated it swings 57, and at a walk it swings 12.6 cm
        # against the shoulder's 13.7 -- the head moving LESS than the
        # body underneath it, which is what a stabilised head means.
        self.euler("neck_01", (b["neck1"] - b["neck_flex"] * flex + b["pump1"] * pump,
                               0, sweep + 0.2 * roll))
        self.euler("neck_02", (b["neck2"] - 0.6 * b["neck_flex"] * flex + b["pump2"] * pump,
                               0, 0.5 * sweep))
        self.euler("head", (b["head"] + 0.6 * b["neck_flex"] * flex + b["pump3"] * pump,
                            0, -0.6 * sweep))
        self.euler("jaw", (b["jaw"] - 3 * pump * b["jaw_move"], 0, 0))
        self.euler("ear.L", (b["ear"] + 2 * pump * b["ear_move"], 0, b["ear_out"]))
        self.euler("ear.R", (b["ear"] + 2 * pump * b["ear_move"], 0, -b["ear_out"]))
        self.euler("tail_01", (b["tail1"] - 4 * flex, 0, 2 * sweep))
        self.euler("tail_02", (b["tail2"] - 3 * flex, 0, 1.5 * sweep))

        for side in ("L", "R"):
            # The scapula swings with its own foreleg -- on a quadruped it is a
            # third of the fore stride -- and it moves the shoulder, so it has
            # to be posed before the arm solves against it.
            limb = (phase - g["contact"][("fore", side)]) % 1.0
            self.euler(f"scapula.{side}",
                       (b["scapula"] * math.cos(2 * math.pi * (limb - 0.90)), 0, 0))

        ratios = {}
        for kind in ("hind", "fore"):
            for side in ("L", "R"):
                ratios[f"{kind}.{side}"] = self.leg(kind, side, phase)
        return ratios


# ── the three gaits ──────────────────────────────────────────────────────────
# `sweep` is how much ground a planted paw covers per unit of limb phase, and it
# alone decides the clip's speed: ground per cycle IS sweep, because a paw
# sweeps for `duty` of the cycle at `sweep`/unit-phase. Duty only decides how
# far each individual foot travels while down -- which is why cutting duty buys
# speed for free, and why a fast gait can be quick without asking any leg for
# reach it does not have. That matters here more than on most rigs: the bear
# stands at 0.97 of its leg reach, so per-paw sweep is the scarce resource.

_STANDING = {                    # what every gait's body block starts from
    "look": 2.5, "pelvis": 4.0, "spine": 7.0, "chest": -8.0,
    "neck1": -7.0, "neck2": -4.0, "head": 7.0, "neck_flex": 5.0,
    "pump1": 2.5, "pump2": 1.5, "pump3": 2.0,
    "jaw": -7.0, "jaw_move": 1.0, "ear": 17.0, "ear_move": 1.0, "ear_out": 6.0,
    "tail1": -16.0, "tail2": -9.0, "scapula": 10.0,
}


def _body(**over):
    return {**_STANDING, **over}


GAITS = {
    # ── Walk: lateral-sequence four-beat, the bear's rolling amble ───────────
    # LH, LF, RH, RF evenly spaced, duty 0.62 so two or three paws are always
    # down. The old clip had its front paws 112 mm through the floor and moving
    # FORWARD while planted, which is why the walk read as a shuffle.
    "Walk": {
        "frames": 48, "stride_frames": 48, "loop": True,
        "description": ("Lateral-sequence four-beat walk: long overlapping "
                        "stances, plantigrade heel-down, heavy shoulder roll."),
        "contact": {("hind", "L"): 0.00, ("fore", "L"): 0.25,
                    ("hind", "R"): 0.50, ("fore", "R"): 0.75},
        "duty": {"hind": 0.62, "fore": 0.62},
        "sweep": 1.748,
        "plant": {"hind": -0.295, "fore": 1.24},
        "y_swing": {"hind": [(0.22, -1.10), (0.52, -0.55), (0.82, 0.06)],
                    "fore": [(0.22, -1.09), (0.52, -0.52), (0.82, 0.05)]},
        "z_swing": {"hind": [(0.20, 0.13), (0.48, 0.20), (0.76, 0.11), (0.92, 0.03)],
                    "fore": [(0.20, 0.12), (0.48, 0.18), (0.76, 0.10), (0.92, 0.03)]},
        "foot_stance": {"hind": [(0.00, -8), (0.22, 10), (0.62, 14), (0.86, 2), (1.00, -30)],
                        "fore": [(0.00, -7), (0.22, 9), (0.62, 12), (0.86, 1), (1.00, -26)]},
        "foot_swing": {"hind": [(0.25, -14), (0.55, 8), (0.80, 10), (0.94, -6)],
                       "fore": [(0.25, -12), (0.55, 7), (0.80, 9), (0.94, -5)]},
        "toe_stance": {"hind": [(0.00, -3), (0.30, 0), (0.75, -4), (1.00, -20)],
                       "fore": [(0.00, -3), (0.30, 0), (0.75, -4), (1.00, -18)]},
        "toe_swing": {"hind": [(0.25, -4), (0.60, 3), (0.88, 0)],
                      "fore": [(0.25, -4), (0.60, 3), (0.88, 0)]},
        "x_stance": {"hind": [(0.00, 0.0), (1.00, 0.0)],
                     "fore": [(0.00, -0.02), (1.00, -0.02)]},
        "x_swing": {"hind": [(0.50, 0.03), (0.90, 0.01)],
                    "fore": [(0.50, 0.01), (0.90, 0.0)]},
        # Four footfalls give the body two shallow dips, not four: the pairs
        # load together enough that the trunk reads as rocking, not stuttering.
        "root_lift": [
        (0.00, -0.1, None), (0.14, -0.14, None), (0.26, -0.1, None),
        (0.38, -0.13, None), (0.50, -0.1, None), (0.64, -0.14, None),
        (0.76, -0.1, None), (0.88, -0.13, None)
    ],
        "root_surge": [(0.00, 0.0, None), (0.25, 0.008, None),
                       (0.50, 0.0, None), (0.75, -0.008, None)],
        "root_pitch": [(0.00, 0.4, None), (0.25, -0.5, None),
                       (0.50, 0.4, None), (0.75, -0.5, None)],
        # A walking bear's shoulders roll visibly, once per lateral pair.
        "roll": [(0.00, 2.2, None), (0.25, 0.0, None),
                 (0.50, -2.2, None), (0.75, 0.0, None)],
        "flex": [(0.00, 0.5, None), (0.25, -0.4, None),
                 (0.50, 0.5, None), (0.75, -0.4, None)],
        "head_pump": [(0.00, 0.5, None), (0.25, -0.5, None),
                      (0.50, 0.5, None), (0.75, -0.5, None)],
        "body": _body(pelvis=1.6, spine=2.4, chest=-2.6, neck1=-3.0, neck2=-2.0,
                      head=4.0, neck_flex=2.0, pump1=1.6, pump2=1.0, pump3=1.2,
                      jaw=0.0, jaw_move=0.0, ear=2.0, ear_move=0.6, ear_out=2.0,
                      tail1=-4.0, tail2=-2.0, scapula=6.0, look=2.0),
    },

    # ── Trot: diagonal pairs, the bear's ground-covering gait ────────────────
    "Trot": {
        "frames": 16, "stride_frames": 16, "loop": True,
        "description": ("Diagonal-pair trot: LH with RF, RH with LF, a short "
                        "suspension between the two beats."),
        "contact": {("hind", "L"): 0.00, ("fore", "R"): 0.00,
                    ("hind", "R"): 0.50, ("fore", "L"): 0.50},
        "duty": {"hind": 0.42, "fore": 0.42},
        "sweep": 2.186,
        "plant": {"hind": -0.32, "fore": 0.995},
        "y_swing": {"hind": [(0.20, -1.10), (0.50, -0.50), (0.84, 0.09)],
                    "fore": [(0.20, -1.09), (0.50, -0.48), (0.84, 0.07)]},
        "z_swing": {"hind": [(0.18, 0.20), (0.44, 0.33), (0.72, 0.22), (0.90, 0.08)],
                    "fore": [(0.18, 0.18), (0.44, 0.29), (0.72, 0.19), (0.90, 0.07)]},
        "foot_stance": {"hind": [(0.00, -14), (0.30, 6), (0.60, 10), (0.84, -2), (1.00, -34)],
                        "fore": [(0.00, -13), (0.30, 5), (0.60, 9), (0.84, -2), (1.00, -31)]},
        "foot_swing": {"hind": [(0.22, -20), (0.48, 8), (0.75, 12), (0.92, -4)],
                       "fore": [(0.22, -18), (0.48, 7), (0.75, 11), (0.92, -3)]},
        "toe_stance": {"hind": [(0.00, -5), (0.35, 0), (0.75, -6), (1.00, -22)],
                       "fore": [(0.00, -4), (0.35, 0), (0.75, -5), (1.00, -20)]},
        "toe_swing": {"hind": [(0.24, -2), (0.55, 4), (0.86, 0)],
                      "fore": [(0.24, -2), (0.55, 4), (0.86, 0)]},
        "x_stance": {"hind": [(0.00, 0.0), (1.00, 0.0)],
                     "fore": [(0.00, -0.03), (1.00, -0.03)]},
        "x_swing": {"hind": [(0.50, 0.04), (0.90, 0.01)],
                    "fore": [(0.50, 0.0), (0.90, -0.01)]},
        "root_lift": [
        (0.00, -0.11, None), (0.16, -0.18, None), (0.34, -0.1, None),
        (0.46, -0.05, None), (0.50, -0.11, None), (0.66, -0.18, None),
        (0.84, -0.1, None), (0.96, -0.05, None)
    ],
        "root_surge": [(0.00, 0.0, None), (0.25, 0.012, None),
                       (0.50, 0.0, None), (0.75, 0.012, None)],
        "root_pitch": [(0.00, 0.6, None), (0.25, -1.4, None),
                       (0.50, 0.6, None), (0.75, -1.4, None)],
        "roll": [(0.00, 1.1, None), (0.25, 0.0, None),
                 (0.50, -1.1, None), (0.75, 0.0, None)],
        "flex": [(0.00, 0.7, None), (0.25, -0.7, None),
                 (0.50, 0.7, None), (0.75, -0.7, None)],
        "head_pump": [(0.00, 0.6, None), (0.28, -0.8, None),
                      (0.50, 0.6, None), (0.78, -0.8, None)],
        "body": _body(pelvis=2.6, spine=4.0, chest=-4.5, neck1=-5.0, neck2=-3.0,
                      head=5.5, neck_flex=3.2, pump1=2.0, pump2=1.2, pump3=1.5,
                      jaw=-3.0, jaw_move=0.5, ear=9.0, ear_move=0.8, ear_out=4.0,
                      tail1=-10.0, tail2=-6.0, scapula=8.0, look=2.2),
    },

    # ── run: half-bound rotary gallop ────────────────────────────────────────
    # The hind pair lands close together and drives, a short extended flight
    # follows, the fores catch in sequence, and the long gathered flight is
    # where the hind legs swing back through under the belly. Footfall order
    # LH-RH-RF-LF is the rotary part; the tight hind pairing is what separates a
    # bear from a dog. The fores get the shorter contact because the gathered
    # flight lifts the front of the animal: at duty 0.32 the lead foreleg was
    # still pinned to the ground while its own shoulder climbed 28 cm away from
    # it, and the leg ran out of reach.
    "run": {
        "frames": 48, "stride_frames": 16, "loop": True,
        "description": ("Half-bound rotary gallop, three 16-frame strides: hind "
                        "pair drives together, short extended flight, fores "
                        "catch in sequence, long gathered flight."),
        "contact": {("hind", "L"): 0.00, ("hind", "R"): 0.08,
                    ("fore", "R"): 0.46, ("fore", "L"): 0.54},
        "duty": {"hind": 0.27, "fore": 0.23},
        "sweep": 4.845,
        "plant": {"hind": -0.375, "fore": 1.44},
        "y_swing": {"hind": [(0.18, -1.131), (0.41, -0.809), (0.65, -0.255), (0.85, 0.120)],
                    "fore": [(0.18, -1.103), (0.38, -0.781), (0.62, -0.299), (0.85, 0.040)]},
        # Both pairs are held UP late into their swing rather than easing down
        # early, and that is what makes the gathered flight read as flight.
        "z_swing": {"hind": [(0.15, 0.28), (0.35, 0.50), (0.58, 0.52), (0.80, 0.44), (0.93, 0.19)],
                    "fore": [(0.12, 0.30), (0.32, 0.42), (0.56, 0.38), (0.78, 0.20), (0.91, 0.08)]},
        "foot_stance": {"hind": [(0.00, -20), (0.31, 4), (0.56, 8), (0.81, -4), (1.00, -44)],
                        "fore": [(0.00, -18), (0.38, 6), (0.63, 12), (0.88, -6), (1.00, -40)]},
        "foot_swing": {"hind": [(0.21, -26), (0.44, 8), (0.71, 16), (0.88, 0)],
                       "fore": [(0.21, -24), (0.44, 10), (0.71, 14), (0.88, -2)]},
        "toe_stance": {"hind": [(0.00, -6), (0.44, 0), (0.75, -8), (1.00, -26)],
                       "fore": [(0.00, -5), (0.44, 0), (0.75, -7), (1.00, -24)]},
        "toe_swing": {"hind": [(0.21, 0), (0.49, 6), (0.79, 0)],
                      "fore": [(0.24, 0), (0.50, 5), (0.79, 0)]},
        "x_stance": {"hind": [(0.00, 0.0), (1.00, 0.0)],
                     "fore": [(0.00, -0.05), (0.50, -0.06), (1.00, -0.05)]},
        "x_swing": {"hind": [(0.34, 0.07), (0.71, 0.05), (0.93, 0.01)],
                    "fore": [(0.34, 0.0), (0.78, -0.03)]},
        "root_lift": [
        (0.00, -0.05, None), (0.08, -0.12, None), (0.16, -0.18, None),
        (0.27, -0.12, None), (0.35, -0.09, None), (0.41, 0.0, None),
        (0.46, -0.05, None), (0.54, -0.13, None), (0.62, -0.18, None),
        (0.72, -0.15, None), (0.77, -0.11, None), (0.89, 0.03, None)
    ],
        "root_surge": [(0.00, 0.0, None), (0.18, -0.025, None), (0.36, 0.02, None),
                       (0.46, 0.03, None), (0.62, -0.02, None), (0.84, 0.025, None)],
        "root_pitch": [(0.00, 0.5, None), (0.16, -1.2, None), (0.33, 3.0, None),
                       (0.44, 1.2, None), (0.60, -3.0, None), (0.76, -0.6, None),
                       (0.90, 1.8, None)],
        "roll": None,
        "flex": [(0.00, 0.55, None), (0.12, 0.0, None), (0.25, -0.6, None),
                 (0.38, -1.0, None), (0.50, -0.85, None), (0.66, -0.10, None),
                 (0.80, 0.6, None), (0.92, 1.0, None)],
        "head_pump": [(0.00, 0.3, None), (0.18, 0.6, None), (0.36, 1.0, None),
                      (0.48, 0.5, None), (0.62, -1.0, None), (0.80, -0.3, None),
                      (0.91, 0.5, None)],
        "body": _body(),
    },
}

# Worst hip-to-ankle extension asked of each leg while it carries weight, per
# gait; filled in by build_gaits and checked by validate.
GAIT_REPORT = {}


def build_gaits(rig):
    """Replace Walk, Trot and run with solved clips. Returns them by name.

    Every frame is keyed, not every fourth. The paw track is solved in world
    space but Blender interpolates the JOINT ANGLES between keys, and an angle
    midway between two solved poses does not put the paw midway between two
    solved positions: at one key in four the planted paw sank 55 mm through the
    ground halfway to the next key. It is free downstream too --
    `export_bake_animation` resamples per frame into the GLB regardless.
    """
    GAIT_REPORT.clear()
    built = {}
    for name, gait in GAITS.items():
        old = bpy.data.actions.get(name)
        if old is not None:
            if rig.animation_data and rig.animation_data.action is old:
                rig.animation_data.action = None
            old.use_fake_user = False
            bpy.data.actions.remove(old)

        action = new_action(rig, name, gait["frames"], gait["loop"], gait["description"])
        poser = GaitPoser(rig, gait)
        stride = gait["stride_frames"]
        worst = {}
        for frame in range(0, gait["frames"] + 1):
            bpy.context.scene.frame_set(frame)
            ratios = poser.frame((frame % stride) / stride,
                                 (frame % gait["frames"]) / gait["frames"])
            for bone in rig.pose.bones:
                bone.keyframe_insert("rotation_euler", frame=frame, group=bone.name)
            rig.pose.bones["root"].keyframe_insert("location", frame=frame, group="root")
            phase = (frame % stride) / stride
            for (kind, side), contact in gait["contact"].items():
                leg = f"{kind}.{side}"
                if (phase - contact) % 1.0 < gait["duty"][kind] - 1e-9:
                    worst[leg] = max(worst.get(leg, 0.0), ratios[leg])
        set_action_handles(action, loop=gait["loop"])
        GAIT_REPORT[name] = worst
        built[name] = action
    return built


def build_other_actions(rig):
    """Author the bear's special poses and three locomotion clips."""
    actions = {}

    # ── variable-duration graze: enter -> repeat feeding -> authored exit ──
    # Do not fold these phases back into one long action. The wildlife brain
    # holds graze for a variable number of seconds; a monolithic clip would
    # raise the head every time it repeated. Three.js can play graze_in once,
    # repeat graze for as long as the state lasts, then play graze_out once.
    graze_bones = (
        "chest", "neck_01", "neck_02", "head", "jaw", "ear.L", "ear.R",
        "fore_upper.L", "fore_lower.L", "fore_foot.L",
        "fore_upper.R", "fore_lower.R", "fore_foot.R",
    )

    def graze_pose(amount, head_pitch=25, head_yaw=0, jaw=0, ear_tilt=2):
        return {
            "chest": (-4 * amount, 0, 0),
            "neck_01": (-52 * amount, 0, 0),
            "neck_02": (-42 * amount, 0, 0),
            "head": (head_pitch * amount, 0, head_yaw * amount),
            "jaw": (jaw * amount, 0, 0),
            "ear.L": (ear_tilt * amount, 0, -2 * amount),
            "ear.R": (ear_tilt * amount, 0, 2 * amount),
            "fore_upper.L": (-2 * amount, 0, 0),
            "fore_lower.L": (3 * amount, 0, 0),
            "fore_foot.L": (-1 * amount, 0, 0),
            "fore_upper.R": (-2 * amount, 0, 0),
            "fore_lower.R": (3 * amount, 0, 0),
            "fore_foot.R": (-1 * amount, 0, 0),
        }

    rest_graze = {name: (0, 0, 0) for name in graze_bones}
    down_graze = graze_pose(1.0)
    down_root = {"root": (0, -0.045, 0)}

    graze_in = new_action(
        rig, "graze_in", 36, False,
        "Enter variable-duration grazing: idle to the exact graze-loop base pose.",
    )
    graze_in["behavior"] = "graze"
    graze_in["phase"] = "enter"
    graze_in["next_action"] = "graze"
    key_pose(rig, 0, rest_graze, {"root": (0, 0, 0)})
    key_pose(rig, 8, graze_pose(0.12, 22), {"root": (0, -0.005, 0)})
    key_pose(rig, 18, graze_pose(0.50, 23), {"root": (0, -0.022, 0)})
    key_pose(rig, 28, graze_pose(0.86, 24), {"root": (0, -0.039, 0)})
    key_pose(rig, 36, down_graze, down_root)
    set_action_handles(graze_in)
    actions[graze_in.name] = graze_in

    graze = new_action(
        rig, "graze", 72, True,
        "Seamless head-down feeding loop for an arbitrarily long graze hold.",
    )
    graze["behavior"] = "graze"
    graze["phase"] = "hold"
    graze["next_action"] = "graze_out"
    key_pose(rig, 0, down_graze, down_root)
    key_pose(rig, 12, graze_pose(1.0, 22, -3.5, 4), {"root": (0, -0.044, 0)})
    key_pose(rig, 24, graze_pose(0.97, 27, 2.5, 0), {"root": (0, -0.042, 0)})
    key_pose(rig, 36, graze_pose(1.0, 23, -1.5, 5), {"root": (0, -0.046, 0)})
    key_pose(rig, 48, graze_pose(0.98, 26, 3.0, 1), {"root": (0, -0.043, 0)})
    key_pose(rig, 60, graze_pose(1.0, 24, -2.0, 4), {"root": (0, -0.045, 0)})
    key_pose(rig, 72, down_graze, down_root)
    set_action_handles(graze, loop=True)
    actions[graze.name] = graze

    graze_out = new_action(
        rig, "graze_out", 36, False,
        "Exit variable-duration grazing: graze-loop base pose back to exact idle.",
    )
    graze_out["behavior"] = "graze"
    graze_out["phase"] = "exit"
    graze_out["next_action"] = "idle"
    key_pose(rig, 0, down_graze, down_root)
    key_pose(rig, 8, graze_pose(0.92, 24), {"root": (0, -0.041, 0)})
    key_pose(rig, 18, graze_pose(0.58, 22), {"root": (0, -0.026, 0)})
    key_pose(rig, 28, graze_pose(0.16, 20), {"root": (0, -0.007, 0)})
    key_pose(rig, 36, rest_graze, {"root": (0, 0, 0)})
    set_action_handles(graze_out)
    actions[graze_out.name] = graze_out

    # ── alert: neutral -> high carriage/ears back -> scan -> neutral ────────
    alert = new_action(
        rig, "alert", 144, False,
        "Idle-to-alert sequence: raised carriage, ears back, two directional looks, idle return.",
    )
    alert_bones = ("pelvis", "chest", "neck_01", "neck_02", "head", "ear.L", "ear.R")

    def alert_pose(amount, look=0, ear_bias=0):
        return {
            "pelvis": (0, 0, 1.5 * amount),
            "chest": (3 * amount, 0, -1.5 * amount),
            "neck_01": (18 * amount, 0, 4 * look * amount),
            "neck_02": (14 * amount, 0, 6 * look * amount),
            "head": (-8 * amount, 0, 8 * look * amount),
            "ear.L": ((14 + ear_bias) * amount, 0, 5 * amount),
            "ear.R": ((14 - ear_bias) * amount, 0, -5 * amount),
        }

    rest_alert = {name: (0, 0, 0) for name in alert_bones}
    for frame in (0, 12):
        key_pose(rig, frame, rest_alert, {"root": (0, 0, 0)})
    key_pose(rig, 24, alert_pose(0.50), {"root": (0, 0.007, 0)})
    key_pose(rig, 36, alert_pose(1.0), {"root": (0, 0.014, 0)})
    key_pose(rig, 48, alert_pose(1.0, 1.0, 2), {"root": (0, 0.014, 0)})
    key_pose(rig, 60, alert_pose(1.0, 0.25, -2), {"root": (0, 0.014, 0)})
    key_pose(rig, 72, alert_pose(1.0, -1.0, 1), {"root": (0, 0.014, 0)})
    key_pose(rig, 84, alert_pose(1.0, -0.75, -1), {"root": (0, 0.014, 0)})
    key_pose(rig, 96, alert_pose(1.0, 0.65, 2), {"root": (0, 0.014, 0)})
    key_pose(rig, 108, alert_pose(0.68, 0), {"root": (0, 0.010, 0)})
    key_pose(rig, 120, alert_pose(0.10, 0), {"root": (0, 0.002, 0)})
    for frame in (132, 144):
        key_pose(rig, frame, rest_alert, {"root": (0, 0, 0)})
    set_action_handles(alert)
    actions[alert.name] = alert

    # ── Walk, Trot and run: solved against the ground; see the section above
    actions.update(build_gaits(rig))

    rig["current_actions"] = "idle, graze_in, graze, graze_out, alert, Walk, Trot, run"
    rig["variable_duration_actions"] = "graze: graze_in -> graze (loop) -> graze_out"
    rig["planned_actions"] = "trout"
    bpy.context.scene.frame_set(0)
    return actions


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
        "Actions: idle 0-48, graze_in 0-36, graze 0-72, graze_out 0-36, "
        "alert 0-144, Walk 0-48, "
        "Trot 0-16, run 0-48.\n"
        "Locomotion clips are seamless in-place loops. Graze is a variable-"
        "duration three-phase behavior: play graze_in once, repeat graze, "
        "then play graze_out once. Its joins are exact; graze_in starts and "
        "graze_out ends at idle. Alert begins and ends at idle. Planned "
        "action: trout.\n\n"
        "Preserve action-name capitalization to match the fox asset contract. "
        "Keep locomotion in place; derive travel "
        "from planted paw displacement after export. The root is a non-deforming "
        "ground control. Pelvis/spine/chest carry body motion. Two neck joints "
        "support graze/alert, jaw supports the future trout pose, separate ears "
        "support listening, and every leg retains upper/lower/foot/toe controls.\n"
    )


def validate(body, rig, actions):
    expected = {
        "root", "pelvis", "spine_01", "chest", "neck_01", "neck_02", "head", "jaw",
        "ear.L", "ear.R", "scapula.L", "scapula.R",
        "fore_upper.L", "fore_lower.L", "fore_foot.L", "fore_toe.L",
        "fore_upper.R", "fore_lower.R", "fore_foot.R", "fore_toe.R",
        "hind_upper.L", "hind_lower.L", "hind_foot.L", "hind_toe.L",
        "hind_upper.R", "hind_lower.R", "hind_foot.R", "hind_toe.R",
        "fore_tip.L", "fore_tip.R", "hind_tip.L", "hind_tip.R",
        "tail_01", "tail_02",
    }
    actual = {bone.name for bone in rig.data.bones}
    assert actual == expected, (expected - actual, actual - expected)
    assert rig.data.bones["root"].use_deform is False
    assert body.find_armature() == rig
    expected_actions = {
        "idle": ((0, 48), True), "graze_in": ((0, 36), False),
        "graze": ((0, 72), True), "graze_out": ((0, 36), False),
        "alert": ((0, 144), False), "Walk": ((0, 48), True),
        "Trot": ((0, 16), True), "run": ((0, 48), True),
    }
    assert set(actions) == set(expected_actions), (set(actions), set(expected_actions))
    for name, (frame_range, loop) in expected_actions.items():
        assert tuple(round(v) for v in actions[name].frame_range) == frame_range, \
            (name, tuple(actions[name].frame_range), frame_range)
        assert bool(actions[name]["loop"]) is loop, (name, actions[name]["loop"], loop)
    assert [actions[name]["phase"] for name in ("graze_in", "graze", "graze_out")] == \
        ["enter", "hold", "exit"]

    # The gallop is solved rather than keyed, so its two physical promises are
    # checked here rather than taken on trust: no leg is asked for more reach
    # than it has while it is carrying weight, and every planted toe tip is on
    # the ground. Either one failing is a foot that slides, and a foot that
    # slides is exactly what the clip this replaced did for its whole length.
    assert set(GAIT_REPORT) == set(GAITS), (set(GAIT_REPORT), set(GAITS))
    strained = {f"{clip}/{leg}": round(r, 4)
                for clip, legs in GAIT_REPORT.items() for leg, r in legs.items() if r > 0.985}
    assert not strained, f"legs clamped under load: {strained}"

    depsgraph = bpy.context.evaluated_depsgraph_get()
    adrift, disagree = [], []
    for name, gait in GAITS.items():
        rig.animation_data.action = actions[name]
        if rig.animation_data.action_slot is None and len(actions[name].slots):
            rig.animation_data.action_slot = actions[name].slots[0]
        stride = gait["stride_frames"]
        speeds = []
        for (kind, side), contact in gait["contact"].items():
            window = sorted(((f / stride - contact) % 1.0, f) for f in range(stride))
            window = [(p, f) for p, f in window if p < gait["duty"][kind] - 1e-9]
            track_y = []
            for _, frame in window:
                bpy.context.scene.frame_set(frame)
                depsgraph.update()
                posed = rig.evaluated_get(depsgraph)
                tip = posed.matrix_world @ posed.pose.bones[f"{kind}_tip.{side}"].head
                if abs(tip.z - GROUND) > 1e-3:
                    adrift.append((name, frame, f"{kind}.{side}", round(tip.z, 4)))
                track_y.append(tip.y)
            span = window[-1][0] - window[0][0]
            speeds.append(-(track_y[-1] - track_y[0]) / span)
        if max(speeds) - min(speeds) > 1e-3:
            disagree.append((name, [round(v, 4) for v in speeds]))
    assert not adrift, f"planted paws off the ground: {adrift[:8]}"
    # Four paws on one piece of ground must agree about how fast it is moving.
    # They did not before: the old Walk's front paws travelled forward while its
    # hind paws travelled back, which is a clip that cannot be measured at all.
    assert not disagree, f"paws disagree on ground speed: {disagree}"
    assert min((body.matrix_world @ v.co).z for v in body.data.vertices) > -0.08
    assert max((body.matrix_world @ v.co).z for v in body.data.vertices) > 1.85
    unweighted = [
        vertex.index for vertex in body.data.vertices
        if not any(group.weight > 0 for group in vertex.groups)
    ]
    assert not unweighted, f"Unweighted body vertices: {len(unweighted)}"
    weights = [
        {body.vertex_groups[item.group].name: item.weight
         for item in vertex.groups if item.weight > 1e-6}
        for vertex in body.data.vertices
    ]

    # The sole still reads as one rigid plantigrade unit, but as a dominant
    # weight rather than an exclusive one.  Demanding a single group here is
    # what forced the z=0.30 cliff that sheared the ankle open in motion.
    slack_paw = []
    for vertex in body.data.vertices:
        if vertex.co.z >= 0.16:
            continue
        side = "L" if vertex.co.x < 0 else "R"
        limb = "fore" if vertex.co.y > -0.10 else "hind"
        expected = f"{limb}_foot.{side}"
        held = weights[vertex.index].get(expected, 0.0)
        # 0.85, not 1.0: the remaining fraction follows the lower leg, which
        # during a plant is static anyway and during a swing reads as flesh
        # trailing the toe.  Demanding the whole sole is what forced the cliff.
        if held < 0.85:
            slack_paw.append((vertex.index, expected, round(held, 3)))
    assert not slack_paw, f"Slack paw vertices: {slack_paw[:8]}"

    # The regression this asset has already paid for once.  Neighbouring
    # vertices must never be driven by disjoint sets of bones: such a step is
    # invisible at rest and buckles the surface the moment a bone turns.
    worst_seam = (0.0, -1, -1)
    for edge in body.data.edges:
        i, j = edge.vertices
        shared = sum(min(weights[i].get(name, 0.0), weights[j].get(name, 0.0))
                     for name in set(weights[i]) | set(weights[j]))
        if 1.0 - shared > worst_seam[0]:
            worst_seam = (round(1.0 - shared, 3), i, j)
    # 0.50 is generous on purpose.  What buckled the surface was a seam of
    # 1.00 — neighbours with nothing in common, one following a swinging limb
    # and one held by the chest.  What survives is around 0.44, between bones
    # that move together at the shoulder, and shows up as nothing.
    assert worst_seam[0] < 0.50, f"Step in the weight field across an edge: {worst_seam}"
    print(
        "BEAR_VALID",
        f"verts={len(body.data.vertices)}",
        f"faces={len(body.data.polygons)}",
        f"bones={len(rig.data.bones)}",
        f"worst_weight_seam={worst_seam[0]}",
        f"actions={[(name, tuple(action.frame_range)) for name, action in actions.items()]}",
    )


def main():
    clear_scene()
    materials = (
        material("Bear black-brown coat", (0.018, 0.020, 0.025), 0.86),
        material("Bear warm muzzle", (0.048, 0.036, 0.030), 0.84),
        material("Bear charcoal", (0.008, 0.006, 0.004), 0.86),
        material("Bear claws", (0.080, 0.060, 0.045), 0.74),
        # Darker than the coat, an eye on a black bear is invisible.  The
        # reference reads as a warm brown lens that is a shade lighter than
        # the fur around it and glossy enough to hold a catchlight.
        material("Bear eye", (0.020, 0.011, 0.005), 0.15),
    )
    body = build_body(materials)
    rig = build_rig(body)
    details = build_details(rig, materials)
    idle = build_idle(rig)
    actions = {"idle": idle}
    actions.update(build_other_actions(rig))
    build_presentation(materials)
    add_readme()
    validate(body, rig, actions)

    bpy.ops.object.select_all(action="DESELECT")
    rig.select_set(True)
    body.select_set(True)
    for detail in details:
        detail.select_set(True)
    bpy.context.view_layer.objects.active = rig
    rig.animation_data.action = idle
    reset_pose(rig)
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
