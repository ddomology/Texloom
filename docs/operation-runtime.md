# PR 03 — Executable operations and the common plan

Typed operation graphs now execute through the same runtime as tracks and legacy
relations. The graph's interchange contract remains `texloom-operations/1` on
Bundle `0.3`. The compiled execution plan is internal runtime data; consumers
continue to use `evaluate`, `createEvaluator`, or `prepareScene`.

The [PR 02 contract](operations-contract.md) defines JSON values, sockets,
references, coordinate spaces and output bindings. This document describes their
execution, compatibility boundaries and the next handoff.

## Public API and consumer behavior

```ts
import {prepareScene} from './src/index.ts';
import {renderSvg} from './src/render-svg.ts';

const runtime = prepareScene(bundle);
const frame = runtime.sample(1.25);
const svg = renderSvg(frame, {idPrefix: 'operation-example'});
```

`createEvaluator(bundle)` validates and snapshots the source once, then returns
an absolute-time sampler. `evaluate(bundle, seconds)` remains the one-off entry
point. `prepareScene` wraps that evaluator with its existing manifest and
capability contract. SVG, Canvas, host clips and Chalkspace placement consume
the same `EvaluatedFrame`; they do not execute the operation graph themselves.

The public `prepareOperationGraph` API still returns the immutable graph
metadata contract `{contract, graph, order, definitions}`. Its `order` describes
authored output-reference dependencies. It does not expose the internal common
plan or the full order of tracks, bindings and legacy relation evaluation.
Creating a custom metadata registry does not install executable code.

## Preparing a common execution plan

Preparation validates the bundle and graph, materializes input defaults and
compiles a dependency order. The common sampling pipeline contains:

- A first pass for existing scalar/vector keyframe tracks, including camera
  tracks. Track writers participate in ownership checks during preparation.
- An ordered plan of built-in authored operations, shared typed outputs, graph
  property bindings, named kernels and compatibility adapters for relations.
- Final derivation of visible path data and sampled field values for the frame.

Dependencies include more than operation-to-operation socket references. A step
declares the scene properties it reads and writes. A consumer of a transformed
point or path depends on writers of the object's transform and all relevant
ancestor transforms. Scene-space position sinks depend on the current target
transform chain because they must invert that chain before storing coordinates.

Whole-property writes overlap their component slots. For example, a binding to
`position` owns the corresponding coordinate pair; a binding to `transform`
owns all of its components. A path-geometry binding owns its editable geometry
and derived path data. Two competing writers fail validation even when they
happen to produce the same number. Disjoint style and geometry writers can
coexist. Cross-layer dependencies and cycles are resolved during preparation,
without relying on the order in which authors listed operations or relations.

This makes graph-written geometry available before a legacy path follower reads
it, and makes graph-written parent transforms available before a scene-space
binding converts its point. It also prevents an implicit second execution pass
from hiding a dependency cycle.

## Sampling and state ownership

Each sample starts from the prepared source snapshot. It clamps finite time to
the bundle's duration, creates fresh frame-local nodes, camera, operation
outputs and relation context, then evaluates the compiled plan. Shared outputs
are computed once per producer in that sample and can feed multiple consumers.

Resources are recursively frozen shared data. They are reused across frames;
mutable evaluated geometry and output tables are not reused between samples.
Preparation and resource sharing are retained optimizations. There is no
temporal output cache, previous-frame integration, or hidden playback clock.

Consequently, forward playback, reverse seeking and isolated export samples use
the same computation. Sampling at one time, mutating the returned frame, then
sampling again does not change the prepared source. This is an absolute-time
scene evaluator, not a stateful simulation solver.

## Executable authored built-ins

All names below require version `1`. Inputs and outputs retain their PR 02
socket types, point/vector roles and explicit space annotations.

| Operator | Numeric behavior |
| --- | --- |
| `sampleCurve` | Samples line/cubic geometry at normalized parameter progress and produces a position and unit tangent in the declared curve space. Parameter must be in `[0,1]`; tolerance must be positive. Undefined tangents and invalid geometry fail. |
| `offsetPoint` | Computes `origin + distance * direction`. It does not normalize the supplied direction. |
| `transformPoint` | Applies `[a,b,c,d,e,f]` as a forward affine map from the declared source space to destination space. |
| `scalarValue` | Produces a finite scalar from its typed input. |
| `pointValue` | Produces a typed point in its declared space. |
| `vectorValue` | Produces a typed vector in its declared space. |
| `pathValue` | Produces a validated copy of line/cubic path geometry in its declared space. |
| `transformValue` | Produces a typed six-component affine map with declared source and destination spaces. |

The five value producers make otherwise literal data available to shared output
references and property bindings. Their inputs can also reference compatible
upstream outputs. They introduce no expression language or implicit reads of
node properties. An unused authored operation is still validated and executed;
being disconnected from a visible object does not suppress domain errors.

Numeric/domain failures include nonfinite results, out-of-range sampling
parameters, invalid tolerances, degenerate tangents and a singular transform
when an inverse is required. A singular *forward* affine map remains a valid
`transformPoint` input when its result is finite; it does not promise that a
later consumer can invert it.

## Legacy relation migration

The original relation formulas are extracted into explicit internal operators:

| Relation | Internal operator |
| --- | --- |
| `pointOnPath` | `texloom.pointOnPath@1` |
| `pathDirection` | `texloom.pathDirection@1` |
| `connect` | `texloom.connect@1` |
| `pointOnEllipse` | `legacy.pointOnEllipse@1` |
| `tangent` | `legacy.tangent@1` |
| `attach` | `legacy.attach@1` |
| `lineBetween` | `legacy.lineBetween@1` |
| `pathLabel` | `legacy.pathLabel@1` |

