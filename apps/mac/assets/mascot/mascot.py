"""The zunos listening bean as a real 3D plush model, built and rendered in Blender (Cycles).

Everything is procedural, so the model can be re-rendered from this file alone:

    nice -n 15 blender -b --factory-startup -t 4 -P apps/mac/assets/mascot/mascot.py -- \
        --view hero --size 2048 --samples 512 --out /tmp/zunos-mascot/hero.png

Add --save path.blend to keep the scene. Views are defined in VIEWS below. The render has a
transparent background with a soft contact shadow (shadow catcher) in the alpha channel, ready
to be laid on the app icon tile or used as the transparent logo mark.

Look (after libraries.dev/bots): a plush toy covered in short dense fur with fuzzy edges, matte
fabric shading, a soft key light from the upper left, a back light that makes the fur edges glow,
and simple dark glossy features sitting on top of the fur. Palette and silhouette follow
assets/brand/logo-mark.svg: red-orange pear-shaped body, enormous cream ear with a gold bowl on
the upper right, closed happy eyes, a small golden bill, and gold sound arcs.
"""

import argparse
import math
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

# Colors from logo-mark.svg (sRGB hex). Fur reads darker than its base color, so fur uses lifted tints.
BODY = "#F34A2D"
BODY_FUR = "#FF5A36"
BODY_DEEP = "#D93428"
CHEEK = "#FF7F63"
EAR = "#FFE4A1"
EAR_BOWL = "#F6A53C"
INK = "#402019"
BILL = "#FFD064"
WAVE = "#F8A93A"

# Camera views: azimuth (degrees, + orbits to the viewer's right), elevation (degrees), lens (mm).
VIEWS = {
    "hero": (-12, 9, 85),
    "front": (0, 4, 85),
    "three-quarter": (-30, 10, 85),
    "ear-side": (32, 8, 85),
    "top-down": (-14, 28, 85),
    "profile": (68, 6, 85),
}


def srgb(hex_color, alpha=1.0):
    h = hex_color.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i : i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, alpha)


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def svg_to_world(x, y):
    """logo-mark.svg coordinates (256 box, y down) to world X/Z: body base at z=0, 88 px per unit."""
    return (x - 107.5) / 88.0, (231 - y) / 88.0


# ---------------------------------------------------------------- scene


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    try:
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        scene.cycles.device = "GPU"
    except Exception:
        scene.cycles.device = "CPU"
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 8
    scene.cycles.transparent_max_bounces = 16
    if hasattr(scene, "cycles_curves"):
        scene.cycles_curves.shape = "THICK"
        scene.cycles_curves.subdivisions = 2
    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.62, 0.6, 0.6, 1)
    bg.inputs["Strength"].default_value = 0.35
    return scene


