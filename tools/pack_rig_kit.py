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

The game authors **+Y forward, +Z up, feet on Z = 0**. The pack faces -Y.
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


# ─────────────────────────────────────────────────────────────────────────────
#  Solved gaits
# ─────────────────────────────────────────────────────────────────────────────
#
# Author the CONTACT POINT, not the joint angles. A paw is either on the ground
# or it is not, and that is a property to construct rather than to check for
# afterwards: each foot follows a path in armature space — a straight sweep back
# at standing height while planted, a lifted arc forward while swinging — and
# the leg is solved to reach it.
#
# The pack's own locomotion cannot be relied on for this. Measured duty per foot:
# the raccoon's walk is 0.47-0.53 and genuinely planted, but the deer's is
# 0.25/0.30/0.23/0.10 with the fore travelling 0.52 where the hind travels 0.63.
# Clip quality varies per animal, so measure before trusting, and solve where it
# does not hold.

LATERAL_WALK = {("hind", "L"): 0.00, ("fore", "L"): 0.25,
                ("hind", "R"): 0.50, ("fore", "R"): 0.75}
DIAGONAL_TROT = {("hind", "L"): 0.00, ("fore", "R"): 0.00,
                 ("hind", "R"): 0.50, ("fore", "L"): 0.50}
# A bound: both hinds drive together, the body sails, both fores catch. What a
# frightened white-tail does, and not a gallop — a gallop's four beats are
# spread, a bound's are two pairs.
BOUND = {("hind", "L"): 0.00, ("hind", "R"): 0.03,
         ("fore", "L"): 0.42, ("fore", "R"): 0.45}

SAFETY = 0.955          # of reach_limit; a leg at 1.0 is a locked leg
PROBE = 64              # reach is a property of the geometry, not of the keying


def gait_rest(rig, legs):
    """Rest geometry for every leg in `legs`.

    `legs` maps a (pair, side) key to a dict of bone names:
        scap    the scapula, swung in phase to carry the hip
        a, b    the two IK links
        target  the bone the IK places (NOT always the same depth per pair —
                the raccoon's fore leg has no `foot` bone at all)
        below   bones under the target, re-aimed so the paw stays flat
        contact the bone whose head actually touches the ground
    """
    clear(rig)
    out = {}
    for k, L in legs.items():
        a = rig.pose.bones[L["a"]].head.copy()
        b = rig.pose.bones[L["b"]].head.copy()
        t = rig.pose.bones[L["target"]].head.copy()
        u = (t - a).normalized()
        perp = (b - a) - u * (b - a).dot(u)
        out[k] = dict(
            target=t, l1=(b - a).length, l2=(t - b).length,
            reach=reach_limit((b - a).length, (t - b).length) * SAFETY,
            bend=(perp.normalized() if perp.length > 1e-5 else Vector((0, -1, 0))),
            scap_dir=(rig.pose.bones[L["scap"]].tail
                      - rig.pose.bones[L["scap"]].head).normalized(),
            below_dirs=[(rig.pose.bones[n].tail - rig.pose.bones[n].head).normalized()
                        for n in L["below"]],
            contact=rig.pose.bones[L["contact"]].head.copy(),
        )
    return out


def gait_pose(rig, legs, rest, spec, t, sweep):
    """One instant of a gait. Returns the worst load on a WEIGHTED leg."""
    clear(rig)
    root = rig.pose.bones["Root"]
    dz = -spec["crouch"] + math.sin(t * math.tau * 2.0) * spec["bob"]
    root.location = local_translation(root, (0.0, 0.0, dz))

    worst = 0.0
    for k, L in legs.items():
        R = rest[k]
        half = sweep * 0.5
        p = (t + spec["phase"][k]) % 1.0
        if p < spec["duty"]:
            u = p / spec["duty"]
            goal = Vector((R["target"].x, R["target"].y - half + sweep * u,
                           R["target"].z))
            planted = True
        else:
            v = (p - spec["duty"]) / (1.0 - spec["duty"])
            goal = Vector((R["target"].x, R["target"].y + half - sweep * v,
                           R["target"].z + spec["lift"] * math.sin(math.pi * v)))
            planted = False

        # The scapula swings in phase with its own paw, carrying the hip toward
        # it. This is where most of a quadruped's stride comes from; without it
        # the two links below are asked for reach they do not have. The SIGN was
        # settled by measurement, not reasoning — inverting it cut the solved
        # sweep by two thirds.
        lead = (R["target"].y - goal.y) / max(sweep, 1e-6)
        point(rig.pose.bones[L["scap"]], rx(-spec["scapula"] * lead) @ R["scap_dir"])

        a = rig.pose.bones[L["a"]]
        if planted:
            worst = max(worst, (goal - a.head).length / R["reach"])
        knee = ik2(a.head.copy(), goal, R["l1"], R["l2"], R["bend"])
        point(a, knee - a.head)
        point(rig.pose.bones[L["b"]], goal - rig.pose.bones[L["b"]].head)
        for n, d in zip(L["below"], R["below_dirs"]):
            point(rig.pose.bones[n], d)
    return worst, (goal if False else None)


