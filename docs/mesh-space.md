# Mesh resources and 3D spaces (PR29)

PR29 adds portable indexed meshes and a static 3D numeric evaluation to Bundle
0.3. The existing 2D scene remains in bp with +Y down. `bundle.space3d` declares
its own units and a right-handed, Z-up world. There is no implicit conversion
between these two coordinate charts.

The evaluated result contains instance matrices, bounds, winding orientation
and an optional affine camera view. Projection, materials, GPU rendering and
3D timeline animation belong to later work. The current SVG, Canvas, Lemniro
and Chalkspace render profiles reject required 3D features before rendering.

## TeX authoring and compilation

Load `texloom-space3d` and put literal declarations after the scene declaration:

```tex
\documentclass{article}
\usepackage{texloom-space3d}
\begin{document}
\TLScene{Triangle in metres}{640}{360}{4}
\loommesh{triangle}|{
  "kind":"mesh", "version":1, "primitive":"triangles",
  "units":"m", "coordinateSpace":"object", "winding":"ccw",
  "topologyRevision":"triangle-1",
  "positions":{
    "version":1,"componentType":"float64","components":3,
    "count":3,"byteOffset":0,"byteStride":24,
    "data":[0,0,0, 1,0,0, 0,1,0]
  },
  "indices":{
    "version":1,"componentType":"uint16","components":1,
    "count":3,"byteOffset":0,"byteStride":2,"data":[0,1,2]
  },
  "bounds":{"min":[0,0,0],"max":[1,1,0]}
}|
\loomspace|{
  "version":1,"units":"m","handedness":"right","upAxis":"z",
  "nodes":[
    {"kind":"group","id":"root","transform":{"translation":[2,0,0]}},
    {"kind":"mesh","id":"sheet","parent":"root","resourceId":"triangle"}
  ],
  "camera":{"id":"camera","transform":{"translation":[0,0,5]}}
}|
\end{document}
```

The commands capture JSON literally; TeX does not calculate mesh data or expand
the JSON into executable code. The verbatim argument also accepts balanced
braces (`\loommesh{id}{...}` and `\loomspace{...}`); the displayed `|...|`
form keeps the JSON delimiter separate from TeX's argument braces. These commands
must be written directly in the source, following the existing literal-capture
rules. Captured declarations and their source spans are archived under
`space3d-sources`, with `bundle.provenance.space3dCapture` recording provenance.
Declare at most one space per scene. Mesh declaration IDs match
`[A-Za-z_][A-Za-z0-9_.:-]*`, with at most 512 characters. Capture is limited to
2,000,000 bytes per JSON declaration, 16,000,000 bytes total and 4,096
declarations. Duplicate JSON keys, duplicate resource IDs, nonfinite values and
excessive JSON nesting are diagnosed before bundle publication.

Compile the complete fixture to a numeric bundle:

```sh
python tools/compile.py examples/mesh-space.tex --out build/mesh-space
node tools/build-mesh-inspector.mjs build/mesh-space/bundle.json build/mesh-space/inspector.html
python tools/package-scene.py build/mesh-space/bundle.json --out build/mesh-space/package
```

`tools/build.py` additionally invokes the 2D player and SVG snapshot pipeline.
Its rendering steps do not support these 3D features in PR29. Use the compiler
and numeric runtime for this milestone.

The standalone inspector displays transformed vertices in a fixed axonometric
diagram alongside world/view matrices and selected vertex coordinates. Its
controls prepare new static input; they do not introduce a 3D animation clock.
All triangle edges remain visible. The diagram supplies no depth, material or
camera projection, and camera edits change the numeric camera-space readout.

## Numeric buffer contract

```ts
interface NumericBuffer {
  version: 1;
  componentType: 'float32' | 'float64' | 'uint16' | 'uint32';
  components: 1 | 2 | 3 | 4;
  count: number;
  byteOffset: number;
  byteStride: number;
  data: number[];
}
```

`data` is a numeric JSON array, rather than serialized host memory. Each entry
is one component of the declared type. Offsets and strides are measured in
bytes of that type: 2 for uint16, 4 for float32/uint32, and 8 for float64. Element
`i`, component `c` addresses
`data[byteOffset / componentBytes + i * byteStride / componentBytes + c]`.

- Offset, stride and count are nonnegative safe integers. Offset and stride
  must be component-aligned; stride must fit the complete element.
- Every addressed element must fit in `data`. Padding before, between or after
  elements is allowed and is validated as ordinary component data.
- Both backing data and compact output are capped at 262,144 components per
  descriptor. Existing asset JSON traversal also caps an input at one million
  values and 128 nesting levels.
- Integer components must be exact integers in their unsigned type's range.
  There is no truncation or wrapping.
- Float components must be finite. Float32 components are converted with
  float32 rounding; overflow is rejected. Ordinary rounding and underflow to
  zero remain part of that explicit conversion. Float64 retains the JSON
  number's double precision.
