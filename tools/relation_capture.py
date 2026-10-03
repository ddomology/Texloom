"""Capture declarative updates; the shared graph owns all evaluation and time."""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path
import re
import shutil


class RelationCaptureDiagnostic(ValueError):
    def __init__(self, message, source_span=None, code='RELATION_CAPTURE'):
        super().__init__(message)
        self.code = code
        self.sourceSpan = source_span


SOCKETS = {
    'followPoint': {'point': 'point', 'offset': 'vector'},
    'alignDirection': {'direction': 'vector', 'fallbackAngle': 'rad'},
    'lookAt': {'from': 'point', 'to': 'point', 'fallbackAngle': 'rad'},
    'thresholdOpacity': {'value': '1', 'threshold': '1'},
}
DEFAULTS = {'followPoint': {'offset': [0, 0]}, 'alignDirection': {'fallbackAngle': 0},
            'lookAt': {'fallbackAngle': 0}, 'thresholdOpacity': {'threshold': .5}}


def _finite(value):
    try:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    except OverflowError:
        return False


def _name(value):
    return isinstance(value, str) and bool(value) and value.strip() == value and len(value) <= 256


def _read(execution, base, field):
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-relation-[1-9][0-9]*', base):
        raise RelationCaptureDiagnostic('Invalid generated relation filename')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file():
        raise RelationCaptureDiagnostic(f'Missing relation sidecar: {path.name}')
    text = path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text), path


def _span(text, path, output):
    lines = text.split('\n')
    return {'file': path.relative_to(output).as_posix(), 'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}


def _archive(text, path, output, folder='relation-sources'):
    archive = output / folder
    archive.mkdir(parents=True, exist_ok=True)
    saved = archive / path.name
    shutil.copyfile(path, saved)
    return _span(text, saved, output)


def _expression(text, base, socket, output):
    folder = output / 'relation-sources'
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f'{base}.{socket}.expression.txt'
    path.write_bytes((text + '\n').encode('utf8'))
    return _span(text, path, output)


def _json(text):
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise RelationCaptureDiagnostic(f'Duplicate JSON key: {key}')
            value[key] = item
        return value

    def bad_number(value):
        raise RelationCaptureDiagnostic(f'Nonfinite JSON value: {value}')

    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_constant=bad_number)
    except (json.JSONDecodeError, RecursionError) as error:
        raise RelationCaptureDiagnostic(f'Invalid relation JSON: {error}') from error
    if not isinstance(value, dict):
        raise RelationCaptureDiagnostic('Relation inputs require a JSON object')

    def finite_tree(item, depth=0):
        if depth > 64:
            raise RelationCaptureDiagnostic('Relation JSON exceeds 64 nested levels')
        if isinstance(item, (int, float)) and not isinstance(item, bool) and not _finite(item):
            raise RelationCaptureDiagnostic('Relation JSON contains a nonfinite number')
        if isinstance(item, dict):
            for child in item.values():
                finite_tree(child, depth+1)
        elif isinstance(item, list):
            for child in item:
                finite_tree(child, depth+1)
    finite_tree(value)
    return value


def _options(text):
    result = {}
    for item in text.split(','):
        if not item.strip():
            continue
        if '=' not in item:
            raise RelationCaptureDiagnostic('Relation options require key=value')
        key, value = (part.strip() for part in item.split('=', 1))
        if key not in ('id', 'space') or key in result or not value:
            raise RelationCaptureDiagnostic(f'Unknown, duplicate or empty relation option: {key}')
        result[key] = value
    return result


def _space(value):
    if value == 'scene':
        return {'kind': 'scene'}
    kind, separator, node = value.partition(':')
    if separator and kind in ('local', 'parent', 'plot') and _name(node):
        return {'kind': kind, 'node': node}
    raise RelationCaptureDiagnostic('Relation space must be scene, local:node, parent:node or plot:group')


def _output(value):
    return isinstance(value, dict) and set(value) == {'operation', 'socket'} and all(_name(v) for v in value.values())


