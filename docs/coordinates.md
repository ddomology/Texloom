# PR 07 — Coordinate operations in explicit spaces

Coordinate constructions are typed operations in the existing `operationGraph`.
They read current point positions, typed scalar expressions and explicit space
transforms. The same compiled dependency plan orders them with tracks,
expressions, deformations and downstream consumers.

## Build the moving triangle

```sh
python tools/build.py examples/triangle-coordinates.tex --out build/triangle-coordinates --video
```

Open `build/triangle-coordinates/player.html`. The triangle moves inside an
explicit plot chart whose y-axis is reflected so positive local y points upwards.
The midpoint and perpendicular foot update with the vertices. A ring shows the
nearest point on the segment: it stays at the endpoint when the perpendicular
foot lies outside the segment. Phase and horizontal swing are live parameters.

The demo converts chart points into scene points before passing them to legacy
line and text-attachment consumers that use a shared numerical coordinate space.
It does not silently change those legacy consumers' semantics.
Its source animation binds scalar `x` and `y` components in chart-local coordinates.
An expression binding to the whole `position` property is a scene-space sink and
would instead inverse-transform the supplied vector into that node's local space.

## TeX syntax

```tex
\usepackage{texloom-coordinates}

% A, B and M must already exist as scene nodes; M is a point node.
\loomcoordinate{M}{midpoint}{{"a":"A","b":"B"}}
\loomcoordinate[id=blend]{P}{lerpPoint}{{"a":"A","b":"B","factor":1.25}}
\loomcoordinate[space=plot:chart]{F}{projectLine}{{"point":"C","a":"A","b":"B"}}
```

The arguments are target point ID, operator name and a literal JSON input
object. The default operation ID is `coordinate:<target>` and the default space
is `scene`. The outer braces delimit the TeX argument; the inner braces belong
to JSON. An alternate verbatim delimiter also works:

```tex
\loomcoordinate{M}{midpoint}|{"a":"A","b":"B"}|
```

`space` and `id` are the only options. IDs must be unique in the combined
operation graph. A non-scene declaration also reserves `<operation-id>:scene`
for its generated conversion operation. Target points have the usual exclusive
position-writer rule; declaring a coordinate does not create its target node.

## Supported constructions

| Operator | Inputs | Result |
| --- | --- | --- |
| `midpoint` | `a`, `b` | `(a+b)/2` |
| `lerpPoint` | `a`, `b`, optional `factor` | `a + factor*(b-a)`; factor defaults to `0.5` and may extrapolate |
| `pointTowards` | `a`, `b`, `distance` | A signed distance from `a` in the direction of `b` |
| `rotatePoint` | `point`, `center`, `angle` | Rotate around the center in the selected space |
| `projectLine` | `point`, `a`, `b` | Orthogonal projection onto the infinite line through `a,b` |
| `projectSegment` | `point`, `a`, `b` | Projection with its line parameter clamped to `[0,1]` |

Every construction returns a `position` socket. Both projections additionally
return a dimensionless `parameter` socket; the segment version returns the
clamped value. Distance and projection require distinct reference endpoints.
Coincident endpoints, nonfinite outputs, incompatible units and missing references
produce diagnostics instead of fallback geometry.

### Point and scalar inputs

Point sockets accept:

- A node ID string, such as `"A"`. Its current position is converted to the
  operation's selected space at each sample.
- A two-number literal such as `[40,20]`, measured in bp coordinates of that space.
- An output reference such as `{"operation":"blend","socket":"position"}`.

Dynamic node references support point positions, ellipse centers and TeX baseline
origins. They include the referenced node's own transform and its ancestor chain.
They do not interpret a group ID as a point or infer a TikZ shape anchor.

Scalar sockets accept finite numbers, expression strings or output references.
Numbers receive the socket's required unit: `1` for a factor, `bp` for distance,
and `rad` for angle. Expression strings must themselves have those units:

```tex
\loomcoordinate{P}{lerpPoint}{{"a":"A","b":"B","factor":"0.5 + 0.5*sin(1rad*time/1s)"}}
\loomcoordinate{Q}{pointTowards}{{"a":"A","b":"B","distance":"40bp"}}
\loomcoordinate{R}{rotatePoint}{{"point":"B","center":"A","angle":"pi*1rad/6"}}
```

An angle number is radians, including when authored in TeX. Convert degrees
explicitly, for example `"30*pi*1rad/180"`. A dimensionless string `"30"` is not
a radian expression. The new coordinate sockets enforce `1`, `bp` and `rad`.
The reusable `scalarValue` operator is explicitly dimensionless; it cannot strip
the unit from a length or angle. Other unannotated legacy scalar sockets retain
their prior numeric compatibility.

Expression inputs can read clamped scene `time` and parameters declared through
`\loomparameter`. They use the [shared expression language](expressions.md).
They do not read node coordinates by arbitrary identifier; point sockets are the
explicit route for live node positions.

