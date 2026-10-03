# Mesh attributes and explicit domain transfer (PR33)

Mesh attributes are immutable captured values attached to an exact indexed topology. A vertex value, a face value and a triangle-corner value remain different domains even when their arrays happen to have the same length. `Bundle.meshAttributes` evaluates ordered steps at each absolute scene sample and publishes derived mesh resources for numeric and GPU consumers.

## Attribute resource contract

`MeshResource.attributes` is optional:

```ts
{
  version: 1,
  topology: {revision: string, vertexCount: number, indices: number[]},
  values: {
    height: {domain: 'vertex', valueType: 'scalar', buffer: NumericBuffer},
    color: {domain: 'vertex', valueType: 'color', buffer: NumericBuffer}
  }
}
```

Supported domains are `vertex`, `face` and `corner`. A corner is an index-buffer occurrence, so one shared vertex may have different values on different triangle corners. Value types are `scalar`, `vec2`, `vec3` and `color`, with respectively 1, 2, 3 and 3 float32/float64 components. Color is **linear-sRGB RGB in `[0,1]`**, not a hex string or encoded sRGB byte triple.

The captured topology must match the mesh's revision, vertex count and complete ordered converted index buffer. Coordinate changes preserve attributes; changing topology without an explicit transfer contract is rejected. There are at most 32 named attributes and 262144 total backing components per mesh. Attribute names are safe literal identifiers of at most 512 characters; reserved prototype names are rejected.

`attachMeshAttributes` snapshots new values. Existing names require its explicit `replace:true` option. `copyMeshAttribute` and `copyMeshBuffers` return owned writable arrays; modifying those copies never changes the resource. The scene program below always requires a fresh capture/transfer name.

## Ordered program

```json
{
  "version": 1,
  "operations": [{
    "id": "colored",
    "source": "sphere",
    "resourceId": "colored-sphere",
    "units": "m",
    "steps": [
      {"kind":"capture", "name":"height", "domain":"vertex",
       "valueType":"scalar", "expression":"z"},
      {"kind":"capture", "name":"vertexColor", "domain":"vertex",
       "valueType":"color", "expression":["0.5+0.4*x", "0.5+0.4*y", "0.5+0.4*z"]},
      {"kind":"set-position", "normalPolicy":"drop",
       "expression":["x", "y", "z+0.1*sin(time / 1s)"]},
      {"kind":"transfer", "source":"vertexColor", "name":"faceColor",
       "domain":"face", "method":"mean"}
    ]
  }]
}
```

The source is an authored mesh, a generated surface, or an **earlier** attribute operation's output. Every operation declares matching units (`unit`, `m`, `cm` or `mm`). Outputs have distinct resource IDs and cannot overwrite authored resources, surfaces, curves or earlier outputs. Forward references, cycles and curve sources are rejected. Place derived resources in `space3d.nodes` without placeholder buffers.

The optional `texloom-attributes` package captures this operation with:

```tex
\loomattributes{colored-sphere}|{"source":"sphere","units":"m","steps":[{"kind":"capture","name":"height","domain":"vertex","valueType":"scalar","expression":"z"}]}|
```

The command supplies `resourceId` and defaults `id` to that argument. The compiler archives the literal JSON, the exact source span of each step, and decoded scalar expression strings. See [the sphere comparison](../examples/mesh-attributes.tex).

### Expression context

- `x`, `y`, `z` are the current domain position. Vertex and corner contexts use the addressed vertex position; face contexts use the arithmetic mean of the three triangle vertices.
- `ox`, `oy`, `oz` are the corresponding position at the **start of this operation**, before its ordered steps. A later operation starts a new original context from its own source resource.
- `index` is the zero-based domain ordinal. A corner index is the global triangle-corner ordinal, not a vertex index.
- These locals are dimensionless scalars interpreted in the operation's declared mesh units. Scene parameters with colliding local names are rejected. Time retains seconds; for example use `time / 1s` to obtain a dimensionless scalar.
- Scalar capture takes one expression string; vec2 takes two strings; vec3/color take three strings. Each expression must return a dimensionless scalar. A position update takes exactly three strings.
- Captured names are not implicit expression variables. PR33 consumes them through explicit domain transfer and material selection; it does not introduce an attribute lookup language.

