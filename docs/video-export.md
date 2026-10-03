# Exact-time video export (PR27)

The scene evaluator remains independent of playback. Video frames use an integer
index, not accumulated wall-clock time. The standalone player exporter is the
uncached reference path; Chalkspace's paired exporter can additionally reuse a
verified capture key. The two tools preserve their existing rendering styles.

## Standalone Texloom player

```sh
python tools/export_video.py build/demo/player.html --out build/demo/clip.mp4 --start 0.1 --duration 2 --fps 60 --width 1280 --height 720
python tools/export_video.py build/demo/player.html --out build/demo/frame.png --still 0.5 --width 1280 --height 720
```

`--start` is the absolute source time; `--duration` is the selected interval
length. Without duration, export ends at scene duration. A still uses its
absolute `--still` time, including the endpoint; a zero-duration scene can be
captured at zero. Preparation, optional playback pause, font readiness and any
asynchronous renderer result are awaited before screenshot capture.

The GPU player from `tools/build-gpu-player.mjs` uses the same export command.
Its bridge exposes a renderer label and explicit output sizing; the manifest
records `WebGL2 + native TeX Canvas` instead of `SVG`. Camera, geometry and
projected native labels are evaluated at every exact source time. This requires
WebGL2 support in the capture browser; rendering errors stop the export.

The clock interprets numeric inputs as their decimal values and calculates
`start + frameIndex / fps` with rational arithmetic, converting once to a
JavaScript number at the capture boundary. Video samples belong to the half-open
interval `[start, start + duration)`. Frame count is the exact ceiling of
`duration * fps`; for example start `0.1`, duration `0.2`, and 30 fps produce
exactly six frames. Common 30/60 fps instants are equal, including with an offset.
Invalid or unrepresentable intervals and more than one million frames are
rejected. Supported integer rates are 1–120 fps.

A fractional final frame yields encoded duration `frameCount / fps`, up to one
frame longer than the requested duration. This is recorded as padding; the
exporter never adds a sample at the exclusive end. Input player SHA-256,
dimensions, quality, rational clock, each sample's time and image hash, and
measurement totals are written into the CLI's `.mp4.json` sidecar. `export()`
returns this same metadata to Python callers. A render or encoding failure
preserves the prior video output. This exporter has no audio.

## Chalkspace capture contract

The paired Chalkspace PR implements an awaited `capture(t, options)` against the
actual lecture renderer and exposes `--fps` / `--no-frame-cache` in video export.
Input revision, renderer version, dimensions, quality, guides and native clip
time enter the capture key. The default cache holds one serialized image;
`cache: false` remains the direct reference path. Different active source times
have distinct keys, and stable held/hidden intervals can reuse an image.
Readiness errors, render failures, resize, disposal and rendering outside capture
cannot publish a stale cached image.

The host's manifest records `lessonTime = start + frameIndex / fps` and native
clip source times returned by the common clip clock. Audio selection and trim
use the same requested lesson interval; fractional final-frame padding is silent.
An unchanged image does not imply unchanged lesson metadata or audio time.

## Acceptance and measurements

Acceptance compares raw capture bytes/pixels before lossy MP4 encoding: cache
enabled versus disabled, common 30/60 fps times, repeated and reverse captures,
quality/dimension/revision changes and clip boundaries. A six-second lecture
fixture has static lead/tail intervals around a moving native TeX diagram,
with no row motion to hide a frozen scene. The full Hausdorff lecture separately
checks placement, source offsets and camera movement.

Reports separate render/evaluation wall time, image serialization or screenshot
wall time, pipe writes, FFmpeg final wait, and audio assembly. Browser RPC and
capture overhead are identified as such. FFmpeg runs concurrently with frame
production, so its total pipeline wall time is not isolated encoding CPU time.
Only measured static intervals support a cache-performance claim.
