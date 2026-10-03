# Texloom

TeX-authored mathematical scenes → a portable object bundle → SVG, a seekable
web player, and video. The renderer receives evaluated objects; it does not
execute TeX or independently implement animation timing.

This is a working 2D engine with an initial 3D rendering path. It includes a real TeX compiler, an explicit
TikZ scene frontend, typed IR validation, geometric dependencies, a shared
time evaluator, static SVG output, an offline HTML player, and MP4 export.

Version 0.3 captures actual PGF soft paths as editable line/cubic geometry. It
adds animated control points, geometric reveal, point-on-path, tangents and
normals. Version 0.2 anchors/connections and v0.1 bundles remain supported.

## Development direction: common runtime, many consumers

The [research-backed roadmap](docs/ROADMAP.md) defines the path from current 2D
scenes toward live geometry, composed animations, mathematical objects, 3D,
fields and optional Blender/solver producers. The first foundation is now
implemented: prepared scenes, capability profiles, host clip timing, native
Canvas2D rendering, and a Chalkspace board placement adapter.

Both SVG and Canvas consume the same `EvaluatedFrame`. See the
[runtime contract and dual-consumer demo instructions](docs/runtime-contract.md).
The real lecture consumer, export cache and explicit chalk presentation intents
are integrated. Mesh instances now render through a shared WebGL2 adapter in the
web player and Chalkspace. Parametric surfaces now generate shared mesh resources;
general simulation operations remain planned.

### Spatial curves and transported frames (PR32)

`\usepackage{texloom-curve3d}` adds `\loomspatialcurve{resource-id}|{...}|`
and `\loomfollowcurve{target-id}|{"curveNode":"path","progress":"time/8s"}|`.
The curve declaration supplies coordinate expressions, a fixed parameter domain,
resolution and an explicit frame seed. The runtime creates an immutable line
strip and discrete parallel-transport frames. A follower moves a mesh or group
at a normalized fraction of the sampled chord length, preserving its scale.
Its local +X/+Y/+Z axes represent tangent, normal and binormal.

```sh
python tools/compile.py examples/curve-frames.tex --out build/curve-frames
node tools/build-gpu-player.mjs build/curve-frames/bundle.json build/curve-frames/player.html
```

The eight-second helix example carries three colored arrows and native TeX
labels, with an authored quarter-turn twist and an adjustable radius. Seeking
and playback use the same absolute clock. Closed curves have explicit seam
policies; these sampled frames do not assert analytical arc length or create
tubes/sweeps. Literal bodies and decoded expressions remain archived with source
spans. See the [pinned feature PortSpec](docs/ports/features/pr32-curve-frames.json)
for the supported subset, numerical policy and primary references.

### Parametric surfaces from TeX (PR31)

`\usepackage{texloom-surface}` adds `\loomsurface{mesh-id}|{...}|`: a literal
JSON declaration of a rectangular parameter domain, resolution, coordinate
expressions, seam/pole policy and analytic or finite-difference normals. The
compiler preserves the declaration and expression sources. Mesh buffers are
generated from absolute time and scene parameters when the shared runtime samples
the scene, and may be referenced by ordinary `space3d` mesh instances.

```sh
python tools/compile.py examples/parametric-surfaces.tex --out build/parametric-surfaces
node tools/build-gpu-player.mjs build/parametric-surfaces/bundle.json build/parametric-surfaces/player.html
```

The sphere/torus example uses explicit welded seams, collapsed sphere poles,
animated radii and native TeX formulas. Its offline player exposes bounded scalar
parameters while preserving the source program. This is fixed-topology sampling,
with explicit failure for unsupported degeneracies. See the
[surface contract](docs/parametric-surfaces.md) and
[pinned feature PortSpec](docs/ports/features/pr31-parametric-surfaces.json).

### Projected 3D scenes and shared output (PR30)

An explicit perspective or orthographic camera projects indexed mesh instances.
Absolute-time transform tracks, opaque unlit colors, depth testing and world
clipping planes feed a Three.js adapter; the portable IR contains no GPU handles.
Native TeX resources attach to projected 3D anchors and compose with ordinary 2D
scene ink. The standalone player and real Chalkspace lecture use the same
compositor and exact-time video capture.