def _input(value, unit, space, base, socket, output):
    if _output(value):
        return {'kind': 'output', 'ref': copy.deepcopy(value)}
    if unit in ('point', 'vector'):
        if isinstance(value, list) and len(value) == 2 and all(_finite(v) for v in value):
            return {'kind': 'literal', 'value': {'type': 'vec2', 'role': unit, 'space': space, 'value': value}}
        if unit == 'point':
            if _name(value):
                return {'kind': 'node', 'node': value, 'property': 'position', 'space': space}
            if isinstance(value, dict) and set(value) == {'expression'} and isinstance(value['expression'], str) and value['expression'].strip():
                return {'kind': 'pointExpression', 'expression': value['expression'], 'space': space,
                        'sourceSpan': _expression(value['expression'], base, socket, output)}
        raise RelationCaptureDiagnostic(f'Relation {socket} requires a finite {unit} pair or typed output reference' +
                                        ('; points also accept a node ID or expression object' if unit == 'point' else ''))
    if _finite(value):
        return {'kind': 'literal', 'value': {'type': 'scalar', 'unit': unit, 'value': value}}
    if isinstance(value, str) and value.strip():
        return {'kind': 'expression', 'expression': value, 'unit': unit,
                'sourceSpan': _expression(value, base, socket, output)}
    if isinstance(value, dict) and set(value) == {'node', 'property'} and all(_name(v) for v in value.values()):
        return {'kind': 'property', 'node': value['node'], 'property': value['property'], 'unit': unit}
    raise RelationCaptureDiagnostic(f'Relation {socket} requires a finite number, expression, property or output reference')


def _ref(operation, socket):
    return {'kind': 'output', 'ref': {'operation': operation, 'socket': socket}}


def _convert(graph, operation_id, value, source, destination, role, span):
    if source == destination:
        return value
    socket = 'point' if role == 'point' else 'vector'
    graph['operations'].append({'id': operation_id, 'operator': 'transformPoint' if role == 'point' else 'transformVector',
        'version': 1, 'spaces': {'from': source, 'to': destination}, 'inputs': {
            socket: value, 'transform': {'kind': 'spaceTransform', 'from': source, 'to': destination}}, 'sourceSpan': span})
    return _ref(operation_id, 'position' if role == 'point' else 'vector')


def _trace(values, target, span, bundle):
    allowed = {'id', 'version', 'source', 'domain', 'step', 'tolerance', 'maxDepth', 'maxSamples', 'seed', 'missing', 'reveal'}
    if set(values)-allowed:
        raise RelationCaptureDiagnostic('Unknown trace fields: ' + ', '.join(sorted(set(values)-allowed)))
    if isinstance(values.get('version', 1), bool) or values.get('version', 1) != 1:
        raise RelationCaptureDiagnostic('Only trace version 1 is supported')
    value = {'id': 'trace:'+target, 'seed': 0, 'missing': 'break', 'reveal': 'progress',
             **{key: copy.deepcopy(item) for key, item in values.items() if key != 'version'},
             'target': target, 'sourceSpan': span}
    if not _name(value['id']):
        raise RelationCaptureDiagnostic('Trace id must be a nonempty name without surrounding whitespace')
    source = value.get('source')
    if not (isinstance(source, dict) and set(source) == {'kind', 'node', 'property', 'space'}
            and source['kind'] == 'node' and _name(source['node']) and source['property'] == 'position'
            and source['space'] == {'kind': 'scene'}):
        raise RelationCaptureDiagnostic('Trace source requires a node position in scene space')
    if isinstance(value['seed'], bool) or value['seed'] != 0:
        raise RelationCaptureDiagnostic('Deterministic trace version 1 requires seed=0')
    if value['missing'] != 'break' or value['reveal'] not in ('progress', 'full'):
        raise RelationCaptureDiagnostic('Trace missing must be break; reveal must be progress or full')
    if not all(key in value for key in ('domain', 'step')):
        raise RelationCaptureDiagnostic('Trace domain and step must be explicitly authored')
    bundle.setdefault('traces', {'version': 1, 'operations': []})['operations'].append(value)