def principled(name, color, roughness=0.6, sheen=0.0, coat=0.0, subsurface=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = srgb(color)
    p.inputs["Roughness"].default_value = roughness
    if sheen:
        p.inputs["Sheen Weight"].default_value = sheen
        p.inputs["Sheen Roughness"].default_value = 0.35
    if coat:
        p.inputs["Coat Weight"].default_value = coat
        p.inputs["Coat Roughness"].default_value = 0.15
    if subsurface:
        p.inputs["Subsurface Weight"].default_value = subsurface
        p.inputs["Subsurface Radius"].default_value = (0.4, 0.15, 0.08)
        p.inputs["Subsurface Scale"].default_value = 0.05
    return m


def fur_material(name, color, tip=None):
    """Fur strands: a diffuse-leaning Principled BSDF with a sheen sheath and a root-to-tip tint."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Roughness"].default_value = 0.55
    p.inputs["Sheen Weight"].default_value = 0.3
    p.inputs["Sheen Roughness"].default_value = 0.4
    p.inputs["Sheen Tint"].default_value = srgb(tip or color)
    p.inputs["Specular IOR Level"].default_value = 0.2
    info = nt.nodes.new("ShaderNodeHairInfo")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    root = Vector(srgb(color)[:3]) * 0.72
    ramp.color_ramp.elements[0].color = (*root, 1)
    ramp.color_ramp.elements[1].color = srgb(tip or color)
    ramp.color_ramp.elements[1].position = 0.75
    noise = nt.nodes.new("ShaderNodeTexWhiteNoise")
    noise.noise_dimensions = "1D"
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 0.12
    nt.links.new(info.outputs["Intercept"], ramp.inputs["Fac"])
    nt.links.new(info.outputs["Random"], noise.inputs["W"])
    nt.links.new(ramp.outputs["Color"], mix.inputs["A"])
    nt.links.new(noise.outputs["Color"], mix.inputs["B"])
    nt.links.new(mix.outputs["Result"], p.inputs["Base Color"])
    return m


def add_fur(obj, name, material, length, count, children=40, group=None, fuzz=1.0):
    obj.data.materials.append(material)
    slot = len(obj.data.materials)
    mod = obj.modifiers.new(name, "PARTICLE_SYSTEM")
    ps = mod.particle_system.settings
    ps.name = name
    ps.type = "HAIR"
    ps.use_advanced_hair = False
    ps.count = count
    ps.hair_step = 5
    ps.render_step = 4
    ps.display_step = 2
    ps.emit_from = "FACE"
    ps.use_even_distribution = True
    ps.distribution = "JIT"
    ps.material_slot = obj.data.materials[slot - 1].name
    ps.child_type = "INTERPOLATED"
    ps.child_percent = 4
    ps.rendered_child_count = children
    ps.child_length = 1.0
    ps.child_length_threshold = 0.35
    ps.clump_factor = 0.08
    ps.clump_shape = 0.3
    ps.roughness_1 = 0.004 * fuzz
    ps.roughness_1_size = 0.6
    ps.roughness_2 = 0.012 * fuzz
    ps.roughness_2_size = 0.4
    ps.roughness_2_threshold = 0.6
    ps.roughness_endpoint = 0.005 * fuzz
    ps.root_radius = 1.0
    ps.tip_radius = 0.15
    ps.radius_scale = 0.0016
    ps.use_close_tip = True
    # Hair length is stored through the normal velocity, so set it after everything else.
    ps.hair_length = length
    # Random velocity is absolute, so keep it a fraction of the normal velocity (a slight tousle).
    ps.factor_random = ps.normal_factor * 0.35 * fuzz
    if group:
        mod.particle_system.vertex_group_density = group
        mod.particle_system.vertex_group_length = group
    return mod


# ---------------------------------------------------------------- geometry


def body_mesh(segments=96, rings=64, seam_back=False):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=1.0)
    body = bpy.context.object
    body.name = "Body"
    if seam_back:
        # Turn the sphere (before shaping) so its UV seam runs down the back, out of sight: a
        # tiling normal map otherwise shows a crease down the face.
        uv = body.data.uv_layers.active.data
        seam = [body.data.vertices[body.data.loops[i].vertex_index].co for i in range(len(uv))
                if uv[i].uv.x < 1e-4 and abs(body.data.vertices[body.data.loops[i].vertex_index].co.z) < 0.9]
        az = math.atan2(sum(v.y for v in seam), sum(v.x for v in seam))
        body.data.transform(Matrix.Rotation(math.pi / 2 - az, 4, "Z"))
    for v in body.data.vertices:
        x, y, z = v.co
        t = (z + 1) / 2  # 0 at the base, 1 at the crown
        # Pear: wide hips, narrower head. Flatten the base so it sits like a plush toy.
        width = 1.13 - 0.36 * t ** 1.4
        if z < -0.35:
            z = -0.35 + (z + 0.35) * 0.62
            width *= 1.0 + 0.10 * smoothstep(-0.35, -0.85, v.co.z)
        x *= width * 1.02
        y *= width * 0.86
        # The crown sits a little left of center; the ear fills the right shoulder.
        x -= 0.10 * t ** 2.2
        # Rest the flattened base on the ground plane (z = 0).
        v.co = Vector((x, y, (z + 0.753) * 0.98))
    bpy.ops.object.shade_smooth()
    sub = body.modifiers.new("Smooth", "SUBSURF")
    sub.levels = 1
    sub.render_levels = 2
    bpy.ops.object.modifier_apply(modifier=sub.name)
    return body


def ear_mesh(segments=96, rings=72):
    """A cupped ear: an ellipsoid whose front is pushed in to a deep bowl, leaving a thick rim."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=1.0)
    ear = bpy.context.object
    ear.name = "Ear"
    rx, ry, rz = 0.43, 0.19, 0.80
    rim = ear.vertex_groups.new(name="rim")
    bowl = ear.vertex_groups.new(name="bowl")
    for v in ear.data.vertices:
        a, b, c = v.co
        # Pear-shaped ear: fuller at the top, narrowing to the lobe.
        top = (c + 1) / 2
        sx = rx * (0.78 + 0.30 * smoothstep(0.0, 0.8, top))
        pos = Vector((a * sx, b * ry, c * rz))
        depth = 0.0
        if b < 0:
            # Bowl centered slightly up and toward the head side.
            u, w = a + 0.10, (c - 0.08) / 0.95
            rr = math.sqrt(u * u + w * w)
            depth = (1 - (rr / 0.80) ** 2) ** 1.6 if rr < 0.80 else 0.0
            front = pos.y
            back = ry * math.sqrt(max(0.0, 1 - a * a - c * c))
            pos.y = min(front + depth * ry * 1.05, back - 0.05 * depth)
        v.co = pos
        bowl.add([v.index], depth, "REPLACE")
        rim.add([v.index], 1.0 - smoothstep(0.02, 0.25, depth), "REPLACE")
    bpy.ops.object.shade_smooth()
    sub = ear.modifiers.new("Smooth", "SUBSURF")
    sub.levels = 1
    sub.render_levels = 1
    bpy.ops.object.modifier_apply(modifier=sub.name)
    cx, cz = svg_to_world(170, 104)
    ear.location = (cx + 0.12, -0.12, cz + 0.12)
    ear.rotation_euler = (math.radians(4), math.radians(-18), math.radians(-14))
    return ear


def ear_curl(ear, lift=0.03):
    """The inner fold (helix curl) as a soft tube in the bowl, like the spiral in the flat mark."""
    pts = []
    for i in range(14):
        t = i / 13
        ang = math.radians(150 - 230 * t)
        r = 0.36 - 0.17 * t
        pts.append(Vector((math.cos(ang) * r * 0.9 - 0.04, -0.02, math.sin(ang) * r * 1.25 + 0.02)))
    curve = tube("EarCurl", pts, 0.055, taper=True)
    curve.parent = ear
    # Sit the curl on the bowl surface (ear local space: bowl faces -Y).
    bvh = bvh_of(ear, local=True)
    spline = curve.data.splines[0]
    for p in spline.points:
        co = Vector(p.co[:3])
        hit = bvh.ray_cast(Vector((co.x, -2.0, co.z)), Vector((0, 1, 0)))
        if hit[0] is not None:
            p.co = (co.x, hit[0].y - lift, co.z, 1)
    return curve


def tube(name, pts, radius, taper=False, resolution=6):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = radius
    cu.bevel_resolution = resolution
    cu.use_fill_caps = True
    sp = cu.splines.new("NURBS")
    sp.points.add(len(pts) - 1)
    for p, co in zip(sp.points, pts):
        p.co = (*co, 1)
    sp.use_endpoint_u = True
    sp.order_u = 4
    sp.resolution_u = 16
    if taper:
        for i, p in enumerate(sp.points):
            t = i / (len(sp.points) - 1)
            p.radius = 0.55 + 0.45 * math.sin(math.pi * min(1.0, t * 1.15))
    else:
        for i, p in enumerate(sp.points):
            t = i / (len(sp.points) - 1)
            p.radius = 0.75 + 0.25 * math.sin(math.pi * t)
    obj = bpy.data.objects.new(name, cu)
    bpy.context.collection.objects.link(obj)
    return obj


def bvh_of(obj, local=False):
    deps = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(deps)
    mesh = ev.to_mesh()
    bm = bmesh.new()
    bm.from_mesh(mesh)
    if not local:
        bm.transform(obj.matrix_world)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    ev.to_mesh_clear()
    return tree


def on_surface(bvh, x, z, lift):
    hit = bvh.ray_cast(Vector((x, -5.0, z)), Vector((0, 1, 0)))
    loc, normal = hit[0], hit[1]
    return loc + normal * lift, normal


def face(body, fur_top=0.06):
    bvh = bvh_of(body)
    parts = []
    # Closed happy eyes: arches from the flat mark, as chunky glossy tubes laid on the fur.
    for (x0, y0), (xc, yc), (x1, y1) in [((59, 105), (67, 93), (75, 107)), ((101, 111), (110, 98), (118, 114))]:
        pts = []
        for i in range(9):
            t = i / 8
            x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * xc + t * t * x1
            y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * yc + t * t * y1
            wx, wz = svg_to_world(x, y)
            p, _ = on_surface(bvh, wx, wz, fur_top)
            pts.append(p)
        eye = tube("Eye", pts, 0.075)
        eye.data.materials.append(principled("Ink", INK, roughness=0.35, coat=0.25))
        parts.append(eye)
    # Small golden bill with a dark open smile beneath it.
    bx, bz = svg_to_world(89, 118)
    loc, n = on_surface(bvh, bx, bz, fur_top * 0.6)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=32, radius=1.0, location=loc)
    bill = bpy.context.object
    bill.name = "Bill"
    bill.scale = (0.19, 0.13, 0.085)
    bpy.ops.object.shade_smooth()
    bill.data.materials.append(principled("Bill", BILL, roughness=0.42, sheen=0.4, subsurface=0.15))
    # Orient so the bill pokes out of the face along the surface normal.
    bill.rotation_euler = (math.radians(-8), math.radians(-8), math.radians(-14))
    parts.append(bill)
    mx, mz = svg_to_world(89, 126)
    loc, n = on_surface(bvh, mx, mz, fur_top * 0.3)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=24, radius=1.0, location=loc)
    mouth = bpy.context.object
    mouth.name = "Mouth"
    mouth.scale = (0.12, 0.05, 0.075)
    mouth.rotation_euler = (0, math.radians(-8), math.radians(-14))
    bpy.ops.object.shade_smooth()
    mouth.data.materials.append(principled("Mouth", INK, roughness=0.35))
    parts.append(mouth)
    return parts