```sh
python tools/compile.py examples/gpu-cube.tex --out build/gpu-cube
node tools/build-gpu-player.mjs build/gpu-cube/bundle.json build/gpu-cube/player.html
python tools/export_video.py build/gpu-cube/player.html --out build/gpu-cube/cube.mp4 --fps 30
```

WebGL2 is required for this path. Labels are always-on-top overlays, hidden when
their anchor is clipped; they do not claim mesh-depth occlusion. Lighting,
textures, transparent materials, volumetrics and arbitrary 3D-to-SVG output are
outside this version. See [the renderer contract and backend comparison](docs/gpu-renderer.md).

### Mesh resources and 3D spaces (PR29)

Versioned indexed meshes, owned typed buffers and a separate right-handed,
Z-up `space3d` produce immutable instance matrices, normals metadata, bounds
and an optional affine camera view. TeX literal declarations and existing asset
packages feed the same numeric contract. `NUMERIC_3D_PROFILE` enables preparation;
the standalone 2D renderers continue to reject 3D features explicitly.
See the [mesh and space contract](docs/mesh-space.md).

### Chalk presentation intent (PR28)

TeX can declare optional draw/erase intent over native geometry. Pure sampled
metadata supplies bounds, contact poses, progress and seeds; Chalkspace supplies
strong grain, tools, target masks and a deterministic effects track. The clean
web renderer retains the same geometry. Glyph outline reveal is explicitly
separate from handwriting reconstruction. See the [contract and authoring guide](docs/presentation-intent.md).

### Packaged assets and preparation (PR 24)

Scenes can also publish a portable `texloom-package/1` manifest with inline,
relative-path, or packed byte-range resources. Preparation verifies every
resource's SHA-256, byte length, kind and bounds before a runtime becomes ready.
The host supplies transport through an `assetResolver`; sampling performs no I/O.

```ts
const store = createAssetStore({resolver: hostResolver});
const loading = beginPrepareScene(scenePackage, {assetStore: store, signal});
const runtime = await loading.ready;
renderCanvas(runtime.sample(2), context);
runtime.dispose(); // Releases this scene's leases. Safe to call again.
store.dispose();   // Host teardown, after its scenes have been disposed.
```

Concurrent scenes share verified immutable resources and pending reads. A
cancelled scene releases its own leases; other consumers keep their resources.
Existing `prepareScene(bundle)` remains synchronous. See the
[asset package and lifecycle contract](docs/assets.md), including the CLI,
resolver range rules, limits, and file/HTTP preview instructions.

### Interactive Lemniro figures (PR25)

`texloom/lemniro` prepares a registered, integrity-checked package into an
independent SVG figure runtime. The paired Lemniro component adds lazy loading,
native playback controls, static posters, reduced-motion behavior and unmount
cleanup to figures declared in a TeX note. See the
[figure contract and publication guide](docs/lemniro-figures.md).

### Native Chalkspace lecture clips (PR26)

`prepareChalkspaceLecture` prepares named scenes and independently placed clips
for the real Chalkspace lecture renderer. The host clock drives both writing
and scene animation, with shared readiness, native Canvas placement and full
disposal. See the [lecture integration contract](docs/chalkspace-lectures.md).

### Exact-time video capture (PR27)

Lecture frame keys include the immutable content revision, exact clip clock and
quality; held intervals can reuse a capture. `describe(t)` reports clip times
without evaluating geometry. The standalone SVG exporter remains an uncached
reference with a decimal-rational frame schedule, source offsets and per-frame
manifest. See [video export and verification](docs/video-export.md).

## Quick start

Requirements: Node 22+, Python 3.11+, TeX Live with `latex` and `dvisvgm`, and
FFmpeg for MP4. Python packages are needed for browser QA/video; the TeX compiler
itself uses the standard library and the shared Node validator.

