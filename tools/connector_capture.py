"""Lower explicit connector routes and metric path labels into the typed graph."""
from __future__ import annotations

import json
import math
from pathlib import Path
import re
import shutil

from anchor_capture import NAMES


class ConnectorCaptureDiagnostic(ValueError):
    pass


def _read(execution: Path, base: str, field: str) -> tuple[str, Path]:
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-connector-[1-9][0-9]*', base):
        raise ConnectorCaptureDiagnostic('Invalid generated connector filename')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file():
        raise ConnectorCaptureDiagnostic(f'Missing connector sidecar: {path.name}')
    text = path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text), path


def _metadata(execution: Path, base: str, field: str) -> str:
    value = _read(execution, base, field)[0].strip()
    if not value:
        raise ConnectorCaptureDiagnostic(f'Connector {field} must be nonempty')
    return value


def _finite(value) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _json(text: str):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ConnectorCaptureDiagnostic(f'Duplicate JSON key in connector inputs: {key}')
            result[key] = value
        return result
    def nonfinite(value):
        raise ConnectorCaptureDiagnostic(f'Connector inputs contain nonfinite JSON value {value}')
    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=nonfinite)
    except json.JSONDecodeError as error:
        raise ConnectorCaptureDiagnostic(f'Invalid connector inputs JSON: {error}') from error


def _padding(value, name: str) -> list:
    if _finite(value):
        value = [value, value]
    if not isinstance(value, list) or len(value) != 2 or not all(_finite(n) and n >= 0 for n in value):
        raise ConnectorCaptureDiagnostic(f'Connector {name} must be a nonnegative scalar or pair')
    return value


def _option_number(text: str):
    # TeX options commonly use .5; the final literal JSON body stays strict JSON.
    if not re.fullmatch(r'[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?', text):
        raise ConnectorCaptureDiagnostic('Connector numeric option must be a literal number')
    return int(text) if re.fullmatch(r'[-+]?\d+', text) else float(text)


def _options(text: str, label: bool) -> dict:
    allowed = ({'id', 'mode', 'at', 'offset', 'rotate', 'anchor', 'contour', 'tolerance',
                'scale-x', 'scale-y', 'inner-sep', 'outer-sep'} if label else
               {'id', 'route', 'space', 'order'})
    entries, start, depth = [], 0, 0
    for index, character in enumerate(text):
        if character == '[':
            depth += 1
        elif character == ']':
            depth -= 1
            if depth < 0:
                raise ConnectorCaptureDiagnostic('Unbalanced connector option brackets')
        elif character == ',' and depth == 0:
            entries.append(text[start:index]); start = index + 1
    if depth:
        raise ConnectorCaptureDiagnostic('Unbalanced connector option brackets')
    entries.append(text[start:])
    result = {}
    for entry in entries:
        if not entry.strip():
            continue
        if '=' not in entry:
            raise ConnectorCaptureDiagnostic(f'Connector option requires key=value: {entry.strip()}')
        key, value = (part.strip() for part in entry.split('=', 1))
        if key not in allowed:
            raise ConnectorCaptureDiagnostic(f'Unknown {"label" if label else "connector"} option: {key}')
        if key in result:
            raise ConnectorCaptureDiagnostic(f'Duplicate connector option: {key}')
        if not value:
            raise ConnectorCaptureDiagnostic(f'Connector option {key} must be nonempty')
        if key in ('inner-sep', 'outer-sep'):
            value = _padding(_json(value) if value.startswith('[') else _option_number(value), key)
        if key in ('at', 'offset', 'contour', 'tolerance', 'scale-x', 'scale-y'):
            value = _option_number(value)
            if not _finite(value):
                raise ConnectorCaptureDiagnostic(f'Label {key} must be finite')
            if key == 'at' and not 0 <= value <= 1:
                raise ConnectorCaptureDiagnostic('Label at must be in [0,1]')
            if key == 'contour' and (not isinstance(value, int) or value < -1):
                raise ConnectorCaptureDiagnostic('Label contour must be -1 or a nonnegative integer index')
            if key == 'tolerance' and value <= 0:
                raise ConnectorCaptureDiagnostic('Label tolerance must be positive')
        choices = {'route': ('straight', 'orthogonal', 'cubic'), 'order': ('horizontal', 'vertical'),
                   'mode': ('parameter', 'length'), 'rotate': ('horizontal', 'tangent', 'upright')}
        if key in choices and value not in choices[key]:
            raise ConnectorCaptureDiagnostic(f'Connector {key} must be one of {", ".join(choices[key])}')
        if key == 'anchor' and value not in NAMES:
            raise ConnectorCaptureDiagnostic('Unknown path label anchor name')
        result[key] = value
    if not label and 'order' in result and result.get('route', 'straight') != 'orthogonal':
        raise ConnectorCaptureDiagnostic('Connector order requires route=orthogonal')
    return result


