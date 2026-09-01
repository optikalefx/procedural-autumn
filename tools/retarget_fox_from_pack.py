"""Put the bought pack fox's clips onto OUR fox's rig, and save the .blend.

    Blender -b assets/models/Animals_v3.0.blend \
        --python tools/retarget_fox_from_pack.py -- [out.blend]

Default output is `assets/models/fox_packanim.blend`; pass a path to override.
Nothing here writes to `Animals_v3.0.blend` or to `fox_reference.blend` unless
you name the latter yourself.

## Why a retarget and not a re-skin

The ask was "port the pack's fox rigging and animations into our model", and
there are two ways to read that. Re-skinning our mesh onto `Skeleton_Fox` is the
literal one and it is the worse one: the pack's bones sit where the pack's fox
is, not where ours is, so the skeleton would have to be moved to fit our
geometry — and moving edit bones changes the rest pose, which is the thing every
clip is stored relative to. That is the same arithmetic as a retarget, done
destructively and with our vertex weights thrown away as well.

So our mesh, our weights and our `Fox_Rig` are untouched. Only the ACTIONS
change. See `docs/` and the `import-animal` skill; the technique is the one
`build_ram_blend.py:retarget_run` used to put the goat's leap on the ram.

## The two rigs are the same rig with different names

Both are 31 bones and the topology matches joint for joint — six spine segments
from pelvis to skull, ears off the last one, shoulders off the third, four tail
segments and a scapula/upper/lower/foot/toe chain per leg. `BONE_MAP` below is
therefore total and asserted total: every bone on our rig is driven, and no
bone on theirs is dropped. That is a much better position than the goat->ram
retarget, which shared names but not proportions.

## What actually transfers, and the frame it is expressed in

A Blender action stores rotation RELATIVE TO REST, so copying fcurves verbatim
between two rigs makes a different animal. What transfers is the reference-
relative WORLD rotation, per bone per frame:

    delta      = src_posed_world @ src_reference_world^-1
    dst_target = delta @ dst_rest_world

Reference differences cancel. But `delta` is expressed in the SOURCE armature's
frame, and the two foxes do not share one: the pack faces -Y with `.L` on +X,
and this repo authors +Y forward, which puts our `.L` on -X. A 180-degree turn
about Z maps one frame onto the other and — being a proper rotation, not a
mirror — it fixes the facing and the handedness together:

    delta_ours = C . delta_pack . C^-1,   C = Rz(180 deg)

Skip it and every limb swings backwards while measuring perfectly, which is the
one fault nothing downstream catches (see `pack_rig_kit`'s docstring).

`Root` is excluded, exactly as the ram's retarget excludes it. Measured on all
four fox clips its reference-relative delta is a CONSTANT 180 degrees and it
never moves: that is the pack's facing convention sitting in a bone, not motion,
and applying it would run the fox tail first.

## The reference pose is NOT the pack's rest, and that cost a round

The obvious `src_reference = src_rest` sagged the fox onto its chest. The two
rests are not the same pose, and only one of them is the animal standing up:

    leg extension at rest      fore     hind
    the pack's bind pose      0.954    0.672      <- hind is a proper canid hock
    the pack STANDING (Idle)  0.869    0.662
    ours                      1.000    0.992      <- a straight column, both ends

Rest-relative, our foreleg picks up the pack's 0.954 -> 0.869 bend and drops the
forequarters 2.4 cm, while our hind — which has no slack to bend into — keeps
its height. The fox ends up nose-down with its hind paws in the air.

So the reference is `Fox_Idle` frame 1, the pack fox STANDING. Then a pack fox
at rest maps to our fox at OUR rest — the tall stance the model was built with,
paws already on the floor — and everything else transfers as a deviation from
standing. This is the correspondence pose a retarget is supposed to have; the
bind pose was only ever a convenient stand-in for it.

## And the paws still have to be planted, because the LEGS cannot bend

The reference fixes the stance. It cannot fix the gait, because the pack's walk
straightens its hock by up to 0.20 of the chain and our hock is already at
0.992 — there is nothing to straighten into. Rotations transfer; reach does not.

The stifle is not where to fix that, and trying cost a round. Solved with
`pack_rig_kit.ik2` over (thigh, shin), the hind leg has a reach limit of 1.0305
against a rest span of 1.0300 — 0.5 mm of travel — so every target clamped and
the paws did not move at all.

**The slack is in the pastern.** From the hock to the paw tip is 0.3785 of
rigid foot, and swinging it is free: the contact point lies on a sphere of that
radius about the ankle, so as long as the ankle is within 0.3785 of the ground
the paw can be put exactly on it by rotating one bone. That is the whole
correction — the "adjust the back feet angle a bit" reading of the problem, done
per frame and measured rather than eyeballed.

So each leg gets a planting pass: where the paw is in the bottom quarter of its
own travel it is rotated onto the floor, and the correction eases to nothing
through the swing so the authored lift arc keeps its shape and nothing pops.
The thigh and shin keep exactly what the retarget gave them.

Body height is set from the FORE paws, which rest at 1.000 against the pack's
0.954 and are the pair the transfer lands on. Taking the deepest of all four
instead let a hind paw that cannot bend hold the whole animal in the air.

## The finding this leaves behind

Our fox's hind limb has 1.305 of bone spanning a 1.305 drop from hip to paw, and
its fore limb 1.201 spanning 1.201. Both legs are straight columns at rest,
where the pack's hind holds 28% of its length in the hock (0.430 of bone for a
0.311 drop). A quadruped rig wants that bend in its REST pose: it is the slack
every gait spends.

This pass puts the paws on the ground. It does not give the animal a leg that
bends, and no retarget or solver run against this rig can. The fix is in the
.blend — bend the stifle and the hock in the rest pose and re-bind — and it is
a change to the model, so it is not made here.

## What we get, and what we do not

    Fox_Idle    240f -> Stand
    Fox_Walk     20f -> Walk     hind duty 0.57 — a real walk, the best case here
    Fox_Run      18f -> run      ONE stride per cycle, not our old three
    Fox_Gesture  74f -> graze    muzzle 0.553 -> 0.146, a sniff to the ground

    Trot             -> the retargeted Walk again, played at 1.4x. See TROT_FROM.
    alert            -> KEPT from our .blend. The pack's one Gesture is a graze.

`alert` is the artist's own and is left exactly as it is.
"""

