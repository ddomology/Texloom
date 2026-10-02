# PR 13 — Connections and path labels

Build editable connections from current anchor positions, then place measured
TeX labels along the resulting geometry. All operations run in the shared graph
at absolute time; web, SVG and Canvas/video consume the same evaluated nodes.

## Example

```sh
python tools/build.py examples/connector-labels.tex --out build/connector-labels --video
python -m unittest tests.connector_compiler_test -v
```

The example moves and scales diagram nodes while their connections and labels
follow. The existing `commutative` reference scene remains unchanged.

## Connector authoring

Load `texloom-connectors` alongside the scene frontend. Declare editable path
targets first, with the desired stroke. Arrowhead geometry for these new paths
is a separate PR 14 feature; legacy arrow flags still require legacy connections.

```tex
\usepackage{texloom-connectors}

\loomconnector[route=straight]{edge}{
  {"from":{"anchor":{"source":"node:A","query":"east"}},
   "to":{"anchor":{"source":"node:B","query":"west"}}}
}
\loomconnector[route=orthogonal,order=horizontal]{elbow}{
  {"from":[40,50],"to":[180,130]}
}
\loomconnector[route=cubic]{curve}{
  {"from":[40,50],"to":[180,130],
   "handleA":[90,10],"handleB":[130,170]}
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `route` | `straight` | `straight`, `orthogonal`, or `cubic` |
| `order` | `horizontal` | Orthogonal only: horizontal then vertical, or `vertical` then horizontal |
| `space` | `scene` | Euclidean chart for endpoints, controls and routing |
| `id` | `connector:<target>` | Unique graph operation ID |

All routes require `from` and `to`. Cubic routes require two **absolute control
points**, `handleA` and `handleB`. They are not handle offsets or a bend amount.
The frontend converts the result into the target path's local space before its
geometry binding, so a target transform is applied exactly once.

Point inputs accept `[x,y]`, a position-node ID, an operation output reference,
`{"expression":"vec2(...)"}`, or an inline anchor. Position-node IDs refer to
point, ellipse or raw TeX nodes; a measured TikZ group uses an anchor reference.
Expressions returning points have bp units in the declared chart.

Inline anchors reuse [the anchor contract](anchors.md): `source` is `node:<id>`
or `shape:<operation>`, `query` is a named anchor or `{"towards":<point>}` for a
supported analytic border, and optional `innerSep`/`outerSep` specify padding.
Node transforms, current dimensions, raw TeX scale and shape-output dependencies
participate in the shared execution plan. A measured group does not infer a new
border or accept padding overrides.

Orthogonal routes keep two identified legs even when one has zero length. Their
elbow is `(to.x, from.y)` or `(from.x, to.y)` in the declared chart. A later
rotation or nonuniform transform can change their screen orientation. These are
explicit routing policies; obstacle avoidance and automatic graph layout are
separate features.

## Label authoring

Declare a raw TeX node, then attach its measured anchor to a path. A TikZ wrapper
group is not itself a raw TeX label target.

```tex
\TLMath{label-art}{f_*}
\TLNode{label}{tex}{"resourceId":"label-art","x":0,"y":0}
\loompathlabel[mode=length,at=.5,offset=-12,rotate=upright,anchor=base]
  {label}{{"path":"edge"}}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `id` | `label:<target>` | Unique placement operation ID |
| `at` | `0.5` | Normalized progress in `[0,1]` |
| `mode` | `length` | Arc-length fraction or `parameter` fraction |
| `offset` | `0` | Signed normal distance, bp in the label parent's chart |
| `rotate` | `horizontal` | `horizontal`, directed `tangent`, or `upright` |
| `anchor` | `center` | Named text anchor, including `base`, `base west`, `base east` |
| `contour` | `-1` | Whole path, or a zero-based contour index |
| `tolerance` | `0.05` | Numerical length/inversion tolerance in the parent chart |
| `scale-x`, `scale-y` | Authored local transform scales, otherwise `1` | Nonzero signed local glyph scales |

JSON requires `path`, and may supply `parameter`, `offset`, `tolerance`,
`scaleX`, `scaleY`. Scalar inputs accept numbers, typed expressions, numeric
property references or operation outputs. Duplicate option/JSON values fail.
An expression for offset/tolerance needs bp; progress and scales are dimensionless.
The optional `inner-sep` and `outer-sep` affect text compass anchors while baseline
anchors keep the unpadded TeX baseline.

A path node ID reads current geometry directly into the label parent's space.
An output reference `{operation,socket}` must already have that space. Add an
explicit source `space` to request conversion, for example:

