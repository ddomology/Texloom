# PR 02 — Typed operations and references

This document records the PR 02 **validation and preparation contract**, which
remains `texloom-operations/1`. PR 03 now supplies executable lowering, numeric
checks and the common runtime plan; see [operation runtime](operation-runtime.md)
for current behavior and rendering instructions. This is an independently
authored contract; no Blender, PGF or Manim implementation is copied.

## Entry points and versioning

Bundle `0.3` may contain `operationGraph: {version: 1, operations, bindings}`.
Graphs are rejected on Bundle `0.1` and `0.2`. Existing bundles without a graph
retain their validation and rendering behavior. An empty graph is harmless.

Public exports from `src/index.ts`:

```ts
validateBundle(bundle); // default registry, diagnostics only
validateOperationGraph(graph, bundle, registry); // default registry if omitted
prepareOperationGraph(graph, bundle, registry); // throws OperationValidationError
createOperatorRegistry(definitions);
defaultOperatorRegistry;
```

`validateOperationGraph` validates both the supplied graph and its base scene
context; any graph already attached to the context is excluded from that check.
`prepareOperationGraph` owns a detached, recursively frozen snapshot. Its result
contains `{contract, graph, order, definitions}`. Missing default inputs become
explicit literals in the snapshot. Authored data and registry inputs are neither
modified nor frozen. Context nodes/resources are not copied into this result:
it is a graph contract snapshot, not a fully prepared executable scene.

The registry uses exact `(name, positive integer version)` pairs. It has no
`latest` resolution. Custom registries can be passed to the graph API; the
bundle CLI and `validateBundle` use the built-in registry. Definitions are
metadata only, declare `pure: true, deterministic: true`, and contain no function,
script or executable plugin. Adding a definition does not add an implementation.

All graph data must be finite plain JSON. Unknown fields in graph contracts,
references and operator definitions are rejected. Operator IDs and socket names
remain separate fields; dots in IDs do not alias nested properties.

## Values, sockets and coordinate spaces

Only four value types are introduced:

| Type | Literal payload | Required metadata |
| --- | --- | --- |
| `scalar` | Finite number | None |
| `vec2` | `[x, y]` | `role: point` or `vector`, and `space` |
| `path2d` | Existing line/cubic `PathGeometry` | `space` |
| `transform2d` | `[a,b,c,d,e,f]` affine matrix | `from`, `to` |

Matrix convention is `x'=a*x+c*y+e, y'=b*x+d*y+f`. A matrix maps from its `from`
space to its `to` space. Singular forward maps are representable; requesting an
inverse requires a separate domain check. No mesh, field or boolean type is added.

`SpaceRef` is `{kind: 'scene'}` or `{kind: 'local', node: 'id'}`. A local reference
must identify an existing node. Scene coordinates use bp, with +y down, before
camera application. Local spaces stay distinct from scene and from one another,
even when their current transforms are identities. Point and vector roles are
incompatible: translation applies to a position, not to a tangent direction.

Definitions use declared space variables, for example `space: 'curve'`.
Each operation binds every variable to a concrete `SpaceRef` in `spaces`.
Unbound and extra variables fail validation. Sockets must match both type and
role, and every concrete coordinate space must match exactly. No implicit
coordinate conversion is inferred from matching array lengths or node transforms.

Each input socket declares exactly one of `required: true` or `default`.
Defaults are validated literals with the same type and role; their concrete
spaces are checked in the operation's scene context during preparation.

## References and dependencies

```json
{"kind":"literal","value":{"type":"scalar","value":0.5}}
```

```json
{"kind":"output","ref":{"operation":"sample","socket":"position"}}
```

There are no implicit node-property reads, arbitrary expressions, script inputs
or source-order dependencies. Producers may appear after their consumers.
Every declared operation is checked, including unused operations. Missing IDs,
missing input/output sockets, duplicate IDs, unknown versions and cycles fail.
Dependency edges come from output references. Kahn ordering puts dependencies
first and uses lexical ID order among ready operations. Self cycles and
disconnected cycles fail. A cycle diagnostic identifies blocked operations and
their source locations, including any downstream operations blocked by the cycle.

An output may feed any number of input sockets and output bindings. Referencing
two outputs of one operation preserves their common producer identity; preparing
the graph does not run that producer twice, or run it at all.

## Initial built-in signatures

| Operator | Inputs | Outputs | Space variables |
| --- | --- | --- | --- |
| `sampleCurve@1` | `curve: path2d` required; `parameter: scalar = 0`; `tolerance: scalar = 0.25` | `position: vec2(point)`, `tangent: vec2(vector)` | `curve` |
| `offsetPoint@1` | `origin: vec2(point)`, `direction: vec2(vector)` required; `distance: scalar = 1` | `position: vec2(point)` | `space` |
| `transformPoint@1` | `point: vec2(point)`, `transform: transform2d` required | `position: vec2(point)` | `from`, `to` |

PR 03 implements the numeric behavior: `sampleCurve` uses normalized
path parameter progress, returns a unit tangent in the declared curve space, and
reports undefined tangent/degenerate geometry explicitly. `offsetPoint` computes
`origin + distance * direction` without hidden normalization. `transformPoint`
uses the declared affine mapping. Parameter bounds, positive tolerance, numeric
overflow and any computed singular inverse are enforced during execution.
Preparation proves socket compatibility; sampling performs the numeric checks.
PR 03 also adds `scalarValue`, `pointValue`, `vectorValue`, `pathValue` and
`transformValue`; their execution is documented in the runtime guide.