import math
import os
import sys

import bpy
from mathutils import Quaternion, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pack_rig_kit as kit                                  # noqa: E402

SRC_RIG = "Skeleton_Fox"
SRC_ROOT = "Root"
DST_RIG = "Fox_Rig"
DST_ROOT = "root"
DST_BLEND = "fox_reference.blend"

# Pack clip -> the slot `mammals/fox.js` names. The value is the action name
# our .blend must end up carrying, so these are the game's names, not theirs.
CLIPS = {
    "Fox_Idle": "Stand",
    "Fox_Walk": "Walk",
    "Fox_Run": "run",
    "Fox_Gesture": "graze",
}
KEEP = ("alert",)               # ours; the pack ships nothing that fills it

# The pack has no trot — no animal in it does — and our own `Trot` is now the
# only clip on the fox that did not come from this pipeline. It also stopped
# ordering: the retargeted Walk covers 33.5 cm where that Trot covers 16.6, so
# the fox "trotted" slower than it walked and the ladder in `glb_rig` inverted.
#
# So the trot is the retargeted Walk, emitted as its OWN clip and played faster.
# It has to be a separate action rather than a second slot pointing at `Walk`,
# because `mixer.clipAction(clip)` returns the SAME action for the same clip and
# the two slots would then fight over one `timeScale`.
#
# What this buys is a correct ladder and one animator's hand on every gait; what
# it costs is that the trot has a WALK's footfalls (lateral, duty 0.55) played
# at 1.4x rather than a trot's diagonal pairs. Set this to None to keep the
# hand-authored `Trot` instead — it is a genuine diagonal trot, and it then
# needs `rate` above 2.0 in `mammals/fox.js` to outrun the walk.
TROT_FROM = "Walk"

# The correspondence pose: the pack fox STANDING, not the pack fox's bind pose.
# See the module docstring — using the bind pose put the animal on its chest.
REFERENCE = ("Fox_Idle", 1)

