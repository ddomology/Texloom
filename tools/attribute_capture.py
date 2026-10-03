"""Literal mesh attribute programs with exact body, step and expression provenance.

All expression/domain/topology semantics belong to the shared TypeScript validator.
The JSON decoder below only locates already validated JSON values in their source.
"""
from __future__ import annotations

import json
from pathlib import Path
import re

from space3d_capture import _json, _span, Space3DCaptureDiagnostic

MAX_CAPTURE_BYTES = 2_000_000
MAX_TOTAL_BYTES = 16_000_000
MAX_OPERATIONS = 16
MAX_STEPS = 32
MAX_TOTAL_STEPS = 128


class AttributeCaptureDiagnostic(ValueError):
    def __init__(self, code, message, source_span=None):
        super().__init__(f'{code}: {message}')
        self.code = code
        self.sourceSpan = source_span


def _read(execution, output, base, field, budget):
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-attributes-[1-9][0-9]*', base):
        raise AttributeCaptureDiagnostic('ATTRIBUTE_CAPTURE_PATH', 'Invalid generated sidecar filename.')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file() or path.resolve().parent != execution.resolve():
        raise AttributeCaptureDiagnostic('ATTRIBUTE_CAPTURE_PATH', f'Missing or redirected sidecar: {path.name}')
    size = path.stat().st_size
    if size > (2048 if field == 'id' else MAX_CAPTURE_BYTES) or budget[0] + size > MAX_TOTAL_BYTES:
        raise AttributeCaptureDiagnostic('ATTRIBUTE_CAPTURE_BUDGET', f'Capture size limit exceeded at {path.name}.')
    budget[0] += size
    try:
        text = path.read_text(encoding='utf8')
    except UnicodeError as error:
        raise AttributeCaptureDiagnostic('ATTRIBUTE_CAPTURE_UTF8', f'Invalid UTF-8 at {path.name}.') from error
    archive = output / 'attribute-sources' / path.name
    archive.parent.mkdir(parents=True, exist_ok=True)
    temporary = archive.with_suffix(archive.suffix + '.tmp')
    temporary.write_text(text, encoding='utf8', newline='\n')
    temporary.replace(archive)
    return text, _span(text, archive, output)


def _offset_span(text, start, end, source):
    def position(index):
        return {'line': text.count('\n', 0, index) + 1,
                'column': index - text.rfind('\n', 0, index)}
    return {'file': source['file'], 'start': position(start), 'end': position(end)}


def _step_spans(text, source):
    """Read exact original ranges of top-level steps, after strict JSON validation."""
    decoder = json.JSONDecoder()
    skip = lambda p: p + len(text[p:]) - len(text[p:].lstrip())
    p = skip(0) + 1
    while True:
        p = skip(p)
        if text[p] == '}':
            return []
        key, p = decoder.raw_decode(text, p)
        p = skip(p) + 1  # colon already checked by the strict decoder
        p = skip(p)
        value, end = decoder.raw_decode(text, p)
        if key == 'steps':
            if not isinstance(value, list):
                return []
            result = []
            p = skip(p + 1)
            while text[p] != ']':
                start = p
                _, p = decoder.raw_decode(text, p)
                result.append(_offset_span(text, start, p, source))
                p = skip(p)
                if text[p] == ',':
                    p = skip(p + 1)
            return result
        p = skip(end)
        if text[p] == ',':
            p += 1


def _expression_span(expression, base, step, component, output):
    archive = output / 'attribute-sources' / f'{base}.step-{step}.expression-{component}.txt'
    temporary = archive.with_suffix('.txt.tmp')
    temporary.write_text(expression + '\n', encoding='utf8', newline='\n')
    temporary.replace(archive)
    return _span(expression + '\n', archive, output)


