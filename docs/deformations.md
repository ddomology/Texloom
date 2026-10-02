# PR 06 — Deform editable curves

A deformation maps typed positions and writes actual path geometry. Both SVG
and Canvas render that evaluated geometry, and points, tangents and normals can
depend on the result through the common execution plan.

## Build the comparison

```sh
python tools/build.py examples/curve-deformations.tex --out build/curve-deformations --video
```

Open `build/curve-deformations/player.html`. The two rows start from the same
straight cubic and apply the same sinusoidal displacement. The upper row moves
the four controls. The lower row maps the entire curve, producing the full
wave. A moving point and its tangent and normal follow the lower result. The
amplitude and phase controls update the scene without recompiling TeX.

## Two distinct operations

| Mode | What is mapped | Output |
| --- | --- | --- |
| `controlDeform` | Every contour start, endpoint and cubic control | Original line/cubic topology with new coordinates |
| `pointwiseDeform` | The actual point on the source curve | Exact line/cubic geometry for recognized affine maps; otherwise an adaptive polyline |

Moving Bézier controls through a nonlinear function generally differs from
mapping every point of the Bézier curve through that function. `controlDeform`
implements the first meaning. Its reported zero approximation error refers to
the control mapping; it does not claim equivalence to the pointwise curve.

An affine pointwise map commutes with Bézier interpolation. The runtime recognizes
supported affine expressions algebraically and retains exact curve topology in
real arithmetic. It does not infer linearity by trying a few sample points.

## TeX declaration

```tex
\usepackage{texloom-tikz}
\usepackage{texloom-geometry}

% source and target are existing editable path IDs, captured by \loomgeometry.
\loomparameter[unit=bp,min=0,max=45]{amplitude}{35}
\loomdeform[mode=pointwiseDeform,tolerance=0.35,max-depth=16,max-segments=32768]
  {wave}{source}{target}{
    position + vec2(0bp,-amplitude*sin(2*pi*1rad*parameter - 1rad*time/1s))
  }
```

Arguments are operation ID, source path ID, target path ID and literal expression.
The expression must produce a `vec2` in `bp`. The default mode is
`pointwiseDeform`; omitted numeric budgets use the runtime defaults below.
Unknown options and invalid numeric values are errors.

| Option | Default | Allowed |
| --- | --- | --- |
| `tolerance` | `0.25` | Positive finite local length in bp |
| `max-depth` | `16` | Integer from 1 through 24 |
| `max-segments` | `32768` | Integer from 1 through 131072 |

TeX captures the final argument with the same multiline verbatim scanner as
[expressions](expressions.md). Write `^`, `&&`, `%`, quotes and backslashes
literally. TeX macros inside the expression are not expanded and unsupported
tokens receive expression diagnostics. Use the command directly in source,
outside another macro's already-scanned argument. This is an explicit expression
language, not a parser for arbitrary TeX mathematics.

## Expression context and coordinates

| Name | Type | Meaning |
| --- | --- | --- |
| `position` | `vec2`, bp | Source-local coordinate being mapped |
| `parameter` | Dimensionless scalar | Whole-source-path parameter for pointwise mode; control ordinal fraction for control mode |
| `index`, `count` | Dimensionless scalar | Zero-based control index and total control count; control mode only |
| `time` | Scalar, seconds | Clamped scene sample time |
| Declared parameters | Their declared types/units | Defaults or overrides from the normal parameter API |

Pointwise `parameter` distributes `[0,1]` over drawable source segments and then
uses each segment's polynomial parameter. It is not arc-length fraction.
Control-mode `parameter` is `index/(count-1)`, or zero for a single control.
Trigonometric inputs use radians; for example `1rad*time/1s` is unit-correct.

**Source and target local coordinates must correspond.** The output numbers are
written directly into the target's local geometry. No source-to-world-to-target
conversion is inserted. In the comparison example, both targets use the same
local coordinates while separate parent translations place their rows on screen.
A target's existing parent, transform and style continue to apply to its geometry.

Each deformation reads the source geometry for the current frame. The authored
bundle remains immutable. `source == target` is supported: input is read once,
then replaced in the fresh frame. It is not a repeated feedback iteration.
Such an in-place path must have no other geometry writer. To animate an upstream
source's controls and then deform them, use a separate target.

## Approximation and diagnostics

Nonlinear pointwise output uses adaptive source subdivision and an interval
enclosure of the mapped curve. A chord is accepted only when its reported
curve-image-to-chord bound meets the requested tolerance. This covers the
supported interval expression subset; it is not a sparse sample-fit heuristic.
Subdivision depth, source/output segment counts and subdivision work are bounded.
Exhausting a budget or failing to certify the requested tolerance produces a
diagnostic, without silently accepting lower quality.

