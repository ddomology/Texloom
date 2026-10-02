# Texloom consumer integration audit

Audit date: 2026-10-02. Read-only inspection of sibling repositories:
`Chalkspace` at HEAD `a077f3b`, `Lemniro` at HEAD `3d12f73`. Line references below
refer to the inspected working files; consumers were not edited by this audit.
Recommendations are future integration work unless explicitly described as
existing behavior.

## Findings in brief

- Chalkspace already samples rendering by absolute time, and exposes useful
  capture methods. Its actual playback still calls a closure-local renderer;
  replacing a property on `window.chalkspace` cannot install a universal hook.
- Reusing `ChalkBoardSurface` proves reuse of the real board material. Drawing
  Texloom paths onto its canvas proves a second geometry consumer. Neither alone
  constitutes integration with the lecture scheduler, chalk stroke inference,
  eraser masks, effects audio, or cached video exporter.
- Lemniro owns document layout and CSS. Its compiled-note HTML intentionally
  rejects executable embeds, so an animated figure needs an explicit component
  and manifest boundary instead of inline scripts emitted from TeX.
- A common evaluator and explicit local-time/placement contract can serve both
  consumers without forcing them to share their presentation materials.

## 1. Exact Chalkspace APIs and coordinate system

### Board surface

`Chalkspace/src/chalkspace/web/board-surface.js:136` defines:

```js
const surface = ChalkBoardSurface.create({ background, seed });
surface.draw(ctx, cameraY, zoom, frameWidth, frameHeight);
```

It does **not** accept the lesson plan as a special API. `draw` is the only
returned method (lines 148–164). The board tile is seeded once, patterns are
cached per context, lighting by canvas dimensions. It saves/restores context
state, places the grain in board coordinates and the lighting in screen
coordinates (lines 137–160). `ChalkMaterials.create` delegates its `drawBoard`
method to this implementation (`web/materials.js:70–72`, `:120`).

### Board-world coordinates

The runtime uses frame width/height `fw`/`fh` in board units and
`zoom = canvas.width / fw` (`web/runtime.js:18–19`, `:251`). For a board-world
point `(x,y)`, its screen position is:

```text
screenX = zoom * (x + fw/2)
screenY = zoom * (y - cameraY + fh/2)
```

The same transformation is used by the board material (`board-surface.js:156`)
and rows (`runtime.js:207–220`). The board is centered horizontally. Board `y`
increases downwards, and `cameraY` is the world y-coordinate at the viewport
center. The initial camera is `fh/2` (`compiler.py:222`), so board y=0 starts at
the top edge; after a pan, it is no longer the viewport's top edge. The legacy
camera moves vertically (`runtime.js:29–33`).

Current lesson settings enforce 16:9 (`schema.py:19–38`). `setSize(w,h)` itself
does not enforce that ratio (`runtime.js:344`). A new adapter should either
retain the ratio or define letterboxing; independently choosing arbitrary w/h
while keeping width-based zoom changes the visible board extent.

### Mapping a Texloom viewport into the board

Existing `Texloom/adapters/chalkspace.ts` defines x as the horizontal placement
center and y as the placed rectangle's top in board-world coordinates. For a
Texloom viewport W×H and a requested board width `bw`:

```text
s = bw/W
localToBoard = [s, 0, 0, s, centerX - bw/2, topY]
heightInBoardUnits = s*H
```

The full order for visible scene geometry should be:

```text
screenFromBoard * localToBoard * texloomCamera * sceneWorldTransform
```

Texloom's camera is a pan offset from its viewport center plus zoom and rotation
(`Texloom/src/render-svg.ts:199–204`). Chalkspace's `cameraY` is an absolute
board-world center. They must not be assigned to one another. Treat the embedded
scene camera and host board camera as two deliberate layers, or explicitly
disable one; do not apply the same camera twice.

## 2. One time source and prepared clip sampling

Existing Chalkspace methods (`web/runtime.js:338–345`):

- `render(t, options)` draws an absolute lesson time and updates DOM controls.
- `seek(t)` pauses playback, renders and synchronizes audio.
- `setSize(w,h)` resizes and clears row/material caches, then renders.
- `frameKey(t)` allows static video frames to be reused.
- `getState()` calls render again; it is not a side-effect-free state getter.