# theirs -> ours. Total in both directions; `retarget` asserts it.
BONE_MAP = {
    "Root": "root",
    "spine.004": "pelvis",      # hind legs and the tail hang off this one
    "spine.005": "spine_01",
    "spine.006": "chest",       # ...and the shoulders off this one
    "spine.007": "neck_01",
    "spine.008": "neck_02",
    "spine.009": "head",        # ...and the ears off this one
    "ear.L": "ear.L",
    "ear.R": "ear.R",
    # the brush, running backwards from the pelvis
    "spine.003": "tail_01",
    "spine.002": "tail_02",
    "spine.001": "tail_03",
    "spine": "tail_04",
    "shoulder.L": "scapula.L",
    "front_thigh.L": "fore_upper.L",
    "front_shin.L": "fore_lower.L",
    "front_foot.L": "fore_foot.L",
    "front_toe.L": "fore_toe.L",
    "shoulder.R": "scapula.R",
    "front_thigh.R": "fore_upper.R",
    "front_shin.R": "fore_lower.R",
    "front_foot.R": "fore_foot.R",
    "front_toe.R": "fore_toe.R",
    "thigh.L": "hind_upper.L",
    "shin.L": "hind_lower.L",
    "foot.L": "hind_foot.L",
    "toe.L": "hind_toe.L",
    "thigh.R": "hind_upper.R",
    "shin.R": "hind_lower.R",
    "foot.R": "hind_foot.R",
    "toe.R": "hind_toe.R",
}

CONTACTS = ["fore_toe.L", "fore_toe.R", "hind_toe.L", "hind_toe.R"]
FORE = ["fore_toe.L", "fore_toe.R"]

# The planting pass rotates ONE bone per leg — the pastern — and the paw below
# it rides along rigidly. `ankle` is the bone that turns, `contact` the paw tip
# that has to meet the floor.
PLANT = {
    "fore.L": dict(ankle="fore_foot.L", contact="fore_toe.L", src="front_toe.L"),
    "fore.R": dict(ankle="fore_foot.R", contact="fore_toe.R", src="front_toe.R"),
    "hind.L": dict(ankle="hind_foot.L", contact="hind_toe.L", src="toe.L"),
    "hind.R": dict(ankle="hind_foot.R", contact="hind_toe.R", src="toe.R"),
}
PLANT_BAND = 0.25       # of a paw's own z range; below this it is "down"

# How far the planting pass may DRAG a paw horizontally, as a fraction of the
# pastern. The paw rides a sphere about the ankle, so pitching it down to reach
# the floor also pulls it in or pushes it out — and unbounded, that drag beat
# the real stride: the left hind travelled +0.81 FORWARD through a 6-frame
# plant, a paw skating the wrong way at 0.28 m/s.
#
# Holding the hock straight to lower the ankle was tried first and is WORSE — a
# rigid column swings the ankle UP through the arc, and the shortfalls doubled.
# There is no pose of this leg that both reaches the floor and holds its ground;
# see "the finding this leaves behind".
#
# So the drag is capped and the paw is allowed to stop short. 0 plants nothing
# and never skates; large plants everything and skates. 0.18 buys most of the
# contact for a slide under the ~0.1 u/frame the body itself travels.
PLANT_DRAG = 0.18

# The frame change. See the module docstring.
C = Quaternion((0.0, 0.0, 1.0), math.pi)


# ─────────────────────────────────────────────────────────────────────────────
#  Reading the pack
# ─────────────────────────────────────────────────────────────────────────────

