# PR 04 — Typed expressions and parameters

Bundle `0.3` can declare a versioned `expressions` program. Explicit expression
bindings compute scene properties from time and typed parameter values. TeX
captures the declarations; the shared TypeScript runtime parses, checks and
evaluates the expression language. SVG and Canvas consume the resulting frame.

## TeX authoring

Load the expression frontend alongside the existing scene package:

```tex
\usepackage{texloom-tikz}
\usepackage{texloom-expressions}
```

Declare a phase parameter and bind a point's scene-space position:

```tex
\loomparameter[type=scalar,unit=rad,min=-6.283185307179586,max=6.283185307179586]{a}{0}
\TLNode{B}{point}{"x":370,"y":320,"r":6,"style":{"fill":"#71DFC2"}}
\loomexpr{B}{position}{vec2(370bp,320bp - 95bp*sin(a + 1rad*time/1s))}
```

The mathematical point is `B=(2,sin(a+ωt))` with `ω=1 rad/s`. The example maps
the mathematical origin to `(180bp,320bp)` and uses `95bp` per coordinate unit.
Its fixed `x=2` therefore becomes `370bp`. Screen +y points down, so the sine
term is subtracted from `320bp`.

`\loomparameter[options]{name}{default}` accepts these options:

| Option | Meaning |
| --- | --- |
| `type` | `scalar` (default), `boolean`, or `vec2`. |
| `unit` | `1`, `bp`, `s`, or `rad`; omitted scalar/vector units are dimensionless. Boolean parameters have no unit. |
| `min`, `max` | Optional inclusive finite bounds for scalar parameters, expressed in their declared unit. |

Defaults are JSON literals, not expression text: `0`, `true`, or `[12,24]`.
Types, finite values, scalar bounds, duplicate names and option names are
checked. A numeric default for a parameter with `unit=rad` is measured in radians.

```tex
\loomparameter[type=boolean]{enabled}{true}
\loomparameter[type=vec2,unit=bp]{offset}{[12,24]}
```

### Literal capture and escaping

The final argument of both commands uses xparse's multiline verbatim (`+v`)
scanner. The expression is literal source text. Write `^`, `&&`, `<`, `>` and
other expression operators directly. Do not use TeX math mode or replace
`sin` with `\sin`. TeX macros inside the expression are not expanded.

Quotes, backslashes, `%`, `#` and `##` survive capture exactly. Preservation
does not make them valid expression syntax: unsupported characters and TeX
commands reach the expression parser and receive a located diagnostic, rather
than breaking JSON or being silently interpreted as TeX comments.

```tex
\loomexpr{B}{style.opacity}{(2^3 >= 8 && true) ? 1 : 0}
\loomexpr{B}{position}{
  vec2(370bp,
    320bp - 95bp*sin(a + 1rad*time/1s))
}
```

Verbatim commands must occur directly in the source. They cannot be placed in
another macro's already-scanned argument, including a wrapper defined to accept
an arbitrary TeX argument and replay it later. A braced verbatim argument must
have balanced braces; an alternate delimiter is also available:

```tex
\loomexpr{B}{position}|vec2(370bp,320bp)|
```

## Portable program shape

The compiler produces explicit parameter metadata and expression strings:

```json
{
  "expressions": {
    "version": 1,
    "parameters": {
      "a": {"type": "scalar", "unit": "rad", "default": 0}
    },
    "bindings": [
      {
        "target": "B",
        "property": "position",
        "expression": "vec2(370bp,320bp - 95bp*sin(a + 1rad*time/1s))"
      }
    ]
  }
}
```

Declarations without expressions retain their existing bundle version and
output shape. Expression declarations promote the compiled bundle to `0.3`.
The existing TikZ geometry and TeX resource pipeline remains in use.

### Archived expression source locations

TeX writes generated filename records to `scene.tl.jsonl`. User expression text
is stored in separate `.body.txt` files; parameter names, options and defaults
also use sidecars. Python reads these files and serializes JSON with its normal
JSON encoder. User text is never inserted raw into a JSON string by TeX.

Bindings carry a `sourceSpan` whose file is the archived expression sidecar,
relative to the output directory containing `bundle.json`, for example
`expression-sources/scene.tl-expression-2.body.txt`. Exact sidecar bytes are
archived under deterministic names; the original files remain in the individual
compilation run directory for provenance. Repeated equivalent compiles therefore
produce the same expression program and source-span paths. Line/column positions are
1-based Unicode-code-point coordinates, with an exclusive end. Multiline
expressions preserve their newlines. These locations describe the actual
captured expression text; they do not pretend to be exact columns of the
original `.tex` command.

## Time, units and scene properties

`time` is absolute scene time in seconds, clamped to the scene's duration by
the scene sampler. Clip hosts convert their clock to source time first. A bare number is dimensionless;
numeric suffixes such as `120bp`, `1s` and `1rad` give explicit units. Write
multiplication explicitly. The phase expression `a + 1rad*time/1s` has angle
units; applying `sin` produces a dimensionless amplitude. Multiplying by `95bp`
then produces a scene-coordinate displacement.

