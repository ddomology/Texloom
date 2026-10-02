# IR contract 0.1 / 0.2 / 0.3

Canonical dimensions are big points (72 per inch), +x right, +y down. TeX
measurements are converted from TeX points (72.27 per inch); original dimensions
and baseline origin are retained in resource provenance. Angles are radians,
time is seconds. Glyph resource coordinates are relative to the TeX baseline.

Node transforms compose as translate × rotate × scale. Parent groups establish
local spaces. Camera x/y are pan offsets from the logical viewport center;
positive values move the camera right/down. Zoom and rotation are around the
viewport center. Output pixel dimensions do not change scene geometry.

A bundle has `version`, `title`, `duration`, `viewport`, `units`, `nodes`,
`resources`, `camera`, `tracks`, `relations`, optional `document`, `provenance`,
and `diagnostics`. The TypeScript contract and its runtime validator are both in
`src/schema.ts`; `tools/validate-bundle.mjs` exposes the same validator to Python.

Vector resources store paint trees, not SVG DOM. Group opacity is compositing
opacity, never distributed onto individual children. Clip paths live in local
user coordinates, with optional affine clip transforms in vector resources.
Logical box and ink bounds are separate, including zero-size/overhanging boxes.

`currentColor` represents TeX foreground paint. Scene fill colors bind foreground
at group/instance boundaries; explicit colored TikZ paint remains explicit.
Setting foreground fill to none makes currentColor transparent. SVG IDs are
renderer-local and not object identities; use a unique render namespace for
multiple embedded SVG documents. This foreground binding applies to groups and
TeX instances. An unfilled path preserves inherited currentColor, allowing an
unfilled connector to use `stroke: currentColor`.

Tracks write supported numeric scalar/vector properties. Key times increase
strictly; exact step-key times select the new key. Outside a track range its
endpoint value is held. Evaluation time clamps to the scene duration. Multiple
writers for a property are rejected rather than given implicit precedence.

Relations are topologically ordered. v0.1 relation participants share a parent
space and have identity local transforms; a shared transformed group works.
Tangent uses the partial derivative with respect to ellipse phase at the current
radii, not the time derivative of a deforming trajectory.

## v0.2 anchors and connections

A group may expose named `anchors` in its local coordinate space. Captured PGF
anchors preserve the shape's outer separation and baseline choices independently
of visible ink bounds. A named TikZ node is a group with one vector-art child;
the child offset aligns PGF's node center with the group's origin.

`connect` reads two `{node, anchor}` references and writes a path's cubic `d` and
`resolvedPath`. It resolves all ancestor transforms, including across parents.
`bend` offsets both cubic control points perpendicularly by the supplied bp in
the path parent's space. Zero bend yields a straight cubic. At parameter 0.5,
the deviation from the chord is 0.75 times bend. It is not a bend angle.

The generated geometry lives in the path's own local space. `resolvedPath`
contains `start`, `c1`, `c2`, `end`; authored bundles cannot supply it. Arrow
flags on a path require a connection relation. Renderer triangle tips coincide
with the endpoints and follow cubic endpoint tangents. `arrowSize` is local bp.

`pathLabel` reads a resolved connection and writes a TeX node's baseline x/y.
`position` is cubic parameter in [0,1], not arc length; `offset` is signed normal
distance in the label parent's space. The positive normal is (-dy, dx): downward
for a rightward line. Logical width/height/depth center the label. Optional `rotate` aligns its
baseline with the tangent while respecting transformed/reflected parents.

All properties have a single writer. Hierarchy and relation dependencies are
checked together for cycles. Runtime singular inverses and undefined connection
directions report typed diagnostics. Evaluation is deterministic at any time.

Scalar-field samples are row-major (y then x), finite values, strictly increasing
sample times, a declared color range, and linear or step temporal interpolation.
The geometry/solver that generated them is external to the renderer.

