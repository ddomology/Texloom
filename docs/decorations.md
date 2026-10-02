# PR 15 — Path decorations and braces

Decorations generate ordinary editable path geometry. A source path remains
available for sampling, labels and intersections while another path displays its
ticks, marks, repeated symbols or snake. SVG and Canvas use the existing path
renderers; there is no browser-only decoration effect.

## TeX authoring

Declare the source and output paths first, then load `texloom-decorations`:

```tex
\usepackage{texloom-decorations}

\loomdecorate[mode=ticks,spacing=20,phase=10,size=6]{ticks}{
  {"path":"source"}
}
\loomdecorate[mode=snake,spacing=40,amplitude=5,resolution=16]{wave}{
  {"path":"source","phase":"time/1s*4bp"}
}
\loomdecorate[mode=symbols,spacing=30,symbol-scale=0.8]{copies}{
  {"path":"source","symbol":"small-chevron"}
}
\loombrace[amplitude=12,aspect=.5,offset=4]{brace}{
  {"from":[30,180],"to":[270,180]}
}
```

The final argument is literal JSON. These commands must appear directly in the
scene, outside another macro's argument, because capture uses a verbatim argument.
The output must be an existing editable path. Its authored style and parent are
retained. Reading that same output as a geometry source creates a dependency cycle
and is rejected. Use a separate output path.

Loading the package without a declaration changes no bundle behavior.

### Decoration options

| Option | Default | Meaning |
| --- | --- | --- |
| `mode` | `ticks` | `ticks`, `marks`, `snake`, or `symbols` |
| `space` | `scene` | `scene`, `local:node`, `parent:node`, or `plot:group` |
| `id` | `decoration:<target>` | Unique operation ID |
| `spacing` | `20` | Positive lattice spacing or snake wavelength, bp |
| `phase` | `0` | Lattice phase, bp |
| `origin` | `0` | Explicit offset of this path in the original distance domain, bp |
| `start-margin` | `0` | Nonnegative excluded distance at the start, bp |
| `end-margin` | `0` | Nonnegative excluded distance at the end, bp |
| `offset` | `0` | Signed offset along the path's 2D normal, bp |
| `size` | `6` | Tick/mark size, bp |
| `orientation` | `tangent` | Tick/mark/symbol frame: `tangent`, `fixed`, or `reverse` |
| `corners` | `following` | `following`, `skip`, or `error` |
| `cusps` | `error` | `error` or `skip` |
| `max-samples` | `2048` | Integer generation budget, 1–2048 |
| `tolerance` | `.05` | Positive path length/inversion tolerance, bp |
| `amplitude` | `5` | Snake normal displacement amplitude, bp; snake only |
| `resolution` | `16` | Integer samples per wavelength, 4–128; snake only |
| `symbol-scale` | `1` | Positive dimensionless symbol scale; symbols only |

Numeric options accept literal decimals such as `.5`, without TeX unit suffixes.
Put dynamic expressions in JSON. JSON uses the corresponding runtime camelCase
socket names: `startMargin`, `endMargin`, `maxSamples`, and `symbolScale`; other
names stay the same. An option and JSON socket cannot specify the same value.

Each numeric socket accepts a finite number, a scalar expression string,
`{"node":"P","property":"r"}`, or
`{"operation":"earlier","socket":"value"}`. Geometric distances use bp.
`resolution`, `maxSamples`, `symbolScale`, and enum sockets use unit `1`.
JSON enum values are `orientation: 0=tangent, 1=fixed, 2=reverse`,
`corners: 0=following, 1=skip, 2=error`, and `cusps: 0=error, 1=skip`.
The TeX `mode` option selects the operation profile and is static.

```tex
\loomdecorate[mode=ticks]{ticks}{
  {"path":"source",
   "spacing":"20bp + 4bp*sin(time/1s*1rad)",
   "size":{"node":"size-control","property":"r"}}
}
```

### Paths, symbols and spaces

A path node ID reads its current geometry and transforms it into the operation's
declared space. A bare graph output reference is already in that exact space.
To convert an output from another space, include an explicit space:

```json
{"path":{"operation":"curve:trimmed","socket":"path","space":"local:source"}}
```

The frontend inserts a `transformPath` operation for that conversion and another
conversion into the output node's local coordinates before its geometry binding.
Type checking rejects mismatched spaces; coordinates are not silently relabeled.

For `mode=symbols`, a symbol node ID reads **local geometry**. Its authored node
translation, rotation, scale and parents do not place the copies. The symbol's
local origin is the attachment point; its x axis is the forward axis. Copy
orientation and `symbolScale` place that geometry along the path. Symbols are
geometry templates: their paint is not copied. The target path supplies paint.

