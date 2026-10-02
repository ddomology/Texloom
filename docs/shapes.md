# PR 08 — Parametric shapes

A shape keeps its mathematical parameters as a typed `shape2d` value. Separate
operations convert it into a renderable path or sample its analytic definition.
Both operations share the same current shape; a moving marker need not infer a
circle or ellipse from its rendered approximation.

## Build the example

```sh
python tools/build.py examples/parametric-shapes.tex --out build/parametric-shapes --video
```

Open `build/parametric-shapes/player.html`. The main ellipse arc changes radius
and sweep while its moving marker and endpoints are sampled from the analytic
arc. Six small examples show the supported constructors. Radius and phase are
live controls; the source also demonstrates a scalar node-property input and a
point-expression item in a polyline.

## TeX construction and output

```tex
\usepackage{texloom-shapes}

% circle-path is an existing path target; O is an existing point node.
\loomshape[tolerance=0.1,maxSegments=4096]{circle-path}{circle}{
  {"center":"O","radius":"40bp+10bp*sin(1rad*time/1s)"}
}
```

The arguments are an existing path target, constructor name and literal JSON
input object. The path may begin as a small placeholder; its geometry is replaced
by the compiled graph. The constructor does not implicitly create a renderer node.
Its default operation ID is `shape:<target>`.

| Constructor | Inputs |
| --- | --- |
| `circle` | `center`, `radius` |
| `ellipse` | `center`, `rx`, `ry` |
| `arc` | `center`, `rx`, `ry`, `startAngle`, `sweepAngle` |
| `rectangle` | `origin`, `width`, `height` |
| `roundedRectangle` | `origin`, `width`, `height`, `cornerRadius` |
| `polyline` | `points`, optional `closed` (defaults to false) |

Radii, width and height must be positive. The corner radius lies from zero to
half the smaller rectangle dimension. Arcs have a nonzero signed sweep with
absolute value at most `2*pi` radians and remain open, including full-turn arcs.
Consecutive polyline vertices must differ. A closed polyline does not repeat its
first point as its last; `closed` supplies the closing edge. Invalid dynamic
values receive diagnostics at the sample where they occur.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `id` | `shape:<target>` | Constructor operation ID |
| `space` | `scene` | `scene`, `local:node`, `parent:node` or `plot:group` |
| `profile` | `cubic` | `cubic` or `polyline` path conversion |
| `tolerance` | `0.1` | Positive approximation budget in the selected space's bp |
| `maxSegments` | `4096` | Integer output budget from 1 through 131072 |

The frontend reserves `<id>:path` for conversion and, when needed, `<id>:local`
for a live path-space conversion. Use unique IDs across the common graph. The
target geometry has one writer; another geometry binding, deformation or
overlapping control writer is a conflict.

## Inputs and units

Point inputs accept a live node ID string, a literal `[x,y]` pair in the selected
space, a typed operation output, or an explicit point-expression object:

```json
{"expression":"vec2(240bp,180bp+20bp*sin(1rad*time/1s))"}
```

A point expression must return a `vec2` in bp. The expression's numbers are
coordinates in the shape's chosen space. A node reference converts the live node
position into that space using its own and ancestor transforms.

Scalar inputs accept finite numbers, expression strings, output references, or
an explicit current-node-property reference:

```json
{"node":"radius-driver","property":"r"}
```

This lets a field, expression or track produce a point radius that a circle or
ellipse consumes. Property inputs are restricted to supported scalar properties;
their actual units must match the socket. They are explicit graph reads, not
arbitrary JavaScript property access. The property must actually contain a finite
numeric value at evaluation time; an omitted style property or renderer default
is not synthesized into a property input.

Numeric radii, dimensions and corner radii receive `bp` units. Numeric angles are
radians. Angle expressions must include angle units, for example
`"pi*1rad/2"`; the string `"90"` is dimensionless. See the
[expression guide](expressions.md) for supported functions and typed parameters.

The points of a polyline form an explicit list whose items use the same point
input forms. The runtime retains dependencies for every item:

```tex
\loomshape{outline}{polyline}{
  {"points":["A",[80,40],{"expression":"vec2(100bp,60bp)"}],"closed":true}
}
```

The TeX frontend converts JSON `true`/`false` to the constructor's dimensionless
`1`/`0` closed flag. A dynamic closed expression must return exactly zero or one.
Output references use `{"operation":"id","socket":"name"}` and keep their
declared type, units and space.

## Analytic sampling

```tex
\loomshapesample{P}{shape:circle-path}{"time/12s"}
```

The arguments are an existing point target, constructor operation ID and a literal
JSON scalar input. The final argument above contains a JSON **string**. A number
such as `{0.25}` samples at a fixed parameter. The expression parameter is
dimensionless and must remain in `[0,1]`; it is not silently clamped.

Options are `id` (default `sample:<target>`) and `space` (default `scene`). The
sampler space must match the constructor's symbolic space. The sampler emits a
`sampleShape` operation with `position` and unit `tangent` outputs. The command
binds position to the target point; its tangent remains available as a typed
output for other graph consumers.