Arithmetic, comparisons, boolean operators, conditionals and function calls are
parsed as a small expression language, with type/unit checks before playback.
It has no JavaScript `eval`, property access or arbitrary executable callback.
Unsupported identifiers, syntax and invalid numeric domains fail explicitly.

### Language reference

| Form | Contract |
| --- | --- |
| `+ - * / ^`, unary `+ -` | Scalar arithmetic; vectors support addition/subtraction, scalar multiplication and scalar division. Use `dot` for vector products. |
| `< <= > >=`, `== !=` | Ordered comparisons take matching scalar dimensions; equality also accepts matching vectors and booleans. |
| `!`, `&&`, logical OR | Boolean-only logic; AND/OR short-circuit. |
| `condition ? yes : no` | Boolean condition; branches must have the same type and dimensions. Only the selected branch is evaluated. |
| `vec2(x,y)` | Two scalars with matching dimensions. |
| `sin(x)`, `cos(x)` | Radians, or dimensionless values interpreted as radians; dimensionless result. |
| `dot(a,b)`, `length(v)`, `normalize(v)` | Dot combines input dimensions; length preserves them; normalization produces a dimensionless vector. |
| `mask(condition,yes,no)`, `if(condition,yes,no)` | Explicit lazy selection with the same typing as a ternary. |

Logical OR is written `||`. Power is right-associative and binds more tightly than unary minus: `-2^2`
means `-(2^2)`, and `2^3^2` means `2^(3^2)`. Dimensional bases require a
compile-time integer exponent. The constants are `pi`, `true`, and `false`.

Division by zero, normalization of the zero vector, non-real powers and
nonfinite results report located errors. For a deliberately excluded domain,
write a guard such as `mask(time > 0s, 10bp*1s/time, 0bp)`. Every branch is
type-checked, including branches that are never evaluated.

Expression angles and runtime rotation properties use radians. Authored TikZ
angle options keep TikZ's degree convention; that compiler boundary does not
silently change expression units. An expression for 90 degrees is
`90*pi/180 * 1rad`.

Bindings use the existing property ownership rules. `position` consumes a
scene-space point; direct coordinate properties such as `x` and `y2` retain
their local-coordinate meaning. An expression cannot compete with a track,
relation or operation binding that owns the same property. Expressions do not
implicitly read the displayed point's current coordinates or infer dependencies
from TeX equations.

## Sampling with parameter overrides

```ts
import {createEvaluator} from './src/index.ts';

const sample = createEvaluator(bundle);
const defaults = sample(0);
const shifted = sample(0, {a: Math.PI / 2});
const later = sample(1.25, {a: 0});
const defaultsAgain = sample(0);
```

Overrides are plain typed values in each parameter's declared unit. They apply
only to that sample; omitted parameters use their declared defaults. Sampling
with an override does not mutate the bundle, defaults, or subsequent calls.
Types, names, bounds and finite values are checked. The evaluator uses absolute
time and parameter values, independent of playback history.

### Standalone player controls

The player adds a Parameters panel only when declarations exist. Bounded scalar
parameters use a range control, other scalars use number inputs, booleans use a
checkbox, and vectors use two number inputs. Editing a value pauses playback
and redraws the current time. Invalid input leaves the last valid frame and
parameter state intact and shows an error.

The browser API accepts the same overrides:

```js
window.texloom.render(0, {a: Math.PI / 2});
```

Explicit API overrides apply to that render without changing the UI controls.
Calling `window.texloom.render(time)` without an override uses the current UI
parameter state. This state is an intentional player convenience; the core
sampler still uses defaults when overrides are omitted. Capture mode hides all
controls. Downloading an SVG saves the current frame; downloading the bundle
retains the authored defaults, not transient UI edits.

## Build the demonstration

```sh
python tools/build.py examples/parameter-sine.tex --out build/parameter-sine --video
```

Open `build/parameter-sine/player.html`. At time zero, change `a` from `0` to
approximately `1.5708 rad`: the point moves from `(2,0)` to approximately `(2,1)`
in the mathematical coordinates. Scrub forwards and backwards, then return to
the same time and parameter to reproduce the same frame.

The scene includes actual TikZ axes, typeset mathematics, a point, its guide
line and attached label driven by explicit typed expressions. The generated
video uses authored parameter defaults unless a caller explicitly supplies
overrides through the sampling API.

## Verification and remaining boundaries

```sh
python -m unittest tests.expression_compiler_test -v
npm run check
npm test
python tools/verify-port.py
```

The compiler tests execute real TeX to check literal/multiline capture,
parameter metadata, shared-validator routing, repeatable expression programs
and exact archived text, and unchanged graph-free outputs.
Core expression/runtime tests cover the language and numerical behavior; the
historical port gate remains required for existing scenes.

This frontend does not parse arbitrary LaTeX formulas into executable programs.
It adds no solver, implicit constraint system, 3D simulation or executable
plugin loader. A typed explicit expression is the runtime declaration; typeset
TeX mathematics remains presentation content unless the author binds it.
