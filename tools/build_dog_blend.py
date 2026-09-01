"""Build the game's dog .blend from the bought pack, and SAVE it.

    Blender -b assets/models/Animals_v3.0.blend --python tools/build_dog_blend.py
    Blender -b assets/models/Animals_v3.0.blend --python tools/build_dog_blend.py -- --shots DIR

Writes `assets/models/dog_pack.blend`: the pack's dog, isolated, turned to face
+Y, with the four clips it ships renamed to the game's slots and **three REST
poses the pack does not ship** — `sit`, `lie` and `curl` — authored onto its rig.

This is the first animal on this path whose missing clips are not gaits. The
camp dog's whole reason to exist is that it settles down by the fire, and
`src/camp/camp_dog.js` says what the three look like in the words of the brief:
"curl its body up and lay down. Occasionally the dog will lay down normally and
not curled up. Sometimes it will sit instead." Those poses are hand-authored
bone rotations in `camp_dog.js` today, blended over a procedural rig. Here they
become clips.

## What the pack ships for the dog, and what it does not

    Dog_Idle     290f -> idle
    Dog_Walk      31f -> walk
    Dog_Run       18f -> run
    Dog_Gesture  222f -> (left as `gesture`, see below)

    sit  lie  curl            NOT in the pack for the dog. Authored here.
    trot                      not authored here either; no animal in the pack
                              has one and the camp dog does not use the gait
                              ladder yet. It belongs to the import step.

`Dog_Gesture` is carried through under its own name rather than being assigned
to `graze` or `alert`. Deciding which slot it fills is the import step's job and
it needs the clip measured against the species file that does not exist yet;
naming it now would be guessing, and a wrong guess is invisible.

## The sit is the CAT's, retargeted — and that is the best thing in this build

`Cat_Sit` is the only sit in all 233 actions, and it is a real one: forelegs
vertical, both hocks flat along the ground, croup down between them, back
inclined, head level, and 51 frames of small breathing on top. Exactly the pose
`camp_dog.js` describes from `sitting-side.jpg`, authored by the person who made
the animal.

And the two rigs are the same rig. Bone for bone, joint for joint:

    Root - hip - (hind legs) - tail chain
               - +1 - +2 - (fore legs) - +3 - +4 - scull - ears, jaw

The NAMES are off by one, because the cat carries one extra tail vertebra:
the dog's hip is `spine.004` and the cat's is `spine.005`, and every spine bone
forward of the hip is shifted with it. Mapping them by name would put the cat's
neck on the dog's thorax. `BONE_MAP` below is built from the topology instead,
and asserted total in the direction that matters — every dog bone that moves in
a sit is driven by a cat bone.

Three bones have no partner, and the third is the interesting one:

* the dog's `front_toe`, which the cat's fore leg does not have at all (the cat
  ends at `front_foot`). The cat's paw drives the dog's PAW — `front_foot` maps
  to `front_toe` — and the dog's extra pastern keeps its standing angle. Mapping
  by name instead drives the dog's pastern with the cat's paw and leaves the paw
  itself dangling.
* the whole TAIL, dropped. The cat carries five tail vertebrae over 0.16 and the
  dog four over 0.30, so any correspondence is a guess — and the guess is
  expensive: mapped base-outward it flung the tail off the rump and stretched
  the 35 mm edge between them to 190 mm. `place_tail` authors it per pose
  instead, which is the better answer anyway. What a tail does in each of these
  three poses is a decision, not something to inherit from a cat.

## Rotations are not the clip. Translations are half of it.

The first cut transferred rotation only — which is all the two retargets already
in this repo need — and the dog came out sitting in mid-air with its hip at
standing height and its paws 300 mm off the floor.

Every clip in this pack animates **location on all 33 bones** as well, because
they are baked out of an FBX. Almost all of it is zero: measured against the cat
standing, only the hip genuinely moves, and it moves 0.194, which IS the sit.
The body does not come down by folding the legs under a fixed pelvis; it comes
down because the pelvis is dropped and the legs fold to meet the floor.

So the hip's translation transfers, scaled by the ratio of the two animals'
standing hip heights (1.79 here) — rotation is scale-free and translation is
not. The four other bones carrying any translation carry 1-2 cm of it and are
dropped: scaled onto a differently proportioned animal that is not motion, and
it opened a 13 mm gap at the hip joint and 14 mm at each shoulder, which a
659-vertex skin tears across.

## What does NOT transfer is contact, and that is the rest of the work

Rotations transfer; proportions do not, and this dog's differ from the cat's in
two ways that both had to be solved rather than inherited:

* **The pelvis.** Both animals drop the pelvis by the same fraction of standing
  hip height — 0.32 for the cat, 0.31 here, so the retarget gets that right —
  but the dog's pelvic bone is 0.149 long against the cat's 0.072 where the
  whole animal is only 1.79x. Wearing the cat's pelvic angle swings the dog's
  hip joint through the ground and buries the haunch 43 mm under it.
  `solve_pelvis` scans for the smallest correction that rests it on the floor:
  -36 degrees.
* **The paws.** Every clip here ends with a planting pass that solves the four
  contact points and asserts them, the same way the solved gaits do: a paw is
  either on the ground or it is not, and that is a thing to construct rather
  than to hope for. All four finish within 0.5 mm.

Lifting the whole animal is not a substitute for either, and trying is
instructive: a sitting dog's shoulder is already at its standing height (425 mm
against 432), so 50 mm of lift put the forelegs at 1.15 of their reach limit — a
clamped leg and a torn shoulder.

## `lie` and `curl` are authored, and share their lower half

Nothing in the pack lies down like a dog. `Cow_Lying` and `Pig_Lying` are the
only two lying clips and both are a barrel animal folding onto its brisket with
its legs vanishing underneath — the wrong silhouette and the wrong anatomy.

So both are built here, and both are built OUT OF THE SIT, because that is what
they anatomically are:

* a sphinx **lie** is a sit with the front end let down — the pelvis, the hocks
  and the folded hind legs are in the same place, the chest comes to the floor
  and the forelegs reach out in front of it;
* a **curl** is a lie with the spine swung into a horizontal C and the head
  brought all the way round to the front paws.

Building them from the retargeted sit rather than from angles means the half of
each pose that the pack's artist authored stays authored, and only the half
this game needs is invented. It also means the hind legs of all three clips
agree, which is what lets the game crossfade between them.

## How much of this is measured

Nothing in this file that could be measured is typed in. The floor is the lowest
vertex of the standing skin; how high each ankle rides above the pad it rests on
is measured with the limb in the attitude it will be in, including a hock laid
flat, which standing never does; which way each middle joint bends is read off
the animal (a dog's stifle points forward and its ELBOW points backward, and one
constant for all four legs inverts one pair — the hind legs came out reaching
forward under the belly like a duck's); the nose height in each pose is a
fraction of its own standing height; and the thorax pitch that lays the brisket
down is scanned against the skin rather than assumed (aiming at the shoulder
instead drove the chest 134 mm through the floor, because a rib cage is deep and
the shoulder joint is nowhere near the bottom of it).

The one assertion that catches all of it at once is the skin: `stretch_report`
measures every clip's worst edge stretch against the pack's OWN clips rather
than against a constant. This mesh is coarse enough that the artist's walk
already puts 3.06x on the web between the thighs, so a fixed threshold would
either pass everything or condemn the animation that shipped with the model.

## Every clip is a loopable HOLD, and holds are what the game needs

`camp_dog.js` rests for 26-75 s. Three clips, each a closed loop with the
animal's breathing on it and nothing else: no settle-down, no getting-up. The
transitions are a crossfade in the game today (`SETTLE_TIME` 1.05 s) and stay
one; authoring `sit_in`/`sit_out` pairs is a real improvement and a separate
piece of work, wired through `GlbRig`'s phase sequencer, which currently has
exactly one sequenced slot (the graze) and would need to grow three more.
"""

import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pack_rig_kit import (                                        # noqa: E402
    open_animal, face_forward, point, clear, purge, frame_view, rx, rz,
    key, new_action, sample, seam, set_linear, local_translation,
    max_edge_stretch, ik2, reach_limit, _neck_reach,
)

