"""Lower intersection sets and explicit point selections into the typed graph."""
from __future__ import annotations

import json
import math
from pathlib import Path
import re
import shutil


class IntersectionCaptureDiagnostic(ValueError):
    pass


def _read(execution: Path, base: str, field: str) -> tuple[str, Path]:
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-intersection-[1-9][0-9]*', base):
        raise IntersectionCaptureDiagnostic('Invalid generated intersection filename')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file():
        raise IntersectionCaptureDiagnostic(f'Missing intersection sidecar: {path.name}')
    text = path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text), path


def _metadata(execution: Path, base: str, field: str) -> str:
    value = _read(execution, base, field)[0].strip()
    if not value:
        raise IntersectionCaptureDiagnostic(f'Intersection {field} must be nonempty')
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
        raise IntersectionCaptureDiagnostic(f'Intersection inputs contain nonfinite JSON value {value}')
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise IntersectionCaptureDiagnostic(f'Duplicate JSON key in intersection inputs: {key}')
            result[key] = value
        return result
    try:
        return json.loads(text, parse_constant=invalid_constant, object_pairs_hook=object_pairs)
    except json.JSONDecodeError as error:
        raise IntersectionCaptureDiagnostic(f'Invalid intersection inputs JSON: {error}') from error


def _options(text: str, select: bool) -> dict:
    allowed = ({'id', 'space', 'along', 'index', 'missing', 'visible-opacity'} if select else
               {'space', 'domain-a', 'domain-b', 'position-tolerance', 'parameter-tolerance'})
    result = {}
    for entry in text.split(','):
        if not entry.strip():
            continue
        if '=' not in entry:
            raise IntersectionCaptureDiagnostic(f'Intersection option requires key=value: {entry.strip()}')
        key, value = (part.strip() for part in entry.split('=', 1))
        if key not in allowed:
            raise IntersectionCaptureDiagnostic(f'Unknown intersection option: {key}')
        if key in result:
            raise IntersectionCaptureDiagnostic(f'Duplicate intersection option: {key}')
        if not value:
            raise IntersectionCaptureDiagnostic(f'Intersection option {key} must be nonempty')
        if key in ('index', 'visible-opacity', 'position-tolerance', 'parameter-tolerance'):
            value = _json(value)
            if not _finite(value):
                raise IntersectionCaptureDiagnostic(f'Intersection {key} must be finite')
            if key == 'index' and (not isinstance(value, int) or value < 0):
                raise IntersectionCaptureDiagnostic('Intersection index must be a nonnegative integer')
            if key == 'visible-opacity' and not 0 <= value <= 1:
                raise IntersectionCaptureDiagnostic('Intersection visible-opacity must be in [0,1]')
            if key.endswith('-tolerance') and value <= 0:
                raise IntersectionCaptureDiagnostic(f'Intersection {key} must be positive')
        if key in ('domain-a', 'domain-b') and value not in ('segment', 'line'):
            raise IntersectionCaptureDiagnostic(f'Intersection {key} must be segment or line')
        if key == 'along' and value not in ('a', 'b'):
            raise IntersectionCaptureDiagnostic('Intersection along must be a or b')
        if key == 'missing' and value not in ('error', 'hide'):
            raise IntersectionCaptureDiagnostic('Intersection missing must be error or hide')
        result[key] = value
    if select and ('along' not in result or 'missing' not in result):
        raise IntersectionCaptureDiagnostic('Intersection selection requires explicit along and missing options')
    return result


def _space(text: str) -> dict:
    if text == 'scene':
        return {'kind': 'scene'}
    kind, separator, node = text.partition(':')
    if separator and kind in ('local', 'parent', 'plot') and node and node.strip() == node:
        return {'kind': kind, 'node': node}
    raise IntersectionCaptureDiagnostic('Intersection space must be scene, local:node, parent:node or plot:group')