def solve_sweep(rig, legs, rest, spec):
    """Largest sweep no weighted leg has to clamp for, anywhere in the cycle.

    Probed at a fixed resolution, NOT at the keyframes. Sampling the reach check
    at the frame count made the answer depend on it — one rig reported 0.593 at
    8 frames and 0.524 at 10 — because a coarse cycle never lands on the worst
    instant.
    """
    lo, hi = 0.02, 2.0
    for _ in range(28):
        mid = (lo + hi) * 0.5
        if max(gait_pose(rig, legs, rest, spec, i / PROBE, mid)[0]
               for i in range(PROBE)) <= 1.0:
            lo = mid
        else:
            hi = mid
    return lo


def build_gait(rig, legs, rest, name, spec, unit_m=1.0):
    """Solve one gait, key it every frame, validate it, and report its speed.

    The speed is a FINDING and not a setting: the sweep is whatever the legs can
    carry. A stride the legs cannot carry is a fact about the animal's
    proportions, not something for this to paper over.
    """
    sweep = solve_sweep(rig, legs, rest, spec)
    frames = spec["frames"]
    bones = ["Root"] + [n for L in legs.values()
                        for n in ([L["scap"], L["a"], L["b"]] + L["below"])]
    act = new_action(rig, name, frames)
    for i in range(frames + 1):
        gait_pose(rig, legs, rest, spec, (i % frames) / frames, sweep)
        key(rig, bones, 1 + i, loc={"Root"})
    rig.animation_data.action = None
    clear(rig)

    cycle = frames / 24.0
    # Speed is sweep over the STANCE, not over the cycle. A planted foot covers
    # `sweep` relative to the body while it is down, which takes `duty * cycle`
    # — so the animal travels sweep / (duty * cycle). Dividing by the cycle
    # instead underreports by exactly the duty factor, which is the same error
    # `measureExcursion` makes and the reason `measure: 'contact'` exists. It
    # matters most where duty is lowest: a bound is down a fifth of the time, so
    # the cycle-based number is five times too slow.
    speed = sweep * unit_m / (spec["duty"] * cycle)

    # Validate the KEYED result against the path it was solved for. This is the
    # phase-independent question — while planted, is the paw where the gait says
    # it should be? Comparing travel BETWEEN keyframes measures the sampling
    # instead: at an odd frame count the diagonal pairs get sampled at different
    # points of their stance and report different distances while both track
    # perfectly.
    worst, where, drift = 0.0, None, 0.0
    for i in range(frames + 1):
        sample(rig, act, 1 + i)
        t = (i % frames) / frames
        for k, L in legs.items():
            R = rest[k]
            half = sweep * 0.5
            p = (t + spec["phase"][k]) % 1.0
            if p >= spec["duty"]:
                continue
            u = p / spec["duty"]
            goal = Vector((R["target"].x, R["target"].y - half + sweep * u,
                           R["target"].z))
            got = rig.pose.bones[L["target"]].head
            if (got - goal).length > worst:
                worst, where = (got - goal).length, f"f{i} {k}"
            drift = max(drift, abs(got.z - R["target"].z))
    s = seam(rig, act, frames)
    rig.animation_data.action = None
    clear(rig)

    print(f"[{name}] sweep {sweep:.3f} ({sweep*unit_m:.3f} m) over {cycle:.3f}s "
          f"= {1/cycle:.2f} Hz, duty {spec['duty']:.2f} -> {speed:.3f} m/s")
    print(f"[{name}]   planted paw off its path {worst*1000:7.3f} mm ({where})")
    print(f"[{name}]   planted paw height drift {drift*1000:7.3f} mm")
    print(f"[{name}]   cycle seam               {s*1000:7.3f} mm")
    assert worst < 0.001, f"{name}: a planted paw left its path by {worst*1000:.2f} mm"
    assert drift < 0.001, f"{name}: a planted paw left the ground by {drift*1000:.2f} mm"
    assert s < 1e-4, f"{name}: the cycle does not close: {s*1000:.3f} mm"
    return speed


