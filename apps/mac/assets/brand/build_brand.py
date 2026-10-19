#!/usr/bin/env python3
"""Builds every zunos logo and icon from the mascot stills in sources/ (captured by capture.cjs).

    DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib uv run --with pillow --with cairosvg python build_brand.py

Writes the macOS icon (1024 master, iconset, ICNS, the Xcode AppIcon set), Expo's icon, splash and
favicon, the transparent logo mark (PNG and a flat SVG), the app's logo-256, and preview.png.
"""
from pathlib import Path
import ctypes.util
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

_find_library = ctypes.util.find_library
if Path("/opt/homebrew/lib/libcairo.2.dylib").exists():
    ctypes.util.find_library = lambda name: "/opt/homebrew/lib/libcairo.2.dylib" if name in {"cairo", "cairo-2"} else _find_library(name)
import cairosvg
from io import BytesIO
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent
APP = ROOT.parent.parent
ICONSET = ROOT / "AppIcon.iconset"
XCODE = APP / "macos/zunos-macOS/Assets.xcassets/AppIcon.appiconset"
SIZES = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)]

# The mascot's colours (src/dom/Mascot.tsx) and the app's warm dark surface.
BODY, EAR, BOWL, INK = "#FF5A36", "#FFE4A1", "#F6A53C", "#231A2C"
TILE_TOP, TILE_BOTTOM = (64, 38, 28), (27, 18, 15)


def trimmed(name):
    im = Image.open(ROOT / "sources" / name).convert("RGBA")
    return im.crop(im.getchannel("A").getbbox())


def fit(im, w, h):
    k = min(w / im.width, h / im.height)
    return im.resize((round(im.width * k), round(im.height * k)), Image.Resampling.LANCZOS)


def squircle_mask(size, box, n=5.0, ss=4):
    """macOS Big Sur's continuous-corner tile: a superellipse inside `box`, supersampled."""
    x0, y0, x1, y1 = (v * ss for v in box)
    big = Image.new("L", (size * ss, size * ss), 0)
    cx, cy, a, b = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
    pts = []
    import math
    for i in range(720):
        t = i / 720 * 2 * math.pi
        c, s = math.cos(t), math.sin(t)
        pts.append((cx + a * (abs(c) ** (2 / n)) * (1 if c >= 0 else -1), cy + b * (abs(s) ** (2 / n)) * (1 if s >= 0 else -1)))
    ImageDraw.Draw(big).polygon(pts, fill=255)
    return big.resize((size, size), Image.Resampling.LANCZOS)


