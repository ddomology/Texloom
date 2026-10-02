"""Explicit mathematical coordinates and bounded, genuinely typeset tick labels.

Catalogs are authored coverage: changing a range never invents new TeX at runtime.
Unlisted ticks remain unlabelled. All renderers consume ordinary paths and nodes.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import re
import shutil
import subprocess

from anchor_capture import NAMES
from connector_capture import _finite, _output, _point, _space, _transform_path


class AxesCaptureDiagnostic(ValueError):
    pass


ROOT = Path(__file__).resolve().parents[1]
COMMON_UNITS = {key: ('bp' if key in ('width', 'height', 'tickSize') else '1')
                for key in ('width', 'height', 'xMin', 'xMax', 'yMin', 'yMax',
                            'xScale', 'yScale', 'logBase', 'xStep', 'yStep', 'tickSize', 'maxTicks')}
TARGETS = ('xAxis', 'yAxis', 'ticks', 'grid')
CATALOG_KEYS = {'axis', 'values', 'precision', 'notation', 'anchor', 'offset', 'scale',
                'style', 'parent', 'idPrefix', 'respectTicks'}


def _read(execution, base, field):
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-axes-[1-9][0-9]*', base):
        raise AxesCaptureDiagnostic('Invalid generated axes filename')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file():
        raise AxesCaptureDiagnostic(f'Missing axes sidecar: {path.name}')
    text = path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text), path


def _json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise AxesCaptureDiagnostic(f'Duplicate JSON key in axes inputs: {key}')
            result[key] = value
        return result
    def nonfinite(value):
        raise AxesCaptureDiagnostic(f'Axes inputs contain nonfinite JSON value {value}')
    try:
        result = json.loads(text, object_pairs_hook=pairs, parse_constant=nonfinite)
    except json.JSONDecodeError as error:
        raise AxesCaptureDiagnostic(f'Invalid axes inputs JSON: {error}') from error
    if not isinstance(result, dict):
        raise AxesCaptureDiagnostic('Axes inputs must be a JSON object')
    return result


def _declarations(records, execution):
    result = []; seen = set()
    for record in records:
        if record['type'] != 'axes-file':
            continue
        base = record.get('file', '')
        if base in seen:
            raise AxesCaptureDiagnostic(f'Duplicate axes declaration file: {base}')
        seen.add(base)
        if record.get('kind') not in ('axes', 'point', 'label', 'ticks'):
            raise AxesCaptureDiagnostic('Unknown axes declaration kind')
        target = _read(execution, base, 'target')[0].strip()
        if not target:
            raise AxesCaptureDiagnostic('Axes ID or target must be nonempty')
        text, path = _read(execution, base, 'inputs')
        result.append((record, target, _json(text), text, path))
    return result


def _span(text, path, output):
    lines = text.split('\n')
    return {'file': path.relative_to(output).as_posix(), 'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}


def _archive(text, path, output):
    folder = output / 'axes-sources'; folder.mkdir(parents=True, exist_ok=True)
    archived = folder / path.name; temporary = archived.with_suffix(archived.suffix + '.tmp')
    shutil.copyfile(path, temporary); temporary.replace(archived)
    return _span(text, archived, output)


def _expression(text, base, socket, output):
    folder = output / 'axes-sources'; folder.mkdir(parents=True, exist_ok=True)
    archived = folder / f'{base}.{socket}.expression.txt'
    temporary = archived.with_suffix(archived.suffix + '.tmp')
    temporary.write_bytes((text + '\n').encode('utf8')); temporary.replace(archived)
    return _span(text, archived, output)


def _literal(value, unit='1'):
    return {'kind': 'literal', 'value': {'type': 'scalar', 'unit': unit, 'value': value}}


def _scalar(value, unit, base, socket, output):
    if _output(value):
        return {'kind': 'output', 'ref': value}
    if _finite(value):
        return _literal(value, unit)
    if isinstance(value, str):
        return {'kind': 'expression', 'expression': value, 'unit': unit,
                'sourceSpan': _expression(value, base, socket, output)}
    if isinstance(value, dict) and set(value) == {'node', 'property'} and all(
            isinstance(value[k], str) and value[k] for k in ('node', 'property')):
        return {'kind': 'property', 'node': value['node'], 'property': value['property'], 'unit': unit}
    raise AxesCaptureDiagnostic(f'Axes {socket} requires a finite number, scalar expression, property or output reference')


def _catalog(values):
    if set(values) - CATALOG_KEYS:
        raise AxesCaptureDiagnostic('Tick catalog contains unsupported fields')
    if values.get('axis') not in ('x', 'y'):
        raise AxesCaptureDiagnostic('Tick catalog axis must be x or y')
    numbers = values.get('values')
    if not isinstance(numbers, list) or not 1 <= len(numbers) <= 256 or not all(_finite(v) for v in numbers):
        raise AxesCaptureDiagnostic('Tick catalog values must contain 1 to 256 finite numbers')
    if len(set(numbers)) != len(numbers):
        raise AxesCaptureDiagnostic('Tick catalog values must be distinct')
    precision = values.get('precision', 6)
    if isinstance(precision, bool) or not isinstance(precision, int) or not 0 <= precision <= 12:
        raise AxesCaptureDiagnostic('Tick catalog precision must be an integer in [0,12]')
    if values.get('notation', 'decimal') not in ('decimal', 'scientific'):
        raise AxesCaptureDiagnostic('Tick catalog notation must be decimal or scientific')
    scale = values.get('scale', 1)
    if not _finite(scale) or scale <= 0:
        raise AxesCaptureDiagnostic('Tick catalog scale must be finite and positive')
    if 'style' in values and not isinstance(values['style'], dict):
        raise AxesCaptureDiagnostic('Tick catalog style must be an object')
    for key in ('parent', 'idPrefix'):
        if key in values and (not isinstance(values[key], str) or not values[key]):
            raise AxesCaptureDiagnostic(f'Tick catalog {key} must be a nonempty ID')
    if 'idPrefix' in values and not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]*', values['idPrefix']):
        raise AxesCaptureDiagnostic('Tick catalog idPrefix must use ASCII letters, digits, underscore or dash')
    if 'anchor' in values and (not isinstance(values['anchor'], str) or values['anchor'] not in NAMES):
        raise AxesCaptureDiagnostic('Unknown tick label anchor')
    if 'offset' in values and (not isinstance(values['offset'], list) or len(values['offset']) != 2):
        raise AxesCaptureDiagnostic('Tick label offset must be a pair')
    respect = values.get('respectTicks', True)
    if not isinstance(respect, (bool, str, dict)) and (not _finite(respect) or respect not in (0, 1)):
        raise AxesCaptureDiagnostic('Tick catalog respectTicks must be boolean, 0/1, or a scalar input')


def prepare_axes_records(records: list[dict], execution: Path) -> None:
    """Add only numeric TeX resources/nodes before normal resource compilation.

    The JS core is the sole formatter. A batch subprocess avoids Python/JS
    rounding differences, and only a strict numeric output grammar enters TeX.
    """
    catalogs = []; declarations = _declarations(records, execution)
    axes_ids = {target for record, target, *_ in declarations if record['kind'] == 'axes'}
    for record, target, values, _text, _path in declarations:
        if record['kind'] == 'ticks':
            if target not in axes_ids:
                raise AxesCaptureDiagnostic(f'{record["file"]}: tick catalog requires an existing axes ID: {target}')
            _catalog(values); catalogs.append((record, target, values))
    if not catalogs:
        return
    request = [{'values': values['values'], 'precision': values.get('precision', 6),
                'notation': values.get('notation', 'decimal')} for _, _, values in catalogs]
    process = subprocess.run(['node', str(ROOT / 'tools/format-axis-ticks.mjs')], input=json.dumps(request),
                             cwd=ROOT, capture_output=True, text=True, encoding='utf8', errors='replace', timeout=60)
    if process.returncode:
        locations = ', '.join(f'{record["file"]} ({target})' for record, target, _ in catalogs)
        raise AxesCaptureDiagnostic(f'Tick label formatting failed for {locations}: ' + process.stderr.strip())
    formatted = json.loads(process.stdout)
    if not isinstance(formatted, list) or len(formatted) != len(catalogs):
        raise AxesCaptureDiagnostic('Invalid tick formatter result')
    resource_ids = {str(record['id']).casefold() for record in records if record['type'] in ('resource', 'field-file')}
    node_ids = {record['value']['id'] for record in records if record['type'] == 'node'}
    for record in records:
        if record['type'].startswith('tikz-') and 'id' in record:
            node_ids.add(record['id'])
            if record['type'] in ('tikz-node', 'tikz-path'):
                node_ids.add(record['id'] + '-art')
    for (record, axes, values), labels in zip(catalogs, formatted):
        if not isinstance(labels, list) or len(labels) != len(values['values']):
            raise AxesCaptureDiagnostic('Invalid tick formatter label count')
        if any(not isinstance(label, str) for label in labels) or len(set(labels)) != len(labels):
            raise AxesCaptureDiagnostic('Distinct authored tick values collapse to duplicate formatted labels; increase precision or reduce magnitude')
        prefix = values.get('idPrefix', 'tlaxes-' + record['file'].rsplit('-', 1)[1])
        generated = []
        for index, (number, label) in enumerate(zip(values['values'], labels)):
            if not isinstance(label, str) or not re.fullmatch(r'-?\d+(?:\.\d+)?(?:e[+-]?\d+)?', label):
                raise AxesCaptureDiagnostic('Tick formatter must produce a finite numeric label')
            resource = f'{prefix}-{index}-r'; node_id = f'{prefix}-{index}-n'
            if resource.casefold() in resource_ids or node_id in node_ids:
                raise AxesCaptureDiagnostic(f'Generated tick label ID collides: {resource} / {node_id}')
            resource_ids.add(resource.casefold()); node_ids.add(node_id)
            if 'e' in label:
                mantissa, exponent = label.split('e'); tex = mantissa + r'\times 10^{' + str(int(exponent)) + '}'
            else:
                tex = label
            asset = execution / ('scene.tl-' + resource + '.tex')
            asset.write_text(tex + '\n', encoding='utf8')
            node = {'id': node_id, 'kind': 'tex', 'resourceId': resource, 'x': 0, 'y': 0,
                    'scale': values.get('scale', 1)}
            for key in ('style', 'parent'):
                if key in values:
                    node[key] = copy.deepcopy(values[key])
            records.extend([{'type': 'resource', 'id': resource, 'kind': 'math', 'file': asset.name},
                            {'type': 'node', 'value': node}])
            placement = {'axes': axes, 'axis': values['axis'], 'value': number,
                         'anchor': values.get('anchor', 'base' if values['axis'] == 'x' else 'base east'),
                         'offset': values.get('offset', [0, 16] if values['axis'] == 'x' else [-9, 0]),
                         'respectTicks': values.get('respectTicks', 1)}
            generated.append({'target': node_id, 'values': placement})
        record['generatedLabels'] = generated


def lower_axes(records: list[dict], bundle: dict, execution: Path, output: Path) -> None:
    declarations = _declarations(records, execution)
    if not declarations:
        return
    graph = bundle.setdefault('operationGraph', {'version': 1, 'operations': [], 'bindings': []})
    nodes = {node['id']: node for node in bundle['nodes']}; axes = {}

    def bind(target, property_name, operation, socket, span):
        graph['bindings'].append({'target': target, 'property': property_name,
                                  'value': {'operation': operation, 'socket': socket}, 'sourceSpan': span})

    # Axes declarations are resolved first, so points and labels may appear before
    # them in source. The graph owns dependency ordering, cycles and writer checks.
    for record, target, values, text, path in declarations:
        if record['kind'] != 'axes':
            continue
        if target in axes:
            raise AxesCaptureDiagnostic(f'Duplicate axes ID: {target}')
        if set(values) - set(COMMON_UNITS) - set(TARGETS) - {'origin', 'space'}:
            raise AxesCaptureDiagnostic('Axes contains unsupported inputs or path target fields')
        base = record['file']; span = _archive(text, path, output)
        space = _space(values.get('space', 'scene'))
        inputs = {'origin': _point(values.get('origin', [0, 0]), space, base, 'origin', output, nodes,
                                  expression_writer=_expression)}
        for key, unit in COMMON_UNITS.items():
            if key not in values:
                continue
            value = values[key]
            if key in ('xScale', 'yScale') and isinstance(value, str) and value in ('linear', 'log'):
                value = {'linear': 0, 'log': 1}[value]
            inputs[key] = _scalar(value, unit, base, key, output)
        graph['operations'].append({'id': target, 'operator': 'cartesianAxes', 'version': 1,
                                     'spaces': {'space': space}, 'inputs': inputs, 'sourceSpan': span})
        for socket in TARGETS:
            if socket not in values:
                continue
            node_id = values[socket]
            if not isinstance(node_id, str) or nodes.get(node_id, {}).get('kind') != 'path' or not nodes[node_id].get('geometry'):
                raise AxesCaptureDiagnostic(f'Axes {socket} target must be an existing editable path')
            ref = {'kind': 'output', 'ref': {'operation': target, 'socket': socket}}
            local = {'kind': 'local', 'node': node_id}
            if space != local:
                ref = _transform_path(graph, target + ':' + socket + ':local', ref, space, local, span)
            graph['bindings'].append({'target': node_id, 'property': 'geometry', 'value': ref['ref'], 'sourceSpan': span})
        axes[target] = (space, inputs)

    def placement(kind, target, values, base, span, suffix=''):
        axes_id = values.get('axes')
        if not isinstance(axes_id, str) or axes_id not in axes:
            raise AxesCaptureDiagnostic('Point and label require an existing axes ID')
        space, common = axes[axes_id]; inputs = copy.deepcopy(common)
        # Mapping operators do not consume the rendering-only tickSize/maxTicks.
        if kind == 'point':
            for key in ('xStep', 'yStep', 'tickSize', 'maxTicks'):
                inputs.pop(key, None)
            if set(values) - {'axes', 'x', 'y'} or not {'x', 'y'} <= set(values):
                raise AxesCaptureDiagnostic('Data point requires axes, x and y only')
            if nodes.get(target, {}).get('kind') not in ('point', 'ellipse', 'tex'):
                raise AxesCaptureDiagnostic('Data point target must be a point, ellipse or raw TeX node')
            for key in ('x', 'y'):
                inputs[key] = _scalar(values[key], '1', base, suffix + key, output)
            operation = 'data:' + target
            graph['operations'].append({'id': operation, 'operator': 'dataToScene', 'version': 1,
                                         'spaces': {'space': space}, 'inputs': inputs, 'sourceSpan': span})
            socket = 'point'
            if space != {'kind': 'scene'}:
                mapped = operation + ':scene'
                graph['operations'].append({'id': mapped, 'operator': 'transformPoint', 'version': 1,
                    'spaces': {'from': space, 'to': {'kind': 'scene'}}, 'inputs': {
                        'point': {'kind': 'output', 'ref': {'operation': operation, 'socket': 'point'}},
                        'transform': {'kind': 'spaceTransform', 'from': space, 'to': {'kind': 'scene'}}}, 'sourceSpan': span})
                operation = mapped; socket = 'position'
            bind(target, 'position', operation, socket, span)
            return
        inputs.pop('tickSize', None)
        if set(values) - {'axes', 'x', 'y', 'value', 'axis', 'respectTicks', 'anchor', 'offset'}:
            raise AxesCaptureDiagnostic('Axis label contains unsupported fields')
        node = nodes.get(target, {})
        measured_group = node.get('kind') == 'group' and node.get('anchorMetrics', {}).get('kind') == 'pgf'
        if node.get('kind') != 'tex' and not measured_group:
            raise AxesCaptureDiagnostic('Axis label target must be a TeX node or a measured loomnode group')
        axis = values.get('axis', 'point')
        if axis not in ('point', 'x', 'y'):
            raise AxesCaptureDiagnostic('Axis label axis must be point, x or y')
        if axis == 'point':
            if 'value' in values or not {'x', 'y'} <= set(values):
                raise AxesCaptureDiagnostic('Point label requires x and y, without value')
            coordinates = {'x': values['x'], 'y': values['y']}
        else:
            if 'value' not in values or {'x', 'y'} & set(values):
                raise AxesCaptureDiagnostic('Tick label requires value, without x or y')
            coordinates = {'x': values['value'] if axis == 'x' else 0,
                           'y': values['value'] if axis == 'y' else 0}
        for key, value in coordinates.items():
            inputs[key] = _scalar(value, '1', base, suffix + key, output)
        offset = values.get('offset', [0, 0])
        if not isinstance(offset, list) or len(offset) != 2:
            raise AxesCaptureDiagnostic('Axis label offset must be a pair')
        for key, value in zip(('offsetX', 'offsetY'), offset):
            inputs[key] = _scalar(value, 'bp', base, suffix + key, output)
        anchor = values.get('anchor', 'base')
        if not isinstance(anchor, str) or anchor not in NAMES:
            raise AxesCaptureDiagnostic('Unknown axis label anchor')
        local = {'kind': 'local', 'node': target}; parent = {'kind': 'parent', 'node': target}
        # Compiled PGF group anchors are immutable layout metadata. Reading a
        # generic world-space anchor here would introduce a false self-pose cycle.
        anchor_input = ({'kind': 'literal', 'value': {'type': 'vec2', 'role': 'point', 'space': local,
                         'value': copy.deepcopy(node['anchors'][anchor])}} if measured_group
                        else {'kind': 'textAnchor', 'node': target, 'anchor': anchor})
        respect = values.get('respectTicks', 1)
        if isinstance(respect, bool):
            respect = int(respect)
        inputs.update({'axis': _literal({'point': -1, 'x': 0, 'y': 1}[axis]),
                       'respectTicks': _scalar(respect, '1', base, suffix + 'respectTicks', output),
                       'anchor': anchor_input,
                       'mapping': {'kind': 'spaceTransform', 'from': space, 'to': parent}})
        operation = 'axislabel:' + target
        graph['operations'].append({'id': operation, 'operator': 'placeAxisLabel', 'version': 1,
            'spaces': {'space': space, 'label': local, 'parent': parent}, 'inputs': inputs, 'sourceSpan': span})
        for property_name, socket in [('transform', 'transform'), ('x', 'x'), ('y', 'y'), ('style.opacity', 'opacity')]:
            if measured_group and property_name in ('x', 'y'):
                continue
            bind(target, property_name, operation, socket, span)

    for record, target, values, text, path in declarations:
        if record['kind'] == 'axes':
            continue
        base = record['file']; span = _archive(text, path, output)
        if record['kind'] == 'ticks':
            if 'generatedLabels' not in record:
                raise AxesCaptureDiagnostic('Tick catalogs must be prepared before resource compilation')
            for index, label in enumerate(record['generatedLabels']):
                placement('label', label['target'], label['values'], base, span, f'label-{index}-')
        else:
            placement(record['kind'], target, values, base, span)
    bundle['version'] = '0.3'