def waves():
    cx, cz = svg_to_world(185, 74)
    objs = []
    for i, (r, a0, a1) in enumerate([(0.42, 52, -18), (0.66, 56, -24), (0.90, 58, -28)]):
        pts = []
        for k in range(10):
            t = k / 9
            ang = math.radians(a0 + (a1 - a0) * t)
            pts.append(Vector((cx + 0.10 + math.cos(ang) * r, 0.05 + 0.10 * math.sin(math.pi * t), cz + math.sin(ang) * r)))
        w = tube(f"Wave{i + 1}", pts, 0.062)
        objs.append(w)
    return objs


def to_mesh(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.convert(target="MESH")
    return bpy.context.object


def cheek_group(body):
    g = body.vertex_groups.new(name="cheek")
    rest = body.vertex_groups.new(name="rest")
    centers = [Vector(svg_to_world(52, 140)), Vector(svg_to_world(128, 146))]
    for v in body.data.vertices:
        co = body.matrix_world @ v.co
        w = 0.0
        if co.y < 0:
            for c in centers:
                d = math.hypot((co.x - c.x) / 0.17, (co.z - c.y) / 0.11)
                w = max(w, 0.8 * (1 - smoothstep(0.2, 1.0, d)))
        g.add([v.index], w, "REPLACE")
        rest.add([v.index], 1 - w * 0.85, "REPLACE")


def build():
    body = body_mesh()
    body.data.materials.append(principled("BodySkin", BODY_DEEP, roughness=0.85))
    cheek_group(body)
    add_fur(body, "BodyFur", fur_material("BodyFur", BODY_FUR, tip="#FF6D45"), 0.06, 12000, children=110, group="rest")
    add_fur(body, "CheekFur", fur_material("CheekFur", CHEEK, tip="#FF9C80"), 0.05, 700, children=60, group="cheek")
    ear = ear_mesh()
    ear.data.materials.append(principled("EarSkin", "#E9B25E", roughness=0.85))
    add_fur(ear, "EarFur", fur_material("EarFur", EAR, tip="#FFF4D6"), 0.045, 3500, children=50, group="rim")
    add_fur(ear, "BowlFur", fur_material("BowlFur", EAR_BOWL, tip="#FFB84A"), 0.032, 2600, children=50, group="bowl", fuzz=0.6)
    curl = to_mesh(ear_curl(ear))
    curl.data.materials.append(principled("CurlSkin", "#E9B25E", roughness=0.85))
    add_fur(curl, "CurlFur", fur_material("CurlFur", EAR, tip="#FFF4D6"), 0.03, 900, children=40, fuzz=0.6)
    for w in waves():
        m = to_mesh(w)
        m.data.materials.append(principled("WaveSkin", "#D9862A", roughness=0.85))
        add_fur(m, "WaveFur", fur_material("WaveFur", WAVE, tip="#FFC867"), 0.032, 1200, children=40, fuzz=0.7)
    face(body)
    return body


def lights():
    def area(name, loc, size, power, color=(1, 1, 1), target=(0, 0, 1.0)):
        d = bpy.data.lights.new(name, "AREA")
        d.shape = "DISK"
        d.size = size
        d.energy = power
        d.color = color
        o = bpy.data.objects.new(name, d)
        bpy.context.collection.objects.link(o)
        o.location = loc
        o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        return o

    area("Key", (-3.2, -4.2, 4.6), 4.5, 1100, (1.0, 0.97, 0.93))
    area("Fill", (4.0, -3.6, 2.2), 4.0, 650, (0.93, 0.96, 1.0))
    area("Rim", (1.8, 4.5, 4.2), 3.0, 1600, (1.0, 0.95, 0.9))
    area("Top", (0, 0, 6.5), 5.0, 300)


def ground():
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0.0))
    g = bpy.context.object
    g.name = "ShadowCatcher"
    g.is_shadow_catcher = True
    return g


def frame_camera(view, size):
    az, el, lens = VIEWS[view]
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("Camera")
    cam_data.lens = lens
    cam = bpy.data.objects.new("Camera", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    target = Vector((0.18, 0.0, 1.2))
    direction = Vector((math.sin(math.radians(az)) * math.cos(math.radians(el)),
                        -math.cos(math.radians(az)) * math.cos(math.radians(el)),
                        math.sin(math.radians(el))))
    # Distance so the subject (about 3.2 units across with waves) fills ~84% of the frame.
    sensor = cam_data.sensor_width
    span = 3.25
    dist = span / 0.84 / (sensor / lens)
    cam.location = target + direction * dist
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    return cam


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--view", default="hero", choices=sorted(VIEWS))
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--samples", type=int, default=256)
    ap.add_argument("--out", default="/tmp/zunos-mascot/render.png")
    ap.add_argument("--save", default=None)
    args = ap.parse_args(argv)
    scene = reset()
    build()
    lights()
    ground()
    frame_camera(args.view, args.size)
    scene.cycles.samples = args.samples
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "16"
    scene.render.filepath = args.out
    if args.save:
        bpy.ops.wm.save_as_mainfile(filepath=args.save)
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
