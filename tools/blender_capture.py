"""Capture portable Blender results; Blender itself is never invoked by TeX.

The native TypeScript manifest validator/lowerer is shared with API consumers.
Only local, self-contained manifests are accepted. Exact input bytes are kept
with declaration spans; a failed import never mutates the candidate bundle.
"""
from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import tempfile

from import_samples import strict_json, canonical_json, sha256, SampleImportDiagnostic
from sampled_field_capture import local_path, SampledFieldCaptureDiagnostic, save
from space3d_capture import _span

ROOT = Path(__file__).resolve().parents[1]
MAX_IMPORTS = 8
MAX_BYTES = 64 * 1024 * 1024


class BlenderCaptureDiagnostic(ValueError):
    def __init__(self, code, message, source_span=None):
        super().__init__(f'{code}: {message}')
        self.code, self.sourceSpan = code, source_span


def fail(code, message, span=None):
    raise BlenderCaptureDiagnostic(code, message, span)


def read_sidecar(execution, output, base, field):
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-blender-[1-9][0-9]*', base):
        fail('BLENDER_CAPTURE_PATH', 'Invalid generated sidecar name.')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file() or path.resolve().parent != execution.resolve():
        fail('BLENDER_CAPTURE_PATH', 'Missing or redirected capture sidecar.')
    if path.stat().st_size > 4096:
        fail('BLENDER_CAPTURE_BUDGET', 'Declaration exceeds 4096 bytes.')
    raw = path.read_bytes()
    try:
        text = raw.decode('utf8')
    except UnicodeError as error:
        raise BlenderCaptureDiagnostic('BLENDER_CAPTURE_UTF8', 'Expected UTF-8.') from error
    archive = output / 'blender-sources' / path.name
    save(archive, raw)
    return text.strip(), _span(text, archive, output)


def lower_blender(records, bundle, execution, output, source):
    declarations = [r for r in records if r.get('type') == 'blender-file']
    if not declarations:
        return None
    if len(declarations) > MAX_IMPORTS:
        fail('BLENDER_CAPTURE_BUDGET', 'At most eight Blender imports are supported.')
    execution, output, source = Path(execution), Path(output), Path(source)
    imports, metadata, seen_files, seen_ids, total = [], [], set(), set(), 0
    for record in declarations:
        base = record.get('file')
        if not isinstance(base, str) or base in seen_files:
            fail('BLENDER_CAPTURE_DUPLICATE', 'Invalid or duplicate declaration sidecar.')
        seen_files.add(base)
        identifier, id_span = read_sidecar(execution, output, base, 'id')
        relative, span = read_sidecar(execution, output, base, 'body')
        presentation_path = execution / f'{base}.presentation.txt'
        presentation = ''
        if presentation_path.exists():
            presentation, presentation_span = read_sidecar(execution, output, base, 'presentation')
            if presentation not in ('', 'wireframe', 'solid'):
                fail('BLENDER_CAPTURE_PRESENTATION', 'Expected optional [wireframe] or [solid].', presentation_span)
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.-]{0,63}', identifier):
            fail('BLENDER_CAPTURE_ID', 'Expected a scope ID of at most 64 ASCII characters.', id_span)
        if identifier in seen_ids:
            fail('BLENDER_CAPTURE_DUPLICATE', f'Duplicate scope {identifier}.', id_span)
        seen_ids.add(identifier)
        try:
            path = local_path(source.parent, relative, span)
        except SampledFieldCaptureDiagnostic as error:
            raise BlenderCaptureDiagnostic('BLENDER_CAPTURE_PATH', str(error), span) from error
        total += path.stat().st_size
        if total > MAX_BYTES:
            fail('BLENDER_CAPTURE_BUDGET', 'Combined manifests exceed 64 MiB.', span)
        raw = path.read_bytes()
        archive = output / 'blender-sources' / f'{base}.manifest.json'
        save(archive, raw)
        try:
            manifest = strict_json(raw, span)
        except SampleImportDiagnostic as error:
            raise BlenderCaptureDiagnostic('BLENDER_CAPTURE_JSON', str(error), span) from error
        entry = {'id': identifier, 'manifest': manifest}
        if presentation:
            entry['presentation'] = {'wireframe': presentation == 'wireframe'}
        imports.append(entry)
        metadata.append({'id': identifier, 'sourcePath': relative,
                         'sourceSpan': span, 'idSourceSpan': id_span,
                         'manifest': archive.relative_to(output).as_posix(),
                         'manifestSha256': sha256(raw), 'byteLength': len(raw),
                         'presentation': entry.get('presentation')})
    with tempfile.TemporaryDirectory(prefix='blender-lowering-', dir=output) as scratch:
        request, response = Path(scratch) / 'request.json', Path(scratch) / 'response.json'
        request.write_bytes(canonical_json({'bundle': bundle, 'imports': imports}))
        result = subprocess.run(['node', str(ROOT / 'tools/lower-blender.mjs'), str(request), str(response)],
                                cwd=ROOT, capture_output=True, text=True, encoding='utf8',
                                errors='replace', timeout=120)
        if result.returncode or not response.is_file():
            fail('BLENDER_CAPTURE_LOWERING', (result.stdout + '\n' + result.stderr)[-6000:],
                 metadata[-1]['sourceSpan'])
        lowered = json.loads(response.read_text(encoding='utf8'))
    report = {'version': 1, 'declarations': metadata, 'imports': lowered['reports']}
    save(output / 'blender-sources/declarations.json', canonical_json(report))
    bundle.clear()
    bundle.update(lowered['bundle'])
    return report
