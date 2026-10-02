# PR 10 — Reusable curve operations

Trim, resample, reverse and join editable paths in the shared typed graph. The
result is a `path2d` value that another operation can consume before a renderer
sees it. Sampling exposes position, direction, distance and source-segment
information from that same value.

## Build the example

```sh
python tools/build.py examples/curve-operations.tex --out build/curve-operations --video
python -m unittest tests.curve_compiler_test -v
```

The twelve-second **A curve is more than a stroke** example trims a native PGF
cubic, places nine markers at equal arc-length fractions, displays their polyline
and moves a probe along the reversed curve. End and phase parameters remain live
in the player. The original curve, exact subcurve and sampled polyline are
separate objects.

## TeX commands

Load `texloom-curves` alongside the scene frontend. Targets must already exist:
curve operations bind a path's geometry; sampling binds a point's position.

```tex
\usepackage{texloom-curves}

% Inside a scene with paths source, trimmed, polygon and backwards, and point P.
\loomcurve[id=extract,mode=parameter]{trimmed}{trim}{
  {"path":"source","start":0.1,"end":"0.75+0.1*sin(time/1s*1rad)"}
}
\loomcurve{polygon}{resample}{
  {"path":{"operation":"extract","socket":"path"},"count":9}
}
\loomcurve[id=backwards]{backwards}{reverse}{
  {"path":{"operation":"extract","socket":"path"}}
}
\loomcurvesample{P}{
  {"path":{"operation":"backwards","socket":"path"},"parameter":"time/12s"}
}
```

| Command operation | Required JSON inputs | Typed runtime operation |
| --- | --- | --- |
| `trim` | `path`, `start`, `end` | `trimPath@1` |
| `resample` with count | `path`, `count` | `resamplePathCount@1` |
| `resample` with spacing | `path`, `spacing` | `resamplePathSpacing@1` |
| `reverse` | `path` | `reversePath@1` |
| `join` | `a`, `b` | `joinPaths@1` |
| `\loomcurvesample` | `path`, `parameter` | `sampleCurve@2` |

Resampling requires exactly one of `count` or `spacing`. All JSON objects may
also supply `tolerance`; it cannot be supplied in both JSON and options. Unknown
options, unknown inputs, duplicate JSON keys and nonfinite values fail explicitly.

### Options

| Option | Default | Applies to / meaning |
| --- | --- | --- |
| `id` | `curve:<target>` or `sample:<target>` | Operation ID; unique in the shared graph |
| `space` | `scene` | `scene`, `local:node`, `parent:node` or `plot:group` |
| `tolerance` | `0.05` | Positive numerical length/inversion budget in the selected space's bp |
| `contour` | `-1` | All except join: whole path, or a zero-based contour index |
| `mode` | `length` | Trim and sample: `length` or `parameter` |
| `wrap` | `false` | Trim: permit a decreasing interval on one closed contour |
| `join` | `separate` | Join: `separate`, `coincident` or `bridge` |
| `tangent` | absent | Sample: an existing point target for the tangent tip |
| `distance` | `12` | Sample with `tangent`: signed tangent-tip offset in the selected space |

For example, `\loomcurvesample[tangent=Q,distance=20]{P}{...}` places `Q` at
`position + 20*tangent`. It does not create a visible arrow; a line or other
consumer can connect the points. This lowers through the historical
`offsetPoint` operator: its distance socket has unit `1`, while the coefficient
here represents bp in the selected coordinate space. Supplying `distance`
without a tangent target is rejected.

The frontend reserves `<id>:local` for path-space conversion, `<id>:scene` for
point conversion, and `<id>:direction` / `<id>:direction:scene` for the optional
tangent tip. Avoid using those generated IDs for another declaration.

## Inputs, spaces and dependencies

A path input is either an editable path node ID, such as `"source"`, or a typed
output reference, such as `{"operation":"extract","socket":"path"}`. A node
read uses its **current evaluated geometry** and converts from its local space
into the operation's space, including current ancestor transforms. Static SVG
`d` strings are not implicitly parsed into editable geometry.

Scalar inputs accept finite numbers, typed expression strings, output references,
or `{"node":"driver","property":"r"}` for a supported scalar property. Numeric
progress and counts are dimensionless; numeric spacing and tolerance receive
`bp`. Expression units must match, for example `"18bp+2bp*sin(time/1s*1rad)"`
for spacing. See [expressions](expressions.md) for the supported language.

