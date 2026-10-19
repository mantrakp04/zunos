"""Real-time version of the mascot: the same model as mascot.py, as a small GLB with morph targets.

    blender -b --factory-startup -P apps/mac/assets/mascot/export_glb.py -- --out /tmp/zunos-mascot/zunos-raw.glb

build_glb.sh then compresses it (meshopt + WebP) into apps/mac/src/dom/assets/mascot/.

Fur doesn't survive a real-time budget, so the plush look comes from a velvet material instead:
sheen (KHR_materials_sheen), a tiling fur normal map, and albedo baked into vertex colors
(cheek blush, a darker base, and ambient occlusion baked in Cycles).

Node tree (glTF, +Y up, the face looks down +Z, origin on the ground under the body):

    Bean                    root; scale it for breathing and squash/stretch
      Body
      Face
        EyeL, EyeR          morph "close" (0 open, 0.5 half, 1 closed lid)
        EyesHappy           the ^ ^ eyes from the icon (hidden by default)
        Bill
        Mouth               morphs "yawn", "o"
      EarPivot              at the ear root; rotate it for small wiggles
        Ear                 morphs "perk", "droop"
      Waves
        Wave1, Wave2, Wave3
"""

import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mascot as m  # noqa: E402


def empty(name, parent=None, location=(0, 0, 0)):
    o = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(o)
    o.location = location
    if parent:
        o.parent = parent
    bpy.context.view_layer.update()
    return o


def parent_keep(child, parent):
    bpy.context.view_layer.update()
    world = child.matrix_world.copy()
    child.parent = parent
    child.matrix_world = world


