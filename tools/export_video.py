"""Sample the same browser evaluator at exact times and encode an MP4.

Requires playwright (with Chromium) and FFmpeg; no TeX execution at export time.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
from time import perf_counter
from urllib.parse import urlencode
from playwright.sync_api import sync_playwright
from export_timing import FrameSchedule, seconds


def export(player: Path, output: Path, fps: int, width: int | None, height: int | None,
           duration: float | None, still: float | None, *, start: float = 0) -> dict:
    if isinstance(fps, bool) or not isinstance(fps, int) or not 1 <= fps <= 120:
        raise ValueError('fps must be an integer between 1 and 120')
    if width is not None and (isinstance(width, bool) or not isinstance(width, int) or width < 2 or width % 2):
        raise ValueError('width must be a positive even integer >= 2')
    if height is not None and (isinstance(height, bool) or not isinstance(height, int) or height < 2 or height % 2):
        raise ValueError('height must be a positive even integer >= 2')
    seconds(start, 'start')
    output.parent.mkdir(parents=True, exist_ok=True)
    revision = hashlib.sha256(player.read_bytes()).hexdigest()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': width or 960, 'height': height or 540},
                                device_scale_factor=1, reduced_motion='reduce')
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(player.resolve().as_uri() + '?' + urlencode({'capture': '1'}), wait_until='load')
        page.wait_for_function('Boolean(window.texloom && typeof window.texloom.render === "function")')
        page.evaluate('async () => { await window.texloom.ready; window.texloom.pause?.(); await document.fonts.ready; }')
        meta = page.evaluate('({duration: window.texloom.bundle.duration, viewport: window.texloom.bundle.viewport})')
        width = width or int(meta['viewport']['width'])
        height = height or int(meta['viewport']['height'])
        if width < 2 or height < 2 or width % 2 or height % 2:
            raise ValueError('capture dimensions must be even integers >= 2')
        page.set_viewport_size({'width': width, 'height': height})
        stage = page.locator('#stage')
        page.add_style_tag(content='html,body{margin:0!important;padding:0!important;overflow:hidden!important} #stage{width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;border-radius:0!important;border:0!important} #stage svg{display:block;width:100%;height:100%;}')

        measurements = {'renderSeconds': 0.0, 'screenshotSeconds': 0.0,
                        'pipeWriteSeconds': 0.0, 'ffmpegWaitSeconds': 0.0}
        def sample(t: float) -> bytes:
            tick = perf_counter()
            page.evaluate('async (t) => { await window.texloom.render(t); }', t)
            measurements['renderSeconds'] += perf_counter() - tick
            tick = perf_counter()
            image = stage.screenshot(type='png', animations='disabled')
            measurements['screenshotSeconds'] += perf_counter() - tick
            if errors:
                raise RuntimeError('; '.join(errors))
            return image

        if still is not None:
            seconds(still, 'still time')
            if not 0 <= still <= meta['duration']:
                raise ValueError('still time is outside scene duration')
            output.write_bytes(sample(still))
            browser.close()
            if errors: raise RuntimeError('; '.join(errors))
            return {'output': str(output), 'time': still, 'width': width, 'height': height,
                    'inputRevision': revision, 'cache': False, 'measurements': measurements}

        schedule = FrameSchedule.create(start, duration, meta['duration'], fps)
        frames = schedule.frames
        # Unique staging avoids collisions with another export. The old output
        # is replaced only after every frame and the encoder have succeeded.
        handle, filename = tempfile.mkstemp(prefix=output.stem + '-', suffix='.partial.mp4', dir=output.parent)
        import os
        os.close(handle)
        temporary = Path(filename)
        command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe',
                   '-vcodec', 'png', '-framerate', str(fps), '-i', '-', '-an', '-c:v', 'libx264',
                   '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(temporary)]
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=log,
                                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            try:
                records = []
                for frame in range(frames):
                    record = schedule.sample(frame)
                    encoded = sample(record['sourceTime'])
                    record['imageSha256'] = hashlib.sha256(encoded).hexdigest()
                    records.append(record)
                    tick = perf_counter()
                    process.stdin.write(encoded)
                    measurements['pipeWriteSeconds'] += perf_counter() - tick
                    if frame % (fps * 2) == 0:
                        print(json.dumps({'frame': frame, 'frames': frames, 'time': record['sourceTime']}), flush=True)
                process.stdin.close()
                tick = perf_counter()
                code = process.wait(timeout=120)
                measurements['ffmpegWaitSeconds'] += perf_counter() - tick
                log.seek(0)
                if code:
                    raise RuntimeError(log.read().decode('utf8', 'replace'))
                if errors:
                    raise RuntimeError('; '.join(errors))
                temporary.replace(output)
            except Exception:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                raise
            finally:
                if process.stdin and not process.stdin.closed:
                    try:
                        process.stdin.close()
                    except OSError:
                        pass
                browser.close()
                temporary.unlink(missing_ok=True)
    return {'contract': 'texloom-video-export/1', 'output': str(output), **schedule.manifest(),
            'width': width, 'height': height, 'inputRevision': revision,
            'quality': {'renderer': 'SVG', 'capture': 'PNG', 'crf': 18},
            'cache': False, 'capturePolicy': 'fresh evaluation and screenshot for every frame',
            'samples': records, 'measurements': measurements,
            'measurementNotes': 'Render includes browser RPC; screenshots include raster capture and PNG encoding. Pipe writes and final FFmpeg wait are separate wall times, not isolated codec CPU time.',
            'renderer': 'same SVG player and shared evaluator', 'audio': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('player', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--fps', type=int, default=30)
    parser.add_argument('--width', type=int)
    parser.add_argument('--height', type=int)
    parser.add_argument('--duration', type=float)
    parser.add_argument('--start', type=float, default=0, help='Absolute source start; duration is the selected interval length')
    parser.add_argument('--still', type=float)
    args = parser.parse_args()
    result = export(args.player, args.out, args.fps, args.width, args.height, args.duration, args.still, start=args.start)
    args.out.with_suffix(args.out.suffix + '.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result), flush=True)