Output references keep their declared coordinate space and units. There is no
implicit conversion between differently typed output sockets. For example, the
projection's `parameter` output can drive a compatible interpolation factor.

## Spaces and metrics

| TeX option | IR reference | Coordinates and Euclidean metric |
| --- | --- | --- |
| `space=scene` | `{"kind":"scene"}` | Scene coordinates before the camera |
| `space=local:A` | `{"kind":"local","node":"A"}` | Coordinates before A's own transform |
| `space=parent:A` | `{"kind":"parent","node":"A"}` | Coordinates in A's parent; numerically scene space if A has no parent |
| `space=plot:chart` | `{"kind":"plot","node":"chart"}` | Local coordinates of an explicitly declared group chart |

Space identities are symbolic. `parent:A`, `local:B` and `scene` remain distinct
even when their matrices currently coincide. A plot chart uses the existing
translation/rotation/scale hierarchy, including reflection. It does not provide
logarithmic axes, arbitrary nonlinear charts or automatic PGFPlots import.

**The chosen space defines the metric.** Affine interpolation gives consistent
results under an affine change of coordinates. Euclidean distance, rotation and
orthogonal projection depend on the chosen metric: a nonuniform scale can make a
local projection differ from a scene projection. A distance of `40bp` in a local
space is 40 local coordinate units before scene scaling.

Rotation follows the numeric matrix `[[cos(a),-sin(a)],[sin(a),cos(a)]]`.
It appears clockwise in the normal y-down scene and counterclockwise in a
y-reflected plot chart. PGF's usual display is y-up; a PGF angle cannot be copied
into a y-down scene while assuming the same visual direction.

Space conversions use the current frame's transforms, excluding camera pan and
zoom. Forward conversion from a singular source is meaningful and allowed when
the destination is invertible. Conversion into a singular destination is rejected
because its inverse is undefined. Tracked inverse-space singularities are checked;
dynamic singularities also fail when sampled.

## Lowering and execution

For a scene-space midpoint, the frontend emits one operation and one binding:

```json
{
  "id": "coordinate:M", "operator": "midpoint", "version": 1,
  "spaces": {"space": {"kind":"scene"}},
  "inputs": {
    "a": {"kind":"node","node":"A","property":"position","space":{"kind":"scene"}},
    "b": {"kind":"node","node":"B","property":"position","space":{"kind":"scene"}}
  }
}
```

The binding writes `position` on M from this operation's `position` output.
For a non-scene space, the frontend inserts an existing `transformPoint`
operation whose transform input is a live `spaceTransform` from the selected
space to scene space. The scene-position binding then inverse-transforms the
result into the target's own local `x,y`. Both conversions happen at sample time.

This extends `operationGraph` version 1 on Bundle 0.3; it adds no separate scene
program. Existing graph operations and bindings are preserved when declarations
are appended. The dependency plan includes live point properties, source and
destination transform ancestors, and output references. Cycles and overlapping
writers are diagnosed. Public `evaluate`, `createEvaluator` and `prepareScene`
sampling APIs remain in place, with fresh values on every absolute-time sample.

## Literal capture and provenance

The final TeX argument is multiline verbatim JSON. JSON rules still apply:
backslashes and quotes inside a JSON string must be escaped as JSON. They do not
need an additional TeX escaping layer. Duplicate JSON keys, nonfinite numbers,
unknown options/operators/sockets and malformed input shapes are rejected.
Commands must appear directly in source rather than inside another macro's
already-scanned argument. No general TikZ `calc` parser is introduced.

TeX writes only a generated filename into declaration JSON. Python archives the
exact input body under `coordinate-sources/scene.tl-coordinate-N.inputs.txt`.
The operation and binding source spans cover that archived JSON. Each decoded
scalar expression gets a separate exact text artifact, for example
`coordinate-sources/scene.tl-coordinate-N.angle.expression.txt`, and its own
source span. Expression offsets therefore refer to decoded expression text,
not to differently escaped JSON text.

Spans use one-based Unicode codepoint positions and exclusive ends. Archive
filenames are deterministic across compiles; per-run original files remain in
compiler provenance. No span claims original TeX source columns. Loading the
package without declarations leaves the original bundle version and shape intact.

## Verification and limits

`tests/coordinate_compiler_test.py` runs actual TeX/PGF `calc` constructions for
midpoint, interpolation, extrapolation, distance, rotation and projection, then
compares their numeric coordinates with the compiled runtime. Its 0.025bp
tolerance accommodates PGF fixed-point dimension rounding. Separate capture tests
check literal text, exact decoded-expression spans, deterministic compilation and
explicit non-scene lowering.

These are six 2D coordinate constructions, not general symbolic geometry or a
TikZ parser. The chart is affine, point references are explicit, and all output
renderers consume the same evaluated positions. Additional constructions can
reuse the common graph, types, dependency scheduling and space conversions.