OUT = "assets/models/dog_pack.blend"

RIG = "Skeleton_Dog"
MESH = ["Dog_01", "Dog_02", "Dog_03", "Dog_04", "Dog_05", "Dog_06"]
HEAD = "scull"
ROOT = "Root"

CAT = "Skeleton_Cat"
CAT_SIT = "Cat_Sit"
CAT_HIP = "spine.005"      # the dog's hip is spine.004; see `bone_map`
CAT_STAND = "Cat_Idle"
DOG_STAND = "Dog_Idle"

RENAME = {"Dog_Idle": "idle", "Dog_Walk": "walk", "Dog_Run": "run",
          "Dog_Gesture": "gesture"}

# ── the rig, in the terms the poses below are written in ─────────────────────
#
# The dog faces **-Y** in the pack (`face_forward` turns the object at the very
# end, which does not touch a single bone), `.L` is on +X, and +Z is up. So
# "forward" is -Y throughout this file and every direction vector below reads
# that way. The rig is in OBJECT space in all of this: `pose_bone.matrix` is
# object-space and therefore invariant under the final turn.
FWD = Vector((0.0, -1.0, 0.0))

HIP = "spine.004"
# Forward of the hip: thorax, then the two neck bones, then the skull. The fore
# legs hang off `spine.006` — printed and checked, not assumed, because it is
# `spine.005` on the deer and `spine.007` on the raccoon and carrying one
# animal's answer to another moved the raccoon's paws 44 mm.
THORAX = ["spine.005", "spine.006"]
NECK = ["spine.007", "spine.008"]
TAIL = ["spine.003", "spine.002", "spine.001", "spine"]

# The body, for the purposes of "is any of it underground": the spine, the tail,
# the pelvis and the thigh. The thigh belongs in it and that is a finding rather
# than a convenience — a sitting dog rests on its HAUNCHES, so the outside of
# the thigh is a contact surface exactly as the metatarsus is, and the pose is
# only right when it is touching.
# The body's own spine, WITHOUT the tail. The distinction earns its keep: the
# pack dog's tail is four bones and 0.30 long against the cat's five and 0.16,
# so the cat's sit — which sweeps its tail out along the ground — puts the dog's
# 50 mm through the floor. Lifting the whole animal to get it out raised the
# shoulder 50 mm too and the forelegs then could not reach the ground at all
# (1.15 of their reach limit, a clamped leg and a torn shoulder). The tail is a
# tail problem; it is laid flat by `lay_tail` and never moves the body.
SPINE_ALL = ["spine.004", "spine.005", "spine.006", "spine.007", "spine.008"]
HAUNCH = ["shoulder.L", "shoulder.R", "thigh.L", "thigh.R"]
LEGS = {
    ("hind", "L"): dict(scap="shoulder.L", a="thigh.L", b="shin.L",
                        foot="foot.L", toe="toe.L"),
    ("hind", "R"): dict(scap="shoulder.R", a="thigh.R", b="shin.R",
                        foot="foot.R", toe="toe.R"),
    ("fore", "L"): dict(scap="front_shoulder.L", a="front_thigh.L", b="front_shin.L",
                        foot="front_foot.L", toe="front_toe.L"),
    ("fore", "R"): dict(scap="front_shoulder.R", a="front_thigh.R", b="front_shin.R",
                        foot="front_foot.R", toe="front_toe.R"),
}

# How close each leg came to its own reach limit on the last solve. A paw can
# track its path perfectly while the leg carrying it is clamped straight, and
# a clamped leg is a torn mesh — so this is read back and asserted rather than
# trusted. See `add-new-animation-to-glb`.
REACH = {}

# Where `ground_plane` found the floor, so the shot helper can draw it.
GROUND_Z = [0.0]

# How far each tail bone is swept round from the one before it, per pose. A
# resting dog's tail is always ON the ground and always to one side; how far
# round is the difference between "settled" and "asleep".
SIT_TAIL_YAW = 11.0
# Steepest a tail bone may fall, as a fraction of its own length.
TAIL_FALL = 0.5

# ─────────────────────────────────────────────────────────────────────────────
#  Reading the cat, before the dog is isolated
# ─────────────────────────────────────────────────────────────────────────────

def bone_map():
    """Cat bone -> dog bone, built from the topology rather than from names.

    The two chains are the same shape with the cat one tail vertebra longer, so
    every spine bone forward of the hip is off by one. See the header.
    """
    m = {"Root": "Root", "scull": "scull", "jaw": "jaw",
         "ear.L": "ear.L", "ear.R": "ear.R",
         "spine.005": HIP,                      # hip
         "spine.006": THORAX[0], "spine.007": THORAX[1],
         "spine.008": NECK[0], "spine.009": NECK[1]}
    # The TAIL is deliberately absent, and it is the one place the map gives up.
    # The cat carries five tail vertebrae over 0.16 and the dog four over 0.30,
    # so any correspondence is a guess, and the guess is expensive: mapping them
    # base-outward flung the dog's tail off the rump and stretched the skin
    # between the two by 4.7x — the worst tear in the build, against the 1.8-2.3x
    # the pack's own clips produce on this 659-vertex mesh. The dog's tail keeps
    # its standing rotation through the retarget and is authored per pose by
    # `place_tail`, which is a better answer anyway: what a tail does in each of
    # these three poses is a decision, not something to inherit from a cat.
    for side in "LR":
        for n in ["shoulder", "thigh", "shin", "foot", "toe"]:
            m[f"{n}.{side}"] = f"{n}.{side}"
        for n in ["front_shoulder", "front_thigh", "front_shin"]:
            m[f"{n}.{side}"] = f"{n}.{side}"
        # The cat's fore leg ends at `front_foot` and the dog's has a pastern
        # below it. The cat's PAW drives the dog's PAW.
        m[f"front_foot.{side}"] = f"front_toe.{side}"
    return m


def sample_cat_sit():
    """`Cat_Sit` as object-space rotations AND bone translations, plus the cat's
    standing reference and the scale to read its translations at.

    Read BEFORE `open_animal` isolates the dog, because that deletes every other
    object in the file. Plain quaternions and vectors come back, so nothing
    downstream depends on the cat surviving.

    ## Rotations alone are not this clip, and believing they were cost a round

    The first cut transferred rotation only — which is all the two retargets
    already in this repo need — and the dog came out sitting in mid-air with its
    hip still at standing height and its paws 30 cm off the floor.

    Every clip in this pack animates **location on all 33 bones** as well,
    because they are baked out of an FBX. Almost all of it is zero: measured
    against the cat standing, only `spine.005` — the hip — genuinely moves, and
    it moves 0.194, which IS the sit. The body does not come down by folding the
    legs under a fixed pelvis; it comes down because the pelvis is dropped and
    the legs fold to meet the floor. Four more bones carry 1-2 cm of soft offset
    and the other 28 carry 0.00000.

    So translation transfers too, scaled by the ratio of the two animals'
    standing hip heights — 0.194 on a cat is not 0.194 on a dog half again its
    size. Rotation is scale-free and translation is not; that is the whole of
    the difference.
    """
    cat = bpy.data.objects[CAT]
    cat.data.pose_position = 'POSE'                 # the pack ships every rig in REST
    if cat.animation_data:                          # ...with Idle SOLOED over everything
        for t in list(cat.animation_data.nla_tracks):
            cat.animation_data.nla_tracks.remove(t)
    cat.animation_data_create()
    cat.location = (0.0, 0.0, 0.0)                  # the cast is laid out on a grid

    def play(name):
        act = bpy.data.actions[name]
        cat.animation_data.action = act
        if act.slots:
            cat.animation_data.action_slot = act.slots[0]
        return act

    def read():
        bpy.context.view_layer.update()
        return {pb.name: (pb.matrix.to_3x3().to_quaternion(), pb.location.copy())
                for pb in cat.pose.bones}

    play(CAT_STAND)
    bpy.context.scene.frame_set(1)
    stand = read()
    bpy.context.view_layer.update()
    floor = min(cat.pose.bones[f"{n}.{s}"].tail.z
                for n in ("toe", "front_foot") for s in "LR")
    hip = cat.pose.bones[CAT_HIP].head.z - floor

    act = play(CAT_SIT)
    f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
    frames = []
    for f in range(f0, f1):              # f1 repeats f0 on a looping hold
        bpy.context.scene.frame_set(f)
        frames.append(read())
    rest3 = {b.name: b.matrix_local.to_3x3() for b in cat.data.bones}
    moved = sorted(((max((frames[i][n][1] - stand[n][1]).length
                         for i in range(len(frames))), n) for n in stand), reverse=True)
    print(f"[sit] sampled {CAT_SIT}: {len(frames)} frames of {len(stand)} bones; "
          f"cat hip {hip:.4f} above its floor")
    print("[sit]   bones that TRANSLATE: "
          + "  ".join(f"{n} {d:.4f}" for d, n in moved[:5]))
    return dict(stand=stand, frames=frames, rest3=rest3, hip=hip)