# ─────────────────────────────────────────────────────────────────────────────
#  The phased graze
# ─────────────────────────────────────────────────────────────────────────────
#
# `GlbRig` sequences `graze_in -> graze -> graze_out` when a species declares
# BOTH `grazeIn` and `grazeOut`. The split is not decoration: the Brain holds a
# graze for a variable 10-26 s, so one long looping clip would raise the head
# every time it repeated. The three must meet pose-exactly, and `graze_out` must
# END on the rest pose, because the sequencer parks on its clamped final frame
# as the carrier for the idle phase.
#
# Reaching the ground is usually a whole-forehand problem rather than a neck
# one. Solve it as: pitch the chest (which lowers the shoulders), CCD the neck
# at the target, then put the forefeet back with two-bone IK so the chest pitch
# costs no contact. The chest pitch is bisected for the SMALLEST value that
# brings the target inside the neck's reach.
#
# Do NOT spread one angle across the neck and bisect that. A chain sharing an
# angle curls into a hook, so past ~90 degrees of total bend the tip returns
# toward the base and muzzle height stops being monotonic in the angle.


def _sagittal(v_from, v_to):
    """Signed angle about world +X between two vectors, in the YZ plane.

    Confining the solve to one plane is what stops the neck reaching its target
    by swinging the head sideways, which is anatomically wrong and reads
    instantly as broken.
    """
    a, b = Vector((0, v_from.y, v_from.z)), Vector((0, v_to.y, v_to.z))
    if a.length < 1e-9 or b.length < 1e-9:
        return 0.0
    a.normalize(); b.normalize()
    return math.degrees(math.atan2(a.y * b.z - a.z * b.y, a.y * b.y + a.z * b.z))


def _neck_reach(rig, neck, tip, target, passes=10, step=22.0):
    """CCD the neck so `tip`'s tail arrives at `target`, base to tip.

    `step` clamps one pass so the chain converges into a curve rather than
    snapping the first bone straight at the target — the clamp is what makes the
    result look like a neck instead of an elbow.
    """
    for _ in range(passes):
        for name in neck:
            pb = rig.pose.bones[name]
            h = pb.head.copy()
            ang = max(-step, min(step, _sagittal(rig.pose.bones[tip].tail - h,
                                                 target - h)))
            if abs(ang) > 1e-4:
                point(pb, rx(ang) @ (pb.tail - pb.head).normalized())


def graze_pose(rig, legs, rest, cfg, chest_deg, target):
    """Pose the animal for one instant of a graze. Returns the muzzle tip."""
    clear(rig)
    for name, share in cfg["chest"]:
        pb = rig.pose.bones[name]
        point(pb, rx(chest_deg * share) @ (pb.tail - pb.head).normalized())
    _neck_reach(rig, cfg["neck"], cfg["tip"], target)

    # The chest has carried the shoulders down and forward; put the FORE feet
    # back. The hind legs hang off a lower spine bone and are never touched.
    for k, L in legs.items():
        if k[0] != "fore":
            continue
        R = rest[k]
        a = rig.pose.bones[L["a"]]
        goal = R["target"]
        knee = ik2(a.head.copy(), goal, R["l1"], R["l2"], R["bend"])
        point(a, knee - a.head)
        point(rig.pose.bones[L["b"]], goal - rig.pose.bones[L["b"]].head)
        for n, d in zip(L["below"], R["below_dirs"]):
            point(rig.pose.bones[n], d)
    return rig.pose.bones[cfg["tip"]].tail.copy()


def solve_chest(rig, legs, rest, cfg, target, tol=0.010):
    """Smallest chest pitch that puts `target` inside the neck's reach.

    Monotonic where the shared-angle version was not: more pitch lowers the neck
    base and strictly shortens the distance left to cover.
    """
    hi = cfg["chest_max"]
    r = (graze_pose(rig, legs, rest, cfg, hi, target) - target).length
    if r > tol:
        raise SystemExit(f"[graze] the muzzle cannot reach {tuple(round(v,3) for v in target)} "
                         f"even at {hi} deg of chest pitch (short by {r:.3f}). "
                         f"Raise chest_max or lift the target.")
    lo = 0.0
    for _ in range(26):
        mid = (lo + hi) * 0.5
        if (graze_pose(rig, legs, rest, cfg, mid, target) - target).length <= tol:
            hi = mid
        else:
            lo = mid
    return hi


