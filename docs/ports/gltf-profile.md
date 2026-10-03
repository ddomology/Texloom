# PR39: limited glTF delivery interchange

This profile introduces glTF 2.0 as a bounded 3D delivery format. It preserves the
supported mesh, hierarchy, material and motion data. Mathematical relations,
field definitions, TeX source and lecture cues remain Texloom metadata; a glTF
asset cannot reconstruct an entire authoring scene.

## Native authoring

```tex
\usepackage{texloom-gltf}
\loomgltf[wireframe]{model}{data/gltf-profile/scene.gltf}
```

The compiler resolves local buffers, archives exact source bytes under
`gltf-sources`, validates the profile and merges the imported data into the scene.
It does not execute an asset or launch a DCC application. `.glb` is an equivalent
input container. `solid` is the ordinary solid presentation, `material=fallback`
explicitly requests the limited base-color fallback, `animation=0` selects a
clip, and `camera=0` selects a source camera. Without a camera option, the TeX
scene keeps its authored camera. Multiple animations require an explicit choice.

Capture preserves the original TeX under `gltf-sources/original/`, generated
scope/path/option declarations with hashes, the exact `.gltf` or `.glb` bytes,
and each decoded binary buffer. A GLB container archive retains its original
padding; the separately archived payload excludes BIN padding. Local buffer
paths may traverse within the authoring TeX directory's package tree, but cannot
escape it. External buffers use `.bin`; supported inline data-URI MIME types are
`application/octet-stream` and `application/gltf-buffer`. Capture is bounded to
eight imports, 64 buffers per asset, 8 MiB JSON and 64 MiB total input bytes.
The imported result is bounded before expansion to 1,024 mesh resources, 4,096
spatial nodes, 65,536 vertices and 262,143 triangle indices.

The import scope `model` separates node and resource identities from other
imports. Mesh primitives shared by several source nodes remain shared immutable
resources. Scene hierarchy and per-node transforms are retained; a source mesh
is not copied merely because another node uses it.
Scopes contain at most 64 ASCII characters: a letter followed by letters,
digits, underscores or hyphens (`[A-Za-z][A-Za-z0-9_-]{0,63}`).

## Supported subset and conversions

- Triangle primitives with float32 positions, optional unit normals, unsigned
  index accessors and validated ranges/alignment. Supported accessor components
  are decoded before publication; malformed, sparse or compressed layouts are
  diagnosed rather than guessed.
- Opaque `KHR_materials_unlit` base colors. The factor is linear RGB and the
  renderer's display-color representation is derived explicitly. Full PBR,
  textures, lighting and general material graphs are outside this profile.
  An omitted material has glTF's default PBR semantics, so it also requires the
  explicit `material=fallback` option; fallback and display-color quantization
  are recorded in the conversion report.
- One selected animation containing STEP or LINEAR translation, scale and
  quaternion rotation. LINEAR rotation uses shortest-path spherical interpolation;
  it is not component-wise quaternion interpolation. STEP uses the value at the
  current knot, including an exact discontinuity.
- Finite supported static cameras selected explicitly, with a proper rigid
  global basis. A source camera's aspect
  ratio must agree with the logical viewport when present. Camera optical axes
  are accounted for separately from converted mesh local coordinates. The camera
  and all its ancestors must remain static. glTF derives its view from rotation
  and translation, so an arbitrary affine Texloom camera is not interchangeable:
  global camera scaling, reflection and shear are rejected. This is a global
  check; mutually cancelling local scales are allowed when the final basis is
  proper rigid.
- Reflected and nonuniform affine transforms. glTF uses right-handed Y-up metres;
  Texloom uses right-handed Z-up metres. Conversion is the proper rotation
  `C(x,y,z)=(x,-z,y)`, with local geometry transformed by `C` and node transforms
  conjugated consistently. Normals use inverse transpose, independent of the
  determinant sign used for front-face winding.

Skinning, morph targets/weights, CUBICSPLINE animation, advanced extensions,
compressed geometry and full shaders are rejected. A required unsupported
extension cannot be silently ignored. Any explicitly chosen material fallback
is reported; the report does not claim preservation of features it discarded.

The JavaScript importer takes an already resolved JSON asset and base64 binary
buffers. The compiler owns local path resolution and containment. No implicit
network fetch or executable callback is part of the portable asset contract.

## Explicit delivery export

```sh
node tools/export-gltf.mjs build/gltf-profile/bundle.json --out build/gltf-export
```