# ─────────────────────────────────────────────────────────────────────────────
#  Posing the dog
# ─────────────────────────────────────────────────────────────────────────────

def hierarchy_order(rig):
    order, seen = [], set()

    def visit(b):
        if b.name in seen:
            return
        if b.parent:
            visit(b.parent)
        seen.add(b.name)
        order.append(b.name)
    for b in rig.data.bones:
        visit(b)
    return order


def dog_standing(rig):
    """The dog's own standing reference: object-space rotation per bone."""
    act = bpy.data.actions[DOG_STAND]
    rig.animation_data.action = act
    if act.slots:
        rig.animation_data.action_slot = act.slots[0]
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.update()
    out = {pb.name: pb.matrix.to_3x3().to_quaternion() for pb in rig.pose.bones}
    rig.animation_data.action = None
    clear(rig)
    return out


def set_world(pb, q):
    """Put a pose bone at the object-space orientation `q`, keeping its head.

    The same construction `point()` uses, and for the same reason: writing
    `pb.matrix` lets Blender solve the basis against whatever the parent is
    doing, so the bone's own local axes — one of which is a full 180 degrees off
    world X on every thigh in this pack — never enter the arithmetic.
    """
    m = q.to_matrix().to_4x4()
    m.translation = pb.head.copy()
    pb.matrix = m


def apply_pose(rig, order, pose):
    """Drive every bone in `pose`, top down.

    A value is either a bare object-space quaternion or a `(quaternion, world
    offset)` pair. Parents first, always: a child's head is only in the right
    place once its parent has been posed, and `set_world` preserves the head it
    finds. The offset is then ADDED on top, in the frame the source expressed it
    in — the bone's own rest space under an already-posed parent, which is what
    `pose_bone.location` means and why it goes on after the rotation rather than
    into the matrix.
    """
    for n in order:
        if n not in pose:
            continue
        pb = rig.pose.bones[n]
        val = pose[n]
        q, offset = val if isinstance(val, tuple) else (val, None)
        set_world(pb, q)
        bpy.context.view_layer.update()
        if offset is not None and offset.length > 1e-9:
            pb.location = pb.location + (
                pb.bone.matrix_local.to_3x3().inverted() @ offset)
            bpy.context.view_layer.update()


def capture(rig):
    """The pose the rig is in now, in the form `apply_pose` eats.

    Rotation AND the bone-space translation, because on this rig the hip's
    translation is not a detail — it is where the whole body height lives, and a
    capture that dropped it would stand every derived pose back up. The
    conversion is the same one `apply_pose` inverts, so it round-trips exactly.
    """
    return {pb.name: (pb.matrix.to_3x3().to_quaternion(),
                      pb.bone.matrix_local.to_3x3() @ pb.location)
            for pb in rig.pose.bones}


def retargeted(cat, cat_frame, dog_stand, cmap, scale):
    """One frame of the cat's sit, as dog object-space rotations and offsets."""
    out = {}
    for cat_b, dog_b in cmap.items():
        if cat_b not in cat_frame or dog_b not in dog_stand:
            continue
        q_src, loc_src = cat_frame[cat_b]
        q_ref, loc_ref = cat["stand"][cat_b]
        # Translation transfers on the HIP only. That bone's 0.194 IS the sit —
        # the body comes down because the pelvis is dropped, not because the
        # legs fold under a fixed one. The four other bones that carry any
        # translation carry 1-2 cm of it, and scaled onto a differently
        # proportioned animal that is not motion: measured, it opened a 13 mm
        # gap at the dog's hip joint and a 14 mm one at each shoulder, which the
        # 659-vertex skin tears across. Joint continuity is worth more than two
        # centimetres of somebody else's slop.
        offset = ((cat["rest3"][cat_b] @ (loc_src - loc_ref)) * scale
                  if cat_b == CAT_HIP else None)
        out[dog_b] = (q_src @ q_ref.inverted() @ dog_stand[dog_b], offset)
    return out




def root_drop(rig, dz):
    """Sink or lift the whole animal by `dz` in world Z.

    `Root` points straight UP on this rig, so its local Y is world Z and writing
    `location.z` slides the dog sideways. `local_translation` is the conversion
    and skipping it is the bug that reads as a solver refusing to converge.
    """
    pb = rig.pose.bones[ROOT]
    pb.location = pb.location + local_translation(pb, Vector((0.0, 0.0, dz)))
    bpy.context.view_layer.update()


# ─────────────────────────────────────────────────────────────────────────────
#  sit
# ─────────────────────────────────────────────────────────────────────────────

def mesh_floor(mesh=None):
    """The lowest point of the DEFORMED skin, right now.

    The floor is a property of the mesh, not of the skeleton. Measured off the
    bones the pack dog's paw-tip bone sits 2 cm under the plane its pads rest
    on, so anything solved against `toe.tail` plants the animal two centimetres
    into the ground and reads as sinking.
    """
    dg = bpy.context.evaluated_depsgraph_get()
    ob = bpy.data.objects[mesh or MESH[0]].evaluated_get(dg)
    m = ob.to_mesh()
    z = min((ob.matrix_world @ v.co).z for v in m.vertices)
    ob.to_mesh_clear()
    return z


def part_floor(bones, mesh=None):
    """The lowest skin driven by `bones` — how deep one limb's underside is.

    Weights come off the UNDEFORMED mesh and positions off the deformed one,
    which is safe because an armature modifier changes neither the count nor
    the order of the vertices.
    """
    name = mesh or MESH[0]
    src = bpy.data.objects[name]
    want = {src.vertex_groups[b].index for b in bones if b in src.vertex_groups}
    idx = [v.index for v in src.data.vertices
           if any(g.group in want and g.weight > 0.3 for g in v.groups)]
    assert idx, f"no vertices are weighted to {sorted(bones)}"
    dg = bpy.context.evaluated_depsgraph_get()
    ob = src.evaluated_get(dg)
    m = ob.to_mesh()
    z = min((ob.matrix_world @ m.vertices[i].co).z for i in idx)
    ob.to_mesh_clear()
    return z


