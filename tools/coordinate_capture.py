"""Lower literal TeX coordinate declarations into the common typed operation graph."""
from __future__ import annotations

import json
import math
from pathlib import Path
import re
import shutil


class CoordinateCaptureDiagnostic(ValueError):
    pass


# Point sockets use bp positions in the chosen metric space. Scalar socket units
# are explicit; omitted optional inputs are left to the common registry defaults.
OPERATORS = {
    'midpoint': {'a': 'point', 'b': 'point'},
    'lerpPoint': {'a': 'point', 'b': 'point', 'factor': '1'},
    'pointTowards': {'a': 'point', 'b': 'point', 'distance': 'bp'},
    'rotatePoint': {'point': 'point', 'center': 'point', 'angle': 'rad'},
    'projectLine': {'point': 'point', 'a': 'point', 'b': 'point'},
    'projectSegment': {'point': 'point', 'a': 'point', 'b': 'point'},
}


def _read(execution: Path, base: str, field: str) -> tuple[str, Path]:
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-coordinate-[1-9][0-9]*', base):
        raise CoordinateCaptureDiagnostic('Invalid generated coordinate filename')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file():
        raise CoordinateCaptureDiagnostic(f'Missing coordinate sidecar: {path.name}')
    text = path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text), path


def _metadata(execution: Path, base: str, field: str) -> str:
    value = _read(execution, base, field)[0].strip()
    if not value:
        raise CoordinateCaptureDiagnostic(f'Coordinate {field} must be nonempty')
    return value


def _options(text: str) -> dict[str, str]:
    result = {}
    for entry in text.split(','):
        if not entry.strip():
            continue
        if '=' not in entry:
            raise CoordinateCaptureDiagnostic(f'Coordinate option requires key=value: {entry.strip()}')
        key, value = (part.strip() for part in entry.split('=', 1))
        if key not in ('id', 'space'):
            raise CoordinateCaptureDiagnostic(f'Unknown coordinate option: {key}')
        if key in result:
            raise CoordinateCaptureDiagnostic(f'Duplicate coordinate option: {key}')
        if not value:
            raise CoordinateCaptureDiagnostic(f'Coordinate option {key} must be nonempty')
        result[key] = value
    return result


def _space(text: str) -> dict:
    if text == 'scene':
        return {'kind': 'scene'}
    kind, separator, node = text.partition(':')
    if separator and kind in ('local', 'parent', 'plot') and node and node.strip() == node:
        return {'kind': kind, 'node': node}
    raise CoordinateCaptureDiagnostic('Coordinate space must be scene, local:node, parent:node or plot:group')


def _inputs(text: str) -> dict:
    def invalid_constant(value):
        raise CoordinateCaptureDiagnostic(f'Coordinate inputs contain nonfinite JSON value {value}')
    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise CoordinateCaptureDiagnostic(f'Duplicate JSON key in coordinate inputs: {key}')
            result[key] = value
        return result
    try:
        value = json.loads(text, parse_constant=invalid_constant, object_pairs_hook=object_pairs)
    except json.JSONDecodeError as error:
        raise CoordinateCaptureDiagnostic(f'Invalid coordinate inputs JSON: {error}') from error
    if not isinstance(value, dict):
        raise CoordinateCaptureDiagnostic('Coordinate inputs must be a JSON object')
    return value


def _finite(value) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _span(text: str, path: Path, output: Path) -> dict:
    lines = text.split('\n')
    return {'file': path.relative_to(output).as_posix(),
            'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}


def _archive_inputs(text: str, path: Path, output: Path) -> dict:
    folder = output / 'coordinate-sources'
    folder.mkdir(parents=True, exist_ok=True)
    archived = folder / path.name
    temporary = archived.with_suffix(archived.suffix + '.tmp')
    shutil.copyfile(path, temporary)
    temporary.replace(archived)
    return _span(text, archived, output)


def _archive_expression(text: str, base: str, socket: str, output: Path) -> dict:
    folder = output / 'coordinate-sources'
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
    if unit == 'point':
        if isinstance(value, str) and value:
            return {'kind': 'node', 'node': value, 'property': 'position', 'space': space}
        if isinstance(value, list) and len(value) == 2 and all(_finite(n) for n in value):
            return {'kind': 'literal', 'value': {'type': 'vec2', 'role': 'point', 'space': space, 'value': value}}
        raise CoordinateCaptureDiagnostic(f'Coordinate input {socket} requires a point node ID, [x,y], or output reference')
    if _finite(value):
        return {'kind': 'literal', 'value': {'type': 'scalar', 'unit': unit, 'value': value}}
    if isinstance(value, str):
        return {'kind': 'expression', 'expression': value, 'unit': unit,
                'sourceSpan': _archive_expression(value, base, socket, output)}
    raise CoordinateCaptureDiagnostic(f'Coordinate input {socket} requires a finite number, scalar expression, or output reference')


def lower_coordinates(records: list[dict], bundle: dict, execution: Path, output: Path) -> None:
    declarations = [record for record in records if record['type'] == 'coordinate-file']
    if not declarations:
        return
    graph = bundle.setdefault('operationGraph', {'version': 1, 'operations': [], 'bindings': []})
    seen = set()
    for record in declarations:
        base = record.get('file', '')
        if base in seen:
            raise CoordinateCaptureDiagnostic(f'Duplicate coordinate declaration file: {base}')
        seen.add(base)
        operator = _metadata(execution, base, 'operator')
        if operator not in OPERATORS:
            raise CoordinateCaptureDiagnostic(f'Unknown coordinate operator: {operator}')
        options = _options(_read(execution, base, 'options')[0])
        target = _metadata(execution, base, 'target')
        operation_id = options.get('id', 'coordinate:' + target)
        space = _space(options.get('space', 'scene'))
        text, path = _read(execution, base, 'inputs')
        values = _inputs(text)
        unexpected = set(values) - set(OPERATORS[operator])
        if unexpected:
            raise CoordinateCaptureDiagnostic(f'Unknown {operator} input: {sorted(unexpected)[0]}')
        source_span = _archive_inputs(text, path, output)
        inputs = {socket: _input(value, OPERATORS[operator][socket], space, base, socket, output)
                  for socket, value in values.items()}
        graph['operations'].append({'id': operation_id, 'operator': operator, 'version': 1,
                                    'spaces': {'space': space}, 'inputs': inputs, 'sourceSpan': source_span})
        binding_id = operation_id
        if space['kind'] != 'scene':
            binding_id += ':scene'
            scene = {'kind': 'scene'}
            graph['operations'].append({'id': binding_id, 'operator': 'transformPoint', 'version': 1,
                                        'spaces': {'from': space, 'to': scene},
                                        'inputs': {'point': {'kind': 'output', 'ref': {'operation': operation_id, 'socket': 'position'}},
                                                   'transform': {'kind': 'spaceTransform', 'from': space, 'to': scene}},
                                        'sourceSpan': source_span})
        graph['bindings'].append({'target': target, 'property': 'position',
                                  'value': {'operation': binding_id, 'socket': 'position'}, 'sourceSpan': source_span})
    bundle['version'] = '0.3'