Outputs retain their declared space. A path binding converts the result into the
target's local space with `transformPath` when needed. Sample point bindings
convert to scene space when needed, then use the normal position sink. Existing
target transforms therefore apply once. Singular required inverses fail.

Length, spacing, tolerance and unit tangents are measured in the operation's
chosen Euclidean coordinate space. A later nonuniform transform changes visible
distances and spacing; these are not screen-pixel guarantees. Choose scene space
when equal distances in the final scene are required.

Geometry reads, output references, scalar-property reads and transform ancestors
participate in the common dependency plan. A source can be animated or written
by an earlier dependency. Reading a path and writing that same path through the
operation creates a cycle; use a distinct output target. Compilation prepares
the full runtime plan and rejects such cycles before publishing the bundle.

## Progress and contours

`start`, `end` and sample `parameter` must be finite and in `[0,1]`; these
operations do not silently clamp them.

- **Length mode** maps normalized progress to cumulative measured arc length.
- **Parameter mode** gives each drawable line or cubic an equal fraction of the
  progress interval, then uses that segment's own parameter. It is not a global
  cubic parameter or an equal-distance traversal.
- A nonzero implicit closing edge participates as a line. Zero-length segments
  do not receive progress. Segment boundaries select the following segment;
  progress one selects the last endpoint.

`contour=-1` traverses contours in stored order for trim and sample. Gaps between
disconnected contours contribute no length and receive no artificial connector.
A sample can jump across a contour boundary. Trim preserves the resulting
disconnected pieces. Selecting a contour index restricts the output or sample
to that contour; unselected contours are not passed through.

Resampling always treats each selected contour independently. `count=9` means
nine samples **per contour**, not nine samples divided across the whole path.
Reverse reverses both the selected contour order and the direction of every
selected contour.

### Closed trim and wrap

Normal trim requires `start <= end`. With `wrap=true`, exactly one selected
contour must be closed; a decreasing range runs from start to one, then from
zero to end. Whole-path wrap is allowed only when the path has one closed
contour. Use a contour index otherwise.

The interval `[0,1]` preserves the selected geometry and closure. Partial trims
are open unless they retain a whole closed contour. `start=end` produces an
empty, open contour at that location, not a full lap; enabling wrap does not
change this convention. Cubics are split with their control geometry preserved.
Length-mode cut locations are numerically inverted, while the resulting pieces
remain genuine cubic subcurves rather than flattened approximations.

## Resampling and joining

Resampling returns a **polyline**, using equal arc-length fractions in the TeX
frontend and typed graph. An open contour includes both endpoints. A closed
contour samples `[0,1)` and adds a closing edge, so the first sample is not
duplicated as a separate sample.

Count must be an integer from 2 through 65536; a drawable closed contour needs
at least three samples. With positive spacing `h` and measured contour length
`L`, the chosen sample count is:

```text
open:   max(2, ceil(L/h) + 1)
closed: max(3, ceil(L/h))
```

The ceiling uses the measured Float64 ratio directly, without snapping near
integers. Floating-point rounding just above an integer can therefore add one
subdivision; numerical tolerance is not a sample-count rounding threshold.

Spacing chooses an equal subdivision whose source arc-length step is at most
the requested spacing, subject to the numerical length tolerance. It does not
place samples at exact multiples of `h` followed by a short remainder. A contour
without drawable segments remains an empty contour at its original start.
The runtime limits total samples and output segments to 131072, in addition to
the per-contour count limit.

```tex
\loomcurve[join=bridge]{combined}{join}{{"a":"first","b":"second"}}
```

| Policy | Result |
| --- | --- |
| `separate` | Concatenates the contour lists, retaining open/closed state and adding no connectors. |
| `coincident` | Stitches open contours in input order; adjacent endpoints must be exactly equal. |
| `bridge` | Stitches open contours and inserts straight segments across unequal endpoints. |

Coincidence is strict coordinate equality, not a tolerance-based snap. Both
stitching policies reject closed contours; explicitly trim a closed curve into
an open portion first. Bridge segments are recorded as synthetic geometry.
Joining does not perform boolean union, nearest-endpoint matching or automatic
reversal. Generated contour/segment IDs are deterministic; provenance retains
the source identities.

## Sampling outputs and metadata

`sampleCurve@2` exposes these reusable typed sockets:

| Socket | Meaning |
| --- | --- |
| `position` | Point in the selected space |
| `tangent` | Unit vector in the direction of increasing progress |
| `normal2d` | Vector `[-tangent.y, tangent.x]` in that same space |
| `distance` | Measured distance from the selected traversal's start, in bp |
| `totalLength` | Measured total length of the selected traversal, in bp |
| `localParameter` | Parameter within the selected current segment, in `[0,1]` |