```sh
npm ci
python -m pip install -r requirements.txt
python -m playwright install chromium
python tools/build.py examples/living-paths.tex --out build/v03 --video
```

Open `build/v03/player.html`. It is self-contained and works without a server.
It also exposes `window.texloom.render(seconds)` for exact-time capture.

The earlier examples still build with the same compiler:

```sh
python tools/build.py examples/orbit.tex --out build/demo --video
```

```sh
python tools/generate_field.py
python tools/build.py examples/field.tex --out build/field --video
```

The field example loads external samples of an analytical standing wave on a
unit square. It verifies the sampled-data interface; no manifold discretization
or numerical PDE solver is implemented.

## Source syntax

```tex
\documentclass{article}
\usepackage{texloom-tikz}
\begin{document}
\begin{loomscene}[width=960,height=540,duration=4]
\loomnode[circle,draw=cyan,text=white,minimum size=60bp]
  (A) at (200,250) {$X$};
\loomnode[rectangle,draw=cyan,text=white,minimum size=60bp]
  (B) at (650,250) {$Y$};
\loomconnect[draw=cyan,->] (f) (A.east) to (B.west);
\loomlabel[text=white,scale=2,offset=-20] (label) on (f) {$f$};
\loomanimate[duration=4] (B) {move to={(700,350)}};
\end{loomscene}
\end{document}
```

See `tex/README-v02.md` and `examples/commutative.tex`. Node appearance is executed
by TikZ itself: styles, fonts, shapes, dimensions, text, and anchors are measured
by PGF. Connection and animation keys are a documented Texloom subset. Scene
positions use bp with +y down; authored rotations are degrees, lowered to radians
in the IR. `bend` is a control-point offset in bp, not a TikZ bend angle.

Editable paths use `\loomgeometry`, `\loompoint`, `\loomdirection`, and
`\loomcontrol`. The path body is executed by PGF, including macros, arcs and
coordinate transforms, then its soft-path operations are captured. See
[v0.3 authoring](tex/README-v03.md) and `examples/living-paths.tex`. This supports
explicit live geometry alongside static TikZ resources, not arbitrary TikZ
animation programs.

The lower-level v0.1 JSON command interface remains documented in `tex/README.md`.
Existing arbitrary LaTeX documents do not automatically become animated object
graphs. Explicit wrappers preserve the identities and intent needed at runtime.

### Typed expressions and parameters (PR 04)

Explicit expressions can bind properties to scene time and typed parameters:

```tex
\usepackage{texloom-expressions}
% Inside an existing scene containing point B:
\loomparameter[type=scalar,unit=rad,min=-6.283185307179586,max=6.283185307179586]{a}{0}
\loomexpr{B}{position}{vec2(370bp,320bp - 95bp*sin(a + 1rad*time/1s))}
```

The expression body is captured verbatim and checked by the shared runtime.
Write operators such as `^` and `&&` literally. TeX math macros are not expanded;
these commands must occur directly in source, outside another macro's scanned
argument. Typed defaults, units and bounds are serialized through sidecar files,
and source spans identify the actual archived expression text.

```sh
python tools/build.py examples/parameter-sine.tex --out build/parameter-sine --video
```

The standalone player provides parameter controls. Core sampling accepts
`createEvaluator(bundle)(time, {a: Math.PI / 2})` without retaining overrides
between calls. See [expressions and parameters](docs/expressions.md) for syntax,
unit conventions, browser API behavior and limits.

### Fields on curve domains (PR 05)

Fields evaluate expressions across stable path-control or named curve-sample
elements. They can capture a position attribute, change the domain's working
positions, and drive existing point nodes' positions, radii, colors, opacity
and visibility. Every sample starts fresh; a capture preserves values across
later operations within that sample.

```tex
\usepackage{texloom-fields}
\loomdomain{samples}{curve}{curve-sample}{[{"id":"mid","parameter":0.5}]}
\loomfield{rest}{samples}{capture}{position}
\loomfield{move}{samples}{setPosition}{position + vec2(0bp,20bp)}
\loomfieldbind{samples}{move}{position}{[{"element":"mid","target":"P"}]}
```