def ground_plane(rig, dog_stand, order):
    """The floor, and how high each limb rides above it in the poses used here.

    Three numbers, all MEASURED off the standing animal and its skin rather than
    declared, because every one of them is a proportion that differs per animal
    and the first cut guessed all three:

    * `floor` — the lowest vertex of the dog standing.
    * `carpus` / `hock` — how far the ankle bone sits above the floor with the
      paw in its STANDING attitude. Put the ankle back at that height with the
      paw held at its standing angle and the paw is planted exactly as it
      stands, whatever the leg above it is doing.
    * `lay` — the same thing for a hock lying FLAT, which is what a sit and a
      lie both do with the hind leg and what standing never does. Solved by
      actually laying the limb down and measuring the skin under it, not by
      assuming the paw is as thick as it is tall.
    """
    clear(rig)
    apply_pose(rig, order, dog_stand)
    floor = mesh_floor()
    stand_pad, bend = {}, {}
    for k, L in LEGS.items():
        stand_pad[k] = rig.pose.bones[L["foot"]].head.z - part_floor([L["foot"], L["toe"]])
        # Which way the middle joint points, read off the animal STANDING. It is
        # not the same way on the two pairs and it is not guessable: a dog's
        # stifle points forward and its elbow points BACKWARD, so one constant
        # for all four legs inverts one pair of them — which is exactly what a
        # first cut of this did, and the hind legs came out reaching forward
        # under the belly like a duck's.
        a = rig.pose.bones[L["a"]].head.copy()
        b = rig.pose.bones[L["b"]].head.copy()
        t = rig.pose.bones[L["foot"]].head.copy()
        u = (t - a).normalized()
        perp = (b - a) - u * (b - a).dot(u)
        bend[k] = perp.normalized() if perp.length > 1e-5 else FWD.copy()

    nose = rig.pose.bones[HEAD].tail.z - floor
    shoulder = rig.pose.bones["front_thigh.L"].head.z - floor
    for bone in TAIL:
        pb = rig.pose.bones[bone]
        d = pb.tail - pb.head
        point(pb, Vector((d.x, d.y, 0.0)))
    # Measured on the LAST tail bone, not the whole chain: the tail tapers, so
    # the root's half-thickness is nearly three times the tip's and using it
    # holds the whole tail 57 mm off the ground.
    tail_pad = rig.pose.bones[TAIL[-1]].head.z - part_floor([TAIL[-1]])
    clear(rig)
    apply_pose(rig, order, dog_stand)

    lay_pad, fore_lay = {}, {}
    for k in (("hind", "L"), ("hind", "R")):
        L = LEGS[k]
        point(rig.pose.bones[L["foot"]], FWD)
        point(rig.pose.bones[L["toe"]], FWD)
        lay_pad[k] = rig.pose.bones[L["foot"]].head.z - part_floor([L["foot"], L["toe"]])
    clear(rig)
    apply_pose(rig, order, dog_stand)
    for k in (("fore", "L"), ("fore", "R")):
        # The lie rests on the ELBOW and the whole forearm, which standing never
        # does, so its ride height has to be measured with the limb actually
        # laid down rather than inferred from the standing paw.
        L = LEGS[k]
        for n in (L["b"], L["foot"], L["toe"]):
            point(rig.pose.bones[n], FWD)
        fore_lay[k] = (rig.pose.bones[L["b"]].head.z
                       - part_floor([L["b"], L["foot"], L["toe"]]))
    clear(rig)
    print(f"[dog] standing floor {floor:+.4f}; ankle above the pad it rests on "
          + "  ".join(f"{k[0]}.{k[1]} {v:.4f}" for k, v in stand_pad.items())
          + " | hock laid flat " + "  ".join(f"{k[1]} {v:.4f}" for k, v in lay_pad.items()))
    print("[dog] middle joint points  "
          + "  ".join(f"{k[0]}.{k[1]} ({b.x:+.2f},{b.y:+.2f},{b.z:+.2f})" for k, b in bend.items()))
    GROUND_Z[0] = floor
    print("[dog] forearm laid flat  "
          + "  ".join(f"{k[1]} {v:.4f}" for k, v in fore_lay.items())
          + f" | standing nose {nose:.4f} above the floor")
    return dict(floor=floor, stand_pad=stand_pad, lay_pad=lay_pad, bend=bend,
                fore_lay=fore_lay, nose=nose, shoulder=shoulder, tail_pad=tail_pad)


def plant_fore(rig, dog_stand, geo):
    """Put both fore paws back on the floor, keeping where the artist put them.

    Only the HEIGHT is corrected. The carpus keeps the x and y the retarget gave
    it, so the cat's own placement of the forelegs survives; what does not
    survive a 1.85x change of proportions is the leg's reach, which is the whole
    reason a paw ends up in the air. Below the carpus the pastern and the paw
    are re-aimed at the world directions they hold while STANDING — so the paw
    meets the floor at exactly the angle it meets it at standing, and its own
    pad thickness is already in `stand_pad`.
    """
    for k in (("fore", "L"), ("fore", "R")):
        L = LEGS[k]
        a, b = rig.pose.bones[L["a"]], rig.pose.bones[L["b"]]
        foot = rig.pose.bones[L["foot"]]
        l1 = (b.head - a.head).length
        l2 = (foot.head - b.head).length
        want = Vector((foot.head.x, foot.head.y, geo["floor"] + geo["stand_pad"][k]))
        REACH[k] = (want - a.head).length / reach_limit(l1, l2)
        knee = ik2(a.head.copy(), want, l1, l2, geo["bend"][k])
        point(a, knee - a.head)
        point(b, want - b.head)
        for n in (L["foot"], L["toe"]):
            point(rig.pose.bones[n], dog_stand[n].to_matrix() @ Vector((0, 1, 0)))


PELVIS = ["shoulder.L", "shoulder.R"]
PELVIS_MAX = 70.0


def pitch_pelvis(rig, deg):
    """Rotate both pelvic bones by `deg` about world X, raising the hip joint."""
    for bone in PELVIS:
        pb = rig.pose.bones[bone]
        point(pb, rx(deg) @ (pb.tail - pb.head).normalized())


def solve_pelvis(rig, geo, tag):
    """Smallest pelvis pitch that rests the haunch ON the floor, not through it.

    The one place the cat's sit cannot simply be worn by a dog. Both animals
    drop the pelvis by the same fraction of their standing hip height (0.32 for
    the cat, 0.31 here — the retarget gets that right), but the dog's pelvic
    bone is 0.149 long against the cat's 0.072 where the whole animal is only
    1.79x, and its femur is shorter. Wearing the cat's pelvic angle therefore
    swings the dog's hip joint 171 mm THROUGH the ground.

    It cannot be fixed by lifting the animal, and trying is instructive: a
    sitting dog's shoulder is already at its standing height, so 171 mm of lift
    put the forelegs at 1.15 of their reach limit — a clamped leg and a torn
    shoulder. The pelvis is rotated instead, by the smallest angle that puts the
    haunch's skin on the floor, and the hind legs are re-solved under it
    afterwards. Everything forward of the loin is still exactly the cat's.

    Solved ONCE and held for the whole clip. Re-solving per frame would let the
    breathing modulate the pelvis, which is a wobble nobody authored — and it
    costs a full mesh evaluation per step, which is not free.
    """
    base = {b: (rig.pose.bones[b].tail - rig.pose.bones[b].head).normalized()
            for b in PELVIS}
    under = geo["floor"] - part_floor(HAUNCH)
    # NEGATIVE, and the sign is a measurement rather than a convention: this
    # bone runs backward and down from the sacrum, so `rx`'s "a positive angle
    # lifts a backward-pointing bone" is about its TAIL, and lifting the tail of
    # the pelvis rolls the whole haunch further under. Scanned both ways once;
    # the croup rises monotonically from 0 to -40 and falls from 0 to +40.
    for i in range(0, -int(PELVIS_MAX) - 1, -2):
        for b in PELVIS:
            point(rig.pose.bones[b], rx(float(i)) @ base[b])
        if part_floor(HAUNCH) >= geo["floor"]:
            print(f"[{tag}] pelvis pitched {i} deg to rest the haunch on the floor; "
                  f"at the cat's own angle its skin was {under * 1000:.0f} mm under")
            return float(i)
    raise SystemExit(
        f"[{tag}] no pelvis pitch down to -{PELVIS_MAX:.0f} deg rests the haunch — it "
        f"is {under * 1000:.0f} mm under the floor and rotating the pelvis is not "
        f"reaching it. The hip joint is in the wrong place, not the femur.")


