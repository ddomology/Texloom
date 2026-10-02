"""Lower literal TeX shape declarations into the shared typed operation graph."""
from __future__ import annotations

import json
import math
from pathlib import Path
import re
import shutil


class ShapeCaptureDiagnostic(ValueError):
    pass


CONSTRUCTORS = {
    'circle': {'center': 'point', 'radius': 'bp'},
    'ellipse': {'center': 'point', 'rx': 'bp', 'ry': 'bp'},
    'arc': {'center': 'point', 'rx': 'bp', 'ry': 'bp', 'startAngle': 'rad', 'sweepAngle': 'rad'},
    'rectangle': {'origin': 'point', 'width': 'bp', 'height': 'bp'},
    'roundedRectangle': {'origin': 'point', 'width': 'bp', 'height': 'bp', 'cornerRadius': 'bp'},
    'polyline': {'points': 'points', 'closed': '1'},
}


def _read(execution: Path, base: str, field: str) -> tuple[str, Path]:
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-shape-[1-9][0-9]*', base):
        raise ShapeCaptureDiagnostic('Invalid generated shape filename')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file():
        raise ShapeCaptureDiagnostic(f'Missing shape sidecar: {path.name}')
    text = path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text), path


def _metadata(execution: Path, base: str, field: str) -> str:
    value = _read(execution, base, field)[0].strip()
    if not value:
        raise ShapeCaptureDiagnostic(f'Shape {field} must be nonempty')
    return value


def _finite(value) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _json(text: str):
    def invalid_constant(value):
        raise ShapeCaptureDiagnostic(f'Shape inputs contain nonfinite JSON value {value}')
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ShapeCaptureDiagnostic(f'Duplicate JSON key in shape inputs: {key}')
            result[key] = value
        return result
    try:
        return json.loads(text, parse_constant=invalid_constant, object_pairs_hook=object_pairs)
    except json.JSONDecodeError as error:
        raise ShapeCaptureDiagnostic(f'Invalid shape inputs JSON: {error}') from error


def _options(text: str, sample: bool) -> dict:
    result = {}
    allowed = ('id', 'space') if sample else ('id', 'space', 'profile', 'tolerance', 'maxSegments')
    for entry in text.split(','):
        if not entry.strip():
            continue
        if '=' not in entry:
            raise ShapeCaptureDiagnostic(f'Shape option requires key=value: {entry.strip()}')
        key, value = (part.strip() for part in entry.split('=', 1))
        if key not in allowed:
            raise ShapeCaptureDiagnostic(f'Unknown shape option: {key}')
        if key in result:
            raise ShapeCaptureDiagnostic(f'Duplicate shape option: {key}')
        if not value:
            raise ShapeCaptureDiagnostic(f'Shape option {key} must be nonempty')
        if key in ('tolerance', 'maxSegments'):
            value = _json(value)
            if not _finite(value) or value <= 0:
                raise ShapeCaptureDiagnostic(f'Shape {key} must be a positive finite number')
            if key == 'maxSegments' and (not isinstance(value, int) or isinstance(value, bool)):
                raise ShapeCaptureDiagnostic('Shape maxSegments must be a positive integer')
        result[key] = value
    if result.get('profile', 'cubic') not in ('cubic', 'polyline'):
        raise ShapeCaptureDiagnostic('Shape profile must be cubic or polyline')
    return result


def _space(text: str) -> dict:
    if text == 'scene':
        return {'kind': 'scene'}
    kind, separator, node = text.partition(':')
    if separator and kind in ('local', 'parent', 'plot') and node and node.strip() == node:
        return {'kind': kind, 'node': node}
    raise ShapeCaptureDiagnostic('Shape space must be scene, local:node, parent:node or plot:group')


