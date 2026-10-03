"""Literal curve/frame declarations; shared TypeScript owns all numerical semantics."""
from __future__ import annotations

import json
from pathlib import Path
import re

from space3d_capture import _json, _span, Space3DCaptureDiagnostic

MAX_CAPTURE_BYTES = 2_000_000
MAX_TOTAL_BYTES = 16_000_000
MAX_OPERATIONS = 16
MAX_FOLLOWERS = 256


class Curve3DCaptureDiagnostic(ValueError):
    def __init__(self, code, message, source_span=None):
        super().__init__(f'{code}: {message}')
        self.code = code
        self.sourceSpan = source_span


def _read(execution, output, base, field, budget):
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-curve3d-[1-9][0-9]*', base):
        raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_PATH', 'Invalid generated sidecar filename.')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file() or path.resolve().parent != execution.resolve():
        raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_PATH', f'Missing or redirected sidecar: {path.name}')
    size = path.stat().st_size
    if size > (2048 if field == 'id' else MAX_CAPTURE_BYTES) or budget[0] + size > MAX_TOTAL_BYTES:
        raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_BUDGET', f'Capture size limit exceeded at {path.name}.')
    budget[0] += size
    try:
        text = path.read_text(encoding='utf8')
    except UnicodeError as error:
        raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_UTF8', f'Invalid UTF-8 at {path.name}.') from error
    archive = output / 'curve3d-sources' / path.name
    archive.parent.mkdir(parents=True, exist_ok=True)
    temporary = archive.with_suffix(archive.suffix + '.tmp')
    temporary.write_text(text, encoding='utf8', newline='\n')
    temporary.replace(archive)
    return text, _span(text, archive, output)


def _expression_span(text, base, suffix, output):
    archive = output / 'curve3d-sources' / f'{base}.{suffix}.expression.txt'
    temporary = archive.with_suffix(archive.suffix + '.tmp')
    temporary.write_text(text + '\n', encoding='utf8', newline='\n')
    temporary.replace(archive)
    return _span(text + '\n', archive, output)


def lower_curves3d(records, bundle, execution, output):
    declarations = [r for r in records if r.get('type') == 'curve3d-file']
    if not declarations:
        return None
    if len(declarations) > MAX_OPERATIONS + MAX_FOLLOWERS:
        raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_BUDGET', 'Too many curve/frame declarations.')
    if 'curves3d' in bundle:
        raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_DUPLICATE', 'A spatial curve program already exists.')
    execution, output = Path(execution), Path(output)
    operations, followers, sources, files, resources, budget = [], [], [], set(), set(), [0]
    ids = {'curve': set(), 'follower': set()}
    surface_resources = {o.get('resourceId') for o in bundle.get('surfaces', {}).get('operations', [])
                         if isinstance(o, dict) and isinstance(o.get('resourceId'), str)}
    for record in declarations:
        base, kind = record.get('file'), record.get('kind')
        if kind not in ids:
            raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_KIND', 'Expected curve or follower capture.')
        if not isinstance(base, str) or base in files:
            raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_DUPLICATE', 'Duplicate or invalid declaration sidecar.')
        files.add(base)
        text, span = _read(execution, output, base, 'body', budget)
        try:
            value = _json(text, span)
        except Space3DCaptureDiagnostic as error:
            raise Curve3DCaptureDiagnostic(error.code.replace('SPACE3D_', 'CURVE3D_'), str(error).split(': ', 1)[-1], error.sourceSpan) from error
        if not isinstance(value, dict):
            raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_JSON', 'A declaration requires a JSON object.', span)
        field = 'resourceId' if kind == 'curve' else 'target'
        if any(key in value for key in (field, 'sourceSpan', 'expressionSpan', 'expressionSpans')):
            raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_FIELD', f'{field} and source spans are supplied by the TeX command.', span)
        literal_id, id_span = _read(execution, output, base, 'id', budget)
        identifier = literal_id.strip()
        limit = 511 if kind == 'curve' else 255
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.:-]{0,' + str(limit) + '}', identifier):
            raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_ID', 'Expected a literal identifier within the declared ID limit.', id_span)
        declaration_id = value.get('id', identifier)
        if isinstance(declaration_id, str):
            if declaration_id in ids[kind]:
                raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_DUPLICATE', f'Duplicate {kind} ID {declaration_id!r}.', span)
            ids[kind].add(declaration_id)
        result = {**value, 'id': declaration_id, field: identifier, 'sourceSpan': span}
        source = {'kind': kind, 'id': declaration_id, field: identifier, 'sourceSpan': span, 'idSourceSpan': id_span}
        if kind == 'curve':
            if identifier in bundle.get('resources', {}) or identifier in resources or identifier in surface_resources:
                raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_DUPLICATE', f'Duplicate resource ID {identifier!r}.', id_span)
            resources.add(identifier)
            position = value.get('position')
            if isinstance(position, list) and len(position) == 3 and all(isinstance(item, str) for item in position):
                spans = [_expression_span(item, base, f'position-{i}', output) for i, item in enumerate(position)]
                result['expressionSpans'] = source['expressionSpans'] = {'position': spans}
            operations.append(result)
            if len(operations) > MAX_OPERATIONS:
                raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_BUDGET', 'At most 16 curves are supported.', span)
        else:
            if isinstance(value.get('progress'), str):
                result['expressionSpan'] = source['expressionSpan'] = _expression_span(value['progress'], base, 'progress', output)
            followers.append(result)
            if len(followers) > MAX_FOLLOWERS:
                raise Curve3DCaptureDiagnostic('CURVE3D_CAPTURE_BUDGET', 'At most 256 followers are supported.', span)
        sources.append(source)
    metadata = {'version': 1, 'declarations': sources}
    archive = output / 'curve3d-sources' / 'declarations.json'
    temporary = archive.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf8', newline='\n')
    temporary.replace(archive)
    bundle['curves3d'] = {'version': 1, 'operations': operations, 'followers': followers}
    bundle['version'] = '0.3'
    return metadata
