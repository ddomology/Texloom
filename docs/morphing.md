# Geometric transitions (PR20)

TeX describes the action, approved correspondence describes how geometry pairs,
and the shared execution plan evaluates each absolute time. SVG, Canvas, video
and the Chalkspace adapter consume ordinary evaluated paths and groups.

```sh
python tools/build.py examples/geometry-transitions.tex --out build/geometry-transitions --video
```

## Authoring

```tex
\usepackage{texloom-animation}
% Declare editable source and destination paths with loomgeometry first.
\begin{loomanimation}[origin=0.5]
  \loommorph[id=bend,duration=2,easing=smooth]{line}{curve}|{"approved":true,"contours":[{"source":"contour-0","target":"contour-0","segments":[{"source":"segment-0","target":"segment-0"}]}],"unmatched":"error"}|
  \loomclone[id=copy]{line}
  \loomtween[duration=2,easing=smooth]{copy}{transform.translate}|{"to":[200,0]}|
  \loomexit[duration=0.5,mode=fade]{copy}
\end{loomanimation}
```

All four commands participate in `loomsequence`, `loomparallel`, `loomstagger`
and cues. Durations are JSON numbers in seconds; write `0.5`, not `.5`.

| Command | Effect |
| --- | --- |
| `\loommorph[id=instance,duration=2]{source}{destination}` followed by literal JSON | Creates an independent group; interpolates approved geometry |
| `\loomclone[id=copy]{source}` | Creates an independent editable path snapshot at this instant |
| `\loomenter[duration=0.5,mode=fade]{target}` | Opacity from zero to one |
| `\loomexit[duration=0.5,mode=fade]{target}` | Opacity from one to zero |
| `mode=create` on enter/exit | Reveals/unreveals an editable path instead of changing opacity |

Morph and clone IDs are required and must differ from every scene node and
other instance. Sources must be authored editable paths. Groups, raster data,
and opaque SVG `d` strings cannot be morphed by this API. Sources remain in
the scene; hide template nodes explicitly when only the transition should show.

Morph creates `instance:shape`, `instance:leaving`, and `instance:entering`
under a group named `instance`. These IDs are reserved. Move, scale, rotate or
fade the group to affect the complete transition. The main shape supports
independent reveal and paint tracks. Helper geometry and the two unmatched
helpers' opacity/reveal have a single owner: the morph program.

The generated group and clone have opacity zero before their creation action;
at that exact time, the source's authored local opacity (default one) is restored.
They set their own `visible` flag to true, even for a hidden source template.
The original parent and its visibility still apply. The source's authored
reveal and paint are copied; using opacity zero or reveal zero to hide a template
also copies that value. Prefer an explicit hidden template flag.

Enter and exit are numeric tween conveniences. For an existing target, a delayed
enter preserves the authored value until its start. Author opacity/reveal zero
if it should already be hidden. Enter/exit endpoints are zero and one; use a
regular tween to restore a different opacity. Zero duration uses the existing
right-continuous set behavior.

## Correspondence is an author decision

`approved:true` is required. This release offers no automatic nearest-shape
matching. Inspect the two endpoint geometries and explicitly approve their
contour and segment pairs. Repeated equal-looking segments have distinct IDs.

```json
{
  "approved": true,
  "contours": [
    {
      "source": "outer",
      "target": "boundary",
      "segments": [
        {"source":"bottom","target":"edge-a"},
        {"source":"right","target":"edge-b"}
      ]
    }
  ],
  "unmatched": "error"
}
```

Each matched contour has the same open/closed state. Control correspondence
must pair every authored segment exactly once, in traversal order. A line
paired with a cubic is promoted to a cubic with collinear one-third/two-third
controls. Coordinates then interpolate in the usual Bernstein control basis.
No implicit nearest-point search, seam rotation, contour joining or topology
repair occurs.

Closed contours are checked for signed winding. Opposite winding requires an
explicit `reverseTarget:true` and the corresponding reversed segment order.
The implicit closing edge remains part of the closed path. Zero-area versus
nonzero-area closed contours are rejected; both degenerate contours may pair.
For filled nonzero paths, reversing only selected closed contours is rejected
because that can change holes into filled regions. Uniform reversal preserves
relative winding. Self-intersection-free intermediates are not guaranteed.

