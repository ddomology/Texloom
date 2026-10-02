"""Lower literal TeX plot declarations into a portable mathematical program.

Axes inputs are copied by value, retaining their typed expression/output reads.
No expression is evaluated by Python and no renderer receives data coordinates.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import re
import shutil

from connector_capture import _finite, _output


class PlotCaptureDiagnostic(ValueError):
    pass


MAPPING_INPUTS = ('origin', 'width', 'height', 'xMin', 'xMax', 'yMin', 'yMax',
                  'xScale', 'yScale', 'logBase')
QUALITY_INPUTS = ('tolerance', 'pixelsPerBp', 'initialSegments', 'maxDepth',
                  'maxSamples', 'maxSegments')
EXPRESSION_FIELDS = {'function': ('expression',),
                     'parametric': ('xExpression', 'yExpression'),
                     'area': ('lower', 'upper'), 'samples': ()}


def _read(execution: Path, base: str, field: str) -> tuple[str, Path]:
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-plot-[1-9][0-9]*', base):
        raise PlotCaptureDiagnostic('Invalid generated plot filename')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file():
        raise PlotCaptureDiagnostic(f'Missing plot sidecar: {path.name}')
    text = path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text), path


def _json(text: str) -> dict:
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise PlotCaptureDiagnostic(f'Duplicate JSON key in plot inputs: {key}')
            result[key] = value
        return result

    def nonfinite(value):
        raise PlotCaptureDiagnostic(f'Plot inputs contain nonfinite JSON value {value}')

    try:
        value = json.loads(text, object_pairs_hook=pairs, parse_constant=nonfinite)
    except json.JSONDecodeError as error:
        raise PlotCaptureDiagnostic(f'Invalid plot inputs JSON: {error}') from error
    if not isinstance(value, dict):
        raise PlotCaptureDiagnostic('Plot inputs must be a JSON object')
    return value


def _span(text: str, path: Path, output: Path) -> dict:
    lines = text.split('\n')
    return {'file': path.relative_to(output).as_posix(), 'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}


def _archive(text: str, path: Path, output: Path) -> dict:
    folder = output / 'plot-sources'; folder.mkdir(parents=True, exist_ok=True)
    archived = folder / path.name; temporary = archived.with_suffix(archived.suffix + '.tmp')
    shutil.copyfile(path, temporary); temporary.replace(archived)
    return _span(text, archived, output)


def _expression(text: str, base: str, socket: str, output: Path) -> dict:
    folder = output / 'plot-sources'; folder.mkdir(parents=True, exist_ok=True)
    archived = folder / f'{base}.{socket}.expression.txt'
    temporary = archived.with_suffix(archived.suffix + '.tmp')
    temporary.write_bytes((text + '\n').encode('utf8')); temporary.replace(archived)
    return _span(text, archived, output)


def _scalar(value, base: str, socket: str, output: Path) -> dict:
    if _output(value):
        return {'kind': 'output', 'ref': copy.deepcopy(value)}
    if _finite(value):
        return {'kind': 'literal', 'value': {'type': 'scalar', 'unit': '1', 'value': value}}
    if isinstance(value, str) and value.strip():
        return {'kind': 'expression', 'expression': value, 'unit': '1',
                'sourceSpan': _expression(value, base, socket, output)}
    if isinstance(value, dict) and set(value) == {'node', 'property'} and all(
            isinstance(value[key], str) and value[key] for key in ('node', 'property')):
        return {'kind': 'property', 'node': value['node'], 'property': value['property'], 'unit': '1'}
    raise PlotCaptureDiagnostic(f'Plot {socket} requires a finite number, scalar expression, property or output reference')


def _domains(value) -> None:
    if not isinstance(value, list) or not 1 <= len(value) <= 128:
        raise PlotCaptureDiagnostic('Plot domains must contain 1 to 128 finite increasing intervals')
    previous = None
    for interval in value:
        if (not isinstance(interval, list) or len(interval) != 2 or
                not all(_finite(number) for number in interval) or interval[0] >= interval[1]):
            raise PlotCaptureDiagnostic('Plot domain intervals require two finite values with min < max')
        if previous is not None and interval[0] < previous:
            raise PlotCaptureDiagnostic('Plot domain intervals must be sorted and disjoint')
        previous = interval[1]


def _breaks(value, domains) -> None:
    if (not isinstance(value, list) or len(value) > 1024 or not all(_finite(number) for number in value)
            or any(a >= b for a, b in zip(value, value[1:]))):
        raise PlotCaptureDiagnostic('Plot breaks must contain at most 1024 finite, strictly increasing values')
    if any(not any(start <= number <= end for start, end in domains) for number in value):
        raise PlotCaptureDiagnostic('Every plot break must belong to an authored domain')


def _samples(value) -> None:
    if not isinstance(value, list) or not 2 <= len(value) <= 65536:
        raise PlotCaptureDiagnostic('Plot samples must contain 2 to 65536 points or explicit null holes')
    for point in value:
        if point is not None and (not isinstance(point, list) or len(point) != 2 or
                                  not all(_finite(number) for number in point)):
            raise PlotCaptureDiagnostic('Plot samples require finite numeric pairs; only explicit null denotes a hole')


def lower_plots(records: list[dict], bundle: dict, execution: Path, output: Path) -> None:
    declarations = [record for record in records if record['type'] == 'plot-file']
    if not declarations:
        return
    if 'plots' in bundle:
        raise PlotCaptureDiagnostic('A plot program already exists in this bundle')
    nodes = {node['id']: node for node in bundle['nodes']}
    axes = {operation['id']: operation for operation in bundle.get('operationGraph', {}).get('operations', [])
            if operation['operator'] == 'cartesianAxes' and operation['version'] == 1}
    operations = []; seen_files = set(); seen_targets = set()
    for record in declarations:
        base = record.get('file', '')
        if base in seen_files:
            raise PlotCaptureDiagnostic(f'Duplicate plot declaration file: {base}')
        seen_files.add(base)
        target = _read(execution, base, 'target')[0].strip()
        if not target or nodes.get(target, {}).get('kind') != 'path' or not nodes[target].get('geometry'):
            raise PlotCaptureDiagnostic('Plot target must be an existing editable path')
        if target in seen_targets:
            raise PlotCaptureDiagnostic(f'Duplicate plot target: {target}')
        seen_targets.add(target)
        text, path = _read(execution, base, 'inputs'); values = _json(text)
        mode = values.get('mode')
        if not isinstance(mode, str) or mode not in EXPRESSION_FIELDS:
            raise PlotCaptureDiagnostic('Plot mode must be function, parametric, samples or area')
        quality = ('maxSamples', 'maxSegments') if mode == 'samples' else QUALITY_INPUTS
        allowed = {'axes', 'mode', 'version', *quality, *EXPRESSION_FIELDS[mode]}
        allowed |= {'samples'} if mode == 'samples' else {'domains', 'breaks', 'mask'}
        if set(values) - allowed:
            raise PlotCaptureDiagnostic('Plot contains unsupported fields for its mode: ' + ', '.join(sorted(set(values) - allowed)))
        if isinstance(values.get('version', 1), bool) or values.get('version', 1) != 1:
            raise PlotCaptureDiagnostic('Only plot version 1 is supported')
        axis_id = values.get('axes')
        if not isinstance(axis_id, str) or axis_id not in axes:
            raise PlotCaptureDiagnostic('Plot requires an existing Cartesian axes ID')
        axis = axes[axis_id]
        operation = {'id': 'plot:' + target, 'target': target, 'mode': mode,
                     'space': copy.deepcopy(axis['spaces']['space']),
                     'inputs': {key: copy.deepcopy(value) for key, value in axis['inputs'].items() if key in MAPPING_INPUTS},
                     'sourceSpan': _archive(text, path, output)}
        if mode == 'samples':
            _samples(values.get('samples')); operation['samples'] = copy.deepcopy(values['samples'])
        else:
            _domains(values.get('domains')); operation['domains'] = copy.deepcopy(values['domains'])
            if 'breaks' in values:
                _breaks(values['breaks'], values['domains']); operation['breaks'] = copy.deepcopy(values['breaks'])
            fields = EXPRESSION_FIELDS[mode] + (('mask',) if 'mask' in values else ())
            operation['expressionSpans'] = {}
            for key in fields:
                expression = values.get(key)
                if not isinstance(expression, str) or not expression.strip():
                    raise PlotCaptureDiagnostic(f'Plot {key} must be a nonempty expression string')
                operation[key] = expression
                operation['expressionSpans'][key] = _expression(expression, base, key, output)
        for key in quality:
            if key in values:
                operation['inputs'][key] = _scalar(values[key], base, key, output)
        operations.append(operation)
    bundle['version'] = '0.3'
    bundle['plots'] = {'version': 1, 'operations': operations}