```json
{"path":{"operation":"connector:edge","socket":"path","space":"scene"}}
```

Label placement always uses `parent:<target>`. It has no independent `space`
option. Reparent the label to an untransformed/root group when scene-space
distances or an upright scene-space baseline are required.

### Position, rotation and reflection

Length mode samples cumulative length. Parameter mode follows the
[PR 10 sampler](curves.md): each nonzero drawable segment has an equal interval.
At an interior segment boundary, the following segment supplies the tangent.
For a two-leg orthogonal route, parameter `0.5` is its elbow when both legs are
nonzero. The length midpoint generally differs. No length is assigned to gaps
between disconnected contours.

For unit tangent `(tx,ty)`, the positive normal is `(-ty,tx)`. Texloom coordinates
have positive y downward, so a left-to-right horizontal line's positive offset
is visually below it. Rotation never changes the chosen side of the path.

- `horizontal` uses local angle zero.
- `tangent` aligns the positive local baseline direction with the path tangent.
- `upright` folds that direction into `[-pi/2,pi/2)` in the parent chart.

Negative `scaleX` receives a half-turn adjustment for tangent/upright alignment.
The scale signs still preserve the intended local reflection. Parent transforms,
including reflections and nonuniform scales, are inherited. `upright` does not
cancel a mirrored ancestor or promise horizontal screen-space text through an
arbitrarily transformed parent. There is no camera-dependent placement.

Logical TeX width, height and depth determine anchors, with baseline origin
`(0,0)`. Ink bounds do not recenter a label. The current `TexNode.scale` is read
when measuring its anchor and is applied once by rendering. A label wider than
its path keeps its authored size and anchor; it is not automatically shrunk,
clipped or displaced to avoid collisions.

### Pose ownership and dependencies

Placement owns the target's entire `transform`, `x` and `y`. It computes a
translate/rotate/scale matrix and resets x/y to zero. Competing writers fail
through the normal graph validation. Other appearance properties and raw TeX
scale can be animated separately.

The new `textAnchor` input reads resource metrics and live TeX scale without
reading the pose being written. This avoids a self-dependency while still
following an upstream scale writer. A path that depends on the same label's
placed position is a real cycle and is diagnosed.

Zero-total-length paths and undefined interior tangents propagate the sampler's
diagnostic. Invalid policies, scales, units, progress, contours and required
inverse transforms fail explicitly, with source spans. No previous frame is used
as a fallback.

## Graph API

| Operator | Spaces | Inputs | Outputs |
| --- | --- | --- | --- |
| `connectStraight@1` | `space` | Point `from`, `to` | `path` |
| `connectOrthogonal@1` | `space` | Point `from`, `to`; `order=0` horizontal-first / `1` vertical-first | `path` |
| `connectCubic@1` | `space` | Point `from`, `to`, `handleA`, `handleB` | `path` |
| `placePathLabel@1` | `space`, `label` | `path`, local point `anchor`; `parameter=.5`, `mode=1`, `offset=0bp`, `rotation=0`, `contour=-1`, `tolerance=.05bp`, `scaleX=1`, `scaleY=1` | `transform`, `x`, `y`, `position`, `angle`, `distance`, `totalLength` |

Connector outputs have contour `connector` and stable segment IDs `segment-0`
and, for the second orthogonal leg, `segment-1`. `placePathLabel` maps its `label`
space into `space`; the frontend binds these to the target's local and parent
spaces respectively. Its `position` is the path sample plus normal offset,
`angle` is in radians, and distance outputs are bp. The transform places the
supplied anchor at that position. Pure executors are exported from `src/index.ts`.

`{kind:"textAnchor",node,anchor,innerSep?,outerSep?}` returns a point in that
node's local chart. It is a metrics-only input, unlike an ordinary live node
anchor that includes current placement.

## Compatibility and semantic references

Legacy `\loomconnect` / `\loomlabel`, bend interpretation, static assets,
relations and historical samplers retain their behavior. Merely loading the new
package without declarations does not upgrade a bundle. Declarations use literal
capture, deterministic `connector-sources` archives, typed graph validation and
the standard source-span convention.

PGF's [horizontal/vertical routing](https://tikz.dev/tikz-paths#sec-14.2.2)
and [nodes on paths](https://tikz.dev/tikz-shapes#sec-17.8) are semantic references.
The latter distinguishes Bézier parameter placement and sloped text with an
upright policy. Texloom exposes length sampling and parent-space rules explicitly;
the initial profile does not claim all TikZ placement or edge-routing behavior.
The implementation is original; no upstream source code was copied or translated.