def sample_pack():
    """Every fox clip as rest-relative world rotations, keyed by OUR bone names.

    Runs BEFORE the file is swapped, and returns plain quaternions so nothing
    downstream holds a reference into a .blend that is about to be closed.
    """
    rig = bpy.data.objects[SRC_RIG]
    rig.data.pose_position = 'POSE'                 # the pack ships every rig in REST
    rig.animation_data_create()
    for t in rig.animation_data.nla_tracks:
        t.is_solo = False                           # ...with Idle SOLOED over the rest
    for t in rig.animation_data.nla_tracks:
        t.mute = True

    report_reach(rig, "pack rest", ("front_thigh.L", "front_shin.L", "front_foot.L"),
                 ("thigh.L", "shin.L", "foot.L"))

    dep = bpy.context.evaluated_depsgraph_get()

    # The correspondence pose, read off the clip rather than off the bind pose.
    kit.play(rig, REFERENCE[0])
    bpy.context.scene.frame_set(REFERENCE[1])
    dep.update()
    ref = {b.name: rig.pose.bones[b.name].matrix.to_quaternion()
           for b in rig.data.bones}
    report_reach(rig, f"pack standing ({REFERENCE[0]} f{REFERENCE[1]})",
                 ("front_thigh.L", "front_shin.L", "front_foot.L"),
                 ("thigh.L", "shin.L", "foot.L"))

    out = {}
    for src_name, dst_name in CLIPS.items():
        act = kit.play(rig, src_name)
        f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
        frames, paws = [], {leg: [] for leg in PLANT}
        for f in range(f0, f1):                     # f1 repeats f0; we loop
            bpy.context.scene.frame_set(f)
            dep.update()
            frames.append({
                BONE_MAP[n]: C @ (rig.pose.bones[n].matrix.to_quaternion()
                                  @ q.inverted()) @ C.inverted()
                for n, q in ref.items()
            })
            # WHEN each paw is down is a fact about the artist's clip, and it is
            # only legible here. Read off our own retargeted paws instead it is
            # circular — the retarget is exactly what the planting pass exists
            # to correct — and it read the graze's 83% stance as 14%.
            for leg, L in PLANT.items():
                paws[leg].append(paw_z(rig, L["src"]))
        out[dst_name] = (frames, paws)
        print(f"[sample] {src_name} -> {dst_name}: {len(frames)} frames "
              f"({len(frames) / 24:.3f}s at 24 fps)")
    return out


def report_reach(rig, label, fore, hind):
    """How straight each leg stands at rest. A ratio of 1.0 is a locked leg."""
    for name, chain in (("fore", fore), ("hind", hind)):
        a, b, t = (rig.pose.bones[n].head for n in chain)
        l1, l2 = (b - a).length, (t - b).length
        print(f"[rest] {label} {name}: l1={l1:.4f} l2={l2:.4f} "
              f"extension={(t - a).length / (l1 + l2):.4f}")


# ─────────────────────────────────────────────────────────────────────────────
#  Writing our rig
# ─────────────────────────────────────────────────────────────────────────────

def parent_first(bones):
    order, seen = [], set()

    def visit(b):
        if b.name in seen:
            return
        if b.parent:
            visit(b.parent)
        seen.add(b.name)
        order.append(b.name)

    for b in bones.values():
        visit(b)
    return order


def retarget(rig, clips):
    bones = {b.name: b for b in rig.data.bones}
    assert set(bones) == set(BONE_MAP.values()), (
        f"BONE_MAP does not cover our rig: missing "
        f"{sorted(set(bones) - set(BONE_MAP.values()))}, unknown "
        f"{sorted(set(BONE_MAP.values()) - set(bones))}")

    rest = {n: b.matrix_local.to_quaternion() for n, b in bones.items()}
    order = parent_first(bones)

    def rest_local(n):
        b = bones[n]
        if b.parent:
            return (b.parent.matrix_local.inverted() @ b.matrix_local).to_quaternion()
        return b.matrix_local.to_quaternion()

    # `rotation_mode` belongs to the POSE BONE, not to an action, and this rig
    # mixes 18 quaternion bones with 13 euler ones. Flipping them all to
    # quaternion would silently kill the euler fcurves in the two clips we are
    # keeping, so each bone is written in whatever mode it already wears.
    prev_euler = {}

    def pose(frame_delta):
        world = {}
        for n in order:
            world[n] = rest[n] if n == DST_ROOT else frame_delta[n] @ rest[n]
        for n in order:
            b = bones[n]
            parent = world[b.parent.name] if b.parent else Quaternion((1, 0, 0, 0))
            q = (parent @ rest_local(n)).inverted() @ world[n]
            pb = rig.pose.bones[n]
            if pb.rotation_mode == 'QUATERNION':
                pb.rotation_quaternion = q
            else:
                # `euler_compat` keeps consecutive frames on the same branch;
                # without it a gimbal flip between two frames reads as a limb
                # spinning the long way round, and only in the exported clip.
                pb.rotation_euler = q.to_euler(pb.rotation_mode,
                                               prev_euler.get(n, pb.rotation_euler))
                prev_euler[n] = pb.rotation_euler.copy()
        bpy.context.view_layer.update()

    floor = min(bones[c].tail_local.z for c in CONTACTS)
    geom = plant_rest(rig)
    for name, (frames, paws) in clips.items():
        build(rig, name, frames, paws, order, pose, rest, floor, geom, prev_euler)
    if TROT_FROM:
        frames, paws = clips[TROT_FROM]
        build(rig, "Trot", frames, paws, order, pose, rest, floor, geom, prev_euler)


