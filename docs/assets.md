# Portable resources and scene preparation

PR24 separates compiled scene structure from native vector and scalar-field
resource payloads. The same compiled bundle can remain inline or become a
portable package. Both routes produce the same evaluated frames; resource
delivery is complete before a prepared scene can be sampled.

## Build a package

```sh
python tools/build.py examples/asset-lifecycle.tex --out build/asset-lifecycle
python tools/package-scene.py build/asset-lifecycle/bundle.json --out build/asset-lifecycle/package
python tools/package-scene.py build/asset-lifecycle/bundle.json --out build/asset-lifecycle/inline --inline
python tools/package-scene.py build/asset-lifecycle/bundle.json --out build/asset-lifecycle/packed --packed
```

The builder validates the complete bundle and its operation plan before
publishing `scene.json`. It does not execute TeX or download anything. The
inventory includes every resource, including hidden and currently unused ones.
The default layout is:

```text
package/
  scene.json
  assets/<payload-sha256>.json
```

Each resource payload is `JSON.stringify(resource)` followed by one newline,
encoded as UTF-8. Its SHA-256 and `byteLength` describe these exact bytes. Key
insertion order inside resources is preserved because native text revisions
depend on it. Identical serialized bytes share one file. Repeating a build with
the same input and key order produces identical output; semantically equivalent
objects with different key order are not promised to deduplicate.

`--inline` embeds those same payload strings. `--packed` concatenates unique
payloads in hash order into one hash-addressed `.bin` file, with a byte range per
entry. Payload hashes still describe individual slices. The manifest is written
last; failure before publication preserves an existing manifest. Older hash
files are retained when reusing an output directory.

## Manifest contract

```ts
type ScenePackage = {
  contract: 'texloom-package/1';
  scene: Omit<Bundle, 'resources'>;
  assets: {
    version: 1;
    requiredFeatures: string[];
    entries: Array<{
      id: string;
      kind: 'vector' | 'scalar-field';
      mediaType: 'application/vnd.texloom.resource+json';
      byteLength: number;
      sha256: string;
      bounds: [number, number, number, number];
      source:
        | {kind: 'inline'; data: string}
        | {kind: 'external'; uri: string;
           byteRange?: {offset: number; length: number}};
    }>;
  };
};
```

The builder uses the full bundle's `sceneFeatures` result. Vector bounds are the
native `inkBounds`; scalar fields use normalized `[0,0,1,1]` bounds. The store
checks the descriptor, exact size, SHA-256, JSON payload, resource type and
bounds. Hydration then validates the full bundle, feature inventory and plan.

## Prepare, sample and release

```ts
import {beginPrepareScene, createAssetStore, SVG_2D_PROFILE} from 'texloom';

const store = createAssetStore({resolver: hostResolver});
const left = beginPrepareScene(scenePackage, {assetStore: store,
  profile: SVG_2D_PROFILE});
const right = beginPrepareScene(scenePackage, {assetStore: store});

// left.state is preparing; no partially prepared runtime is exposed.
const [a, b] = await Promise.all([left.ready, right.ready]);
const frame = a.sample(2, {phase: 0});
a.dispose();                    // b still works and holds its own leases.
const other = b.sample(2, {phase: Math.PI / 2});
b.dispose();                    // Last leases release their stored resources.
store.dispose();                // Host-owned store; idempotent.
```

`beginPrepareScene` returns a handle immediately, including on malformed input.
Its state is `preparing`, `ready`, `failed` or `disposed`; errors arrive through
`ready` and the handle's `error`. Calling `dispose()` while preparing cancels
that consumer, and calling it after readiness releases that runtime. Calls are
idempotent. A disposed runtime rejects subsequent sampling and capability
checks; already returned frames remain usable. Resources are immutable and
shared, while each frame's nodes and camera remain independently editable.

`prepareSceneAsync(input, options)` is the promise-only alternative. Both accept
an `AbortSignal` whose abort also disposes an already ready scene. Use either
`assetResolver` or a shared `assetStore`, not both. A supplied store remains
host-owned. Without one, a package preparation creates and later disposes its
own store. Existing synchronous `prepareScene(Bundle)` remains available.

The asynchronous input snapshot uses `validateAssetJson`: a maximum of one
million JSON values and depth 128. This bound also applies to its inline bundle
input; the existing synchronous route is unchanged. The default store budgets
are 16 MiB per resource and 64 MiB total reserved payload bytes. Hosts may supply
explicit limits when creating a store.
Manifests contain at most 4096 entries and 256 distinct required feature names.
Declared unsupported features fail before asset I/O; features discovered after
hydration must also be declared and supported by the selected renderer profile.

## Host delivery and byte ranges

There is no default network resolver. The host decides which URIs it accepts,
how they map to files or requests, and how credentials and transport failures
are handled.

```ts
type AssetResolver = (
  entry: DeepReadonly<AssetEntry>,
  options: {signal: AbortSignal}
) => Promise<Uint8Array | ArrayBuffer>;
```

The resolver must return exactly the resource payload bytes. For a packed entry
it selects the declared range itself; the store does not slice a second time.
An HTTP host may request `Range: bytes=offset-end`, verify a `206 Content-Range`,
or explicitly slice a complete `200` body. It must honor cancellation when
possible. The store checks integrity after resolution. SHA-256 uses Web Crypto;
browser deployments need a host that provides `crypto.subtle` (normally HTTPS
or localhost; the tested Chromium file preview also provides it). Transport
adapters should bound response sizes while reading; the store validates the
completed buffer against its declared size.

The shared cache identity includes hash, byte length, type, media type and
bounds, and excludes resource ID and URI. Concurrent compatible consumers share
the same load and immutable Resource object. Canceling one waiter does not
cancel another. When the last waiter or lease disappears, pending work is
aborted and the entry is removed. The store does not retain an unbounded idle
cache. `store.stats()` reports entries, pending, ready, waiters, leases,
reservedBytes and disposed for host diagnostics.

## Run the teaching demo

```sh
node tools/build-asset-demo.mjs build/asset-lifecycle/bundle.json build/asset-lifecycle/index.html
python -m http.server 8000 --directory build/asset-lifecycle
```

The two views connect circular motion to a sine wave. They reuse native TeX
labels and share one store, while keeping separate time and phase controls.
Load, cancel, release and reload are visible operations. An explicitly labeled
850 ms delay makes loading cancellation easy to try.

Opening `index.html` directly also works: its host resolver reads an embedded
map containing the exact external-package bytes. It does not use browser
`file:` fetching. Served over HTTP, the same page resolves the external asset
files with `fetch`; the embedded map is unused. All three manifest variants are
linked from the page. A production HTTP host can omit the preview's offline map.

```sh
python tools/export_video.py build/asset-lifecycle/index.html --out build/asset-lifecycle/demo.mp4 --fps 30 --width 720 --height 450
```

The capture bridge waits for package preparation and samples the same prepared
runtime at `frameIndex / fps`; View A is captured without the surrounding
controls. No second inline evaluator is created for the video.

This release covers resource delivery, validation, cancellation, shared leases
and disposal. Renderer-owned Canvas/GPU caches, service-worker storage, browser
object URLs and application framework components have separate lifecycles and
are not claimed here.
