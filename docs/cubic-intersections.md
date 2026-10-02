# PR 12 — Cubic intersections with bounded work

Two editable cubic paths can produce one reusable intersection set. Markers,
labels, web playback, SVG and Canvas/video consume the same evaluated result.
The solver runs against current geometry at absolute time, including upstream
control-point edits and transforms.

## Authoring

```tex
\usepackage{texloom-intersections}

\loomintersections[solver=curves,max-work=65536,max-depth=40]{hits}
  {{"a":"curveA","b":"curveB"}}
\loomintersectionpoint[along=a,index=0,missing=hide]{P}
  {{"intersections":"hits"}}
```

Use literal capture declarations directly in the scene as in
[`cubic-intersections.tex`](../examples/cubic-intersections.tex). Path inputs,
coordinate spaces, selector targets, source archives and opacity bindings follow
the [PR 11 contract](intersections.md).

| Option | Default | Contract |
| --- | --- | --- |
| `solver` | `basic` | `basic` emits `intersectPaths@1`; `curves` emits `intersectPaths@2` |
| `max-work` | `65536` | Integer in `[1,1048576]`, total cubic work across the whole operation |
| `max-depth` | `40` | Integer in `[1,52]`, subdivision depth per curve |
| `position-tolerance` | `0.0000001` | Positive distance in the declared coordinate space |
| `parameter-tolerance` | `0.000000001` | Dimensionless, in `[32*Number.EPSILON,0.5)` |

Work/depth options require `solver=curves`. JSON `maxWork` and `maxDepth` also
accept dimensionless scalar expressions, property references and operation
outputs. A value cannot be supplied both as an option and a JSON socket. Budgets
must evaluate to valid integers at each evaluated time. Increasing a tolerance
does not authorize treating an unresolved near miss as a proven intersection.

## Core and graph APIs

```ts
import {intersectPathGeometriesV2} from './src/index.ts';

const {intersections, report} = intersectPathGeometriesV2(a, b, {
  positionTolerance: 1e-7,
  parameterTolerance: 1e-9,
  maxWork: 65536,
  maxDepth: 40,
});
```

`AdvancedIntersectionOptions` extends `IntersectionOptions`: finite/infinite
line domains, maximum segment pairs and maximum result records remain available.
The maximum work is shared by all cubic pairs; a path with many cubics does not
receive a fresh whole-operation budget for every pair. Line-line and line-cubic
pairs retain their existing bounded analytic solver. Infinite domains still
require line segments on that operand.

Each visited subdivision box and each candidate merge comparison consumes one
work unit; the numerical routines within a unit have fixed iteration bounds.
Analytic, overlap and point-like fast paths cost one unit per pair. The report's
work count is deterministic rather than a CPU-time estimate.

`intersections` retains the portable `IntersectionSet` version 1 payload. The
existing selector and stored-result validation accept it without conversion.
The new report records solver `adaptive-cubic-v2`, `cubicPairs`, `work`,
`maxDepthReached`, `maxWork` and `maxDepth`. Core results and nested arrays are
detached and frozen. No timings or mutable continuation state enter the result.

The graph's `intersectPaths@2` has all v1 sockets plus dimensionless scalar
`maxWork` and `maxDepth`. Outputs are unchanged: `intersections`, `count`,
`overlapCount`. Frame metadata adds `report` to
`frame.intersections.sets[id]`; v1 metadata keeps its original shape.

## Geometry and uncertainty

The new pair kernel combines control-hull projection rejection, adaptive
de Casteljau subdivision, a Krawczyk-style local enclosure for regular roots,
and Newton refinement. Coordinates are normalized by a power of two. A separate
scalar-polynomial route handles curves with a common strictly monotone
coordinate, including the supported analytic tangencies in the regression suite.

Known equal/reversed control polygons produce overlap intervals with direction.
A constant cubic is point-like. Multiple parameter visits to the same spatial
point remain distinct; deduplication uses both operands' parameters and path
topology. General partial or differently parameterized coincident curves can
remain unresolved and raise a diagnostic.

This is a numerical Float64 API. Enclosure checks use conservative roundoff
margins; they are not an arbitrary-precision formal proof system. Residual size
alone does not establish a root. Difficult singular contacts, near coincidence,
or lost numerical resolution may be rejected even if a mathematical answer
exists. Position tolerance is measured before any later display transform, and
does not specify a screen-pixel error.

| Diagnostic | Meaning |
| --- | --- |
| `INTERSECTION_AMBIGUOUS` | The remaining geometry does not establish isolated roots or a supported overlap |
| `INTERSECTION_PRECISION` | Normalization, polynomial multiplicity or refinement cannot meet the numeric contract |
| `INTERSECTION_BUDGET` | Work, depth, segment-pair or result limits were exhausted/invalid |
| `INTERSECTION_OVERLAP` | A point selector was given a set containing interval solutions |
| `INTERSECTION_MISSING` | A requested isolated branch is absent with `missing=error` |

Failure throws a typed error; no incomplete set is presented as success. Graph
errors include the authored operation's source span. `missing=hide` handles an
absent branch in a successfully computed set. It does not suppress solver errors.

## Ordering and compatibility

V2 sorts by source contour index, segment index and local parameter along A.
Selectors can explicitly order along A or B. The other operand and stable IDs
break ties. Result and selector ordering share one comparator. There is no
previous-frame matching: reversing playback or seeking directly to a time
computes the same selection. An index can refer to a different branch after
roots merge or disappear.

`intersectPathGeometries` and `intersectPaths@1` retain PR 11 behavior, including
explicit rejection of cubic-cubic pairs. Merely loading the TeX package preserves
old bundle behavior. No historical baseline or sampler is migrated implicitly.
Filled-region Boolean topology and continuous branch tracking are outside this PR.

## Verification and example

```sh
npm run check
npm test
python -m unittest tests.intersection_compiler_test -v
python tools/verify-port.py
python tools/build.py examples/cubic-intersections.tex --out build/cubic-intersections --video
```

Analytic fixtures include nine intersections from transposed Chebyshev cubics,
supported double contacts, close
roots and near misses, input reversal/swap symmetry, repeated visits on a loop,
overlaps, endpoint contacts, independent tolerances and exhausted budgets. Graph
tests exercise live inputs, stateless selection and unchanged v1 behavior. The
TeX example shows two deforming cubics and disappearing/reappearing branches.
The full port gate separately checks historical reference fixtures.

PGF's [named intersections and explicit sorting](https://tikz.dev/tikz-coordinates#sec-13.3.2)
provide the semantic reference. The source reference remains
[PGF revision 1d623487](https://github.com/pgf-tikz/pgf/blob/1d6234878836bc50b5e5a15ae266d74911466e7a/tex/generic/pgf/libraries/pgflibraryintersections.code.tex).
This is an original implementation; no upstream source was copied or translated.
The documented subset does not claim universal PGF intersection equivalence.
