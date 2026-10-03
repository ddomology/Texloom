# Declarative updates and absolute-time traces

PR23 adds authored following, direction alignment, look-at and threshold
visibility to the typed operation registry. They compose with existing shape,
intersection, expression and timeline operations. The same evaluated nodes
reach SVG, Canvas, the web player, video and the Chalkspace adapter.

The [runnable example](../examples/declarative-updates.tex) combines a moving
point, its TeX label and orientation, changing geometry, intersection visibility
and a progressively revealed trace.

## TeX authoring

Load `texloom-relations`. Commands have an optional stable `id`; geometric
commands also accept `space=scene`, `local:node`, `parent:node` or `plot:group`.
JSON bodies are literal and archived with source spans.

```tex
\usepackage{texloom-relations}
% The scene already contains point P, a TeX label, and path trail.
\loomfollow[id=label-follow]{label}|{"point":"P","offset":[12,-10]}|
\loomalign[id=tangent-heading]{pointer}|{"direction":{"operation":"curve-sample","socket":"tangent"},"fallbackAngle":0}|
\loomlookat[id=aim]{other-pointer}|{"from":[100,100],"to":"P","fallbackAngle":0}|
\loomvisibility[id=crossing-visible]{crossing}|{"value":{"operation":"select-crossing","socket":"found"},"threshold":0.5}|
\loomtrace{trail}|{"id":"motion","source":{"kind":"node","node":"P","property":"position","space":{"kind":"scene"}},"domain":[0,8],"step":0.125,"tolerance":0.25,"maxDepth":12,"maxSamples":8192,"seed":0,"missing":"break","reveal":"progress"}|
```

Each command is independent; the snippet illustrates references to objects and
operations that must exist in the containing scene. The full example supplies
them. Build it with:

```sh
python tools/build.py examples/declarative-updates.tex --out build/declarative-updates --video
```

| Command | Required body inputs | Convenience defaults | Effect |
| --- | --- | --- | --- |
| `\loomfollow` | `point` | `offset: [0,0]` | Binds target position. |
| `\loomalign` | `direction` | `fallbackAngle: 0` | Aligns the target's positive local x-axis. |
| `\loomlookat` | `from`, `to` | `fallbackAngle: 0` | Aims the same axis from one point toward another. |
| `\loomvisibility` | `value` | `threshold: 0.5` | Sets opacity to one when value is at least threshold, otherwise zero. |
| `\loomtrace` | `source`, `domain`, `step` | `id: trace:<target>`, `seed: 0`, `missing: break`, `reveal: progress` | Samples and displays an absolute-time path. |

Point inputs accept a node ID, a numeric pair, a typed operation output, or an
`{"expression":"vec2(...)"}` object. Vector inputs accept a numeric pair or
typed output. Scalar inputs accept numbers, typed expressions, operation outputs
or `{"node":"P","property":"progress"}`. Unit checking remains active.
The low-level registry requires every fallback and threshold explicitly; the
TeX convenience layer writes its defaults into the portable graph.

### Coordinate and rotation conventions

Offsets are vectors in the declared input chart; they are not screen pixels.
Following converts the result to scene coordinates, then the common binding
layer converts into the target's local coordinates. Animated parent transforms
therefore preserve the requested scene relationship.

Alignment and look-at convert vectors/points into the target's **parent chart**
before computing rotation. This accounts for rotated, reflected and nonuniform
parent scales. Angles are radians, with positive y pointing down. The fallback
angle is explicitly in that parent chart. A zero vector or coincident pair uses
the fallback without borrowing the previous frame's orientation.

The TeX alignment conveniences require a fixed positive own x-scale and reject
writers to the target's own scale or whole transform. Animate a parent to change
its chart. The typed operators remain available for explicitly authored axis
conventions outside this convenience contract. Following and aiming a single
object can form a dependency cycle if its position calculation consumes the
rotation being written; place translation and orientation on separate nodes
when their dependencies require it.

## Registry and dependency contract

All operators are version 1, pure and deterministic:

| Operator | Inputs | Outputs |
| --- | --- | --- |
| `followPoint` | Point and vector offset in the same chart | Point `position` |
| `alignDirection` | Vector and `fallbackAngle` in rad | `angle` in rad; dimensionless `valid` |
| `lookAt` | `from`/`to` points and fallback angle | Angle, unit `direction`, `valid` |
| `thresholdOpacity` | Dimensionless value and threshold | Dimensionless `opacity`, exactly 0 or 1 |
| `transformVector` | Vector and affine transform with matching from/to charts | Vector in the destination chart; translation ignored |