def plant_rest(rig):
    """How much pastern each leg has to swing — the radius of its reach sphere."""
    kit.clear(rig)
    out = {}
    for leg, L in PLANT.items():
        a = rig.pose.bones[L["ankle"]].head.copy()
        c = paw_pos(rig, L["contact"])
        out[leg] = (c - a).length
        print(f"[plant] {leg}: pastern {out[leg]:.4f} from ankle z {a.z:.4f} "
              f"to paw z {c.z:.4f}")
    return out


def plant_track(zs):
    """How strongly to hold each frame's paw on the floor, 1 down to 0 airborne.

    A paw in the bottom `PLANT_BAND` of its OWN travel is down and is held all
    the way; through a swing the hold eases off and back on, so the authored
    lift arc keeps its shape and nothing pops at the hand-over. A paw that never
    leaves the floor — every frame of an idle — is held for the whole clip.
    """
    n = len(zs)
    lo, hi = min(zs), max(zs)
    band = lo + PLANT_BAND * (hi - lo)
    down = [i for i in range(n) if zs[i] <= band]
    if len(down) == n:
        return [1.0] * n, down
    w = [1.0 if i in set(down) else None for i in range(n)]
    for i in range(n):
        if w[i] is not None:
            continue
        prev = next(j for j in range(1, n + 1) if w[(i - j) % n] is not None)
        nxt = next(j for j in range(1, n + 1) if w[(i + j) % n] is not None)
        # A hump that is 1 at both planted ends and 0 in the middle of the
        # swing: the paw is released as it leaves and caught as it lands.
        u = prev / (prev + nxt)
        w[i] = 1.0 - kit.ease(min(u, 1.0 - u) * 2.0)
    return w, down


def build(rig, name, frames, paws, order, pose, rest, floor, geom, prev_euler):
    """One action: retarget, stand it on its fore legs, then plant the hinds."""
    kit.clear(rig)
    prev_euler.clear()

    # The body is NOT lifted, and that is the second thing this file got wrong.
    # Raising it until no paw penetrated the floor hoisted the whole animal by
    # 13 cm through the walk and 26 cm through the graze, because our fore leg
    # rests at 1.000 and the pack's walk straightens ITS fore past the standing
    # pose — so ours hyperextends and reaches below a floor our rest already
    # stands on. The lift then took the other three paws up with it.
    #
    # With the standing reference the retarget already puts the body at our own
    # rest height in the neutral pose, so height is left to it and the pastern
    # plants the paws in BOTH directions: a paw below the floor is swung up by
    # exactly the same rotation that swings a floating one down.
    low = None
    for d in frames:
        pose(d)
        z = min(paw_z(rig, c) for c in FORE)
        low = z if low is None else min(low, z)
    root_lift = rest[DST_ROOT].inverted() @ Vector((0.0, 0.0, 0.0))

    # Second pass at that height: what the paws do NOW is what planting corrects.
    zs = {leg: [] for leg in PLANT}
    for d in frames:
        pose(d)
        rig.pose.bones[DST_ROOT].location = root_lift
        bpy.context.view_layer.update()
        for leg, L in PLANT.items():
            zs[leg].append(paw_z(rig, L["contact"]))
    weight, short = {}, {}
    for leg in PLANT:
        weight[leg], down = plant_track(paws[leg])
        short[leg] = 0.0
        print(f"[{name}] {leg}: paw z {min(zs[leg]):+.4f}..{max(zs[leg]):+.4f} "
              f"against floor {floor:+.4f}; the source clip has it down on "
              f"{len(down)}/{len(frames)} frames (duty {len(down) / len(frames):.2f})")

    act = kit.new_action(rig, name, len(frames))
    prev_euler.clear()
    for i in range(len(frames) + 1):               # +1 closes the loop on frame 0
        f = i % len(frames)
        pose(frames[f])
        rig.pose.bones[DST_ROOT].location = root_lift
        bpy.context.view_layer.update()
        for leg, L in PLANT.items():
            gap = replant(rig, L, geom[leg], floor, weight[leg][f])
            if weight[leg][f] > 0.99:      # only a STANCE frame owes the floor
                short[leg] = max(short[leg], gap)
        kit.key(rig, order, i, loc={DST_ROOT})
    kit.set_linear(act)
    rig.animation_data.action = None
    kit.clear(rig)

    print(f"[{name}] {len(frames)} frames; lowest fore paw {low:+.4f} against a "
          f"rest contact of {floor:+.4f}"
          + "".join(f"; {leg} out of pastern by {v:.4f}"
                    for leg, v in short.items() if v > 1e-4))
    measure(rig, act, name, weight)