- Getters, functions, sparse arrays, typed arrays in the portable input and
  unsupported descriptor fields are rejected.

`validateNumericBuffer` reports diagnostics. `snapshotNumericBuffer` makes a
detached, recursively frozen JSON snapshot. `copyNumericBuffer` makes a compact
typed array of the declared component type. It has no shared backing allocation
with the input or another call. Callers may mutate their owned arrays; this
does not modify the stored resource.

## Mesh resource contract

```ts
interface MeshResource {
  kind: 'mesh';
  version: 1;
  primitive: 'triangles';
  units: 'unit' | 'm' | 'cm' | 'mm';
  coordinateSpace: 'object';
  winding: 'ccw';
  topologyRevision: string;
  positions: NumericBuffer;
  indices: NumericBuffer;
  normals?: NumericBuffer;
  bounds: {min: [number, number, number]; max: [number, number, number]} | null;
  provenance?: Record<string, unknown>;
}
```

Positions and optional normals have three float32 or float64 components per
vertex. Indices have one uint16 or uint32 component, with a count divisible by
three. Every index refers to an existing vertex. Normals have the same element
count as positions and must have unit length within `1e-4` after conversion.
They are not regenerated, normalized or forced to match a triangle's face
normal. Zero normals are invalid.

Bounds are the **exact extrema of the converted position buffer**, including
unreferenced vertices. For float32 positions, calculate bounds from the
float32 values, not the unrounded JSON values. An empty mesh has zero vertices,
zero indices and `bounds: null`; optional normals must also be empty. A
vertex-only point cloud is outside this triangle contract.

`topologyRevision` is a nonblank authored identity of at most 512 characters.
It does not replace the resource's content hash or automatically authorize
interpolation between meshes. Identical revisions do not prove identical
indices.

CCW establishes the order used to define front faces in object space. Open,
nonmanifold and independently authored normal data are allowed. Validation does
not infer an outward side for arbitrary surfaces. Repeated-index and
numerically zero-area triangles remain in place with `MESH_DEGENERATE` warnings;
the library does not silently delete or reorder them.

`validateMeshResource` returns errors and warnings. `snapshotMeshResource`
rejects errors and preserves valid data, including warned triangles.
`copyMeshBuffers` returns fresh compact `positions`, `indices`, optional
`normals`, frozen bounds, `triangleCount` and `degenerateTriangles`. The numeric
arrays are deliberately writable and never alias the shared immutable resource.

### Asset ownership and delivery

Meshes use the existing `application/vnd.texloom.resource+json` payload and
`texloom-package/1` manifest. The mesh entry's bounds are the 3D min/max object
or null; vector and scalar-field entries retain their 2D bounds contracts.
Inline, external and packed-range payloads have the same SHA-256 and byte-length
checks. This version does not introduce a binary vertex transport format.

The asset store shares one verified frozen JSON resource between leases.
Consumer-owned typed arrays are derived explicitly after preparation; they are
not inserted into the portable bundle or cached as writable shared handles.
Cancellation, disposal and late resolver results follow the existing
[asset lifecycle contract](assets.md).

## Static 3D scene contract

```ts
type Transform3D =
  | {translation?: Vec3; rotation?: [number, number, number, number]; scale?: Vec3}
  | {matrix: Matrix4};

interface Space3D {
  version: 1;
  units: 'unit' | 'm' | 'cm' | 'mm';
  handedness: 'right';
  upAxis: 'z';
  nodes: Array<
    | {kind: 'group'; id: string; parent?: string; transform?: Transform3D}
    | {kind: 'mesh'; id: string; parent?: string; transform?: Transform3D;
       resourceId: string; visible?: boolean}
  >;
  camera?: {id: string; parent?: string; transform?: Transform3D};
}
```

The space requires Bundle 0.3. It permits at most 4,096 nodes plus the optional
camera. Node and camera IDs share a unique 3D namespace and contain 1–256
characters. Referenced resource IDs allow 1–512 characters. Neither may have surrounding whitespace. Parents
must name 3D groups. Cycles, missing mesh resources and unit mismatches are errors. Unit
conversion must happen explicitly before import. `visible` is a mesh-instance
boolean and defaults to true; it is not an inherited group property in PR29.

Matrices are column-major and act on column vectors. They are finite affine
matrices with last row `[0,0,0,1]`. A transform uses either a matrix or TRS,
never both. TRS composes as `translation * rotation * scale`. Quaternions use
`[x,y,z,w]`, must be nonzero and are normalized during composition. Helper
angles use radians and the right-hand rule. Defaults are zero translation,
identity rotation and unit scale. Parent composition is
`world = parentWorld * local`.

`prepareSpace3D` returns a frozen static evaluation. The normal evaluator
attaches this as `frame.space3d` for every sampled time. Existing 2D animation
can continue in the same bundle, but 3D transforms, visibility and buffers have
no timeline bindings in PR29.