def tile(art, art_width, size=1024, inset=100, lift=0.0, shadow=True, bleed=False):
    """The app icon: the mascot on a warm dark squircle, macOS icon grid (824 tile in 1024).
    `bleed`: an opaque full square instead, for the asset catalog, where macOS 26 applies its own
    mask (art that brings its own shape and padding gets set in a grey platter there)."""
    S = size
    box = (inset, inset, S - inset, S - inset)
    mask = Image.new("L", (S, S), 255) if bleed else squircle_mask(S, box)
    shadow = shadow and not bleed
    bg = Image.new("RGB", (S, S))
    d = ImageDraw.Draw(bg)
    for y in range(S):
        t = y / (S - 1)
        d.line([(0, y), (S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TILE_TOP, TILE_BOTTOM)))
    # a warm glow behind the mascot, like the light in the dictation dial
    glow = Image.new("L", (S, S), 0)
    r = S * 0.34
    ImageDraw.Draw(glow).ellipse((S / 2 - r, S * 0.47 - r, S / 2 + r, S * 0.47 + r), fill=120)
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.09))
    bg = Image.composite(Image.new("RGB", (S, S), (246, 140, 60)), bg, glow.point(lambda v: int(v * 0.45)))
    tile_im = bg.convert("RGBA")
    tile_im.putalpha(mask)
    # a hairline of light along the top edge
    edge = Image.new("L", (S, S), 0) if bleed else ImageChops.subtract(mask, squircle_mask(S, (inset, inset + max(1, S // 340), S - inset, S - inset)))
    tile_im = Image.alpha_composite(tile_im, Image.merge("RGBA", (*[Image.new("L", (S, S), 255)] * 3, edge.point(lambda v: v * 40 // 255))))
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    if shadow:
        sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        sh.putalpha(mask.point(lambda v: v * 110 // 255))
        sh = sh.filter(ImageFilter.GaussianBlur(S * 0.022))
        out.alpha_composite(sh, (0, round(S * 0.012)))
    out.alpha_composite(tile_im)
    m = fit(art, art_width, art_width)
    x = (S - m.width) // 2
    y = round((S - m.height) / 2 + S * lift)
    # contact shade under the body
    cs = Image.new("L", (S, S), 0)
    bw = m.width * 0.5
    ImageDraw.Draw(cs).ellipse((x + m.width * 0.04, y + m.height * 0.9, x + m.width * 0.04 + bw, y + m.height * 1.0), fill=150)
    cs = ImageChops.multiply(cs.filter(ImageFilter.GaussianBlur(S * 0.018)), mask)
    out.alpha_composite(Image.merge("RGBA", (*[Image.new("L", (S, S), 0)] * 3, cs.point(lambda v: v * 0.55))))
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    layer.alpha_composite(m, (x, y))
    out.alpha_composite(Image.composite(layer, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask))
    return out


def canvas(art, size, width_frac):
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    m = fit(art, round(size * width_frac), round(size * width_frac))
    out.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
    return out


plush = trimmed("mascot.png")
flat_full = Image.open(ROOT / "sources/mascot-flat.png").convert("RGBA")
# The sound arcs start at x 104 of the mascot's 100-unit box (left edge at a quarter of its size,
# captured 700 px wide at 2x): at 16 and 32 px they only blur, so the smallest icons go without.
flat = flat_full.crop((0, 0, round(1400 * (0.25 + 1.02)), flat_full.height))
flat = flat.crop(flat.getchannel("A").getbbox())

master = tile(plush, 640, lift=0.01)
master.save(ROOT / "app-icon-1024.png")
small = tile(flat, 700, shadow=False, inset=100)  # 16/32 px: flat colours, no arcs, bigger in the tile
# The asset catalog gets full-bleed squares at the same scale (art sized against the 824 tile).
master_bleed = tile(plush, round(640 * 1024 / 824), bleed=True, lift=0.012)
small_bleed = tile(flat, round(700 * 1024 / 824), bleed=True)

ICONSET.mkdir(exist_ok=True)
for points, scale in SIZES:
    px = points * scale
    src = small if px <= 32 else master
    name = f"icon_{points}x{points}{'@2x' if scale == 2 else ''}.png"
    src.resize((px, px), Image.Resampling.LANCZOS).save(ICONSET / name)
    (small_bleed if px <= 32 else master_bleed).resize((px, px), Image.Resampling.LANCZOS).convert("RGB").save(XCODE / name)
subprocess.run(["iconutil", "-c", "icns", str(ICONSET), "-o", str(ROOT / "AppIcon.icns")], check=True)

master_bleed.convert("RGB").save(APP / "assets/icon.png")  # Expo wants an opaque square; the OS masks it
canvas(plush, 1024, 0.8).save(APP / "assets/splash-icon.png")
small.resize((48, 48), Image.Resampling.LANCZOS).save(APP / "assets/favicon.png")
canvas(plush, 2048, 0.86).save(ROOT / "logo-mark.png")
canvas(plush, 256, 0.92).save(APP / "src/dom/assets/logo-256.png")

# The flat mark: the same outlines as the mascot (src/dom/Mascot.tsx), its face and sound arcs.
LOGO_SVG = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -4 136 104" width="136" height="104">
  <path fill="{EAR}" d="M84 5C96 5 101 18 100 33C99 48 93 62 82 65C74 67 67 61 66 53C65 46 70 41 71 33C72 23 71 5 84 5Z"/>
  <path fill="{BOWL}" d="M84 13C91 13 94.5 24 94 34C93.5 44 89 53 82 54.5C77 55.5 74.5 51 75.5 47C76.5 43 78.5 40 78.5 34C78.5 26 77 13 84 13Z"/>
  <path fill="{BODY}" d="M42 15C27 15 18 30 13 47C8 64 4 79 8 88C12 96 26 97 43 97C60 97 75 96 79 88C83 79 79 64 74 48C69 30 57 15 42 15Z"/>
  <ellipse fill="{INK}" cx="38" cy="45" rx="5" ry="6.5"/>
  <ellipse fill="{INK}" cx="56" cy="45" rx="5" ry="6.5"/>
  <path fill="none" stroke="{INK}" stroke-width="3.4" stroke-linecap="round" d="M40 58Q47 63.5 54 58"/>
  <g fill="none" stroke="{BOWL}" stroke-width="4.6" stroke-linecap="round">
    <path d="M104 22Q113 32 110 46"/>
    <path d="M111 12Q125 30 119 54"/>
  </g>
</svg>
"""
(ROOT / "logo-mark.svg").write_text(LOGO_SVG)


def svg_image(name, width, height):
    return Image.open(BytesIO(cairosvg.svg2png(bytestring=(ROOT / name).read_text().encode(),
                      output_width=width, output_height=height))).convert("RGBA")


# Contact sheet: every deliverable on the app's dark surface and on a light one.
font = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", 22)
sheet = Image.new("RGB", (2400, 1180), "#FFF8EE")
draw = ImageDraw.Draw(sheet)
draw.rectangle((1200, 0, 2400, 1180), fill="#1C1513")
for col, dark in [(0, False), (1200, True)]:
    ink = "#FFF0D9" if dark else "#402019"

    def paste(im, x, y, w, h):
        im = fit(im, w, h) if im.width > w or im.height > h else im
        sheet.paste(im, (col + x + (w - im.width) // 2, y + (h - im.height) // 2), im)

    paste(master, 40, 40, 420, 420)
    paste(Image.open(ROOT / "logo-mark.png"), 480, 40, 380, 420)
    paste(svg_image("logo-mark.svg", 272, 208), 880, 120, 280, 260)
    draw.text((col + 60, 470), "app icon · 1024", font=font, fill=ink)
    draw.text((col + 520, 470), "logo mark · 2048", font=font, fill=ink)
    draw.text((col + 900, 470), "flat mark · svg", font=font, fill=ink)
    x = 40
    for points, scale in SIZES:
        im = Image.open(ICONSET / f"icon_{points}x{points}{'@2x' if scale == 2 else ''}.png")
        w = min(im.width, 200)
        paste(im, x, 560 + (200 - w), w, w)
        draw.text((col + x, 780), f"{points * scale}", font=font, fill=ink)
        x += w + 16 if w > 32 else 52
        if x > 1000:
            break
    for i, px in enumerate([16, 32, 48, 64]):
        paste(Image.open(ICONSET / "icon_512x512@2x.png").resize((px, px), Image.Resampling.LANCZOS) if px > 32 else
              Image.open(ICONSET / f"icon_{px}x{px}.png"), 60 + i * 110, 900, 80, 80)
        draw.text((col + 70 + i * 110, 1000), f"{px}px", font=font, fill=ink)
sheet.save(ROOT / "preview.png", optimize=True)

# Checks: sizes, transparent corners, an opaque tile, the ICNS round trip, a valid SVG.
assert master.size == (1024, 1024) and master.getpixel((0, 0))[3] == 0 and master.getpixel((512, 512))[3] == 255
assert Image.open(ROOT / "logo-mark.png").size == (2048, 2048)
for points, scale in SIZES:
    im = Image.open(ICONSET / f"icon_{points}x{points}{'@2x' if scale == 2 else ''}.png")
    assert im.size == (points * scale,) * 2 and im.mode == "RGBA" and im.getpixel((0, 0))[3] == 0
ET.fromstring(LOGO_SVG)
with tempfile.TemporaryDirectory(prefix="zunos-icns-") as temp:
    out = Path(temp) / "AppIcon.iconset"
    subprocess.run(["iconutil", "-c", "iconset", str(ROOT / "AppIcon.icns"), "-o", str(out)], check=True)
    assert sorted(p.name for p in out.iterdir()) == sorted(p.name for p in ICONSET.iterdir())
print("PASS", ROOT / "preview.png")
