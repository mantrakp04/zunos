#!/usr/bin/env python3
"""Rebuild with: DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib uv run --with pillow --with cairosvg python build_brand.py"""
from io import BytesIO
from pathlib import Path
import ctypes.util
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

_find_library = ctypes.util.find_library
if Path("/opt/homebrew/lib/libcairo.2.dylib").exists():
    ctypes.util.find_library = lambda name: "/opt/homebrew/lib/libcairo.2.dylib" if name in {"cairo", "cairo-2"} else _find_library(name)
import cairosvg
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
subprocess.run(["swift", str(ROOT / "prepare.swift"), str(ROOT)], check=True)
ICONSET = ROOT / "AppIcon.iconset"
ICONSET.mkdir(exist_ok=True)
master = Image.open(ROOT / "app-icon-1024.png").convert("RGBA")
sizes = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2),
         (256, 1), (256, 2), (512, 1), (512, 2)]
for points, scale in sizes:
    suffix = "@2x" if scale == 2 else ""
    name = f"icon_{points}x{points}{suffix}.png"
    # Pillow's RGBA resize filters premultiplied color to avoid dark alpha fringes.
    master.resize((points * scale,) * 2, Image.Resampling.LANCZOS).save(ICONSET / name)
# Supply premultiplied channels only to the converter's two legacy encoders.
# The public PNG iconset remains straight-alpha. Modern ICNS entries are lossless.
with tempfile.TemporaryDirectory(prefix="zunos-compile-") as temp:
    compile_set = Path(temp) / "AppIcon.iconset"
    shutil.copytree(ICONSET, compile_set)
    for size in [16, 32]:
        target = compile_set / f"icon_{size}x{size}.png"
        original = Image.open(target).convert("RGBA")
        encoded = Image.frombytes("RGBA", original.size, original.convert("RGBa").tobytes())
        encoded.save(target)
    subprocess.run(["iconutil", "-c", "icns", str(compile_set), "-o", str(ROOT / "AppIcon.icns")], check=True)

def svg_image(name, width, height, dark=False):
    svg = (ROOT / name).read_text()
    if dark and name == "wordmark.svg":
        # Preview-only reverse lettering. The delivered SVG stays the primary ink color.
        svg = svg.replace('stroke="#402019" stroke-width="13"',
                          'stroke="#FFF2DD" stroke-width="13"')
    return Image.open(BytesIO(cairosvg.svg2png(bytestring=svg.encode(),
                      output_width=width, output_height=height))).convert("RGBA")

def font(size, rounded=False):
    path = "/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf" if rounded else "/System/Library/Fonts/SFNS.ttf"
    return ImageFont.truetype(path, size)

sheet = Image.new("RGB", (2400, 2100), "#FFF8EE")
draw = ImageDraw.Draw(sheet)
draw.rectangle((1200, 0, 2400, 2100), fill="#221B18")
draw.rectangle((0, 0, 2400, 140), fill="#35221B")
draw.text((64, 32), "zunos", font=font(60, True), fill="#FFF0D2")
draw.text((350, 57), "PERSONAL VOICE  /  BRAND ASSETS", font=font(24), fill="#E5BA8C")
draw.text((1870, 57), "ENGLISH · HINDI · GUJARATI", font=font(23), fill="#E5BA8C")

def paste_center(image, x, y, box_w, box_h, max_w=None, max_h=None):
    image = image.copy()
    image.thumbnail((max_w or box_w, max_h or box_h), Image.Resampling.LANCZOS)
    sheet.paste(image, (int(x+(box_w-image.width)/2), int(y+(box_h-image.height)/2)), image)