def apply_transform(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def set_origin(obj, point):
    """Move obj's origin to a world point without moving its geometry."""
    offset = obj.matrix_world.inverted() @ Vector(point)
    obj.data.transform(Matrix.Translation(-offset))
    obj.matrix_world = obj.matrix_world @ Matrix.Translation(offset)


# ---------------------------------------------------------------- textures and materials


def fur_normal_map(size=256):
    """A tiling normal map of short, mostly vertical strands (filtered noise), for velvet."""
    rng = np.random.default_rng(7)
    noise = rng.standard_normal((size, size))
    fy = np.fft.fftfreq(size)[:, None]
    fx = np.fft.fftfreq(size)[None, :]
    # Anisotropic low-pass: longer along v than u, so it reads as fibres.
    spectrum = np.exp(-((fx / 0.16) ** 2 + (fy / 0.06) ** 2))
    h = np.real(np.fft.ifft2(np.fft.fft2(noise) * spectrum))
    h = (h - h.mean()) / (h.std() + 1e-6)
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    strength = 0.9
    n = np.stack([-dx * strength, -dy * strength, np.ones_like(h)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    rgba = np.concatenate([n * 0.5 + 0.5, np.ones((size, size, 1))], -1).astype(np.float32)
    img = bpy.data.images.new("FurNormal", size, size, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(rgba.ravel())
    img.file_format = "PNG"
    img.pack()
    return img


def velvet(name, sheen_hex, normal_img=None, roughness=0.82, vertex_color=True, base_hex="#FFFFFF"):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Roughness"].default_value = roughness
    p.inputs["Sheen Weight"].default_value = 1.0
    p.inputs["Sheen Roughness"].default_value = 0.45
    p.inputs["Sheen Tint"].default_value = m.srgb(sheen_hex)
    p.inputs["Specular IOR Level"].default_value = 0.25
    if vertex_color:
        attr = nt.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "Col"
        nt.links.new(attr.outputs["Color"], p.inputs["Base Color"])
    else:
        p.inputs["Base Color"].default_value = m.srgb(base_hex)
    if normal_img is not None:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = normal_img
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nmap.inputs["Strength"].default_value = 0.6
        nt.links.new(tex.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], p.inputs["Normal"])
    return mat


def glossy(name, hex_color, roughness=0.3, coat=0.0):
    return m.principled(name, hex_color, roughness=roughness, coat=coat)


# ---------------------------------------------------------------- parts


def open_eye(name, bvh, sx, sy):
    """A dark glossy oval with a catchlight, and a "close" shape key that folds it into a lid line."""
    x, z = m.svg_to_world(sx, sy)
    hit, n = m.on_surface(bvh, x, z, 0.0)
    rx, ry, rz = 0.085, 0.045, 0.102
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=20, radius=1.0)
    eye = bpy.context.object
    eye.name = name
    unit = [v.co.copy() for v in eye.data.vertices]
    for v, u in zip(eye.data.vertices, unit):
        v.co = Vector((u.x * rx, u.y * ry, u.z * rz))
    # Catchlight: a small white sphere up and to the right, on the front of the oval.
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=1.0)
    glint = bpy.context.object
    glint_unit = [v.co.copy() for v in glint.data.vertices]
    gc = Vector((rx * 0.32, -ry * 0.78, rz * 0.38))
    for v, u in zip(glint.data.vertices, glint_unit):
        v.co = gc + u * 0.024
    eye.data.materials.append(glossy("EyeInk", m.INK, roughness=0.22, coat=0.5))
    glint.data.materials.append(m.principled("EyeGlint", "#FFFFFF", roughness=0.4))
    n_eye = len(eye.data.vertices)
    bpy.ops.object.select_all(action="DESELECT")
    glint.select_set(True)
    eye.select_set(True)
    bpy.context.view_layer.objects.active = eye
    bpy.ops.object.join()
    bpy.ops.object.shade_smooth()
    eye.shape_key_add(name="Basis")
    close = eye.shape_key_add(name="close")
    for i, u in enumerate(unit):
        # A thin downward-bowed lid line (sleepy closed eye), slightly wider than the open eye.
        cz = rz * (-0.32 + 0.42 * u.x * u.x)
        close.data[i].co = Vector((u.x * rx * 1.12, u.y * ry * 0.7, cz + u.z * rz * 0.13))
    for j, u in enumerate(glint_unit):
        close.data[n_eye + j].co = Vector((0, ry * 0.2, rz * -0.2)) + u * 0.002
    # Sit the eye on the face, half sunk into the surface, facing along the normal.
    eye.rotation_euler = Vector((0, -1, 0)).rotation_difference(n).to_euler()
    eye.location = hit + n * 0.012
    return eye


def mouth(bvh):
    x, z = m.svg_to_world(89, 125)
    hit, n = m.on_surface(bvh, x, z, 0.0)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=20, radius=1.0)
    mo = bpy.context.object
    mo.name = "Mouth"
    unit = [v.co.copy() for v in mo.data.vertices]

    def shape(sx, sy, sz, dz):
        return [Vector((u.x * sx, u.y * sy, u.z * sz + dz)) for u in unit]

    for v, co in zip(mo.data.vertices, shape(0.085, 0.045, 0.042, 0.0)):
        v.co = co
    bpy.ops.object.shade_smooth()
    mo.data.materials.append(glossy("MouthInk", "#4A1A14", roughness=0.4))
    mo.shape_key_add(name="Basis")
    for name, params in [("yawn", (0.11, 0.05, 0.15, -0.085)), ("o", (0.055, 0.05, 0.062, -0.02))]:
        key = mo.shape_key_add(name=name)
        for d, co in zip(key.data, shape(*params)):
            d.co = co
    mo.rotation_euler = Vector((0, -1, 0)).rotation_difference(n).to_euler()
    mo.location = hit + n * 0.004
    return mo


def ear_with_morphs(normal_img):
    ear = m.ear_mesh(segments=36, rings=28)
    curl = m.to_mesh(m.ear_curl(ear, lift=0.0))
    # Ear vertex groups drive the two materials: cream rim, gold bowl.
    bowl = ear.vertex_groups["bowl"]
    ear.data.materials.append(velvet("EarRim", "#FFF6DD", normal_img))
    ear.data.materials.append(velvet("EarBowl", "#FFD27A", normal_img))
    weights = {}
    for v in ear.data.vertices:
        for g in v.groups:
            if g.group == bowl.index:
                weights[v.index] = g.weight
    for poly in ear.data.polygons:
        w = sum(weights.get(i, 0.0) for i in poly.vertices) / len(poly.vertices)
        poly.material_index = 1 if w > 0.25 else 0
    curl.data.materials.clear()
    curl.data.materials.append(ear.data.materials[0])
    apply_transform(ear)
    apply_transform(curl)
    bpy.ops.object.select_all(action="DESELECT")
    curl.select_set(True)
    ear.select_set(True)
    bpy.context.view_layer.objects.active = ear
    bpy.ops.object.join()
    bpy.ops.object.shade_smooth()
    return ear


