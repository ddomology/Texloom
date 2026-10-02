# Mathematical coordinates and axes (PR17)

`texloom-axes` separates dimensionless mathematical data from the scene's bp
coordinates. One pure Cartesian mapping produces ordinary paths, points and
TeX placement transforms. SVG, Canvas, Chalkspace and video receive the same
evaluated scene; none of them computes a second coordinate system.

## Build the example

```sh
python tools/build.py examples/cartesian-axes.tex --out build/cartesian-axes --video
```

The linear panel changes its width and range while `P=(2,1)` and its label stay
at their declared data coordinates. The other panel uses logarithmic axes:
`Q=(10,100)` has the same position at every sample. The player exposes range and
tick-step parameters. A fractional step can intentionally have fewer numeric
labels than ticks: numeric labels come from the explicit catalog below.

## Authoring

Load `texloom-axes` alongside `texloom-tikz` and `texloom-geometry`. Declare
editable path nodes before referring to them as outputs. The body after each
command is literal JSON, captured without macro expansion.

```tex
\loomgeometry[draw=gray] (grid) {(0,0)--(1,0)};
\loomgeometry[draw=white] (x-axis) {(0,0)--(1,0)};
\loomgeometry[draw=white] (y-axis) {(0,0)--(1,0)};
\loomgeometry[draw=white] (ticks) {(0,0)--(1,0)};
\loomaxes{plot}|{"origin":[60,80],"width":400,"height":240,"xMin":-4,"xMax":4,"yMin":-3,"yMax":3,"xStep":1,"yStep":1,"xAxis":"x-axis","yAxis":"y-axis","ticks":"ticks","grid":"grid"}|
\TLNode{P}{point}{"x":0,"y":0,"r":4}
\loomdatapoint{P}|{"axes":"plot","x":2,"y":1}|
\TLMath{p-art}{P=(2,1)}
\TLNode{p-label}{tex}{"resourceId":"p-art","x":0,"y":0}
\loomaxislabel{p-label}|{"axes":"plot","axis":"point","x":2,"y":1,"anchor":"base west","offset":[8,-8]}|
\loomaxisticks{plot}|{"axis":"x","values":[-4,-3,-2,-1,0,1,2,3,4],"precision":0,"anchor":"base","offset":[0,18]}|
```

Scalar sockets accept finite numeric literals, typed expressions or typed
operation output references. Bare numbers acquire the socket's declared unit;
an expression must have that unit itself. Thus `width` can be
`"400bp+20bp*sin(pi*time/6s)"`, while a range endpoint can be
`"4+sin(pi*time/6s)"`. Data coordinates never acquire a bp unit implicitly in
the operation graph.

## Mapping contract

`origin` is the top-left corner of a rectangular viewport, in its declared
geometric chart. Width and height are positive bp distances. Data ranges are
finite and strictly increasing. For a linear axis:

```
sceneX = originX + width  * (dataX - xMin) / (xMax - xMin)
sceneY = originY + height * (yMax - dataY) / (yMax - yMin)
```

The y direction is inverted here once. `sceneToData` performs the inverse.
Mapping can extrapolate beyond the rectangle; it does not clip geometry.
Label visibility is a separate, explicit policy.

Set `xScale` or `yScale` to `"log"` to opt into a log profile. Endpoints and
mapped values on that axis must be strictly positive; `logBase` must exceed
one (default 10). Equal ratios then occupy equal distances. Log tick steps
are steps in the exponent, so step 1 at base 10 produces powers of ten.
Nonpositive values are errors, even if a label would otherwise be hidden.

The horizontal axis crosses data y=0 when a linear range contains zero; if
zero is outside the range, it uses the nearest boundary. The vertical axis
uses the analogous x rule. A log axis uses its minimum-domain boundary.
These are explicit placement rules, not an artificial logarithm of zero.

## Tick values and presentation

Ticks lie on a zero-origin lattice in linear data or in log exponents. The
implementation computes lattice indices instead of repeatedly adding a step,
normalizes negative zero, and bounds work before generating geometry. The
default tick budget is 512 across both axes; the hard limit is 4096.
`tickSize` is the full mark length in bp, independent of the data scale.
Grid lines are derived from the same tick values and span the plot rectangle.

`formatTick` formats a value without changing it. Decimal and scientific
notation support 0–12 fractional digits; redundant zeroes are removed.
`formatTickLabels` rejects distinct values that would display identically at
the selected precision. Increasing the precision fixes that ambiguity; the
formatter does not move the tick to its rounded display value.

`\loomaxisticks` declares a **bounded catalog of labels** (1–256 distinct values
per declaration). Its values are sent
through the shared formatter, then typeset by real TeX and imported as vector
resources. `scale`, `style`, `anchor` and `offset` control their appearance.
At each time, labels outside the range or off the current tick lattice are
hidden. Only supplied values have labels: arbitrary new ticks do not trigger
runtime TeX compilation or silently substitute browser text. Include all
desired candidate values for animated ranges/steps, or choose a selective
catalog intentionally. Changed label content requires recompilation.

`\loomaxislabel` places existing measured TeX content, including formulas.
For `axis:"x"` or `axis:"y"`, use `value` for that data coordinate; for
`axis:"point"`, specify `x` and `y`. `respectTicks:false` permits an annotation
between numeric ticks. The base anchors preserve actual TeX baselines and
depth; no browser font measurement is involved.

## Operation and consumer boundary

| Operator | Main result |
| --- | --- |
| `cartesianAxes@1` | x/y axis, tick and grid paths in the declared chart; tick counts |
| `dataToScene@1` | geometric point plus bp x/y scalar outputs |
| `sceneToData@1` | dimensionless x/y data scalars |
| `placeAxisLabel@1` | measured label transform, visibility and reset x/y pose |

Data mapping lives in `geometry/data-space.ts`; typed validation/units live
in `operations/axes.ts`; TeX capture and source archives live in
`tools/axes_capture.py`. Existing geometric charts remain distinct. Explicit
space transforms map output paths to their local chart and labels to their
parent chart, including transformed ancestors. Label placement owns its full
transform and `style.opacity` visibility (zero or one), and resets a raw TeX
node's x/y pose. Measured PGF groups keep their captured local anchors; editing
children does not remeasure those anchors. Competing writers and dependency
cycles are diagnosed by the shared operation planner.

Invalid ranges, steps, log domains, unrepresentable numeric scales, excessive
tick counts, duplicate displayed labels, unknown fields and incompatible units
fail with diagnostics rather than producing NaN geometry. Source-side errors
and operation errors retain declaration provenance.

## Scope and references

This is a Cartesian linear/log profile, with explicit labels and geometry.
It does not include automatic label collision avoidance, polar or complex
charts, clipping of arbitrary plots, a symbolic algebra engine, or function
sampling. PR18 builds function and parametric curves on this mapping contract.
Range reversal requires a future explicit policy rather than a negative size.

Conceptual references: [Manim Axes](https://docs.manim.community/en/stable/reference/manim.mobject.graphing.coordinate_systems.Axes.html),
[PGF coordinate calculations](https://tikz.dev/library-calc), and
[PGFPlots tick options](https://tikz.dev/pgfplots/reference-tickoptions).
These inform contracts; no upstream implementation code is copied.
