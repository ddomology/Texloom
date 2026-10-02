# Shared runtime and renderer contract, M0

Implemented in this milestone; scene schemas remain 0.1/0.2. This is the first
foundation in [the roadmap](ROADMAP.md), not full M1 or 3D compatibility.

```ts
const runtime = prepareScene(bundle);
runtime.require(SVG_2D_PROFILE);
runtime.require(CANVAS_2D_PROFILE);
const frame = runtime.sample(6);
const svg = renderSvg(frame);
renderCanvas(frame, canvasContext);
```

`prepareScene` validates and snapshots once. Resources are shared immutable
data; frame geometry is independent per sample. A renderer consumes the frame
without recomputing timing/relations. The manifest exposes scene version,
duration, viewport and required render features. Profiles are versioned; an
unsupported feature fails capability checks. Runtime paint validation can also
reject unsupported CSS values. A matching feature vocabulary does not imply
universal CSS or pixel identity between rendering APIs.

No real-time clock, audio playback, arbitrary callbacks or JS expressions are
stored in a scene. A host owns the playback clock and samples absolute seconds.
The dependency graph currently is the existing relation evaluator; a generalized
plugin operation graph remains later work.

## Clip time

```ts
const clip = bindSceneClip(runtime, {
  start: 10, sourceStart: 2, rate: 2, duration: 3,
  before: 'hidden', after: 'hold',
});
const sample = clip.sample(11.5); // sourceTime=5, visible=true
```

Active interval is `[start,start+duration)`, host seconds. Rate is positive source
seconds per host second. Source start plus rate×duration must fit source duration.
Endpoint hold/hidden behavior is explicit. Zero-duration clips use the after
policy at the start instant. Negative finite host times are allowed and resolve
to the before policy; start itself is nonnegative. Hidden samples return no frame.
Repeated or reversed calls do not change results. There is no implicit looping,
reverse playback, extrapolation, or narration retiming in M0.

## Canvas

`renderCanvas(frame, ctx, options)` uses native Canvas `Path2D`, with no SVG image
conversion. Width/height are backing-pixel output extent, not host canvas resize.
Default background matches SVG; `transparent` skips it. `clear:false` preserves
the host background. Caller state is saved/restored and existing clip retained.
Viewport fit uses SVG's default centered meet behavior. Group opacity is
isolated on offscreen surfaces rather than multiplied into children. A surface
factory can be injected; it must supply independent contexts for nested opacity.

Default compositing surfaces use browser `document`. Worker/OffscreenCanvas
integration is a later profile; M0 does not claim a tested worker backend.
Filled outlines preserve typeset geometry, but do not reconstruct handwriting.
Rotated heatmap cells use native Canvas antialiasing; SVG crispEdges may differ.
Geometry/style/timing invariants and bounded image comparison are separate tests.

## Chalkspace Canvas layer

```ts
const layer = createChalkspaceCanvasLayer({x: 0, y: 1, width: 12});
layer.draw(frame, ctx, {frameWidth: 16, frameHeight: 9, cameraY: 4.5});
```

Placement x is horizontal center; y is the top of the scene rectangle in board
world units. Host cameraY is the board coordinate at viewport center. The scene's
own camera is applied inside the layer once. Board viewport and host canvas
aspect must agree; there is no implicit stretch. Layers above 8192 backing pixels
per dimension fail the current surface budget. Host owns clipping and foreground
order. The layer has no timer, audio, eraser state or chalk material inference.

For full lecture integration, host render calls must sample clips, draw them at
an explicit layer order, and include changing clips in export frame-cache keys.
The current standalone demo uses the real Chalkspace board module and this native
layer; it does not install these hooks in the existing lesson runtime.

## Reproduction

```sh
python tools/build.py examples/commutative.tex --out build/v02
node tools/build-dual-demo.mjs build/v02/bundle.json build/shared/index.html ../Chalkspace
python tools/qa_dual.py build/shared/index.html
npm run check
npm test
```

The demo builder reads only `../Chalkspace/src/chalkspace/web/board-surface.js`
from the existing checkout and embeds it with a SHA256 provenance record.
It does not copy that module into Texloom's source or modify Chalkspace. Build
`examples/orbit.tex` into `build/demo` for the existing compiled-resource TS test.
Optional `build/field/bundle.json` expands Canvas QA to scalar fields.

`qa_dual.py` verifies browser errors, mobile overflow, clip/group alpha/currentColor,
v0.1/v0.2 compiled scenes, backwards seek, host context state, SVG/Canvas image
differences and a local performance baseline. Reports include exact dimensions
and timings, not guarantees for every device or future scene class.

## Live path slice (0.3)

The evaluator also resolves editable PGF paths, control-point tracks, prefix
reveal, point-on-path and tangent/normal relations. Consumers need no extra
geometry implementation: the generated path `d` and point/line coordinates
already belong to the shared frame. Complete geometry is retained separately
from its visible prefix for analytic sampling. See the versioned IR contract
for local-length progress and world-direction conventions.

```sh
python tools/build.py examples/living-paths.tex --out build/v03 --video
node tools/build-dual-demo.mjs build/v03/bundle.json build/v03/dual.html ../Chalkspace
python tools/qa_dual.py build/v03/dual.html
python tools/qa_paths.py build/v03/dual.html build/v03/bundle.json
```

The path browser check compares captured geometry with the actual retained PGF
artwork, then compares SVG/native Canvas at nine times including partial reveal
and deformation. PGF's separate driver conversion can cause small edge-pixel
differences. Full Chalkspace lesson scheduler/eraser/cache and Lemniro React
component integration remain a separate milestone.
