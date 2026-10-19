# zunos artwork sources

The mascot is drawn by the app itself: `src/dom/Mascot.tsx` renders it with
[bot-avatars](https://libraries.dev/bots) (MIT), a plush red-orange bean with a cupped cream ear and
a gold bowl, stacked as three avatars that share one rig. The stills here are captured from
`src/preview/IconLab.tsx` in WebKit at 2x on a transparent background, so the icons match the app:

- `mascot.png`: fabric (plush) shading with two sound arcs; the app icon, logo mark, splash and logo-256.
- `mascot-flat.png`: flat shading; the 16 and 32 px icons, without the arcs.

Recapture (Metro running on port 8090) and rebuild every asset:

```sh
cd /tmp && npm i playwright && npx playwright install webkit
NODE_PATH=/tmp/node_modules node /Users/barreloflube/voice-data/apps/mac/assets/brand/capture.cjs
DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib uv run --with pillow --with cairosvg python /Users/barreloflube/voice-data/apps/mac/assets/brand/build_brand.py
```

`build_brand.py` lays the mascot on a warm dark Big Sur squircle (824 px tile in 1024) for the iconset,
the ICNS and `app-icon-1024.png`. The Xcode AppIcon set and Expo's `icon.png` get the same art as opaque
full-bleed squares: macOS 26 masks those itself, and sets shaped icons in a grey platter. It also writes Expo's splash and favicon, the transparent logo mark,
the flat SVG mark (the same outlines as `Mascot.tsx`), `src/dom/assets/logo-256.png` and `preview.png`.
