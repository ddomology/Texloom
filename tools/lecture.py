"""TeX lecture authoring harness. CLI and Python API share the same operations.

Trusted local TeX is executed with shell escape disabled. Mathematical validity
and spoken equivalence require review; compiler success does not certify either.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

from compile import compile_scene
from lecture_source import capture_lecture, apply_repair, scene_dependencies

ROOT = Path(__file__).resolve().parents[1]
ID = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,127}')


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical(value) -> bytes:
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def save(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=True, indent=2, allow_nan=False) + '\n', encoding='utf8')


def read(path: Path):
    return json.loads(path.read_text(encoding='utf8'))


def inside(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or '\\' in name or Path(name).is_absolute():
        raise ValueError('LECTURE_PATH: expected relative POSIX path')
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError('LECTURE_PATH: path leaves artifact directory')
    return path


def run(args, *, cwd=ROOT, timeout=300):
    result = subprocess.run([str(a) for a in args], cwd=cwd, capture_output=True,
                            text=True, encoding='utf8', errors='replace', timeout=timeout)
    if result.returncode:
        raise ValueError('LECTURE_TOOL: ' + ' '.join(map(str, args[:3])) + '\n' + (result.stdout + result.stderr)[-5000:])
    return result.stdout.strip()


def node(*args):
    return run(['node', ROOT / 'node_modules/tsx/dist/cli.mjs', ROOT / 'tools/lecture_assets.ts', *args])


def capabilities():
    return json.loads(node('capabilities'))


def templates():
    return [{'id': p.stem, 'source': str(p.relative_to(ROOT))} for p in sorted((ROOT / 'examples/lectures').glob('*.tex'))]


def syntax(template):
    choices = {row['id']: ROOT / row['source'] for row in templates()}
    if template not in choices:
        raise ValueError('LECTURE_TEMPLATE: unknown template; query templates first')
    path = choices[template]
    return {'contract': 'texloom-authoring-syntax/1', 'template': template, 'source': path.read_text(encoding='utf8'),
            'package': (ROOT / 'tex/texloom-lecture.sty').read_text(encoding='utf8'),
            'documentation': 'docs/lecture-authoring.md'}


def tex_plain(text):
    return ''.join({'\\': r'\textbackslash{}', '&': r'\&', '%': r'\%', '$': r'\$', '#': r'\#',
                    '_': r'\_', '{': r'\{', '}': r'\}', '~': r'\textasciitilde{}', '^': r'\textasciicircum{}'}.get(c, c) for c in text)


def snapshot_package(root, output):
    """Conservative authored dependency set, including Python-read asset data."""
    result, total = {}, 0
    for path in sorted(root.rglob('*')):
        path = path.resolve()
        if path.is_relative_to(output) or any(part in ('.git', '__pycache__') for part in path.parts):
            continue
        if not path.is_relative_to(root):
            raise ValueError('LECTURE_DEPENDENCY: source package symlink leaves its directory')
        if not path.is_file():
            continue
        total += path.stat().st_size
        if total > 256 * 1024 * 1024 or len(result) >= 10000:
            raise ValueError('LECTURE_BUDGET: keep the authored source package below 256 MiB and 10,000 files')
        result[str(path)] = sha(path)
    return result


def paragraph_source(notes, *, width=640):
    lines = [r'\documentclass{article}', r'\usepackage{texloom}', '\\TLSetup{' + notes['setup'] + '}',
             r'\begin{document}', r'\TLScene{Lecture paragraphs}{660}{480}{1}']
    for block in notes['blocks']:
        identifier = block['id']
        # This is a genuine TeX paragraph box. No TeX-to-HTML token substitutions.
        body = r'\parbox{' + str(width) + r'bp}{\fontsize{19}{27}\selectfont\raggedright ' + block['tex'] + '}'
        lines += ['\\TLText{' + identifier + '-ink}{' + body + '}',
                  '\\TLNode{' + identifier + '}{tex}{' + json.dumps({'resourceId': identifier + '-ink',
                    'x': 4, 'y': 40, 'style': {'fill': '#e9eee5'}}, separators=(',', ':'))[1:-1] + '}']
    return '\n'.join(lines + [r'\end{document}', ''])


def build_lesson(notes, scene_rows):
    associations = {b['id']: [] for b in notes['blocks']}
    for scene in scene_rows:
        associations[scene['block']].append(scene['id'])
    objects, beats, mapping = {}, [], []
    for block in notes['blocks']:
        identifier = block['id']
        title = tex_plain(block['kind'].capitalize() + '. ' + block['title'])
        body = r'\textbf{' + title + r'}\par\smallskip ' + block['tex']
        # Chalkspace executes this same preamble in the consumer TeX build.
        objects[identifier] = {'kind': 'paragraph', 'tex': body, 'width': 5.4 if associations[identifier] else 12.2}
        words = len(block['say'].split())
        duration = round(min(3.8, max(1.4, words / 18)), 3)
        beats.append({'id': identifier, 'say': block['say'], 'focus': identifier,
                      'actions': [{'op': 'write', 'object': identifier, 'duration': duration}],
                      'speech_overlap': min(.65, duration), 'hold': .45})
        mapping.append({'id': identifier, 'kind': block['kind'], 'title': block['title'], 'sceneIds': associations[identifier],
                        'beatId': identifier, 'objectId': identifier, 'say': block['say'], 'sourceSpan': block['sourceSpan']})
    lesson = {'version': 1, 'id': notes['id'], 'title': notes['title'],
              'settings': {'font_size': 30, 'surface': 'chalkboard', 'board_tools': True, 'sound_effects': True,
                           'writing_rhythm': 'flow', 'words_per_minute': 155, 'gap': .3, 'reading_hold': .45},
              'objects': objects, 'beats': beats}
    return lesson, mapping


def web_preview(notes, metrics, scenes, mobile_metrics):
    esc = html.escape
    metrics = {row['id']: row for row in metrics}
    mobile_metrics = {row['id']: row for row in mobile_metrics}
    cards = []
    for block in notes['blocks']:
        row = metrics[block['id']]
        mobile = mobile_metrics[block['id']]
        figures = []
        for scene in scenes:
            if scene['block'] != block['id']:
                continue
            figures.append(f'<figure><iframe loading="lazy" title="{esc(scene["caption"])}" src="scenes/{scene["id"]}/player.html"></iframe>'
                           f'<figcaption>{esc(scene["caption"])}</figcaption></figure>')
        cards.append(f'<article id="{block["id"]}" class="block {block["kind"]}"><div class="eyebrow">{esc(block["kind"])} · {block["id"]}</div>'
                     f'<h2>{esc(block["title"])}</h2><div class="paragraph" tabindex="0" role="region" '
                     f'aria-label="{esc(block["title"])}. Scroll horizontally if needed." '
                     f'style="--paragraph-width:{row["width"]}px;--mobile-paragraph-width:{mobile["width"]}px">'
                     f'<picture><source media="(max-width:650px)" srcset="vectors/mobile/{block["id"]}.svg" '
                     f'width="{mobile["width"]}" height="{mobile["height"]}">'
                     f'<img class="math" src="vectors/{block["id"]}.svg" '
                     f'width="{row["width"]}" height="{row["height"]}" alt="{esc(block["say"])}"></picture></div>'
                     + ('<p class="scroll-hint">Scroll horizontally to read the full formula.</p>' if mobile['overflow'] > 1 else '')
                     + ''.join(figures) + f'<details><summary>Narration &amp; source</summary><p>{esc(block["say"])}</p>'
                     f'<pre>{esc(block["tex"])}</pre></details></article>')
    toc = ''.join(f'<a href="#{b["id"]}">{esc(b["title"])}</a>' for b in notes['blocks'])
    return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + \
        '<title>' + esc(notes['title']) + '</title><style>' + \
        ':root{color-scheme:dark;font-family:Georgia,serif;background:#101c1b;color:#e9eee5}*{box-sizing:border-box}body{margin:0}a{color:#9dd8bf}' + \
        'main{max-width:1050px;margin:auto;padding:64px 24px}header{border-bottom:1px solid #40544b;padding-bottom:32px;margin-bottom:28px}' + \
        'h1{font-size:clamp(32px,5vw,54px);font-weight:normal;line-height:1.1;margin:20px 0}h2{font-size:24px;font-weight:normal;margin:12px 0 24px}' + \
        'p{line-height:1.7}.eyebrow,nav,summary,figcaption,.meta{font:12px/1.6 system-ui,sans-serif}.eyebrow{letter-spacing:.12em;text-transform:uppercase;color:#cbb888}' + \
        '.meta{color:#adbbb2}nav{display:flex;gap:10px 18px;flex-wrap:wrap;margin:24px 0}.block{padding:28px 30px;border:1px solid #344c41;' + \
        'border-radius:12px;background:#172925;margin:18px 0;scroll-margin-top:20px}.theorem,.definition{border-left:3px solid #d9c08a}' + \
        '.paragraph{max-width:100%;overflow-x:auto}.paragraph:focus-visible{outline:2px solid #9dd8bf;outline-offset:4px}' + \
        '.math{display:block;max-width:none;width:var(--paragraph-width);height:auto}.scroll-hint{display:none;font:12px/1.6 system-ui,sans-serif;color:#afc4b6}' + \
        'figure{margin:24px 0 0}iframe{display:block;border:1px solid #3d5449;border-radius:10px;width:100%;height:420px;background:#152723}' + \
        'figcaption{color:#afc4b6;padding:10px 0}details{border-top:1px solid #30483e;margin-top:24px;padding-top:14px}summary{cursor:pointer;color:#abc6b4}' + \
        'pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.6}footer{padding:30px 0;color:#afbeb5}' + \
        '@media(max-width:650px){main{padding:28px 12px}.block{padding:22px 14px}.math{width:var(--mobile-paragraph-width)}.scroll-hint{display:block}iframe{height:300px}}' + \
        '</style><main><header><div class="eyebrow">Texloom · Lecture authoring</div><h1>' + esc(notes['title']) + \
        f'</h1><p class="meta">{len(notes["blocks"])} semantic blocks · executed TeX typography · shared animated scenes</p>' + \
        '<p class="meta">Content review is pending. Captions are schematic where stated. Narration is a paired script; timing is estimated until audio is measured.</p>' + \
        '<nav><a href="sources/notes.tex">TeX source</a><a href="authoring-map.json">Script correspondence</a><a href="report.json">Validation report</a></nav>' + \
        '</header><nav>' + toc + '</nav>' + ''.join(cards) + \
        '<footer class="meta">Text outlines come from native TeX boxes through DVI. Animations use the existing Texloom runtime. No lesson-specific renderer.</footer></main></html>'


def artifact_revision(source_revision, files):
    return hashlib.sha256(canonical({'sourceRevision': source_revision, 'files': files})).hexdigest()


def compile_lecture(source: Path, output: Path) -> dict:
    source, output = source.resolve(), output.resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError('LECTURE_OUTPUT: use a new empty output directory for each immutable build')
    output.mkdir(parents=True, exist_ok=True)
    save(output / 'status.json', {'success': False, 'stage': 'capture'})
    try:
        package_before = snapshot_package(source.parent, output)
        notes = capture_lecture(source, output / '_capture')
        if any(not ID.fullmatch(b['id']) for b in notes['blocks']):
            raise ValueError('LECTURE_ID: unsupported block identifier')
        scene_rows, input_files = [], dict(package_before)
        for index, scene in enumerate(notes['scenes']):
            path = inside(source.parent, scene['file'])
            if path.suffix != '.tex' or not path.is_file():
                raise ValueError('LECTURE_SCENE: scene must name an existing relative .tex source')
            identifier = f'figure-{index + 1}'
            input_files[str(path)] = sha(path)
            folder = output / 'scenes' / identifier
            bundle = compile_scene(path, folder, trace_inputs=True)
            dependencies = scene_dependencies(path, folder, package_root=source.parent)
            if any(package_before.get(name) != value for name, value in dependencies.items()):
                raise ValueError('LECTURE_DEPENDENCY: recorded scene input differs from the source package snapshot')
            run(['node', ROOT / 'tools/build-lecture-player.mjs', folder / 'bundle.json', folder / 'player.html'])
            scene_rows.append({**scene, 'id': identifier, 'file': f'scenes/{identifier}/bundle.json',
                               'duration': bundle['duration'], 'viewport': bundle['viewport']})
        (output / 'sources').mkdir()
        shutil.copyfile(output / '_capture/lecture-sources' / source.name, output / 'sources/notes.tex')
        if sha(output / 'sources/notes.tex') != notes['sourceRevision']:
            raise ValueError('LECTURE_SOURCE_CHANGED: archived source differs from capture')
        paragraph_metrics = {}
        for profile, width in (('desktop', 640), ('mobile', 320)):
            suffix = '' if profile == 'desktop' else '-mobile'
            generated = output / ('sources/paragraphs' + suffix + '.tex')
            paragraph_folder = output / ('paragraphs' + suffix)
            vector_folder = output / ('vectors' if profile == 'desktop' else 'vectors/mobile')
            generated.write_text(paragraph_source(notes, width=width), encoding='utf8')
            compile_scene(generated, paragraph_folder, trace_inputs=True)
            dependencies = scene_dependencies(generated, paragraph_folder, package_root=source.parent)
            if any(Path(name) != generated and package_before.get(name) != value for name, value in dependencies.items()):
                raise ValueError('LECTURE_DEPENDENCY: recorded paragraph input differs from the source package snapshot')
            paragraph_metrics[profile] = json.loads(node('text', paragraph_folder / 'bundle.json', vector_folder))
        lesson, blocks = build_lesson(notes, scene_rows)
        save(output / 'notes.json', notes)
        save(output / 'lesson.json', lesson)
        save(output / 'scene-map.json', scene_rows)
        (output / 'index.html').write_text(web_preview(notes, paragraph_metrics['desktop'], scene_rows, paragraph_metrics['mobile']), encoding='utf8')
        publish = [output / p for p in ('notes.json', 'lesson.json', 'scene-map.json', 'index.html', 'sources/notes.tex',
                                       'sources/paragraphs.tex', 'paragraphs/bundle.json', 'vectors/metrics.json',
                                       'sources/paragraphs-mobile.tex', 'paragraphs-mobile/bundle.json', 'vectors/mobile/metrics.json')]
        publish += sorted((output / 'vectors').rglob('*.svg'))
        for scene in scene_rows:
            publish += [output / scene['file'], output / 'scenes' / scene['id'] / 'player.html']
        files = {p.relative_to(output).as_posix(): sha(p) for p in publish}
        revision = artifact_revision(notes['sourceRevision'], files)
        correspondence = {'contract': 'texloom-authoring-map/1', 'sourceRevision': notes['sourceRevision'],
                          'artifactRevision': revision, 'blocks': blocks, 'setup': notes['setup'],
                          'scenes': {s['id']: {'file': s['file'], 'caption': s['caption']} for s in scene_rows}}
        save(output / 'authoring-map.json', correspondence)
        if package_before != snapshot_package(source.parent, output) or sha(source) != notes['sourceRevision']:
            raise ValueError('LECTURE_SOURCE_CHANGED: source package changed during build')
        manifest = {'contract': 'texloom-authoring-build/1', 'status': 'complete', 'sourceRevision': notes['sourceRevision'],
                    'artifactRevision': revision, 'files': files, 'mapSha256': sha(output / 'authoring-map.json'),
                    'source': str(source), 'inputFiles': input_files, 'packageRoot': str(source.parent),
                    'inputPolicy': 'conservative source-directory snapshot',
                    'manualRepairCount': sum(read(p).get('status') == 'applied' for p in source.parent.glob('.' + source.name + '.repair-*.json'))}
        save(output / 'manifest.json', manifest)
        report = validate_lecture(output)
        save(output / 'report.json', report)
        save(output / 'status.json', {'success': report['renderValidation']['passed'], 'stage': 'complete',
                                     'sourceRevision': notes['sourceRevision'], 'artifactRevision': revision})
        return report
    except Exception as error:
        diagnostic = {'code': getattr(error, 'code', 'LECTURE_BUILD'), 'message': str(error)}
        if source.is_file() and source.stat().st_size <= 2 * 1024 * 1024:
            raw = source.read_bytes()
            text = raw.decode('utf8', errors='replace')
            span = {'file': source.name, 'start': {'line': 1, 'column': 1},
                    'end': {'line': text.count('\n') + 1, 'column': len(text) - text.rfind('\n')},
                    'startOffset': 0, 'endOffset': len(text), 'offsetUnit': 'unicode-code-point', 'precision': 'document'}
            diagnostic['sourceSpan'] = getattr(error, 'sourceSpan', None) or span
            revision = hashlib.sha256(raw).hexdigest()
            save(output / 'status.json', {'success': False, 'stage': 'failed', 'sourceRevision': revision, 'diagnostics': [diagnostic]})
            # Failed builds also have a concrete revision for an LLM repair.
            # Only the failed source and diagnostic are published in this manifest.
            archive = output / 'sources/failed-notes.tex'
            archive.parent.mkdir(exist_ok=True)
            archive.write_bytes(raw)
            files = {p: sha(output / p) for p in ('status.json', 'sources/failed-notes.tex')}
            artifact = artifact_revision(revision, files)
            save(output / 'authoring-map.json', {'contract': 'texloom-authoring-map/1', 'sourceRevision': revision,
                'artifactRevision': artifact, 'blocks': [], 'scenes': {}, 'setup': ''})
            save(output / 'manifest.json', {'contract': 'texloom-authoring-build/1', 'status': 'failed', 'sourceRevision': revision,
                'artifactRevision': artifact, 'files': files, 'mapSha256': sha(output / 'authoring-map.json'),
                'source': str(source), 'inputFiles': {str(source): revision}, 'manualRepairCount': 0})
        else:
            save(output / 'status.json', {'success': False, 'stage': 'failed', 'diagnostics': [diagnostic]})
        raise


def verify_artifacts(output: Path, *, check_inputs=False):
    output = output.resolve()
    manifest = read(output / 'manifest.json')
    if manifest.get('contract') != 'texloom-authoring-build/1':
        raise ValueError('LECTURE_MANIFEST: unsupported contract')
    files = manifest.get('files')
    if not isinstance(files, dict) or not files:
        raise ValueError('LECTURE_MANIFEST: missing files')
    for name, expected in files.items():
        path = inside(output, name)
        if not path.is_file() or sha(path) != expected:
            raise ValueError('LECTURE_STALE_ARTIFACT: ' + name)
    if artifact_revision(manifest['sourceRevision'], files) != manifest['artifactRevision']:
        raise ValueError('LECTURE_STALE_ARTIFACT: manifest revision')
    if sha(output / 'authoring-map.json') != manifest['mapSha256']:
        raise ValueError('LECTURE_STALE_ARTIFACT: authoring-map.json')
    mapping = read(output / 'authoring-map.json')
    if any(mapping.get(k) != manifest.get(k) for k in ('sourceRevision', 'artifactRevision')):
        raise ValueError('LECTURE_STALE_ARTIFACT: correspondence revision')
    if check_inputs:
        if manifest.get('inputPolicy') == 'conservative source-directory snapshot' and snapshot_package(Path(manifest['packageRoot']), output) != manifest['inputFiles']:
            raise ValueError('LECTURE_STALE_SOURCE: source package inventory or contents changed')
        for name, expected in manifest['inputFiles'].items():
            path = Path(name)
            if not path.is_file() or sha(path) != expected:
                raise ValueError('LECTURE_STALE_SOURCE: ' + name)
    return manifest


def validate_lecture(output: Path, *, check_inputs=False):
    manifest = verify_artifacts(output, check_inputs=check_inputs)
    if manifest.get('status') == 'failed':
        return {'contract': 'texloom-authoring-report/1', 'sourceRevision': manifest['sourceRevision'],
                'artifactRevision': manifest['artifactRevision'], 'renderValidation': {'passed': False,
                'diagnostics': read(output / 'status.json')['diagnostics']}, 'mathReview': {'status': 'unresolved'}}
    notes, lesson, mapping = (read(output / p) for p in ('notes.json', 'lesson.json', 'authoring-map.json'))
    errors = []
    expected = [b['id'] for b in notes['blocks']]
    mapped = [b['id'] for b in mapping['blocks']]
    omissions = sorted(set(expected) - set(mapped))
    if mapped != expected or len(mapped) != len(set(mapped)):
        errors.append({'code': 'LECTURE_CORRESPONDENCE', 'message': 'Block mapping is incomplete or duplicated'})
    beats = {b['id']: b for b in lesson['beats']}
    source_blocks = {b['id']: b for b in notes['blocks']}
    if list(beats) != expected or set(lesson['objects']) != set(expected):
        errors.append({'code': 'LECTURE_CORRESPONDENCE', 'message': 'Lesson block order or coverage differs from captured source'})
    for block in mapping['blocks']:
        if block['beatId'] not in beats or block['objectId'] not in lesson['objects']:
            errors.append({'code': 'LECTURE_REFERENCE', 'block': block['id']})
        elif block['id'] not in source_blocks or beats[block['beatId']]['say'] != block['say'] or source_blocks[block['id']]['say'] != block['say']:
            errors.append({'code': 'LECTURE_SCRIPT', 'block': block['id']})
        if block['beatId'] != block['id'] or block['objectId'] != block['id']:
            errors.append({'code': 'LECTURE_REFERENCE', 'block': block['id'], 'message': 'Block, beat and object IDs must agree'})
        if any(scene not in mapping['scenes'] for scene in block['sceneIds']):
            errors.append({'code': 'LECTURE_SCENE_REFERENCE', 'block': block['id']})
    # Bind both responsive layouts to real TeX resources. The narrow variant is
    # re-typeset at the same font size, never a scaled copy of the wide page.
    overflow, mobile_overflow = [], []
    for profile, width, suffix, vectors in (('desktop', 640, '', 'vectors'), ('mobile', 320, '-mobile', 'vectors/mobile')):
        try:
            generated = output / ('sources/paragraphs' + suffix + '.tex')
            if generated.read_text(encoding='utf8') != paragraph_source(notes, width=width):
                raise ValueError('Generated paragraph source differs from the captured blocks or typography profile')
            bundle = read(output / ('paragraphs' + suffix) / 'bundle.json')
            metrics = read(output / vectors / 'metrics.json')
            if [r['id'] for r in metrics] != expected or [n['id'] for n in bundle['nodes']] != expected:
                raise ValueError('Measured paragraph coverage differs from captured blocks')
            for row, native in zip(metrics, bundle['nodes']):
                resource = bundle['resources'][native['resourceId']]
                m, bounds = resource['metrics'], resource['inkBounds']
                ix, iy, iw, ih = bounds
                values = [*bounds, m['width'], m['height'], m['depth'], row['width'], row['height'], row['overflow']]
                if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
                    raise ValueError('Non-finite paragraph geometry')
                measured_width = math.ceil(max(m['width'], ix + iw) - min(0, ix) + 8)
                measured_height = math.ceil(max(m['depth'], iy + ih) - min(-m['height'], iy) + 8)
                if (row['metrics'] != m or row['inkBounds'] != bounds or abs(m['width'] - width) > .01
                    or row['width'] != measured_width or row['height'] != measured_height
                    or abs(row['overflow'] - max(0, iw - m['width'])) > .000001
                    or row['file'] != row['id'] + '.svg' or measured_width <= 0 or measured_height <= 0):
                    raise ValueError('Paragraph metrics differ from the native TeX resource')
                svg = ET.parse(output / vectors / row['file']).getroot()
                if svg.tag != '{http://www.w3.org/2000/svg}svg' or [float(v) for v in svg.attrib['viewBox'].split()] != [0, 0, measured_width, measured_height]:
                    raise ValueError('Paragraph vector viewport differs from measured ink')
                if row['overflow'] > 1:
                    target = overflow if profile == 'desktop' else mobile_overflow
                    target.append({'block': row['id'], 'overflowBp': row['overflow']})
        except (ValueError, KeyError, TypeError, OSError, ET.ParseError) as error:
            errors.append({'code': 'LECTURE_PARAGRAPH_METRICS', 'profile': profile, 'message': str(error)})
    for row in overflow:
        errors.append({'code': 'LECTURE_TEXT_OVERFLOW', **row})
    for path in [output / 'paragraphs/bundle.json', output / 'paragraphs-mobile/bundle.json', *[inside(output, s['file']) for s in mapping['scenes'].values()]]:
        run(['node', ROOT / 'tools/validate-bundle.mjs', path])
    return {'contract': 'texloom-authoring-report/1', 'sourceRevision': manifest['sourceRevision'],
            'artifactRevision': manifest['artifactRevision'], 'renderValidation': {'passed': not errors, 'diagnostics': errors},
            'semanticCoverage': {'expectedBlocks': len(expected), 'mappedBlocks': len(mapped), 'omissions': omissions,
                                 'scope': 'declared block/cue correspondence; no automatic theorem or spoken-equivalence proof'},
            'layout': {'paragraphOverflow': overflow, 'mobileScrollableParagraphs': mobile_overflow,
                       'paragraphProfiles': {'desktop': {'widthBp': 640, 'fontSizePt': 19},
                                             'mobile': {'widthBp': 320, 'fontSizePt': 19, 'overflowPolicy': 'local horizontal scroll'}}, 'overlaps': [],
                       'scope': 'Web paragraphs occupy separate CSS flow boxes; Chalkspace measured overlap audit is separate'},
            'manualRepairCount': manifest['manualRepairCount'],
            'mathReview': {'status': 'unresolved', 'required': 'Independent mathematical and spoken-script review'},
            'timing': {'status': 'estimated', 'source': 'words per minute; actual consumer audit required after audio measurement'}}


def repair_lecture(source, output, request):
    manifest = verify_artifacts(output, check_inputs=True)
    if Path(manifest['source']).resolve() != Path(source).resolve():
        raise ValueError('LECTURE_REPAIR_SOURCE: selected source differs from build input')
    return apply_repair(Path(source), manifest, request)


def consumer_video(output, chalkspace, destination, *, narrate=False, start=0., end=None, fps=30):
    manifest = verify_artifacts(output)
    if manifest.get('status') != 'complete':
        raise ValueError('LECTURE_CONSUMER: a successful compiled lecture is required')
    chalkspace = chalkspace.resolve()
    binary = chalkspace / ('.venv/Scripts/chalkspace.exe' if os.name == 'nt' else '.venv/bin/chalkspace')
    if not binary.is_file():
        raise ValueError('LECTURE_CONSUMER: Chalkspace CLI virtual environment is required')
    destination = destination.resolve()
    plan_dir = destination.parent / (destination.stem + '-plan')
    args = [binary, 'build-authored', output.resolve(), '-o', plan_dir]
    if narrate:
        args += ['--narrate']
    run(args, cwd=chalkspace, timeout=900)
    args = [binary, 'render', plan_dir / 'plan.json', '-o', destination, '--quality', 'medium', '--start', start, '--fps', fps]
    if end is not None:
        args += ['--end', end]
    run(args, cwd=chalkspace, timeout=1800)
    return {'video': str(destination), 'plan': str(plan_dir / 'plan.json'),
            'audit': str(plan_dir / 'authoring-audit.json'), 'narration': 'measured local voice' if narrate else 'estimated silent script'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('capabilities')
    sub.add_parser('templates')
    p = sub.add_parser('syntax'); p.add_argument('template')
    compile_p = sub.add_parser('compile'); compile_p.add_argument('source', type=Path); compile_p.add_argument('--out', required=True, type=Path)
    for name in ('validate', 'preview'):
        p = sub.add_parser(name); p.add_argument('directory', type=Path); p.add_argument('--check-inputs', action='store_true')
    p = sub.add_parser('sample'); p.add_argument('bundle', type=Path); p.add_argument('--time', type=float, default=0); p.add_argument('--out', required=True, type=Path)
    p = sub.add_parser('repair'); p.add_argument('source', type=Path); p.add_argument('--build', required=True, type=Path); p.add_argument('--request', required=True, type=Path)
    p = sub.add_parser('video'); p.add_argument('directory', type=Path); p.add_argument('--chalkspace', required=True, type=Path)
    p.add_argument('--out', required=True, type=Path); p.add_argument('--narrate', action='store_true'); p.add_argument('--start', type=float, default=0)
    p.add_argument('--end', type=float); p.add_argument('--fps', type=int, default=30)
    args = parser.parse_args()
    try:
        if args.command == 'capabilities': result = capabilities()
        elif args.command == 'templates': result = templates()
        elif args.command == 'syntax': result = syntax(args.template)
        elif args.command == 'compile': result = compile_lecture(args.source, args.out)
        elif args.command in ('validate', 'preview'):
            result = validate_lecture(args.directory.resolve(), check_inputs=args.check_inputs)
            if args.command == 'preview': result['preview'] = (args.directory / 'index.html').resolve().as_uri()
        elif args.command == 'sample':
            args.out.parent.mkdir(parents=True, exist_ok=True)
            result = json.loads(node('sample', args.bundle, args.out, args.time))
        elif args.command == 'repair': result = repair_lecture(args.source, args.build, read(args.request))
        else: result = consumer_video(args.directory, args.chalkspace, args.out, narrate=args.narrate, start=args.start, end=args.end, fps=args.fps)
        print(json.dumps(result, ensure_ascii=True, indent=2))
        return 0 if not isinstance(result, dict) or result.get('renderValidation', {}).get('passed', True) else 1
    except (ValueError, OSError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({'success': False, 'code': getattr(error, 'code', 'LECTURE_ERROR'), 'message': str(error)}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
