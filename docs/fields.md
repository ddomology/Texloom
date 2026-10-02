# PR 05 — Fields on curve domains

A field evaluates an expression for every element of an explicit geometry
domain. Each evaluation receives the geometry identity, domain identity, stable
element ID, position, index, count and time. Its typed values can drive existing
point nodes through the common scene runtime.

This implementation supports editable path controls and explicitly named curve
samples. `setPosition` changes the domain's working positions. It does not
rewrite the source path geometry; geometry editing is a later stage.

## Build the example

```sh
python tools/build.py examples/curve-fields.tex --out build/curve-fields --video
```

Open `build/curve-fields/player.html`. Thirteen named samples span a real PGF
curve. Hollow markers use a captured original-position field. Filled markers
use a sinusoidally shifted working dataset, grow by element index, and change
color with their current height. The amplitude and phase controls come from the
existing typed parameter interface.

The source curve remains in place. The moving markers demonstrate field
evaluation and consumption, not a deformed curve renderer. Seeking to the same
time and parameters reproduces the same result.

## TeX declarations

```tex
\usepackage{texloom-tikz}
\usepackage{texloom-fields}
```

The fields package also loads the expression frontend. Place commands directly
in the scene source. Their final arguments use the same literal multiline
verbatim scanner as [PR 04 expressions](expressions.md).

### Domain

```tex
\loomdomain{samples}{curve}{curve-sample}{[
  {"id":"left","parameter":0},
  {"id":"middle","parameter":0.5},
  {"id":"right","parameter":1}
]}
```

The arguments are domain ID, editable source-path node ID, domain kind, and a
literal JSON sample array. A `curve-sample` entry has an explicit stable `id` and
a normalized whole-path `parameter` in `[0,1]`. This parameter is not arc-length
percentage. Point-node IDs are specified separately by output bindings.

A control domain derives its elements from the path's actual geometry:

```tex
\loomdomain{controls}{curve}{path-control}{[]}
```

It has one element per start, endpoint or cubic-control slot. A stable element
ID is the JSON serialization of `[contourId, segmentId-or-null, slot]`, with slot
`start`, `c1`, `c2` or `to`. For example, a captured PGF contour's initial point
can have ID `["contour-0",null,"start"]`. Use its escaped JSON string when writing
a binding's `element` value:

```json
{"element":"[\"contour-0\",null,\"start\"]","target":"P0"}
```

Control-domain `parameter` is the ordinal fraction `index/(count-1)` (zero for
a single element). It is not a geometric parameter along the curve. Element IDs
come from declared topology and do not change merely because coordinates move.
Domain compatibility includes source geometry identity, kind and topology.

### Ordered operations

```tex
\loomfield[position=original]{rest}{samples}{capture}{position}
\loomfield{shift}{samples}{setPosition}{position + vec2(0bp,20bp)}
\loomfield{moved}{samples}{evaluate}{position}
\loomfield{radius}{samples}{evaluate}{3bp + 4bp*index/(count-1)}
```

Arguments are output attribute ID, domain ID, operation kind and literal
expression. Optional `position=current` (default) or `position=original`
selects which position the expression's `position` variable sees.

Attribute IDs are unique expression identifiers: `[A-Za-z_][A-Za-z0-9_]*`.
They cannot shadow a declared parameter, built-in function or context variable.
Scene parameters must also avoid field context names such as `position`,
`index`, `count` and `parameter` when a field program is present.

| Operation | Effect |
| --- | --- |
| `capture` | Evaluates a typed attribute snapshot at this point in the operation sequence. |
| `evaluate` | Evaluates a typed attribute using the domain state at this point in the sequence. |
| `setPosition` | Evaluates a `vec2` position field in bp and replaces the domain's working positions for subsequent operations. |

Operations execute in declaration order. A later expression in the same domain
can refer to an earlier operation's attribute by ID. A captured attribute does
not change when a later operation changes working positions:

```tex
\loomfield{before}{samples}{capture}{position}
\loomfield{move}{samples}{setPosition}{position + vec2(0bp,20bp)}
\loomfield{delta}{samples}{evaluate}{position - before}
```

Here every `delta` is `(0bp,20bp)`. Re-evaluating `position` after the move sees
the moved positions. Cross-domain attributes and references to later operations
are rejected rather than paired by coincident array indices.

### Capture lifetime and original geometry

A capture is a snapshot **within one absolute-time evaluation**. Every new time
sample starts again from the prepared scene's authored geometry and that frame's
evaluated geometry. There is no first-playback freeze or temporal field cache.
A capture of current positions can therefore differ between frames if upstream
tracks change the source geometry.

`originalPosition` and `position=original` use the authored local-coordinate
geometry baseline. `position=current` uses working positions initialized from
the current frame's source geometry after upstream track/expression writes.
Subsequent `setPosition` operations change that working dataset. The baseline
and previously captured attributes remain available for the rest of the sample.

Original local coordinates are not a permanently frozen world position. A point
binding still uses the source geometry's current transform chain to place them
in the scene.

## Field expression context

The language and unit rules are shared with the scalar/vector expression engine.

