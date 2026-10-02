# Anchors and text placement (PR 09)

An anchor is a measured or analytic point with an explicit coordinate space.
The shared operation runtime resolves it after its text, shape and transform
dependencies. SVG, Canvas, the player and video consume the resulting scene.
No renderer reconstructs a baseline from visible glyph paths.

## TeX interface

Load `texloom-anchors` alongside the existing scene packages. Sources and targets
must already be declared, except that graph declaration order is immaterial:

```tex
\usepackage{texloom-anchors}

% Raw TeX node: place the midpoint of its baseline at a scene point.
\loomplace[anchor=base]{formula}{[240,180]}

% Pair-valued separation uses square brackets inside the optional argument.
\loomplace[anchor=north east,innerSep=[2,4],outerSep=1]{other-formula}{[480,180]}

% Resolve an anchor into an existing point node.
\loomanchor{baseline-point}{node:formula}{"base west"}

% orbit is an explicit constructor ID: \loomshape[id=orbit]...
\loomanchor{attachment}{shape:orbit}{{"towards":"destination-point"}}

% PGF groups supply their actual named anchors, including native padding.
\loomanchor{destination-point}{native-node}{"west"}
```

`node:ID` and a bare `ID` both refer to a scene node. `shape:ID` refers to the
`shape` output of a constructor operation, not to its rendered path. Thus a
default constructor ID `shape:ellipse` is written `shape:shape:ellipse`; prefer
an explicit short constructor ID for readable declarations.

### Query and placement options

`\loomanchor[space=scene,id=anchor:TARGET,...]{TARGET}{SOURCE}{JSON}` accepts:

- A JSON string: `center`, the eight compass names (`north east` uses a space),
  `base`, `base west`, `base east`, or `mid`, subject to provider support below.
- A JSON object `{"towards": POINT}` for an analytic border query. The ray starts
  at the provider's center and passes through `POINT`; a zero direction fails.
- Optional `innerSep` / `outerSep` as nonnegative bp numbers or `[x,y]` pairs,
  for example `innerSep=[2,4],outerSep=1`. Shape sources accept only `outerSep`.
- `space=scene`, `local:ID`, `parent:ID`, or `plot:GROUP`. Both the result and
  a border query's target point use that space. A final scene-position binding
  converts the answer into the target point's local coordinates.

`\loomplace[anchor=base west,id=placement:TARGET,...]{TARGET}{POINT}` places a
raw `TexNode` so its selected logical anchor reaches a scene point. It supports
the same text separation options, but has no `space` option. Placement computes
the required baseline origin directly, without a dependency on the target's
previous x/y. It therefore does not introduce a self-read cycle.

`POINT` is one of:

| JSON | Meaning |
| --- | --- |
| `[120,80]` | Literal point in the declared space, in bp. |
| `"P"` | Live position of a point, ellipse or raw TeX node. |
| `{"operation":"coordinate:P","socket":"position"}` | Typed graph output in the same space. |
| `{"expression":"vec2(120bp,80bp+20bp*sin(time/1s*1rad))"}` | Typed point expression; parameters and time remain live. |

A PGF **group** has no generic position socket. Resolve its `center` or another
named anchor into a point, then use that point. `\loomplace` targets raw TeX
nodes; it does not relocate a native PGF group by re-typesetting its content.

Both commands' final arguments use standalone xparse `+v` literal capture,
including multiline JSON. Do not nest them inside another macro argument.
JSON quotes/backslashes use ordinary JSON escaping; arbitrary TeX macros in
expressions are not expanded. Original JSON and decoded nested expressions
are archived under deterministic `anchor-sources/` filenames. Source spans
refer to those exact archived texts, not guessed columns in the original TeX.

## Three providers, distinct measurements

| Provider | Compass / center | Baseline | Border |
| --- | --- | --- | --- |
| Raw TeX node | Padded logical rectangle | Unpadded `base`, `base west`, `base east` | Logical rectangle |
| Circle, ellipse, rectangle, rounded rectangle | Analytic geometry | Unsupported | Analytic boundary |
| Measured PGF node group | Only captured native names | Native measured names | Unsupported; no inferred boundary |

Raw TeX logical bounds are `[0,-height,width,height+depth]`. Ink bounds describe
what was painted and remain separate. `\phantom`, overhanging text, descenders
and tall fractions therefore cannot silently change the meaning of a baseline.
`TexNode.scale` scales resource metrics and ink first; explicit separation then
uses node-local bp. Text compass/border anchors include inner plus outer
separation. Baseline anchors refer to the unpadded logical box.

Measured PGF anchors already include authored options. Any explicit separation
override, including zero, is rejected; set `inner sep` / `outer sep` in the
native `\loomnode` options instead. `mid` is supported only when PGF actually
measured it; raw resources have no font x-height measurement. Arc and polyline
constructors are not closed area anchor providers in this version.