def place_tail(rig, geo, yaw, pelvis=0.0, tag=None):
    """Sweep the tail round by `yaw` degrees per bone and lay it on the ground.

    Cumulative, off the direction the tail is already holding, so the sickle the
    pack authored is swept rather than replaced. `pelvis` carries the croup's
    own correction into the tail root, which has to follow it. `lay_tail` then
    drapes what is left onto the ground.
    """
    for i, bone in enumerate(TAIL):
        pb = rig.pose.bones[bone]
        # From the direction the bone is ALREADY pointing, not from the one it
        # points at standing. The tail hangs off the hip, and the hip has been
        # rotated by both the retarget and `pitch_pelvis`; starting from the
        # standing direction throws that away and leaves the tail behind while
        # the croup moves out from under it. That is a 35 mm edge between the
        # buttock and the tail root stretched to 190 mm — a visible web.
        d = (pb.tail - pb.head).normalized()
        point(pb, rz(yaw * (i + 1)) @ rx(pelvis * (1.0 if i == 0 else 0.5)) @ d)
    lay_tail(rig, geo)
    if tag:
        tip = rig.pose.bones[TAIL[-1]].tail
        print(f"[{tag}] tail swept {yaw * len(TAIL):.0f} deg; its tip rests "
              f"{(tip.z - geo['floor']) * 1000:.0f} mm above the floor")


def lay_tail(rig, geo):
    """Drape the tail onto the floor: down until it reaches it, then along it.

    Every pose here rests the tail on the ground, and each bone from the base
    outward is aimed as steeply down as it can go without its far end passing
    through the floor. A bone already at floor level therefore runs flat, and
    the chain as a whole falls and then lies — which is what a tail does. Judged
    from the base outward so each one is aimed after its parent has landed.
    """
    for bone in TAIL:
        pb = rig.pose.bones[bone]
        d = pb.tail - pb.head
        length = d.length
        floor_z = geo["floor"] + geo["tail_pad"]
        # Capped, and the cap is the whole of what makes this a tail rather
        # than a plumb line. Letting each bone fall as steeply as it can sends
        # the ROOT one straight down out of the croup — the skin between the
        # tail and the thigh is one 35 mm edge and it came out stretched 5.8x,
        # against the 2.3x the pack's own walk produces on this mesh. A tail
        # leaves the body along the body and only then falls.
        drop = max(0.0, min(TAIL_FALL, (pb.head.z - floor_z) / length))
        horiz = Vector((d.x, d.y, 0.0))
        if horiz.length < 1e-5:
            horiz = Vector((0.0, 1.0, 0.0))
        horiz = horiz.normalized() * math.sqrt(max(1.0 - drop * drop, 0.0))
        point(pb, Vector((horiz.x, horiz.y, -drop)))


def plant_hind(rig, geo, tuck=None):
    """Lay both hocks and both hind paws flat along the floor.

    A sitting dog rests on the BACKS OF ITS THIGHS AND ITS HOCKS, not on its
    rump — `camp_dog.js` says so and `sitting-side.jpg` shows it — so the
    metatarsus is a CONTACT, not a joint above one. It is levelled first, in
    whatever direction the retarget was pointing it, and the leg above is then
    solved to hold the hock at the one height that puts the underside of that
    limb on the floor.
    """
    for k in (("hind", "L"), ("hind", "R")):
        L = LEGS[k]
        a, b = rig.pose.bones[L["a"]], rig.pose.bones[L["b"]]
        foot, toe = rig.pose.bones[L["foot"]], rig.pose.bones[L["toe"]]
        # Which way along the ground the metatarsus runs, read BEFORE anything
        # moves — after the IK the paw is stale and aiming at it swings the
        # whole limb round.
        flat = Vector((toe.head.x - foot.head.x, toe.head.y - foot.head.y, 0.0))
        if flat.length < 1e-4:
            flat = FWD.copy()
        if tuck is None:
            want = Vector((foot.head.x, foot.head.y, geo["floor"] + geo["lay_pad"][k]))
        else:
            # A curl does not leave the hind legs wherever the spine's own bend
            # put them: they are drawn IN, under the belly, at the inside of the
            # C. Placing the hock explicitly is the only way to say that — the
            # sit's "keep the x and y, fix only the height" rule is exactly what
            # leaves them sticking out of the rump.
            side = Vector((-tuck.y, tuck.x, 0.0)) * (0.05 if k[1] == "L" else -0.05)
            want = a.head + tuck * 0.21 + side
            want.z = geo["floor"] + geo["lay_pad"][k]
            flat = Vector((tuck.x, tuck.y, 0.0))
        l1 = (b.head - a.head).length
        l2 = (foot.head - b.head).length
        REACH[k] = (want - a.head).length / reach_limit(l1, l2)
        knee = ik2(a.head.copy(), want, l1, l2, geo["bend"][k])
        point(a, knee - a.head)
        point(b, want - b.head)
        point(foot, flat)
        point(toe, flat)


def build_sit(rig, order, cat, dog_stand, geo, scale, name="sit"):
    cmap = bone_map()
    driven = set(cmap.values())
    # Everything the sit moves has to be driven by a cat bone — except the tail,
    # which `place_tail` authors instead and `bone_map` deliberately leaves out.
    must = {HIP, *THORAX, *NECK, HEAD} | {b for L in LEGS.values() for b in
                                          (L["scap"], L["a"], L["b"])}
    missing = sorted(must - driven)
    assert not missing, f"no cat bone drives {missing}"
    assert not (set(TAIL) & driven), "the tail is authored here, not retargeted"

    cat_frames = cat["frames"]
    act = new_action(rig, name, len(cat_frames))
    lows, reach, lift, base, pelvis = [], [], None, None, None
    for i in range(len(cat_frames) + 1):
        f = cat_frames[i % len(cat_frames)]
        clear(rig)
        apply_pose(rig, order, retargeted(cat, f, dog_stand, cmap, scale))
        if lift is None:
            # How far the body has to come UP before anything below it is
            # solved. The cat's own joint angles put the dog's stifle 120 mm
            # under the floor — its pelvis is relatively longer and its femur
            # relatively shorter than the cat's, so the same angles reach
            # further down. Nothing about the legs can fix that; the body is in
            # the wrong place and the legs are the only thing that can tell you.
            #
            # Measured ONCE, on the first frame, and held constant for the
            # whole clip: recomputing it per frame would let the breathing
            # modulate the body height, which is a bounce nobody authored.
            # Only ever UP: the retarget is entitled to hold the body higher
            # than the floor and this is not a place to second-guess it.
            lift = max(0.0, geo["floor"] - part_floor(SPINE_ALL))
            print(f"[sit] body {(part_floor(SPINE_ALL) - geo['floor']) * 1000:+.1f} mm "
                  f"above the floor, haunch "
                  f"{(geo['floor'] - part_floor(HAUNCH)) * 1000:+.1f} mm, shoulder "
                  f"{(rig.pose.bones['front_thigh.L'].head.z - geo['floor'])*1000:.0f} mm up "
                  f"(standing {geo['shoulder']*1000:.0f})")
        root_drop(rig, lift)
        if pelvis is None:
            pelvis = solve_pelvis(rig, geo, "sit")
        else:
            pitch_pelvis(rig, pelvis)
        place_tail(rig, geo, SIT_TAIL_YAW, pelvis, "sit" if i == 0 else None)
        if i == 0:
            raw = {k: part_floor([L["foot"], L["toe"]]) - geo["floor"] for k, L in LEGS.items()}
            print("[sit] retargeted, before planting: each paw's sole "
                  + "  ".join(f"{k[0]}.{k[1]} {v:+.4f}" for k, v in raw.items()))
        plant_hind(rig, geo)
        plant_fore(rig, dog_stand, geo)
        if i == 0:
            base = capture(rig)
        lows.append({k: part_floor([L["foot"], L["toe"]]) - geo["floor"] for k, L in LEGS.items()})
        reach.append(dict(REACH))
        key(rig, order, i, loc={ROOT})
    set_linear(act)
    rig.animation_data.action = None
    clear(rig)
    worst = max(abs(v) for row in lows for v in row.values())
    geo["pelvis"] = pelvis
    print("[sit] each paw's sole after planting, worst frame: "
          + "  ".join(f"{k[0]}.{k[1]} {max(abs(r[k]) for r in lows)*1000:+.1f} mm"
                      for k in LEGS)
          + " | reach used " + "  ".join(f"{k[0]}.{k[1]} {max(r[k] for r in reach):.3f}"
                                         for k in LEGS))
    gap = seam(rig, act, len(cat_frames))
    rig.animation_data.action = None
    clear(rig)
    print(f"[sit] {len(cat_frames)} frames; worst paw off the floor {worst*1000:.2f} mm, "
          f"loop seam {gap*1000:.3f} mm")
    return act, base


