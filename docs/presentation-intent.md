# Presentation intent (PR28)

Presentation is optional consumer metadata over the existing mathematical scene.
TeX typesetting, editable geometry, transforms, resource identity and cameras remain
the same for SVG, the clean Canvas player and Chalkspace. Sampling is pure; it does
not emit sound, advance a pen, append masks or mutate the geometry.

## Authoring and capture

Load `texloom-presentation` and declare one literal program in the source:

```tex
\loompresentation{
{"version":1,"seed":28,"events":[
 {"kind":"draw","id":"write-rule","target":"rule",
  "start":1,"end":2,"mode":"stroke","tool":"chalk"},
 {"kind":"erase","id":"wipe-rule","targets":["rule"],
  "start":4,"end":5,"tool":"eraser"}
]}
}
```

The verbatim body supports multiline JSON and is not expanded as TeX. Capture
archives the exact declaration under `presentation-sources/program.json`, supplies
source spans, and uses the shared TypeScript validator before publishing a bundle.
Duplicate declarations, JSON keys and nonfinite literals fail. See the executable
`examples/presentation-intent.tex` for CM Bright text, native TikZ curves, a direction
mark, erase targets and explanation cues.

## Version 1 contract

`Bundle.presentation = {version: 1, seed: uint32, events: [...]}`.

| Event | Required fields | Optional fields |
|---|---|---|
| Draw | `kind: "draw", id, target, start, end, mode` | `pathId, tool, contact, sourceSpan` |
| Erase | `kind: "erase", id, targets, start, end` | `tool, sourceSpan` |

- Times are source seconds with `0 <= start <= end <= duration`. IDs are stable
  and unique. At most 4,096 events and 65,536 target references are accepted.
- `stroke` requires a line or one editable path contour. `pathId` names that
  contour; it is not a lookup into an arbitrary SVG or a recovered handwriting stroke.
- `glyph-outline` requires a TeX node. Chalkspace reveals its actual typeset ink
  with a left-to-right sweep. This **does not reconstruct handwriting order**.
- `fill` supports editable paths, ellipses and points. It is a visual fill reveal.
- Tool defaults are `chalk`/`eraser`; `none` suppresses the physical tool. Draw
  contact can be `continuous` or `none`. These are consumer hints.
- Each target has at most one draw and one subsequent erase in this version.
  An erase can target already visible native ink without a preceding draw event.
  Group-level erasure and repeated write/erase cycles need a later contract.

`frame.presentation` contains the authored events with phase, normalized progress
and event seed, plus per-target draw/erase state, local/world bounds, world matrix,
native stroke prefix and contact pose. World coordinates never include a camera.
The original nodes/resources are not recolored or overwritten by presentation.

## Consumer boundary

The clean SVG/Canvas renderers may ignore the optional hints. Chalkspace consumes
them through the per-leaf `CanvasOptions.paintNode(node, ctx, drawNative)` hook.
The hook runs inside the native node transform/clip and group opacity hierarchy.
`drawNative(ctx, {strokePrefix})` paints a partial native line/path using the same
paint rules; it suppresses the unfinished terminal arrow. Full progress uses the
original native painter. The hook must be synchronous and keep its work bounded.

The lecture adapter passes clip ID, frame, placement, resolved timing and an exact
scene-world-to-host-pixel projection. This includes the native camera, rounded
backing extent and host board camera once. Consumers must not reapply them.

Chalkspace owns pigment, target masks, the shared zigzag erase tool, fades, smooth
tool poses and the recorded sound palette. Its strong grain modulates existing ink
alpha in local coordinates; the mathematics and TeX outline positions stay fixed.
Erase masks affect only the listed leaves. Unrelated overlapping ink remains.

## Sound and export

`SceneClip.mapInterval` clips a source interval to the active host interval and
maps it with the same offset/rate as sampling. `lecture.intentSchedule()` exposes
those intervals; held frames never extend sound contact. Consumers can sample
contact without drawing or dispatching an event.

Chalkspace bakes one effects track from pure contact controls. Random sample
variation uses the program seed, clip ID and event ID. Audio cache identity includes
the native payload and renderer inputs. Seeking adjusts the existing audio cursor;
it never appends another contact sound. Video capture hashes the presentation
renderer alongside the remaining runtime inputs.

## Verification

- Core tests: strict schema, lifecycle boundaries, zero duration, reverse seeks,
  geometry/parent transforms, source spans and deterministic seeds.
- Adapter tests: trimmed source intervals, independent rates, held clips, copies
  of schedules and scene/board camera composition.
- Real Chromium: native pass-through pixels with group opacity/clipping, prefix
  painting without mutation or premature arrowheads, projection precision.
- Real TeX: CM Bright resources, editable PGF paths and captured presentation.
- Chalkspace tests: material masks, target-only erase, pure contact controls,
  deterministic effects, rate/offset handling and export audio.

Run `python tools/verify-port.py` for the Texloom gate. The companion Chalkspace
gate builds `examples/presentation-intent.yaml` and exports the erase interval.