`curve` must be an editable path node and `P` an existing point node.
`setPosition` updates the sampled dataset; it leaves the source curve geometry
unchanged. The [field guide](docs/fields.md) documents domain identity, current
versus original positions, typed attributes, target-space conversion and ramps.

```sh
python tools/build.py examples/curve-fields.tex --out build/curve-fields --video
```

### Editable curve deformation (PR 06)

Typed position expressions can now write actual curve geometry. `controlDeform`
maps the existing controls and retains their topology. `pointwiseDeform` maps the
whole curve, preserving recognized affine maps exactly in real arithmetic and
using a bounded adaptive polyline for supported nonlinear expressions.

```tex
\usepackage{texloom-geometry}
\loomdeform[mode=pointwiseDeform,tolerance=0.35]{wave}{source}{target}{
  position + vec2(0bp,30bp*sin(2*pi*1rad*parameter - 1rad*time/1s))
}
```

Source and target are editable path IDs with corresponding local coordinates.
Existing point/tangent/normal consumers follow the evaluated output. Bounds are
local geometric errors per stage; exhausted budgets produce diagnostics. Every
sample is fresh, so in-place deformation does not accumulate across playback.
The [deformation guide](docs/deformations.md) covers mode semantics, units,
provenance, single-writer dependencies and adaptive topology limitations.

```sh
python tools/build.py examples/curve-deformations.tex --out build/curve-deformations --video
```

### Coordinate operations and spaces (PR 07)

Midpoint, interpolation/extrapolation, fixed distance, rotation, line projection
and segment projection run in the existing typed operation graph. Point inputs
read live node positions; scalar inputs can use time/parameter expressions.

```tex
\usepackage{texloom-coordinates}
\loomcoordinate{M}{midpoint}{{"a":"A","b":"B"}}
\loomcoordinate[space=plot:chart]{F}{projectLine}{{"point":"C","a":"A","b":"B"}}
```

The target point must exist. Choose scene, node-local, parent or explicit plot
coordinates; distance, rotation and projection use that space's Euclidean metric.
Non-scene results convert through live transforms into the normal scene-position
binding. See [coordinate operations](docs/coordinates.md) for typed units,
reflection/scale behavior, exact source spans and real PGF comparison tests.

```sh
python tools/build.py examples/triangle-coordinates.tex --out build/triangle-coordinates --video
```

### Parametric shapes (PR 08)

Circle, ellipse, arc, rectangle, rounded rectangle and polyline constructors
produce typed analytic shapes. Separate graph operations sample those shapes or
convert them to paths under an explicit approximation profile and tolerance.

```tex
\usepackage{texloom-shapes}
\loomshape[tolerance=0.1]{orbit}{circle}{{"center":"O","radius":"40bp+10bp*sin(1rad*time/1s)"}}
\loomshapesample{P}{shape:orbit}{"time/12s"}
```

`orbit` is an existing path and `P` an existing point. Shape inputs can consume
live positions, typed expressions, property values and explicit point lists.
The target path receives geometry converted into its local space. See the
[shape guide](docs/shapes.md) for the six constructors, analytic sampling,
source spans, units and approximation limits.

```sh
python tools/build.py examples/parametric-shapes.tex --out build/parametric-shapes --video
```

## Architecture

```text
TeX execution + explicit declarations
  ├─ geometry / IDs / tracks / relations
  └─ measured math & TikZ → DVI → dvisvgm transport → vector objects
                      ↓
                versioned bundle
                      ↓
           createEvaluator(bundle)(time)
                      ↓
                  renderSvg(frame)
                ↙        ↓         ↘
           snapshot   web player   Chromium frames → FFmpeg
```

DVI files and source artifacts remain in the compilation directory with hashes
and toolchain provenance. SVG is temporary transport and a renderer output.
The common bundle contains paths, affine groups, measured boxes, references,
tracks and relations; it does not embed raw SVG strings.

