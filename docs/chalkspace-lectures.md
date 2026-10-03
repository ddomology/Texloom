# Chalkspace lecture integration and exact frame identity (PR26–27)

`prepareChalkspaceLecture` connects compiled Texloom scenes to Chalkspace's
actual lesson render function. The host owns its clock, camera, rows, erasures,
tools, captions and audio. The adapter has no animation loop or DOM attachment.

## Portable lecture payload

```ts
import {prepareChalkspaceLecture} from 'texloom/chalkspace';

const layer = await prepareChalkspaceLecture({
  contract: 'texloom-lecture/1',
  scenes: {diagram: compiledBundleOrInlinePackage},
  clips: [{
    id: 'first-view', scene: 'diagram',
    timing: {start: 3, sourceStart: 0, rate: 1, duration: 8,
      before: 'hidden', after: 'hold'},
    placement: {x: -3.1, y: 2.35, width: 5.9},
  }],
}, {signal: hostAbort.signal});

// Called inside the host's real render(t), under its writing-area clip.
const states = layer.draw(context, absoluteLessonSeconds, {
  frameWidth: 14.222222, frameHeight: 8, cameraY: currentBoardCameraY,
});
layer.dispose();
```

Scenes can be full validated bundles or `texloom-package/1` packages whose
resources are all inline. External transport is resolved at lesson compilation;
the emitted HTML needs no server or runtime network request. At most 64 named
scenes and 128 independently timed clips are accepted. Plain JSON validation
rejects accessors and nonfinite data before preparation.

Each clip references one scene and has a unique ID. `timing` is the existing
`bindSceneClip` contract: `[start, start + duration)` is active; the default
before policy is hidden and after policy is hold. The source offset and rate
are applied exactly once by that shared function. There is no inferred loop.
One prepared source may serve multiple clips; their clocks and placement remain
independent. Sample results are fresh, so reverse seeking and returned-frame
mutation do not change future evaluation.

Preparation snapshots the complete input before waiting, verifies all resources
and the Canvas capability profile, then publishes the entire lecture atomically.
The lecture owns a shared asset store and its scene preparations. Cancellation
before/during/after readiness and explicit disposal release all preparations,
leases and Canvas surfaces. A disposed layer rejects sampling or drawing.

`manifest` exposes frozen scene metadata, the content revision and resolved clip
timings/placements. `describe(t)` returns each clip's ID, scene, absolute host
time, source time, phase and visibility without evaluating any scene geometry.
It uses `SceneClip.describe`, the same clock mapping called by `sample`.
`sample(t)` returns each clip's ID, scene, source time, phase, visibility and
evaluated frame. `draw` samples each clip once and returns the same metadata
without the frame, plus the screen rectangle for visible clips.

## Coordinates and layer order

Placement uses board-world units: `x` is centered horizontally and `y` is the
top of the scene. Width determines proportional height from the scene viewport.
The scene camera is applied by the shared native Canvas renderer. Board pan and
scale are applied once when placing the resulting surface.

The host render order is:

1. Board surface.
2. Existing rows, copying and highlights.
3. Texloom scene surfaces, clipped to the board writing area and their own viewport.
4. Foreground chalk/eraser, header, captions and shelf.

The adapter preserves the incoming context and clip. It retains the existing
16:9 board contract, permitting up to one backing pixel of rounding for the
host's 854×480 export preset. A genuinely different aspect ratio is rejected.
Native vector paint is retained; this stage does not invent chalk stroke order
for an arbitrary scene or make row erasers delete external scene content.

## Actual player hook and export

The paired Chalkspace change calls this layer from the existing closure's
`render`, reached by Play, the actual slider, beat jumps, `seek`, `setSize` and
camera events. It does not wrap only a public `window` method.

`chalkspace.ready` resolves after atomic scene preparation; legacy lessons stay
synchronously ready. Playback is disabled while preparing or after failure.
An error is visible and rejects readiness instead of silently dropping a scene.
The export path waits for this same promise. Host disposal aborts preparation,
cancels the host animation frame/audio and disposes a late-arriving layer.

## Exact frame identity

`layer.revision` and `layer.manifest.revision` expose the same immutable SHA-256
fingerprint, computed once during preparation from the complete input snapshot.
It covers scene geometry, resource content, scene identities, clip ordering,
timings and placement. Object property insertion order is canonicalized; array
order and signed numeric zero are preserved. Source metadata is included, so a
metadata-only edit may conservatively invalidate a cache. The revision is not
an authentication signature or a guarantee of identical rendering across
different browser or renderer versions.

`layer.frameKey(t, quality = '')` returns an exact string key containing the
content revision, the host's quality tag and every clip's phase, visibility and
source time. Active clips also include the absolute host time, preserving
distinct representable host times even if their mapped source times happen to
round to the same number. No decimal rounding or time quantization is applied.
Repeated requests for the same time and quality have the same key regardless
of seek history. Before/after intervals omit the changing host time, so an
unchanged hidden or held endpoint can reuse its cached frame. Zero-duration
clips use the ordinary after policy at their exact start.

Keys and descriptions do not evaluate geometry, perform I/O, or change playback
state. The `string | null` return type is retained for host compatibility; this
adapter returns a string for every valid prepared request. Hosts may still
receive `null` from older or custom layers and must draw those frames normally.

The host must add its own board content revision, camera, captions, tools and
output settings to the complete frame key. Pass an unambiguous quality tag for
pixel size, frame rate or rendering choices, for example
`JSON.stringify({width:1920,height:1080,fps:30,renderer:'canvas-1'})`. A lecture
layer cannot infer which host configuration affects the final image. The
content revision includes placement; it does not include a camera supplied only
to `draw`. Changing output quality or host camera must invalidate the host key.

## Distribution and reproduction

From a committed source checkout:

```sh
node tools/build-chalkspace-runtime.mjs build/chalkspace-runtime
```

This produces a browser IIFE, a Node validator and provenance with the source
commit and both file hashes. Copy all three files into Chalkspace's
`src/chalkspace/web/`. The Python compiler invokes the validator on the exact
inline payload and uses resolved timings from the same `bindSceneClip` logic.
The validator requires Node 22+. Playback needs only a modern browser.
`--development` is for local iteration; release distributions must record
`development: false`. No TypeScript, private tools or source maps are embedded
in the browser payload.

The example source `examples/hausdorff-neighborhoods.tex` depicts disjoint open
neighborhoods around a point of a compact set and an external point. Its shapes
deform while labels and distinguished points retain their mathematical roles.
It is an illustration of the separation argument, not a restriction of the
theorem to planar subsets. Build and register it with:

```sh
python tools/build.py examples/hausdorff-neighborhoods.tex --out build/hausdorff-neighborhoods
node tools/package-scene.mjs build/hausdorff-neighborhoods/bundle.json --out build/hausdorff-package --inline
```

Chalkspace's `examples/hausdorff-texloom.yaml` includes a complete compact-closed
proof, two differently started clips and a later camera pan. Legacy erasure
is checked separately against the original renderer.
The paired repository's tests cover compilation, actual player controls and
layer order. `tests/chalkspace-lecture.test.ts` covers independent timing,
snapshots, random seeking, capability/resource errors, cancellation, disposal
and the rounded export aspect. Browser acceptance compares the lecture pixels
against direct native frame evaluation and checks legacy frames separately.
