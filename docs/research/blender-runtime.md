# Blender, portable scenes, and browser rendering

Research date: 2026-10-02. Scope: architectural evidence for Texloom, not a claim
that the current 2D implementation supports Blender's feature set. Source facts
and Texloom recommendations are separated below. URLs are primary documentation.
Some Blender documentation pages were available through the search index but
their direct fetch returned an access error; the linked version and language are
retained rather than silently substituting an unverified current page.

## Decision summary

**Recommendation:** keep TeX as an authoring frontend, Texloom as the versioned
scene/evaluation contract, and web/Chalkspace/Blender as consumers or adapters.
Expand through explicit geometry, animation and sampled-data capabilities.
Preserve the existing `authored bundle -> evaluate(t) -> frame -> renderer` split.
It is a useful foundation for multiple renderers, but it needs capability
negotiation, typed geometry and external buffers before broad 3D work.

Blender is useful both as architectural reference and, later, as an optional
offline producer/renderer. Its procedural execution graph and renderer internals
should not become mandatory browser dependencies. A glTF file is a useful 3D
delivery asset; it is not a replacement for the Texloom object and relation model.

## What the sources establish

### 1. Authoring state and evaluated state are distinct

Blender's dependency graph design evaluates copies of source data and exposes
evaluated transforms, geometry and materials to render engines. It describes
converting unsupported non-mesh geometry into evaluated meshes for consumers,
and treating cached objects as another evaluation input. This is a design
document originating in the Blender 2.8 architecture, not a new promise about
every current implementation detail. [Blender dependency graph design](https://developer.blender.org/docs/features/core/depsgraph/)

The Python API demonstrates access to evaluated objects, temporary meshes with
modifiers applied, and object instances together with their matrices. Temporary
meshes have explicit cleanup ownership. These are practical adapter boundaries
for exporting *results* of Blender evaluation. [Depsgraph API, Blender 5.0](https://docs.blender.org/api/5.0/bpy.types.Depsgraph.html)

**Recommendation:** a Texloom renderer should receive a resolved frame, including
world transforms or enough explicit hierarchy to compute them, geometry handles,
materials, and visible instances. It should never rerun relations independently.
Keep source identities and source locations alongside evaluated data; do not
mutate the authoring bundle during playback. Cache keys must include source,
operator version, inputs, quality settings and time where applicable.

### 2. A field is not the same thing as a simulation

Geometry Nodes fields are functions evaluated in a geometry/domain context.
The same field expression can produce different results at two places in a
node graph because the input geometry differs. [Geometry Nodes fields](https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/fields.html)

Simulation zones, in contrast, permit one frame's result to affect the next;
they are evaluated as the animation frame changes and use cached state.
Substeps and interpolation are explicit concerns. [Simulation zone, Blender 5.0](https://docs.blender.org/manual/en/5.0/modeling/geometry_nodes/simulation/simulation_zone.html)

Blender's geometry bake cache is explicitly **not** an interchange format, and
compatibility between Blender versions is not guaranteed. Volumes have a
separate OpenVDB exception. [Geometry Nodes baking, Blender 5.0](https://docs.blender.org/manual/id/5.0/modeling/geometry_nodes/baking.html)

**Recommendation:** expose three different operation classes:

| Class | Runtime contract | Example |
|---|---|---|
| Pure geometry/field | Same inputs and time produce the same result | Parametric surface, scalar field on mesh vertices |
| Sampled result | Read immutable samples and apply declared interpolation | Exported wave displacement, mesh positions over time |
| Stateful computation | Precompute with fixed settings, or restore a checkpoint and replay | Numerical PDE, particles, collision simulation |

Do not claim arbitrary random seeking for stateful operations until replay or
baking is implemented. Never put `deltaTime` integration into a renderer: a
30 fps export, a 60 Hz browser and a backwards seek must consume the same result.
For the first scientific-data milestone, support arrays from an external solver;
keep the numerical solver and error analysis outside the rendering core.

### 3. glTF is a delivery format with a bounded semantic model

The glTF specification defines an API-neutral runtime asset delivery format,
scene nodes, meshes, materials, cameras, binary buffers/accessors and animation.
Core animation targets translation, rotation, scale and morph weights; richer
behaviors need extensions or a different representation. [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)

The Blender exporter documents transform, bone and shape-key animation, and
notes other animated properties can be ignored. This is an exporter capability
statement, not a guarantee about all glTF extensions. [Blender glTF exporter, 5.0](https://docs.blender.org/manual/id/5.0/addons/import_export/scene_gltf2.html)

**Recommendation:** import/export glTF as a typed resource/profile for meshes,
materials, cameras and supported animation. Preserve relations such as “this
label follows this curve” in Texloom. Bake unsupported procedural behaviors or
report them. A successful glTF export does not establish semantic round-trip
compatibility with a Geometry Nodes graph, TikZ construction, or lecture script.

### 4. USD is a strong interchange reference, not an automatic runtime

OpenUSD separates typed scene descriptions, references/layers/variants and
time-varying attributes. Hydra separates scene and render delegates. USD's
documentation also distinguishes scene composition and the OpenExec computation
framework from a complete rigging system: execution behavior does not become
portable merely because its data can be encoded. [OpenUSD introduction](https://openusd.org/release/intro.html)

**Recommendation:** adopt the useful ideas—stable asset references, explicit
schemas, instancing, sampled properties, named capability profiles—without
requiring a USD runtime in every lecture webpage. Add a USD adapter only when a
real production interchange case justifies it. It should remain optional.

### 5. Browser renderer coverage must be declared

Three.js `BufferGeometry` represents mesh, line and point geometry using vertex
and index buffers, including normals, UVs and custom attributes. Some indirect
draw features specifically require its WebGPU backend. [BufferGeometry](https://threejs.org/docs/pages/BufferGeometry.html)

`InstancedMesh` reuses geometry/materials with distinct transforms to reduce
draw calls; this supports a resource/instance distinction in an IR.
[InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)

`WebGPURenderer` tries WebGPU and can fall back to WebGL 2. Its guide still calls
the renderer experimental, and warns that `ShaderMaterial`, `RawShaderMaterial`,
`onBeforeCompile` customizations and the old `EffectComposer` stack do not port
unchanged to its node/TSL approach. Fallback is not universal feature parity.
[WebGPURenderer guide](https://threejs.org/manual/pages/webgpurenderer)

Three.js's SVG renderer can project geometric scenes but documents no advanced
shading, textures or shadows. SVG cannot honestly be the full-fidelity fallback
for a rich 3D material system. [SVGRenderer](https://threejs.org/docs/pages/SVGRenderer.html)

**Recommendation:** preserve the current dedicated SVG renderer for diagrams and
TeX. Add a Canvas 2D consumer for Chalkspace, then a separate Three.js adapter for
a documented 3D subset. Use WebGL 2 as an initial baseline where it meets the
scene's needs; make WebGPU enhancements capability-gated and test both paths.
Keep Three.js classes, TSL nodes and GPU handles out of the portable bundle.

### 6. Blender can be an optional offline adapter

Blender's CLI supports background operation, Python scripts, frame rendering
and a Python exception exit code. Argument order matters. These make a pinned
Blender process a practical batch producer or rendering backend.
[Blender command-line arguments](https://docs.staging.blender.org/manual/en/latest/advanced/command_line/arguments.html)

Blender is GPL software; its official license page separately states that
artwork and output data may be used by their creator, including commercially.
Copying source code and generating assets are therefore distinct integration
questions. [Blender license and artwork](https://www.blender.org/about/license/)

**Recommendation:** implement an optional adapter script with explicit inputs,
outputs, toolchain version and license provenance. Prefer executing Blender's
supported APIs over transplanting source into the TypeScript runtime. Any actual
source port needs its own license and attribution review; a process boundary is
not a blanket legal conclusion. No Blender code is copied by this research.

## Proposed portable IR boundaries

This is an architectural proposal, not the current schema.

```text
TeX/TikZ + explicit scene declarations       External tools/solvers
                   |                          |       |
                   v                          |       v
        semantic scene + relations <--- sampled geometry/fields
                   |
          versioned typed operators
                   |
          deterministic evaluated frame
         /               |               \
    SVG / DOM        Canvas/Chalkspace    3D adapter
         \               |               /
              exact-time capture / video
```

1. **Scene layer:** stable IDs, hierarchy, instances, cameras, visibility,
   presentation layers, clip structure, coordinates and physical/display units.
   Retain 2D bp/y-down semantics; add an explicit 3D coordinate space and a tested
   projection transform rather than reinterpreting existing coordinates.
2. **Geometry layer:** typed line/quadratic/cubic segments, curves with domains,
   point sets, indexed meshes, fixed or variable topology, spatial bounds,
   named attributes and interpolation domains. Preserve canonical geometry;
   tessellation is a quality-controlled derived result.
3. **Appearance layer:** portable solid/stroke/unlit options first; later a
   documented PBR subset. Chalk grain and eraser behavior are consumer-specific
   presentation choices over shared geometry. Explicit unsupported-material
   diagnostics are preferable to silently dropping a shader.
4. **Animation layer:** time in seconds, precise interval/end-point semantics,
   easing, sequence/parallel composition, source-target identity, relations,
   repeat policy and seed. Keep sound/lecture cues on the same clock but do not
   execute them as side effects of every frame evaluation.
5. **Data layer:** immutable resource IDs plus content hashes; buffers with
   component type, shape/count, byte range, endian convention and validation.
   Use an asset resolver to load them before synchronous sampling. Avoid giant
   per-frame JSON arrays and copying static vertex data on every evaluation.
6. **Computation layer:** explicit operator name/version, input references,
   output type, execution class and determinism declaration. Built-in pure
   kernels first; browser code is not transported as an arbitrary function.
   Unknown required operators must fail validation with a useful diagnostic.
7. **Provenance layer:** TeX/DVI originals, source maps, native tool versions,
   bake settings, numeric units, error bounds where applicable, and artifacts.
   Artifacts preserve reproducibility but do not replace semantic objects.

For a “wave on a manifold” example, the minimum useful bundle is: an indexed
surface with stable vertex identities, a scalar sample per vertex per sample
time, an explicit displacement/color map, interpolation, and camera/labels.
An analytical formula or external numerical solver can produce these arrays.
If topology changes, continuous interpolation between unrelated vertex arrays
must be rejected or replaced by a declared remapping/step policy.

## Capability and fallback contract

Each bundle declares required features and available alternative resources.
Each consumer reports support with parameters, such as clip shapes, path kinds,
mesh size, material model and sampling method. Resolve these before playback.

| Feature | Preferred consumption | Explicit fallback |
|---|---|---|
| Measured TeX/path geometry | SVG or Canvas paths | Pre-rendered image only when declared |
| Editable 2D curves | Shared geometry evaluator + native renderer | Tessellated polyline with tolerance |
| Instanced mesh | GPU instances | Expanded geometry within a stated budget |
| Portable unlit/PBR mesh | Three.js adapter | Prepared image/video or diagnostic |
| Stateful solver result | Versioned baked sample data | Deterministic checkpoint replay, if implemented |
| Blender-only shading/volume | Optional offline render | Authored video/image asset |

Every chosen fallback should record whether interaction, fidelity or editability
was lost. Missing required capabilities should not silently render a partial
lecture. Profiles can make “web + Chalkspace” a compile target: the compiler
either produces both valid consumer plans or reports the exact unsupported node.

## Phased milestones and acceptance gates

The stages below are ordered technical gates, not calendar estimates.

| Stage | Deliverable | Acceptance gate |
|---|---|---|
| Foundation | Capability inventory, renderer interface, one clock, frame/resource ownership | Same 2D scene and time produce matching geometry in web and Chalkspace; reverse seek passes |
| Geometry | Typed curves, sampling, tangents, trim/reveal, intersections with branch policy | Degenerate/tangent cases diagnosed; declared tolerances tested under transforms |
| Choreography | Sequence/parallel/stagger, references, relations, explicit morph correspondence | Start/end, overlap and zero-duration rules tested; independent of capture fps |
| 3D subset | Mesh/instances, orthographic/perspective cameras, unlit appearance, TeX overlay | Browser frame and exported frame agree within defined rendering tolerances |
| Fields | Fixed-topology sampled meshes/scalars/vectors, binary buffers, asset loading | Analytical example verified numerically; missing chunks/topology changes diagnosed |
| Simulation adapter | Bake manifest, external solver/Blender producer, checkpoints if needed | Reordering seeks never changes output; provenance and bake hashes verified |
| Optional interchange | Bounded glTF/USD/Blender import/export profiles | Fixture matrix states preserved, baked and rejected features explicitly |

The next release should implement the **foundation plus a coherent 2D geometry
vertical slice**. It should create a real second consumer, not merely a different
CSS skin around the same SVG page. That proves the architectural claim before
adding large new classes of geometry.

## Explicit non-goals for the first expansion

- Reimplementing Blender's modeling UI, entire modifier stack, physics engines,
  Cycles, or all material nodes.
- Automatic semantic extraction of every arbitrary `.blend`, TikZ or Python
  program; a renderable static artifact and an editable live object differ.
- Universal SVG parity for textured/shadowed 3D scenes.
- Transporting Blender's private cache format as a portable Texloom resource.
- Claiming a PDE solver from a heatmap or analytical sample animation.
- Claiming exact cross-GPU pixel equality for all future 3D materials. Geometry,
  timing, numerical samples and image tolerances need separate contracts.

Success is a growing set of independently testable capabilities and useful
authoring abstractions. “TikZ + Manim + Blender breadth” is an architectural
direction requiring multiple milestones, not a single-release compatibility
claim.
