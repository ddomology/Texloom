# Native TeX semantic parts

PR 21 gives authored formula parts stable identity without replacing TeX's
typesetter. It preserves the original vector paint and attaches a selection
tree to it. Formula-to-formula correspondence and semantic morphs belong to
PR 22; a part view in this version is a static selection that ordinary timeline
operations can animate as a node.

## Authoring

```tex
\usepackage{texloom,texloom-math,texloom-animation}
% Inside the document, after TLScene:
\TLMath{equation}{\loompart{whole}{
  \loompart{left-x}{x}+\loompart{right-x}{x}=2x}}
\TLNode{formula}{tex}{"resourceId":"equation","x":120,"y":180,"scale":3}
\loompartview{second-highlight}{formula}|{"query":{"ids":["right-x"],"scope":"descendants","overlap":"error"},"style":{"fill":"#ed8c7a","opacity":0}}|
\begin{loomanimation}
  \loomtween[duration=0.4]{second-highlight}{style.opacity}|{"from":0,"to":1}|
  \loomwait{1}
\end{loomanimation}
```

The complete runnable example is
[`semantic-math-parts.tex`](../examples/semantic-math-parts.tex). Compile it with:

```sh
python tools/compile.py examples/semantic-math-parts.tex --out build/semantic-math-parts
node tools/build-player.mjs build/semantic-math-parts/bundle.json build/semantic-math-parts/player.html
```

`\loompart{id}{body}` inserts transparent DVI specials around its body. It does
not add a group or a box. Use literal IDs matching
`[A-Za-z][A-Za-z0-9_.:-]{0,255}`, unique within each resource. Repeated printed
symbols remain distinct because the author supplies their identities.

`\loompartbox{id}{body}` explicitly makes an atomic box and measures its real
TeX width, height and depth in the active math style. Use it when an exact
logical extent is needed and boxing preserves the native formula. The native
comparison below is still mandatory. For example,
`\loompartbox{reserved}{\phantom{x^2}}` records space with no painted leaves.
Transparent parts do not claim measured logical boxes; ink bounds are never
substituted for logical dimensions.

`\loompartview{viewId}{sourceTexNode}|JSON|` selects parts and produces an
ordinary vector resource and TeX node. The JSON requires `query` and accepts
optional `style` with `fill` and `opacity`. The view copies the source node's
placement, parent, transform and clip. It is a static snapshot: later motion of
the source node does not move its sibling view. Put both under the same moving
parent or animate the view explicitly when they should move together.

Views are lowered after the existing source scene programs and before
`loomanimation`. Use that timeline syntax to animate generated view IDs. A raw
`TLTrack`, relation or expression referencing a view before it exists is not
accepted by the source-scene validation. At most 256 views may be declared in
one lowering pass; a view's source must be an authored TeX node, not another
new view from the same pass.

The view retains the whole source's metrics and ink bounds to preserve
alignment; these bounds are not the selected glyphs' bounds. It retains the
source bounds even for empty selections, so bounds-based anchors refer to the
whole original formula. A selected-ink bounding API is separate future work.
It retains the
pruned original paint tree, including ancestor clips and isolated group
opacity. Its fill override recolors painted fills, preserving `none`; opacity
acts at the node boundary. Original resource paint is untouched. Generated
views omit original part addresses and glyph inventories whose indices would
be invalid after pruning. Provenance records their selected original IDs.

## Import contract and selection

```ts
import {selectTextParts} from '../src/index.js';
const selected = selectTextParts(resource, {
  ids: ['right-x'], scope: 'descendants', overlap: 'error',
});
// Immutable detached paint tree; original resource coordinates are preserved.
selected.items;
selected.leaves; // original addresses, owners, ancestors and accumulated matrices
```

An optional `resource.textParts = {version: 1, parts: [...]}` contains:

| Field | Meaning |
| --- | --- |
| `id`, optional `parent` | Authored identity and lexical nesting. |
| `sourceRange` | Body offsets in `resource.sourceTex`, in Unicode code points, end exclusive. |
| `sourceSpan` | Archived body location with one-based line/column, end exclusive. |
| `paintPaths` | Directly owned path-leaf addresses: index in `items`, then `children`. |
| optional `logicalBox` | Measured `[x,y,width,height]` in resource-local bp. |