def _span(text: str, path: Path, output: Path) -> dict:
    lines = text.split('\n')
    return {'file': path.relative_to(output).as_posix(), 'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}


def _archive(text: str, path: Path, output: Path) -> dict:
    folder = output / 'shape-sources'
    folder.mkdir(parents=True, exist_ok=True)
    archived = folder / path.name
    temporary = archived.with_suffix(archived.suffix + '.tmp')
    shutil.copyfile(path, temporary)
    temporary.replace(archived)
    return _span(text, archived, output)


def _expression(text: str, base: str, socket: str, output: Path) -> dict:
    folder = output / 'shape-sources'
    folder.mkdir(parents=True, exist_ok=True)
    archived = folder / f'{base}.{socket}.expression.txt'
    temporary = archived.with_suffix(archived.suffix + '.tmp')
    temporary.write_bytes((text + '\n').encode('utf8'))
    temporary.replace(archived)
    return _span(text, archived, output)


def _input(value, unit: str, space: dict, base: str, socket: str, output: Path) -> dict:
    if isinstance(value, dict) and set(value) == {'operation', 'socket'} and all(
            isinstance(value[key], str) and value[key] for key in ('operation', 'socket')):
        return {'kind': 'output', 'ref': value}
    if unit == 'points':
        if not isinstance(value, list):
            raise ShapeCaptureDiagnostic('Shape points input must be a JSON array or output reference')
        return {'kind': 'points', 'space': space,
                'items': [_input(point, 'point', space, base, f'{socket}.{index}', output)
                          for index, point in enumerate(value)]}
    if unit == 'point':
        if isinstance(value, str) and value:
            return {'kind': 'node', 'node': value, 'property': 'position', 'space': space}
        if isinstance(value, list) and len(value) == 2 and all(_finite(n) for n in value):
            return {'kind': 'literal', 'value': {'type': 'vec2', 'role': 'point', 'space': space, 'value': value}}
        if isinstance(value, dict) and set(value) == {'expression'} and isinstance(value['expression'], str):
            text = value['expression']
            return {'kind': 'pointExpression', 'expression': text, 'space': space,
                    'sourceSpan': _expression(text, base, socket, output)}
        raise ShapeCaptureDiagnostic(f'Shape input {socket} requires a node ID, [x,y], point expression, or output reference')
    if isinstance(value, dict) and set(value) == {'node', 'property'} and all(
            isinstance(value[key], str) and value[key] for key in ('node', 'property')):
        return {'kind': 'property', 'node': value['node'], 'property': value['property'], 'unit': unit}
    if _finite(value):
        return {'kind': 'literal', 'value': {'type': 'scalar', 'unit': unit, 'value': value}}
    if isinstance(value, str):
        return {'kind': 'expression', 'expression': value, 'unit': unit,
                'sourceSpan': _expression(value, base, socket, output)}
    raise ShapeCaptureDiagnostic(f'Shape input {socket} requires a finite number, scalar expression, property or output reference')


def _op(operation_id: str, operator: str, spaces: dict, inputs: dict, source_span: dict) -> dict:
    return {'id': operation_id, 'operator': operator, 'version': 1,
            'spaces': spaces, 'inputs': inputs, 'sourceSpan': source_span}


def _ref(operation: str, socket: str) -> dict:
    return {'kind': 'output', 'ref': {'operation': operation, 'socket': socket}}


def lower_shapes(records: list[dict], bundle: dict, execution: Path, output: Path) -> None:
    declarations = [record for record in records if record['type'] == 'shape-file']
    if not declarations:
        return
    graph = bundle.setdefault('operationGraph', {'version': 1, 'operations': [], 'bindings': []})
    seen = set()
    for record in declarations:
        base = record.get('file', '')
        if base in seen:
            raise ShapeCaptureDiagnostic(f'Duplicate shape declaration file: {base}')
        seen.add(base)
        kind = record.get('kind')
        if kind not in ('constructor', 'sample'):
            raise ShapeCaptureDiagnostic(f'Unknown shape declaration kind: {kind}')
        sample = kind == 'sample'
        options = _options(_read(execution, base, 'options')[0], sample)
        target = _metadata(execution, base, 'target')
        operation_id = options.get('id', ('sample:' if sample else 'shape:') + target)
        space = _space(options.get('space', 'scene'))
        text, path = _read(execution, base, 'inputs')
        values = _json(text)
        source_span = _archive(text, path, output)
        if sample:
            shape = _metadata(execution, base, 'shape')
            graph['operations'].append(_op(operation_id, 'sampleShape', {'space': space},
                {'shape': _ref(shape, 'shape'), 'parameter': _input(values, '1', space, base, 'parameter', output)}, source_span))
            binding_id = operation_id
            if space['kind'] != 'scene':
                binding_id += ':scene'
                scene = {'kind': 'scene'}
                graph['operations'].append(_op(binding_id, 'transformPoint', {'from': space, 'to': scene},
                    {'point': _ref(operation_id, 'position'), 'transform': {'kind': 'spaceTransform', 'from': space, 'to': scene}}, source_span))
            graph['bindings'].append({'target': target, 'property': 'position',
                'value': {'operation': binding_id, 'socket': 'position'}, 'sourceSpan': source_span})
            continue
        constructor = _metadata(execution, base, 'constructor')
        if constructor not in CONSTRUCTORS:
            raise ShapeCaptureDiagnostic(f'Unknown shape constructor: {constructor}')
        if not isinstance(values, dict):
            raise ShapeCaptureDiagnostic('Shape constructor inputs must be a JSON object')
        unexpected = set(values) - set(CONSTRUCTORS[constructor])
        if unexpected:
            raise ShapeCaptureDiagnostic(f'Unknown {constructor} input: {sorted(unexpected)[0]}')
        if constructor == 'polyline' and isinstance(values.get('closed'), bool):
            values['closed'] = int(values['closed'])
        inputs = {socket: _input(value, CONSTRUCTORS[constructor][socket], space, base, socket, output)
                  for socket, value in values.items()}
        graph['operations'].append(_op(operation_id, constructor, {'space': space}, inputs, source_span))
        path_id = operation_id + ':path'
        conversion_inputs = {'shape': _ref(operation_id, 'shape')}
        for key, unit in [('tolerance', 'bp'), ('maxSegments', '1')]:
            if key in options:
                conversion_inputs[key] = {'kind': 'literal', 'value': {'type': 'scalar', 'unit': unit, 'value': options[key]}}
        graph['operations'].append(_op(path_id, 'shapeToPolyline' if options.get('profile', 'cubic') == 'polyline' else 'shapeToCubic',
            {'space': space}, conversion_inputs, source_span))
        target_space = {'kind': 'local', 'node': target}
        binding_id = path_id
        if space != target_space:
            binding_id = operation_id + ':local'
            graph['operations'].append(_op(binding_id, 'transformPath', {'from': space, 'to': target_space},
                {'path': _ref(path_id, 'path'), 'transform': {'kind': 'spaceTransform', 'from': space, 'to': target_space}}, source_span))
        graph['bindings'].append({'target': target, 'property': 'geometry',
            'value': {'operation': binding_id, 'socket': 'path'}, 'sourceSpan': source_span})
    bundle['version'] = '0.3'
