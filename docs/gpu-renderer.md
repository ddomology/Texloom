# WebGL2 output (PR30)

The GPU adapter consumes evaluated `frame.space3d` data. It owns browser GPU
objects, while the portable bundle continues to contain JSON resources,
materials, transforms and camera declarations. TeX execution, scene evaluation
and animation timing remain outside the renderer.

## Backend decision and comparison

The first backend is pinned Three.js `0.186.1` with `@types/three` `0.186.0`.
Three's `WebGLRenderer` requires WebGL2 and exposes world clipping, drawing-buffer
preservation and explicit disposal. Its `BufferGeometry` accepts indexed vertex
buffers. These match the narrow mesh adapter boundary.
[WebGLRenderer documentation](https://threejs.org/docs/pages/WebGLRenderer.html),
[BufferGeometry documentation](https://threejs.org/docs/pages/BufferGeometry.html).

Before implementing the adapter, a direct Three render was compared with a
separate raw WebGL2 program: two indexed triangles at different depths, an
independently authored orthographic projection, opaque primary colors and
`LEQUAL` depth. In the tested Chromium at 128×128 without antialiasing, all RGBA
channels matched and the near red triangle occluded the blue triangle. The
initial experiment is recorded under `build/pr30-backend-comparison`; the
tracked reference and browser suite continue to check the adapter independently.
This comparison establishes the tested fixture, not equivalence across all GPUs.

| Option | Fit for this milestone | Work retained by Texloom |
| --- | --- | --- |
| Three.js WebGLRenderer | Selected: indexed geometry, opaque unlit materials, clipping and resource disposal have direct adapter paths | Explicit evaluated matrices, frame scheduling, ownership, limits, diagnostics and tests |
| Minimal raw WebGL2 | Used as the independent triangle/depth reference; a viable narrow backend | A production implementation would also need shader variants, lifecycle recovery, batching and broader state management |
| Babylon.js | An alternative with a broader engine/scene API; its ThinEngine layer also exposes a lower-level graphics boundary | A separate adapter would still need the same Texloom contract and conformance tests |

Babylon's official architecture describes Engine/ThinEngine boundaries, and its
feature inventory includes scene, camera, mesh, animation and audio systems.
The decision above is a scope choice; no Babylon performance comparison was
performed. [Babylon engine architecture](https://github.com/BabylonJS/Documentation/blob/master/content/setup/support/webGPU/webGPUInternals/webGPUOverview.md),
[Babylon feature inventory](https://www.babylonjs.com/specifications/).

Three.js is an npm dependency, not copied source. Distributed browser bundles
must include its complete MIT license notice. There is no CDN or network loader
inside this adapter.

## API

```ts
import {createGpuRenderer} from 'texloom/gpu';

const renderer = createGpuRenderer({canvas, antialias: true});
renderer.render(frame, {
  width: 1280,
  height: 720,
  background: 'transparent', // or an opaque #rrggbb color
});
const counters = renderer.stats();
renderer.dispose();
```

Construction requires a browser `HTMLCanvasElement` and a WebGL2 context. Omitting
`canvas` creates a detached element exposed as `renderer.canvas`. Importing the
module in Node does not access the DOM or allocate a GPU context. `antialias`
defaults to true; conformance references use false to isolate raster edges.

`render` is synchronous and starts from the supplied frame. It neither advances
time nor modifies the frame or resource objects. `state` is `ready`, `lost` or
`disposed`. Sampling belongs to the runtime, so any frame may be rendered after
any other frame. A missing camera or projection produces `GPU_PROJECTION`.
Unavailable WebGL2 produces `GPU_WEBGL2`; there is no automatic Canvas fallback.

The drawing buffer uses alpha, depth, premultiplied alpha and
`preserveDrawingBuffer`. A caller-supplied canvas whose pre-existing context
does not have those properties is rejected. This supports immediate
`drawImage(renderer.canvas, ...)` and capture by the consumer. An explicit
render clears both color and depth. Omitted background is transparent.

## Supported visual contract

- Perspective and orthographic projection matrices come from the shared
  evaluator. Camera world/view and instance world matrices are copied into
  the backend. Three's automatic camera updates are disabled so an authored
  affine camera scale is preserved. The evaluated model-view matrix is also
  installed before uniform upload instead of relying on Three's recomputation.
- Materials are opaque `unlit` with `#rrggbb` colors and `front` or `double`
  side policy. Output is sRGB with no tone mapping. There are no lights,
  transparency sorting, textures, PBR materials or shadows in this profile.
- PR31 adds optional `wireframe: true` to expose triangle edges. Filled rendering
  remains the default. Wireframes draw all triangle edges, including diagonals;
  they do not add a hidden filled surface, lighting, or a custom line width.
  Backend line rasterization is device dependent. Geometry is shared between
  filled and wireframe instances; their materials have separate cache entries.
- Depth testing and depth writes are enabled. Equal-depth ties follow evaluated
  instance order, which is restored independently of previous renders.
- World clipping planes keep points for which `dot(normal, point) + constant`
  is nonnegative. At most eight planes are supported.
- Reflection and front-face handling preserve the authored side convention.
  Geometry is not rewritten or reversed in the shared resource.
  Instance reflection is accounted for by its evaluated world orientation.
  A reflected camera remains an authored affine view: it reverses screen
  winding and may cull a front-only face. The adapter does not silently undo
  camera reflection; `double` explicitly renders both screen sides.
- Resize changes the raster dimensions, not the camera's logical aspect ratio.
  The host fits the logical viewport into its output region.

The GPU adapter paints meshes only. The shared scene Canvas compositor handles
native 2D content and projected TeX overlays after the GPU pass. Overlay
visibility, projection and anchor positions come from the evaluated frame;
the mesh renderer does not infer them.

## Ownership, precision and limits

Mesh resources must be immutable evaluated resources. Geometry is keyed by the
resource object's identity, so two instances can share one upload. A different
resource with the same textual ID replaces the geometry. Cache entries not used
by the current visible frame are disposed. Colors and side policies share
materials while they are in use; instance IDs retain only renderer-owned objects.

Uploads are independently owned compact arrays. The shared JSON resource and
another renderer's storage cannot be modified through them. Float64 positions
are explicitly converted to float32 for WebGL. Overflow, nonzero underflow and
new triangle degeneracy introduced by conversion produce `GPU_PRECISION`.
Transform rank/orientation changes after float32 conversion, and a backend
determinant sign inconsistent with the evaluated sign, are also rejected.
Ordinary float32 rounding remains part of GPU output; this is not a float64
rendering promise. Upload matrices and clipping uniforms also require finite
float32 representation. Conservative interval checks over object bounds reject
overflow/underflow in shader products and partial sums at both matrix stages.
These bounds can reject extreme, highly cancelling transforms even when an
individual vertex would remain representable. Unlit rendering does not upload
unused vertex normals.

The adapter limits each dimension to 4,096 pixels, the output to 16,777,216
pixels, active geometry buffers to 128 MiB, instances to 4,096 and drawn
triangles per frame to one million. Device drawing-buffer limits may be lower
and are checked before resize. Mesh resource limits still apply independently.
Unsupported inputs fail explicitly rather than truncating buffers or geometry.

Wireframe geometry reserves the upper bound of Three's derived edge index buffer
within the same 128 MiB limit. That reservation remains while the geometry is
cached, including after switching it back to a filled material, because Three
retains that buffer until geometry disposal. `bufferBytes` includes this bound.
Generated surface frames use the same immutable-resource ownership path; each
new mesh replaces the prior frame's upload and unused geometry is disposed.

`stats()` returns a frozen snapshot of state, dimensions, active geometry,
material and instance counts, buffer bytes, successful render count, last draw
calls/triangles and context generation. These counters describe this adapter;
they are not process-wide GPU memory measurements.

## Context loss and teardown

On `webglcontextlost`, the renderer enters `lost` and drops its resource caches.
Rendering then throws `GPU_CONTEXT_LOST`. After the browser restores the
context, the adapter returns to `ready` and increments its generation. The next
explicit render reconstructs buffers and materials from the supplied immutable
frame. No old frame is silently replayed and no animation loop is started.

`dispose()` is idempotent, removes listeners, disposes geometry/material/backend
resources and releases the WebGL context. Later renders throw `GPU_DISPOSED`.
It does not dispose the caller's scene runtime or its asset leases.

## Reproducible checks

```sh
npx tsx --test tests/gpu-data.test.ts
python -m unittest tests.gpu_renderer_test -v
```

The actual-browser suite bundles local source with esbuild and runs Chromium
with `--enable-unsafe-swiftshader` for environments using software WebGL2. It
does not use a screenshot mock or alternate Canvas renderer. Its report is
written to `build/gpu-conformance/report.json` with browser version and source
hashes.

The cases cover projection pixel bounds, depth, clipping, reflected front faces,
double-sided geometry, affine camera scale, resource identity replacement,
source immutability, resize, reverse render order, missing capabilities,
float32 limitations, disposal and actual context loss/restoration. The raw GL
reference has no Three or Texloom rendering imports. Fixed-device repeatability
and cross-backend comparison are separate assertions; exact cross-GPU pixels
are not promised.