Parents directly own only leaves outside their nested child parts. A query
must state its policy:

| Option | Behavior |
| --- | --- |
| `scope: 'exact'` | Select only directly owned leaves. |
| `scope: 'descendants'` | Include all nested parts and their leaves. |
| `overlap: 'error'` | Reject an ancestor and descendant requested together with descendant scope. |
| `overlap: 'ancestor-wins'` | Deduplicate nested requests while preserving original paint order. |

Empty and phantom parts are valid identities with empty paint selections.
An empty selection is not a missing ID. Unknown IDs, duplicate IDs, invalid
addresses, cyclic parents and multiply owned leaves fail validation.

The literal capture scanner follows standard TeX catcodes and does not expand
macros. Captured bodies are archived under `math-sources/`. A unique matching
literal original body receives an original source span. Ambiguous IDs across
resources or transformed source retain the exact generated-asset span with
`sourcePrecision: 'generated-asset'`. Original source is archived too. The
range always refers to `sourceTex`, regardless of span provenance.

## Native-layout certification

Each annotated resource is compiled twice using the same setup and toolchain:

1. Compile markers through LaTeX, DVI and dvisvgm; import paint and identities.
2. Compile a native reference with both marker commands replaced by their body.
3. Require identical TeX box metrics, original paint order, normalized outline
   coordinates, effective paint, clipping and opacity isolation.
4. Publish a bundle only after certification and shared schema validation.

Coordinate comparisons allow at most **0.000002 bp** for SVG decimal
serialization. TeX width, height and depth are exact at the compiler's recorded
precision. The certificate records maximum coordinate/ink differences, leaf
count and native DVI/SVG hashes in `provenance.textPartsValidation`. This costs
one additional TeX/vector compile per annotated resource; unannotated resources
retain the existing path.

The test references are independently authored unmarked formulas. They cover
fractions, scripts, full large operators and limits, scalable delimiters,
repeated symbols, aligned equations, fonts, whole text words, paragraphs,
empty parts, phantom material and nested measured math styles. The test oracle
is separate from the production comparison implementation.

## Boundaries and diagnostics

Adding specials can still affect TeX. Splitting the `fi` ligature with
`f\loompart{i}{i}`, or marking only `\sum` with its scripts outside the marker,
changes native typesetting and fails with `TEXT_PART_LAYOUT`. Mark the whole
word or the whole operator including scripts. Boxing a binary operator can
change spacing and is also rejected. There is no silent approximate fallback.
For unsupported internal macro structure, mark the whole macro call as one
part; if it cannot be certified, leave the resource unannotated.

Marks discarded inside `\phantom`, inactive `\mathchoice` branches or unused
boxes cannot acquire paint ownership: the emitted/source mismatch fails.
Place a phantom marker outside `\phantom{...}`. Dynamically generated or
duplicated IDs fail instead of being guessed. Explicit catcode manipulation,
verbatim environments and similar nonstandard source parsing are unsupported
inside annotated resources; source capture diagnoses them.

The layout certifier supports polynomial SVG path commands. It conservatively
rejects elliptical `A/a` commands in annotated resources. Ordinary unannotated
vector import support is unchanged. Arbitrary TeX package internals, inferred
mathematical ASTs, inferred glyph identities and formula morph correspondence
are outside this PR.

Limits: 4096 parts, 64 levels of part/paint addresses, 65536 owned leaf
addresses. Measured boxing allows at most four nested measured parts and a
worst-case construction budget of 4096 (sum of `4^measuredDepth` for markers),
because TeX constructs all four math styles before choosing one.

## Design references

- [dvisvgm specials](https://dvisvgm.de/Manpage/): raw SVG groups and DVI-position
  placeholders carry identity and genuine box measurements through typesetting.
- [Manim MathTex](https://docs.manim.community/en/stable/reference/manim.mobject.text.tex_mobject.MathTex.html):
  useful API precedent for selectable formula parts. Texloom keeps original
  whole-formula paint and verifies it against a native reference.

These references informed the design; no implementation code was copied.
