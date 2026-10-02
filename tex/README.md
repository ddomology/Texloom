# TeX frontend v0.1

`texloom.sty` executes under real LaTeX and writes declarations to JSONL. The
compiler then compiles each mathematical/text/TikZ resource with LaTeX and
dvisvgm, measures the logical TeX box, and imports transport SVG as normalized
vector objects. The final bundle has no raw SVG payload.

## Minimal authored scene

```tex
\documentclass{article}
\usepackage{texloom}
\begin{document}
\TLScene{A moving formula}{960}{540}{4}
\TLCamera{0}{0}{1}
\TLSetup{\newcommand{\R}{\mathbb{R}}}
\TLMath{formula}{\frac{x_i^2}{1+x_i^2}\in\R}
\TLNode{label}{tex}{"resourceId":"formula","x":100,"y":240,"scale":3}
\TLTrack{label}{x}{smooth}{[[0,100],[4,500]]}
\end{document}
```

Compile from the repository root:

```text
python tools/compile.py examples/orbit.tex --out build/demo
```

## Commands

| Command | Meaning |
|---|---|
| `\TLScene{title}{width}{height}{seconds}` | One scene, bp units, y down |
| `\TLCamera{x}{y}{zoom}` | Base camera values |
| `\TLNode{id}{kind}{JSON properties}` | A versioned scene object |
| `\TLTrack{id}{property}{linear/smooth/step}{JSON keys}` | Scalar/vector keyframes |
| `\TLRelation{type}{JSON properties}` | An explicit geometric dependency |
| `\TLMath{id}{math body}` | Display-style math in an exactly measured hbox |
| `\TLText{id}{TeX text}` | TeX text resource |
| `\TLTikZ{id}{tikzpicture}` | Static TikZ picture as a vector resource |
| `\TLSetup{TeX preamble}` | Shared definitions/packages for resource compilation |
| `\TLFieldFile{id}{relative JSON path}` | Load sampled scalar-field data |
| `\TLDocument{JSON object}` | Optional document metadata |

IDs are stable author-chosen names. JSON property arguments must be valid JSON.
Numeric scene properties are literal JSON values; v0.1 does not evaluate TeX
expressions in these arguments. Node declarations can be emitted by TeX macros;
normal TeX parameter escaping still applies (`##` inside a macro definition).
Titles and IDs currently must not contain JSON quotes/backslashes. TeX math
bodies may use arbitrary supported TeX macros provided by `TLSetup`; ordinary
source-preamble definitions are not implicitly copied into standalone resources.
Use one `TLSetup` declaration; the latest declaration supplies the resource setup.

## Exact scope

- Supported SVG transport: paths, basic shapes converted to paths, local uses,
  affine groups, paint order, group opacity, fill/stroke alpha, single-path
  user-space clipping, fill rules, solid colors, dashed strokes.
- Unsupported elements, filters, masks, gradients/pattern paint servers,
  external images/fonts/references, and unsupported clipping fail explicitly.
- TikZ pictures are static resource trees in this version. Their node names and
  geometric dependencies are not inferred as live scene objects. Use explicit
  `TLNode`, `TLTrack`, and `TLRelation` declarations for live geometry.
- TeX logical width/height/depth and visible ink bounds are independent. Empty
  phantom and overflowing zero-height boxes are retained correctly.
- The imported `glyphs` array records transport outline IDs and use positions;
  final placement is the PaintItem affine hierarchy, not the glyph metadata.
- Source node line numbers identify the executed declaration call site. They
  are not a full TeX macro-expansion source map.
- Compiled outputs retain source/DVI artifacts and hashes in fresh run folders.
  A failed invocation invalidates the previous `bundle.json` to prevent stale
  successful output from being consumed accidentally.

TeX is executable input. Shell escape is disabled, but the CLI is intended for
trusted local sources, not as a sandbox for arbitrary uploaded TeX.

## Evidence

`python -m unittest discover -s tests -p compiler_test.py -v` runs real-engine
fixtures and vector-import failures. `python tools/compiler_probe.py` compares
LuaTeX node capture with the selected DVI path on an identical fraction/sum
fixture. It writes `build/compiler-probe/comparison.json`; this is a feasibility
probe, not a general performance or package compatibility benchmark.
