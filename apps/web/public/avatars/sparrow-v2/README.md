# Sparrow avatar bases v2

Three transparent, single-pose raster bases for the avatar compositing prototype.
They are complete birds, not independently alignable body-part layers.

| File | Pose | Dimensions | Alpha | Bytes |
| --- | --- | --- | --- | ---: |
| `base-1.webp` | Round front / three-quarter | 256 x 256 RGBA | Lossless WebP, genuine transparency | 47,266 |
| `base-2.webp` | Compact right-facing side profile | 256 x 256 RGBA | Lossless WebP, genuine transparency | 38,846 |
| `base-3.webp` | Three-quarter with left wing raised | 256 x 256 RGBA | Lossless WebP, genuine transparency | 52,760 |

Untouched 1254 x 1254 RGBA source PNGs are retained in `source/`. The WebP
delivery assets were resized with Sharp using Lanczos3 and encoded losslessly.

## Sources

- Approved concept sheet: `/home/jake/.codex/generated_images/01a0877b-b953-7512-b654-fc0d2f6a52fc/exec-fda1f93f-5e73-42f3-ac09-a8c213f5527e.png`
- Brand routing reference: `/tmp/sparrow-brand-routing.webp`
- Brand hero reference: `/tmp/sparrow-brand-hero.webp`
- Generator: built-in `image_gen`

## Exact prompts

### base-1

```text
Use case: stylized-concept
Asset type: production avatar base image, designed to remain readable at 24px
Primary request: Generate exactly one round, expressive house sparrow in a front-facing three-quarter pose. Use Image 1 as the approved character concept and Images 2-3 only as references for the Sparrow brand's luminous hand-painted storybook style and warm natural palette.
Scene/backdrop: genuine transparent background with a clean alpha channel; no colored square, halo, shadow, scenery, branch, ground, or backdrop.
Subject: one full-body compact sparrow with an appealing oversized rounded head, very large dark glossy eyes, a tiny dark beak, bold charcoal bib, bright cream cheeks, warm chestnut cap and wing, plump cream belly, tiny feet. Give it a friendly, curious expression.
Style/medium: polished painterly gouache/watercolor illustration, soft but high-contrast shapes, fewer and broader feather marks than the concept sheet, crisp silhouette, recognizable at favicon scale.
Composition/framing: square canvas; bird fills roughly 78% of canvas height; full body and every feather/foot comfortably inside with generous transparent padding. Head centered in upper-middle. Keep lower-right perimeter especially clear for a presence badge. Three-quarter front view, body mostly upright, wings folded.
Constraints: exactly one bird; genuine transparency; no text, props, badge, icon, border, frame, environment, perch, cast shadow, or watermark. Do not create a sprite sheet. Strong simple facial features and silhouette suitable at 24px.
```

### base-2

```text
Use case: stylized-concept
Asset type: production avatar base image, readable at 24px
Primary request: Generate exactly one compact expressive house sparrow in a clean side-profile pose, facing right. Use Image 1 as the approved character concept and Images 2-3 only for the Sparrow brand's luminous hand-painted storybook style and warm natural palette.
Scene/backdrop: genuine transparent background with clean alpha; no scenery, branch, ground, square, halo, or shadow.
Subject: one full-body plump sparrow with oversized rounded head, one very large visible dark glossy eye, tiny pointed dark beak, bold charcoal bib, bright cream cheek, warm chestnut cap and wing, compact cream belly, tiny feet. Friendly alert expression. Folded wing and short tail.
Style/medium: polished painterly gouache/watercolor; broad confident brush shapes, fewer feather details than the approved concept, strong readable value blocks, crisp silhouette.
Composition/framing: square canvas; bird fills about 74% height and 76% width; full body/feet/tail comfortably inside transparent padding. Head in upper-middle. Reserve generous empty transparent space at the lower-right perimeter for a presence badge. Pure side profile, compact stance.
Constraints: exactly one bird; genuine transparency; no text, props, badge, icon, border, frame, environment, perch, cast shadow, or watermark. Do not create a sprite sheet. Favor simple shapes and clear facial markings at tiny size.
```

### base-3

```text
Use case: stylized-concept
Asset type: production avatar base image, readable at 24px
Primary request: Generate exactly one round expressive house sparrow in a lively three-quarter pose with one wing slightly raised in a small friendly wave. Use Image 1 as the approved character concept and Images 2-3 only for Sparrow brand luminous hand-painted storybook style and warm natural palette.
Scene/backdrop: genuine transparent background with clean alpha; no scenery, branch, ground, square, halo, or shadow.
Subject: one full-body plump sparrow with oversized rounded head, two large dark glossy eyes, tiny dark beak, bold charcoal bib, bright cream cheeks, warm chestnut cap and wing, cream belly, tiny feet. Friendly energetic expression. One wing raised modestly beside the body, clearly attached and anatomically coherent; other wing folded.
Style/medium: polished painterly gouache/watercolor; broad confident brush shapes, fewer feather details than concept, strong value blocks, crisp silhouette. Raised wing should be simple, with only 5-7 broad feather groupings.
Composition/framing: square canvas; bird fills about 78% height; every wingtip, foot and tail comfortably inside generous transparent padding. Head centered upper-middle. Keep the lower-right perimeter free for a presence badge; raised wing should extend toward upper-left, not lower-right.
Constraints: exactly one bird; genuine transparency; no detached parts; no text, props, badge, icon, border, frame, environment, perch, cast shadow, or watermark. Do not create a sprite sheet. This is a single base pose, not an independently compositable wing layer.
```

The untouched generated originals remain under
`/home/jake/.codex/generated_images/01a08d52-6610-7b82-acff-63f5a44a3f2b/`.