Circle and ellipse sampling follows angular parameter, and arc sampling follows
`startAngle + parameter*sweepAngle`. It is independent of the rendered path's
subdivision count; ellipse sampling is not arc-length sampling. Rectangles,
rounded rectangles and polylines use the exact perimeter fraction. Tangents at
joins follow the outgoing piece, while parameter one uses the incoming tangent.
Positive angles use the normal numeric rotation formula,
appearing clockwise in y-down scene coordinates and counterclockwise in a
y-reflected plot chart. Consult [coordinate spaces](coordinates.md) for the
metric and reflection conventions.

## Path conversion and space boundaries

The emitted graph separates responsibilities:

```text
live inputs → constructor → shape2d
                            ├─ sampleShape → analytic point / tangent
                            └─ shapeToCubic or shapeToPolyline → path2d
                                      → transformPath → target-local geometry
```

The constructor returns parameters, without evaluating a renderer. The chosen
path profile and tolerance control approximation. Tolerance is measured in the
shape's selected coordinate space before any later affine transform. It is not
a screen-pixel budget after scaling, nor a derivative-error budget. The renderer
receives ordinary evaluated line/cubic geometry and does not recreate shapes.
The recorded bound applies before `transformPath`; arbitrary later affine
scaling or deformation does not inherit that same numerical error guarantee.

The cubic profile uses endpoint values and analytic derivatives to construct
Hermite cubics. Its elliptic-arc bound is `max(rx,ry)*h^4/384` per angular interval.
The polyline profile uses chords with bound `max(rx,ry)*h^2/8`. The runtime adds a
Float64 roundoff allowance, chooses enough subdivisions and checks the resulting
bound. Straight edges remain lines; polylines preserve their authored vertices.
An insufficient segment budget or a tolerance below representable coordinate
precision fails explicitly. These geometric bounds do not certify derivative
error or formally verify the host math library.

If the selected space is not exactly `local:<target>`, a generated `transformPath`
uses a live `spaceTransform` to convert the path into the target's local space.
Thus existing target transforms apply exactly once. A same-space declaration
omits that conversion. Nonuniform scale and reflection are supported by the
existing affine hierarchy; conversion into a singular destination is rejected.

Analytic position sampling uses the normal scene-position binding, including
conversion from the shape space and the target's inverse transform. This differs
from a path geometry sink, which explicitly receives target-local coordinates.

## Runtime metadata and evaluation

`frame.shapes.definitions[constructorId]` records the shape's declared space and
current primitive parameters. `frame.shapes.approximations[pathOperationId]`
records the conversion space and the primitive-to-path report. These records
describe the evaluated sample and preserve the distinction between the analytic
object and its renderable approximation.

The report includes profile, analytic kind, tolerance, maximum error bound,
segment count, closure and precision policy. Each span records the generated
segment ID, its source parameter interval, bound and line/arc origin. Core
`primitiveBounds` returns analytic axis-aligned bounds as `[minX,minY,width,height]`,
independent of the rendered approximation.

All declarations append to `operationGraph` version 1 on Bundle 0.3. Existing
operations and bindings are retained. Recursive point-list inputs, node-property
reads and space transforms participate in the common dependency plan. Every
absolute-time sample creates fresh values; there is no accumulated shape state.
Existing `evaluate`, `createEvaluator`, `prepareScene`, SVG, Canvas and video
entry points continue to consume the shared evaluated scene.

## Literal capture and source locations

The final arguments use multiline verbatim capture. JSON strings require normal
JSON escaping of quotes and backslashes, with no extra TeX escaping layer.
Place commands directly in source, outside another macro's pre-scanned argument.
There is no general TikZ path parser or arbitrary TeX-macro expression expansion.

Only a generated sidecar filename enters the TeX declaration record. Python
archives the exact input JSON at `shape-sources/scene.tl-shape-N.inputs.txt`.
Every decoded scalar or point expression receives its own deterministic text
artifact and exact source span. Nested point expressions include their item index
in the filename, such as `scene.tl-shape-N.points.2.expression.txt`.

Spans use one-based Unicode codepoint positions and an exclusive end. They refer
to archived input/decoded text rather than claiming original TeX columns. Per-run
capture remains in compiler provenance. Loading the package without declarations
does not add a graph or change the original scene version.

## Verification and scope

`tests/shape_compiler_test.py` executes actual PGF circle, ellipse, arc and
rectangle paths and compares their boundaries with generated geometry. It also
checks analytic sampling, exact literal capture, nested expression locations,
profiles, space lowering, property inputs and repeatable compilation.

This stage supplies six 2D primitives, not a general solid-modeling system,
boolean geometry engine, arbitrary SVG-shape importer or implicit TikZ parser.
An analytic shape and an editable path are distinct values connected by explicit
conversion, so later geometry operations can build on the existing path pipeline.