These names identify internal frame-mutating kernels and adapters. They are not
new public plugin definitions or names to insert into authored graph metadata.
The migration preserves the arithmetic and operation order inside each legacy
formula, including transform composition, path sampling and TeX baseline
placement. Existing TeX examples and their relation JSON need no rewriting.

`pathDirection` consumes the tangent sampled for its point in the same frame.
`connect` continues to construct its cubic in target-parent coordinates before
lowering to target-local coordinates. `pathLabel` continues to position labels
with logical TeX width, height and depth rather than visible ink bounds.

The old v0.1 shared-parent/identity-local-transform restrictions remain where
the legacy authoring contract requires them. Migrating a relation into the
common plan does not silently broaden its geometry contract.

## Spaces and binding conversions

Space identity is symbolic. `{kind: 'scene'}`, `{kind: 'local', node: 'A'}` and
`{kind: 'local', node: 'B'}` are distinct even when both node transforms are
identities or happen to produce equal coordinates. Socket compatibility checks
exact space identity and point/vector role. A runtime does not guess a conversion
from matching numbers. Authors use `transformPoint` with an explicit affine map
when an operation needs a point in another declared space.

The semantic property sinks `position`, `start` and `end` explicitly accept
scene-space points. At the current sample time, the binding inverts the target's
complete world transform, including its own local transform, and stores the
result in the target's local coordinate slots. The camera is not part of this
conversion. A singular inverse fails explicitly. Direct scalar sinks such as
`x` or `x1` retain their existing local-coordinate meaning.

Whole path geometry and named path controls require target-local values.
`transform.translate` is a vector in parent space; `transform.scale` is a vector
whose local-space annotation identifies the target axes. A whole `transform`
maps target-local space to parent space (scene space for a root node).

### Whole transform lowering

Scene nodes still store translation, rotation and scale. A whole affine output
is accepted as a scene-node transform only when it can be represented by
`translate · rotate · scale`, including reflections. The runtime reconstructs
the affine matrix from the decomposition and checks each component with
tolerance `1e-12 * max(1, columnNorm)` for each linear component, and
`1e-12 * max(1, abs(translation))` for translation. Using the column norm preserves
valid quarter-turns with very unequal scales despite trigonometric roundoff.

Shear or another nonrepresentable affine result is rejected with a diagnostic;
its off-axis terms are not discarded. This limit belongs to the scene-node
transform sink. Typed affine values and forward point transformation can still
carry and apply general finite matrices. Any later inverse has its own
invertibility check.

## Animation in this release

Existing tracks remain the time source. They can animate path controls, progress,
transforms and other supported properties. Graph values can write source
geometry or transforms that downstream legacy relations consume. For example,
a `pathValue` output can supply a follower's source geometry while a normal
keyframe track changes the follower point's `progress`.

Writer ownership still applies: a whole-geometry binding cannot coexist with a
track writing a control inside that same geometry. A track cannot also write a
coordinate already owned by a graph position binding.

Authored graph sockets currently accept literals and output references. They
have no direct time socket, expression input, callback or implicit node-property
read. The static shared-curve fixture therefore renders its sampled result but
does not acquire motion merely because the bundle has a nonzero duration.

## Run the JSON graph through real renderers

The existing fixture deliberately places `tip` before its producer `sample`.
The runtime resolves the dependency, executes `sampleCurve` once, shares its
position between the dot and line start, and sends its tangent to `offsetPoint`
for the line end. Its historical title still says “validation fixture”; it is
now an executable rendering example.

```sh
node tools/validate-bundle.mjs tests/fixtures/operations/sample-curve.json --prepare-operations
npm run snapshot -- tests/fixtures/operations/sample-curve.json build/operations/sample.svg 1
node tools/build-player.mjs tests/fixtures/operations/sample-curve.json build/operations/player.html
```

Open `build/operations/player.html`, or pass a sampled frame to the existing
Canvas consumer. The fixture's path literal is independent of the rendered path
node; editing that node does not implicitly change the operation's input.

## Diagnostics and acceptance gate

Preparation catches structural/type/space errors, unsupported implementations,
writer conflicts and dependency cycles. Sampling enforces numeric and geometric
domains, including computed inverse and matrix-lowering failures. Authored
operation and binding diagnostics retain their available `sourceSpan` and
related references for editor/CLI use. Legacy geometry errors retain their
existing codes and messages.

The implementation must pass the full existing port-regression gate with the
committed references unchanged:

```sh
npm run check
npm test
python tools/verify-port.py
```

The [port guide](ports/README.md) documents the pinned toolchain, clean source
compilation, semantic and frame comparisons, reverse seeking, SVG/Canvas raster
comparison and captured run evidence. A passing typecheck alone is not that
gate. No new golden image or re-recorded baseline is required to accommodate the
internal execution refactor.

## Handoff and limits

- The common compiled plan is internal. The stable consumer surface remains
  `EvaluatedFrame` and the existing scene sampling APIs.
- The authored registry is closed for execution. Metadata definitions do not
  load modules, install plugins or carry executable closures.
- Expression/time-socket authoring belongs to PR 04. New TeX syntax for those
  features is not introduced here.
- There is no temporal cache, incremental dirty-state evaluator, solver loop,
  general affine scene transform, mesh/3D operation or PDE simulation engine.
- Existing TeX capture and renderer support boundaries remain in force. Typed
  operation execution does not provide universal TikZ animation compatibility.

The next stage can introduce explicit time/value producers and richer authoring
against this common plan while keeping property ownership, space identity,
diagnostics and historical rendering as required contracts.
