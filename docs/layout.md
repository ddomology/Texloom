# Measured content layouts (PR16)

`texloom-layout` arranges real TeX measurements through the operation graph.
Load it beside `texloom-tikz` when using `\loomnode`. Ordinary text/math resources
work with `\TLText` / `\TLMath` and `tex` nodes. No renderer-specific layout or
browser font measurement participates in the result. The first layout/fit
declaration opts the compilation into PGF content measurement; merely loading
the package leaves existing scene capture unchanged.

```tex
\usepackage{texloom-tikz}
\usepackage{texloom-layout}
% Inside the document/scene, after creating the named nodes:
\loomlayout[mode=matrix,columns=2,gap-x=24,gap-y=18,align-y=baseline]
  {proof-grid}{{"nodes":["hypothesis","conclusion",null,"example"],"origin":[40,60]}}
\loomfit[padding-x=12,padding-y=10]{frame}{{"layout":"proof-grid"}}
```

The literal JSON body is captured without TeX expansion. The layout ID is also
the operation ID; fit references a preceding declaration. `frame` must already
be an editable path. Null cells retain their row-major index and reserve a
matrix cell. Every layout needs at least one measured target; at most 4096 cells
are accepted. Duplicate targets are an error. All targets must have the same
immediate parent, including the common scene parent.

## Measurement and placement

* TeX resources use logical width, height and depth, multiplied by the node's
  positive scalar `scale`. Their intrinsic bounds start at `(0,-height*scale)`
  and their baseline is zero. Phantoms, explicit widths, and descenders therefore
  affect spacing even if the visible ink is smaller or larger.
* Measured `\loomnode` groups use `anchorMetrics.logicalTextBox` and the measured
  `base` anchor. Native PGF inner/outer separations do not enlarge this content
  box. Multiline content keeps the actual TeX box and baseline measurement.
* Group metadata is authoritative: independently animating a child drawing
  does not remeasure its parent. Recompile changed TeX content to update its
  logical measurement. TeX scalar `scale` is evaluated at each frame.
* Layout owns each target's complete transform. For TeX nodes it also writes
  `x=y=0`. Authored placement/rotation/scale in `transform` is replaced. A changing
  ancestor transform is still respected; a second dynamic writer on a target's
  pose is rejected by the normal graph planner.
* Measurement does not read the target pose, so placing the boxes does not
  create a dependency cycle. Expressions which read that pose to compute the
  layout do create a real cycle and receive a diagnostic.

The shared layout chart is `parent(firstNonNullTarget)`. Each placement maps it
explicitly to its own `parent(target)` chart, preserving typed chart identities.
Fit uses the same measured inputs and layout positions; it never measures the
already-placed targets. Its rectangle is converted into the target path's local
chart before the geometry binding.

## Authoring modes

Distances use bp. Scalar JSON sockets accept finite numbers, typed expressions
such as `"20bp + time/1s*4bp"`, numeric property references
`{"node":"A","property":"scale"}`, or `{"operation":"id","socket":"width"}`.
TeX options accept literal numbers or the symbolic values below. Specifying a
socket in both options and JSON is an error. Unlisted options are rejected.

| Mode | Sockets and defaults | Semantics |
| --- | --- | --- |
| `matrix` (default) | `columns=1`, `gapX=gapY=20`, `alignX=center`, `alignY=baseline`, `origin=[0,0]`, `maxWidth=maxHeight=0`, `overflow=allow` | Column widths and row extents come from the largest measured contents. Rows advance downward. The default baseline alignment makes each row's baselines coincide. |
| `row` / `column` | `gap=20`, `crossGap=20`, `align=center`, `origin=[0,0]`, `maxWidth=maxHeight=0`, `overflow=allow` | Main-axis distribution with cross-axis alignment. Wrapping starts a new row/column at the configured main-axis bound. |
| `align` | required `positions`, `axis=x`, `align=center`, `at=0` | Changes one axis and preserves each input position's orthogonal coordinate. |
| fit | required `layout`, `paddingX=paddingY=0` | Padded union of non-null content bounds at that layout's positions. |

Option spellings are kebab case: `gap-x`, `gap-y`, `align-x`, `align-y`,
`cross-gap`, `max-width`, `max-height`, `padding-x`, `padding-y`. JSON uses the
camelCase sockets shown above. `origin` is JSON-only and accepts `[x,y]`, a point
output, a point expression `{"expression":"vec2(40bp,60bp)"}`, or the other
existing point/anchor inputs. `align` requires a point list with the same number
of entries as `nodes`, including placeholders, or a `points2d` output reference.

Numeric enum values in JSON:

| Socket | Values |
| --- | --- |
| `alignX` | `0=start`, `1=center`, `2=end` |
| `alignY` | `0=baseline`, `1=start`, `2=center`, `3=end` |
| `align` | `0=start`, `1=center`, `2=end`, `3=baseline` (vertical alignment only) |
| `axis` | `0=x`, `1=y`; fixed by `mode=row` / `mode=column` |
| `overflow` | `0=allow`, `1=error`, `2=wrap` (distribution only) |

Zero max width/height means unbounded. Finite positive limits, nonnegative gaps
and padding, and integer column counts are validated by the pure layout core.
Matrix overflow can allow or report overflow; it does not silently change the
requested number of columns. Wrap requires a bound on the main axis and rejects
an individually oversized cell. `align` with `axis=x,align=baseline` and column
distribution with `align=baseline` are invalid. Row distribution may align its
vertical baselines. No collision search, text reflow, automatic line breaking, row/column
spans, or general constraints are implied by this profile.

## Graph and outputs

`matrixBoxLayout@1`, `distributeBoxLayout@1`, and `alignBoxLayout@1` consume
`boxes2d` and produce `positions`, `origin`, `width`, `height`, `rows`, `columns`,
and a bounding rectangle `path`. Align returns zero rows/columns because it does
not define a grid. `fitBoxBounds@1` produces `path`, `origin`, `width`, and
`height`. The source archive is `layout-sources/`; JSON declarations and every
embedded expression retain source spans. The ordinary graph validation supplies
unit, chart, missing-reference, cycle, and writer-conflict errors.

All results are deterministic and detached. SVG, Canvas, video, and Chalkspace
consume the same positioned scene nodes and ordinary path geometry.

## Reference scope

The semantic references are PGF's [matrix placement](https://tikz.dev/tikz-matrices)
and [fit library](https://tikz.dev/library-fit). Regression tests execute native
PGF to compare row baselines and column edge gaps, and independently verify
logical extents and padding. Texloom implements this documented content-box
subset; it does not emulate the complete PGF key system, arbitrary matrix-cell
code, or all fit-node behavior.