def ear_root(ear):
    """Where the ear meets the head: the lowest, innermost part of the ear (world space)."""
    pts = [ear.matrix_world @ v.co for v in ear.data.vertices]
    low = min(p.z for p in pts)
    near = [p for p in pts if p.z < low + 0.35]
    return sum(near, Vector()) / len(near)


def add_ear_keys(ear, pivot):
    ear.shape_key_add(name="Basis")
    base = [v.co.copy() for v in ear.data.vertices]
    piv = ear.matrix_world.inverted() @ pivot

    def rotated(rot, scale=1.0):
        return [piv + rot @ ((co - piv) * scale) for co in base]

    # Perk: stand taller and turn the bowl toward the viewer. Droop: flop out and down.
    perk = Matrix.Rotation(math.radians(14), 3, "Y") @ Matrix.Rotation(math.radians(-10), 3, "Z")
    droop = Matrix.Rotation(math.radians(-38), 3, "Y") @ Matrix.Rotation(math.radians(12), 3, "X")
    for name, cos in [("perk", rotated(perk, 1.06)), ("droop", rotated(droop, 0.97))]:
        key = ear.shape_key_add(name=name)
        for d, co in zip(key.data, cos):
            d.co = co


# ---------------------------------------------------------------- vertex colors


def bake_ao(objs, samples=64):
    scene = bpy.context.scene
    scene.cycles.samples = samples
    scene.render.bake.target = "VERTEX_COLORS"
    for o in objs:
        if "ao" not in o.data.color_attributes:
            o.data.color_attributes.new("ao", "FLOAT_COLOR", "POINT")
        o.data.color_attributes.active_color = o.data.color_attributes["ao"]
    for o in objs:
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")


def paint(obj, fn, ao_strength=0.55):
    """Write the final albedo into the "Col" attribute: fn(index, world_pos) * mixed ambient occlusion."""
    ao = obj.data.color_attributes.get("ao")
    col = obj.data.color_attributes.new("Col", "BYTE_COLOR", "POINT")
    mw = obj.matrix_world
    for i, v in enumerate(obj.data.vertices):
        base = fn(i, mw @ v.co)
        occ = ao.data[i].color[0] if ao else 1.0
        k = 1 - ao_strength + ao_strength * occ
        col.data[i].color = (base[0] * k, base[1] * k, base[2] * k, 1)
    obj.data.color_attributes.active_color = col
    obj.data.color_attributes.render_color_index = obj.data.color_attributes.find("Col")
    if ao:
        obj.data.color_attributes.remove(ao)


def body_albedo(_i, p):
    base = Vector(m.srgb("#FF5634")[:3])
    deep = Vector(m.srgb(m.BODY_DEEP)[:3])
    cheek = Vector(m.srgb("#FF8466")[:3])
    t = m.smoothstep(0.05, 0.75, p.z)
    c = deep.lerp(base, t)
    for sx, sy in [(52, 140), (128, 146)]:
        cx, cz = m.svg_to_world(sx, sy)
        if p.y < 0:
            d = math.hypot((p.x - cx) / 0.17, (p.z - cz) / 0.11)
            c = c.lerp(cheek, 0.75 * (1 - m.smoothstep(0.2, 1.0, d)))
    return c


def flat(hex_color):
    c = Vector(m.srgb(hex_color)[:3])
    return lambda _i, _p: c


def ear_albedo(obj):
    rim = Vector(m.srgb(m.EAR)[:3])
    bowl = Vector(m.srgb(m.EAR_BOWL)[:3])
    # Color by material: faces using the bowl material get gold; rim and curl get cream.
    idx = {}
    for poly in obj.data.polygons:
        for vi in poly.vertices:
            idx[vi] = max(idx.get(vi, 0), poly.material_index)
    return lambda i, _p: bowl if idx.get(i, 0) == 1 else rim