The destination must be new. The command prepares `scene.gltf`, portable
`buffer-NNN.bin` payloads, `conversion-report.json` and `texloom-sidecar.json`,
then publishes the completed directory together. It refuses to overwrite an
existing directory. The conversion report and sidecar are part of the result:
glTF alone does not carry Texloom's mathematical and lecture semantics.

Delivery export accepts explicit triangle meshes, groups and supported numeric
TRS tracks in metres. Unevaluated geometry programs, clipping, native overlays,
curves, custom mesh attributes and hidden mesh nodes require a separate explicit
conversion and are rejected here. Native wireframe is reported as a conversion
to solid delivery triangles and retained in the sidecar.

Binary geometry and animation accessors use finite float32. The export report
records rounded component counts and the largest component rounding difference;
distinct key times that collapse after conversion are rejected. Static JSON
transforms and camera parameters retain their finite double-precision values.
The precision report is not a global rendered-error bound. The sidecar records
native authoring metadata and the spatial source description, but is explicitly
not an automatic lossless reconstruction recipe.

Camera export also needs the bundle viewport or an explicit fragment
`requiredAspectRatio` (directly or in its import report); it does not invent
viewport dimensions when a source perspective camera omitted its aspect ratio.

## Original fixture and independent reference

`tools/gltf/create_fixture.py` creates the original fixture in
`examples/data/gltf-profile`. No upstream model or implementation is copied.
The scene has a parent assembly, three instances of one faceted hexagonal
bipyramid and a separate static camera. Three material primitives alternate
mint colors, so faces remain readable with an unlit renderer. Geometry uses
36 expanded vertices and 12 outward-facing triangles. One instance is reflected
and nonuniformly scaled. The source binary buffer is only 1,160 bytes.

The eight-second animation combines LINEAR translation, quaternion rotation and
STEP scale. Its union of knots is `0,2,3,4,5,6,8`. The independent reference also
samples six intermediate or boundary-adjacent times, including both sides of
the STEP at two seconds. `scene.gltf` plus `scene.bin` and `scene.glb` contain the
same data; their documents differ only by the external buffer URI.
Both containers also pass the separately pinned official Khronos
`gltf-validator` version `2.0.0-dev.3.10` with zero errors and warnings. That
validator checks format conformance; it does not replace the independent motion
and coordinate oracle.

`tests/gltf_oracle.py` reads the actual float32 payload without importing the
generator or TypeScript importer. It independently composes hierarchical TRS,
computes quaternion SLERP, applies inverse-transpose normals and converts world
coordinates. The committed `reference.json` records indexed world points,
normals, transforms and source hashes. Reported sampled bounds are not a proof
of continuous-time extrema.

The generator uses algebraic regular-hexagon coordinates so exact zeros do not
acquire platform-specific trigonometric residuals. Stored reference floats are
rounded to 12 decimal places with a positive zero sign for portable archive
bytes. This serialization policy does not round the runtime oracle's numeric
calculations or loosen its full-precision acceptance tolerances.

```sh
python tools/gltf/create_fixture.py --out build/reproduced-gltf
python tests/gltf_oracle.py --asset build/reproduced-gltf/scene.gltf --out build/reproduced-gltf/reference.json
python -m unittest tests.gltf_fixture_test -v
```

Acceptance compares the actual shared runtime to this oracle at every selected
time, including discontinuities; verifies selected-camera optical orientation;
and checks source immutability, shared resources and reverse seeking. Container
and export tests establish the declared subset, not universal glTF compliance.
Between animation knots, the supported interpolation semantics are checked
directly instead of treating sampled endpoint agreement as sufficient evidence.

## Primary sources and boundary

The format reference is the [Khronos glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html).
The immutable reviewed source is KhronosGroup/glTF commit
`8e691206fa2e981fc3b8c8bc57e671595576c971`: the
[specification](https://github.com/KhronosGroup/glTF/blob/8e691206fa2e981fc3b8c8bc57e671595576c971/specification/2.0/Specification.adoc)
and [KHR_materials_unlit contract](https://github.com/KhronosGroup/glTF/blob/8e691206fa2e981fc3b8c8bc57e671595576c971/extensions/2.0/Khronos/KHR_materials_unlit/README.md).
The specification source declares CC-BY-4.0. This is an independent implementation
with attribution, not a copied renderer or a certification claim.

PR39 completes limited delivery interchange. A native sidecar remains necessary
for mathematical meaning and authoring history. Broader extensions and editable
scene reconstruction require separate contracts and evidence.
