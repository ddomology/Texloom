"""Literal shared-instance declarations; the TypeScript compiler owns semantics.

Stable set identifiers never become filenames. Source JSON and decoded component
expressions are archived before the shared validator can publish a bundle.
"""
from __future__ import annotations

import json
from pathlib import Path
import re

from space3d_capture import _json, _span, Space3DCaptureDiagnostic

MAX_CAPTURE_BYTES = 2_000_000
MAX_TOTAL_BYTES = 16_000_000
MAX_OPERATIONS = 16


class InstanceCaptureDiagnostic(ValueError):
    def __init__(self, code, message, source_span=None):
        super().__init__(f'{code}: {message}')
        self.code = code
        self.sourceSpan = source_span


def _read(execution, output, base, field, budget):
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-instances-[1-9][0-9]*', base):
        raise InstanceCaptureDiagnostic('INSTANCE_CAPTURE_PATH', 'Invalid generated sidecar filename.')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file() or path.resolve().parent != execution.resolve():
        raise InstanceCaptureDiagnostic('INSTANCE_CAPTURE_PATH', f'Missing or redirected sidecar: {path.name}')
    size = path.stat().st_size
    if size > (2048 if field == 'id' else MAX_CAPTURE_BYTES) or budget[0] + size > MAX_TOTAL_BYTES:
        raise InstanceCaptureDiagnostic('INSTANCE_CAPTURE_BUDGET', f'Capture size limit exceeded at {path.name}.')
    budget[0] += size
    try:
        text = path.read_text(encoding='utf8')
    except UnicodeError as error:
        raise InstanceCaptureDiagnostic('INSTANCE_CAPTURE_UTF8', f'Invalid UTF-8 at {path.name}.') from error
    archive = output / 'instance-sources' / path.name
    archive.parent.mkdir(parents=True, exist_ok=True)
    temporary = archive.with_suffix(archive.suffix + '.tmp')
    temporary.write_text(text, encoding='utf8', newline='\n')
    temporary.replace(archive)
    return text, _span(text, archive, output)


def _expression_span(expression, base, name, component, output):
    suffix = name if component is None else f'{name}-{component}'
    archive = output / 'instance-sources' / f'{base}.{suffix}.expression.txt'
    temporary = archive.with_suffix('.txt.tmp')
    temporary.write_text(expression + '\n', encoding='utf8', newline='\n')
    temporary.replace(archive)
    return _span(expression + '\n', archive, output)


def lower_instances(records, bundle, execution, output):
    declarations = [record for record in records if record.get('type') == 'instances-file']
    if not declarations:
        return None
    if len(declarations) > MAX_OPERATIONS:
        raise InstanceCaptureDiagnostic('INSTANCE_CAPTURE_BUDGET', 'At most 16 instance operations are supported.')
    if 'instances' in bundle:
        raise InstanceCaptureDiagnostic('INSTANCE_CAPTURE_DUPLICATE', 'An instance program already exists.')
    execution, output = Path(execution), Path(output)
    operations, sources, files, ids, budget = [], [], set(), set(), [0]
    for record in declarations:
        base = record.get('file')
        if not isinstance(base, str) or base in files:
            raise InstanceCaptureDiagnostic('INSTANCE_CAPTURE_DUPLICATE', 'Duplicate or invalid declaration sidecar.')
        files.add(base)
        text, span = _read(execution, output, base, 'body', budget)
        try:
            value = _json(text, span)
        except Space3DCaptureDiagnostic as error:
            raise InstanceCaptureDiagnostic(error.code.replace('SPACE3D_', 'INSTANCE_'),
                                            str(error).split(': ', 1)[-1], error.sourceSpan) from error
        if not isinstance(value, dict):
            raise InstanceCaptureDiagnostic('INSTANCE_CAPTURE_JSON', 'An instance operation requires a JSON object.', span)
        if any(key in value for key in ('id', 'sourceSpan', 'expressionSpan', 'expressionSpans')):
            raise InstanceCaptureDiagnostic('INSTANCE_CAPTURE_FIELD', 'Set ID and source spans are supplied by the command.', span)
        literal_id, id_span = _read(execution, output, base, 'id', budget)
        identifier = literal_id.strip()
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.:-]{0,511}', identifier):
            raise InstanceCaptureDiagnostic('INSTANCE_CAPTURE_ID', 'Expected a literal set identifier of at most 512 characters.', id_span)
        if identifier in ids:
            raise InstanceCaptureDiagnostic('INSTANCE_CAPTURE_DUPLICATE', f'Duplicate set ID {identifier!r}.', id_span)
        ids.add(identifier)
        operation = {**value, 'id': identifier, 'sourceSpan': span}
        expression_spans = {}
        for name, count in (('position', 3), ('rotation', 4), ('scale', 3), ('color', 3)):
            values = value.get(name)
            if isinstance(values, list) and len(values) == count and all(isinstance(x, str) for x in values):
                expression_spans[name] = [_expression_span(expression, base, name, index, output)
                                          for index, expression in enumerate(values)]
        if isinstance(value.get('selection'), str):
            expression_spans['selection'] = _expression_span(value['selection'], base, 'selection', None, output)
        if expression_spans:
            operation['expressionSpans'] = expression_spans
        operations.append(operation)
        sources.append({'id': identifier, 'sourceSpan': span, 'idSourceSpan': id_span,
                        'expressionSpans': expression_spans})
    metadata = {'version': 1, 'declarations': sources}
    archive = output / 'instance-sources' / 'declarations.json'
    temporary = archive.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf8', newline='\n')
    temporary.replace(archive)
    bundle['instances'] = {'version': 1, 'operations': operations}
    bundle['version'] = '0.3'
    return metadata
