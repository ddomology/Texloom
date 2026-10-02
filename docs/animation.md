# Animation composition (PR19)

Write the order of actions in TeX. The shared TypeScript compiler resolves
their times and lowers them to numeric tracks. SVG, Canvas, video and the
Chalkspace adapter continue to consume the same evaluated frames.

```sh
python tools/build.py examples/animation-composition.tex --out build/animation-composition --video
```

## TeX authoring

```tex
\usepackage{texloom-animation}
% Declare the referenced curve, point and formula objects first.
\begin{loomanimation}[origin=0.5]
  \loomcue{draw}
  \loomtween[duration=2,easing=smooth]{curve}{reveal}|{"to":1}|
  \begin{loomparallel}
    \loomtween[duration=4]{P}{progress}|{"to":0.9}|
    \begin{loomsequence}
      \loomwait{1}
      \loomtween[duration=1]{formula}{style.opacity}|{"from":0,"to":1}|
    \end{loomsequence}
  \end{loomparallel}
  \loomcue{explained}
  \loomwait{1}
\end{loomanimation}
```

`loomanimation` is one sequence root per scene. Its origin is an absolute
source time in seconds. Everything inside it uses relative durations.
Leaf commands must occur inside this root. Loading the package without using
it leaves an existing scene unchanged.

| Construct | Timing |
| --- | --- |
| `loomsequence` | Each child starts when the previous child ends |
| `loomparallel` | All children start together; the longest determines the end |
| `loomstagger` | Child i starts at i times the supplied lag in seconds |
| `\loomwait{seconds}` | Advances a sequence without writing any property |
| `\loomcue{name}` | Records a named instant without advancing time |
| `\loomtween[duration=…]{target}{property}` | Interpolates one numeric property |
| `\loomsetvalue{target}{property}` | Changes one numeric property instantly |

```tex
\begin{loomstagger}{0.3}
  \loomtween[duration=0.8]{first}{style.opacity}|{"to":1}|
  \loomtween[duration=0.8]{second}{style.opacity}|{"to":1}|
  \loomtween[duration=0.8]{third}{style.opacity}|{"to":1}|
\end{loomstagger}
\loomsetvalue{P}{progress}|0|
```

The tween body is literal JSON with `to` and optional `from`. A set body is a
JSON number or numeric vector. It is not TeX-expanded or evaluated as code.
Use `id=...` on groups/actions when a stable authored name is useful. Numeric
property values use the existing track units: bp positions, radians for
rotation, and dimensionless opacity, scale and path progress. Timing options
are finite numeric seconds, not expression strings.

The existing `\loomset{...}` still configures TikZ styles. The instantaneous
animation command has the distinct name `\loomsetvalue`.

## Time and endpoint semantics

- Sequence duration is the sum of child durations.
- Parallel duration is the maximum child duration, or zero for an empty group.
- Stagger duration is the maximum of `i * lag + childDuration`.
- A positive tween is active on `[start,end)`. At the exact end its destination
  is present, unless a following action at that time replaces it.
- A zero-duration tween is a set to its `to` value. Its `from` does not create
  an interval or an intermediate visible state.
- Values hold between actions and after the last action. Before the first
  action, the original property value is retained.
- Omitted `from` uses that lane's preceding value, including previous sets.
  Explicit `from` can create a jump at the start, without modifying the
  preceding interval.

There is no artificial epsilon inserted around an instantaneous change. Keys
are strictly increasing; separate incoming values retain the left limit and
the key value determines the exact instant and its right side.

For simultaneous boundary changes, sequence order establishes precedence.
Ambiguous same-time writes from parallel branches are rejected. Adjacent
positive intervals may meet at a common endpoint; their active ranges do not
overlap. Two positive intervals writing the same property may not overlap.
This version provides no implicit last-writer rule or blending operation.

Every group must finish within the declared scene duration. The compiler
rejects negative durations, nonfinite sums and a positive duration too small
to advance the current floating-point time. Group time scaling, loops and
reverse playback policies are future additions. Seeking backward is already
supported because sampling is independent of playback history.

Sequence children inherit the preceding child's actual end time. Metadata
retains this canonical `end` independently of the descriptive `duration`,
which is `end - origin`. Use the stored endpoint for boundary comparisons;
reconstructing it with `origin + duration` can round differently.

## Easing, units and property ownership

Easing is `linear`, `smooth` (the cubic `u²(3−2u)`) or `step`. Different actions
on the same property may use different easing. A step holds its starting
value throughout its active interval and changes at the exact endpoint.

Properties use the existing numeric track contract, including vectors,
camera values, path reveal and editable path controls. The property schema
checks dimensions, allowed ranges and target identities. A generated track
owns its property for the entire scene, including holds; an existing track,
expression, graph binding or deformation cannot also own that property.

Missing properties need a well-defined base value. Local opacity and identity
transforms have defaults. Inherited paint or other ambiguous initial values
need explicit authoring. Changing geometry still passes through the common
dependency plan before point, tangent and connector consumers read it.

## Cues and source data

Cues are timestamped data. Frame sampling does not play audio, call callbacks
or remember which cues were previously crossed. A host can apply its own
playback, scrubbing and deduplication policies. Named cues are globally unique
within the composition. They are markers, not scheduling references.

The source AST and command sidecars are archived under `animation-sources/`.
Compilation preserves source locations on clips and tracks. Conflict errors
identify both authored commands and their time intervals. The compiled bundle
contains numeric tracks and timeline metadata; it does not require a separate
renderer-specific scheduler or a Python scheduling implementation.

The programmatic API is `compileTimeline(program,bundle)` for the compiled
tracks/report, and `lowerTimeline(program,bundle)` for a new validated bundle.
Both preserve the authored input. Prepared scenes expose the resulting cue
metadata, and host clips map it using the same source offset and rate as their
frame clock.

`runtime.manifest.timeline` exposes a frozen snapshot. `clip.cues` contains
`name`, `sourceTime`, `hostTime` and any source location. Cues at both source
endpoints are included, even though the clip's active frame interval excludes
its ending instant. This lets a host retain a terminal cue without implying
that sampling at that instant dispatches an event. Positive clip durations
must advance both the source and host clocks at their numeric precision.

An authoring AST permits at most 4096 nodes and 32 nesting levels. Root
version is 1 and the typed compilation API requires a Bundle 0.3 context.
The TeX frontend promotes scenes using the new commands to that version.

## Scope and references

This step composes numeric animation actions. Automatic shape morphing,
semantic formula matching, symbolic expressions in durations, arbitrary
callbacks, audio playback and Blender simulation remain separate features.
The existing `loomanimate` syntax remains valid on other properties.

Conceptual references: [Manim AnimationGroup](https://docs.manim.community/en/stable/reference/manim.animation.composition.AnimationGroup.html)
and [Manim Succession](https://docs.manim.community/en/stable/reference/manim.animation.composition.Succession.html).
The implementation uses Texloom's own object, source and track contracts.