Bounds are **per deformation stage, in corresponding source/target local bp**.
They are neither screen-pixel errors after scaling nor accumulated error bounds
for a chain of deformations. They constrain geometry, not derivatives. Arithmetic
uses Float64, outward rounding and explicit guards around host math functions;
the certificate is not a formally verified proof of the host math library.

Spatial arithmetic, integer powers, vector operations and sine/cosine are
supported by the interval evaluator. Spatial comparisons and spatial branch
conditions are currently unsupported for nonlinear pointwise certification.
Parameter/time-dependent branch choices are allowed when independent of position
and path parameter. Potential singularities trigger further subdivision where
possible, then a diagnostic if their interval cannot be resolved within budget.
See [the expression reference](expressions.md) for the shared type and unit rules.

`frame.deformations[operationId]` contains:

- `method`: `control`, `affine-exact` or `adaptive-polyline`.
- `sourceSegments`, `outputSegments`, `subdivisions` and `maxDepthReached`.
- `tolerance`, `maxErrorBound`, `boundPolicy`, `precision` and `tangentPolicy`.
- Per-output-segment provenance: source contour/segment ID, local source interval,
  whole-path parameter interval, closing-edge flag and error bound.

`segments.length` equals `outputSegments`. Counts include authored segments
(including degenerate ones) and nonzero implicit closing edges. A control map
can separate coincident seam endpoints and create a closing edge; its provenance
has `synthetic: "closing-edge"`, `sourceSegmentId: null`, `sourceInterval: [1,1]`
and a zero-width parameter interval at the original seam. Conversely, an
implicit closing edge that collapses has no output-segment record, while it
remains included in `sourceSegments`.

Closed contours preserve closure. A pointwise expression that maps the two sides
of a closed seam to different points is rejected, apart from checked floating
point roundoff. Nonfinite positions and incompatible units are also explicit
errors with source spans.

## Downstream consumers and execution

Deformations participate in the same compiled property dependency plan as tracks,
expressions, typed operations and legacy relations. Geometry writers are exclusive;
conflicts and dependency cycles are diagnosed. The target's editable geometry
and SVG path data are replaced together, and obsolete connector geometry is
invalidated. Existing `evaluate`, `createEvaluator` and `prepareScene` entry
points remain the sampling APIs.

Point-on-path, reveal and direction consumers see the output geometry. For an
adaptive polyline, ordinary downstream parameter/length modes describe that
polyline. The original source parameter is not implicitly preserved; use the
reported source intervals for explicit correspondence. Tangents are segmentwise,
with the existing right-hand policy at joins, and normals follow those tangents.
Reducing geometric tolerance does not establish an analytic derivative bound.

[PR 05 field domains](fields.md) retain their stable-topology contract. Control
deformation can feed them when source and target topology match. Adaptive output
may change subdivision topology between samples and cannot implicitly reuse an
original control/sample domain. Explicit cross-topology mapping is future work.

Every absolute-time sample starts with fresh frame state. Reverse seeking and
repeated sampling use the same computation; there is no temporal deformation
cache. Existing parameter controls and exact-time capture work unchanged.

## Bundle and source provenance

```json
{
  "version": "0.3",
  "deformations": {
    "version": 1,
    "operations": [{
      "id": "shift", "source": "curve", "target": "shifted",
      "mode": "pointwiseDeform",
      "expression": "position + vec2(0bp,20bp)",
      "tolerance": 0.25, "maxDepth": 16, "maxSegments": 32768
    }]
  }
}
```

The snippet shows the deformation member; a complete bundle also contains the
usual scene, resource and node members. Loading the TeX package alone does not
upgrade or add program members to an existing scene.

TeX writes a JSON record containing only a generated sidecar filename. Python
reads the literal body, serializes JSON safely, and archives the exact body at
`deformation-sources/scene.tl-deformation-N.body.txt` relative to the output.
Source spans identify this deterministic captured text, with one-based Unicode
codepoint positions and an exclusive end. They do not pretend to be original TeX
source columns. Per-run capture files remain in compiler provenance. Identical
compiles produce identical canonical program/source-span data.

## Current scope

This stage edits 2D line/cubic paths. It does not add a general mesh system,
surface deformation, numerical PDE solver, plugin loader or implicit resampling
of field attributes across changing topology. Renderer-specific deformation
logic is unnecessary: consumers already receive the same evaluated path objects.