def replant(rig, L, radius, floor, w):
    """Pitch this leg's pastern toward the floor, weighted by `w`.

    The paw tip rides a sphere of `radius` about the ankle, so its height and
    its horizontal reach are ONE degree of freedom, not two: pitching it down to
    meet the floor also pulls it in toward the ankle. Unbounded, that pull is
    larger than the stride and reverses the stance.

    So the drag is capped at `PLANT_DRAG` of the pastern and the shortfall is
    taken vertically. A paw a few mm off the ground reads as a paw on the
    ground; a paw that slides reads as a paw on ice.

    Returns how far above the floor the paw was left.
    """
    if w < 1e-4:
        return 0.0
    pb = rig.pose.bones[L["ankle"]]
    ankle = pb.head.copy()
    v = paw_pos(rig, L["contact"]) - ankle
    h = Vector((v.x, v.y, 0.0))
    if h.length < 1e-5:
        h = Vector((0.0, 1.0, 0.0))             # a paw already pointing down
    want_z = max(floor - ankle.z, -radius)      # the ankle may be out of reach
    flat = math.sqrt(max(radius * radius - want_z * want_z, 0.0))
    # The cap is one-sided. Dropping a floating paw is cosmetic and is worth
    # capping; RAISING one that the retarget drove through the floor is not —
    # a paw inside the terrain is the more obviously broken of the two, and the
    # fore legs hyperextend below our rest plane by up to 2.2 cm in the graze.
    cap = PLANT_DRAG * radius if want_z <= v.z else radius
    flat = min(max(flat, h.length - cap), h.length + cap)
    # Whatever the cap took out of the horizontal comes back as height.
    got_z = -math.sqrt(max(radius * radius - flat * flat, 0.0))
    short = max(0.0, got_z - (floor - ankle.z))
    target = h.normalized() * flat + Vector((0.0, 0.0, got_z))
    q = v.rotation_difference(target)
    if w < 1.0:
        q = Quaternion().slerp(q, w)
    parent = pb.parent
    pw = parent.matrix.to_quaternion() if parent else Quaternion((1, 0, 0, 0))
    rl = ((parent.bone.matrix_local.inverted() @ pb.bone.matrix_local).to_quaternion()
          if parent else pb.bone.matrix_local.to_quaternion())
    set_rotation(pb, (pw @ rl).inverted() @ (q @ pb.matrix.to_quaternion()))
    bpy.context.view_layer.update()
    return short


def set_rotation(pb, q):
    if pb.rotation_mode == 'QUATERNION':
        pb.rotation_quaternion = q
    else:
        pb.rotation_euler = q.to_euler(pb.rotation_mode, pb.rotation_euler)


