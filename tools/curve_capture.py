"""Lower explicit curve operations into the shared typed operation graph."""
from __future__ import annotations

import json
import math
from pathlib import Path
import re
import shutil


class CurveCaptureDiagnostic(ValueError):
    pass


def _read(execution: Path, base: str, field: str) -> tuple[str, Path]:
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-curve-[1-9][0-9]*', base):
        raise CurveCaptureDiagnostic('Invalid generated curve filename')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file():
        raise CurveCaptureDiagnostic(f'Missing curve sidecar: {path.name}')
    text = path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text), path


def _metadata(execution: Path, base: str, field: str) -> str:
    value = _read(execution, base, field)[0].strip()
    if not value:
        raise CurveCaptureDiagnostic(f'Curve {field} must be nonempty')
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
        raise CurveCaptureDiagnostic(f'Curve inputs contain nonfinite JSON value {value}')
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise CurveCaptureDiagnostic(f'Duplicate JSON key in curve inputs: {key}')
            result[key] = value
        return result
    try:
        return json.loads(text, parse_constant=invalid_constant, object_pairs_hook=object_pairs)
    except json.JSONDecodeError as error:
        raise CurveCaptureDiagnostic(f'Invalid curve inputs JSON: {error}') from error


def _options(text: str, operator: str) -> dict:
    allowed = {'id', 'space', 'tolerance'}
    if operator != 'join':
        allowed.add('contour')
    if operator in ('trim', 'sample'):
        allowed.add('mode')
    if operator == 'trim':
        allowed.add('wrap')
    if operator == 'join':
        allowed.add('join')
    if operator == 'sample':
        allowed.update(('tangent', 'distance'))
    result = {}
    for entry in text.split(','):
        if not entry.strip():
            continue
        if '=' not in entry:
            raise CurveCaptureDiagnostic(f'Curve option requires key=value: {entry.strip()}')
        key, value = (part.strip() for part in entry.split('=', 1))
        if key not in allowed:
            raise CurveCaptureDiagnostic(f'Unknown {operator} option: {key}')
        if key in result:
            raise CurveCaptureDiagnostic(f'Duplicate curve option: {key}')
        if not value:
            raise CurveCaptureDiagnostic(f'Curve option {key} must be nonempty')
        if key in ('contour', 'tolerance', 'distance'):
            value = _json(value)
            if not _finite(value):
                raise CurveCaptureDiagnostic(f'Curve {key} must be a finite number')
            if key == 'contour' and (not isinstance(value, int) or value < -1):
                raise CurveCaptureDiagnostic('Curve contour must be -1 or a nonnegative integer index')
            if key == 'tolerance' and value <= 0:
                raise CurveCaptureDiagnostic('Curve tolerance must be positive')
        if key == 'mode' and value not in ('parameter', 'length'):
            raise CurveCaptureDiagnostic('Curve mode must be parameter or length')
        if key == 'wrap' and value not in ('true', 'false'):
            raise CurveCaptureDiagnostic('Curve wrap must be true or false')
        if key == 'join' and value not in ('separate', 'coincident', 'bridge'):
            raise CurveCaptureDiagnostic('Curve join must be separate, coincident or bridge')
        result[key] = value
    if 'distance' in result and 'tangent' not in result:
        raise CurveCaptureDiagnostic('Curve distance requires a tangent point target')
    return result


def _space(text: str) -> dict:
    if text == 'scene':
        return {'kind': 'scene'}
    kind, separator, node = text.partition(':')
    if separator and kind in ('local', 'parent', 'plot') and node and node.strip() == node:
        return {'kind': kind, 'node': node}
    raise CurveCaptureDiagnostic('Curve space must be scene, local:node, parent:node or plot:group')


