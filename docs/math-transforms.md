# Formula transformations by authored part identity

PR22 moves, copies, replaces and removes named native TeX parts through the
shared timeline. Explicit correspondence supplies the meaning of a transition.
The engine does not prove an equation or guess which repeated symbol to use.

The runnable [algebra example](../examples/math-transformations.tex) shows
`(x+x)/2=3`, then `x+x=2·3`, then `2x=6`, with a separate one-to-two copy panel.
Every endpoint is an original TeX resource certified by the PR21 native-layout
comparison. Web/SVG, Canvas, video and Chalkspace sample the same evaluated
ordinary nodes and immutable vector resources.

## Minimal authoring

```tex
\documentclass{article}
\usepackage{texloom,texloom-math,texloom-animation}
\begin{document}
\TLScene{Collect like terms}{500}{300}{4}
\TLMath{before}{\loompartbox{left}{x}+\loompartbox{right}{x}}
\TLMath{after}{2\loompartbox{result}{x}}
\TLNode{A}{tex}{"resourceId":"before","x":150,"y":150,"scale":3,"visible":false}
\TLNode{B}{tex}{"resourceId":"after","x":190,"y":150,"scale":3,"visible":false}
\TLNode{intro}{tex}{"resourceId":"before","x":150,"y":150,"scale":3}
\begin{loomanimation}
  \loomwait{1}
  \loomsetvalue{intro}{style.opacity}|0|
  \loommathtransform[id=collect,duration=2,easing=smooth]{A}{B}|{"approved":true,"retention":"replace","pairs":[{"source":"left","target":"result","mode":"replace","sourceAnchor":"logical-center","targetAnchor":"logical-center"}],"unmatched":"fade","labels":{"source":"x plus x","target":"two x"}}|
  \loomwait{1}
\end{loomanimation}
\end{document}
```

```sh
python tools/build.py examples/math-transformations.tex --out build/math-transformations --video
```

Each endpoint is a hidden authored `tex` node. A separate visible intro node
can use the same resource before the first transition. `loommathtransform`
creates an independent instance which is hidden before its timeline action,
becomes visible at the action's start, and holds the native target afterward.
For successive transitions, set the old instance opacity to zero at the exact
start of the next action. This is explicit ownership; a second action does not
silently remove an unrelated instance.

## Correspondence contract

The JSON body is literal, archived with a source span, and must include:

| Field | Contract |
| --- | --- |
| `approved: true` | The author accepts this visual correspondence. |
| `retention` | `replace` or `keep-source`. |
| `pairs` | Ordered array of source part ID, target part ID, mode, and two anchors. |
| `unmatched` | `error` for complete paint coverage, or `fade` for unmatched material. |
| `labels` | Plain-language `source` and `target` descriptions, each at most 4096 characters. |

Pair modes and uniqueness are explicit:

- For `replace`, each used source ID has exactly one `replace` pair. Additional
  destinations from that same source must use `copy` pairs.
- For `keep-source`, all pairs use `copy`. The whole source remains while the
  target appears.
- A target ID can appear once. Parent/child selections whose paint overlaps
  cannot claim the same target leaves. Distinct source IDs cannot overlap
  either; intentional reuse names the same source ID with `copy`.
- Each named selection includes descendants. Every painted leaf is counted,
  including unmarked punctuation, fraction rules and ordinary text.
- `unmatched: 'error'` requires every source and target leaf to be covered.
  `fade` dissolves unmatched source paint during replacement and introduces
  unmatched target paint. A retained source keeps its full original paint.
- Empty and phantom parts remain valid identities. They do not acquire invented
  ink or invisible fake glyphs.

An anchor is either `[x,y]` in resource-local bp, or `"logical-center"`.
The latter requires the named part's genuine measured `logicalBox` from
`loompartbox`; a transparent part needs an explicit coordinate. Full-resource
ink bounds from PR21 part views cannot locate a selected term. If the native
guard rejects atomic boxing, use a transparent part and an explicit anchor.
The example demonstrates both forms.

For progress `p`, anchors are mapped by the endpoints' authored `x`, `y` and
`scale`, linearly interpolated in their common parent coordinates, and used to
place both native selected paint trees. Scale interpolates positively. The
timeline's chosen easing controls `p`. Source paths, glyph spacing and native
resource contents are never rewritten.

