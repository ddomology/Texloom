# PR38: evaluated Blender scenes as portable assets

This producer runs **Blender 4.5.9** outside the browser, evaluates the dependency
graph at declared times, and writes a `blender-evaluated/1` manifest. The browser
and Chalkspace consume ordinary Texloom meshes, transforms and PR36 position
bakes. They do not contain Blender, Python callbacks or a Geometry Nodes engine.

## Reproduce the fixture

`tools/blender/toolchain.json` pins the Windows and Linux archive hashes and the
Blender build. Set `BLENDER_EXE` to that executable; no system installation or
interactive Blender window is needed.

```sh
"$BLENDER_EXE" --background --factory-startup --python-exit-code 1 \
  --python tools/blender/create_fixture.py -- --out build/blender-producer/source.blend

"$BLENDER_EXE" --background build/blender-producer/source.blend --python-exit-code 1 \
  --python tools/blender/export_scene.py -- --out build/blender-producer/export \
  --times 0,0.25,1,2,4,6,8

"$BLENDER_EXE" --background build/blender-producer/source.blend --python-exit-code 1 \
  --python tools/blender/reference_scene.py -- --out build/blender-producer/reference.json \
  --times 0,0.25,1,2,4,6,8
```

PowerShell uses `& $env:BLENDER_EXE` instead of `"$BLENDER_EXE"`. Run the commands
from the repository root. Creating the `.blend` again creates a new source file;
its recorded hash identifies that file. Repeated export of the same unchanged
file with the same producer/configuration has identical payload bytes. Export
requires a new output directory and refuses to overwrite an existing directory.
Conversion happens before that directory is published.

## Native TeX import

```tex
\usepackage{texloom-blender}
\loomblender{model}{data/blender-evaluated/manifest.json}
```

The compiler reads the existing manifest; compiling TeX never launches Blender.
It validates the portable data, archives the declaration and imported source
bytes under `blender-sources`, and scopes imported IDs under `model`. An authored
3D group named `model` can position the whole import. Resources remain shared
when collection instances are lowered to mesh children. The import report
records that representation change and every ID mapping.

Use `\loomblender[wireframe]{model}{data/blender-evaluated/manifest.json}` to
display the evaluated edges, or `[solid]` to force filled geometry. This is an
authored presentation override applied after manifest validation. It leaves
the source manifest, color, shared geometry, sampling and producer report
unchanged and is recorded separately in the import report. The default keeps
the material presentation supplied by the producer.

## Conversion contract

| Blender result | Portable representation |
| --- | --- |
| Evaluated mesh after modifiers | Object-space metre coordinates and triangles |
| Static evaluated split/corner normals | Expanded triangle corners with preserved normals |
| Fixed-topology geometry that changes over time | PR36 absolute-position bake, explicit knots and recomputed triangle normals |
| Repeated identical evaluated geometry | Shared mesh resource; separate instance transforms |
| Static affine object/instance transform | Explicit column-major matrix |
| Animated transform representable by TRS | Declared translation, rotation and scale tracks |
| Supported opaque material color | Texloom unlit color |
| Unsupported material with explicit fallback | Unlit replacement plus an unsupported-entry diagnostic in the report |

The source basis and target basis are both right-handed and Z-up. There is no
hidden Y/Z swap. `scene.unit_settings.scale_length` is recorded as
`metersPerBlenderUnit`; the producer applies it to local coordinates and world
translations. Unit conversion does not alter dimensionless rotation or scale.

The material subset is an opaque viewport diffuse color, or a directly connected
Principled surface with constant base color. The producer converts linear RGB to
an sRGB hex color for the unlit consumer. Linked color, alpha, transmission,
emission, connected volume, displacement and multiple used material slots require the explicit
`--unsupported-material fallback` option or fail. Fallback uses the viewport
diffuse color and records the unsupported material; it never executes that shader
in the browser.

Visible non-mesh geometry such as curves and text is rejected rather than
silently omitted. Empty instancers, cameras and lights are explicitly outside
the exported geometry inventory. The retained raw position/normal samples have
an aggregate 64 MiB budget checked during collection, before the next snapshot
is stored. Animated TRS reconstruction checks the linear 3×3 block independently
of translation, so a large translation cannot hide unsupported shear.

