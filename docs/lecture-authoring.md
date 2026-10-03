# Lecture authoring from TeX notes

The PR40 authoring layer connects semantic lecture blocks, their spoken text,
and ordinary Texloom scenes. The same source can supply a reading page, a timed
web preview, and a Chalkspace lecture plan. The scene compiler and renderers
remain the existing public Texloom pipeline.

This is an authoring and verification harness. Successful compilation checks
syntax, references, assets, and the declared timing contract. It does not certify
a mathematical proof or prove that a viewer will understand the explanation.

## Source contract

```tex
\documentclass{article}
\usepackage{texloom-lecture}
\loomlecturesetup{\usepackage{amsmath,amssymb}}
\begin{document}
\loomlecture{lesson-id}{A human-readable lesson title}
\loomblock{claim}{theorem}{A short block title}
{The mathematical statement, using genuine \LaTeX{} syntax.}
{Spoken English that states the same assumptions and conclusion.}
\loomsceneuse{claim}{diagrams/claim.tex}{An explanation of the illustration.}
\end{document}
```

`\loomlecture` declares the lesson identity and title. Each `\loomblock` has a
stable identity, a semantic kind, a title, TeX body, and spoken text. Supported
kinds are `definition`, `theorem`, `lemma`, `corollary`, `proof`, `example`,
`remark`, and `explanation`. Titles provide orientation; they are not a
substitute for the mathematical content in the body.

`\loomlecturesetup` supplies the preamble needed by the body fragments. Keep
actual TeX commands in these arguments: `\varepsilon`, not a string containing
two literal backslashes followed by `varepsilon`.

`\loomsceneuse` associates a block with a source scene and a caption. Resolve the
scene path relative to the lecture source. Keep the lecture's assets and diagram
sources together under its source directory. A referenced scene is an ordinary
Texloom `.tex` scene; it can use the supported TikZ-like frontend, native nodes,
and animation tracks without a lesson-specific renderer.

## Writing blocks that can be narrated

Use one mathematical step or one short paragraph per block. State assumptions
before invoking them. In proofs, identify where each hypothesis is used, explain
the construction, and finish the inference. Split long arguments at meaningful
steps rather than splitting after every printed line.

Keep spoken text close to the body. Read the same quantifiers, bounds, and
conclusions in the same order. Explain symbols in ordinary speech, such as
"epsilon divided by three" or "h after f". A spoken paragraph should not claim
an inequality or theorem that is absent from the displayed block. Conversely,
an essential step should not appear only in an unspoken formula.

Scene captions should identify what the image represents and where it is only
schematic. A drawing of neighborhoods does not add a Euclidean metric to an
abstract topological space. A dot moving along a commutative diagram represents
composition, not a numerical trajectory. A chain of three error estimates does
not assert an ordering of the four real function values.

## CLI workflow

Run these commands from the Texloom repository with its Python environment
activated and the repository's Node and TeX dependencies available. The entry
point is `tools/lecture.py`; the corresponding Python functions use the same
capture, compilation, validation, and revision checks.

Discover supported operations and copy the syntax of an actual example:

```console
python tools/lecture.py capabilities
python tools/lecture.py templates
python tools/lecture.py syntax commuting-square
```

`templates` returns the available example IDs and source paths. `syntax` returns
the selected source, the actual lecture package source, and this documentation
path. It does not create a new file or overwrite an existing lesson.

Build and inspect a complete lecture:

```console
python tools/lecture.py compile examples/lectures/hausdorff-compact-closed.tex --out build/my-lecture
python tools/lecture.py validate build/my-lecture --check-inputs
python tools/lecture.py preview build/my-lecture --check-inputs
```

Use a new empty output directory for each build. `preview` validates the build
and returns the URI of `index.html`; it does not launch a browser or start a
server. Both validation commands verify published artifact hashes. The
`--check-inputs` flag also checks the original input files recorded by the build.
Without that flag, a preserved earlier build can still be inspected after its
authoring source has changed.

Input tracking combines the native compiler's dependency trace with a
conservative hash snapshot of the lecture's source directory. Keep a dedicated
source package: even an otherwise unrelated tracked file changing in that
directory can invalidate `--check-inputs`. The snapshot is bounded to 256 MiB
and 10,000 files; the current build output is excluded.

The build directory contains:

| Artifact | Purpose |
| --- | --- |
| `index.html` | Reading view with TeX paragraph vectors, script text, and scene players |
| `notes.json` | Executed semantic block capture and source spans |
| `lesson.json` | Ordered paragraph objects and spoken beats for the consumer |
| `authoring-map.json` | Block, beat, object, scene, and source correspondence |
| `scene-map.json`, `scenes/` | Referenced native scenes and their playable builds |
| `vectors/`, `paragraphs/bundle.json` | Measured native TeX paragraph rendering |
| `manifest.json` | Source and artifact revisions plus file hashes |
| `report.json`, `status.json` | Validation evidence and build status |
| `sources/` | The captured lecture source and generated paragraph scene source |

Sample a referenced animation through the same native runtime:

```console
python tools/lecture.py sample build/my-lecture/scenes/figure-1/bundle.json --time 4 --out build/figure-at-4s.svg
```

The time must lie within that scene's own duration. It is a scene timestamp,
not automatically the time of the surrounding lecture block.

Apply a revision-bound source repair, then compile into a fresh directory:

```console
python tools/lecture.py repair examples/lectures/hausdorff-compact-closed.tex --build build/my-lecture --request repair.json
python tools/lecture.py compile examples/lectures/hausdorff-compact-closed.tex --out build/my-lecture-revised
```