A symbol graph output must specify its space explicitly, for example:

```json
{"path":"source",
 "symbol":{"operation":"shape:chevron:path","socket":"path","space":"local:template"}}
```

Spacing, margins, offsets and tolerance are measured in the operation's chosen
coordinate space. A later nonuniform transform changes the displayed distances;
these are not fixed screen pixels.

Ticks are centered normal segments of length `size`. Marks are chevrons with
local vertices `(-size/2,-size/2)`, `(0,0)`, `(-size/2,size/2)`; the middle vertex
is the attachment point. Tangent orientation aligns the local x axis to the
forward path tangent, fixed orientation keeps the chosen space's axes, and
reverse orientation reverses the tangent frame.

## Distance, phase and endpoints

Regular placements use absolute integer lattice indices `k`:

```text
d = phase + k * spacing - origin
```

Only samples inside the margin interval are retained. An open path can include
both endpoints. A closed contour excludes the sample at total length so its seam
is not duplicated. Indices are tied to the lattice, not to the current number of
visible copies. This makes clipping by margins and moving phase deterministic.

If a path was trimmed, its zero distance normally starts at the new beginning.
Pass the original start distance as `origin` to retain the previous lattice
phase. This is explicit authoring data; the decoration does not infer a distance
origin from arbitrary upstream operations.

The initial profile accepts one open or closed contour. It does not connect
disconnected contours. At corners, `following` uses the outgoing direction;
`skip` omits the affected sample, and `error` reports it. A cusp with no unique
usable direction must be rejected or skipped according to `cusps`. Skipping a
snake sample splits its generated polyline instead of bridging the gap.

The snake samples sinusoidal normal displacement with a step derived from
`spacing/resolution`. Its output is a polyline. `tolerance` controls path sampling,
not a certified bound on that sinusoidal approximation. A closed path does not
force the last wave value to meet its first: wavelength and phase remain authored.
There is no random displacement or hidden seed in this version.

## Braces

`\loombrace` is an independent endpoint construction. It accepts `from` and `to`
as point node IDs, `[x,y]`, point output references, point expressions such as
`{"expression":"vec2(20bp,40bp)"}`, or the inline anchor form from
[connectors](connectors.md). Its numeric options and JSON sockets are
`amplitude` (12 bp), `aspect` (.5), and `offset` (0 bp).

The brace uses four cubic bends and up to two straight shoulders in the frame from
`from` toward `to`.
`aspect` selects the cusp's fractional position along that span; `amplitude`
sets its signed height and `offset` moves the baseline along the normal. Require
`0 < aspect < 1`; reversing endpoints reverses the normal. It does not
follow an arbitrary curved input path. Its default ID is `brace:<target>`.

## Runtime and reproducibility

The frontend emits `decoratePath@1`, `repeatPathSymbols@1`, or `bracePath@1`.
The first two expose a `path` output and a scalar `count`; braces expose `path`.
The output
path can feed later operations through an explicit graph output reference.
The same dependency plan handles live scalar expressions, property inputs and
geometry animation before generating decoration geometry.

The core `createPathDecoration(path, options, symbol?)` returns generated geometry
and a report with `kind`, `totalLength`, `candidateCount`, `emittedCount`,
`skippedIds`, `sampleIds`, and `representation` (`exact` or `polyline`). The core
API uses named policies (`corner`, `cusp`); graph inputs use numeric enum sockets
(`corners`, `cusps`). `createBraceGeometry(from, to, options)` returns a path.

Each absolute-time sample starts from authored data. Reverse seeking has no
previous-frame state or placement cache. Unsupported geometry, undefined frames,
invalid sizes and exceeded budgets produce diagnostics instead of truncating
the output silently.

Original JSON and exact decoded expression text are archived in deterministic
`decoration-sources/` paths. Their source spans point to those archived contents,
including nested point expressions in brace anchors. The existing connector
capture helper retains its default source locations.

## Reference and verification

The [PGF/TikZ decoration manual](https://tikz.dev/library-decorations) provides
the semantic reference for repeated path markings and local frames. Tests execute
native PGF markings on a slanted line and compare their actual placement matrices
with generated ticks. Independent tests check sine samples, brace endpoints,
symbol-local geometry, phase/origin and reverse sampling. This is an original,
bounded implementation; it does not import PGF code or claim general decoration
library compatibility.

```sh
python -m unittest tests.decoration_compiler_test -v
python tools/verify-port.py
```