The compile probe compares the same formula under DVI and LuaTeX. It supports
choosing the completed DVI importer for v0.1, while LuaTeX remains a candidate
for richer future node capture. Run `python tools/compiler_probe.py` to repeat.

## Current capabilities

- Native groups, paths, ellipses, points, lines, TeX resources, scalar fields.
- Translation, rotation, scale, camera pan/zoom/rotation, scalar/vector keyframes,
  linear/smoothstep/step interpolation, simultaneous independent tracks.
- Point-on-ellipse, tangent, attached label, line-between-points dependencies.
- Multi-contour line/cubic geometry, exact splitting and bounds, bounded
  arc-length measurement, prefix reveal, stable-ID control-point tracks.
- Point-on-path with parameter or length progress; tangents and world-space
  perpendicular normals across transformed parents.
- Real TikZ node art and named center/cardinal/diagonal/base/mid anchors when the
  shape defines them; native TikZ path bodies exported as vector resources.
- Named straight/curved connections with triangular arrowheads, attached TeX
  labels, and simultaneous animations of nodes and parent groups.
- Cross-parent anchor resolution, including rotation, nonuniform scaling and
  reflections; label placement respects TeX width/height/depth.
- Group alpha, clipping, fill/stroke alpha, paint order, dash/cap/join.
- Exact logical TeX width/height/depth and separate visible ink bounds.
- Deterministic random seeking, shared immutable resources, explicit validation.
- External time-sampled grids, frame interpolation, heatmap presentation.

## Deliberate limits

- Live geometry uses explicit declarations. A static TikZ resource does not
  automatically retain node identities, constraint intent, or PGF animations.
- The older v0.1 geometric relations require a shared parent space and identity
  local transforms. New `connect`/`pathLabel` relations resolve full transforms.
- Live connections have a documented cubic model; their arrowheads are Texloom
  triangles, not PGF `arrows.meta` geometry. Path labels use cubic parameter
  position, not arc-length percentage. Native TikZ paths retain their static
  visuals, but do not acquire live internal constraints automatically.
- No arbitrary path morph, general constraint solver, 3D mesh, physics, or PDE
  solver yet. These require additional typed operations/resources, not raw SVG.
- The strict graphics importer rejects gradients, masks, filters, images,
  nested viewports, and unsupported styles. This is not universal TeX support.
- Document metadata has a slot, but a full responsive lecture-note converter is
  still owned by Lemniro. The existing sites and Chalkspace engine are unchanged.
- Integration adapters provide a responsive figure/player embed and a
  Chalkspace overlay transform. They do not implement chalk stroke estimation
  for every imported path or migrate old lecture actions.
- Export is silent video. Narration, sound design, and teaching choreography are
  consumer features.

## Anchors and baseline placement (PR 09)

The opt-in `texloom-anchors` package connects logical TeX baselines, measured
native PGF anchors and analytic closed-shape boundaries through the same typed
operation graph. `\loomplace` aligns a raw formula's selected anchor to a scene
point; `\loomanchor` resolves a named anchor or analytic border into an existing
point node. Metrics, ink bounds and native padding remain distinct. Existing
scenes retain their original capture output unless the package is loaded.

```sh
python tools/build.py examples/anchor-layout.tex --out build/anchor-layout --video
```

See [anchors and text placement](docs/anchors.md) for literal TeX syntax,
coordinate spaces, opt-in PGF metadata and supported provider limits.

## Reusable curve operations (PR 10)

The `texloom-curves` package trims, resamples, reverses and joins editable paths
as typed graph values. Sample positions, tangents and distances remain live;
chained outputs retain source-segment provenance. Length and parameter modes,
contour selection, closed wrap and join policies are explicit.

```sh
python tools/build.py examples/curve-operations.tex --out build/curve-operations --video
```

The demo combines a trimmed cubic, nine equal arc-length markers, a sampled
polyline and a moving reverse-direction probe. See [curve operations](docs/curves.md)
for TeX syntax, current-geometry reads, reusable outputs, numerical tolerances
and resampling limits. The historical sampler and renderer APIs remain unchanged.

## Path intersections (PR 11)

