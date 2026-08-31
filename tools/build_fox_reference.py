"""Generate the first stylized fox reference asset in Blender.

Run from Blender's Python console with:
exec(compile(open('/Users/sean/htdocs/procedural-fall/tools/build_fox_reference.py').read(), '/Users/sean/htdocs/procedural-fall/tools/build_fox_reference.py', 'exec'))
"""

import bpy
import math
import sys
from mathutils import Vector


BLEND_PATH = "/Users/sean/htdocs/procedural-fall/assets/models/fox_reference.blend"
GLB_PATH = "/Users/sean/htdocs/procedural-fall/public/models/fox_reference.glb"
RENDER_PATH = "/tmp/fox_reference.png"


# ─── DO NOT RUN THIS AGAINST THE CURRENT ASSET ───────────────────────────────
# This script rebuilds the fox from scratch: it deletes every object in the
# scene first. It does NOT reproduce the shipped asset: that was rigged and
# animated in a live Blender session (Fox_Rig, 31 bones, six clips) and the
# session was never captured back into code, so the rig and every clip exist
# nowhere but inside the .blend. Re-running this would destroy all of it, and
# the flat-shaded blue-bellied mesh it produces is two art passes behind.
#
# That gap is a debt, not a decision, and it has already cost a round: when the
# fox's gaits turned out to need the same ground-solving the bear's did, the
# bear could be regenerated from scratch a dozen times in an afternoon and the
# fox could not be touched with confidence. Compare `build_bear_reference.py`,
# which IS the bear's source of truth. See the `import-animal` skill.
#
# It is kept because it is the record of how the silhouette was derived. To
# rebuild the fox from zero on purpose, pass --force.
if "--force" not in sys.argv:
    for _ob in bpy.data.objects:
        if _ob.type == 'ARMATURE':
            raise SystemExit(
                "Refusing to run: this scene is rigged (%s). Re-running would delete "
                "the rig and both animation clips. Pass --force if that is genuinely "
                "what you want." % _ob.name)


def material(name, color, roughness=0.7):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1.0)
    mat.use_nodes = True
    principled = mat.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = (*color, 1.0)
    principled.inputs["Roughness"].default_value = roughness
    return mat


RUSSET = material("Fox russet", (0.46, 0.085, 0.020))
BELLY_BLUE = material("Fox blue-gray belly", (0.13, 0.30, 0.40))
TAIL_WHITE = material("Fox white tail tip", (0.88, 0.83, 0.68))
CHARCOAL = material("Fox charcoal", (0.025, 0.018, 0.015))
EYE = material("Fox eye", (0.006, 0.004, 0.003), 0.24)
GROUND = material("Presentation ground", (0.055, 0.065, 0.05))


def uv(name, location, scale, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, location=location, rotation=rotation)
    ob = bpy.context.object
    ob.name = name
    ob.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return ob