## Native paint and exact endpoints

At `p=0`, the instance paints the complete original source resource. At `p=1`,
it paints the complete original target resource. A retained source also remains
at `p=1`. This avoids reconstructing an endpoint from independently composited
parts, which could change paint order or antialiasing.

Inside the interval, matching native outlines with equal paint and equal
anchor-relative placement travel as a single painted branch. This avoids the
opacity dip of crossfading two identical glyphs. The equality test is
conservative: original path data, effective paint and normalized affine
positions must agree within 0.000002 bp, with no unsupported clip or opacity
scope inference. Mathematical text equality alone is never used.

Different native shapes move and crossfade. A primary replacement has source
weight `1-p` and target weight `p`. A copied branch fades into existence with
strength `p`; its two different shapes have weights `p(1-p)` and `p²`. An equal
shape copy uses one branch of weight `p`. These are native-paint transitions,
not automatic contour morphing between arbitrary characters.

Splitting an isolated opacity scope across multiple selected/remainder
resources would alter compositing. Such mappings fail with
`MATH_PART_OPACITY_PARTITION`. Choose a larger intact part or a whole-resource
fade. Native clipping and paint ancestry are retained. Endpoint node opacity
must agree: replacement applies it once around all moving parts; retention
uses separate original and moving opacity scopes so overlapping source and
target formulas composite independently.

PR22 also fixes measured-part baseline capture from PR21: the origin special
now lives inside the emitted box, after TeX inserts automatic math glue.
Independent glyph comparisons cover numerator, binary-operator, relation and
copy contexts, so a measured center cannot drift from its own native glyph.

## Runtime and accessibility

```ts
import {prepareMathCorrespondence, lowerTimeline, createEvaluator} from '../src/index.js';
const mapping = prepareMathCorrespondence(sourceResource, targetResource, {
  approved: true, retention: 'replace', unmatched: 'fade',
  pairs: [{source: 'left', target: 'result', mode: 'replace',
           sourceAnchor: 'logical-center', targetAnchor: 'logical-center'}],
});
// lowerTimeline accepts kind:'math-transform' with the same correspondence,
// plus labels, source/destination node IDs, instance id, duration and easing.
const frame = createEvaluator(compiledBundle)(1.25);
frame.mathTransforms; // progress, state, active, plain descriptions, retention
```

The compiled bundle has a versioned `mathTransforms` program. A public instance
group owns `mathProgress`; the shared execution plan samples every helper from
immutable endpoint snapshots. Repeated seeks have no playback history. Existing
tracks and typed expressions may drive progress; conflicting internal writers
fail. Generated helper placement, paint, transform and visibility are reserved.
Use the public instance's transform, opacity or visibility for presentation.

Reports distinguish `source`, `transition` and `target`. During a transition,
the description names both endpoints without claiming that the intermediate
image is a valid equation. Instance and ancestor opacity/visibility are read
after their dependencies; hidden instances are not announced. Active reports
feed escaped SVG descriptions and accessible labels, including the standard
SVG web player. Canvas and Chalkspace hosts receive the same frame metadata
and may expose it through their own accessible UI.

## Explicit bounds

- Endpoints must share parent, local transform and clip. Authored x/y/scale may
  differ. This PR does not infer arbitrary parent-space conversion.
- Endpoints are static authored snapshots. Animating the hidden templates later
  does not retarget an existing transformation. Animate the shared parent or
  public instance to move the composition.
- Native typesetting still passes the strict PR21 guard; arbitrary package
  internals and unsupported source expansion are not automatically understood.
- No automatic string matching is applied. Suggestions and contour-level
  character morphing can be added separately without changing explicit IDs.
- Mid-transition shapes may overlap or dissolve; an intermediate image is not
  asserted to be a mathematical identity. Route anchors and correspondence
  are author decisions.
- Limits: 128 transition operations; 256 pairs per correspondence; 65536 native
  leaves and 131072 paint items per resource; 262144 instanced mapped leaves.
  Timeline depth/node and existing JSON budgets also apply.

Conceptual reference: [Manim TransformMatchingTex](https://docs.manim.community/en/stable/reference/manim.animation.transform_matching_parts.TransformMatchingTex.html).
Texloom uses explicit authored mapping and its own portable runtime; no Manim
implementation was copied.