Browser playback calls the closure-local `render` from its animation loop at
`:337`; controls also reference that closure at `:333–336`. An external wrapper
on `window.chalkspace.render` affects external calls, but cannot intercept those
internal calls. A future consumer integration should install a documented render
stage hook or refactor runtime ownership rather than patch the global property.

**Recommended clip contract:**

```text
prepare(bundle, assets, consumerCapabilities) -> preparedClip
sample(lessonTime, clipTiming) -> evaluatedFrame
draw(ctx, evaluatedFrame, placement, hostFrame) -> no timing/audio side effects
```

Preparation should finish asset loading and validation before capture readiness.
Local scene time is computed once from a declared clip start, offset and rate;
define end behavior (`hold`, `hide`, or an explicit loop policy). Pass that same
time to every visual consumer. A clip must not create another requestAnimationFrame
loop inside Chalkspace. Keep the parent lesson's clock and narrator authoritative.
Seek tests should include negative/beyond-end requests, exact boundaries,
backwards order, duplicate times and playback-rate changes.

## 3. Clipping and compositing are integration requirements

The inspected render order is:

1. Board texture/background (`runtime.js:252–258`).
2. Writable-area clip (`:259–260`).
3. Rows and per-object erasure/residue (`:274`, `:207–218`).
4. Flying copy and highlight (`:275–290`).
5. Chalk/eraser/dust tool graphics (`:292–314`).
6. Debug guides, then restore the writable-area clip (`:315–316`).
7. Header/caption gradients, text and shelf (`:317–321`).

The writable-area rectangle starts at `0.72*zoom` and has height
`canvas.height-1.98*zoom` (`:260`). It is a **screen-space** clip, applied before
individual board-world object transforms. An embedded Texloom scene needs this
outer host clip, its placement viewport clip, and its own nested clips in the
correct order. It should not cover captions/shelf or paint outside the board
writing area when the board scrolls.

The first useful hook can draw a clip before the foreground tools, under the
host writable clip. A later scene-wide layer order is needed when Texloom
objects must interleave with ordinary rows, annotations and physical copies.

Canvas group opacity needs isolated compositing when children overlap. Simply
multiplying every child's alpha gives a different result from SVG group alpha.
The new Canvas consumer should isolate such groups, preserve nested clip and
paint order, and restore transform/alpha/composite state before returning to
Chalkspace. Shared geometry/timing equality does not imply exact cross-renderer
pixel equality at antialiased edges; define tolerances separately.

## 4. Erasing a live scene is more than drawing an eraser above it

Legacy erasure rebuilds the original row surface, applies a mask, draws residue,
and then composites the remaining ink (`runtime.js:196–218`). The mask uses
`destination-out` on that isolated surface (`web/tools.js:194–200`). Tool graphics
are drawn later. Thus it erases the target row without cutting holes through the
board texture or unrelated objects.

For Texloom, choose explicit semantics before integrating:

- **Erase a frozen illustration:** sample at erase start, then mask that frozen
  content. Straightforward and closest to wiping a drawn board object.
- **Erase a live viewport:** evaluate geometry at each time, then apply the
  cumulative mask in declared board or clip coordinates. Newly moving geometry
  may re-enter cleared regions; this needs an intentional policy.
- **Remove a scene:** opacity/visibility transition, distinct from material
  erasure.

Do not run `destination-out` against the fully composited board canvas. Retain
an offscreen clip surface, then combine its erasure mask before composition.
Reverse seeking should reconstruct the mask from time, not replay destructive
canvas edits from the preceding frame.

## 5. Video cache invalidation is a correctness gate

`runtime.js:339–342` returns a changing-frame marker only while a legacy event
is active. Otherwise its key includes completed event count and caption chunk.
The exporter (`src/chalkspace/video.py:57–68`) reuses the previous encoded image
when that key repeats and does not call render again.

An external animation that is absent from `plan.events` will therefore be frozen
by that optimization during otherwise idle lecture intervals. Adding a visual
hook without changing this cache contract can make interactive preview appear
correct while exported MP4 is wrong.

**Required integration:** combine the host key with every clip's evaluated
content key, or conservatively return `null` while any clip can change. The key
must account for local time/sampling, effective camera, placement, viewport
dimensions, resource revisions, quality, style and erasure state. Do not round
continuous time to an arbitrary bucket that drops animation frames. A first
correct implementation can disable static reuse for active clips, then optimize
only with proven hold intervals.

