# Sampled mesh instances (PR34)

`Bundle.instances` evaluates one transform, color and selection record per sampled element. The set refers to one mesh prototype; it does not duplicate the prototype's vertex buffers. Web and Chalkspace consume the same absolute-time evaluated sets. Optional realization explicitly creates an ordinary mesh when expanded geometry is needed.

## Authored program

```json
{
  "version": 1,
  "operations": [{
    "id": "arrows",
    "prototype": "arrow-mesh",
    "units": "unit",
    "seed": 2026,
    "source": {"kind":"mesh", "resourceId":"sample-grid", "domain":"vertex"},
    "position": ["x", "y", "z + 0.12"],
    "rotation": ["0", "0", "sin(time / 8s)", "cos(time / 8s)"],
    "scale": ["0.15", "0.15", "0.15"],
    "color": ["rand", "rand1", "rand2"],
    "selection": "rand3 < density"
  }]
}
```

The TeX frontend accepts literal JSON through `\loominstances{arrows}|{...}|` from `texloom-instances`. It injects the operation ID and archives the exact source and decoded expressions. The output is placed with a spatial node:

```json
{"kind":"instances", "id":"field", "instanceSetId":"arrows"}
```

The node supports the existing spatial parent, transform, visibility and unlit material fields. Prototype coordinates first receive the per-instance `T*R*S`, then the spatial node and ancestor transforms. Coordinates use the operation's explicit `unit`, `m`, `cm` or `mm` chart; source and prototype units must match. No unit conversion is inferred.

Source choices:

| Source | Element position | Stable identity |
|---|---|---|
| Mesh `vertex` | Converted vertex position | Resource ID, topology revision, domain and ordinal |
| Mesh `face` | Arithmetic triangle centroid | Resource ID, topology revision, domain and ordinal |
| Mesh `corner` | Position of the indexed vertex occurrence | Resource ID, topology revision, domain and ordinal |
| `{kind:"points",points:[{id,position:[x,y,z]}]}` | Explicit point | Authored unique point ID |

Sources and prototypes may reference authored meshes, generated surfaces, mesh-attribute outputs or an earlier realization in this program. Forward references, cycles and curve resources are rejected. Mesh identities use an opaque deterministic 128-bit digest plus the ordinal; they remain stable under coordinate changes with unchanged topology revision. A different topology revision changes their identity. Source meshes are sampled after upstream generation at the current time and parameter values.

## Expressions and defaults

All numeric expression components are dimensionless values interpreted in the declared object chart. Shared typed parameters and `time` work as in other expression programs (`time / 8s` is dimensionless). Read-only locals are `x`, `y`, `z`, `index`, `rand`, `rand1`, `rand2` and `rand3`. Conflicting parameter names are rejected. Named mesh attributes are preserved by realization but are not additional expression variables in this version.

| Field | Shape | Omitted value |
|---|---|---|
| `position` | Three scalar expressions | Source position |
| `rotation` | Four scalar expressions, quaternion `[x,y,z,w]` | Identity quaternion |
| `scale` | Three scalar expressions | `[1,1,1]` |
| `color` | Three scalar expressions, linear-sRGB `[0,1]` | White |
| `selection` | Boolean expression | `true` |

Quaternions are normalized; zero norm is rejected. Scale may be nonuniform, negative or zero. Inverse-dependent realization of normals still requires an invertible transform. An unselected instance retains its ID and record, while selected-only rendering and realization omit it.

The four random lanes are deterministic functions of the unsigned 32-bit seed, operation ID, element ID and lane number. The implementation hashes the JSON tuple with FNV-1a over UTF-16 code units followed by a fixed integer avalanche, then divides the unsigned result by `2^32`. Each lane lies in `[0,1)`. Randomness does not depend on elapsed playback, sample order or frame rate. Reordering explicit points preserves each ID's random lanes; the explicit `index` variable changes with ordering.

## Explicit realization

```json
"realize": {
  "resourceId": "expanded-arrows",
  "normalPolicy": "transform",
  "selection": "selected",
  "instanceColorAttribute": "instanceColor",
  "instanceSelectionAttribute": "chosen"
}
```

`normalPolicy` is required: `transform` applies the normalized inverse transpose to existing builtin normals, while `drop` removes them. Reflections reverse triangle indices and triangle-corner attribute order. Existing named attributes are copied as data; a generic `vec3` attribute is not interpreted as a normal or position. Optional color and selection attributes are explicitly promoted to vertices under new names; collisions are errors.

`selection` defaults to `selected`; `all` also expands records with `selected:false`. `maxVertices` and `maxBytes` may tighten the low-level realization limits. The generated topology revision includes prototype identity and exact indexed topology, included stable IDs and reflection signs; changing only coordinates or colors preserves it. The realization result reports ranges for each included ID and its compact numeric `bufferBytes`, including the separate captured topology indices. This measures payload bytes, not JavaScript heap usage.

`realizeMeshInstances` is also available as a direct pure API, with an explicit `topologyRevision`. `derivedInstanceTopologyRevision` supplies the deterministic policy used by the scene program. `exactInstanceSetBounds` computes vertex extrema for the selected or all records; spatial runtime bounds transform the prototype AABB and are conservative under general rotations.

## Runtime and limits

`prepareInstanceProgram` returns frozen `baseInstanceSets`, `baseResources` and `sample(time, parameters?, generatedResources?)`. Without caller-supplied generated resources, it prepares upstream surface/attribute programs and samples them at the requested absolute time. When supplied explicitly, that dictionary is the caller's current upstream geometry. Inputs are validated before access and preparation snapshots caller-owned data.

The main evaluator publishes `frame.instanceSets[id]` and any explicitly realized resources in `frame.resources`. `frame.space3d.instanceBatches` contains projected-consumer metadata and composed world/model-view transforms. `SceneManifest.instanceSets` inventories IDs, prototype IDs and units; realized outputs also appear in `generatedResources` with producer `instances`.

There are at most 16 operations and 4096 sampled elements across the entire program. The budget counts unselected records too. Realization is additionally bounded by the existing 262144-component buffers and attribute limits, at most 87381 vertices and 64 MiB compact numeric payload. Exact vertex bounds have a 4,000,000 vertex-visit limit. Budgets are checked before their corresponding allocation/work. Runtime geometry, colors and selection are finite and validated for every sample; errors retain the authored operation or expression source span.

Features `instance.mesh.3d` and, when used, `instance.realize.3d` are declared explicitly. Numeric and GPU profiles support this vocabulary; 2D-only profiles reject it. Instances introduce no callbacks, accumulated simulation state, implicit nearest-neighbor mapping or generic scene-object duplication.

## GPU consumption

The GPU consumer uses shared prototype geometry with instanced matrix and color uploads (76 bytes per selected element). Spatial evaluation also limits the expanded total to 4096 mesh, curve and sampled records, counting repeated references to the same set before allocating their evaluated transforms. Hidden and unselected records still count toward this bound.

One visible batch normally requires one draw call. Mixed reflection signs split it into contiguous runs because front-face state is object-wide in the backend. Runs preserve authored order, including equal-depth ties. The evaluated affine camera matrix remains authoritative. Instance color multiplies the unlit material and any explicitly selected prototype color attribute.

Geometry, material and instance buffers are pruned when unused and rebuilt after context restoration. `stats().instances` counts selected visible elements, whereas `drawCalls` counts submitted runs. Tests compare ten instancing cases against an independent WebGL reference and track actual buffer creation/deletion through repeated scene preparation, changing selection, pruning and disposal. Exact pixels are asserted within the tested browser, not across different drivers.