# ─────────────────────────────────────────────────────────────────────────────
#  lie — the sphinx
# ─────────────────────────────────────────────────────────────────────────────
#
# Reference `laying-1.png`: chest and elbows on the ground, forelegs reaching
# straight out in front, hind legs folded flat alongside, head up and awake.
# `camp_dog.js` calls it "the one that reads as keeping an eye on you rather
# than asleep", and that is the whole brief — it is the pose the dog is in when
# the player looks over and it looks back.
#
# Built from the SIT, because that is what it anatomically is: the pelvis, the
# hocks and the folded hind legs do not move at all between the two. Only the
# forehand comes down. Everything below is therefore about the front half.

# How far down the forehand goes is not a number to type in: it is whatever
# first puts the BRISKET on the ground, measured on the skin. Aiming at the
# shoulder instead — "low enough that a vertical humerus reaches the floor" —
# was the first cut and it drove the chest 134 mm THROUGH the floor, because a
# rib cage is deep and the shoulder joint is nowhere near the bottom of it.
# Scanned rather than solved in closed form, for the reason `solve_chest` gives:
# nothing here guarantees the monotonicity a bisection needs.
LIE_PITCH_MAX = 78.0
# The bones the brisket and rib cage hang off — what has to reach the ground.
CHEST = ["spine.006", "spine.007"]
LIE_PITCH_SHARE = [("spine.005", 0.46), ("spine.006", 0.54)]

# Where the nose ends up, as a fraction of the height it carries at standing.
# The head stays UP: this is the awake pose, and the sleeping one is `curl`.
LIE_NOSE = 0.55
LIE_TAIL_YAW = 12.0              # per bone, laid out alongside
LIE_NOSE_AHEAD = 0.30            # how far in front of the neck base, in body units


def fore_reach_down(rig):
    """Length of the humerus — how far the elbow hangs below the shoulder."""
    a = rig.pose.bones["front_thigh.L"]
    return (rig.pose.bones["front_shin.L"].head - a.head).length


def lie_forehand(rig, geo, pitch):
    """Pitch the thorax by `pitch` degrees and report the shoulder's height."""
    for name, share in LIE_PITCH_SHARE:
        pb = rig.pose.bones[name]
        point(pb, rx(pitch * share) @ (pb.tail - pb.head).normalized())
    return rig.pose.bones["front_thigh.L"].head.z - geo["floor"]


def lie_forelegs(rig, geo, along=None, splay=0.14):
    """Humerus down, forearm and paw flat along the floor in front.

    The elbow is a CONTACT in this pose and the forearm is another — a lying dog
    rests on both — so everything from the elbow forward is laid level at the
    one height that puts the underside of the limb on the ground, exactly as the
    hind leg's metatarsus is in `plant_hind`.
    """
    for k in (("fore", "L"), ("fore", "R")):
        L = LEGS[k]
        a = rig.pose.bones[L["a"]]
        l1 = (rig.pose.bones[L["b"]].head - a.head).length
        drop = a.head.z - (geo["floor"] + geo["fore_lay"][k])
        # The elbow lies on a sphere of the humerus's own length about the
        # shoulder. If the shoulder is higher than that, the chest has not come
        # down far enough and no arrangement of the leg can reach the floor.
        assert drop <= l1 * 0.999, (
            f"{k} shoulder is {drop:.3f} above the floor with a {l1:.3f} humerus; "
            f"the forehand has not come down far enough to put the elbow on it")
        flat = (along or FWD).normalized()
        # The elbow lies on a circle: the humerus's length, dropping `drop`, with
        # the rest of it spent going BACKWARD along the body — a lying dog's
        # elbow is behind its shoulder, not in front of it.
        horiz = math.sqrt(max(l1 * l1 - drop * drop, 0.0))
        side = Vector((-flat.y, flat.x, 0.0)) * (splay if k[1] == "L" else -splay)
        point(a, (-flat + side).normalized() * horiz + Vector((0.0, 0.0, -drop)))
        for n in (L["b"], L["foot"], L["toe"]):
            point(rig.pose.bones[n], flat)


def build_lie(rig, order, base, dog_stand, geo, name="lie", frames=None):
    """Author the sphinx lie on top of `base` (the planted sit pose)."""
    clear(rig)
    apply_pose(rig, order, base)
    stand_nose = geo["nose"]
    reach = fore_reach_down(rig)

    got, pitch = None, None
    for i in range(int(LIE_PITCH_MAX) + 1):
        clear(rig)
        apply_pose(rig, order, base)
        h = lie_forehand(rig, geo, float(i))
        if part_floor(CHEST) <= geo["floor"]:
            pitch, got = float(i), h
            break
    assert pitch is not None, (
        f"no thorax pitch up to {LIE_PITCH_MAX} deg puts the brisket on the floor")
    geo["lie_pitch"] = pitch
    print(f"[lie] thorax pitched {pitch:.0f} deg to put the brisket down; "
          f"shoulder {got:.4f} above the floor against a {reach:.4f} humerus")

    lie_forelegs(rig, geo)
    # The neck inherits every degree of that pitch and would drive the muzzle
    # into the ground. Bring the head back up to a target measured off the
    # animal's own standing nose height rather than off a constant.
    base_neck = rig.pose.bones[NECK[0]].head.copy()
    target = Vector((0.0, base_neck.y - LIE_NOSE_AHEAD,
                     geo["floor"] + stand_nose * LIE_NOSE))
    _neck_reach(rig, NECK + [HEAD], HEAD, target)
    place_tail(rig, geo, LIE_TAIL_YAW, 0.0, name)
    settle(rig, geo, name)
    nose = rig.pose.bones[HEAD].tail
    print(f"[lie] nose y{nose.y:+.4f} z{nose.z - geo['floor']:+.4f}, asked "
          f"z{target.z - geo['floor']:+.4f} ({LIE_NOSE:.2f} of standing {stand_nose:.4f})")
    return breathe(rig, order, name, frames or REST_FRAMES, geo)


# ─────────────────────────────────────────────────────────────────────────────
#  curl — the comma
# ─────────────────────────────────────────────────────────────────────────────
#
# Reference `curled-up-2.jpg`: the spine arcs through most of a half circle in
# the HORIZONTAL plane, the hindquarters make a high rounded dome, and the nose
# comes all the way round to rest by the front paws.
#
# The finding `camp_dog.js` records is the one that matters and it is repeated
# here because it is not obvious: **the BACK makes the C, not the neck.** Put
# most of the yaw in the neck and the result is a straight dog with its head
# turned round, which is a swan. The yaw below is cumulative — each bone adds to
# its parent's — so the numbers look small and the arc they sum to is 128
# degrees, of which the spine carries 78 and the neck only finishes it.
# The arc, authored as an ABSOLUTE (yaw, pitch) per spine bone against the
# direction the body points at the loin — not as a rotation of whatever that
# bone was already doing. The difference is not cosmetic: the first cut layered
# the arc on top of the LIE's 63 degrees of thorax pitch and then ran the
# sagittal neck solver over the result, and the head ended up buried in the
# flank. A curled dog's spine is a curve lying flat on the ground; say that
# directly and there is nothing to unwind.
#
# The finding `camp_dog.js` records is the one that matters, and it is repeated
# here because it is not obvious: **the BACK makes the C, not the neck.** Put
# most of the yaw in the neck and the result is a straight dog with its head
# turned round, which is a swan. Of the 120 degrees below the back carries 66
# and the neck and skull finish the last 54.
CURL_ARC = [(HIP, 0.0, -4.0), ("spine.005", 30.0, -2.0), ("spine.006", 66.0, 2.0),
            ("spine.007", 88.0, 16.0), ("spine.008", 108.0, 28.0), (HEAD, 124.0, 30.0)]
