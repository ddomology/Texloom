# Live paths implementation record

2026-10-02 · Texloom 0.3 · M1.1 and the reveal/point/direction part of M1.2

## Delivered

- Actual PGF soft-path execution/capture, retained native TeX/DVI/SVG reference.
- Typed multi-contour line/cubic geometry and stable control-coordinate tracks.
- Exact evaluation/splitting and cubic bounds; bounded local arc length.
- Parameter/length reveal and point sampling; world tangent/normal relations.
- One evaluated frame consumed by SVG, native Canvas and the Chalkspace board
  placement adapter. No per-renderer path mathematics or independent clock.
- Twelve-second TeX example with reveal, changing controls, moving point,
  tangent, normal, marker fade and transformed parent group.

Source: `examples/living-paths.tex`. Build instructions and authoring syntax are
in `tex/README-v03.md` and `docs/runtime-contract.md`.

## Verification

| Check | Result |
| --- | --- |
| TypeScript type check | Passed |
| TypeScript tests | 73 passed, including 21 kernel and 8 integration tests |
| Real TeX/compiler tests | 26 passed, including 11 new PGF path tests |
| PGF original versus captured native curve | 195 edge pixels differ out of 518,400; mean channel difference 0.000886/255, maximum 44/255 |
| SVG/native Canvas at nine reveal/deformation times | At most 2 pixels differ, maximum channel difference 1/255 |
| Reverse seek, source immutability and stable topology | Passed |
| Existing orbit, node/anchor and scalar-field Canvas cases | Passed within established raster thresholds |
| Player controls, SVG download, mobile overflow | Passed |
| Same-time player versus exported SVG | Pixel exact |
| Native PGF resource importer comparison | All nine resources within established edge-AA tolerance |
| Video | H.264, 1280×720, 30 fps, 360 frames, 12 seconds, no audio |

Detailed browser outputs: [shared renderer report](m1-browser-verification.json)
and [path report](m1-path-verification.json). PGF soft coordinates and the final
DVI driver each round units, so the PGF comparison is not claimed pixel exact.
Numeric tests separately check analytic positions, derivatives, bounds,
length inversion, closure, degeneracies and transformed directions.

The local 960×540 sample+Canvas timing was 1.5 ms median / 3.5 ms p95 over 40
samples. This is a small-scene observation on this machine, not a performance
guarantee for arbitrary scenes or hardware.

## Remaining scope

Intersection branch/missing policies, actual consumer scheduler/export-cache
hooks and Lemniro React mounting remain in M1. This demo uses the real
Chalkspace board material with a Texloom Canvas layer; it does not install
the layer in existing lessons or recover chalk handwriting. M2 animation
composition, M3 math objects, M4 3D and M5 simulations remain future work.

Native path capture is an explicit geometry subset. Extra drawing statements,
embedded text and unrepresented paint/clip changes fail instead of disappearing.
Use static artwork wrappers for broader TikZ appearance. Topology-changing
morphs and automatically inferred package-level semantic dependencies are not
implemented.
