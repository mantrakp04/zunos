# zunos artwork sources

Created with the built-in imagegen tool. Three independent original mascot concepts were generated. The happy pear-shaped listening bean was selected, then refined for the final mark and app tile. The owner's reference supplied only the warm listening mood. Its character was not traced or upscaled.

Final mark prompt: Preserve the selected plump red-orange pear-shaped bird-like blob, smooth head, no tuft or eyebrows, closed happy crescent eyes, tiny rounded golden bill and smile. An enormous peach-gold cupped ear on the right receives two bold golden sound arcs. Tight glow, smooth satiny 3D shading, clean transparent edges, no text, no background, no Angry Birds resemblance.

Final icon prompt: Place the same mascot inside a macOS rounded square with a warm orange-to-honey-gold gradient. Bright cream-gold ear, soft directional light, breathing room, transparent outside the tile, no text. The generated tile was fitted to an exact 824px silhouette in a 1024px canvas by the native preparation script.

`mascot.png` and `app-tile.png` retain the generated source resolution. `prepare.swift` tightens the faint alpha fringe, lays out the 2048px mark, and enforces icon padding. `build_brand.py` uses Pillow LANCZOS for the iconset, builds the ICNS with iconutil, renders the contact sheet, and checks the outputs. The primary wordmark contains custom path lettering, with no font dependency. Its light lettering on the dark preview is a display-only reverse treatment.

Rebuild from any directory:

```sh
DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib uv run --with pillow --with cairosvg python /Users/barreloflube/voice-data/apps/mac/assets/brand/build_brand.py
```