The `texloom-intersections` package computes reusable line-line and line-cubic
intersection sets. Select points or labels along either input with an explicit
branch index and missing policy. Shared endpoints retain their incident segment
references; overlapping intervals remain distinct from isolated points.

```sh
python tools/build.py examples/path-intersections.tex --out build/path-intersections --video
```

See [path intersections](docs/intersections.md) for finite/infinite domains,
typed outputs, numerical tolerances, selection, and TeX authoring. Cubic-cubic
solving is the subsequent PR 12 scope.

## Cubic intersections (PR 12)

Opt into `solver=curves` for cubic-cubic intersection sets. The versioned solver
uses bounded adaptive subdivision and root refinement, reports unresolved
contacts explicitly, and shares deterministic branch selection across web,
SVG and Canvas/video. The default PR 11 solver retains its existing behavior.

```sh
python tools/build.py examples/cubic-intersections.tex --out build/cubic-intersections --video
```

See [cubic intersections](docs/cubic-intersections.md) for supported tangencies,
overlap limits, total work budgets, diagnostics and the v2 core/graph APIs.

## Connections and path labels (PR 13)

`texloom-connectors` adds straight, orthogonal and explicitly controlled cubic
connections from live anchors, plus measured TeX labels placed by parameter or
arc-length fraction. Labels declare their anchor, normal offset and rotation
policy. Existing `loomconnect`/`loomlabel` behavior stays compatible.

```sh
python tools/build.py examples/connector-labels.tex --out build/connector-labels --video
```

See [connections and labels](docs/connectors.md) for coordinate spaces, baseline
metrics, reflection rules, typed graph APIs and explicit limits.

## Arrow tips and shortening (PR 14)

`texloom-arrows` adds triangle/stealth tips, independent endpoint shortening,
and an explicit error/clamp policy for short paths. Tip dimensions and kinds can
follow expressions or graph outputs. Both renderers consume the same derived
geometry; labels and samplers retain the complete logical path.

```sh
python tools/build.py examples/arrowheads.tex --out build/arrowheads --video
```

See [arrow authoring](docs/arrows.md) for the local-space contract, PGF comparison,
legacy compatibility, and graph APIs.

## Path decorations and braces (PR 15)

`texloom-decorations` derives ticks, direction marks, repeated local symbols and
sinusoidal snakes from editable paths. Shared arc-length frames provide explicit
spacing, phase, margins, orientation and corner/cusp policies. Endpoint braces
use the same ordinary path representation. Source paths remain available to
labels and other computations, and derived geometry updates after its upstream
writers on every seek. SVG, Canvas and Chalkspace consume the same output.

The initial profile accepts one contour and bounded generation work. Snakes are
resolution-controlled polylines; closed paths have an explicit open seam cut.
This is a documented subset of decoration behavior, not a PGF state-machine
interpreter. See the [authoring and API guide](docs/decorations.md) and
[animated example](examples/path-decorations.tex).

## Geometric transitions (PR 20)

Explicitly approved contour/segment correspondence animates editable paths,
including line-to-cubic promotion and opt-in arc-length resampling. Independent
transition instances preserve authored endpoints; clones, entrances and exits
compose with the existing timeline. Unmatched stroke contours support fade or
create policies. See the [geometry transition guide](docs/morphing.md) and
[`examples/geometry-transitions.tex`](examples/geometry-transitions.tex).

## Animation composition (PR 19)

`texloom-animation` composes actions with sequence, parallel, stagger, waits
and named cues. The shared compiler lowers relative timing to numeric tracks,
including mixed easing, exact instantaneous changes and holds. Property
conflicts are diagnosed before playback; no renderer owns a second clock.
See the [authoring and timing contract](docs/animation.md) and
[`examples/animation-composition.tex`](examples/animation-composition.tex).

## Function and parametric plots (PR 18)

`texloom-plots` generates editable paths from typed functions, parametric
curves, ordered sample data and regions between two function boundaries.
Adaptive sampling uses the existing Cartesian mapping and preserves authored
domain gaps. Expressions and quality parameters are evaluated by the shared
runtime; downstream curve operations consume the generated geometry.
See [plot authoring, quality and discontinuity contracts](docs/plots.md) and
[`examples/function-plots.tex`](examples/function-plots.tex).