| Variable | Value and units |
| --- | --- |
| `position` | Selected current/original position, `vec2` in source-path-local bp. |
| `originalPosition` | Authored baseline position, `vec2` in source-path-local bp. |
| `index` | Zero-based element index, dimensionless scalar. |
| `count` | Number of elements in the domain, dimensionless scalar. |
| `parameter` | Curve sample parameter or control ordinal fraction, dimensionless. |
| `time` | Absolute scene seconds, using the normal sampler's clamped time. |
| Declared parameters | Values from `Bundle.expressions.parameters`, with their declared types and units. |
| Prior operation IDs | Typed values of earlier operations in the same domain, matched by stable element identity. |

Examples:

```text
position + vec2(0bp,-amplitude*sin(2*pi*1rad*parameter + 1rad*time/1s))
3bp + 4bp*index/(count-1)
(dot(position,vec2(0,1)) - 180bp)/240bp
parameter < 0.5
```

`dot(position,vec2(1,0))` reads the local x coordinate; the corresponding y
coordinate uses `vec2(0,1)`. There is no JavaScript property access syntax.
Expressions must be valid for the declared domain; for example, dividing by
`count-1` needs a domain with more than one element or an explicit conditional.

## Bind attributes to point nodes

```tex
\loomfieldbind{samples}{moved}{position}{[
  {"element":"left","target":"P0"},
  {"element":"middle","target":"P1"},
  {"element":"right","target":"P2"}
]}
\loomfieldbind{samples}{radius}{r}{[
  {"element":"left","target":"P0"},
  {"element":"middle","target":"P1"},
  {"element":"right","target":"P2"}
]}
```

Arguments are domain ID, attribute/operation ID, property and a literal JSON
target array. The target is an existing point-node ID; the `element` is a domain
element ID. IDs are checked explicitly. The binding is not positional array zip.

| Property | Required field value |
| --- | --- |
| `position` | Local-domain `vec2` in bp. |
| `r` | Nonnegative scalar in bp. |
| `style.opacity` | Dimensionless scalar in `[0,1]`. |
| `style.fill` | Dimensionless scalar with an explicit color ramp. |
| `visible` | Boolean. |

Position bindings transform from source-path-local coordinates through its
current world transform, then through the target point's inverse world
transform. This supports differently transformed source and target parents.
The camera is not part of this conversion. Singular required inverses fail.
Other properties retain the target node's normal property meaning.

Whole position ownership includes both x and y. Field bindings cannot compete
with tracks, expressions, relations or graph bindings that write the same
property. Style and position bindings may coexist when their owned slots are
disjoint.

### Color ramps

```tex
\loomfield{height}{samples}{evaluate}{(dot(position,vec2(0,1)) - 180bp)/240bp}
\loomfieldbind[from=71DFC2,to=EE8D82]{samples}{height}{style.fill}{[
  {"element":"left","target":"P0"},
  {"element":"middle","target":"P1"},
  {"element":"right","target":"P2"}
]}
```

The options contain six hexadecimal digits without `#`; the compiler emits
`ramp: {from: '#71DFC2', to: '#EE8D82'}`. The binding clamps the scalar to `[0,1]`
and interpolates encoded sRGB channels. Clamping belongs to this explicit color
binding, so the expression does not need a `clamp` function. Opacity and radius
use their own validity checks rather than this color conversion.

## Bundle, frames and source provenance

The compiler adds `fields: {version: 1, domains, operations, bindings}` to a
Bundle `0.3`. Parameters remain in the existing expression program. Sources
without field declarations keep their previous bundle shape.

The TeX frontend writes generated filename records and literal sidecars. It
does not place user expressions or target JSON directly inside JSON strings.
Operation bodies and binding target arrays are archived byte-for-byte at stable
`field-sources/scene.tl-field-N.*.txt` paths relative to `bundle.json`. Their
source spans use the actual archived text, with 1-based code-point columns and
an exclusive end. Original run artifacts remain available for provenance.

`EvaluatedFrame.fields` exposes the final domain contexts and evaluated
attributes for inspection. The existing renderers consume ordinary evaluated
point-node geometry and styles. They need no separate field evaluator.

## Verification and boundaries

```sh
python -m unittest tests.field_compiler_test -v
npm run check
npm test
python tools/verify-port.py
```

Compiler tests exercise real TeX literal capture, stable IDs, explicit ramp
metadata, rejected malformed JSON/options, reproducible programs/source archives,
shared expression diagnostics and unchanged sources without fields. Runtime
tests separately verify domain identity, attribute snapshots, coordinate
conversion, numerical constraints and deterministic sampling.

PR 05 implements two curve domains and consumers for existing point nodes. It
does not edit the path's control geometry, remesh curves, infer interpolation
between domains, add mesh/surface domains or solve field differential equations.
These need explicit geometry operations and additional contracts.

## Design reference

Blender's [Fields manual](https://docs.blender.org/manual/en/latest/modeling/geometry_nodes/fields.html)
describes evaluation in a geometry/domain context and capturing a value before
later position changes. Those concepts informed this independently implemented
Texloom layer. No Blender code was copied, and this is not a claim of Blender
node or file compatibility.
