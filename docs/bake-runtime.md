# Temporal data at runtime

PR36 adds fixed-topology vertex samples. The importer and TeX authoring format
are described in [temporal-samples.md](temporal-samples.md).

## What is stored

A bake declares seconds, strictly increasing sample times, the exact mesh
topology, mesh units, channel units, a seed and solver provenance. Each channel
is scalar, vector or absolute position. Samples are split into contiguous
chunks with declared lengths and SHA-256 hashes. Chunk bytes use IEEE
little-endian float32 or float64 in frame, channel, vertex, component order.

The topology check compares revision, vertex count and every ordered triangle
index. Matching array lengths alone is insufficient. Position-channel units
must equal the mesh units. No implicit unit conversion takes place.

Stored precision describes the input bytes. Interpolation uses float64 and
captured mesh attributes retain that precision. A visualization may amplify
or map those values afterward; it does not rewrite the imported source.

## Synchronous sampling

```ts
import {prepareInlineBake} from 'texloom';

const bake = prepareInlineBake(inlineManifest);
const value = bake.sample(1.25);
const {left, right, alpha, sourceTime} = value.bracket;
const scalars = value.channels.temperature.values;
```

Every inline chunk is authenticated and checked for finite values before the
sampler is returned. External chunks raise `BAKE_NOT_READY`; synchronous
sampling never starts network requests. All returned values are immutable.

Linear interpolation selects the two surrounding stored times. Exact knots
return the stored sample with `left === right` and `alpha === 0`. Step mode
selects the latest sample at or before the requested time. Outside the stored
interval, the manifest explicitly selects clamping or an error. Frame rate,
playback direction and previous sample calls do not affect selection.

## Selective external prefetch

```ts
import {createBakeStore} from 'texloom';

const store = createBakeStore(externalManifest, {
  resolver: async (chunk, {signal}) => {
    // The host resolves an allowed URI and selects exactly byteLength bytes.
    // For byteRange sources, return the selected range, not the whole file.
    return readSelectedChunkBytes(chunk, signal);
  },
});

await store.prefetch(1.25, abortController.signal);
const frame = store.sample(1.25);
const loading = store.status();
store.dispose();
```

`prefetch(t)` requests only the chunks needed for that time's bracket.
Concurrent requests for a chunk share transport. Cancelling one subscriber
does not cancel another subscriber's request. When all subscribers leave,
transport is aborted; late replies cannot repopulate a detached request.

`sample(t)` raises `BAKE_NOT_READY` if any required chunk is unavailable. It
never returns an earlier frame as though it represented the requested time.
Status reports missing, loading, ready, failed or disposed states and the
individual chunk states. A failed chunk can be retried explicitly by prefetch.

`prefetchAll()` verifies all chunks, and `materialize()` returns a portable
inline manifest only when all chunks are ready. `dispose()` and its alias
`release()` are idempotent and release cached bytes. The initial profile uses
a bounded cache without eviction.

## Scene integration

The evaluation order is:

```text
surfaces → curves → mesh attributes → sampled fields
         → field visualization → instances → space3d
```

`Bundle.bakes` holds manifests; `Bundle.sampledFields` maps their channels to
new named vertex attributes and optionally replaces absolute positions.
Normal handling is explicit. A field visualization can select
`scalar: {attribute: 'raw-scalar'}` or `vector: {attribute: 'raw-vector'}`.
These selectors require matching vertex attribute types and do not evaluate
the original solver again.

`prepareScene()` accepts inline data. `prepareSceneAsync()` and
`beginPrepareScene()` accept a separate `bakeResolver` alongside the existing
JSON resource `assetResolver`. Scene preparation eagerly verifies **all**
chunks before publishing `ready`, keeping ordinary scene sampling synchronous.
Selective loading is exposed by the bake store API above; this version does
not stream missing chunks during a synchronous render call.

Consumer capabilities are checked before transport. Cancellation and failure
dispose pending stores, and no partially prepared scene is published. The
scene manifest exposes sample times, channel declarations and solver metadata
without exposing chunk transport payloads or URIs.

The packaging CLI keeps inline chunks for inline packages, writes
content-addressed binary files for external packages, and assigns exact byte
ranges in a shared binary file for packed packages. JSON mesh assets retain
their separate transport contract.

## Limits and scientific meaning

Each scene supports at most 16 bake manifests and 64 MiB of aggregate declared
binary payload. Each bake supports at most 256 chunks, 4096 time samples,
65536 vertices and 32 channels. A sampled-field program supports at most 16
operations and 65536 total processed vertices.
The existing mesh attribute limits also apply: at most 32 named attributes
and 262144 attribute components per output mesh, including inherited values.

Variable topology, checkpoint replay and solver execution are outside this
profile. Linear interpolation has its own approximation error, separate from
stored numeric precision and the original solver error. The demo imports
analytic reference samples; PR37 separately validates a manifold-wave model.
