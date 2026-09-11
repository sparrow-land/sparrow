# Busy Avatar Atlases

These are derived, identity-matched motion assets. The approved base-1.webp,
base-2.webp and base-3.webp stills in the parent directory are unchanged.

Sources are the generated hover-base-1.png, hover-base-2.png and
hover-sprites-v1.png sheets in ../../motion-study. Exact generation prompts and
source paths are recorded there in hover-variants.md and hover-sprites-v1.md.

Each output is a lossless RGBA WebP, 768 by 768 pixels, containing nine 256px
cells in reading order. Playback is 750ms per cycle, approximately 12fps.

Reproduce from the web package directory using Sharp installed separately:

```sh
SPARROW_SHARP_PATH=/path/to/node_modules/sharp node scripts/prepare-motion-atlases.mjs
```

The script registers each head to the first frame using a fixed head patch,
removes the generated sage background by green excess, then scales each frame
to 218px with padding inside its 256px cell. registration.json records measured
offsets and matching errors. The green key is specific to these warm-colored
sources, not a general background-removal algorithm. Reinspect edges on all
palette colors when replacing source art. Padding cannot restore details
already clipped in a generated source cell.

The generated hover loop and static portrait are different poses. Returning to
idle uses a crossfade; these assets do not contain authored landing frames.