The normal is a numeric positive quarter-turn, which appears clockwise in a
y-down scene. It is not a separately computed world-space normal after later
nonuniform scaling. Endpoint tangents use one-sided limits where possible.
Sampling an empty/degenerate curve or an interior stationary point with no
defined tangent fails explicitly.

`frame.curves.operations[operationId]` contains `{space, report, provenance}`.
Reports identify the operation, `exact` or `polyline` representation, input and
output segment counts, tolerance, and relevant resampling/join settings.
`frame.curves.samples[operationId].sample` contains position, tangent, `length`
(the distance socket), total length, current contour/segment IDs, local
parameter, mapping kind and `sourceRefs`; its surrounding entry records space.

Provenance version 1 covers every current segment. Each source reference records
the original contour/segment IDs, source parameter interval, closing-edge flag
and an optional geometry identity. Mapping is `exact` for a retained subcurve,
`approximate` for sampled chords, or `synthetic` for a newly inserted bridge.
Reverse reverses source intervals. A sample on an exact segment resolves an
original parameter; a sample on an approximate chord retains the contributing
source ranges rather than claiming an exact original point.

Output references, `pathValue` and `transformPath` preserve lineage. Reading an
editable node seeds provenance from its **current** geometry with that node's
ID. Rereading a bound output node therefore starts a fresh identity; chain typed
output references when original source intervals matter. A path value with no
provenance, such as a literal or shape-conversion output, is seeded at its first
curve consumer with `curve-input:` plus `JSON.stringify([operationId,socket])`.

A forward affine projection can collapse an implicit closing edge while other
segments remain drawable. The provenance-aware transform preserves that edge
as an explicit zero-length line with a collision-free ID, retaining its source
`closing:true` flag. Sampling skips it like other zero-length segments.

## Numerical scope and core API

Tolerance controls numerical length measurement and length-to-parameter
inversion. It is not a maximum geometric deviation for the resampled polyline,
a tangent-error bound or a join snapping radius. Use an appropriate sample count
or spacing for the visual approximation. Requests below representable precision
or beyond subdivision/output budgets fail instead of silently degrading.

The public entry point exports `trimCurveGeometry`, `resampleCurveGeometry`,
`reverseCurveGeometry`, `joinCurveGeometries`, `sampleCurveGeometry`,
`seedCurveProvenance`, `assertCurveProvenance`, `transformCurveInput` and their
curve types. `transformCurveInput({geometry, provenance?}, matrix)` keeps geometry
and lineage consistent through affine transforms. Core scope
uses `{kind:'whole'}` or `{kind:'contour',contourId:'...'}` rather than an index.
The new core API, TeX frontend and typed graph default to **length mode**.
Pass `mode:'parameter'` explicitly for equal progress per drawable segment in
core trim or sample operations. Core count resampling also accepts parameter
mode; spacing resampling requires length mode. Historical `sampleGeometry`
retains its parameter-mode default.

The graph encodes `mode` as 0/1 for parameter/length, `wrap` as 0/1, and join
policy as 0/1/2 for separate/coincident/bridge. Path operations are version 1;
the expanded sampler is version 2. Historical `sampleCurve@1` remains unchanged.
Declarations append to `operationGraph` version 1 on Bundle 0.3. Loading the
package without declarations leaves the original bundle version unchanged.

Every absolute-time evaluation resolves fresh geometry and values. Existing
`evaluate`, `createEvaluator`, `prepareScene`, SVG, Canvas and video entry points
remain unchanged and consume the same evaluated frame. These are 2D line/cubic
operations, not general Blender geometry-node compatibility, NURBS processing,
arbitrary path morphing or a geometric constraint solver.

## Literal capture and diagnostics

Both commands use standalone xparse `+v` capture for the final JSON object.
Multiline inputs are supported. Place commands directly in source rather than
inside another macro's pre-scanned argument; use ordinary JSON escaping for
quotes and backslashes. Expressions are not arbitrary expanded TeX code.

Exact original JSON is archived under
`curve-sources/scene.tl-curve-N.inputs.txt`. Decoded expression strings receive
their own deterministic files, such as
`scene.tl-curve-N.end.expression.txt`. Source spans use one-based Unicode
codepoint positions and an exclusive end in those exact archived texts; they
do not claim original TeX columns. Dynamic invalid values receive diagnostics
at the evaluation time where they occur.