The repair request is a JSON object containing `expectedSourceRevision` and
`expectedArtifactRevision` from the current manifest, the exact `sourceSpan`,
`expectedText`, and `replacement`. Source spans use half-open Unicode code-point
offsets, not byte offsets. Copy a literal block's span from the correspondence
map and match its current text exactly. Stale source, stale artifacts, or a
mismatched text span cause rejection. A successful repair records an audit next
to the source and preserves the earlier published build.

A failed TeX build also records a failed-build manifest, the source revision,
and diagnostic source span. When an exact block cannot be identified, the span
is conservatively marked `precision: document`; it does not claim an exact
error location. Use that failed manifest and span in the same repair command,
then compile to a fresh directory. Validation continues to report the earlier
build as failed even after the repaired source compiles successfully.

With the compatible Chalkspace checkout and its Python environment installed,
export a short consumer video:

```console
python tools/lecture.py video build/my-lecture --chalkspace ../Chalkspace --out build/demo.mp4 --end 12
```

The optional narrated version uses the consumer's available local voice backend
(the Windows voice path is supported by the local setup):

```console
python tools/lecture.py video build/my-lecture --chalkspace ../Chalkspace --out build/demo-voiced.mp4 --narrate --end 12
```

`--start`, `--end`, and `--fps` select the exported lecture interval and frame
rate; defaults are a start time of zero and 30 frames per second. The command
returns the video, consumer plan, and authoring audit paths. Inspect that audit
to distinguish estimated silent-script timing from measured local-audio timing.

## Three complete public examples

| Source | Content | Referenced scene |
| --- | --- | --- |
| `examples/lectures/hausdorff-compact-closed.tex` | Ten blocks proving that a compact subset of a Hausdorff space is closed | `diagrams/hausdorff-separation.tex` |
| `examples/lectures/commuting-square.tex` | Eight blocks defining composition and proving an explicit square commutes | `diagrams/commuting-square.tex` |
| `examples/lectures/uniform-limit-continuity.tex` | Ten blocks proving continuity of a uniform limit | `diagrams/epsilon-three-terms.tex` |

The Hausdorff proof handles the empty subset, relates ambient open covers to
the subspace definition of compactness, chooses disjoint neighborhoods, extracts
a finite subcover, forms a finite intersection, proves its disjointness from the
compact set, and concludes that the complement is open. The case of an empty
complement is also explicit.

The commuting square uses four labeled copies of the real numbers with
`f(x)=x+1`, `g(x)=2x`, `h(y)=2y`, and `k(z)=z+2`. Both composites send every input
to `2x+2`. The numerical example at `x=3` illustrates the identity without being
presented as its proof. A final remark distinguishes this square's identity
from the different equation `f∘g=g∘f`.

The analysis proof assumes a metric domain and continuous real-valued
functions. It chooses one uniform approximation index before choosing the local
continuity radius. The first and third errors use that same index; the middle
error uses continuity of the chosen function. The theorem proves ordinary
continuity, not uniform continuity. The final `x^n` example explains why
pointwise convergence is insufficient.

All three scene sources are animated with public frontend commands. The
Hausdorff scene varies boundary control points while preserving the distinguished
points and the indicated disjointness. The square uses two coordinate tracks to
trace its routes. The analysis scene reveals three error links in sequence.
Each scene has a declared duration of eight seconds.

## Timing: a deterministic schedule is not a measured voice track

There are three different quantities to keep distinct:

1. **Scene time.** Native scene tracks have explicit timestamps. Sampling the
   same source time reproduces the same scene state.
2. **Estimated narration time.** A schedule derived from word counts or a
   speaking-rate setting estimates how long the text may take to read. It has
   no measured information about pauses, pronunciation, or actual speech.
3. **Measured narration time.** Recorded audio or a verified speech alignment
   supplies actual timings. Only that evidence can support a claim about an
   audio-to-board offset or measured narration synchronization.

A measured clip duration establishes the audio extent of its block. It does not
by itself establish the timestamp of each spoken word or mathematical symbol.

A preview may use an entirely deterministic estimated schedule. Its metadata
must still label that schedule as estimated. Silent video exports demonstrate
the board and scene timeline; they are not evidence of synchronized narration.
An eight-second diagram can have a different duration from the spoken block
that introduces it. Any hold, replay, or time remapping must be explicit in the
generated plan.

## Review and repair

Treat source identity, block identity, scene references, and artifact revision
as part of a repair request. Apply a targeted repair to the current revision,
then rebuild and inspect the affected block and its neighbors. Do not patch a
generated picture while leaving the semantic source inconsistent with it.

Check the following independently:

- Every authored block is represented in the generated reading view, script
  mapping, and lecture plan, in the intended order.
- Every reference resolves to the intended scene, with the intended caption.
- Formulas, line wrapping, labels, and scene bounds remain readable at the
  target viewport, with no unintended overlap or clipping.
- Script and board make the same mathematical claims. Missing quantifiers or
  an incorrect sign can survive both TeX compilation and visual inspection.
- Timing reports distinguish estimated schedule values from measured audio
  values; unavailable measurements remain unavailable.
- Repair history records actual source edits and their revisions. Do not infer
  a zero-edit workflow merely because the final build succeeded.

These examples received an author self-review when written. That is not an
independent mathematical approval. Mathematical review must remain unresolved
until an identified human reviewer checks the current source and records the
result. Likewise, successful tests are not a substitute for reviewing a video
at its intended viewing size and pace.

## Scope

The source deliberately carries both TeX content and an explicit script. This
version does not promise to recover all semantic structure from an arbitrary
existing textbook document, to synthesize a correct proof, or to validate the
mathematics automatically. It provides a consistent place to author, compile,
inspect, and revise those ingredients while reusing the established scene IR.
