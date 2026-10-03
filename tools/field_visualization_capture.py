"""Literal mesh-field visualization declarations; TypeScript owns field semantics.

Stable operation identifiers never become filenames. Source JSON and decoded component
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


class FieldVisualizationCaptureDiagnostic(ValueError):
    def __init__(self, code, message, source_span=None):
        super().__init__(f'{code}: {message}')
        self.code = code
        self.sourceSpan = source_span


def _read(execution, output, base, field, budget):
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-field-visualization-[1-9][0-9]*', base):
        raise FieldVisualizationCaptureDiagnostic('FIELD_VISUALIZATION_CAPTURE_PATH', 'Invalid generated sidecar filename.')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file() or path.resolve().parent != execution.resolve():
        raise FieldVisualizationCaptureDiagnostic('FIELD_VISUALIZATION_CAPTURE_PATH', f'Missing or redirected sidecar: {path.name}')
    size = path.stat().st_size
    if size > (2048 if field == 'id' else MAX_CAPTURE_BYTES) or budget[0] + size > MAX_TOTAL_BYTES:
        raise FieldVisualizationCaptureDiagnostic('FIELD_VISUALIZATION_CAPTURE_BUDGET', f'Capture size limit exceeded at {path.name}.')
    budget[0] += size
    try:
        text = path.read_text(encoding='utf8')
    except UnicodeError as error:
        raise FieldVisualizationCaptureDiagnostic('FIELD_VISUALIZATION_CAPTURE_UTF8', f'Invalid UTF-8 at {path.name}.') from error
    archive = output / 'field-visualization-sources' / path.name
    archive.parent.mkdir(parents=True, exist_ok=True)
    temporary = archive.with_suffix(archive.suffix + '.tmp')
    temporary.write_text(text, encoding='utf8', newline='\n')
    temporary.replace(archive)
    return text, _span(text, archive, output)


def _expression_span(expression, base, name, component, output):
    suffix = name if component is None else f'{name}-{component}'
    archive = output / 'field-visualization-sources' / f'{base}.{suffix}.expression.txt'
    temporary = archive.with_suffix('.txt.tmp')
    temporary.write_text(expression + '\n', encoding='utf8', newline='\n')
    temporary.replace(archive)
    return _span(expression + '\n', archive, output)


def lower_field_visualization(records, bundle, execution, output):
    declarations = [record for record in records if record.get('type') == 'field-visualization-file']
    if not declarations:
        return None
    if len(declarations) > MAX_OPERATIONS:
        raise FieldVisualizationCaptureDiagnostic('FIELD_VISUALIZATION_CAPTURE_BUDGET', 'At most 16 field visualization operations are supported.')
    if 'fieldVisualization' in bundle:
        raise FieldVisualizationCaptureDiagnostic('FIELD_VISUALIZATION_CAPTURE_DUPLICATE', 'A field visualization program already exists.')
    execution, output = Path(execution), Path(output)
    operations, sources, files, ids, budget = [], [], set(), set(), [0]
    for record in declarations:
        base = record.get('file')
        if not isinstance(base, str) or base in files:
            raise FieldVisualizationCaptureDiagnostic('FIELD_VISUALIZATION_CAPTURE_DUPLICATE', 'Duplicate or invalid declaration sidecar.')
        files.add(base)
        text, span = _read(execution, output, base, 'body', budget)
        try:
            value = _json(text, span)
        except Space3DCaptureDiagnostic as error:
            raise FieldVisualizationCaptureDiagnostic(error.code.replace('SPACE3D_', 'FIELD_VISUALIZATION_'),
                                            str(error).split(': ', 1)[-1], error.sourceSpan) from error
        if not isinstance(value, dict):
            raise FieldVisualizationCaptureDiagnostic('FIELD_VISUALIZATION_CAPTURE_JSON', 'A field visualization operation requires a JSON object.', span)
        if any(key in value for key in ('id', 'sourceSpan', 'expressionSpan', 'expressionSpans')):
            raise FieldVisualizationCaptureDiagnostic('FIELD_VISUALIZATION_CAPTURE_FIELD', 'Operation ID and source spans are supplied by the command.', span)
        literal_id, id_span = _read(execution, output, base, 'id', budget)
        identifier = literal_id.strip()
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.:-]{0,511}', identifier):
            raise FieldVisualizationCaptureDiagnostic('FIELD_VISUALIZATION_CAPTURE_ID', 'Expected a literal operation identifier of at most 512 characters.', id_span)
        if identifier in ids:
            raise FieldVisualizationCaptureDiagnostic('FIELD_VISUALIZATION_CAPTURE_DUPLICATE', f'Duplicate operation ID {identifier!r}.', id_span)
        ids.add(identifier)
        operation = {**value, 'id': identifier, 'sourceSpan': span}
        expression_spans = {}
        vector = value.get('vector')
        if isinstance(vector, list) and len(vector) == 3 and all(isinstance(x, str) for x in vector):
            expression_spans['vector'] = [_expression_span(expression, base, 'vector', index, output)
                                          for index, expression in enumerate(vector)]
        fields = {'scalar': value.get('scalar'), 'mask': value.get('mask')}
        displacement, arrows = value.get('displacement'), value.get('arrows')
        if isinstance(displacement, dict): fields['amplitude'] = displacement.get('amplitude')
        if isinstance(arrows, dict): fields['lengthScale'] = arrows.get('lengthScale')
        for name, expression in fields.items():
            if isinstance(expression, str):
                expression_spans[name] = _expression_span(expression, base, name, None, output)
        if expression_spans:
            operation['expressionSpans'] = expression_spans
        operations.append(operation)
        sources.append({'id': identifier, 'sourceSpan': span, 'idSourceSpan': id_span,
                        'expressionSpans': expression_spans})
    metadata = {'version': 1, 'declarations': sources}
    archive = output / 'field-visualization-sources' / 'declarations.json'
    temporary = archive.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf8', newline='\n')
    temporary.replace(archive)
    bundle['fieldVisualization'] = {'version': 1, 'operations': operations}
    bundle['version'] = '0.3'
    return metadata