# ---------------------------------------------------------------- export


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    out = argv[argv.index("--out") + 1] if "--out" in argv else "/tmp/zunos-mascot/zunos-raw.glb"
    m.reset()
    normal_img = fur_normal_map()

    body = m.body_mesh(segments=40, rings=28, seam_back=True)
    body.vertex_groups.clear()
    body.data.materials.append(velvet("Body", "#FF9A70", normal_img))

    ear = ear_with_morphs(normal_img)

    bvh = m.bvh_of(body)
    happy = [o for o in m.face(body, fur_top=0.03) if o.name.startswith("Eye")]
    # face() also adds a bill and mouth for the render; rebuild them for the real-time rig.
    for o in list(bpy.data.objects):
        if o.name.startswith(("Bill", "Mouth")):
            bpy.data.objects.remove(o)
    for o in happy:
        o.data.bevel_resolution = 3
        o.data.splines[0].resolution_u = 8
    happy_mesh = [m.to_mesh(o) for o in happy]
    bpy.ops.object.select_all(action="DESELECT")
    for o in happy_mesh:
        o.select_set(True)
    bpy.context.view_layer.objects.active = happy_mesh[0]
    bpy.ops.object.join()
    eyes_happy = bpy.context.object
    eyes_happy.name = "EyesHappy"

    eye_l = open_eye("EyeL", bvh, 67, 103)
    eye_r = open_eye("EyeR", bvh, 109, 108)

    bx, bz = m.svg_to_world(89, 117)
    hit, n = m.on_surface(bvh, bx, bz, 0.012)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=20, radius=1.0, location=hit)
    bill = bpy.context.object
    bill.name = "Bill"
    bill.scale = (0.18, 0.12, 0.08)
    bill.rotation_euler = (math.radians(-8), math.radians(-8), math.radians(-14))
    bpy.ops.object.shade_smooth()
    bill.data.materials.append(velvet("Bill", "#FFF0B0", None, roughness=0.5, vertex_color=False, base_hex=m.BILL))
    mo = mouth(bvh)

    waves = []
    for w in m.waves():
        w.data.bevel_resolution = 3
        wm = m.to_mesh(w)
        wm.data.materials.append(velvet("Wave", "#FFD27A", normal_img))
        waves.append(wm)

    # Bake ambient occlusion with everything in place, then write albedo into vertex colors.
    for o in [body, ear, *waves]:
        apply_transform(o)
    bake_ao([body, ear, *waves])
    paint(body, body_albedo)
    paint(ear, ear_albedo(ear), ao_strength=0.6)
    for w in waves:
        paint(w, flat(m.WAVE), ao_strength=0.3)

    # Rig: empties with meaningful pivots.
    root = empty("Bean")
    parent_keep(body, root)
    face_node = empty("Face", root, location=Vector((m.svg_to_world(89, 110)[0], -0.6, m.svg_to_world(89, 110)[1])))
    for o in [eye_l, eye_r, eyes_happy, bill, mo]:
        parent_keep(o, face_node)
    pivot = ear_root(ear)
    ear_pivot = empty("EarPivot", root, location=pivot)
    add_ear_keys(ear, pivot)
    parent_keep(ear, ear_pivot)
    cx, cz = m.svg_to_world(185, 74)
    waves_node = empty("Waves", root, location=(cx, 0.0, cz))
    for i, w in enumerate(waves):
        w.name = f"Wave{i + 1}"
        set_origin(w, (cx, 0.0, cz))
        parent_keep(w, waves_node)

    for o in bpy.data.objects:
        if o.type in {"LIGHT", "CAMERA"}:
            bpy.data.objects.remove(o)

    for o in bpy.data.objects:
        if o.type == "MESH":
            o.data.name = o.name
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_morph=True,
        export_morph_normal=True,
        export_normals=True,
        export_tangents=False,
        export_vertex_color="MATERIAL",
        export_extras=False,
        export_image_format="AUTO",
    )
    print("EXPORTED", out)


if __name__ == "__main__":
    main()
