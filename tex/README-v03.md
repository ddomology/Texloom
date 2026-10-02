# Editable PGF paths — Texloom 0.3

This frontend executes a geometry-only TikZ path through PGF and captures its
soft-path commands into `PathGeometry`. The runtime can reveal, sample and deform
that geometry. Original TeX, DVI and SVG artwork remain available for comparison.
The compiled scene continues to use one shared evaluator for every renderer.

Ordinary v0.2 source remains v0.2. A `loomgeometry`, `loompoint` or `loomdirection`
declaration opts the emitted bundle into v0.3. The original JSON interface and
static `loompath` resource wrapper remain available.

## A minimal live curve

```tex
\documentclass{article}
\usepackage{texloom-tikz}
\begin{document}
\begin{loomscene}[width=640,height=360,duration=4]
  \loomgeometry[at={(100,200)},draw=blue,line width=2bp,reveal=0]
    (curve) {(0,0) .. controls (100,-150) and (250,150) .. (400,0)};
  \loomdirection[on=curve,point=P,length=70,draw=red] (T);
  \loompoint[on=curve,at=0,radius=4,fill=blue] (P);
  \loomanimate[duration=1] (curve) {reveal to=1};
  \loomanimate[delay=1,duration=3,easing=linear] (P) {progress to=1};
\end{loomscene}
\end{document}
```

Build `examples/living-paths.tex` for a longer example with actual control-point
deformation, a tangent and normal, nested groups, movement, rotation and scaling.

## Geometry authoring

```tex
\loomgeometry[<options>] (<id>) {<one TikZ path expression>};
```

The body is parsed by TikZ itself. It is not interpreted with source-text regular
expressions. TeX macros from `loomsetup`, coordinate arithmetic, lines, cubic
controls, rectangles, circles and arcs are executed by PGF. Multiple subpaths
and `cycle` closure survive capture. Shapes such as circles become the actual
cubic segments selected by PGF, not exact symbolic circles.

| Option | Default | Meaning |
| --- | --- | --- |
| `at={(x,y)}` | `(0,0)` | Scene translation in bp, +y down |
| `draw`, `fill` | `black`, `none` | Named xcolor paint, converted into concrete hex colors |
| `line width` | `1bp` | TeX length converted into bp |
| `line cap`, `line join` | `butt`, `miter` | Supported Canvas/SVG stroke cap and join |
| `fill rule` | `nonzero` | `nonzero` or `evenodd` |
| `opacity` | `1` | Set both native PGF fill and draw opacity |
| `fill opacity`, `draw opacity` | `1` | Separate native PGF paint opacity |
| `reveal` | `1` | Initial visible fraction from 0 to 1 |
| `mode` | `parameter` | `parameter` or `length` reveal progress |
| `tolerance` | `.05` | Path length approximation tolerance in local bp |
| `rotate`, `scale`, `xshift`, `yshift` | `0`, `1`, `0bp`, `0bp` | Native TikZ coordinate transforms, baked into captured geometry |

`at` and outer `loomgroup` transformations stay editable scene transforms.
Native TikZ coordinate transforms follow PGF ordering and its physical +y-up
rotation convention. The capture converts PGF pt into bp and flips y once.
Runtime group rotations retain Texloom's +y-down convention. Prefer outer
`loomgroup` transforms when animating a collection.

PGF fixed-point rounding remains visible in the captured coordinates. An authored
70bp coordinate can differ by roughly .001bp after PGF basis conversion; preserving
the actual PGF result is preferable to replacing it with a source-text guess.

For predictable native paint, geometry uses an explicit wrapper style set and
clears `every path`. Use the wrapper options for paint. Path-body paint changes,
embedded nodes, extra drawing statements, `to`/`edge`, decorations, pictures and
general inline option blocks are rejected. Native shape options consumed by
TikZ, such as `circle[radius=20bp]`, are supported. This capture adapter is a
documented geometry subset; it does not claim universal TikZ semantic recovery.
Use `loomnode` or the broader static `loompath` for other artwork.