Each evaluated instance contains:

| Field | Meaning |
| --- | --- |
| `id`, `resourceId`, `topologyRevision` | Stable instance and source identities |
| `visible` | Authored instance visibility |
| `worldMatrix` | Object-to-world affine map |
| `modelViewMatrix` | `viewMatrix * worldMatrix`, or null without a camera |
| `normalMatrix` | Inverse-transpose of the object-to-world linear part, or null when singular |
| `orientation` | Determinant sign: -1, 0 or +1 |
| `worldWinding` | `cw` after reflection, `ccw` without reflection, null when singular |
| `worldBounds` | Transformed object AABB, or null for empty geometry |

World bounds enclose the transformed eight corners of the object's AABB. They
are conservative bounds rather than a tight hull of transformed vertices.
Hidden instances retain validated numeric metadata.

### Normals, reflection and singularity

An ordinary direction uses the linear transform. A normal uses its
inverse-transpose and is normalized by `transformNormal3D`. Translation is
irrelevant. The normal transform does not multiply by the determinant sign:
reflection changes triangle winding separately. For invertible linear `M`,
`cross(Mu, Mv) = det(M) * inverseTranspose(M) * cross(u, v)`.

For example, reflecting X reverses a CCW triangle's winding while an authored
Z normal can retain its direction. Consumers receive both the normal matrix
and winding metadata and can apply their declared front-face policy.

Singular mesh transforms still have meaningful forward positions and bounds.
Their normal matrix and world winding are null, `orientation` is zero, and the
frame carries `SPACE3D_SINGULAR_NORMAL`. Requesting an inverse or transformed
normal directly throws `MATRIX4_SINGULAR`. Unrepresentable finite-range results
produce `MATRIX4_RANGE`; determinant-sign queries do not require a representable
determinant magnitude.

### Affine camera only

The optional camera is an affine pose in the same hierarchy. Its local forward
axis is -Z and local up axis is +Y, while the world remains Z-up. The view matrix
is the inverse of its world matrix. A singular camera is invalid. There are no
perspective/orthographic projection parameters, clipping planes, viewport
mapping or automatic look-at behavior in this contract yet.

## Capability negotiation and sampling

`NUMERIC_3D_PROFILE` (`texloom.numeric3d/1`) supports the existing 2D feature
vocabulary plus `mesh.triangles.3d`, `transform.affine.3d` and `camera.affine.3d`.
It promises numeric preparation and evaluation, without rasterization.

```ts
import {beginPrepareScene, NUMERIC_3D_PROFILE, copyMeshBuffers} from 'texloom';

const preparation = beginPrepareScene(scenePackage, {
  profile: NUMERIC_3D_PROFILE,
  assetResolver: hostResolver,
});
const runtime = await preparation.ready;
const frame = runtime.sample(0);
const instance = frame.space3d!.instances[0];
const owned = copyMeshBuffers(frame.resources[instance.resourceId]);
// Read instance.worldMatrix and owned.positions in a numeric consumer.
runtime.dispose();
```

The asynchronous preparation default remains the SVG 2D profile, so request
the numeric profile explicitly. `prepareScene(bundle)` also supports numeric
sampling; call its `require(NUMERIC_3D_PROFILE)` when selecting that consumer.
Feature inventory includes hidden and unused mesh resources. Existing 2D
renderers report unsupported capabilities rather than dropping those meshes.

## Completion criteria and next step

PR29's acceptance surface is:

- Versioned JSON resources, strict buffer/index/bounds validation, explicit
  warnings and owned typed arrays.
- Hierarchical affine composition, camera inversion, inverse-transpose normals,
  reflection and singular cases checked numerically.
- Immutable source data and static 3D frames independent of sample order.
- Existing asset hash, sharing, cancellation and disposal behavior for meshes.
- Literal TeX declarations compiled into the same validated bundle with source
  archives, plus explicit rejection by unsupported 2D render profiles.

The focused checks live in `tests/buffers.test.ts`, `tests/mesh.test.ts` and
the accompanying matrix, scene, asset and compiler suites. Final full-suite
counts belong to the PR's verification report.

**PR30 next:** define projection/camera parameters and an initial 3D rendering
profile, then verify its visible output and exact-time export. Static numeric
success here does not establish rendering parity, lighting, texturing, 3D
animation, glTF import/export or Blender compatibility.

## Design references

The [Blender/runtime research](research/blender-runtime.md) records the upstream
evidence and the original architectural proposals. Useful reference boundaries
are the [Blender dependency graph](https://developer.blender.org/docs/features/core/depsgraph/),
[glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
and [Three.js BufferGeometry documentation](https://threejs.org/docs/pages/BufferGeometry.html).
PR29 is an independently implemented Texloom contract; these links do not
claim a format adapter, copied upstream implementation or complete feature parity.
