# Importing external time samples

PR36 imports finite scalar, vector and position samples attached to a fixed mesh
vertex domain. The importer serializes supplied data; it does not execute a
solver. The checked-in example is an analytic sample producer, not a PDE result.

## Input JSON and deterministic import

Run from the repository root:

```sh
python tools/import_samples.py examples/data/temporal-samples/samples.json --out build/imported-samples --chunk-frames 2
python tools/compile.py examples/temporal-samples.tex --out build/temporal-samples
node tools/build-gpu-player.mjs build/temporal-samples/bundle.json build/temporal-samples/player.html
```

The output directory must be new. All validation and encoding complete before
one staged directory is renamed into place; existing output is preserved. Use
another output directory for a repeat import. Identical input bytes and options
produce identical manifests, chunks and import reports.

Input has exactly these fields:

```json
{
  "version": 1,
  "units": "m",
  "topology": {"revision":"triangle-v1", "vertexCount":3, "indices":[0,1,2]},
  "interpolation": "linear",
  "outside": "clamp",
  "seed": 36,
  "solver": {"name":"external-producer", "version":"1", "parameters":{}},
  "channels": [
    {"id":"height", "kind":"scalar", "componentType":"float64", "unit":"1"}
  ],
  "frames": [
    {"time":0, "values":{"height":[0,1,0]}},
    {"time":0.75, "values":{"height":[1,0,1]}}
  ]
}
```

- `units` is `unit`, `m`, `cm` or `mm`. Mesh coordinates are in that unit;
  no conversion is implicit.
- Topology includes the exact ordered triangle indices and revision. Same
  counts with rewired indices are a mismatch. Frames cannot change topology.
- Times are finite seconds, strictly increasing, and may be nonuniform or
  start before zero. A single sample is allowed.
- Every frame contains exactly the declared channel IDs. Values are flat
  vertex-order arrays: one component for `scalar`, three for `vector` or
  `position`. Position channel units must equal mesh units.
- Stored components are IEEE `float32` or `float64`. Nonfinite values and
  float32 overflow are errors; float32 values are rounded once when encoded.
  Temporal interpolation uses decoded values in float64.
- `interpolation` is `linear` or `step`; `outside` is `clamp` or `error`.
  These policies are independent of the scene player's own time interval.
- `seed` is an explicit uint32 provenance value. Importing and sampling do not
  randomize values. `solver` describes the producer; its parameters are finite
  plain JSON, and no code is invoked from this metadata.

Input is bounded by 64 MiB, JSON depth 128 and one million JSON values; there
are at most 4096 samples, 65536 vertices, 32 channels, 256 chunks and 64 MiB of
decoded chunk bytes. Index arrays have at most 262144 components. Channel IDs
are safe unique literal identifiers of at most 256 characters. Unknown fields,
duplicate keys, missing channels and malformed counts are rejected.

## Chunk byte layout and hashes

The importer writes `manifest.json`, `chunk-000.bin`, …, and
`import-report.json`. Each chunk contains **frames, then declared channels,
then vertices, then components**, in that order. Every component is
little-endian. There are no headers, time columns, alignment padding or implicit
compression. Channels may use different component types in the same frame.

`byteLength` and lowercase SHA-256 refer to the exact selected chunk payload.
The manifest carries the time array and contiguous sample-index ranges for the
chunks. A bracket may span two chunks. `import-report.json` records the original
input hash and manifest hash; the manifest hash is over UTF-8 JSON with sorted
keys, compact separators, Unicode retained and one final newline. It is a hash
of emitted bytes, not a claim that all JSON number serializers are identical.

External manifests may also refer to a packed local file with an explicit
`byteRange:{offset,length}`. The compiler selects exactly that range and then
checks byte length and hash. It never assumes the full file is the payload.

## TeX authoring and portable publication

```tex
\usepackage{texloom-samples}
\usepackage{texloom-field}
\loombake{samples}{data/bake/manifest.json}
\loomsampledfield{sample}|{
  "source":"mesh", "resourceId":"sampled", "bake":"samples", "units":"m",
  "attributes":[{"channel":"height", "name":"raw-height"}]
}|
\loomfieldvisualization{color}|{
  "source":"sampled", "resourceId":"colored", "units":"m",
  "scalar":{"attribute":"raw-height"}, "invalidPolicy":"error",
  "color":{
    "attribute":"color", "stops":[
      {"position":0,"color":[0,0,1]}, {"position":1,"color":[1,0,0]}
    ],
    "range":{"mode":"fixed","min":0,"max":1},
    "outOfRange":"clamp", "invalidColor":[0.2,0.2,0.2]
  }
}|
```

The source mesh must already exist and match the bake topology and units. Scalar
and vector channels become explicit vertex attributes. Optional position input
uses `position:{channel,normalPolicy,degenerateNormalPolicy}`; normals are
explicitly dropped or recomputed, with declared error/source fallback behavior.
The sampled-field stage runs before field visualization. Raw channel values
survive color mapping and are not re-evaluated on the moved positions.

The native compiler supports bounded local relative paths using ordinary
letters, digits, underscores, dots, hyphens and `/`. It rejects absolute paths,
dot segments, URL schemes and files resolving outside the source directory (or
outside a manifest's directory for chunks). No network request occurs. Inline
canonical base64 and local external chunks are verified and copied into inline
`Bundle.bakes`, so the standalone player needs no file server. Runtime transport
adapters can separately use external/packed packages.

Original declaration bodies, manifests and selected binary chunks are archived
under `bake-sources/`, with source spans and hashes in
`bundle.provenance.sampledFieldCapture`. A failed compilation removes the stale
published bundle. The source JSON used by an upstream producer is not implied
by a manifest: retain it separately when it is needed for an independent oracle.

## Example and evidence

`examples/data/temporal-samples/generate.py` creates a fixed outward-oriented
114-vertex sphere, analytic scalar/vector/position arrays and these time knots:

`0, 0.5, 1.75, 3, 4.5, 6.25, 8`.

The original data lives in `samples.json`; four external chunks contain two,
two, two and one frames. Regeneration requires a new directory:

```sh
python examples/data/temporal-samples/generate.py --out build/new-analytic-input
```

At time 1.125 the displayed value is the linear blend of the 0.5 and 1.75
samples. It intentionally differs from evaluating the producer's cosine at
1.125. Tests compare all scalar/vector components and positions against original
JSON, cover knots and chunk boundaries, check exact resulting bounds and native
GPU colors, repeat reverse seeks, compare 30/60 fps histories, and operate the
mobile time/speed controls. This establishes the declared sample interpolation
contract, not PDE accuracy or behavior between spatial vertices.