The first version requires at least one drawn or filled path for the retained
PGF reference artifact. A path with both paints set to `none` is rejected.
Move-only contours have no paint and are omitted; unsupported soft-path protocol
tokens fail compilation. Lower-level TeX driver manipulation is outside this API.

## Points, tangents and normals

```tex
\loompoint[on=curve,at=.3,radius=4,fill=blue,
           mode=length,tolerance=.025] (P);
\loomdirection[on=curve,point=P,length=80,draw=red] (T);
\loomdirection[on=curve,point=P,length=60,normal=true,draw=green] (N);
```

`loompoint` options: required `on`, initial `at` progress (default 0), `radius`
(default 4bp), `fill` (black), `draw` (none), `line width` (1bp), `mode`
(`parameter`) and `tolerance` (.05bp).

`loomdirection` requires `on` and `point`. It accepts `length` (default 80 world
bp), `normal` (default false), `draw` (black) and `line width` (1bp). Its point
must come from `pointOnPath` on that same path; its sampling mode and tolerance
are inherited from that relation. The evaluator computes direction in world
space, so the normal remains perpendicular after nonuniform parent transforms.

Point and direction sampling use the full analytic geometry independently of
the reveal fraction. Hide or fade markers when choreography requires waiting
for a curve to appear. Reversed seeking uses the same absolute-time results.
Zero-speed points, degenerate paths and invalid references are reported by the
geometry runtime instead of inventing a tangent direction.

## Animation and control identity

The existing `loomanimate` adds two scalar properties:

```tex
\loomanimate[duration=2,easing=linear] (curve) {reveal to=1};
\loomanimate[duration=6,easing=linear] (P) {progress to=1};
```

Move an explicit captured coordinate with:

```tex
\loomcontrol[delay=2,duration=4] (curve)
  {contour-0}{segment-0}{c1}{(110,-80)};
\loomcontrol[duration=4] (curve)
  {contour-0}{}{start}{(-10,0)};
```

The arguments identify path, contour, segment, coordinate and destination.
Valid segment coordinates are `to`, or `c1`/`c2` on cubic segments. Use an empty
segment argument and `start` for a contour's start. The destination is a runtime
local-bp coordinate after capture; it does not reapply native TikZ transforms.

IDs are `contour-0`, `contour-1`, ... and per-contour `segment-0`, `segment-1`, ...
in executed PGF order. They remain stable across time, not across arbitrary
source edits that alter contour topology. Inspect the bundle when addressing a
library-generated shape. Invalid IDs and incompatible coordinates are errors.

Control animations lower into properties such as
`geometry.contour-0.segment-0.c1`. Sequential intervals merge into one track;
overlaps and mixed easing on the same property are rejected, as in v0.2.

Reveal yields a true partial geometry path shared by SVG and Canvas. Its fill
follows ordinary implicit path-closure rules; partial reveal of a filled shape
can therefore show a closing chord. The initial demo uses stroked curves.
This is geometry reveal, not a recovered handwriting stroke sequence.

## Capture provenance and verification

Each geometry's `source.referenceResourceId` names the original compiled vector
resource. Its provenance includes `pgfSoftPath.geometry`, protocol, PGF version,
coordinate conventions, token count and capture hash. The asset folder retains
`asset.tex`, `asset.dvi`, `asset.svg`, `asset.anchors` and `asset.path`.

To compare reference art at full reveal, place a TeX instance in the native
path's local space with `x=pgfCapture.bounds[0]` and `y=0`, applying the same
scene transform. This compensates the resource box's TeX baseline origin.

`tests/path_compiler_test.py` invokes installed LaTeX/PGF and verifies expanded
macros and coordinate arithmetic, controls, unit/sign conversion, native
transforms, contours, closure, PGF-generated circle cubics, relation lowering,
control animation addresses, capture provenance, and explicit unsupported-input
errors. Renderer-level browser comparisons should cover full and partial paths,
deformed controls, random seeks and the shared Chalkspace consumer.