Asset caches and frame caches differ. Cache immutable paths by resource hash;
cache rasterizations by resource/style/scale; cache a complete frame only when
all time-dependent inputs are equal. `setSize` already clears legacy row caches
(`runtime.js:344`); it will also need to invalidate new clip surfaces.

## 6. Sound has one owner

Chalkspace preview audio is managed independently from frame drawing by
`syncAudio` (`runtime.js:325–338`); explicit seeks pause playback. Export disables
audio in the capture document (`video.py:29`) and assembles narration/effects
after the video pass (`:80–97`). This is an appropriate separation to retain.

Effects preparation asks the actual stroke planner for contact events
(`effects.py:26–67`), then generates deterministic samples with seeded variation
(`:72–94`). Chalk tool motion is sampled from cached data without previous-frame
state (`web/tools.js:127–145`).

Texloom frame evaluation and Canvas drawing must not start audio. If a future
Texloom reveal is to make chalk sounds, expose a deterministic contact/cue track
and let the lesson audio layer schedule or bake it. Otherwise every export seek,
browser repaint, or comparison preview could retrigger sound. Until the stroke
and contact model is shared, a moving vector scene on a chalk board must not be
described as fully integrated chalk writing.

## 7. Lemniro integration boundary

Lemniro is a static Next.js export (`next.config.mjs:2–6`). Articles place compiled
CSS and HTML inside the reader (`src/components/article.tsx:28–31`), and its
document adapter rejects scripts/iframes/objects/embeds in compiled note HTML
(`scripts/tex-document.ts:29–38`). Keep that boundary.

`Entry` currently has compiled HTML, visual records, source/PDF paths, and an
optional YouTube ID; there is no Texloom scene manifest slot
(`src/lib/content-types.ts:4–37`). The `TexVisual` contract describes static
inline math, display math or diagrams, with logical geometry in **TeX points**
(`src/lib/tex-visual-types.ts:1–17`). Texloom uses bp. Convert explicitly:

```text
bp = texPt * 72/72.27
texPt = bp * 72.27/72
```

**Recommended first integration:**

1. Build a Texloom artifact alongside notes; publish its content-hashed bundle,
   player module, poster, source and optional MP4 under an explicit assets path.
2. Add scene-reference metadata or a validated figure placeholder. A dedicated
   React component renders a static, accessible poster and activates playback
   on demand. It should honor the site's asset/base path (`src/lib/site.ts:10`).
3. Keep paragraphs, theorem boxes, CSS typography and reference anchors owned
   by Lemniro. An animated figure is an embedded visual, not a replacement for
   the document's semantic HTML.
4. Use independent SVG ID namespaces when multiple figures occur on one page;
   Lemniro's existing visual adapter already does this for static figures
   (`docs/tex-rendering.md:58–61`). Preserve captions/text alternatives and offer
   a static fallback before loading the animation runtime.
5. For figures using external binary resources, resolve all asset URLs through
   the manifest; do not assume root `/` on GitHub Pages. Preserve a no-JavaScript
   poster and make loading/error states explicit.

Existing Texloom `renderLemniroFigure` and `renderLemniroPlayer` are reusable
output helpers, not proof that the Lemniro publishing pipeline consumes a bundle
today. A separately hosted iframe is feasible when placed by a trusted React
component; it cannot be inserted unchanged through the current compiled-HTML
path. Prefer an aspect-ratio-aware player over the current fixed 720px iframe
height when implementing real article integration.

## Practical acceptance matrix

| Integration claim | Evidence required |
|---|---|
| Shared scene consumer | SVG and native Canvas consume the same evaluated frame, including nested clips and group opacity |
| Real board appearance | Actual `ChalkBoardSurface` module used with documented API and seeded settings |
| Chalkspace lecture clip | Lesson clock drives local scene time; writable clip and foreground order are correct |
| Correct video export | Animated clip remains moving through a legacy static interval; cache reuse invalidated correctly |
| Eraser integration | Target layer is erased with deterministic masks while board/unrelated rows remain intact |
| Chalk writing integration | Reveal geometry, tool motion and contact audio share a verified schedule |
| Lemniro publishing | Rebuild publishes assets and a component on a real note page under the configured base path |
| Random seeking | 0→mid→end, end→mid→0 and shuffled times yield equal state; pixels match within declared backend tolerance |

The immediate cross-consumer demo should accurately claim the first two rows
when those are verified. The remaining rows are separate implementation gates,
not implied by a Canvas preview or static SVG adapter.