def lower_relations(records, bundle, execution: Path, output: Path):
    declarations = [record for record in records if record['type'] == 'relation-file']
    if not declarations:
        return []
    guarded = []
    seen = set()
    for record in declarations:
        base = record.get('file', '')
        if base in seen:
            raise RelationCaptureDiagnostic(f'Duplicate relation sidecar: {base}')
        seen.add(base)
        target = _read(execution, base, 'target')[0].strip()
        if not _name(target):
            raise RelationCaptureDiagnostic('Relation target must be a nonempty node ID')
        kind = record.get('kind')
        text, path = _read(execution, base, 'inputs')
        span = _archive(text, path, output, 'trace-sources' if kind == 'trace' else 'relation-sources')
        try:
            values = _json(text)
            if kind == 'trace':
                _trace(values, target, span, bundle)
                continue
            if kind not in SOCKETS:
                raise RelationCaptureDiagnostic(f'Unknown relation kind: {kind}')
            option_text, option_path = _read(execution, base, 'options')
            option_span = _archive(option_text, option_path, output)
            try:
                options = _options(option_text)
            except RelationCaptureDiagnostic as error:
                error.sourceSpan = option_span
                raise
            operation_id = options.get('id', 'relation:'+target+':'+kind)
            if not _name(operation_id):
                raise RelationCaptureDiagnostic('Relation id must be nonempty without surrounding whitespace')
            space = _space(options.get('space', 'scene'))
            if kind == 'thresholdOpacity' and 'space' in options:
                raise RelationCaptureDiagnostic('Visibility is scalar and does not accept a space option')
            if set(values)-set(SOCKETS[kind]):
                raise RelationCaptureDiagnostic('Unknown relation inputs: '+', '.join(sorted(set(values)-set(SOCKETS[kind]))))
            values = {**DEFAULTS[kind], **values}
            if set(SOCKETS[kind])-set(values):
                raise RelationCaptureDiagnostic('Missing relation inputs: '+', '.join(sorted(set(SOCKETS[kind])-set(values))))
            graph = bundle.setdefault('operationGraph', {'version': 1, 'operations': [], 'bindings': []})
            inputs = {key: _input(value, SOCKETS[kind][key], space, base, key, output) for key, value in values.items()}
            chart = space
            if kind in ('alignDirection', 'lookAt'):
                chart = {'kind': 'parent', 'node': target}
                for key in ('direction',) if kind == 'alignDirection' else ('from', 'to'):
                    inputs[key] = _convert(graph, operation_id+':'+key+':parent', inputs[key], space, chart,
                                           'vector' if kind == 'alignDirection' else 'point', span)
                guarded.append({'target': target, 'sourceSpan': span})
            graph['operations'].append({'id': operation_id, 'operator': kind, 'version': 1,
                'spaces': {} if kind == 'thresholdOpacity' else {'space': chart}, 'inputs': inputs, 'sourceSpan': span})
            prop, socket = ('position', 'position') if kind == 'followPoint' else (
                ('style.opacity', 'opacity') if kind == 'thresholdOpacity' else ('transform.rotate', 'angle'))
            result = _ref(operation_id, socket)
            if kind == 'followPoint':
                result = _convert(graph, operation_id+':scene', result, space, {'kind': 'scene'}, 'point', span)
            graph['bindings'].append({'target': target, 'property': prop, 'value': result['ref'], 'sourceSpan': span})
        except RelationCaptureDiagnostic as error:
            if not error.sourceSpan:
                error.sourceSpan = span
            raise
    bundle['version'] = '0.3'
    return guarded


def validate_relation_targets(guarded, bundle):
    """Alignment sugar promises positive local x; its own scale stays fixed.

    Run after animation lowering so authored timeline writers are included.
    Parent transforms remain free to animate and are read by chart conversion.
    """
    nodes = {node['id']: node for node in bundle['nodes']}
    writers = [*bundle['tracks'], *bundle.get('expressions', {}).get('bindings', []),
               *bundle.get('operationGraph', {}).get('bindings', [])]
    for record in guarded:
        target, span = record['target'], record['sourceSpan']
        node = nodes.get(target)
        if not node:
            raise RelationCaptureDiagnostic('Alignment target must be an existing authored node', span)
        scale = node.get('transform', {}).get('scale', [1, 1])
        if not isinstance(scale, list) or len(scale) != 2 or not _finite(scale[0]) or scale[0] <= 0:
            raise RelationCaptureDiagnostic('Alignment requires a fixed positive own x-scale; use the typed graph for other axis conventions', span)
        for writer in writers:
            prop = writer.get('property', '')
            if writer.get('target') == target and (prop in ('transform', 'transform.scale', 'scale') or prop.startswith('transform.scale.')):
                raise RelationCaptureDiagnostic('Alignment target own scale/whole transform must remain fixed; parent transforms may animate', span)