def paw_pos(rig, contact):
    """The paw TIP in armature space — the toe's tail, not its head."""
    pb = rig.pose.bones[contact]
    return pb.matrix @ Vector((0.0, pb.bone.length, 0.0))


def paw_z(rig, contact):
    return paw_pos(rig, contact).z


def measure(rig, act, name, weight):
    """What the game will read off this clip, plus the one thing it cannot.

    `measureExcursion` reports a paw's absolute range and an absolute range has
    no sign, so a paw travelling the WRONG WAY through its own stance measures
    perfectly. That is checked here instead: through a plant, a paw must move
    backwards (-y), because the animal is moving forwards and the paw is not.
    """
    rows = []
    for i in range(int(act.frame_end)):
        kit.sample(rig, act, i)
        rows.append({leg: paw_pos(rig, L["contact"])
                     for leg, L in PLANT.items()})
    for leg, L in PLANT.items():
        zs = [r[leg].z for r in rows]
        w = weight[leg]
        held = [i for i in range(len(rows)) if w[i] > 0.99]
        line = (f"[{name}]   {L['contact']:12s} z {min(zs):+.4f}..{max(zs):+.4f} "
                f"lift {max(zs) - min(zs):.4f}")
        if held:
            runs, cur = [], [held[0]]
            for i in held[1:]:
                if i == cur[-1] + 1:
                    cur.append(i)
                else:
                    runs.append(cur)
                    cur = [i]
            runs.append(cur)
            run = max(runs, key=len)
            dy = rows[run[-1]][leg].y - rows[run[0]][leg].y
            # A pose clip's paws shuffle a few mm as the animal shifts its
            # weight; only call it skating when it outruns that.
            verdict = ('back' if dy <= 0 else
                       'forward, negligible' if dy < 0.02 * len(run) else
                       'FORWARD — skating')
            line += (f" | plant {len(held)}/{len(rows)} frames, longest run "
                     f"{len(run)}f travels {dy:+.4f} {verdict}")
        print(line)
    rig.animation_data.action = None
    kit.clear(rig)


# ─────────────────────────────────────────────────────────────────────────────

def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = argv[0] if argv else os.path.join(root, "assets", "models",
                                            "fox_packanim.blend")

    clips = sample_pack()                       # BEFORE the file is swapped

    src = os.path.join(root, "assets", "models", DST_BLEND)
    bpy.ops.wm.open_mainfile(filepath=src)
    rig = bpy.data.objects[DST_RIG]
    rig.animation_data_create()
    report_reach(rig, "ours", ("fore_upper.L", "fore_lower.L", "fore_foot.L"),
                 ("hind_upper.L", "hind_lower.L", "hind_foot.L"))

    retarget(rig, clips)

    # The clips we replaced are gone from THIS file by name; the two we keep are
    # the artist's own and were never touched.
    for a in bpy.data.actions:
        a.use_fake_user = True
        a.use_frame_range = True
    have = sorted(a.name for a in bpy.data.actions)
    want = sorted(set(CLIPS.values()) | set(KEEP) | ({"Trot"} if TROT_FROM else set()))
    assert have == want, f"expected clips {want}, found {have}"

    # Lay them out the way every other working .blend in this repo is laid out:
    # one soloable NLA track per clip, so the file can be scrubbed clip by clip.
    if rig.animation_data:
        for t in list(rig.animation_data.nla_tracks):
            rig.animation_data.nla_tracks.remove(t)
    rig.animation_data.action = None
    for act in sorted(bpy.data.actions, key=lambda a: a.name):
        t = rig.animation_data.nla_tracks.new()
        t.name = act.name
        t.strips.new(act.name, int(act.frame_start), act)
        t.is_solo = False

    walk = bpy.data.actions["Walk"]
    kit.frame_view(rig, ["Fox_Reference"], clip="Walk",
                   clip_range=(int(walk.frame_start), int(walk.frame_end)))

    bpy.ops.wm.save_as_mainfile(filepath=out, copy=True)
    print(f"\n[build] saved {out} ({os.path.getsize(out)} bytes); clips "
          + ", ".join(f"{a.name} {int(a.frame_start)}-{int(a.frame_end)}"
                      for a in sorted(bpy.data.actions, key=lambda a: a.name)))


main()
