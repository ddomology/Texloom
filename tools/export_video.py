"""Sample the same browser evaluator at exact times and encode an MP4.

Requires playwright (with Chromium) and FFmpeg; no TeX execution at export time.
"""
from __future__ import annotations
import argparse
import json
import math
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlencode
from playwright.sync_api import sync_playwright


def export(player: Path, output: Path, fps: int, width: int | None, height: int | None,
           duration: float | None, still: float | None) -> dict:
    if fps < 1 or fps > 120:
        raise ValueError('fps must be between 1 and 120')
    if width is not None and (width < 2 or width % 2):
        raise ValueError('width must be a positive even integer >= 2')
    if height is not None and (height < 2 or height % 2):
        raise ValueError('height must be a positive even integer >= 2')
    output.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': width or 960, 'height': height or 540},
                                device_scale_factor=1, reduced_motion='reduce')
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(player.resolve().as_uri() + '?' + urlencode({'capture': '1'}), wait_until='load')
        page.wait_for_function('Boolean(window.texloom && typeof window.texloom.render === "function")')
        page.evaluate('async () => { await window.texloom.ready; }')
        meta = page.evaluate('({duration: window.texloom.bundle.duration, viewport: window.texloom.bundle.viewport})')
        width = width or int(meta['viewport']['width'])
        height = height or int(meta['viewport']['height'])
        if width % 2 or height % 2:
            raise ValueError('MP4 capture dimensions must be even')
        page.set_viewport_size({'width': width, 'height': height})
        duration = meta['duration'] if duration is None else duration
        if not math.isfinite(duration) or duration <= 0 or duration > meta['duration']:
            raise ValueError('duration must be positive and within scene duration')
        stage = page.locator('#stage')
        page.add_style_tag(content='html,body{margin:0!important;padding:0!important;overflow:hidden!important} #stage{width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;border-radius:0!important;border:0!important} #stage svg{display:block;width:100%;height:100%;}')

        def sample(t: float) -> bytes:
            page.evaluate('async (t) => { await window.texloom.render(t); }', t)
            return stage.screenshot(type='png', animations='disabled')

        if still is not None:
            if not math.isfinite(still) or not 0 <= still <= meta['duration']:
                raise ValueError('still time is outside scene duration')
            output.write_bytes(sample(still))
            browser.close()
            if errors: raise RuntimeError('; '.join(errors))
            return {'output': str(output), 'time': still, 'width': width, 'height': height}

        frames = math.ceil(duration * fps)
        temporary = output.with_name(output.stem + '.partial.mp4')
        command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe',
                   '-vcodec', 'png', '-framerate', str(fps), '-i', '-', '-an', '-c:v', 'libx264',
                   '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(temporary)]
        with tempfile.TemporaryFile() as log:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=log,
                                       creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            try:
                for frame in range(frames):
                    process.stdin.write(sample(frame / fps))
                    if frame % (fps * 2) == 0:
                        print(json.dumps({'frame': frame, 'frames': frames, 'time': frame/fps}), flush=True)
                process.stdin.close()
                code = process.wait(timeout=120)
                log.seek(0)
                if code:
                    raise RuntimeError(log.read().decode('utf8', 'replace'))
                if errors:
                    raise RuntimeError('; '.join(errors))
                temporary.replace(output)
            except Exception:
                process.kill()
                process.wait()
                raise
            finally:
                browser.close()
    return {'output': str(output), 'fps': fps, 'frames': frames, 'duration': frames/fps,
            'width': width, 'height': height, 'timeSelection': 'frameIndex / fps',
            'renderer': 'same SVG player and shared evaluator', 'audio': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('player', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--fps', type=int, default=30)
    parser.add_argument('--width', type=int)
    parser.add_argument('--height', type=int)
    parser.add_argument('--duration', type=float)
    parser.add_argument('--still', type=float)
    args = parser.parse_args()
    result = export(args.player, args.out, args.fps, args.width, args.height, args.duration, args.still)
    args.out.with_suffix(args.out.suffix + '.json').write_text(json.dumps(result, indent=2), encoding='utf8')
    print(json.dumps(result), flush=True)
