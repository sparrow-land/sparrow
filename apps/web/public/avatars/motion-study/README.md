# Sparrow motion study assets

Experimental layered raster rig derived from `../sparrow-v2/base-2.webp`. The
original avatar files are unchanged.

## Result

No production-ready body/wing contract is provided. Both built-in generation
attempts returned 1254 x 1254 RGB images with a flattened checkerboard rather
than alpha. The wingless-body edit also changed the source bird's proportions,
head, feet, and tail. Using it would make the supposedly stable parts jump.

`wing-source-extract-candidate.png` is a 256 x 256 RGBA, canvas-aligned,
feather-region extraction from the original source. It is retained for visual
evaluation only; its lower edge cannot be separated confidently from the tail
and breast in the flattened source. Suggested candidate pivot: `(119px, 103px)`,
or `46.484% 40.234%` on the full canvas.

## Provenance

Source: `../sparrow-v2/base-2.webp` (256 x 256). Original files were not changed.

Built-in image generation prompt for the body edit (verbatim):

```text
Use case: precise-object-edit
Asset type: 256x256 transparent animation rig body layer
Input image: Image 1 is the edit target and identity/style reference.
Primary request: create a wingless clean body layer of this exact right-facing compact painterly sparrow by removing ONLY the prominent near-side folded wing (the layered brown-and-tan feather shape spanning roughly x=37..151, y=91..190). Reconstruct the hidden body beneath it as plausible soft cream/tan flank plumage and preserve a natural continuous back and belly silhouette. The far-side anatomy should remain unobtrusive.
Composition/framing: preserve the exact original 256x256 canvas placement, scale, pose, head, eye, beak, breast, tail, legs, feet, and transparent margins pixel-for-pixel as closely as possible.
Style/medium: preserve the original hand-painted digital illustration, fine feather texture, colors, lighting, and edge softness.
Scene/backdrop: genuinely transparent background with alpha, no checkerboard or colored fill.
Constraints: change only the near-side wing region and the tiny newly exposed adjacent body area; keep head/body/feet/tail stable for animation compositing; no text, no shadow, no new objects, no watermark.
Avoid: moving, resizing, rotating, restyling, changing expression, altering the tail or legs, opaque background.
```

Built-in image generation prompt for the wing isolation attempt (verbatim):

```text
Use case: background-extraction
Asset type: isolated 256x256 transparent animation wing layer
Input image: Image 1 is the exact subject, style, and placement reference.
Primary request: isolate ONLY the prominent near-side folded wing from this exact right-facing painterly sparrow: the layered brown, rust, cream, and charcoal feather shape attached near the upper back and tapering down-left. Remove the entire rest of the bird. Preserve the wing's original likeness, painted feather markings, outline, angle, scale, and exact original canvas coordinates.
Composition/framing: output on the same square canvas with the wing located exactly where it appears in Image 1, approximately x=37..151 and y=91..190 when normalized to 256x256. Everything outside the wing must be transparent.
Style/medium: unchanged hand-painted digital illustration from the source.
Scene/backdrop: genuinely transparent alpha; no checkerboard, no white or colored fill.
Constraints: wing only; preserve its root overlap/shoulder feathers so it can rotate naturally around pivot approximately (123,105) on a 256x256 canvas; no body, head, eye, beak, breast, tail, legs, or feet; no text, shadow, watermark.
Avoid: inventing a new wing, spread flight pose, changing colors or markings, moving/resizing/rotating the extracted wing, opaque background.
```

The isolation generation returned a flattened checkerboard and was not used.