Time is in seconds relative to `scene.frame_start`, with
`frame = frame_start + time * (fps / fps_base)`. Fractional frames use Blender's
subframe evaluation. The requested times start at zero and strictly increase
through the declared duration. Positions between exported knots are linearly
interpolated by Texloom; this does not reproduce arbitrary Blender deformation
exactly between those knots. Animated transforms use the declared native track
semantics. Unsupported animated shear or changing topology is rejected.

### Reflections and normals

A negative determinant is retained in the world transform. The evaluated frame
therefore reports reversed world winding and the GPU consumer adjusts culling.
Normal direction uses the inverse transpose of the linear transform; it is not
multiplied by the determinant sign. Applying that extra sign would make mirrored
smooth normals point the wrong way.

For a changing mesh, version 1 stores positions and recomputes flat triangle
normals. It does not silently claim preservation of animated custom or smooth
normals. This conversion is explicit in each object's `normalPolicy`. The
independent oracle checks static corner normals directly, and checks the
documented triangle-normal result for deformed meshes.

## Actual acceptance scene

The source script creates a small scene in centimetre-sized Blender coordinates:

- **TwistedColumn** starts with 42 authored vertices. Bevel and fixed
  triangulation produce 96 evaluated vertices and 188 triangles; an animated
  twist changes positions while preserving triangle identities.
- **OrbWest**, **OrbEastMirror** and **OrbNorth** are genuine dependency-graph
  collection instances of one 42-vertex, 80-triangle sphere. One translates over
  time; another has a negative, nonuniform scale.
- The two unique corner-expanded prototypes contain 804 vertices. The unit
  factor is approximately 0.01 metre per Blender unit, exactly as stored by
  Blender's floating-point setting.
- The fixture covers eight seconds and seven selected sample times. Its bounds
  fit within roughly 2.5 m × 0.7 m × 2.4 m.

`reference_scene.py` independently reopens and evaluates the `.blend` with
Blender. It uses Blender's own matrix multiplication and inverse-transpose
normal operations, rather than importing exporter helpers. The acceptance test
then lowers the manifest, evaluates Texloom at every chosen time, and compares
every expanded world vertex and normal. Blender's float32 operations and the
consumer's float64 arithmetic are allowed a small explicit coordinate/normal
tolerance; no exact floating-point identity is claimed across those engines.

The same tests verify modifier application, true instance sharing, reflection,
source immutability, repeated-export byte equality, reverse evaluation, strict
clock errors, explicit material fallback, topology-change rejection and no
partial publication on conversion failure.

Run the external-tool tests with `BLENDER_EXE` set:

```sh
TEXLOOM_REQUIRE_BLENDER=1 python -m unittest tests.blender_producer_test -v
```

Both full acceptance gates set `TEXLOOM_REQUIRE_BLENDER=1`; missing Blender is
then an error. A developer without Blender can run the remaining tests, with
this external-tool class reporting an explicit skip.

## Source and limits

The upstream execution target is Blender 4.5.9, source revision
`8bf95cbd38d1456c94e9d751f3804eea4d5b137b`. The public APIs are
[dependency-graph instances](https://docs.blender.org/api/4.5/bpy.types.Depsgraph.html),
[object evaluation and temporary meshes](https://docs.blender.org/api/4.5/bpy.types.Object.html),
and [scene units](https://docs.blender.org/api/4.5/bpy.types.UnitSettings.html).
The pinned [temporary-mesh API implementation](https://github.com/blender/blender/blob/8bf95cbd38d1456c94e9d751f3804eea4d5b137b/source/blender/makesrna/intern/rna_object_api.cc)
establishes ownership: every temporary `to_mesh()` result is paired with
`to_mesh_clear()` in a `finally` block. No upstream implementation is copied or
translated into the Texloom runtime.

This profile does not preserve editable modifier/node graphs, arbitrary shader
networks, textures, lights, physics caches, topology-changing interpolation or
Blender UI behavior. Imported geometry can be placed and combined with native
TeX, but the original procedural model is edited in Blender and exported again.