## Mathematical coordinates and axes (PR 17)

`texloom-axes` maps dimensionless mathematical data into bp geometry, with
linear/log axes, stable bounded ticks, derived grids and real TeX label catalogs.
Ranges, sizes and tick steps can depend on time or typed parameters. The same
evaluated paths and placements feed SVG, Canvas, Chalkspace and video.
See [the coordinate and label contract](docs/axes.md) and
[`examples/cartesian-axes.tex`](examples/cartesian-axes.tex).

## Measured box layout (PR 16)

`texloom-layout` places measured TeX content into matrices, rows, columns and
explicit alignments. Logical width, height and depth determine column widths and
row baselines. Null slots retain matrix cells. Distribution can wrap at a declared
extent; overflow never silently shrinks the content. A fit path follows the same
measurement and placement outputs with explicit padding.

Layouts own placement transforms. Live TeX scale and layout parameters update
the shared operation graph before downstream connectors and labels are sampled.
Measured PGF groups use their captured logical text metrics; independently edited
child artwork requires new measurement. See the [layout guide](docs/layout.md)
and [commutative diagram example](examples/box-layout.tex).

### Native TeX semantic parts (PR 21)

`\loompart{id}{body}` assigns explicit identity while TeX typesets the whole
formula. The compiler compares annotated paint and metrics with a native
reference and rejects layout changes. `\loompartbox` opts into measured atomic
boxes; transparent markers never infer logical boxes from ink.

`selectTextParts` selects original paint by authored ID, with explicit nesting
and overlap rules. `\loompartview` creates ordinary independently animatable
nodes using that selection, consumed by the existing SVG, Canvas and Chalkspace
renderers. See the [semantic parts guide](docs/text-parts.md) and
[real TeX example](examples/semantic-math-parts.tex). PR22 below adds explicit
formula-to-formula correspondence.

### Formula part transformations (PR 22)

`\loommathtransform` maps authored part IDs between two native TeX formulas.
It supports explicit replacement, one-to-many copies, retained sources,
unmatched fades and measured or explicit alignment anchors. Exact endpoints
use the original complete resources; native outlines move and crossfade during
the transition. Shared frame metadata describes the same semantic state used
by SVG accessibility. See the [formula transform guide](docs/math-transforms.md)
and [three-stage algebra example](examples/math-transformations.tex).

### Declarative updates and traces (PR 23)

`texloom-relations` adds following, direction alignment, look-at and
value-controlled opacity through the shared typed operation graph. Parent-space
transport keeps orientation correct under affine parent transforms. Shapes and
their dependents regenerate from validated parameters and absolute scene time.
`\loomtrace` prepares a bounded, adaptive path over an authored time domain;
seeking and output fps do not accumulate or choose its vertices. Observed gaps
remain separate contours. See the [update and trace guide](docs/declarative-updates.md)
and [real TeX example](examples/declarative-updates.tex) for authoring, error
estimates, budgets and the terminal trace-output contract.

## Core API

```ts
import {createEvaluator, validateBundle} from './src/index.ts';
import {renderSvg} from './src/render-svg.ts';

const sample = createEvaluator(bundle); // validates and snapshots once
const frame = sample(1.25);            // independent of playback history
const svg = renderSvg(frame, {idPrefix: 'my-unique-figure'});
```

Use a unique `idPrefix` per inline SVG in one HTML document. The Lemniro adapter
handles namespaces and responsive sizing. `evaluate(bundle,t)` is a convenient
one-off alternative; treat its returned shared resources as immutable.

## Verification

### Executable typed operations (PR 03)

An optional versioned `operationGraph` on Bundle 0.3 declares typed sockets,
shared outputs, explicit coordinate spaces and property bindings. The common
runtime now executes these graphs alongside tracks and legacy relations through
a compiled dependency plan. Property reads/writes and transform ancestors
determine ordering; every sample receives fresh mutable frame/output state.
The existing `evaluate`, `createEvaluator` and `prepareScene` APIs are unchanged.