for column, dark in [(0, False), (1200, True)]:
    ink = "#FFF0D9" if dark else "#402019"
    muted = "#C3A992" if dark else "#866652"
    line = "#49362C" if dark else "#EAD7C1"
    draw.text((column+64, 179), "DARK" if dark else "LIGHT", font=font(21), fill=muted)
    paste_center(Image.open(ROOT / "logo-mark.png"), column+65, 240, 500, 490)
    paste_center(master, column+630, 240, 500, 490)
    draw.text((column+85, 751), "Mascot · transparent · 2048 × 2048", font=font(22), fill=ink)
    draw.text((column+650, 751), "macOS icon · 1024 × 1024", font=font(22), fill=ink)
    draw.line((column+64, 810, column+1136, 810), fill=line, width=2)
    paste_center(svg_image("logo-mark.svg", 280, 280), column+72, 840, 240, 260)
    paste_center(svg_image("wordmark.svg", 775, 210, dark), column+350, 855, 775, 240)
    draw.text((column+85, 1112), "Flat mark · six colors", font=font(22), fill=ink)
    draw.text((column+370, 1112), "Custom rounded wordmark · vector paths", font=font(22), fill=ink)
    draw.line((column+64, 1170, column+1136, 1170), fill=line, width=2)
    draw.text((column+64, 1201), "APPICON.ICONSET  +  APPICON.ICNS", font=font(24), fill=ink)
    for i, (points, scale) in enumerate(sizes):
        suffix = "@2x" if scale == 2 else ""
        image = Image.open(ICONSET / f"icon_{points}x{points}{suffix}.png").convert("RGBA")
        x = column+64+(i % 5)*216
        y = 1270+(i // 5)*258
        physical = points*scale
        display = min(physical, 152)
        paste_center(image, x, y, 208, 166, display, display)
        draw.text((x+12, y+182), f"{points}px{suffix}", font=font(20), fill=ink)
        draw.text((x+12, y+211), f"{physical} × {physical}", font=font(17), fill=muted)
    draw.line((column+64, 1815, column+1136, 1815), fill=line, width=2)
    draw.text((column+64, 1848), "SMALL-SIZE CHECK", font=font(20), fill=muted)
    paste_center(svg_image("logo-mark.svg", 16, 16), column+70, 1907, 40, 32, 16, 16)
    draw.text((column+124, 1910), "16px", font=font(18), fill=muted)
    paste_center(svg_image("logo-mark.svg", 32, 32), column+230, 1907, 40, 32, 32, 32)
    draw.text((column+284, 1910), "32px", font=font(18), fill=muted)
    for i, color in enumerate(["#F34A2D", "#D93428", "#FFE4A1", "#F6A53C", "#402019", "#FFD064"]):
        x=column+480+i*96
        draw.rounded_rectangle((x, 1890, x+64, 1954), radius=18, fill=color, outline=muted)
    draw.text((column+64, 2010), "Original listening mascot · transparent sRGB PNG · font-independent SVG", font=font(20), fill=muted)

sheet.save(ROOT / "preview.png", optimize=True)

# Verify real deliverables and round-trip the actual ICNS container.
assert Image.open(ROOT / "logo-mark.png").size == (2048, 2048)
assert master.size == (1024, 1024)
assert master.getpixel((0, 0))[3] == 0
assert master.getpixel((512, 512))[3] == 255
assert master.getchannel("A").getbbox() == (100, 100, 924, 924)
for points, scale in sizes:
    suffix = "@2x" if scale == 2 else ""
    image = Image.open(ICONSET / f"icon_{points}x{points}{suffix}.png")
    assert image.size == (points*scale, points*scale)
    assert image.mode == "RGBA" and image.getpixel((0, 0))[3] == 0
for name in ["logo-mark.svg", "wordmark.svg"]:
    ET.fromstring((ROOT / name).read_text())
assert len(set(re.findall(r"#[A-Fa-f0-9]{6}", (ROOT / "logo-mark.svg").read_text()))) == 6
with tempfile.TemporaryDirectory(prefix="zunos-icns-") as temp:
    extracted = Path(temp) / "AppIcon.iconset"
    subprocess.run(["iconutil", "-c", "iconset", str(ROOT / "AppIcon.icns"), "-o", str(extracted)], check=True)
    for points, scale in sizes:
        suffix = "@2x" if scale == 2 else ""
        name = f"icon_{points}x{points}{suffix}.png"
        decoded = Image.open(extracted / name).convert("RGBA")
        original = Image.open(ICONSET / name).convert("RGBA")
        assert decoded.size == original.size
        assert decoded.getchannel("A").tobytes() == original.getchannel("A").tobytes()
        if name in {"icon_16x16.png", "icon_32x32.png"}:
            # Legacy encoding quantizes the nearly transparent antialiased fringe.
            from PIL import ImageChops
            for color in ["black", "white"]:
                background = Image.new("RGBA", original.size, color)
                a = Image.alpha_composite(background, decoded).convert("RGB")
                b = Image.alpha_composite(background, original).convert("RGB")
                differences = list(ImageChops.difference(a, b).convert("RGBA").getdata())
                pixels = list(original.getdata())
                assert all(max(delta[:3]) <= (8 if pixel[3] < 32 else 3)
                           for delta, pixel in zip(differences, pixels))
        else:
            assert decoded.tobytes() == original.tobytes()
print("PASS: dimensions, transparent corners, 100px padding, 10 icon sizes, six-color SVG, ICNS alpha and color round-trip")
print(ROOT / "preview.png")
