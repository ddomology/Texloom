# PR 11 — Path intersections and explicit selection

Compute intersections once and let multiple points or labels consume the same
typed result set. Solving, selecting a branch, and displaying it are separate
steps. All consumers use the shared absolute-time evaluator.

## Build the example

```sh
python tools/build.py examples/path-intersections.tex --out build/path-intersections --video
python -m unittest tests.intersection_compiler_test -v
```

The example moves a line across a cubic. It displays multiple isolated roots,
selects a branch in an explicitly declared order, and hides missing markers.
The same TeX source produces an interactive player, SVG frames and a video.

## TeX declarations

Load `texloom-intersections` alongside the scene frontend. The paths and target
nodes must already exist. A result ID names an operation, not a drawn node.

```tex
\usepackage{texloom-intersections}

% Inside a scene containing editable paths probe/curve and point P.
\loomintersections{hits}{{"a":"probe","b":"curve"}}
\loomintersectionpoint[along=a,index=0,missing=hide]{P}{{"intersections":"hits"}}
```

`a` and `b` accept an editable path node ID or a graph output reference such as
`{"operation":"curve:trimmed","socket":"path"}`. A node read uses its current
evaluated geometry, including upstream geometry writers and current transforms.
SVG `d` strings are not implicitly parsed. Ordinary scene line nodes are not
editable path inputs; use captured PGF paths or a path-producing operation.

The selector accepts an intersection operation ID or a typed output reference.
Its target can be an existing point or raw TeX node. Several selectors can share
the same result, including a marker and its label.

### Intersection options

| Option | Default | Meaning |
| --- | --- | --- |
| `space` | `scene` | `scene`, `local:node`, `parent:node` or `plot:group` |
| `domain-a` | `segment` | `segment` or `line` for input A |
| `domain-b` | `segment` | `segment` or `line` for input B |
| `position-tolerance` | `0.0000001` | Positive positional tolerance in the chosen space's bp |
| `parameter-tolerance` | `0.000000001` | Positive dimensionless parameter tolerance |

The first argument is the actual operation ID. There is no separate `id` option
for `\loomintersections`. The JSON object requires `a` and `b` and may supply
`positionTolerance` and `parameterTolerance`. A tolerance cannot appear in both
options and JSON.

### Selection options

| Option | Default | Meaning |
| --- | --- | --- |
| `along` | required | `a` or `b`; input whose traversal orders the results |
| `missing` | required | `error` or `hide` |
| `index` | `0` | Zero-based index among isolated point records |
| `space` | `scene` | Must match the intersection result's space |
| `id` | `intersection:<target>` | Unique selector operation ID |
| `visible-opacity` | authored target opacity, otherwise `1` | Opacity when present with `missing=hide`, in `[0,1]` |

The JSON object requires `intersections` and may supply `index` and
`visibleOpacity`. Those two scalar inputs may be finite numbers, typed
expression strings, scalar output references, or
`{"node":"driver","property":"r"}`. Duplicate option/JSON values fail.
An animated index must evaluate to a nonnegative safe integer at every sampled
time. An expression for positional tolerance must have unit `bp`; index,
parameter tolerance and opacity are dimensionless.

Parameter tolerance must be at least `32 * Number.EPSILON` and less than `0.5`.
Root isolation and monotone overlap partitions still use numerical precision;
a loose user tolerance does not remove a distinct turning point.

Only `missing=hide` adds a TeX opacity binding. With `missing=error`, the
selector still computes its opacity output but the frontend leaves the target's
opacity under its existing controls.

Unknown options, unknown JSON fields, duplicate JSON keys and nonfinite values
are rejected. Generated conversion IDs use the suffixes `:fallback` and
`:scene`; reserve those names for the frontend.

## Finite segments and infinite lines

The geometry kernel supports line-line and line-cubic segment pairs. Cubics
always use their finite parameter interval `[0,1]`. Infinite `line` mode extends
each line segment on that operand to its supporting line, so its returned
parameter can be outside `[0,1]`. An operand with cubic segments cannot use
infinite-line mode.

Every contour and segment participates, including a nonzero implicit closing
edge. There are no connectors between disconnected contours. A cubic-cubic pair
is rejected explicitly, even if other segment pairs in the paths are supported;
PR 12 owns general cubic-cubic solving.

Finite degenerate segments are point-like inputs with a canonical local
parameter of zero. An infinite line needs a nonzero direction. Contact records
distinguish `crossing`, `tangent`, `endpoint` and `degenerate`; an endpoint contact
can also be geometrically tangent, so the contact label is not a full algebraic
multiplicity description.

## Result set

`intersectPaths@1` returns an `intersections2d` value with a declared space and
this versioned geometry payload:

```text
IntersectionSet
  version: 1
  points[]
    point: [x, y]
    incidents[]
      a, b: {contourId, segmentId, contourIndex, segmentIndex, closing}
      parameterA, parameterB
      contact
  overlaps[]
    a, b: segment references
    parameterA, parameterB: parameter intervals
    orientation: +1 or -1
    points: endpoints ordered along A
  options: resolved modes, tolerances and work limits
  pairsTested
```

Parameters describe the current evaluated segments, not a whole-path arc-length
fraction. Original intervals from PR 10's curve provenance are not inferred into
these parameters. Implicit closing edges have explicit references in the result.