# Where the forelegs point. Not straight ahead: at the thorax's own heading the
# paws finish a whole forearm past the muzzle, because this dog's fore chain
# below the elbow is 0.39 long and the head has come round 124 degrees to meet
# it. Aimed along the INSIDE of the curl instead, they end up beside the nose,
# which is where both reference photographs have them.
CURL_FORE_YAW = 145.0
CURL_TAIL_YAW = 30.0             # per bone, wrapped round the OUTSIDE of the curl


def build_curl(rig, order, base, dog_stand, geo, name="curl", frames=None):
    """Author the curl: the body flat on the ground, bent into a comma."""
    clear(rig)
    apply_pose(rig, order, base)

    for bone, yaw, pitch in CURL_ARC:
        point(rig.pose.bones[bone], rz(yaw) @ rx(pitch) @ FWD)
    back = max(y for b, y, _ in CURL_ARC if b not in NECK and b != HEAD)
    print(f"[curl] spine arc {CURL_ARC[-1][1]:.0f} deg, of which the BACK carries "
          f"{back:.0f} and the neck and skull finish {CURL_ARC[-1][1] - back:.0f}")

    # Where the body sits is decided by the body, before anything hanging off it
    # is solved: flattening the loin has left the barrel floating, and a limb
    # solved against a floating body is solved against nothing.
    drop = geo["floor"] - part_floor(SPINE_ALL)
    root_drop(rig, drop)
    print(f"[curl] barrel put down {drop * 1000:+.1f} mm; shoulder now "
          f"{(rig.pose.bones['front_thigh.L'].head.z - geo['floor']) * 1000:.0f} mm up")

    # Flattening the loin rolled both hind legs with it. Put them back the way
    # the sit has them — hocks along the ground, tucked in under the body —
    # which is where a curled dog's are too. The pelvis itself needs NO second
    # correction: it is a child of the hip and carried the sit's solved pitch
    # through the arc with it.
    plant_hind(rig, geo, tuck=(rz(CURL_ARC[1][1]) @ FWD))

    # The forelegs hang off the thorax and have been carried round by the arc.
    # Lay them back down flat, pointing wherever the chest now faces, so the
    # paws finish under the muzzle at the inside of the curl.
    # No splay in a curl: the two forelegs are drawn together at the inside of
    # the C, and the 0.14 the lie uses puts the far one outside it.
    lie_forelegs(rig, geo, rz(CURL_FORE_YAW) @ FWD, splay=0.0)

    place_tail(rig, geo, CURL_TAIL_YAW, 0.0, name)

    settle(rig, geo, name)
    nose = rig.pose.bones[HEAD].tail
    print(f"[curl] nose z{nose.z - geo['floor']:+.4f} above the floor "
          f"({(nose.z - geo['floor']) / geo['nose']:.2f} of standing)")
    return breathe(rig, order, name, frames or REST_FRAMES, geo)


def settle(rig, geo, tag):
    """Drop or lift the whole animal until its lowest skin is ON the floor.

    An authored pose is a claim about where the body is, and the claim is only
    true if something is touching the ground. Both poses below rest on their
    ribs and their folded limbs rather than on four solved contact points, so
    the honest check is the skin itself: find the lowest vertex and move the
    animal by exactly that much. Anything else either floats or sinks, and both
    read instantly at three metres.
    """
    dz = geo["floor"] - mesh_floor()
    root_drop(rig, dz)
    after = mesh_floor() - geo["floor"]
    print(f"[{tag}] settled {dz * 1000:+.1f} mm; lowest skin now "
          f"{after * 1000:+.2f} mm off the floor")
    assert abs(after) < 0.002, "the settle did not land the animal on the floor"


# ─────────────────────────────────────────────────────────────────────────────
#  Breathing, which is the whole of a rest clip's motion
# ─────────────────────────────────────────────────────────────────────────────
#
# A settled dog holds its pose for 26-75 s (`camp_dog.js` REST_TIME), so the
# clip it holds cannot be a still frame. What moves on a resting animal is the
# rib cage, and only the rib cage: a few millimetres, once every four seconds.
#
# Keyed at every frame like everything else here, and closed on its own seam —
# a breath that does not return to where it started decelerates across the loop
# join every four seconds, which is exactly the kind of fault that is invisible
# in Blender and obvious in the game.
REST_FRAMES = 96                 # 4.0 s at the pack's 24 fps
BREATH_DEG = 1.35                # rib cage, at the thorax
BREATH_NECK = 0.55               # the head rides a fraction of it


def breathe(rig, order, name, frames, geo):
    """Key the pose the rig is in now over `frames`, with a breath on it."""
    held = capture(rig)

    act = new_action(rig, name, frames)
    for f in range(frames + 1):
        clear(rig)
        apply_pose(rig, order, held)
        phase = math.sin(2.0 * math.pi * (f % frames) / frames)
        for bone, share in (("spine.005", 0.55), ("spine.006", 0.45),
                            (NECK[0], -BREATH_NECK * 0.6), (NECK[1], -BREATH_NECK * 0.4)):
            pb = rig.pose.bones[bone]
            point(pb, rx(BREATH_DEG * share * phase) @ (pb.tail - pb.head).normalized())
        key(rig, order, f, loc={ROOT, HIP})
    set_linear(act)
    rig.animation_data.action = None
    clear(rig)
    gap = seam(rig, act, frames)
    rig.animation_data.action = None
    clear(rig)
    print(f"[{name}] {frames} frames; loop seam {gap * 1000:.3f} mm")
    return act


# ─────────────────────────────────────────────────────────────────────────────
#  Build
# ─────────────────────────────────────────────────────────────────────────────

