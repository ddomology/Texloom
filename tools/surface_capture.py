"""Capture literal parametric declarations; TypeScript owns expression/mesh semantics.

The resource identifier never forms a filename. Whole JSON bodies and decoded
expression strings have exact generated-source spans, without guessing TeX lines.
"""
from __future__ import annotations

import json
from pathlib import Path
import re

# Reuse the already bounded strict JSON parser used by native spatial resources.
from space3d_capture import _json, _span, Space3DCaptureDiagnostic

MAX_CAPTURE_BYTES = 2_000_000
MAX_TOTAL_BYTES = 16_000_000
MAX_DECLARATIONS = 16


class SurfaceCaptureDiagnostic(ValueError):
    def __init__(self, code, message, source_span=None):
        super().__init__(f'{code}: {message}')
        self.code = code
        self.sourceSpan = source_span


def _read(execution, output, base, field, budget):
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-surface-[1-9][0-9]*', base):
        raise SurfaceCaptureDiagnostic('SURFACE_CAPTURE_PATH', 'Invalid generated sidecar filename.')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file() or path.resolve().parent != execution.resolve():
        raise SurfaceCaptureDiagnostic('SURFACE_CAPTURE_PATH', f'Missing or redirected sidecar: {path.name}')
    size = path.stat().st_size
    if size > (2048 if field == 'id' else MAX_CAPTURE_BYTES) or budget[0] + size > MAX_TOTAL_BYTES:
        raise SurfaceCaptureDiagnostic('SURFACE_CAPTURE_BUDGET', f'Capture size limit exceeded at {path.name}.')
    budget[0] += size
    try:
        text = path.read_text(encoding='utf8')
    except UnicodeError as error:
        raise SurfaceCaptureDiagnostic('SURFACE_CAPTURE_UTF8', f'Invalid UTF-8 at {path.name}.') from error
    archive = output / 'surface-sources' / path.name
    archive.parent.mkdir(parents=True, exist_ok=True)
    temporary = archive.with_suffix(archive.suffix + '.tmp')
    temporary.write_text(text, encoding='utf8', newline='\n')
    temporary.replace(archive)
    return text, _span(text, archive, output)


def _expression_span(text, base, group, index, output):
    archive = output / 'surface-sources' / f'{base}.{group}-{index}.expression.txt'
    temporary = archive.with_suffix(archive.suffix + '.tmp')
    temporary.write_text(text + '\n', encoding='utf8', newline='\n')
    temporary.replace(archive)
    return _span(text + '\n', archive, output)


def lower_surfaces(records, bundle, execution, output):
    declarations = [record for record in records if record.get('type') == 'surface-file']
    if not declarations:
        return None
    if len(declarations) > MAX_DECLARATIONS:
        raise SurfaceCaptureDiagnostic('SURFACE_CAPTURE_BUDGET', 'At most 16 surface declarations are supported.')
    if 'surfaces' in bundle:
        raise SurfaceCaptureDiagnostic('SURFACE_CAPTURE_DUPLICATE', 'A surface program has already been declared.')
    execution, output = Path(execution), Path(output)
    operations, source_records, seen_files, seen_ids, seen_resources, budget = [], [], set(), set(), set(), [0]
    for record in declarations:
        base = record.get('file')
        if not isinstance(base, str) or base in seen_files:
            raise SurfaceCaptureDiagnostic('SURFACE_CAPTURE_DUPLICATE', 'Duplicate or invalid declaration sidecar.')
        seen_files.add(base)
        text, span = _read(execution, output, base, 'body', budget)
        try:
            value = _json(text, span)
        except Space3DCaptureDiagnostic as error:
            raise SurfaceCaptureDiagnostic(error.code.replace('SPACE3D_', 'SURFACE_'), str(error).split(': ', 1)[-1], error.sourceSpan) from error
        if not isinstance(value, dict):
            raise SurfaceCaptureDiagnostic('SURFACE_CAPTURE_JSON', 'A surface declaration requires a JSON object.', span)
        if any(key in value for key in ('resourceId', 'sourceSpan', 'expressionSpans')):
            raise SurfaceCaptureDiagnostic('SURFACE_CAPTURE_FIELD', 'resourceId and source spans are supplied by the TeX capture command.', span)
        literal_id, id_span = _read(execution, output, base, 'id', budget)
        resource_id = literal_id.strip()
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.:-]{0,511}', resource_id):
            raise SurfaceCaptureDiagnostic('SURFACE_CAPTURE_ID', 'Expected a literal resource identifier of at most 512 characters.', id_span)
        if resource_id in bundle.get('resources', {}) or resource_id in seen_resources:
            raise SurfaceCaptureDiagnostic('SURFACE_CAPTURE_DUPLICATE', f'Duplicate resource ID {resource_id!r}.', id_span)
        operation_id = value.get('id', resource_id)
        # A non-string ID is diagnosed by the authoritative TS validator below.
        if isinstance(operation_id, str):
            if operation_id in seen_ids:
                raise SurfaceCaptureDiagnostic('SURFACE_CAPTURE_DUPLICATE', f'Duplicate operation ID {operation_id!r}.', span)
            seen_ids.add(operation_id)
        seen_resources.add(resource_id)
        operation = {**value, 'id': operation_id, 'resourceId': resource_id, 'sourceSpan': span}
        expression_spans = {}
        normals = value.get('normals')
        for name, expressions in (
                ('position', value.get('position')),
                ('dU', normals.get('dU') if isinstance(normals, dict) else None),
                ('dV', normals.get('dV') if isinstance(normals, dict) else None)):
            if isinstance(expressions, list) and len(expressions) == 3 and all(isinstance(item, str) for item in expressions):
                expression_spans[name] = [_expression_span(item, base, name, index, output)
                                          for index, item in enumerate(expressions)]
        if expression_spans:
            operation['expressionSpans'] = expression_spans
        operations.append(operation)
        source_records.append({'id': operation_id, 'resourceId': resource_id, 'sourceSpan': span,
                               'idSourceSpan': id_span, 'expressionSpans': expression_spans})
    metadata = {'version': 1, 'declarations': source_records}
    archive = output / 'surface-sources' / 'declarations.json'
    temporary = archive.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf8', newline='\n')
    temporary.replace(archive)
    bundle['surfaces'] = {'version': 1, 'operations': operations}
    bundle['version'] = '0.3'
    return metadata
