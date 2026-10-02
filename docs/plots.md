# Function, parametric and sampled plots (PR18)

`texloom-plots` turns dimensionless mathematical expressions or data samples
into ordinary editable path geometry. The PR17 Cartesian mapping is reused,
including logarithmic axes. Plot expressions use the existing typed expression
compiler; there is no JavaScript evaluation, second expression language, or
renderer-specific graph implementation.

```sh
python tools/build.py examples/function-plots.tex --out build/function-plots --video
```

The example animates a sine wave and its filled region. Existing curve-sampling
operations read that generated path to place a moving point and local tangent.
The other panels show a parametric loop and two disconnected branches of `1/x`.
The player exposes amplitude and frequency. All consumers see the same evaluated
geometry at a given time and parameter set.

## Authoring

Load `texloom-plots` beside `texloom-axes`. Create a path target and declare an
axis mapping with `\loomaxes` before referring to its ID. The literal JSON body
of `\loomplot` is captured without TeX macro expansion. Every plot owns its
target's geometry; a second writer on that geometry is an error.

```tex
\loomgeometry[draw=cyan,line width=2bp] (curve) {(0,0)--(1,0)};
\loomplot{curve}|{"axes":"coords","mode":"function","expression":"sin(x)","domains":[[-3,3]],"tolerance":0.25}|
```

The `axes` ID selects the same mapping inputs used by the axes operation.
Changing an axis range, width or typed parameter therefore changes the plot.
The mapping inputs are copied as portable references, not evaluated during
TeX compilation. Output references remain graph dependencies, and property
references participate in the shared ordering and cycle checks.

### Four modes

| Mode | Authored data | Meaning |
| --- | --- | --- |
| `function` | `expression`, `domains` | `(x, expression(x))` |
| `parametric` | `xExpression`, `yExpression`, `domains` | `(x(u), y(u))` |
| `samples` | `samples` | Piecewise linear, ordered data with explicit null gaps |
| `area` | `lower`, `upper`, `domains` | Closed bands between two explicit function boundaries |

```tex
\loomplot{loop}|{"axes":"coords","mode":"parametric","xExpression":"2*cos(u)","yExpression":"sin(u)","domains":[[0,6.283185307179586]]}|
\loomplot{data}|{"axes":"coords","mode":"samples","samples":[[0,0],[1,1],null,[2,1],[3,0]]}|
\loomplot{band}|{"axes":"coords","mode":"area","lower":"0","upper":"sin(x)","domains":[[-3,3]]}|
```

`parameter` is the dimensionless sample variable. `x` is its convenient alias
for function/area plots; `u` is its alias for parametric plots. These local
names cannot also be scene parameters in the modes that introduce them; samples
mode has no expression locals. Expressions can read scene `time` and
declared parameters. The expression result must be a dimensionless scalar;
bp values cannot silently become data coordinates. The mapping applies units
and flips y-up data into the scene's y-down coordinates exactly once.

The expression language remains the supported PR04 language: arithmetic,
powers, comparisons, boolean operators, conditionals, sine/cosine, vectors and
the existing functions. This PR does not add symbolic math or promise arbitrary
LaTeX expressions can be executed. Raw TeX is still available for labels.

## Domains, breaks and masks

`domains` is a finite, sorted list of increasing parameter intervals. Each
interval has its own contour; gaps between intervals are never joined. Use
multiple domains to describe known excluded regions explicitly:

```tex
\loomplot{branches}|{"axes":"coords","mode":"function","expression":"1/x","domains":[[-3,-0.1],[0.1,3]]}|
```

`breaks` splits intervals at known parameter values. A break is a topological
separator, not an instruction to draw an infinite branch or to clip it to the
viewport. Near an unbounded pole, provide a finite exclusion interval or an
explicit boolean `mask`, such as `"x < -0.1 || x > 0.1"`.

The optional mask is evaluated before the function. A false result omits that
sample. Sample-time numeric domain errors, nonfinite expression results and
invalid logarithmic data can also create missing samples. Unsupported syntax,
wrong units, invalid parameters and malformed declarations remain errors;
they are never silently converted into gaps.

The sampler subdivides mixed valid/invalid cells. At its depth limit, an
unresolved cell touching missing data becomes a reported gap. It never draws
a line across that cell. `samples` mode preserves authored order and every
`null` separator; it does not sort, interpolate across a hole, or fit a spline.