Shared topological endpoints can have multiple incident segment pairs in one
point record. Distinct branches visiting the same coordinate retain separate
records; position alone is insufficient for deduplication. Position and parameter
tolerances have separate roles.

Coincident overlap remains an interval result. For infinite line overlaps,
`null` bounds/endpoints express unbounded ends without nonfinite JSON numbers.
Collinear cubic overlaps may have several monotone intervals. They are never
silently reduced to their midpoint or first endpoint. `count` reports the number
of isolated point records; `overlapCount` reports the number of overlap records.

## Ordering and missing results

`selectIntersection@1` orders point records by contour order, segment order and
local parameter along the chosen input. It selects a deterministic representative
incident at a shared endpoint, then uses the other input and stable IDs to break
ties. It does not sort by screen x/y or retain the previous frame's branch.

Reversing input A can change selection along A while leaving selection along B
unchanged. When roots merge or disappear, a numeric index can select a different
branch. Continuous branch tracking needs a future explicit constraint or bake.

Any overlap in the input set raises `INTERSECTION_OVERLAP` during selection.
This applies even when isolated points also exist and even with `missing=hide`.
The set is still a valid reusable value; the point selector cannot represent a
continuum of solutions.

With `missing=error`, an absent index raises `INTERSECTION_MISSING`. With
`missing=hide`, the raw graph operator returns the caller's required fallback
point, `found=0` and `opacity=0`. Its parameter outputs are zero placeholders and
must not be interpreted as a solution when `found=0`. Selection metadata records
`selected:null` and `incident:null`.

The TeX frontend captures the target's authored local x/y as the fallback and
converts it using current transforms. It does not read the position it is about
to write, reuse a previous frame's point, or invent a coordinate. Hidden selection
binds the target's position and `style.opacity`. Present opacity defaults to its
authored value; an explicit `visibleOpacity` controls it instead. These writes
participate in normal writer-conflict and cycle checks. Other nodes, attached
labels and groups are not implicitly hidden; give them their own selector or
explicit opacity binding.

## Runtime and core APIs

Both operations use `spaces:{space:...}`.

| Operation | Inputs | Outputs |
| --- | --- | --- |
| `intersectPaths@1` | `a`, `b`, `domainA=0`, `domainB=0`, `positionTolerance=1e-7bp`, `parameterTolerance=1e-9` | `intersections`, `count`, `overlapCount` |
| `selectIntersection@1` | `intersections`, required `along`, `index=0`, required `missing`, required point `fallback`, `visibleOpacity=1` | `position`, `found`, `opacity`, `parameterA`, `parameterB` |

The graph encodes domains as `0=segment`, `1=line`; selection order as `0=A`,
`1=B`; and missing policy as `0=error`, `1=hide`. Raw graph users must bind the
opacity output themselves when they want hidden markers. The solver and selector
do not mutate scene nodes directly.

Core exports `intersectPathGeometries(a,b,options?)`, `assertIntersectionSet` and
the result types. Core options use `modeA`/`modeB` string values. Results are
detached and frozen. Default work limits are 65536 segment pairs and 16384 result
records, counting point incidents and overlap intervals; the core supports
explicit bounded limits. Exceeding a budget fails
instead of returning a silently truncated set.

`frame.intersections.sets[id]` contains `{space,result}`.
`frame.intersections.selections[id]` contains
`{space,along,index,selected,incident}`. Frames without intersection operations
do not receive this optional metadata.

Lengths and positional tolerances are measured in the operation's declared
coordinate space. A later nonuniform transform changes visible error; this is
not a screen-pixel tolerance. Selection outputs retain the declared space; the
TeX frontend converts them to scene coordinates before ordinary position binding.

These are numerical intersections, not a symbolic exact-arithmetic API. A
nonzero critical polynomial value within the roundoff bound raises
`INTERSECTION_PRECISION` because its root multiplicity is unresolved. A line
position computed with floating-point arithmetic from a cubic's extremum can
trigger this diagnostic instead of being treated as an exact tangent. Lost
coefficients, coordinate underflow and excessive position residuals also fail
explicitly. Near-tangent general cubic pairs,
filled-region Boolean operations and temporal branch matching are later work.

## Capture, compatibility and semantic references

The final JSON arguments use xparse `+v` literal capture. Multiline declarations
are supported; place them directly in source rather than inside a macro's
pre-scanned argument. Exact literals are archived in `intersection-sources/`;
decoded expression strings receive separate deterministic files. Source spans
refer to these archived texts with one-based Unicode columns and exclusive ends,
not guessed columns in the original TeX file.

Declarations append to the common operation graph on Bundle 0.3. Merely loading
the package does not upgrade a scene with no intersection declarations. Existing
renderers, historical samplers and reference fixtures remain on their existing
contracts.

The semantic reference is PGF's
[named intersections and explicit sorting](https://tikz.dev/tikz-coordinates#sec-13.3.2),
with source reference
[PGF intersections at revision 1d623487](https://github.com/pgf-tikz/pgf/blob/1d6234878836bc50b5e5a15ae266d74911466e7a/tex/generic/pgf/libraries/pgflibraryintersections.code.tex).
The kernel is an original implementation. Source code is not copied or translated.
PGF's default discovery order is not adopted as a stable branch identity;
Texloom makes the sorting input explicit and preserves segment parameters.