def _span(text: str, path: Path, output: Path) -> dict:
    lines = text.split('\n')
    return {'file': path.relative_to(output).as_posix(), 'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}


def _archive(text: str, path: Path, output: Path) -> dict:
    folder = output / 'intersection-sources'
    folder.mkdir(parents=True, exist_ok=True)
    archived = folder / path.name
    temporary = archived.with_suffix(archived.suffix + '.tmp')
    shutil.copyfile(path, temporary)
    temporary.replace(archived)
    return _span(text, archived, output)


def _expression(text: str, base: str, socket: str, output: Path) -> dict:
    folder = output / 'intersection-sources'
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
        raise IntersectionCaptureDiagnostic(f'Intersection input {socket} requires a path node ID or output reference')
    if unit == 'intersections':
        if isinstance(value, str) and value:
            return {'kind': 'output', 'ref': {'operation': value, 'socket': 'intersections'}}
        raise IntersectionCaptureDiagnostic('Intersection selection requires a result operation ID or output reference')
    if _finite(value):
        return _literal(value, unit)
    if isinstance(value, str):
        return {'kind': 'expression', 'expression': value, 'unit': unit,
                'sourceSpan': _expression(value, base, socket, output)}
    if isinstance(value, dict) and set(value) == {'node', 'property'} and all(
            isinstance(value[key], str) and value[key] for key in ('node', 'property')):
        return {'kind': 'property', 'node': value['node'], 'property': value['property'], 'unit': unit}
    raise IntersectionCaptureDiagnostic(f'Intersection input {socket} requires a finite number, scalar expression, property or output reference')


def _ref(operation: str, socket: str) -> dict:
    return {'kind': 'output', 'ref': {'operation': operation, 'socket': socket}}


def _transform(operation: str, value: dict, source: dict, destination: dict, span: dict) -> dict:
    return {'id': operation, 'operator': 'transformPoint', 'version': 1,
            'spaces': {'from': source, 'to': destination}, 'inputs': {'point': value,
            'transform': {'kind': 'spaceTransform', 'from': source, 'to': destination}}, 'sourceSpan': span}


def lower_intersections(records: list[dict], bundle: dict, execution: Path, output: Path) -> None:
    declarations = [record for record in records if record['type'] == 'intersection-file']
    if not declarations:
        return
    graph = bundle.setdefault('operationGraph', {'version': 1, 'operations': [], 'bindings': []})
    nodes = {node['id']: node for node in bundle['nodes']}
    seen = set()
    for record in declarations:
        base = record.get('file', '')
        if base in seen:
            raise IntersectionCaptureDiagnostic(f'Duplicate intersection declaration file: {base}')
        seen.add(base)
        if record.get('kind') not in ('intersect', 'select'):
            raise IntersectionCaptureDiagnostic(f'Unknown intersection declaration kind: {record.get("kind")}')
        select = record['kind'] == 'select'
        options = _options(_read(execution, base, 'options')[0], select)
        space = _space(options.get('space', 'scene'))
        text, path = _read(execution, base, 'inputs')
        values = _json(text)
        if not isinstance(values, dict):
            raise IntersectionCaptureDiagnostic('Intersection inputs must be a JSON object')
        span = _archive(text, path, output)
        sockets = ({'intersections': 'intersections', 'index': '1', 'visibleOpacity': '1'} if select else
                   {'a': 'path', 'b': 'path', 'positionTolerance': 'bp', 'parameterTolerance': '1'})
        unexpected = set(values) - set(sockets)
        if unexpected:
            raise IntersectionCaptureDiagnostic(f'Unknown intersection input: {sorted(unexpected)[0]}')
        option_sockets = ({'index': 'index', 'visible-opacity': 'visibleOpacity'} if select else
                          {'position-tolerance': 'positionTolerance', 'parameter-tolerance': 'parameterTolerance'})
        for option, socket in option_sockets.items():
            if option in options and socket in values:
                raise IntersectionCaptureDiagnostic(f'Intersection {socket} specified in both options and JSON')
        inputs = {socket: _input(value, sockets[socket], space, base, socket, output)
                  for socket, value in values.items()}
        for option, socket in option_sockets.items():
            if option in options:
                inputs[socket] = _literal(options[option], sockets[socket])
        if not select:
            operation_id = _metadata(execution, base, 'result')
            for option, socket in [('domain-a', 'domainA'), ('domain-b', 'domainB')]:
                if option in options:
                    inputs[socket] = _literal(0 if options[option] == 'segment' else 1)
            graph['operations'].append({'id': operation_id, 'operator': 'intersectPaths', 'version': 1,
                'spaces': {'space': space}, 'inputs': inputs, 'sourceSpan': span})
            continue
        target = _metadata(execution, base, 'target')
        node = nodes.get(target)
        if not node or node.get('kind') not in ('point', 'tex'):
            raise IntersectionCaptureDiagnostic('Intersection selection target must be an existing point or raw TeX node')
        initial = [node.get('x'), node.get('y')]
        if not all(_finite(value) for value in initial):
            raise IntersectionCaptureDiagnostic('Intersection target requires finite authored x and y')
        operation_id = options.get('id', 'intersection:' + target)
        inputs['along'] = _literal(0 if options['along'] == 'a' else 1)
        inputs['missing'] = _literal(0 if options['missing'] == 'error' else 1)
        if 'visibleOpacity' not in inputs:
            inputs['visibleOpacity'] = _literal(node.get('style', {}).get('opacity', 1))
        local = {'kind': 'local', 'node': target}
        fallback = {'kind': 'literal', 'value': {'type': 'vec2', 'role': 'point', 'space': local, 'value': initial}}
        if local != space:
            fallback_id = operation_id + ':fallback'
            graph['operations'].append(_transform(fallback_id, fallback, local, space, span))
            fallback = _ref(fallback_id, 'position')
        inputs['fallback'] = fallback
        graph['operations'].append({'id': operation_id, 'operator': 'selectIntersection', 'version': 1,
            'spaces': {'space': space}, 'inputs': inputs, 'sourceSpan': span})
        binding_id = operation_id
        if space['kind'] != 'scene':
            binding_id += ':scene'
            graph['operations'].append(_transform(binding_id, _ref(operation_id, 'position'), space, {'kind': 'scene'}, span))
        graph['bindings'].append({'target': target, 'property': 'position',
            'value': {'operation': binding_id, 'socket': 'position'}, 'sourceSpan': span})
        if options['missing'] == 'hide':
            graph['bindings'].append({'target': target, 'property': 'style.opacity',
                'value': {'operation': operation_id, 'socket': 'opacity'}, 'sourceSpan': span})
    bundle['version'] = '0.3'