## Binding outputs to scene properties

A binding is `{target, property, value: {operation, socket}, sourceSpan?}`.
It consumes an output reference; literal initial properties remain on the node.

| Binding property | Target | Input contract | Owned property slots |
| --- | --- | --- | --- |
| `position` | point, tex | Scene point | `x`, `y` |
| `position` | ellipse | Scene point | `cx`, `cy` |
| `start`, `end` | line | Scene point | `x1,y1` or `x2,y2` |
| `geometry` | path | Path in target-local space | `geometry` and derived `d` |
| `geometry.c.start`, `geometry.c.s.c1`, etc. | path | Point in target-local space; existing control ID | Named control |
| `transform` | any node | Matrix from target-local to parent space | Whole transform |
| `transform.translate` | any node | Vector in parent space | Translate tuple |
| `transform.scale` | any node | Vector in target-local space | Scale tuple |
| Existing scalar animatable property | compatible node or `$camera` | Scalar | Exact property |

`c` and `s` above are contour and segment IDs. Root parent space is scene; a
child's parent space is the parent's local space. Scale tuple values are
dimensionless axis factors; the local-space annotation identifies their axes.

The semantic `position/start/end` sinks explicitly consume scene points. PR 03
inverse-transforms those values to stored target-local coordinates before
rendering, including the target's own transform. Concrete scalar properties
such as `x` remain node-local. Known zero static scales or continuous scale tracks
crossing zero in the inverse chain already fail PR 02 preparation. Discrete step
changes between nonzero scales remain legal. Graph-produced transforms need the
additional runtime invertibility and dependency checks implemented in PR 03.

Writer ownership includes both graph bindings and existing tracks/relations.
Aggregate aliases are expanded, and whole-property writes overlap descendants:
`position` conflicts with `x`; `geometry` conflicts with a control track and
`connect`'s `d`; `transform` conflicts with any `transform.*` writer. Two
bindings of the same output still count as two writers when their target slots
overlap. Style writers can coexist with disjoint geometric writers. Authored
initial values are inputs, not additional per-frame writers.

Whole matrix bindings lower to the current renderer's translate/rotate/scale
representation, including reflections. The runtime checks the reconstructed
matrix and rejects unsupported shear explicitly. General affine value transport
and forward point mapping do not imply general affine scene-node storage. See
the runtime guide for the numeric representability check.

## Diagnostics

`SourceSpan = {file, start: {line,column}, end: {line,column}}` uses 1-based lines
and Unicode-code-point columns, with an exclusive end. Empty spans are permitted;
reversed spans and noninteger positions fail. Source paths are provenance labels;
validation does not open files or prove that source ranges exist on disk.

Diagnostics retain existing `severity`, `code`, `message`, `path` and add optional
`sourceSpan` and `related`. Operation errors carry that operation's authored
location. Binding errors carry the binding location. Unknown output sockets link
to the producer; writer conflicts link to the earlier writer. Legacy warnings
are returned once. `OperationValidationError.diagnostics` preserves structured
information for editors and CLI clients.

## Reproduce the acceptance example

```sh
node tools/validate-bundle.mjs tests/fixtures/operations/sample-curve.json
node tools/validate-bundle.mjs tests/fixtures/operations/sample-curve.json --prepare-operations
npm run check
npm test
python tools/verify-port.py
```

The JSON fixture deliberately lists `tip` before `sample`. Preparation returns
`order: ["sample", "tip"]`. One `sample.position` output feeds both the dot and
the tangent-line start. The same operation's `sample.tangent` feeds `offsetPoint`
to construct the line end. The fixture's path literal is self-contained; it does
not read the rendered path node or silently track edits to that node.

The plain CLI outputs diagnostic JSON and exits 0/1 for success/error. Preparation
mode outputs the frozen-plan serialization or diagnostic JSON. Missing files,
malformed JSON and missing graphs fail explicitly; invalid command usage exits 2.

`evaluate`, `createEvaluator` and `prepareScene` now execute supported operation
graphs. This fixture is also a renderable JSON graph example; its literal inputs
produce a static sampled curve rather than a time-varying animation. The
[runtime guide](operation-runtime.md#run-the-json-graph-through-real-renderers)
gives SVG/player commands. Existing graph-free demos continue through the same
public APIs, and the PR 01 historical bundles/images remain unchanged.

## Evidence and handoff

`tests/operations.test.ts` covers the shared-output DAG, deterministic ordering,
defaults, immutable snapshots, missing references, sockets, versions, cycles,
malformed JSON values, source spans, spaces, point/vector roles, scalar camera
bindings, writer aliases, singular inverse chains, legacy compatibility and CLI.
The existing regression gate separately checks four compiled scenes at 21 times.

The architectural reference retained from PR 01 is Blender's dependency graph
documentation and its pinned source at
[`8931427c0a55f25a462c8bc657a9a1a31a746266`](https://github.com/blender/blender/blob/8931427c0a55f25a462c8bc657a9a1a31a746266/source/blender/depsgraph/intern/eval/deg_eval.cc).
This is a reference-only relationship, with the reuse-review status already
recorded in `docs/ports/v03-baseline.json`; no execution or equivalence to Blender
is established here. The active PR 01 PortSpec and its hashes are unchanged.

PR 03 adds named legacy kernels/adapters, executable built-ins, a unified
dependency order including parent transforms and binding conversions, and
domain checks. Public API compatibility and the frozen PR 01 baseline remain
required gates. Caches, a plugin executor, expression parsing and future geometry
types remain separately planned work; see the runtime guide for the current
handoff.