Ellipse diagonal names follow PGF's 45-degree **parametric** convention. This
differs from a 45-degree ray through a noncircular ellipse; use a border query
for a ray intersection. North means negative y in provider-local coordinates.
Parent rotations, reflections and nonuniform scales are applied afterwards;
space conversions are explicit and required singular inverses fail.

## Provider API

The public `src/index.ts` entry exports `AnchorProvider`, `AnchorName`,
`AnchorQuery`, `TextMetrics`, `anchorNames` and these functions:

```ts
createShapeAnchorProvider(primitive, outerSep = [0, 0]);
createTextAnchorProvider({width, height, depth}, inkBounds, {
  innerSep: [0, 0], outerSep: [0, 0], revision: 'source-content-id'
});
createMeasuredAnchorProvider({center: [0, 0], mid: [0, -2]}, {
  logicalBounds: [0, -8, 20, 10], inkBounds: [0, -7, 19, 9],
  revision: 'measurement-source-id'
});
anchorPosition(provider, {kind: 'named', name: 'north east'});
anchorPosition(provider, {kind: 'border', direction: [1, -1]});
```

Constructor option objects and their fields are optional. All three constructors
return detached, deeply frozen `DeepReadonly<AnchorProvider>` snapshots;
`anchorPosition` returns a fresh `[x,y]` pair. Core border queries take a local
direction vector, while the authored graph/TeX query takes a target point.
Bounds use `[minX,minY,width,height]`. Core revisions encode geometry or metrics,
ink, separation, measured coordinates and any supplied revision seed in canonical
order. The runtime supplies a content fingerprint covering text source and vector
items, so equal box dimensions do not imply equal resource identity.

## Opt-in native PGF capture

Loading `texloom-anchors` writes a capture-profile record. Only that profile
adds an extra resource preamble and records:

```ts
group.anchorMetrics = {
  kind: 'pgf', shape: 'rectangle',
  logicalTextBox: [x, y, width, height],
  textMetrics: {width, height, depth},
  innerSep: [x, y], outerSep: [x, y],
  alignment: 'right', revision: 'content-derived SHA-256'
};
```

The hook measures the actual `pgfnodeparttextbox` before PGF consumes it, after
PGF's automatic outer-separation adjustment. It measures all four logical text
corners through PGF's saved node transform. `logicalTextBox` is their axis-aligned
bound in group-local coordinates, even with native rotation or `transform
shape`; `textMetrics` retains the untransformed TeX dimensions. Neither field
is the whole picture's box or its ink bounding box. The profile captures the
main text part of a `\loomnode`, not separate logical boxes for every part of
arbitrary multipart nodes. Alignment records explicit standard `align` choices
(`natural` if none); it is not a reconstruction of arbitrary custom paragraph
macros. Extra `base west` and `base east` anchors are recorded when available.

Revision seeds contain canonical measurements, anchors and the resource's
source digest, excluding temporary run paths. Existing scenes without this
package retain the historical resource preamble and capture output. Existing
groups with only an `anchors` map still work; their revisions derive from
those measurements. Capture-only metadata is an optional 0.2 extension;
declarative anchor operations use Bundle 0.3's existing graph contract.

## Runtime and diagnostics

Anchor inputs and placement lower to existing typed `midpoint` operations with
identical a/b inputs; a non-scene anchor output adds `transformPoint`. They are
ordinary graph dependencies and position bindings, with the same writer and
cycle rules. Text metrics, shape outputs, nested point inputs and transform
ancestors participate in scheduling. Every absolute-time sample resolves
current values afresh; no previous frame is used as an anchor cache.
`createEvaluator` snapshots its source bundle: changing the caller's resources
after preparation does not affect it. Prepare a new evaluator after recompilation
to consume changed fonts, source content or measurements.

`frame.anchors` records resolved provider metadata, output space and point under
the input's graph path. Providers expose logical and ink bounds separately when
available. A placement entry's point is the computed **baseline origin**.
Unsupported names, unmeasured PGF borders, unknown sources, mismatched spaces
and invalid padding fail explicitly. Public sampling and renderer APIs remain
unchanged.

## Example and verification

```sh
python tools/build.py examples/anchor-layout.tex --out build/anchor-layout --video
python -m unittest tests.anchor_compiler_test -v
```

The twelve-second example aligns a fraction, integral and limit on one baseline,
then connects a changing ellipse boundary to a moving native PGF node. Phase
and radius remain editable in the player. Real-TeX tests cover baseline/depth,
phantom height, overhang, asymmetric padding, alignment, transformed logical
corners, raw formula placement, shape borders, deterministic revisions and
historical opt-out. The complete port gate keeps all four old scene fixtures
unchanged.

The PGF concepts are described in its [official manual](https://pgf-tikz.github.io/pgf/pgfmanual.pdf),
especially nodes, anchors and shape geometry. This integration reads PGF's
executed measurements; it does not parse general TikZ syntax or claim complete
PGF shape/anchor compatibility. Arbitrary artwork does not supply an analytic
border, and evaluation never re-typesets TeX at runtime.
