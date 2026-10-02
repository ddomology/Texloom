# Porting contracts and regression baselines

PR 01 establishes a reviewable baseline for the existing Texloom 0.1–0.3
compiler, evaluator, and renderers. Each later logical port has a machine-readable
PortSpec describing the original behavior being considered and the behavior that
Texloom actually promises. The current contract is
[`v03-baseline.json`](v03-baseline.json).

## Setup

Run from the Texloom repository root. The gate needs Node 22+, Python 3.11+,
the lockfile-installed Node dependencies, and the pinned browser/image packages:

```sh
npm ci
python -m pip install -r requirements-port.txt
python -m playwright install chromium
```

`requirements-port.txt` pins Playwright 1.63.0 and Pillow 12.3.0. Install the
Chromium build belonging to that Playwright version; an arbitrary system browser
is not the recorded raster profile. Full compilation additionally needs
`latex`, `dvisvgm`, and `kpsewhich` on `PATH`, PGF, AMS math, Latin Modern fonts
and a usable `latex.fmt`. For Ubuntu:

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends texlive-latex-extra texlive-fonts-recommended lmodern dvisvgm
python -m playwright install --with-deps chromium
```

The gate uses only this checkout. No sibling Chalkspace repository, prebuilt
demo directory, Manim/Blender installation or FFmpeg is required. Committed
scalar samples are used as fixture inputs; do not regenerate them as an
unrecorded setup step.

## Run the checks

For the complete source-to-renderer gate:

```sh
python tools/verify-port.py
```

This normal verification command:

1. Validates active PortSpecs, registered inputs, reference inventory and hashes.
2. Compiles all four TeX scenes twice and compares their canonical semantic
   bundles, retaining node order, geometry, TeX metrics and resource contents.
3. Compares current bundles and evaluated observations with committed references,
   including repeated/reverse-time seeks and checks that inputs/prior frames
   remain unchanged.
4. Compares current SVG rasters with historical PNGs, and current SVG with native
   Canvas using the separately declared tolerances.
5. Runs the TypeScript typecheck, all `tests/*.test.ts` tests and all Python
   `tests/*_test.py` tests.

It never updates approved references when a comparison fails. Checks fail fast,
so a failed early fixture may prevent later fixtures and tests from running;
inspect `report.json` and logs for the completed evidence. The registry
[`../../tests/fixtures/ports/suite.json`](../../tests/fixtures/ports/suite.json)
defines inputs, sample times and tolerances; committed bundles, observations,
SVGs, PNGs and toolchain evidence live under `tests/fixtures/ports/reference/`.
Missing required inputs, tools or reference artifacts fail verification.

For runtime work without a TeX installation:

```sh
python tools/verify-port.py --runtime-only
```

This reads the committed compiler bundles, then checks current runtime
observations, reverse seeking, historical PNG regression and SVG/Canvas parity.
It also runs the TypeScript typecheck, all TypeScript tests and
`tests/port_verifier_test.py`. It does not rebuild TeX, prove repeated
compilation, run the compiler Python suites, or create fixture players.

For a fast contract-only check:

```sh
python tools/verify-port.py --spec-only
```

This validates PortSpec metadata, fixture definitions and registered input
paths. It does not check approved artifact hashes, run the compiler/runtime,
launch a browser or run tests. Python's standard library is sufficient for
this mode; it does not establish geometry or visual equivalence.

For a deliberate baseline change:

```sh
python tools/verify-port.py --record --reason "Explain the intended change and its evidence"
```

`--record` requires a nonempty reason and a full source build; it cannot be
combined with `--runtime-only`. It writes reference artifacts only after every
fixture, renderer parity check and test passes. Recording intentionally replaces
historical expectations, so it cannot also establish agreement with those old
expectations. Review the resulting diff, input/toolchain records and affected
figures before merging. A passing newly recorded baseline is not independent
proof that a changed algorithm is correct. CI never uses `--record`.

## Reports and review artifacts

Every invocation writes a run directory under `build/port-verification/`.
`latest.json` contains its success flag and the path to its `report.json`.
The report records the mode, completed checks and any error; full/runtime runs
also record source/dependency/toolchain information and comparison results.

| Artifact | Contents |
| --- | --- |
| `run-*/report.json` | Overall status, completed fixtures, comparison metrics, toolchain drift, test status when reached, and failure message. |
| `run-*/toolchain.json` | Observed Node/Python/package/browser versions, implementation hashes, and TeX/font details in full mode. |
| `run-*/logs/*.log` | Compiler, observation, typecheck and test subprocess output for steps reached. |
| `run-*/<fixture>/bundle.json`, `observations.json` | Canonical compiler result and sampled runtime state. |
| `run-*/<fixture>/frame-*.svg`, `frame-*.png`, `canvas-*.png` | Current evaluated SVGs and both renderer rasters. Frame indices follow fixture sample-time order. |
| `run-*/<fixture>/first/`, `repeat/`, `build-provenance.json` | Full-mode compilation outputs and retained nonsemantic provenance. |
| `run-*/<fixture>/player.html` | Self-contained player, created after a full-mode fixture's comparisons pass. |

Artifacts depend on how far the invocation progressed; a missing player after
an early failure is not a passed visual review. To investigate a failure, start
with `report.json`, identify its fixture/time or subprocess log, then compare
the current figure against the corresponding committed reference. Keep the
original failure report when reviewing an intentional baseline migration.

## Continuous integration

The workflow
[`../../.github/workflows/port-regression.yml`](../../.github/workflows/port-regression.yml)
defines two independent Ubuntu 24.04 jobs on pull requests, pushes to `main`,
and manual dispatch:

- **Frozen-bundle runtime and raster regression:** Node 22, Python 3.11,
  `npm ci`, pinned Python packages, Chromium with Linux dependencies, and
  `python tools/verify-port.py --runtime-only`.
- **TeX compilation and full regression:** the same setup plus the Ubuntu TeX
  packages above, then `python tools/verify-port.py`.

Both jobs upload `build/port-verification/` with `if: always()`, using separate
artifact names and 14-day retention. If dependency installation fails before
the verifier starts, GitHub's step log is the available evidence; there may be
no report to upload. Neither job is allowed to record a new baseline or ignore
a failed comparison.

The Linux TeX distribution may differ from the machine that recorded the
reference. The report exposes that drift and keeps the same tolerances. A
cross-platform failure needs investigation or a reviewed toolchain migration;
do not widen tolerances or refresh references automatically. Workflow YAML
defines these gates; only an actual successful Actions run establishes that
they pass on the hosted runner.

## Registered scenes

| Fixture ID | Source | Contract exercised |
| --- | --- | --- |
| `orbit` | `examples/orbit.tex` | v0.1 animated ellipse, attached label, tangent, camera, typeset resources and native TikZ art. |
| `commutative` | `examples/commutative.tex` | v0.2 measured PGF anchors, nested transforms, live connections, arrowheads and labels. |
| `living-paths` | `examples/living-paths.tex` | v0.3 PGF soft-path capture, changing cubic controls, geometric reveal, path point, tangent and normal. |
| `scalar-field` | `examples/field.tex` and `examples/data/wave-grid.json` | External row-major scalar samples and linear temporal interpolation. The data is an analytical standing wave on a square. |

These are regression cases, not a coverage claim for every input accepted by
TikZ, Manim or Blender. Existing focused compiler/runtime unit tests remain
necessary for malformed input, singular transforms, degenerate curves, and other
boundaries not visible in these four scenes. The scalar fixture does not verify
a numerical PDE solver or a wave on a curved manifold.

## What is being compared

Keep the following evidence separate in both reports and review:

1. **Historical Texloom regression.** Current semantic objects and sampled
   coordinates are compared with an explicitly approved baseline. Stored
   artifacts have hashes so accidental edits are visible. Input and source
   hashes identify what was tested.
2. **Repetition and random access.** The same input/toolchain must reproduce the
   same semantic output, including repeated and reverse-time samples. This
   alone cannot detect a deterministic but incorrect algorithm change.
3. **Current renderer agreement.** SVG and Canvas consume the same evaluated
   frame. Compare raster outputs within the fixture's declared tolerance.
   Agreement between two current renderers is not historical visual regression
   and is not an upstream oracle.
4. **Original PGF evidence.** Where a retained PGF resource is compared with
   captured live geometry, the PGF output came from the installed TeX toolchain.
   Its version/provenance must be recorded. It is separate from the pinned
   source revision consulted for the PortSpec.
5. **Independent numerical evidence.** Analytic ellipse relationships, cubic
   geometry, or interpolation expectations can check mathematical behavior.
   Reusing the implementation under test to produce every expected value is
   not an independent numerical check.

Reports must name which of these were run. Do not infer an unrun category from
another passing category. Concrete thresholds belong to the fixture registry;
do not loosen them globally to accommodate a single changed scene.

## Toolchains and portability

The manifest records exact tools used locally, including relevant TeX/PGF,
font/format inputs, Node/Python dependencies and browser versions when available.
Source-code reference revisions are a different record: installing TeX Live
does not imply its PGF equals the Git revision in `upstream`.

Semantic normalization must be explicit. Compile directories, elapsed times,
absolute machine paths and DVI timestamp-bearing provenance may differ without
changing a scene. Exclude only declared nonsemantic data from semantic hashes;
retain that data in the provenance report. Node order, resource paint order,
glyph outlines, measured widths/heights/depths, anchors, transforms, tracks,
geometry and scalar samples are not disposable metadata.

A portable scene contract is not a promise of identical bytes from every TeX
distribution. Font outlines, TeX metrics, PGF driver conversion and browser
antialiasing can change with the toolchain. Record that difference explicitly.
If an approved comparison fails, inspect whether it is an engine regression or
a toolchain migration; do not silently accept it or automatically replace the
golden. An approved toolchain migration includes its manifest, artifact diff,
visual review and reason. Fixed source input plus two matching runs on the new
machine proves local repeatability, not equivalence to the old baseline.

## Authoring a PortSpec

Copy [`port-spec.template.json`](port-spec.template.json), give it a new `id`,
and replace every placeholder. The template is documentation and is excluded
from the active spec list. An active spec must contain:

| Field | Required meaning |
| --- | --- |
| `schemaVersion`, `id`, `title` | Format version and stable contract identity. |
| `implementation` | Implementation approach, supported profiles, and explicit exclusions. |
| `upstream[]` | Project, immutable 40-character commit, file, symbols, documentation, reference role, and license review status/note. |
| `contract` | Inputs, outputs, coordinate/unit conventions, and failure/approximation rules. |
| `fixtures[]` | IDs registered by the executable fixture manifest. |
| `verification` | Reproduction command, claims the checks establish, and claims they do not establish. |

Missing source revisions fail validation. A branch such as `main`, a moving
documentation URL, or a release name alone does not replace the commit. Verify
that the named file and symbols exist at that revision. Fixture IDs must resolve;
do not use a free-form demo title in place of a registered fixture.

For a new logical port, state the actual domain precisely: parameter versus arc
length, local versus world space, mutable versus immutable values, stable IDs,
degeneracies, numerical budget, error behavior and observable output. Add a
reference case for the supported subset and a negative/boundary case where the
semantics differ. `review-required` is an honest license status for a consulted
reference; it does not authorize copying source. A PR that copies or adapts
upstream code must separately complete file-level license/notice review.

## Current evidence boundary

`v03-baseline.json` pins PGF soft-path, Manim vector-object and Blender dependency
evaluation source locations. Their files and named symbols have been checked.
PGF describes the protocol consumed through the installed TeX toolchain. Manim
and Blender are design references for later ports. This PR does not execute
Manim/Blender reference programs, import their complete test suites, or establish
algorithmic equivalence to either project. It introduces no upstream source-code
copy. Those claims require dedicated executable reference cases in later PRs.

The current runtime contract is documented in
[`../ir-contract.md`](../ir-contract.md) and
[`../runtime-contract.md`](../runtime-contract.md). This directory covers the
PR 01 baseline and future executable port contracts; the implementation remains
the existing 2D runtime.
