"""Literal mesh/space declarations; the shared TypeScript validator owns 3D semantics.

Only generated filenames are read. Resource IDs never become filesystem paths.
The archived JSON remains unchanged, including user provenance and string escapes.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
import re


MAX_CAPTURE_BYTES = 2_000_000
MAX_TOTAL_BYTES = 16_000_000
MAX_DECLARATIONS = 4096


class Space3DCaptureDiagnostic(ValueError):
    def __init__(self, code, message, source_span=None):
        super().__init__(f'{code}: {message}')
        self.code = code
        self.sourceSpan = source_span


def _span(text, archive, output):
    # TeX appends one write newline; source coordinates refer to the literal body.
    body = text[:-1] if text.endswith('\n') else text
    lines = body.split('\n')
    return {'file': archive.relative_to(output).as_posix(),
            'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}


def _read(execution, output, base, field, budget):
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-space3d-[1-9][0-9]*', base):
        raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_PATH', 'Invalid generated sidecar filename.')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file() or path.resolve().parent != execution.resolve():
        raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_PATH', f'Missing or redirected sidecar: {path.name}')
    size = path.stat().st_size
    limit = 2048 if field == 'id' else MAX_CAPTURE_BYTES
    if size > limit or budget[0] + size > MAX_TOTAL_BYTES:
        raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_BUDGET', f'Capture size limit exceeded at {path.name}.')
    budget[0] += size
    try:
        text = path.read_text(encoding='utf8')
    except UnicodeError as error:
        raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_UTF8', f'Invalid UTF-8 at {path.name}.') from error
    archive = output / 'space3d-sources' / path.name
    archive.parent.mkdir(parents=True, exist_ok=True)
    temporary = archive.with_suffix(archive.suffix + '.tmp')
    temporary.write_text(text, encoding='utf8', newline='\n')
    temporary.replace(archive)
    return text, _span(text, archive, output)


def _json(text, span):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_DUPLICATE', f'Duplicate JSON key {key!r}.', span)
            result[key] = value
        return result

    def nonfinite(value):
        raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_NONFINITE', f'Nonfinite JSON number {value}.', span)

    def number(text):
        value = float(text)
        if not math.isfinite(value):
            nonfinite(text)
        return value

    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_constant=nonfinite, parse_float=number)
    except (json.JSONDecodeError, RecursionError, ValueError) as error:
        if isinstance(error, Space3DCaptureDiagnostic):
            raise
        raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_JSON', f'Invalid literal JSON: {error}', span) from error
    # Bound nesting/size before any subsequent recursive serializer. Walk without recursion.
    pending = [(value, 0)]; count = 0
    while pending:
        item, depth = pending.pop(); count += 1
        if depth > 128 or count > 1_000_000:
            raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_BUDGET', 'JSON exceeds depth 128 or one million values.', span)
        if isinstance(item, dict):
            pending.extend((v, depth + 1) for v in item.values())
        elif isinstance(item, list):
            pending.extend((v, depth + 1) for v in item)
        elif isinstance(item, int) and not isinstance(item, bool):
            try:
                finite = math.isfinite(item)
            except OverflowError:
                finite = False
            if not finite:
                nonfinite(str(item))
    return value


def lower_space3d(records, bundle, execution, output):
    """Attach a scene only after capture succeeds; final TS validation precedes publication."""
    declarations = [r for r in records if r.get('type') == 'space3d-file']
    if not declarations:
        return None
    if len(declarations) > MAX_DECLARATIONS:
        raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_BUDGET', 'Too many 3D declarations.')
    execution, output = Path(execution), Path(output)
    mesh_resources, source_records, seen_files, budget = {}, [], set(), [0]
    space = None
    for record in declarations:
        base, kind = record.get('file'), record.get('kind')
        if not isinstance(base, str) or base in seen_files:
            raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_DUPLICATE', 'Duplicate or invalid declaration sidecar.')
        seen_files.add(base)
        if kind not in ('mesh', 'space'):
            raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_KIND', f'Unknown 3D declaration kind {kind!r}.')
        text, span = _read(execution, output, base, 'body', budget)
        value = _json(text, span)
        if not isinstance(value, dict):
            raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_JSON', 'A declaration requires a JSON object.', span)
        source = {'kind': kind, 'sourceSpan': span}
        if kind == 'mesh':
            literal_id, id_span = _read(execution, output, base, 'id', budget)
            resource_id = literal_id.strip()
            if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.:-]{0,511}', resource_id):
                raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_ID', 'Expected a literal identifier of at most 512 characters.', id_span)
            if resource_id in bundle.get('resources', {}) or resource_id in mesh_resources:
                raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_DUPLICATE', f'Duplicate resource ID {resource_id!r}.', id_span)
            if value.get('kind') != 'mesh':
                raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_KIND', 'loommesh requires a kind:mesh resource.', span)
            mesh_resources[resource_id] = value
            source.update({'resourceId': resource_id, 'idSourceSpan': id_span})
        else:
            if space is not None or 'space3d' in bundle:
                raise Space3DCaptureDiagnostic('SPACE3D_CAPTURE_DUPLICATE', 'Declare one 3D space per scene.', span)
            space = value
        source_records.append(source)
    archive = output / 'space3d-sources' / 'declarations.json'
    metadata = {'version': 1, 'declarations': source_records}
    temporary = archive.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf8', newline='\n')
    temporary.replace(archive)
    bundle.setdefault('resources', {}).update(mesh_resources)
    if space is not None:
        bundle['space3d'] = space
    bundle['version'] = '0.3'
    return metadata
