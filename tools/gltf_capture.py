"""Read local glTF/GLB data and pass a detached asset to the shared importer.

Neither glTF extensions nor file contents execute programs. This layer resolves
container bytes and records their provenance; the TypeScript profile owns all
geometry, material, camera, animation and bundle semantics.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path
import re
import struct
import subprocess
import tempfile
from urllib.parse import unquote_to_bytes, urlsplit

from import_samples import strict_json, canonical_json, sha256, SampleImportDiagnostic
from sampled_field_capture import save
from space3d_capture import _span

ROOT = Path(__file__).resolve().parents[1]
MAX_IMPORTS = 8
MAX_BYTES = 64 * 1024 * 1024
MAX_JSON_BYTES = 8 * 1024 * 1024
MAX_BUFFERS = 64
DATA_URI = re.compile(r'data:(?:application/octet-stream|application/gltf-buffer);base64,([A-Za-z0-9+/]*={0,2})')


class GltfCaptureDiagnostic(ValueError):
    def __init__(self, code, message, source_span=None):
        super().__init__(f'{code}: {message}')
        self.code, self.sourceSpan = code, source_span


def fail(code, message, span=None):
    raise GltfCaptureDiagnostic(code, message, span)


def bounded_read(path, budget, span=None, maximum=MAX_BYTES):
    size = path.stat().st_size
    if size > maximum or budget[0] + size > MAX_BYTES:
        fail('GLTF_CAPTURE_BUDGET', 'Combined asset and buffer inputs exceed the byte budget.', span)
    # A file changed between stat/read must never evade the pre-read budget.
    with path.open('rb') as stream:
        raw = stream.read(size + 1)
    if len(raw) != size:
        fail('GLTF_CAPTURE_CHANGED', 'Source size changed during capture.', span)
    budget[0] += size
    return raw


def contained_path(root, base, uri, span=None):
    if not isinstance(uri, str) or not uri or len(uri) > 4096 or re.search(r'[\x00-\x20\\]', uri):
        fail('GLTF_CAPTURE_PATH', 'Expected an encoded relative local URI.', span)
    try:
        parts = urlsplit(uri)
    except ValueError as error:
        raise GltfCaptureDiagnostic('GLTF_CAPTURE_PATH', 'Malformed local URI.', span) from error
    if parts.scheme or parts.netloc or parts.query or parts.fragment or uri.startswith('/'):
        fail('GLTF_CAPTURE_PATH', 'Only local relative URIs without query or fragment are supported.', span)
    if re.search(r'%(?![A-Fa-f0-9]{2})', uri):
        fail('GLTF_CAPTURE_PATH', 'Malformed percent escape in local URI.', span)
    try:
        relative = unquote_to_bytes(parts.path).decode('utf8')
    except UnicodeError as error:
        raise GltfCaptureDiagnostic('GLTF_CAPTURE_PATH', 'Local URI must encode UTF-8.', span) from error
    if re.search(r'[\x00-\x1f\\:]', relative) or relative.startswith('/'):
        fail('GLTF_CAPTURE_PATH', 'Invalid local URI path.', span)
    candidate = (base / relative).resolve()
    if not candidate.is_relative_to(root.resolve()) or not candidate.is_file():
        fail('GLTF_CAPTURE_PATH', f'Missing or outside-package local file: {uri}', span)
    return candidate


def parse_document(raw, span=None):
    if len(raw) > MAX_JSON_BYTES:
        fail('GLTF_CAPTURE_BUDGET', 'glTF JSON exceeds 8 MiB.', span)
    try:
        document = strict_json(raw, span)
    except SampleImportDiagnostic as error:
        raise GltfCaptureDiagnostic('GLTF_CAPTURE_JSON', str(error), span) from error
    if not isinstance(document, dict):
        fail('GLTF_CAPTURE_JSON', 'Expected a glTF JSON object.', span)
    pending = [document]
    try:
        while pending:
            item = pending.pop()
            if isinstance(item, dict):
                pending.extend(item.keys())
                pending.extend(item.values())
            elif isinstance(item, list):
                pending.extend(item)
            elif isinstance(item, str):
                item.encode('utf8')
    except UnicodeError as error:
        raise GltfCaptureDiagnostic('GLTF_CAPTURE_UTF8', 'JSON strings must contain valid Unicode scalar values.', span) from error
    return document


def unpack_glb(raw, span=None):
    """Strict GLB 2 container: JSON first, then at most one optional BIN chunk."""
    if len(raw) < 20:
        fail('GLTF_CAPTURE_GLB', 'GLB header or JSON chunk is truncated.', span)
    magic, version, length = struct.unpack_from('<4sII', raw)
    if magic != b'glTF' or version != 2 or length != len(raw) or length % 4:
        fail('GLTF_CAPTURE_GLB', 'Expected GLB 2 with exact aligned total length.', span)
    chunks, offset = [], 12
    while offset < length:
        if offset + 8 > length:
            fail('GLTF_CAPTURE_GLB', 'Truncated GLB chunk header.', span)
        size, kind = struct.unpack_from('<II', raw, offset)
        offset += 8
        if size % 4 or offset + size > length or len(chunks) >= 2:
            fail('GLTF_CAPTURE_GLB', 'Invalid GLB chunk length or count.', span)
        chunks.append((kind, raw[offset:offset + size]))
        offset += size
    if not chunks or chunks[0][0] != 0x4E4F534A or (len(chunks) == 2 and chunks[1][0] != 0x004E4942):
        fail('GLTF_CAPTURE_GLB', 'Only ordered JSON and optional BIN chunks are supported.', span)
    document = parse_document(chunks[0][1], span)
    return document, chunks[1][1] if len(chunks) == 2 else None


def read_asset(path, package_root, output, base, budget, span=None):
    """Return self-contained API input and exact source archives, without lowering."""
    suffix = path.suffix.lower()
    if suffix not in ('.gltf', '.glb'):
        fail('GLTF_CAPTURE_FORMAT', 'Expected a .gltf or .glb source.', span)
    raw = bounded_read(path, budget, span, MAX_JSON_BYTES if suffix == '.gltf' else MAX_BYTES)
    archive = output / 'gltf-sources' / f'{base}.asset{suffix}'
    save(archive, raw)
    if suffix == '.glb':
        document, binary = unpack_glb(raw, span)
    else:
        document, binary = parse_document(raw, span), None
    buffers = document.get('buffers', [])
    if not isinstance(buffers, list) or len(buffers) > MAX_BUFFERS:
        fail('GLTF_CAPTURE_BUFFERS', 'Expected at most 64 buffer declarations.', span)
    encoded, sources, used_binary = [], [], False
    for index, buffer in enumerate(buffers):
        if not isinstance(buffer, dict) or type(buffer.get('byteLength')) is not int or not 1 <= buffer['byteLength'] <= MAX_BYTES:
            fail('GLTF_CAPTURE_BUFFERS', 'Every buffer requires a bounded positive byteLength.', span)
        size = buffer['byteLength']
        uri = buffer.get('uri')
        if 'uri' not in buffer:
            if suffix != '.glb' or index != 0 or binary is None:
                fail('GLTF_CAPTURE_BUFFERS', 'Only the first GLB buffer may omit its URI.', span)
            if not size <= len(binary) <= size + 3 or any(binary[size:]):
                fail('GLTF_CAPTURE_GLB', 'BIN length or zero padding disagrees with buffer byteLength.', span)
            payload, kind, source_path = binary[:size], 'glb-bin', None
            used_binary = True
        elif isinstance(uri, str) and uri.startswith('data:'):
            match = DATA_URI.fullmatch(uri)
            if not match or len(match[1]) != 4 * ((size + 2) // 3):
                fail('GLTF_CAPTURE_ENCODING', 'Expected a bounded canonical base64 buffer data URI.', span)
            if budget[0] + size > MAX_BYTES:
                fail('GLTF_CAPTURE_BUDGET', 'Combined asset and buffer inputs exceed 64 MiB.', span)
            try:
                payload = base64.b64decode(match[1], validate=True)
            except ValueError as error:
                raise GltfCaptureDiagnostic('GLTF_CAPTURE_ENCODING', 'Invalid base64 buffer.', span) from error
            if base64.b64encode(payload).decode('ascii') != match[1]:
                fail('GLTF_CAPTURE_ENCODING', 'Buffer base64 must be canonical.', span)
            budget[0] += len(payload)
            kind, source_path = 'data-uri', None
        else:
            buffer_path = contained_path(package_root, path.parent, uri, span)
            if buffer_path.suffix.lower() != '.bin':
                fail('GLTF_CAPTURE_FORMAT', 'External buffers must be .bin files.', span)
            payload = bounded_read(buffer_path, budget, span)
            kind, source_path = 'external', buffer_path.relative_to(package_root.resolve()).as_posix()
        if len(payload) != size:
            fail('GLTF_CAPTURE_LENGTH', 'Buffer byteLength does not match its source bytes.', span)
        target = output / 'gltf-sources' / f'{base}.buffer-{index:03d}.bin'
        save(target, payload)
        sources.append({'index': index, 'kind': kind, 'sourcePath': source_path,
                        'file': target.relative_to(output).as_posix(), 'sha256': sha256(payload),
                        'byteLength': len(payload)})
        encoded.append(base64.b64encode(payload).decode('ascii'))
    if binary is not None and not used_binary:
        fail('GLTF_CAPTURE_GLB', 'GLB contains an unreferenced BIN chunk.', span)
    return {'document': document, 'buffers': encoded}, {
        'format': suffix[1:], 'asset': archive.relative_to(output).as_posix(),
        'assetSha256': sha256(raw), 'byteLength': len(raw), 'buffers': sources}


def read_sidecar(execution, output, base, field):
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-gltf-[1-9][0-9]*', base):
        fail('GLTF_CAPTURE_PATH', 'Invalid generated sidecar name.')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file() or path.resolve().parent != execution.resolve():
        fail('GLTF_CAPTURE_PATH', 'Missing or redirected capture sidecar.')
    raw = bounded_read(path, [0], maximum=4096)
    try:
        text = raw.decode('utf8')
    except UnicodeError as error:
        raise GltfCaptureDiagnostic('GLTF_CAPTURE_UTF8', 'Expected UTF-8 sidecar.') from error
    archive = output / 'gltf-sources' / path.name
    save(archive, raw)
    return text.strip(), _span(text, archive, output)


def parse_options(text, span=None):
    options = {}
    if not text:
        return options
    for item in text.split(','):
        item = item.strip()
        if item in ('wireframe', 'solid'):
            key, value = 'wireframe', item == 'wireframe'
        elif item in ('material=error', 'material=fallback'):
            key, value = 'materialPolicy', item.split('=')[1]
        elif re.fullmatch(r'(animation|camera)=(0|[1-9][0-9]{0,4})', item):
            key, number = item.split('=')
            value = int(number)
        else:
            fail('GLTF_CAPTURE_OPTIONS', 'Expected wireframe, solid, material=error|fallback, animation=N or camera=N.', span)
        if key in options:
            fail('GLTF_CAPTURE_OPTIONS', f'Duplicate option: {key}.', span)
        options[key] = value
    return options


def lower_gltf(records, bundle, execution, output, source):
    declarations = [r for r in records if r.get('type') == 'gltf-file']
    if not declarations:
        return None
    if len(declarations) > MAX_IMPORTS:
        fail('GLTF_CAPTURE_BUDGET', 'At most eight glTF imports are supported.')
    execution, output, source = Path(execution), Path(output), Path(source)
    imports, metadata, seen_files, seen_ids, budget = [], [], set(), set(), [0]
    for record in declarations:
        base = record.get('file')
        if not isinstance(base, str) or base in seen_files:
            fail('GLTF_CAPTURE_DUPLICATE', 'Invalid or duplicate declaration sidecar.')
        seen_files.add(base)
        identifier, id_span = read_sidecar(execution, output, base, 'id')
        relative, span = read_sidecar(execution, output, base, 'body')
        text, option_span = read_sidecar(execution, output, base, 'options')
        options = parse_options(text, option_span)
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', identifier):
            fail('GLTF_CAPTURE_ID', 'Expected a scope ID starting with an ASCII letter, followed by letters, digits, underscores or hyphens, at most 64 characters.', id_span)
        if identifier in seen_ids:
            fail('GLTF_CAPTURE_DUPLICATE', f'Duplicate scope {identifier}.', id_span)
        seen_ids.add(identifier)
        path = contained_path(source.parent, source.parent, relative, span)
        asset, info = read_asset(path, source.parent, output, base, budget, span)
        imports.append({'id': identifier, 'asset': asset, 'options': options})
        sidecars = []
        for field in ('id', 'body', 'options'):
            archive = output / 'gltf-sources' / f'{base}.{field}.txt'
            raw = archive.read_bytes()
            sidecars.append({'field': field, 'file': archive.relative_to(output).as_posix(),
                             'sha256': sha256(raw), 'byteLength': len(raw)})
        metadata.append({'id': identifier, 'sourcePath': relative, 'sourceSpan': span,
                         'idSourceSpan': id_span, 'optionsSourceSpan': option_span,
                         'sidecars': sidecars, 'options': options, **info})
    # Keep the source alongside generated declaration spans, including commands
    # expanded from macros. The exact generated values remain independently hashed.
    original = bounded_read(source, [0], maximum=MAX_JSON_BYTES)
    original_path = output / 'gltf-sources' / 'original' / source.name
    save(original_path, original)
    with tempfile.TemporaryDirectory(prefix='gltf-lowering-', dir=output) as scratch:
        request, response = Path(scratch) / 'request.json', Path(scratch) / 'response.json'
        request.write_bytes(canonical_json({'bundle': bundle, 'imports': imports}))
        try:
            result = subprocess.run(['node', str(ROOT / 'tools/lower-gltf.mjs'), str(request), str(response)],
                                    cwd=ROOT, capture_output=True, text=True, encoding='utf8',
                                    errors='replace', timeout=120)
        except subprocess.TimeoutExpired as error:
            raise GltfCaptureDiagnostic('GLTF_CAPTURE_TIMEOUT', 'glTF lowering exceeded 120 seconds.', metadata[-1]['sourceSpan']) from error
        if result.returncode or not response.is_file():
            fail('GLTF_CAPTURE_LOWERING', (result.stdout + '\n' + result.stderr)[-6000:], metadata[-1]['sourceSpan'])
        lowered = json.loads(response.read_text(encoding='utf8'))
    report = {'version': 1, 'declarations': metadata, 'imports': lowered['reports'],
              'source': {'file': original_path.relative_to(output).as_posix(), 'sha256': sha256(original)}}
    save(output / 'gltf-sources' / 'declarations.json', canonical_json(report))
    bundle.clear()
    bundle.update(lowered['bundle'])
    bundle['version'] = '0.3'
    return report