def build_phased_graze(rig, legs, rest, cfg):
    """Author graze_in / graze / graze_out, and assert the joins are exact."""
    clear(rig)
    up = rig.pose.bones[cfg["tip"]].tail.copy()
    target = Vector(cfg["target"])
    chest = solve_chest(rig, legs, rest, cfg, target)
    got = graze_pose(rig, legs, rest, cfg, chest, target)
    print(f"[graze] chest {chest:.1f} deg (max {cfg['chest_max']}); muzzle "
          f"y{got.y:+.3f} z{got.z:+.3f}, asked y{target.y:+.3f} z{target.z:+.3f}")

    bones = ([n for n, _ in cfg["chest"]] + list(cfg["neck"])
             + [n for k, L in legs.items() if k[0] == "fore"
                for n in ([L["a"], L["b"]] + L["below"])])
    IN, HOLD, OUT = cfg["in_frames"], cfg["hold_frames"], cfg["out_frames"]

    def pose(t, nudge=Vector((0, 0, 0))):
        return graze_pose(rig, legs, rest, cfg, chest * t,
                          up.lerp(target, t) + nudge)

    acts = {}
    acts["graze_in"] = new_action(rig, "graze_in", IN)
    for i in range(IN + 1):
        pose(ease(i / IN)); key(rig, bones, 1 + i)
    acts["graze"] = new_action(rig, "graze", HOLD)
    for i in range(HOLD + 1):
        p = (i % HOLD) / HOLD
        # Working the ground, and a glance up every few seconds. Driven as small
        # moves of the TARGET rather than extra rotation, so the neck curve stays
        # consistent and the forefeet keep their planted positions throughout.
        pose(1.0, Vector((0.0, math.sin(p * math.pi * 6.0) * cfg["crop"],
                          max(0.0, math.sin(p * math.pi * 2.0)) ** 3 * cfg["glance"])))
        key(rig, bones, 1 + i)
    acts["graze_out"] = new_action(rig, "graze_out", OUT)
    for i in range(OUT + 1):
        pose(ease(1.0 - i / OUT)); key(rig, bones, 1 + i)

    rig.animation_data.action = None
    clear(rig)
    p_rest = {pb.name: pb.matrix.copy() for pb in rig.pose.bones}

    def at(a, f):
        sample(rig, acts[a], f)
        return {pb.name: pb.matrix.copy() for pb in rig.pose.bones}

    def diff(a, b):
        return max((a[k].translation - b[k].translation).length for k in a)

    checks = {
        "in starts at rest": diff(at("graze_in", 1), p_rest),
        "in ends where graze starts": diff(at("graze_in", 1 + IN), at("graze", 1)),
        "graze loops": diff(at("graze", 1), at("graze", 1 + HOLD)),
        "out starts where graze ends": diff(at("graze_out", 1), at("graze", 1 + HOLD)),
        "out ends at rest": diff(at("graze_out", 1 + OUT), p_rest),
    }
    worst_foot, lowest = 0.0, 1e9
    for name, n in (("graze_in", IN), ("graze", HOLD), ("graze_out", OUT)):
        for f in range(1, 2 + n):
            sample(rig, acts[name], f)
            for k, L in legs.items():
                worst_foot = max(worst_foot,
                                 (rig.pose.bones[L["contact"]].head - rest[k]["contact"]).length)
            lowest = min(lowest, rig.pose.bones[cfg["tip"]].tail.z)
    rig.animation_data.action = None
    clear(rig)

    print("[graze] validation")
    for k, v in checks.items():
        print(f"   {k:32s} {v*1000:7.3f} mm")
    print(f"   {'foot movement, worst frame':32s} {worst_foot*1000:7.3f} mm")
    print(f"   muzzle reaches z {lowest:.3f} (rest {up.z:.3f})")
    for k, v in checks.items():
        assert v < 1e-4, f"{k}: {v*1000:.3f} mm apart, must be exact"
    assert worst_foot < 0.005, f"a foot slid {worst_foot*1000:.1f} mm"
    assert lowest > 0.0, f"the muzzle ploughs the ground (z={lowest:.3f})"
    # Tied to the declared target, not a constant: a hard-coded floor here once
    # failed the build the moment the target was deliberately raised.
    assert lowest <= target.z + 0.05, (
        f"the muzzle stopped at z={lowest:.3f}, short of its target {target.z:.3f}")
