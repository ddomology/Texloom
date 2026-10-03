# Lemniro figure integration (PR25)

`texloom/lemniro` exposes a browser adapter for a registered static-site figure.
Lemniro owns document layout, React controls, visibility and accessibility.
Texloom owns package validation, resource preparation and deterministic SVG
frames. The deployed reader needs no TeX installation.

## Registration and preparation

```ts
import {prepareLemniroFigure, type LemniroFigureReference} from 'texloom/lemniro';

const figure: LemniroFigureReference = {
  contract: 'texloom-figure/1', id: 'circle-and-sine',
  manifestPath: 'texloom/circle-and-sine/scene.json',
  manifestSha256: '…64 lowercase hexadecimal characters…',
  posterPath: 'texloom/circle-and-sine/poster.svg',
  title: 'A circle becomes a sine wave',
  description: 'A moving point and its vertical projection have the same height.',
  width: 720, height: 450, duration: 8,
};
const controller = new AbortController();
const runtime = await prepareLemniroFigure(figure, {
  baseUrl: new URL('/Lemniro/', location.origin),
  instanceId: 'note-figure-1', signal: controller.signal,
});
const svg = runtime.render(2);
const frame = runtime.sample(2); // Same common evaluated frame as other consumers.
runtime.dispose();             // Or abort the controller, including after ready.
```

`validateLemniroFigureReference` and `assertLemniroFigureReference` are shared
by the publishing pipeline and browser. Registrations are plain JSON with an
explicit version; unknown fields, getters, invalid dimensions and nonportable
paths fail. IDs start with a lowercase letter and contain lowercase letters,
digits and hyphens, with a maximum of 64 characters. Paths use ASCII letters,
digits, dots, underscores, hyphens and slashes, with no empty, `.` or `..`
segments. Reference title/description are plain text, never HTML.

The adapter snapshots the registration, options and base URL before waiting.
The caller supplies an instance ID beginning with an ASCII letter and containing
letters, digits, underscores or hyphens. Repeated figures must use different IDs
to isolate SVG definitions. Each preparation owns an independent runtime and
asset store; disposing one figure leaves other figures usable.

The returned runtime has `ready` or `disposed` state. `render` and `sample` are
synchronous and perform no fetching. Calls after disposal fail. The adapter
does not schedule animation frames, observe visibility or retain DOM elements.

## Static-host transport contract

- `baseUrl` is an absolute HTTP(S) directory, including any deployment prefix.
  Same-origin relative manifest and asset paths must stay within that prefix.
  Credentials in URLs, query strings, fragments and redirects are rejected.
- The caller may inject `fetch` for another HTTP host or for testing. Requests
  use `redirect: 'error'`, `credentials: 'same-origin'` and cancellation signals.
- Raw manifest bytes must match the registered SHA-256 before JSON parsing.
  Registered viewport/duration must match before resource fetching starts.
- Manifest reads are bounded to 4 MiB, each resource to 16 MiB and the private
  store to 64 MiB. Streaming response bytes are counted even without a declared
  Content-Length. Failure or cancellation cancels pending body reads.
- Inline and external resources use the PR24 checks for exact byte length,
  SHA-256, resource kind/bounds, hydrated scene validity and SVG capabilities.
- Packed assets require an exact HTTP `206 Content-Range`. A server returning
  the whole file with `200` is rejected by this adapter. Use the default unpacked
  output on static hosts whose range behavior has not been verified.
- Web Crypto requires HTTPS or a supported localhost environment. A local
  `file:` URL is not a supported deployment for this fetch adapter.

`LemniroFigureError` includes a stable `code` and immutable diagnostic array.
Errors from package preparation retain their existing asset/runtime diagnostics.
The host should preserve the poster and offer retry when preparation fails.

## Author once, publish with a note

The paired Lemniro implementation registers references in `content/scenes.json`.
A note includes a complete block with `\LemniroScene{circle-and-sine}`. Its
compiler verifies local package bytes before publication, emits sanitized HTML
plus ordered figure references, and rejects unknown or nested placeholders.
TeX authors do not supply a script, iframe URL or executable component.

The server renders a real poster image and descriptive caption. Client code
loads near the viewport, uses a unique namespace per occurrence, and adds native
play/pause, reset, time and speed controls. Initial playback is paused. Reduced
motion keeps the poster until explicit interaction. Offscreen/hidden figures
pause and do not automatically resume. Unmount aborts preparation and disposes
the runtime, animation frame, observers and event handlers. PDF output can use
an optional static poster PDF; the same note remains readable without scripts.

The React component, TeX macro and note compiler live in the Lemniro repository.
Because Texloom is private and Lemniro is public, the site uses a vendored npm
archive containing compiled runtime ES modules and generated type declarations.
It includes no TypeScript implementations, TeX tools, tests, source maps or
private documentation. The package remains private; it is not an npm release.

From a clean, committed Texloom checkout, create the distributable in an empty
directory, then pack it with npm:

```sh
node tools/build-lemniro-package.mjs build/lemniro-package
npm pack ./build/lemniro-package --pack-destination build
```

`provenance.json` records the exact source commit, generator/tool versions and
hashes of every generated module and declaration. Lemniro stores that provenance
beside its vendored archive; `package-lock.json` pins the archive integrity.
Public site builds therefore require no private repository credentials. Future
updates regenerate the archive from a new reviewed commit. Next consumes the
`texloom` package without copying adapter implementation into site components.

Rebuild the actual integration scene from this checkout:

```sh
python tools/build.py examples/asset-lifecycle.tex --out build/asset-lifecycle
node tools/package-scene.mjs build/asset-lifecycle/bundle.json --out build/asset-lifecycle/package
npm run snapshot -- build/asset-lifecycle/bundle.json build/asset-lifecycle/package/poster.svg 6
```

Publish the generated package directory to the site's `public/texloom/<id>/`,
register the returned manifest digest and dimensions, and supply an informative
caption. Keep the source and provenance alongside the package for reproduction.
TeX input is trusted repository source; asset validation is not a TeX sandbox.

## Acceptance evidence

`tests/lemniro-figure.test.ts` covers namespace independence and synchronous-frame
parity, deployment prefixes, snapshot isolation, input/transport rejection,
integrity failures, exact packed ranges, stream budgets, aborts before/during/
after preparation and late responses from a fetch implementation that ignores
its signal. Existing compiler/runtime/raster regressions remain unchanged.

The paired site gate must additionally exercise three figures in an actual
exported note: lazy loading, independent seeking, mobile resize, native keyboard
controls, reduced motion, no-JavaScript posters, error fallback, document and
viewport visibility, SPA navigation/re-entry and unmount during pending fetch.
Verify frame geometry against the original compiler bundle, not a reconstruction
of the published assets. Inspect the compiled PDF's static figures separately.

This milestone provides a 2D SVG lecture-note consumer. Parameter editors, shared
cross-figure clocks, general simulations and Chalkspace lecture scheduling are
separate milestones.
