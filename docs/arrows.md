# PR 14 — Editable arrow tips and shaft shortening

An editable path can carry filled triangle or stealth tips. The evaluator derives
a shortened shaft and separate tip polygons from its current local geometry.
Web, SVG and Canvas/video use those same objects. The authored path remains
available to labels, sampling, intersections and later geometry operations.

## TeX authoring

```tex
\usepackage{texloom-arrows}

% Declare an editable path called edge first, then configure its tips.
\loomarrows[start=none,end=stealth,length=12,width=8,inset=3,
            shorten-end=2,collision=error]{edge}{{}}
```

The last argument is literal JSON, even when empty. Place the command directly
in the scene; its verbatim argument cannot be nested inside another macro's
argument. Loading the package without declarations changes no bundle behavior.

| Option | Default | Meaning |
| --- | --- | --- |
| `start` | `none` | `none`, `triangle`, or `stealth` |
| `end` | `triangle` | `none`, `triangle`, or `stealth` |
| `length` | `9` | Positive tip length, local bp |
| `width` | `7.56` | Positive full tip width, local bp |
| `inset` | `2.52` | Stealth notch distance forward from the rear corners, local bp |
| `shorten-start` | `0` | Nonnegative arc distance from the original start to its visual tip |
| `shorten-end` | `0` | Nonnegative arc distance from the original end to its visual tip |
| `collision` | `error` | Reject an overfull path, or `clamp` the geometric sizes together |
| `tolerance` | `.05` | Positive length/inversion tolerance, local bp |
| `id` | `arrows:<target>` | Unique graph operation ID |

Inset is always nonnegative; when a stealth tip is active, require `inset < length`. Numeric options
accept ordinary TeX-style decimals such as `.5`; they do not parse dimensions
or expressions. The JSON body accepts the sockets `start`, `end`, `length`,
`width`, `inset`, `shortenStart`, `shortenEnd`, and `tolerance`. Tip enums in JSON
are dimensionless numbers: `0 = none`, `1 = triangle`, `2 = stealth`.

```tex
\loomarrows[end=stealth,inset=3,collision=clamp]{edge}{
  {"length":"12bp + 2bp*sin(time/1s*1rad)",
   "width":{"node":"size-control","property":"r"},
   "shortenEnd":2}
}
```

Each numeric JSON input can be a number, a typed scalar expression string,
`{node,property}`, or `{operation,socket}`. Lengths use bp; tip enums use unit
`1`. Expressions and upstream properties are evaluated at the requested absolute
time. An option and JSON socket cannot specify the same value. `collision` is
static and belongs in the optional TeX argument.

The frontend writes one `arrowStyle@1` operation with no spaces. It binds all
eight scalar outputs to `arrows.<property>`. The node stores explicit defaults
plus its collision policy. Original JSON and decoded expression bodies are
archived under deterministic `arrow-sources/` paths with exact source spans.

## Geometry and painting

The initial profile requires exactly one open contour with positive finite
length. Closed paths, disconnected paths and degenerate paths receive diagnostics.
No final contour or usable direction is silently chosen.

The visual tip is sampled after explicit endpoint shortening. Its axis follows
the local tangent there, reversed at the start. A triangle has its rear corners
one `length` behind its tip at half the requested width. A stealth polygon adds
a central notch `inset` forward from those corners. The shaft ends at the rear
of a triangle and at the notch of a stealth tip.

On a curve, each tip is a rigid polygon aligned to that tangent. Shaft trimming
uses arc length and retains cubic subcurves. The tip does not bend along the
curve, and a sharply curved shaft need not meet a rigid tip exactly as a straight
shaft would. This profile does not implement TikZ flex/bend tip modes.

Tips are filled using the inherited stroke paint and have no outline. Their
dimensions do not grow automatically with stroke width. The derived shaft keeps
the stroke styling and uses butt caps. Existing affine node and parent transforms
apply to shaft and tips together, including reflections and nonuniform scales.
The dimensions are local bp, not constant screen pixels.

For a short path, `collision=error` raises `ARROW_COLLISION`. The `clamp` policy
uniformly reduces tip length, width, inset and both requested shortening distances
to leave a positive shaft. Reservation conservatively includes full lengths of
both active tips; the report exposes the applied scale. The numerical tolerance
is not a geometric size and is not reduced by this policy.

Reveal uses the derived shaft: zero reveal hides both tips, partial reveal keeps
the start tip and hides the end tip, and full reveal displays both configured
tips. It does not progressively draw through a filled polygon.

## Runtime and graph APIs

`createArrowGeometry(path, options)` returns detached, frozen data:

```ts
{
  shaft, startTip, endTip,
  report: {
    totalLength, scale, shortenStart, shortenEnd,
    shaftTrimStart, shaftTrimEnd,
    start: {endpoint, visualTip, shaftEndpoint, tangent},
    end:   {endpoint, visualTip, shaftEndpoint, tangent}
  }
}
```

Each geometry is a `PathGeometry`; an absent tip has no contours. Frame nodes
expose the result as `resolvedArrows`. This is generated data and cannot be
authored in a bundle. The original `geometry` stays intact; `d` keeps its usual
logical-path/reveal serialization and is not replaced with the shortened shaft.
Renderers consume `resolvedArrows` when present.

An explicit profile, or a scalar writer to `arrows.*`, initializes frame-local
defaults before tracks and graph execution. Property readers can therefore read
an omitted default such as `arrows.length = 9`; validation of the complete style
runs after current writers. The authored bundle is never filled in or mutated.

For graph composition, `arrowPath@1` takes a `path` in its declared `space`, the
same eight style scalars, and dimensionless `collision` (`0 = error`, `1 = clamp`).
It outputs `shaft`, `startTip`, `endTip` in that space, plus `scale` and
`totalLength`. This is useful when a downstream operation should consume a
derived shaft explicitly. Ordinary labels still read the original path.

Invalid styles, unavailable tangents, collisions and geometry restrictions
produce typed diagnostics. A missing tip is distinct from an evaluation error.
Every sample starts from authored data; there is no previous-frame tip cache.

## Compatibility and reference

The new opt-in profile cannot be mixed with legacy `arrowStart`, `arrowEnd`, or
`arrowSize` keys, including flags set to false. Repeated declarations on the same
target are rejected. Existing legacy connection scenes retain their historical
triangle arithmetic and rendering. Richer tip kinds, multiple tips per endpoint,
outlined tips, screen-size compensation and general `arrows.meta` syntax are
outside this profile.

Boolean arrow flags on a new editable path lower to this profile's default
triangle with `length = arrowSize` and `width = .84 * arrowSize`. Existing
`connect` relations keep their original unshortened shaft and triangle rendering.

The [PGF/TikZ arrow manual](https://tikz.dev/tikz-arrows) supplies the semantic
reference for endpoint orientation and explicit tip dimensions. Tests execute
native PGF Triangle and Stealth tips with specified length/width and zero outline,
then compare emitted geometry with this profile. The implementation is original;
no upstream source was copied. These checks establish a documented subset rather
than full `arrows.meta` compatibility.

```sh
python -m unittest tests.arrow_compiler_test -v
python tools/verify-port.py
```