def _space(text: str) -> dict:
    if text == 'scene':
        return {'kind': 'scene'}
    if isinstance(text, str):
        kind, separator, node = text.partition(':')
        if separator and kind in ('local', 'parent', 'plot') and node and node.strip() == node:
            return {'kind': kind, 'node': node}
    raise ConnectorCaptureDiagnostic('Connector space must be scene, local:node, parent:node or plot:group')


def _span(text: str, path: Path, output: Path) -> dict:
    lines = text.split('\n')
    return {'file': path.relative_to(output).as_posix(), 'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}


def _archive(text: str, path: Path, output: Path) -> dict:
    folder = output / 'connector-sources'; folder.mkdir(parents=True, exist_ok=True)
    archived = folder / path.name; temporary = archived.with_suffix(archived.suffix + '.tmp')
    shutil.copyfile(path, temporary); temporary.replace(archived)
    return _span(text, archived, output)


def _expression(text: str, base: str, socket: str, output: Path) -> dict:
    folder = output / 'connector-sources'; folder.mkdir(parents=True, exist_ok=True)
    archived = folder / f'{base}.{socket}.expression.txt'; temporary = archived.with_suffix(archived.suffix + '.tmp')
    temporary.write_bytes((text + '\n').encode('utf8')); temporary.replace(archived)
    return _span(text, archived, output)


def _output(value) -> bool:
    return isinstance(value, dict) and set(value) == {'operation', 'socket'} and all(
        isinstance(value[key], str) and value[key] for key in ('operation', 'socket'))


def _point(value, space: dict, base: str, socket: str, output: Path, nodes: dict, depth=0,
           expression_writer=None) -> dict:
    writer = _expression if expression_writer is None else expression_writer
    if depth > 32:
        raise ConnectorCaptureDiagnostic('Connector anchor nesting exceeds 32 levels')
    if isinstance(value, str) and value:
        return {'kind': 'node', 'node': value, 'property': 'position', 'space': space}
    if isinstance(value, list) and len(value) == 2 and all(_finite(n) for n in value):
        return {'kind': 'literal', 'value': {'type': 'vec2', 'role': 'point', 'space': space, 'value': value}}
    if _output(value):
        return {'kind': 'output', 'ref': value}
    if isinstance(value, dict) and set(value) == {'expression'} and isinstance(value['expression'], str):
        text = value['expression']
        return {'kind': 'pointExpression', 'expression': text, 'space': space,
                'sourceSpan': writer(text, base, socket, output)}
    if isinstance(value, dict) and set(value) == {'anchor'}:
        anchor = value['anchor']
        if not isinstance(anchor, dict) or not {'source', 'query'} <= set(anchor) or set(anchor) - {'source', 'query', 'innerSep', 'outerSep'}:
            raise ConnectorCaptureDiagnostic('Inline anchor requires source and query, with optional innerSep/outerSep')
        padding = {key: _padding(anchor[key], key) for key in ('innerSep', 'outerSep') if key in anchor}
        source = anchor['source']
        if not isinstance(source, str) or not source:
            raise ConnectorCaptureDiagnostic('Inline anchor source must be a node ID or shape:operation ID')
        if source.startswith('shape:'):
            if not source[6:] or 'innerSep' in padding:
                raise ConnectorCaptureDiagnostic('Shape anchors require an operation ID and do not accept innerSep')
            provider = {'kind': 'shape', 'ref': {'operation': source[6:], 'socket': 'shape'}, **padding}
        else:
            source = source[5:] if source.startswith('node:') else source
            if not source:
                raise ConnectorCaptureDiagnostic('Inline node anchor ID must be nonempty')
            metrics = nodes.get(source, {}).get('anchorMetrics', {})
            if not isinstance(metrics, dict):
                raise ConnectorCaptureDiagnostic('Inline anchor source anchorMetrics must be an object')
            if metrics.get('kind') == 'pgf' and padding:
                raise ConnectorCaptureDiagnostic('Measured PGF anchors do not accept padding overrides; set native node options')
            provider = {'kind': 'node', 'node': source, **padding}
        query = anchor['query']
        if isinstance(query, str) and query in NAMES:
            resolved = {'kind': 'named', 'name': query}
        elif isinstance(query, dict) and set(query) == {'towards'}:
            resolved = {'kind': 'border', 'towards': _point(query['towards'], space, base, socket+'.towards', output, nodes, depth+1,
                                                         expression_writer=writer)}
        else:
            raise ConnectorCaptureDiagnostic('Inline anchor query must be a known name or {"towards": point}')
        return {'kind': 'anchor', 'source': provider, 'query': resolved, 'space': space}
    raise ConnectorCaptureDiagnostic(f'Connector {socket} requires a node ID, [x,y], point expression, output reference or inline anchor')


def _scalar(value, unit: str, base: str, socket: str, output: Path) -> dict:
    if _output(value):
        return {'kind': 'output', 'ref': value}
    if _finite(value):
        return _literal(value, unit)
    if isinstance(value, str):
        return {'kind': 'expression', 'expression': value, 'unit': unit,
                'sourceSpan': _expression(value, base, socket, output)}
    if isinstance(value, dict) and set(value) == {'node', 'property'} and all(isinstance(value[k], str) and value[k] for k in ('node', 'property')):
        return {'kind': 'property', 'node': value['node'], 'property': value['property'], 'unit': unit}
    raise ConnectorCaptureDiagnostic(f'Label {socket} requires a finite number, scalar expression, property or output reference')


def _literal(value, unit='1') -> dict:
    return {'kind': 'literal', 'value': {'type': 'scalar', 'unit': unit, 'value': value}}


def _ref(operation: str, socket: str) -> dict:
    return {'kind': 'output', 'ref': {'operation': operation, 'socket': socket}}


def _transform_path(graph: dict, operation: str, value: dict, source: dict, target: dict, span: dict) -> dict:
    graph['operations'].append({'id': operation, 'operator': 'transformPath', 'version': 1,
        'spaces': {'from': source, 'to': target}, 'inputs': {'path': value,
            'transform': {'kind': 'spaceTransform', 'from': source, 'to': target}}, 'sourceSpan': span})
    return _ref(operation, 'path')


def lower_connectors(records: list[dict], bundle: dict, execution: Path, output: Path) -> None:
    declarations = [record for record in records if record['type'] == 'connector-file']
    if not declarations:
        return
    graph = bundle.setdefault('operationGraph', {'version': 1, 'operations': [], 'bindings': []})
    nodes = {node['id']: node for node in bundle['nodes']}; seen = set()
    for record in declarations:
        base = record.get('file', '')
        if base in seen:
            raise ConnectorCaptureDiagnostic(f'Duplicate connector declaration file: {base}')
        seen.add(base)
        if record.get('kind') not in ('connector', 'label'):
            raise ConnectorCaptureDiagnostic(f'Unknown connector declaration kind: {record.get("kind")}')
        label = record['kind'] == 'label'
        options = _options(_read(execution, base, 'options')[0], label)
        target = _metadata(execution, base, 'target'); node = nodes.get(target, {})
        operation = options.get('id', ('label:' if label else 'connector:')+target)
        text, path = _read(execution, base, 'inputs'); values = _json(text)
        if not isinstance(values, dict):
            raise ConnectorCaptureDiagnostic('Connector inputs must be a JSON object')
        span = _archive(text, path, output)
        if not label:
            if node.get('kind') != 'path' or not node.get('geometry'):
                raise ConnectorCaptureDiagnostic('Connector target must be an existing editable path')
            route = options.get('route', 'straight'); space = _space(options.get('space', 'scene'))
            sockets = {'from', 'to'} | ({'handleA', 'handleB'} if route == 'cubic' else set())
            if set(values) != sockets:
                raise ConnectorCaptureDiagnostic(f'{route} connector requires exactly {", ".join(sorted(sockets))}')
            inputs = {key: _point(value, space, base, key, output, nodes) for key, value in values.items()}
            if route == 'orthogonal':
                inputs['order'] = _literal(0 if options.get('order', 'horizontal') == 'horizontal' else 1)
            graph['operations'].append({'id': operation, 'operator': {'straight':'connectStraight','orthogonal':'connectOrthogonal','cubic':'connectCubic'}[route],
                'version': 1, 'spaces': {'space': space}, 'inputs': inputs, 'sourceSpan': span})
            local = {'kind': 'local', 'node': target}; value = _ref(operation, 'path')
            if local != space:
                value = _transform_path(graph, operation+':local', value, space, local, span)
            graph['bindings'].append({'target': target, 'property': 'geometry', 'value': value['ref'], 'sourceSpan': span})
            continue
        if node.get('kind') != 'tex':
            raise ConnectorCaptureDiagnostic('Path label target must be an existing raw TeX node')
        units = {'parameter':'1','offset':'bp','tolerance':'bp','scaleX':'1','scaleY':'1'}
        if 'path' not in values or set(values)-set(units)-{'path'}:
            raise ConnectorCaptureDiagnostic('Path label inputs require path and optional parameter/offset/tolerance/scaleX/scaleY')
        space = {'kind':'parent','node':target}; local = {'kind':'local','node':target}
        path_value = values['path']
        if isinstance(path_value, str) and path_value:
            path_input = {'kind':'path','node':path_value,'space':space}
        elif _output(path_value):
            path_input = {'kind':'output','ref':path_value}
        elif isinstance(path_value, dict) and set(path_value)=={'operation','socket','space'} and _output({k:v for k,v in path_value.items() if k!='space'}):
            source = _space(path_value['space'])
            path_input = {'kind':'output','ref':{k:v for k,v in path_value.items() if k!='space'}}
            if source != space:
                path_input = _transform_path(graph, operation+':path', path_input, source, space, span)
        else:
            raise ConnectorCaptureDiagnostic('Label path requires a path node ID or an output reference with optional explicit space')
        inputs = {'path':path_input,'anchor':{'kind':'textAnchor','node':target,'anchor':options.get('anchor','center')}}
        for key, name in [('inner-sep','innerSep'),('outer-sep','outerSep')]:
            if key in options:
                inputs['anchor'][name] = options[key]
        scalar_options = {'at':'parameter','offset':'offset','tolerance':'tolerance','scale-x':'scaleX','scale-y':'scaleY'}
        for option, socket in scalar_options.items():
            if option in options and socket in values:
                raise ConnectorCaptureDiagnostic(f'Label {socket} specified in both options and JSON')
        for key in units:
            if key in values:
                inputs[key] = _scalar(values[key], units[key], base, key, output)
        for option, socket in scalar_options.items():
            if option in options:
                inputs[socket] = _literal(options[option], units[socket])
        for key, mapping in [('mode',{'parameter':0,'length':1}),('rotate',{'horizontal':0,'tangent':1,'upright':2})]:
            if key in options:
                inputs['rotation' if key=='rotate' else key] = _literal(mapping[options[key]])
        if 'contour' in options:
            inputs['contour'] = _literal(options['contour'])
        transform = node.get('transform', {})
        if not isinstance(transform, dict):
            raise ConnectorCaptureDiagnostic('Path label target transform must be an object')
        scale = transform.get('scale', [1,1])
        if not isinstance(scale, list) or len(scale) != 2 or not all(_finite(value) for value in scale):
            raise ConnectorCaptureDiagnostic('Path label target transform.scale must be a finite pair')
        for index, key in enumerate(('scaleX','scaleY')):
            if key not in inputs:
                inputs[key] = _literal(scale[index])
        graph['operations'].append({'id':operation,'operator':'placePathLabel','version':1,
            'spaces':{'space':space,'label':local},'inputs':inputs,'sourceSpan':span})
        for property_name, socket in [('transform','transform'),('x','x'),('y','y')]:
            graph['bindings'].append({'target':target,'property':property_name,
                'value':{'operation':operation,'socket':socket},'sourceSpan':span})
    bundle['version'] = '0.3'
