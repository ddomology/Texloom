# Parametric surfaces

PR31 adds explicit parameterized triangle meshes. A portable surface program is
evaluated by the shared Texloom evaluator before 3D instance bounds and rendering.
Web, GPU and Chalkspace consumers receive the same mesh at the same absolute time.

```ts
surfaces: {
  version: 1,
  operations: [{
    id: 'sheet', resourceId: 'sheet-mesh', units: 'unit',
    domain: {u: [0, 1], v: [0, 1]}, segments: {u: 32, v: 16},
    position: ['u', 'v', 'amplitude * sin(pi*u) * sin(pi*v)'],
    normals: {kind: 'analytic',
      dU: ['1', '0', 'amplitude*pi*cos(pi*u)*sin(pi*v)'],
      dV: ['0', '1', 'amplitude*pi*sin(pi*u)*cos(pi*v)']},
    orientation: 'uv'
  }]
}
```

Declare `amplitude` as a scalar parameter with `unit: '1'` in the existing
`expressions.parameters` program. Reference `sheet-mesh` from an ordinary
`space3d` mesh instance. Do not place a placeholder mesh in `resources`.
Generated IDs must be unique and cannot overwrite authored resources. The
program requires Bundle 0.3, permits at most 16 operations, and caps the sum of
`segments.u * segments.v` at 65,536 cells. Each surface is limited to 32,768
cells and 65,536 full-grid vertices before seam/pole identification. Its sampling
budget is one million position evaluations per call. Counts and buffer limits
are checked before allocating the grid.

## Expressions, units and normals

`u` and `v` are dimensionless local scalars; scene parameters cannot reuse these
names. `time` has seconds, so an expression such as `time / 1s` is dimensionless.
Position and derivative triples must produce dimensionless scalars interpreted
as coordinates in the operation's explicit `unit`, `m`, `cm` or `mm` chart.
The mesh and `space3d.units` must agree. No conversion from document bp is
implicit. This is the existing bounded scalar expression language, not arbitrary
JavaScript or a symbolic algebra engine.

Analytic normals use the authored derivative cross product. Texloom validates
the numerical result but does not symbolically prove that a supplied derivative
matches the position expression. Alternatively use
`normals: {kind: 'finite-difference'}`. Each axis uses a fixed step of its domain
span times `1e-5`, central differences inside the domain, bounded one-sided
differences at open endpoints, and wrapping across periodic seams. Orientation `uv` is the default; `vu`
reverses both triangle winding and normals. Invalid expression domains and
nonfinite values are located errors, never silently discarded vertices.

`sourceSpan` describes the full declaration. Optional `expressionSpans` contains
`position`, `dU`, and `dV` arrays of three source spans each; derivative spans
are available only with analytic normals. Errors retain the component path and
its source location.

## Seams and collapsed boundaries

`seams` explicitly selects `open`, `weld`, or `duplicate` on each parameter
axis; omitted axes default to `open`. A closed seam must agree geometrically at sampled endpoint pairs within
`seamTolerance`, measured in object units. The default tolerance is `1e-9`.
Open boundaries make no closure promise. Duplicate seams retain distinct UV
endpoints; welded seams share topology. After passing the tolerance test, both
policies canonicalize matching endpoint positions exactly. Welded normal vectors
must additionally agree within `1e-6`; an authored crease needs duplicate seams.

Author coordinate singularities explicitly with `collapsedBoundaries`, using
`u-min`, `u-max`, `v-min`, or `v-max`. Collapse is supported on one axis, with
either or both ends. Only triangles prescribed by that collapse are omitted;
other degenerate triangles are errors. At a collapsed pole, normals are the
normalized equal-weight average of incident unit-face normals, reported separately from regular
analytic or finite-difference vertices. This is a stated discrete pole policy.

Topology and grid resolution stay fixed across samples. A changing seam or
collapsed boundary that violates the declared topology fails at that sample.
There is no adaptive remeshing, PDE solver, arbitrary attribute system, texture
mapping, lighting, or inferred singularity repair in this version.

## Evaluation and immutable data

Preparation compiles all expressions once and captures base positions at time
zero with default scene parameters. Each frame resolves the same parameter
override contract as ordinary expression bindings, samples its positions and
normals, and publishes frozen generated meshes in `frame.resources`.
`frame.surfaces[operationId]` contains the `resourceId`, attributes (`uv` and
`basePositions`), and the numerical report including normal provenance. UV entries
are the actual authored parameter coordinates `(u,v)`, not normalized `[0,1]`
texture coordinates.
The authored resource dictionary and input program remain unchanged.
`runtime.manifest.generatedResources` lists their IDs, producing operation IDs,
kind and units. Transport `assets` remains an inventory of authored payloads;
it never advertises a generated mesh as a downloadable asset or a fixed bound.

Generated bounds and topology revisions are passed to the 3D sampler before it
computes each instance's world bounds. Previous frames, forward playback, and
reverse seeking do not influence the result. Existing authored resources retain
their immutable identity. Consumers must not mutate frame resources or treat a
topology revision as a complete hash of changing vertex positions.

For a standalone numerical consumer, `prepareSurfaceProgram(program, bundle)`
returns `{resourceIds, baseResources, sample(time, overrides?)}`. The immutable
`baseResources` capture default parameters at time zero. Its sample result holds
`{resources, surfaces}`; the full Bundle evaluator additionally clamps time to
the scene interval and combines these with authored assets.

`prepareSpace3DSampler` also accepts an optional fourth argument of declared
dynamic mesh IDs. Its returned sampler then requires a second argument with
exactly those IDs mapped to `{bounds, topologyRevision}`. This lightweight
metadata boundary copies no vertex buffers, validates finite ordered bounds,
and prevents reuse of stale static bounds. Existing static callers keep the
original one-argument behavior and shared frozen result.

## Rendering and TeX authoring

Mesh material `wireframe: true` displays triangle edges; false is the default.
The existing opaque unlit color and front/double side policy still apply.
Capabilities inventory adds `surface.parametric.3d` for surface programs and
`material.wireframe.3d` when requested. Numeric and GPU profiles know both;
ordinary 2D renderers do not silently flatten generated meshes.

The optional `texloom-surface` package captures literal JSON with
`\loomsurface{sheet-mesh}|{...}|`. The command supplies `resourceId`; `id`
defaults to that same stable identifier. It archives authored expression source
locations and delegates validation/evaluation to the shared TypeScript core.

See [mesh spaces](mesh-space.md) for 3D transforms, projection, world clipping,
native TeX overlays and the absolute-time transform-track contract.
