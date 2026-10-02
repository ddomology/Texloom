# Texloom 0.2: named TikZ objects

The opt-in `texloom-tikz` package adds a TeX/PGF-key authoring frontend without
JSON in the source. The original `texloom` 0.1 package and bundle format remain
supported. See `examples/commutative.tex` for a complete 12-second scene.

```tex
\documentclass{article}
\usepackage{texloom-tikz}
\loomset{object/.style={rectangle,draw,minimum width=70bp,minimum height=45bp}}
\begin{document}
\begin{loomscene}[width=600,height=300,duration=4,title={Moving objects}]
  \loomconnect[draw=blue,->] (f) (A.east) to (B.west);
  \loomnode[object] (A) at (120,130) {$X$};
  \loomnode[object] (B) at (440,130) {$Y$};
  \loomlabel[at=.5,offset=-15,scale=1.8] (flabel) on (f) {$f$};
  \loomanimate[duration=4] (A) {move to={(160,180)},rotate to=8};
\end{loomscene}
\end{document}
```

## What executes in PGF

`\loomnode[<TikZ node options>] (ID) at (x,y) {<TeX text>};` creates a real
TikZ node in a separate measured LaTeX asset. TikZ evaluates its shape, font,
styles, minimum dimensions, inner/outer separation, paths, colors, and text.
PGF's actual `\pgfpointanchor` coordinates are captured before flattening;
Texloom does not guess anchors from SVG ink bounds. Center, cardinal, diagonal,
base, and mid anchors are recorded when the selected shape defines them.

Each named node becomes an author-ID group with local anchors and a vector-art
child. The true PGF picture bounding box positions that child relative to the
node center. TeX baseline and box dimensions remain in the resource. Appearance
travels through DVI/dvisvgm and the strict vector importer; public IR has paint
objects and resource provenance, not an SVG string.

Named styles belong in `\loomset{...}`. Put shared macro definitions, color
definitions, extra libraries, or `\tikzset` calls in `\loomsetup{...}`. Both
execute in the authored document and are replayed in generated assets. Plain
definitions outside these setup commands are not automatically copied into
assets. Define setup before the scene; changing a named style midway through a
scene is not a supported time-varying style mechanism.

## Units and transforms

- Scene coordinates are **bp** (72 per inch), x rightward, y downward.
- Shape lengths such as `minimum width=80bp` and `inner sep=3pt` retain normal
  TeX units. TeX pt (72.27/in) is converted to bp once by the compiler.
- Authored group `rotate` and tween `rotate to` values are **degrees**, positive
  clockwise in the scene's downward-y space. Public IR stores radians.
- Native TikZ node options retain TikZ's own transform and angle conventions.
  Prefer scene groups/tweens for live transforms, so their meaning stays visible.
- `scale` is uniform and dimensionless. A group transforms about its local
  origin. A named node's local origin is the PGF node center.
- Node placement always uses `anchor=center`; use the node's exported anchors
  to attach other objects. Cross-node positioning keys inside a node's TikZ
  options cannot refer to other assets.

## Live wrapper options

| Command | Supported options |
| --- | --- |
| `loomscene` | `width`, `height`, `duration`, `title` |
| `loomgroup` | `at={(x,y)}`, `rotate`, `scale`, `opacity` |
| `loomconnect` | `draw`, `line width`, `opacity`, `bend`, `arrow size`, `->`, `<-`, `<->`, `-`, `thick`, `thin` |
| `loomlabel` | `at` (0–1), `offset`, `scale`, `text`, `rotate=true/false` |
| `loompath` | `at={(x,y)}`, `scale` |
| `loomanimate` | `duration`, `delay`, `easing=smooth/linear/step` |
| tween body | `move to={(x,y)}`, `rotate to`, `scale to`, `opacity to` |

These keys are evaluated by PGF keys. Unknown wrapper keys and unknown TikZ
node keys are errors, not silently ignored options. IDs use ASCII letters,
digits, underscores, and hyphens, starting with a letter; `ID-art` is reserved
for the generated artwork of `ID`. Keep titles plain text; JSON string escapes
in metadata titles are not a supported authoring feature yet.

```tex
\begin{loomgroup}[at={(300,180)},rotate=3,scale=.95]{diagram}
  \begin{loomgroup}{triangle}
    % Children use coordinates relative to these explicit parent groups.
  \end{loomgroup}
\end{loomgroup}
\loomanimate[duration=2] (diagram) {rotate to=8};
\loomanimate[delay=2,duration=2] (diagram) {rotate to=3};
```

Tweens on the same property merge when intervals do not overlap and easing is
the same. Delays are absolute scene times. Between tweens a property holds its
last value. Transform tweens are absolute targets, not increments.

## Connections and labels

Connections preserve endpoint **identity** (`A.east`, `B.south west`). The
runtime resolves anchors through local and parent transforms every frame,
including connections between different parent groups. A connection target is
an independent path; it can appear before its endpoints in the source to draw
behind them. `bend` is a signed perpendicular control-point distance in the
path parent's bp space, not
TikZ's `bend left` angle. Live arrowheads are Texloom triangles oriented along
the curve tangent; they do not claim to implement PGF `Stealth` semantics.

Labels refer to a named live connection. `at` is its cubic Bezier parameter,
not arc length. `offset` is a signed normal offset in the label parent's bp space. Text is centered with
its real TeX width, height and depth. By default labels keep their parent-frame
orientation. `rotate=true` follows the tangent in that frame.

## Native static path artwork

```tex
\loompath[at={(60,60)}] (art) {
  \begin{scope}
    \clip (0,0) rectangle (120,60);
    \draw[blue,line width=2bp,opacity=.5]
      (-10,50) .. controls (20,-20) and (100,90) .. (130,5);
  \end{scope}
};
```

The path body is genuine TikZ in a picture with `x=1bp,y=-1bp`. Native curves,
scopes, clips, paths, arrows, fills, and strokes work when the existing strict
vector importer supports their output. Shadings, patterns, filters, and other
unsupported paint servers fail with diagnostics. This wrapper is one artwork
object; its internal vertices and TikZ relations do **not** become live scene
dependencies. The complete resource can still translate, rotate, scale, fade.

## Scope of this version

This is a measured named-node bridge, not a parser for arbitrary existing TikZ
documents. Arbitrary `\draw (A.east)--(B.west)` code is not automatically lifted
to a live connection; use `\loomconnect`. Runtime shape/text re-typesetting,
arbitrary PGF animations, moving intersections, decorations, procedural meshes,
3D surfaces and PDE solvers remain later extensions. PGF is executed as an
installed dependency; its implementation source has not been copied into this
repository.

## Build and integration tests

```powershell
python tools/compile.py examples/commutative.tex --out build/v02
node tools/build-player.mjs build/v02/bundle.json build/v02/player.html
python -m unittest discover -s tests -p '*compiler_test.py'
```

The integration tests run real LaTeX/PGF and check rectangle versus circle
anchors, outer-separation versus ink bounds, font/math compilation, nested
groups, degree/radian conversion, retained clips/Bezier paths, color/line units,
merged timing, and diagnostics. Compilation uses `-no-shell-escape`; authored
TeX is trusted input, as in v0.1.