def worst_stretch(clip, floor_mm=0.020):
    """Worst edge stretch this clip puts on the skin, against the REST mesh.

    Two things make this different from `pack_rig_kit.max_edge_stretch`, and
    both were arrived at by getting a wrong answer first:

    * The baseline is the **undeformed** mesh. The kit's version takes its rest
      lengths from whatever pose the rig happens to be in when it is called,
      which is right inside a build that calls it straight after `clear` and
      silently reports 1.000 anywhere else.
    * Edges shorter than `floor_mm` are ignored. This is a 659-vertex animal
      with 2 mm edges around the eyes and paw pads, and a ratio on one of those
      is noise — 6x of nothing is nothing. What matters is a 35 mm edge that
      becomes 190 mm, which is a web of skin the player can see.
    """
    src = bpy.data.objects[MESH[0]]
    rest = {e.index: (src.data.vertices[e.vertices[0]].co
                      - src.data.vertices[e.vertices[1]].co).length
            for e in src.data.edges}
    act = bpy.data.actions[clip]
    # `frame_start`/`frame_end` are the MANUAL range and read 0 unless
    # `use_frame_range` was set — which the clips authored here do and the
    # pack's do not. Sampling that range walked one frame, frame 0, for every
    # pack clip and reported four identical numbers.
    f0, f1 = (int(act.frame_start), int(act.frame_end)) if act.use_frame_range \
        else (int(act.frame_range[0]), int(act.frame_range[1]))
    worst, where = 0.0, None
    for f in range(f0, f1 + 1, max(1, (f1 - f0) // 12)):
        play(src.parent, act, f)
        dg = bpy.context.evaluated_depsgraph_get()
        ev = src.evaluated_get(dg)
        m = ev.to_mesh()
        for e in m.edges:
            base = rest.get(e.index, 0.0)
            if base < floor_mm:
                continue
            r = (m.vertices[e.vertices[0]].co - m.vertices[e.vertices[1]].co).length / base
            if r > worst:
                worst, where = r, (f, base)
        ev.to_mesh_clear()
    return worst, where


def play(rig, act, frame):
    """Assign an action, its SLOT, and a frame — and mean it.

    `pack_rig_kit.sample` only fills the slot in when it finds `action_slot` at
    None, which is exactly right the first time and wrong every time after: once
    a slot is set, assigning a different action leaves the old one in place and
    the rig silently keeps the previous clip's pose. The tell is several clips
    reporting identical numbers, which is how this was found.
    """
    rig.animation_data.action = act
    if act.slots:
        rig.animation_data.action_slot = act.slots[0]
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()


def stretch_report(rig):
    """Print every clip's worst stretch, and fail if ours are out of family.

    The bar is the PACK's own clips rather than a constant. This mesh is coarse
    enough that its walk already puts 2.3x on the web between the thighs, so a
    fixed threshold would either pass everything or condemn the artist's own
    animation. What can be asserted honestly is that the three poses authored
    here do not deform the skin much worse than the animation that shipped with
    it.
    """
    got = {}
    for clip in ("idle", "walk", "run", "gesture", "sit", "lie", "curl"):
        if clip in bpy.data.actions:
            r, where = worst_stretch(clip)
            got[clip] = r
            print(f"[dog] {clip:8s} worst skin stretch {r:.2f}x"
                  + (f" (frame {where[0]}, a {where[1]*1000:.0f} mm edge)" if where else ""))
    theirs = max(got[c] for c in ("idle", "walk", "run", "gesture") if c in got)
    ours = max(got[c] for c in ("sit", "lie", "curl") if c in got)
    assert ours <= theirs * 2.0, (
        f"the authored poses stretch the skin {ours:.2f}x against {theirs:.2f}x for "
        f"the pack's own clips — that is a tear, not a pose")
    print(f"[dog] authored {ours:.2f}x against the pack's own {theirs:.2f}x")
    rig.animation_data.action = None
    clear(rig)


def variant_report():
    """Do the six `Dog_0*` meshes ride one skeleton, and how do they differ?

    The pack ships variants three different ways and it is worth a minute to
    find out which one this is (the deer's are separate SILHOUETTES on identical
    skeletons; the goat's two are the same 828 vertices with different UVs, so
    the variant is a texture). Whatever this dog's answer is, it belongs to the
    import step — all six are carried through, because they already share
    `Skeleton_Dog` and cost nothing.
    """
    dg = bpy.context.evaluated_depsgraph_get()
    base = None
    for name in MESH:
        ob = bpy.data.objects[name]
        co = [ob.matrix_world @ v.co for v in ob.data.vertices]
        uvs = len({tuple(round(x, 5) for x in l.uv) for l in ob.data.uv_layers[0].data})
        if base is None:
            base = co
            print(f"[dog] {name}: {len(co)} verts, {uvs} distinct UVs  (the reference)")
            continue
        if len(co) == len(base):
            dev = max((a - b).length for a, b in zip(co, base))
            print(f"[dog] {name}: {len(co)} verts, {uvs} distinct UVs, "
                  f"max deviation from {MESH[0]} {dev:.6f}")
        else:
            print(f"[dog] {name}: {len(co)} verts, {uvs} distinct UVs "
                  f"— a DIFFERENT mesh, not a recolour")


def build(shots=None):
    cat = sample_cat_sit()

    rig = open_animal(RIG, MESH, "Dog_")
    for ob in bpy.data.objects:
        if ob.type == 'MESH':
            ob.location = (0.0, 0.0, 0.0)      # the cast is on a grid; so are its meshes
    bpy.context.view_layer.update()
    variant_report()

    order = hierarchy_order(rig)
    for pb in rig.pose.bones:
        pb.rotation_mode = 'QUATERNION'
    dog_stand = dog_standing(rig)
    geo = ground_plane(rig, dog_stand, order)

    # Rotation is scale-free; translation is not. The cat's hip drops 0.194 in
    # its own units and the dog is half again its size, so every transferred
    # offset is read at the ratio of the two animals' standing hip heights.
    scale = (rig.pose.bones[HIP].head.z - geo["floor"]) / cat["hip"]
    print(f"[sit] cat -> dog translation scale {scale:.4f}")
    _, base = build_sit(rig, order, cat, dog_stand, geo, scale)
    build_lie(rig, order, base, dog_stand, geo)
    build_curl(rig, order, base, dog_stand, geo)

    for old, new in RENAME.items():
        if old not in bpy.data.actions:
            continue
        act = bpy.data.actions[old]
        act.name = new
        act.use_fake_user = True
        # `export_pack_glb` asserts a manual range on every action, and an
        # action that has never had one reads 0..0 — which would export each of
        # the pack's four clips as a single frame. Set it to the range its own
        # KEYS occupy: the artist numbered these from 1 and they stay there.
        # The clips authored here are zero-based because they were authored that
        # way (see `new_action`); these are not, and renumbering them would be
        # editing the artist's clip to suit the exporter.
        act.frame_start, act.frame_end = act.frame_range
        act.use_frame_range = True

    stretch_report(rig)

    if shots:
        render_shots(rig, shots)

    face_forward(rig, HEAD)

    # Lay every clip out as a soloable NLA track, the way the pack lays itself
    # out, so the saved file is consistent with its source and can be scrubbed.
    rig.animation_data.action = None
    for act in sorted(bpy.data.actions, key=lambda a: a.name):
        track = rig.animation_data.nla_tracks.new()
        track.name = act.name
        track.strips.new(act.name, int(act.frame_start), act)
        track.is_solo = False

    mats, imgs = purge(MESH)
    print(f"[dog] kept materials {mats} images {imgs}")
    # Opens framed on the animal with the CURL soloed — the clip this file
    # exists to let you judge, and the one the dog spends most of its time in
    # (`camp_dog.js` picks it 55% of the time).
    curl = bpy.data.actions["curl"]
    frame_view(rig, MESH, clip="curl",
               clip_range=(int(curl.frame_start), int(curl.frame_end)))
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(OUT))
    size = os.path.getsize(OUT) / 1e6
    print(f"[dog] wrote {OUT} ({size:.1f} MB) with clips "
          f"{sorted(a.name for a in bpy.data.actions)}")


# ─────────────────────────────────────────────────────────────────────────────
#  Stills, so a pose can be judged rather than asserted at
# ─────────────────────────────────────────────────────────────────────────────

def render_shots(rig, out_dir):
    """Side and top stills of every authored clip. Judge a pose broadside."""
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.render.resolution_x, sc.render.resolution_y = 800, 600
    sc.render.image_settings.media_type = 'IMAGE'
    sc.render.image_settings.file_format = 'PNG'
    cam_data = bpy.data.cameras.new('shotcam')
    cam = bpy.data.objects.new('shotcam', cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = 1.55
    keep = {MESH[0]}
    for ob in bpy.data.objects:
        ob.hide_render = ob.type == 'MESH' and ob.name not in keep

    # A floor, because a pose that floats and a pose that rests look identical
    # without one.
    bpy.ops.mesh.primitive_plane_add(size=6.0, location=(0.0, 0.0, GROUND_Z[0]))
    plane = bpy.context.object
    keep.add(plane.name)
    plane.hide_render = False
    views = dict(side=(1.0, 0.0, 0.0), rear=(1.1, 1.0, 0.45),
                 front=(1.1, -1.0, 0.45), top=(0.0, 0.0, 1.0))
    for name in ("sit", "lie", "curl"):
        act = bpy.data.actions.get(name)
        if not act:
            continue
        mid = int((act.frame_start + act.frame_end) / 2)
        sample(rig, act, mid)
        # Frame each pose on its own bounding box. A sit is 0.95 tall and a curl
        # is 0.35; one fixed camera either crops the first or loses the second.
        dg = bpy.context.evaluated_depsgraph_get()
        ev = bpy.data.objects[MESH[0]].evaluated_get(dg)
        m = ev.to_mesh()
        pts = [ev.matrix_world @ v.co for v in m.vertices]
        ev.to_mesh_clear()
        lo = Vector((min(p[i] for p in pts) for i in range(3)))
        hi = Vector((max(p[i] for p in pts) for i in range(3)))
        centre = (lo + hi) / 2
        cam_data.ortho_scale = max(hi[i] - lo[i] for i in range(3)) * 1.35
        for view, eye in views.items():
            d = Vector(eye).normalized()
            cam.location = centre + d * 4.0
            cam.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
            sc.render.filepath = os.path.join(out_dir, f"{name}_{view}.png")
            bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(plane, do_unlink=True)
    rig.animation_data.action = None
    clear(rig)
    bpy.data.objects.remove(cam, do_unlink=True)
    for ob in bpy.data.objects:
        ob.hide_render = False


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    shots = argv[argv.index("--shots") + 1] if "--shots" in argv else None
    build(shots)