`valid` is zero only for an exactly zero direction. Normalization handles very
small and very large finite inputs without relying on a previous orientation.
Nonfinite values, mismatched units/charts and unsupported output values produce
located diagnostics.

The existing execution graph orders writers before their readers. Source order
does not define update order. Conflicting writers and dependency cycles are
errors, including cycles passing through a node position binding. Immutable
`ExecutionPlan.accesses` exposes property reads/writes for derived-data
preparation. It includes timeline tracks and each prepared execution step.

Parameter-driven regeneration uses ordinary graph composition: a parameter or
time expression changes a shape; sampling that shape moves a point; follow and
alignment consume the resulting point and tangent. No serialized function or
arbitrary Python updater is introduced.

## Trace contract

`Bundle.traces` is `{version:1, operations:[...]}`. A trace observes an existing
point, ellipse centre or TeX origin in scene coordinates. Its domain must be an
increasing finite interval inside the scene duration. The target is a dedicated
path; it is not also an input to another operation or a destination for another
writer. This terminal-output rule rejects recursive regeneration explicitly.

| Field | Meaning |
| --- | --- |
| `domain` | Full source-time interval in seconds, independently of playback. |
| `step` | Maximum initial interval width; the interval is divided into equal cells no wider than this value. |
| `tolerance` | Observed chord interpolation error in scene bp; default 0.5. |
| `maxDepth` | Maximum bisection depth per initial cell; default 12, maximum 20. |
| `maxSamples` | Maximum independent source evaluations; default 8192, maximum 32768. |
| `seed` | Must be zero in version 1; no random samples are used. |
| `missing` | `break`: absent or hidden observed positions separate contours. |
| `reveal` | `full` displays the domain; `progress` clips it at absolute scene time. |

Each cell probes its endpoints, midpoint and quarter points. Excess observed
error triggers bisection. An unresolved numeric error at the depth limit or an
exhausted sample budget produces a diagnostic. At most 32 traces and a sum of
65536 configured samples are accepted per parameter state.

Visibility sampling respects a node's `visible` flag and the opacity of that
node and its ancestors. Paint colour, clipping and fill/stroke opacity do not
define source existence. Mixed visible/hidden cells are refined; unresolved
visibility boundaries are conservatively masked and reported. Genuine source
evaluation errors propagate with the trace time and source location.

**This is an observed-probe approximation, not a certified continuous bound.**
An oscillation, jump or visibility window narrower than the probes can be
missed. Choose a sufficiently small initial step for the source's frequency and
event timing. Version 1 does not infer analytic event times or root isolation.

Reports include sample and segment counts, accepted/observed errors, depth,
masked intervals, gap reasons, the full-domain result and current reveal state.
The progressive endpoint is interpolated along the prepared polyline; it can
differ from the exact source point within the approximation policy.

### Preparation, ownership and consumers

The evaluator samples a scene without traces through its ordinary shared plan.
It stores one bounded, immutable full-domain result per parameter state, then
constructs fresh frame geometry at each requested time. Changing validated
parameters replaces that result atomically. Prior frames and caller-owned
resources are never mutated. A failed resample cannot publish a partial trace.

Rendering fps and seek order do not choose trace vertices. A reversed seek or a
different video frame rate samples the same absolute-time object. Camera changes
do not change mathematical samples. At display time the path is converted through
the current target inverse matrix, preserving its scene placement under an
animated parent.

Use a parent for opacity or visibility animation. Parent transforms change its
local chart while the sampled scene path stays fixed. The trace target cannot
be an ancestor of other nodes and has no independent reveal writer. Arrow tips
on trace targets are outside this version's contract: a progressive or gapped
path need not have one open contour. Style and colour may be authored statically.

Stateful integration, accumulated simulation and arbitrary updater callbacks are
not converted by this feature. The later external-bake contract is intended for
those producers.

## Verification and references

Focused tests cover affine parents, graph order, parameter regeneration, missing
intersections, zero directions, limits, reverse seeks, multiple sampling rates,
ownership and immutable snapshots. Real TeX compiler tests also verify literal
capture, source archives and the same shared runtime behavior.

Conceptual references: [Manim Mobject updaters](https://docs.manim.community/en/stable/reference/manim.mobject.mobject.Mobject.html#manim.mobject.mobject.Mobject.add_updater)
and [TracedPath](https://docs.manim.community/en/stable/reference/manim.animation.changing.TracedPath.html).
These describe the use cases; no upstream implementation was copied.