`createEvaluator` validates, snapshots and freezes the bundle once. Each call
clones mutable node/camera values, evaluates tracks, resolves relations, and
samples fields. The result shares immutable resources. No renderer evaluates
tracks independently; a render frame has only resolved state.

Extensions such as mesh/surface/volume data, typed field operations, constraints,
simulation bakes and richer document semantics require versioned schema changes.
An unknown kind fails validation. No arbitrary JS/Python closure is serialized.

## v0.3 editable path geometry

A path may supply `geometry: {contours: [...]}`. Each contour has a unique `id`,
a `start: [x,y]`, `segments`, and optional `closed`. A segment is either
`{kind:'line', id, to}` or `{kind:'cubic', id, c1, c2, to}`. Segment IDs are unique
within their contour; IDs cannot contain dots. Closed contours reserve the
segment ID `<contour-id>:close` for their implicit closing edge. Geometry uses the node's local
bp space. No SVG DOM parsing occurs during evaluation.

`d` remains the paint transport field and is regenerated from geometry at each
evaluation. Authored geometry cannot coexist with a `connect` writer on the same
path. The original PGF artwork resource is retained through
`source.referenceResourceId` for comparison and provenance; it is not drawn as
a duplicate. PGF-produced arcs/circles are the cubics emitted by PGF, not exact
analytic conics. Capture does not infer live constraints hidden in arbitrary
TikZ code. See the explicit frontend support list in `tex/README-v03.md`.

Control tracks address stable coordinates as `geometry.<contour>.start` or
`geometry.<contour>.<segment>.c1|c2|to`, with finite pairs as key values. Missing
IDs and cubic controls on lines fail validation. Editing coordinates preserves
topology; arbitrary topology-changing morphs are not implemented.

`reveal` in [0,1] creates a genuine geometric prefix using exact cubic splits.
`revealMode` is `parameter` (default) or `length`; `pathTolerance` defaults to
0.05 local bp. Full geometry stays available to dependent operations. Zero
reveal yields no ink. Disjoint contours never gain connecting segments. A
partially revealed closed contour stays open until the closing segment is done.
Fill uses ordinary SVG/Canvas implicit closure of open contours; use
`fill:'none'` for stroke drawing. Reveal is not human handwriting inference.

Parameter mode divides progress equally between nondegenerate drawable segments,
including a nonzero implicit closing line (`<contour-id>:close`). Length mode
uses bounded adaptive subdivision and monotone length inversion. Tolerance is
absolute in local bp; nonuniform parent scaling does not turn local length
progress into constant world speed. Exact internal boundaries choose the next
segment, including an intentional jump to the next disconnected contour.
Progress 1 selects the last endpoint. Zero-length segments consume no progress.

`pointOnPath` writes a point's x/y using its `progress` (default 0). It resolves
source and target ancestor transforms. `mode` and `tolerance` belong to this
relation; `pathDirection` inherits its referenced point's sample. A direction
must reference the same source path as that point. The tangent is with respect
to the current curve parameter, not velocity of a deforming curve over time.

`pathDirection` writes a line centered on the sampled point. Its `length` is in
world bp, before the viewing camera. It transforms and normalizes the tangent
in world space; with `normal:true` the direction is (-Ty, Tx) in that space,
remaining perpendicular under nonuniform/reflected parent transforms. Target
coordinates are obtained by inverse transformation. Singular inverses are
diagnosed, including continuous scale tracks crossing zero.

Sampling empty/all-degenerate geometry fails explicitly. A zero endpoint
derivative uses the first nonzero one-sided control secant. A stationary
interior tangent raises `UNDEFINED_TANGENT`. Static drawing and reveal need no
tangent and can still display those curves. Unmet numerical budgets raise
`ARC_LENGTH_TOLERANCE`; they are not silently accepted. Bounds are analytic for
cubic extrema, include move-only starts and return null for zero contours.

The pure kernel is exported from `src/path-geometry.ts`. Runtime kernel errors
carry the source path ID in shared bundle diagnostics. SVG and native Canvas
consume the same generated prefix `d` and relation coordinates.
