# Texloom

TeX-authored mathematical scenes → a portable object bundle → SVG, a seekable
web player, and video. The renderer receives evaluated objects; it does not
execute TeX or independently implement animation timing.

This is a working 2D vertical slice. It includes a real TeX compiler, an explicit
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
Full lecture scheduler, chalk strokes, eraser and export-cache integration remain
explicit follow-up gates; 3D and general simulation operations are planned.

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