`sampleCurve`, `offsetPoint` and `transformPoint` execute typed computations;
five value producers support scalar, point, vector, path and transform bindings.
Scene-space position sinks convert to target-local coordinates at sample time.
Whole transform bindings support representable translation/rotation/scale,
including reflections; unsupported shear fails explicitly. See the
[operation runtime](docs/operation-runtime.md) for execution, limits and handoff,
and the [PR 02 contract](docs/operations-contract.md) for JSON/socket details.

```sh
node tools/validate-bundle.mjs tests/fixtures/operations/sample-curve.json --prepare-operations
npm run snapshot -- tests/fixtures/operations/sample-curve.json build/operations/sample.svg 1
node tools/build-player.mjs tests/fixtures/operations/sample-curve.json build/operations/player.html
```

The sample shares one curve operation's position and tangent across a dot and
direction line and now renders through the normal player and SVG/Canvas paths.
Its literal inputs are static. The separate PR 04 expression program supplies
typed time/parameter bindings; authored graph sockets remain literal/output
references. Existing tracks remain available for motion and can drive legacy
consumers of graph-written sources. Existing TeX examples remain unchanged;
there is no executable plugin loader or temporal output cache.

### Historical rendering and compiler regression

The [PR 01 port-regression gate](docs/ports/README.md) checks all four registered
scenes from a clean Texloom checkout. It does not need a sibling Chalkspace
checkout, prebuilt demo directories, or FFmpeg. Use the pinned verification
packages so browser/raster changes are visible:

```sh
npm ci
python -m pip install -r requirements-port.txt
python -m playwright install chromium
python tools/verify-port.py
```

Full verification needs `latex`, `dvisvgm`, and `kpsewhich` on `PATH`, with PGF,
AMS math and Latin Modern installed. On Ubuntu, use the package/browser setup in
[the port guide](docs/ports/README.md#setup). The command compiles each source
twice, compares semantic bundles and sampled frames with committed references,
checks reverse seeking, compares historical PNGs and SVG/Canvas raster output,
then runs the TypeScript typecheck, all TypeScript tests and all Python
`*_test.py` tests. A failure leaves the committed references unchanged.

| Command | Evidence it checks |
| --- | --- |
| `python tools/verify-port.py` | Full source compilation, runtime, raster and test gate. |
| `python tools/verify-port.py --runtime-only` | Current runtime/renderers against committed compiler output; no TeX compilation or compiler tests. |
| `python tools/verify-port.py --spec-only` | PortSpec metadata, registered inputs and fixture references only. |

`build/port-verification/latest.json` points to the run's `report.json`; the same
run directory contains toolchain records, logs and frame artifacts. Full runs
also build a `player.html` for each completed fixture. Open these files to inspect
a difference before considering an explicit `--record --reason "..."` update.
Reference recording requires a full build and passing tests; it is never an
automatic response to a regression.

[GitHub Actions](.github/workflows/port-regression.yml) defines separate Linux
runtime-only and full compile jobs, with evidence uploaded even after a failed
verification step. Toolchain drift is reported; it does not relax comparison
tolerances. See the port guide for baseline review and artifact details.

The separate interactive QA scripts (`qa_player.py`, `qa_anchors.py`,
`qa_dual.py`, `qa_paths.py`) remain useful for focused browser-control,
responsive-layout and integration checks. Their coverage is not implied by
passing the PR 01 regression command.

TeX compilation is intended for trusted local source files. Disabling shell
escape is not an OS sandbox for arbitrary uploaded TeX.

## Project boundaries and provenance

`src/` owns the interchange/runtime; `tex/` and `tools/compile.py` own capture;
`adapters/` owns consumer-specific placement. No Manim or Blender implementation
was copied into this version. External TeX/font/tool licenses continue to apply.
The source repository is `ddomology/Texloom`; the npm package is marked private.
Choose a distribution license before publishing reusable source packages.