def lower_attributes(records, bundle, execution, output):
    declarations = [record for record in records if record.get('type') == 'attributes-file']
    if not declarations:
        return None
    if len(declarations) > MAX_OPERATIONS:
        raise AttributeCaptureDiagnostic('ATTRIBUTE_CAPTURE_BUDGET', 'At most 16 attribute operations are supported.')
    if 'meshAttributes' in bundle:
        raise AttributeCaptureDiagnostic('ATTRIBUTE_CAPTURE_DUPLICATE', 'An attribute program already exists.')
    execution, output = Path(execution), Path(output)
    operations, sources, files, ids, resources, budget, total_steps = [], [], set(), set(), set(), [0], 0
    for program in ('surfaces', 'curves3d'):
        for operation in bundle.get(program, {}).get('operations', []):
            if isinstance(operation, dict) and isinstance(operation.get('resourceId'), str):
                resources.add(operation['resourceId'])
    for record in declarations:
        base = record.get('file')
        if not isinstance(base, str) or base in files:
            raise AttributeCaptureDiagnostic('ATTRIBUTE_CAPTURE_DUPLICATE', 'Duplicate or invalid declaration sidecar.')
        files.add(base)
        text, span = _read(execution, output, base, 'body', budget)
        try:
            value = _json(text, span)
        except Space3DCaptureDiagnostic as error:
            raise AttributeCaptureDiagnostic(error.code.replace('SPACE3D_', 'ATTRIBUTE_'),
                                             str(error).split(': ', 1)[-1], error.sourceSpan) from error
        if not isinstance(value, dict):
            raise AttributeCaptureDiagnostic('ATTRIBUTE_CAPTURE_JSON', 'An attribute operation requires a JSON object.', span)
        if any(key in value for key in ('resourceId', 'sourceSpan', 'expressionSpan', 'expressionSpans')):
            raise AttributeCaptureDiagnostic('ATTRIBUTE_CAPTURE_FIELD', 'Output resourceId and source spans are supplied by the command.', span)
        literal_id, id_span = _read(execution, output, base, 'id', budget)
        resource_id = literal_id.strip()
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.:-]{0,511}', resource_id):
            raise AttributeCaptureDiagnostic('ATTRIBUTE_CAPTURE_ID', 'Expected a literal resource identifier of at most 512 characters.', id_span)
        if resource_id in resources or resource_id in bundle.get('resources', {}):
            raise AttributeCaptureDiagnostic('ATTRIBUTE_CAPTURE_DUPLICATE', f'Duplicate resource ID {resource_id!r}.', id_span)
        resources.add(resource_id)
        operation_id = value.get('id', resource_id)
        if isinstance(operation_id, str):
            if operation_id in ids:
                raise AttributeCaptureDiagnostic('ATTRIBUTE_CAPTURE_DUPLICATE', f'Duplicate operation ID {operation_id!r}.', span)
            ids.add(operation_id)
        operation = {**value, 'id': operation_id, 'resourceId': resource_id, 'sourceSpan': span}
        source = {'id': operation_id, 'resourceId': resource_id, 'sourceSpan': span, 'idSourceSpan': id_span, 'steps': []}
        if isinstance(value.get('steps'), list):
            steps = value['steps']
            total_steps += len(steps)
            if len(steps) > MAX_STEPS or total_steps > MAX_TOTAL_STEPS:
                raise AttributeCaptureDiagnostic('ATTRIBUTE_CAPTURE_BUDGET', 'At most 32 steps per operation and 128 total steps are supported.', span)
            step_spans = _step_spans(text, span)
            captured = []
            for index, step in enumerate(steps):
                step_span = step_spans[index]
                if not isinstance(step, dict):
                    captured.append(step)
                    continue
                if any(key in step for key in ('sourceSpan', 'expressionSpan', 'expressionSpans')):
                    raise AttributeCaptureDiagnostic('ATTRIBUTE_CAPTURE_FIELD', 'Step source spans are generated from literal source.', step_span)
                item = {**step, 'sourceSpan': step_span}
                descriptor = {'index': index, 'sourceSpan': step_span}
                expression = step.get('expression')
                expressions = [expression] if isinstance(expression, str) else expression
                if step.get('kind') in ('capture', 'set-position') and isinstance(expressions, list) and 1 <= len(expressions) <= 3 and all(isinstance(x, str) for x in expressions):
                    spans = [_expression_span(x, base, index, component, output) for component, x in enumerate(expressions)]
                    item['expressionSpans'] = descriptor['expressionSpans'] = spans
                captured.append(item)
                source['steps'].append(descriptor)
            operation['steps'] = captured
        operations.append(operation)
        sources.append(source)
    metadata = {'version': 1, 'declarations': sources}
    archive = output / 'attribute-sources' / 'declarations.json'
    temporary = archive.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf8', newline='\n')
    temporary.replace(archive)
    bundle['meshAttributes'] = {'version': 1, 'operations': operations}
    bundle['version'] = '0.3'
    return metadata