def _span(text: str, path: Path, output: Path) -> dict:
    lines = text.split('\n')
    return {'file': path.relative_to(output).as_posix(), 'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}


def _archive(text: str, path: Path, output: Path) -> dict:
    folder = output / 'curve-sources'
    folder.mkdir(parents=True, exist_ok=True)
    archived = folder / path.name
    temporary = archived.with_suffix(archived.suffix + '.tmp')
    shutil.copyfile(path, temporary)
    temporary.replace(archived)
    return _span(text, archived, output)


def _expression(text: str, base: str, socket: str, output: Path) -> dict:
    folder = output / 'curve-sources'
    folder.mkdir(parents=True, exist_ok=True)
    archived = folder / f'{base}.{socket}.expression.txt'
    temporary = archived.with_suffix(archived.suffix + '.tmp')
    temporary.write_bytes((text + '\n').encode('utf8'))
    temporary.replace(archived)
    return _span(text, archived, output)


def _literal(value, unit='1') -> dict:
    return {'kind': 'literal', 'value': {'type': 'scalar', 'unit': unit, 'value': value}}


def _input(value, unit: str, space: dict, base: str, socket: str, output: Path) -> dict:
    if isinstance(value, dict) and set(value) == {'operation', 'socket'} and all(
            isinstance(value[key], str) and value[key] for key in ('operation', 'socket')):
        return {'kind': 'output', 'ref': value}
    if unit == 'path':
        if isinstance(value, str) and value:
            return {'kind': 'path', 'node': value, 'space': space}
        raise CurveCaptureDiagnostic(f'Curve input {socket} requires an editable path node ID or output reference')
    if _finite(value):
        return _literal(value, unit)
    if isinstance(value, str):
        return {'kind': 'expression', 'expression': value, 'unit': unit,
                'sourceSpan': _expression(value, base, socket, output)}
    if isinstance(value, dict) and set(value) == {'node', 'property'} and all(
            isinstance(value[key], str) and value[key] for key in ('node', 'property')):
        return {'kind': 'property', 'node': value['node'], 'property': value['property'], 'unit': unit}
    raise CurveCaptureDiagnostic(f'Curve input {socket} requires a finite number, scalar expression, property or output reference')


def _ref(operation: str, socket: str) -> dict:
    return {'kind': 'output', 'ref': {'operation': operation, 'socket': socket}}


def _op(operation_id: str, operator: str, space: dict, inputs: dict, span: dict, version=1) -> dict:
    return {'id': operation_id, 'operator': operator, 'version': version,
            'spaces': {'space': space}, 'inputs': inputs, 'sourceSpan': span}


def _bind_point(graph: dict, operation: str, target: str, space: dict, span: dict) -> None:
    binding_id = operation
    if space['kind'] != 'scene':
        binding_id += ':scene'
        scene = {'kind': 'scene'}
        graph['operations'].append({'id': binding_id, 'operator': 'transformPoint', 'version': 1,
            'spaces': {'from': space, 'to': scene}, 'inputs': {'point': _ref(operation, 'position'),
                'transform': {'kind': 'spaceTransform', 'from': space, 'to': scene}}, 'sourceSpan': span})
    graph['bindings'].append({'target': target, 'property': 'position',
                             'value': {'operation': binding_id, 'socket': 'position'}, 'sourceSpan': span})


def lower_curves(records: list[dict], bundle: dict, execution: Path, output: Path) -> None:
    declarations = [record for record in records if record['type'] == 'curve-file']
    if not declarations:
        return
    graph = bundle.setdefault('operationGraph', {'version': 1, 'operations': [], 'bindings': []})
    seen = set()
    for record in declarations:
        base = record.get('file', '')
        if base in seen:
            raise CurveCaptureDiagnostic(f'Duplicate curve declaration file: {base}')
        seen.add(base)
        if record.get('kind') not in ('operation', 'sample'):
            raise CurveCaptureDiagnostic(f'Unknown curve declaration kind: {record.get("kind")}')
        sample = record['kind'] == 'sample'
        operator = 'sample' if sample else _metadata(execution, base, 'operation')
        if operator not in (('sample',) if sample else ('trim', 'resample', 'reverse', 'join')):
            raise CurveCaptureDiagnostic(f'Unknown curve operation: {operator}')
        options = _options(_read(execution, base, 'options')[0], operator)
        target = _metadata(execution, base, 'target')
        operation_id = options.get('id', ('sample:' if sample else 'curve:') + target)
        space = _space(options.get('space', 'scene'))
        text, path = _read(execution, base, 'inputs')
        values = _json(text)
        if not isinstance(values, dict):
            raise CurveCaptureDiagnostic('Curve inputs must be a JSON object')
        span = _archive(text, path, output)
        if operator == 'resample':
            if ('count' in values) == ('spacing' in values):
                raise CurveCaptureDiagnostic('Curve resample requires exactly one of count or spacing')
            runtime = 'resamplePathCount' if 'count' in values else 'resamplePathSpacing'
            sockets = {'path': 'path', 'count': '1'} if 'count' in values else {'path': 'path', 'spacing': 'bp'}
        else:
            runtime, sockets = {
                'trim': ('trimPath', {'path': 'path', 'start': '1', 'end': '1'}),
                'reverse': ('reversePath', {'path': 'path'}),
                'join': ('joinPaths', {'a': 'path', 'b': 'path'}),
                'sample': ('sampleCurve', {'path': 'path', 'parameter': '1'}),
            }[operator]
        sockets['tolerance'] = 'bp'
        unexpected = set(values) - set(sockets)
        if unexpected:
            raise CurveCaptureDiagnostic(f'Unknown {operator} input: {sorted(unexpected)[0]}')
        if 'tolerance' in options and 'tolerance' in values:
            raise CurveCaptureDiagnostic('Curve tolerance is specified in both options and JSON')
        inputs = {socket: _input(value, sockets[socket], space, base, socket, output)
                  for socket, value in values.items()}
        if 'tolerance' in options:
            inputs['tolerance'] = _literal(options['tolerance'], 'bp')
        if 'mode' in options:
            inputs['mode'] = _literal(0 if options['mode'] == 'parameter' else 1)
        if 'contour' in options:
            inputs['contour'] = _literal(options['contour'])
        if 'wrap' in options:
            inputs['wrap'] = _literal(int(options['wrap'] == 'true'))
        if operator == 'join':
            inputs['policy'] = _literal({'separate': 0, 'coincident': 1, 'bridge': 2}[options.get('join', 'separate')])
        graph['operations'].append(_op(operation_id, runtime, space, inputs, span, 2 if sample else 1))
        if sample:
            _bind_point(graph, operation_id, target, space, span)
            if 'tangent' in options:
                direction_id = operation_id + ':direction'
                # Legacy offsetPoint's distance socket is dimensionless. Its
                # coefficient scales a unit tangent in the chosen bp space.
                graph['operations'].append(_op(direction_id, 'offsetPoint', space, {
                    'origin': _ref(operation_id, 'position'), 'direction': _ref(operation_id, 'tangent'),
                    'distance': _literal(options.get('distance', 12))}, span))
                _bind_point(graph, direction_id, options['tangent'], space, span)
            continue
        binding_id = operation_id
        target_space = {'kind': 'local', 'node': target}
        if space != target_space:
            binding_id += ':local'
            graph['operations'].append({'id': binding_id, 'operator': 'transformPath', 'version': 1,
                'spaces': {'from': space, 'to': target_space}, 'inputs': {'path': _ref(operation_id, 'path'),
                    'transform': {'kind': 'spaceTransform', 'from': space, 'to': target_space}}, 'sourceSpan': span})
        graph['bindings'].append({'target': target, 'property': 'geometry',
                                 'value': {'operation': binding_id, 'socket': 'path'}, 'sourceSpan': span})
    bundle['version'] = '0.3'