### Unequal segment counts

Omit per-segment pairs and explicitly select resampling:

```json
{
  "approved": true,
  "contours": [{"source":"coarse","target":"detailed"}],
  "resample": {"count":64,"tolerance":0.05},
  "unmatched":"error"
}
```

Sampling uses arc length independently for every contour. It never traverses
a move gap between separate contours. The interior representation is a polyline;
the report records original counts, sampled counts, tolerance, reversal,
zero-length segments, promotion and unmatched contours. Tolerance controls the
existing length sampler; it is not a proof of a global morph error bound.

At progress exactly zero and one, the original endpoint geometry, IDs, order
and segment kinds are restored exactly. A resampled interior can differ slightly
from the curved endpoint as it approaches that endpoint. Select enough samples
for the required image scale. Source geometry is never mutated.

Bounds: 128 contours and 8192 authored segments per endpoint, up to 4096 samples
per contour, 32768 output segments, and a separate preparation work bound.
Oversized requests fail with diagnostics instead of silently reducing fidelity.

### Unmatched contours

| Policy | Behavior |
| --- | --- |
| `error` (default) | Rejects any contour without a pair |
| `fade` | Source-only opacity is `1-p`; target-only opacity is `p` |
| `create` | Source-only reveal is `1-p`; target-only reveal is `p` |

Fade/create operate on whole unmatched contours and currently require
stroke-only paint (`fill:none`). Filled holes cannot be independently composited
as ordinary transparent paths. Matched filled multipaths are supported.
Both unmatched sets are separate ordinary helper paths; their appearance is
copied from the source. Destination paint is not interpolated. At either exact
endpoint, the complete original geometry is in the main shape and helpers are
empty, preserving endpoint geometry without overlapping duplicate strokes.

## Coordinates, ownership and portability

The order is **local geometry morph → instance local transform → ancestor
transforms → camera**. Both endpoint geometries are interpreted in authored
local bp coordinates (y down). The instance copies the source's authored
transform and parent. The destination's transform and parent are not applied.
For a desired move, animate the instance transform explicitly. This avoids
guessing how unrelated coordinate systems should correspond.

Endpoint snapshots use authored geometry at preparation, even if other tracks
subsequently animate the visible source. They do not sample the source's live
state at the morph start. Clones follow the same authored-snapshot rule. Chained
copies of generated instances and automatic live capture are outside this PR.

The compiled bundle adds `morphs:{version:1,operations:[...]}` and numeric
`morphProgress` tracks on instance groups. There is no renderer-specific clock
or callback. Preparing a scene validates correspondence once. Evaluation is a
pure function of absolute time; backward seeking and export use the same path.
Whole-geometry writers, control-point tracks and other conflicting programs are
rejected. Downstream curve operations can read `instance:shape` through the
shared dependency plan after lowering the authoring program.

`prepareCorrespondence` and `sampleCorrespondence` expose the pure geometry
API. Their inputs and returned snapshots are detached and immutable.
`compileTimeline` returns additional `generatedNodes` and `morphs` when used;
use `lowerTimeline` to assemble a complete validated bundle automatically.
Frame metadata `frame.morphs[instance]` contains progress and the approved report.

## Verification and references

Independent tests cover line/cubic promotion, exact endpoints, reverse winding,
implicit closure, holes, multiple paths, degenerate and duplicate segments,
resampling, unmatched policies, snapshot ownership, transformed consumers,
writer conflicts and seek order. Real TeX tests exercise the capture path and
source-span diagnostics. The full existing port gate retains its references.

The conceptual references are Manim's [Transform](https://docs.manim.community/en/stable/reference/manim.animation.transform.Transform.html)
and [VMobject](https://docs.manim.community/en/stable/reference/manim.mobject.types.vectorized_mobject.VMobject.html)
APIs. Their distinction between endpoint state and aligned vector data informed
this design. Implementation is local; no Manim implementation was copied.
This PR supplies explicit 2D path transitions; automatic semantic formula
matching and arbitrary 3D mesh correspondence remain separate roadmap work.