Capture uses the current input of its step. `set-position` then replaces positions, recomputes exact bounds, preserves index order/topology and all captured values, and removes normals. The explicit `normalPolicy:"drop"` prevents stale normals from claiming to describe changed geometry. This is sufficient for the current unlit renderer; normal recomputation and general deformation graphs remain separate work.

Every sample starts from its current source resource. Capturing before a deformation preserves those values **within that sample**, rather than storing mutable values from an earlier playback frame. Reverse seek and parameter changes consequently do not depend on playback history.

## Registered domain transfers

| Source | Destination | Method | Meaning |
|---|---|---|---|
| vertex | face | `mean` | Mean of the triangle's three vertex values |
| face | vertex | `uniform` | Mean of incident face values; each face counted once |
| face | vertex | `area-weighted` | Mean weighted by current triangle area |
| vertex | corner | `promote` | Read the corner's indexed vertex |
| face | corner | `promote` | Copy the containing face value |
| corner | vertex or face | `mean` | Mean of contributing explicit corner values |

No nearest-neighbor or automatic domain conversion is inferred. Transfer buffers explicitly use float64. Arithmetic means and area weights use overflow-resistant arithmetic; normal floating-point rounding still applies.

Transfers to vertices default to an error for destinations without contributors. `orphan:"zero"` explicitly fills them with zero. Area-weighted transfer defaults to an error on zero-area triangles; `zeroArea:"ignore"` excludes them, after which a vertex with no contributing area follows the orphan policy. These options are rejected on unrelated transfer methods/domains. Weighted transfer uses the geometry at the transfer step, including preceding position updates.

## Runtime and rendering

`prepareMeshAttributeProgram(program,bundle)` prepares expressions once. Its `sample(time,parameters?)` also samples upstream surfaces at that absolute time. A caller integrating separately prepared producers may supply an explicit generated-resource dictionary at preparation or as the third sample argument; explicit dictionaries are validated before cloning or property access. Those dictionaries must contain the current required source geometry. The scene evaluator supplies current generated resources automatically, after surfaces and curves and before spatial transforms.

Evaluated frames contain immutable output meshes in `resources` and reports in `meshAttributes[operationId]`: source/output IDs, ordered step kind/domain/element counts, and retained attribute names. Runtime manifests list `producer:"mesh-attributes"` outputs separately from transported assets. Internal empty validation metadata is never emitted as authored or evaluated geometry.

Select a color capture using the mesh material's `colorAttribute` name. The resource must contain that exact `color`-typed attribute; a scalar or vec3 is not silently interpreted as color. GPU consumers implement vertex interpolation and explicit face/corner colors while keeping the core resource immutable. See [GPU renderer contracts](gpu-renderer.md).

The program supports at most 16 operations, 32 ordered steps per operation, 128 steps total and 1048576 evaluated scalar components per sample. Domain contexts, transfers and attribute arrays also enforce their own buffer bounds. Failures retain source diagnostics and do not publish a partial derived frame. Features are `attribute.mesh.3d`, `attribute.domain-transfer.3d` and `material.color-attribute.3d`.

## Acceptance

Numeric tests cover exact topology identity, vertex/face/corner distinctions, discontinuous shared-vertex corners, uniform and area-weighted transfers, orphan/zero-area policies, finite arithmetic and immutable array ownership. Program tests cover capture before position changes, original/current contexts, normal removal, dynamic bounds, typed expressions, source spans, ordered dependencies, reverse seek, getter rejection, and direct-sampler parity with the full evaluator. Combined surface/curve/attribute scenes and inline/external/packed packages exercise integration with existing producers and lifecycle preparation.