For `area`, both boundaries are sampled on the same parameter partition.
If either is invalid, the corresponding strip is omitted from both sides.
Each surviving strip becomes a closed contour. No numeric integral, automatic
boundary ordering, or intersection decomposition is computed. Crossing
boundaries follow the consumer's ordinary path fill rule.

## Quality and finite work

Quality is measured **after data-to-chart mapping**, so axis range and size
changes can require different sample densities. The declared chart may be the
scene or a transformed local coordinate system.

| Input | Default | Meaning |
| --- | --- | --- |
| `tolerance` | 0.5 | Allowed observed probe deviation in declared output pixels |
| `pixelsPerBp` | 1 | Explicit quality density; effective chart-bp tolerance is their ratio |
| `initialSegments` | 16 | Initial intervals per authored domain |
| `maxDepth` | 16 | Maximum recursive refinement depth |
| `maxSamples` | 16384 | Total sampled parameter positions (or authored entries in samples mode) |
| `maxSegments` | 8192 | Maximum generated line segments |

An area evaluates both boundaries at each sampled parameter position.
These quality inputs can be typed scalar expressions. `pixelsPerBp` describes
the intended output density in the plot's geometric chart. It is explicit;
neither browser device pixel ratio, camera zoom nor an ancestor scale silently
changes it. Set it appropriately when exporting at a different scale. All
quality scalars use unit `1`; axis dimensions retain bp units.

For example, a chart enlarged uniformly by 10 requires `pixelsPerBp: 10`
for a one-pixel-per-scene-bp output. With nonuniform scale, use a conservative
maximum stretch. `samples` mode accepts only `maxSamples` and `maxSegments`;
it preserves the supplied polyline rather than refining an expression.

Portable programs allow up to 256 plots, 128 domains, 1024 breaks and 65536
authored sample entries per plot. Refinement limits are `initialSegments`
1..4096, `maxDepth` 0..24, `maxSamples` 1..262144 and `maxSegments` 1..131072.
Each break must lie in an authored domain. These caps bound individual plots;
they are not a total scene execution-time guarantee.

Several interior probes guide refinement, including nonuniform locations.
This reduces ordinary midpoint aliasing, but **finite sampling does not certify
a global error bound or detect every discontinuity**. A narrow spike or a
masked island between every probe can be missed. Increase `initialSegments`,
use known domains/breaks, and choose a sensible tolerance for the content.

Reports distinguish observed errors, accepted-segment errors, sample/segment
counts and masked intervals. A continuous finite cell that still exceeds the
quality requirement at `maxDepth` fails with a resolution diagnostic. Exceeding
a work budget fails before publishing a partial plot. The runtime does not
quietly substitute a coarse line and call it accurate.

## Runtime and interoperability

The portable `plots` program stores declarations, typed inputs, source spans
and expressions. Preparation compiles expressions once. At each sample time,
the shared execution plan resolves inputs, maps data, samples curves, converts
the resulting geometry into the target's local chart and updates the path.
Target and ancestor transforms are explicit dependencies. Downstream path
sampling, decorations, connectors, SVG, Canvas and Chalkspace consume this
ordinary path.

Plot paths are adaptive polylines. Their generic path parameter is the output
segment/length parameter, not the original mathematical x or u. Their local
tangent is segmentwise and can change at a vertex. No symbolic derivative is
inferred. Expression domains and quality reports preserve the separate
mathematical interpretation.

Every sample is deterministic and detached from previous frames. Seeking in
reverse order and changing parameters do not mutate the source bundle or cache
an earlier topology. Diagnostics include the authored plot/expression source
where available. `plot-sources/` stores the literal declarations and expressions.

## Scope and references

Implicit curves, contour extraction, symbolic integration/differentiation,
automatic asymptote proofs, spline fitting and 3D surfaces remain separate
features. Plot rectangles do not automatically clip arbitrary output paths.
Use explicit domains/masks when only part of a function should appear.

Conceptual references: [Manim Axes](https://docs.manim.community/en/stable/reference/manim.mobject.graphing.coordinate_systems.Axes.html)
and [Manim ParametricFunction](https://docs.manim.community/en/stable/reference/manim.mobject.graphing.functions.ParametricFunction.html).
The implementation is original and uses Texloom's existing coordinate,
expression and execution contracts.