def cone(name, location, radius1, radius2, depth, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(vertices=14, radius1=radius1, radius2=radius2, depth=depth,
                                   location=location, rotation=rotation)
    ob = bpy.context.object
    ob.name = name
    return ob


def aim(ob, target):
    ob.rotation_euler = (Vector(target) - ob.location).to_track_quat('-Z', 'Y').to_euler()


def add_area(name, location, energy, size, color):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.shape = 'DISK'
    data.size = size
    data.color = color
    ob = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(ob)
    ob.location = location
    aim(ob, (0, 0, 1.05))
    return ob


# Start from a known, empty asset scene. The user may have left Blender in Edit
# mode, where object-level deletion and export operators are unavailable.
if bpy.context.object and bpy.context.object.mode != 'OBJECT':
    bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
for datablocks in (bpy.data.meshes, bpy.data.curves, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
    pass

# The volumes deliberately overlap before remeshing: the finished animal is one
# continuous silhouette rather than a collection of disconnected primitives.
parts = []
parts.append(uv("Fox body", (0, -0.08, 1.38), (0.57, 1.06, 0.53)))
parts.append(uv("Fox chest", (0, 0.45, 1.51), (0.50, 0.59, 0.61)))
parts.append(uv("Fox neck", (0, 0.66, 1.72), (0.35, 0.40, 0.48), (math.radians(-16), 0, 0)))
parts.append(uv("Fox head", (0, 0.91, 1.94), (0.47, 0.46, 0.42)))
parts.append(uv("Fox muzzle", (0, 1.28, 1.79), (0.29, 0.38, 0.20), (math.radians(10), 0, 0)))
parts.append(uv("Fox nose volume", (0, 1.57, 1.76), (0.15, 0.13, 0.11)))

# Long pointed ears, thickened at the root so they survive the fused remesh.
parts.append(cone("Fox left ear", (-0.27, 0.82, 2.42), 0.23, 0.018, 0.78,
                  (math.radians(-8), math.radians(-6), math.radians(-7))))
parts.append(cone("Fox right ear", (0.27, 0.82, 2.42), 0.23, 0.018, 0.78,
                  (math.radians(-8), math.radians(6), math.radians(7))))

# Four narrow, planted legs. They reach into the torso volumes so all joins are seamless.
for x, y, label in ((-0.34, 0.48, "front left"), (0.34, 0.48, "front right"),
                    (-0.37, -0.57, "rear left"), (0.37, -0.57, "rear right")):
    parts.append(uv("Fox %s upper leg" % label, (x, y, 0.94), (0.17, 0.18, 0.66)))
    parts.append(uv("Fox %s lower leg" % label, (x, y + 0.015, 0.38), (0.13, 0.14, 0.45)))
    parts.append(uv("Fox %s paw" % label, (x, y + 0.09, 0.07), (0.16, 0.23, 0.10)))

# A three-volume brush makes a big, soft low-poly tail that still has a readable pale tip.
parts.append(uv("Fox tail base", (0, -1.00, 1.30), (0.40, 0.65, 0.34), (math.radians(-12), 0, 0)))
parts.append(uv("Fox tail brush", (0, -1.72, 1.22), (0.49, 0.98, 0.39), (math.radians(-8), 0, 0)))
parts.append(uv("Fox tail tip", (0, -2.50, 1.20), (0.38, 0.62, 0.30), (math.radians(-4), 0, 0)))

for ob in parts:
    ob.data.materials.append(RUSSET)
    ob.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
fox = bpy.context.object
fox.name = "Fox_Reference"

# Fuse overlapping anatomy into a single organic low-poly mesh, then reduce it
# enough to retain intentional facets akin to the video reference.
remesh = fox.modifiers.new("Fused organic silhouette", 'REMESH')
remesh.mode = 'VOXEL'
remesh.voxel_size = 0.052
remesh.use_smooth_shade = False
bpy.context.view_layer.objects.active = fox
bpy.ops.object.modifier_apply(modifier=remesh.name)

decimate = fox.modifiers.new("Intentional low-poly facets", 'DECIMATE')
decimate.ratio = 0.43
bpy.ops.object.modifier_apply(modifier=decimate.name)

# Joining the source volumes can leave duplicate material slots. Remove those
# slots before assigning colours so the polygon indices below remain reliable.
fox.data.materials.clear()
fox.data.materials.append(RUSSET)
fox.data.materials.append(BELLY_BLUE)
fox.data.materials.append(TAIL_WHITE)
fox.data.materials.append(CHARCOAL)
for poly in fox.data.polygons:
    poly.use_smooth = False
    # Mesh polygon centres are local to the fox object, while the coat-region
    # thresholds below are authored in scene/world coordinates.
    center = fox.matrix_world @ poly.center
    # Match the video reference: rust-orange upper coat; a cool blue-gray
    # throat/belly; black nose, stockings and ear tips; white tail tip.
    # Keep the black nose compact. The reference has a cool throat colour
    # running directly beneath the jaw instead of a black muzzle or chin/collar.
    if center.z > 2.62 or center.z < 0.46 or (center.y > 1.62 and 1.64 < center.z < 1.94):
        poly.material_index = 3
    elif center.y < -2.18:
        poly.material_index = 2
    elif ((center.z < 1.22 and center.y > -0.24)
          or (center.y > 0.16 and center.z < 1.58)
          or (center.y > 0.66 and center.z < 1.78)):
        poly.material_index = 1
    else:
        poly.material_index = 0

# Small separate eyes give the character a clear focal point without breaking
# the fused silhouette of the body.
eyes = []
for x in (-0.275, 0.275):
    eye = uv("Fox eye", (x, 1.265, 2.035), (0.045, 0.032, 0.040))
    eye.data.materials.append(EYE)
    eyes.append(eye)

# Simple presentation scene and a neutral ground for immediate inspection.
bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, -0.035))
ground = bpy.context.object
ground.name = "Presentation Ground"
ground.data.materials.append(GROUND)

camera_data = bpy.data.cameras.new("Fox presentation camera")
camera = bpy.data.objects.new("Fox presentation camera", camera_data)
bpy.context.collection.objects.link(camera)
camera.location = (5.8, 4.6, 3.1)
camera.data.lens = 54
aim(camera, (0, -0.32, 1.25))

add_area("Fox key", (3.5, 3.8, 5.0), 850, 4.0, (1.0, 0.82, 0.68))
add_area("Fox fill", (-4.0, 1.0, 2.8), 480, 3.5, (0.35, 0.50, 1.0))
add_area("Fox rim", (0, -4.0, 4.2), 720, 3.0, (1.0, 0.20, 0.06))

scene = bpy.context.scene
scene.camera = camera
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 720
scene.render.resolution_y = 720
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = RENDER_PATH
scene.world.color = (0.012, 0.016, 0.022)
try:
    scene.view_settings.look = 'AgX - Medium High Contrast'
except Exception:
    pass

# Save the editable source and a compact Three.js-ready glTF binary. Export only
# the fox mesh and eye meshes, never the presentation plane/lights/camera.
bpy.ops.object.select_all(action='DESELECT')
fox.select_set(True)
for eye in eyes:
    eye.select_set(True)
bpy.context.view_layer.objects.active = fox
bpy.ops.wm.save_as_mainfile(filepath=BLEND_PATH)
bpy.ops.export_scene.gltf(filepath=GLB_PATH, export_format='GLB', use_selection=True,
                          export_materials='EXPORT', export_apply=True)

bpy.ops.object.select_all(action='DESELECT')
fox.select_set(True)
for eye in eyes:
    eye.select_set(True)
bpy.context.view_layer.objects.active = fox
bpy.ops.render.render(write_still=True)

print("FOX_REFERENCE_COMPLETE", BLEND_PATH, GLB_PATH, RENDER_PATH, "faces=", len(fox.data.polygons))
