"""Lower opt-in measured anchors and literal placement declarations."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import re
import shutil


class AnchorCaptureDiagnostic(ValueError):
    pass


NAMES = {'center', 'north', 'south', 'east', 'west', 'north east', 'north west',
         'south east', 'south west', 'base', 'base west', 'base east', 'mid'}


def _read(execution: Path, base: str, field: str) -> tuple[str, Path]:
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-anchor-[1-9][0-9]*', base):
        raise AnchorCaptureDiagnostic('Invalid generated anchor filename')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file():
        raise AnchorCaptureDiagnostic(f'Missing anchor sidecar: {path.name}')
    text = path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text), path


def _metadata(execution: Path, base: str, field: str) -> str:
    text = _read(execution, base, field)[0].strip()
    if not text:
        raise AnchorCaptureDiagnostic(f'Anchor {field} must be nonempty')
    return text


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
                raise AnchorCaptureDiagnostic(f'Duplicate JSON key in anchor inputs: {key}')
            result[key] = value
        return result
    def nonfinite(value):
        raise AnchorCaptureDiagnostic(f'Anchor inputs contain nonfinite JSON value {value}')
    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=nonfinite)
    except json.JSONDecodeError as error:
        raise AnchorCaptureDiagnostic(f'Invalid anchor inputs JSON: {error}') from error


def _options(text: str, place: bool) -> dict:
    # xparse accepts a bracket pair within the outer optional argument. Split
    # only commas outside that pair so asymmetric padding remains literal.
    entries, start, depth = [], 0, 0
    for index, character in enumerate(text):
        if character == '[':
            depth += 1
        elif character == ']':
            depth -= 1
            if depth < 0:
                raise AnchorCaptureDiagnostic('Unbalanced anchor option brackets')
        elif character == ',' and depth == 0:
            entries.append(text[start:index])
            start = index + 1
    if depth:
        raise AnchorCaptureDiagnostic('Unbalanced anchor option brackets')
    entries.append(text[start:])
    result = {}
    allowed = {'id', 'innerSep', 'outerSep', 'anchor' if place else 'space'}
    for entry in entries:
        if not entry.strip():
            continue
        if '=' not in entry:
            raise AnchorCaptureDiagnostic(f'Anchor option requires key=value: {entry.strip()}')
        key, value = (part.strip() for part in entry.split('=', 1))
        if key not in allowed:
            raise AnchorCaptureDiagnostic(f'Unknown anchor option: {key}')
        if key in result:
            raise AnchorCaptureDiagnostic(f'Duplicate anchor option: {key}')
        if not value:
            raise AnchorCaptureDiagnostic(f'Anchor option {key} must be nonempty')
        if key in ('innerSep', 'outerSep'):
            value = _json(value)
            if _finite(value):
                value = [value, value]
            if not isinstance(value, list) or len(value) != 2 or not all(_finite(n) and n >= 0 for n in value):
                raise AnchorCaptureDiagnostic(f'Anchor {key} must be a nonnegative scalar or pair')
        result[key] = value
    if place and result.get('anchor', 'base west') not in NAMES:
        raise AnchorCaptureDiagnostic('Unknown placement anchor name')
    return result


def _space(text: str) -> dict:
    if text == 'scene':
        return {'kind': 'scene'}
    kind, separator, node = text.partition(':')
    if separator and kind in ('local', 'parent', 'plot') and node and node.strip() == node:
        return {'kind': kind, 'node': node}
    raise AnchorCaptureDiagnostic('Anchor space must be scene, local:node, parent:node or plot:group')


def _span(text: str, path: Path, output: Path) -> dict:
    lines = text.split('\n')
    return {'file': path.relative_to(output).as_posix(), 'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}


def _archive(text: str, path: Path, output: Path) -> dict:
    folder = output / 'anchor-sources'
    folder.mkdir(parents=True, exist_ok=True)
    archived = folder / path.name
    temporary = archived.with_suffix(archived.suffix + '.tmp')
    shutil.copyfile(path, temporary)
    temporary.replace(archived)
    return _span(text, archived, output)


def _point(value, space: dict, base: str, socket: str, output: Path) -> dict:
    if isinstance(value, str) and value:
        return {'kind': 'node', 'node': value, 'property': 'position', 'space': space}
    if isinstance(value, list) and len(value) == 2 and all(_finite(n) for n in value):
        return {'kind': 'literal', 'value': {'type': 'vec2', 'role': 'point', 'space': space, 'value': value}}
    if isinstance(value, dict) and set(value) == {'operation', 'socket'} and all(
            isinstance(value[key], str) and value[key] for key in ('operation', 'socket')):
        return {'kind': 'output', 'ref': value}
    if isinstance(value, dict) and set(value) == {'expression'} and isinstance(value['expression'], str):
        text = value['expression']
        folder = output / 'anchor-sources'
        folder.mkdir(parents=True, exist_ok=True)
        archived = folder / f'{base}.{socket}.expression.txt'
        temporary = archived.with_suffix(archived.suffix + '.tmp')
        temporary.write_bytes((text + '\n').encode('utf8'))
        temporary.replace(archived)
        return {'kind': 'pointExpression', 'expression': text, 'space': space,
                'sourceSpan': _span(text, archived, output)}
    raise AnchorCaptureDiagnostic('Anchor point requires a node ID, [x,y], point expression or output reference')


def _attach_metrics(records: list[dict], bundle: dict) -> None:
    if not any(record['type'] == 'anchor-profile' for record in records):
        return
    nodes = {node['id']: node for node in bundle['nodes']}
    for record in records:
        if record['type'] != 'tikz-node':
            continue
        resource = bundle['resources'][record['resourceId']]
        measured = resource['provenance']['pgfCapture']
        corners = measured.get('logicalCorners', [])
        if len(corners) != 4 or 'text-metrics' not in measured:
            raise AnchorCaptureDiagnostic('PGF node is missing its opt-in logical text measurement')
        center = measured['anchors']['center']
        xs = [p[0] - center[0] for p in corners]
        ys = [center[1] - p[1] for p in corners]
        metrics = {'kind': 'pgf', 'shape': measured['shape'],
                   'logicalTextBox': [round(n, 8) for n in [min(xs), min(ys), max(xs)-min(xs), max(ys)-min(ys)]],
                   'textMetrics': dict(zip(('width', 'height', 'depth'), measured['text-metrics'])),
                   'innerSep': measured['inner-sep'], 'outerSep': measured['outer-sep'],
                   'alignment': measured['alignment']}
        revision = {'sourceSha256': resource['provenance']['texSha256'], 'metrics': metrics,
                    'anchors': nodes[record['id']]['anchors']}
        metrics['revision'] = hashlib.sha256(json.dumps(revision, sort_keys=True, separators=(',', ':')).encode('utf8')).hexdigest()
        nodes[record['id']]['anchorMetrics'] = metrics


def lower_anchors(records: list[dict], bundle: dict, execution: Path, output: Path) -> None:
    _attach_metrics(records, bundle)
    declarations = [record for record in records if record['type'] == 'anchor-file']
    if not declarations:
        return
    graph = bundle.setdefault('operationGraph', {'version': 1, 'operations': [], 'bindings': []})
    nodes = {node['id']: node for node in bundle['nodes']}
    seen = set()
    for record in declarations:
        base = record.get('file', '')
        if base in seen:
            raise AnchorCaptureDiagnostic(f'Duplicate anchor declaration file: {base}')
        seen.add(base)
        if record.get('kind') not in ('anchor', 'place'):
            raise AnchorCaptureDiagnostic(f'Unknown anchor declaration kind: {record.get("kind")}')
        place = record['kind'] == 'place'
        options = _options(_read(execution, base, 'options')[0], place)
        target = _metadata(execution, base, 'target')
        operation_id = options.get('id', ('placement:' if place else 'anchor:') + target)
        space = _space(options.get('space', 'scene'))
        text, path = _read(execution, base, 'inputs')
        values = _json(text)
        source_span = _archive(text, path, output)
        padding = {key: options[key] for key in ('innerSep', 'outerSep') if key in options}
        if place:
            value = {'kind': 'textPlacement', 'node': target, 'anchor': options.get('anchor', 'base west'),
                     'point': _point(values, space, base, 'point', output), **padding}
        else:
            source_text = _metadata(execution, base, 'source')
            if source_text.startswith('shape:'):
                if not source_text[6:]:
                    raise AnchorCaptureDiagnostic('Shape anchor source operation ID must be nonempty')
                if 'innerSep' in padding:
                    raise AnchorCaptureDiagnostic('Shape anchor sources do not accept innerSep')
                source = {'kind': 'shape', 'ref': {'operation': source_text[6:], 'socket': 'shape'}, **padding}
            else:
                node_id = source_text[5:] if source_text.startswith('node:') else source_text
                if not node_id:
                    raise AnchorCaptureDiagnostic('Node anchor source ID must be nonempty')
                if nodes.get(node_id, {}).get('anchorMetrics', {}).get('kind') == 'pgf' and padding:
                    raise AnchorCaptureDiagnostic('Measured PGF anchors do not accept padding overrides; set padding in the native node options')
                source = {'kind': 'node', 'node': node_id, **padding}
            if isinstance(values, str) and values in NAMES:
                query = {'kind': 'named', 'name': values}
            elif isinstance(values, dict) and set(values) == {'towards'}:
                query = {'kind': 'border', 'towards': _point(values['towards'], space, base, 'towards', output)}
            else:
                raise AnchorCaptureDiagnostic('Anchor query must be a known name or {"towards": point}')
            value = {'kind': 'anchor', 'source': source, 'query': query, 'space': space}
        graph['operations'].append({'id': operation_id, 'operator': 'midpoint', 'version': 1,
                                    'spaces': {'space': space}, 'inputs': {'a': value, 'b': value}, 'sourceSpan': source_span})
        binding_id = operation_id
        if space['kind'] != 'scene':
            binding_id += ':scene'
            scene = {'kind': 'scene'}
            graph['operations'].append({'id': binding_id, 'operator': 'transformPoint', 'version': 1,
                'spaces': {'from': space, 'to': scene}, 'inputs': {
                    'point': {'kind': 'output', 'ref': {'operation': operation_id, 'socket': 'position'}},
                    'transform': {'kind': 'spaceTransform', 'from': space, 'to': scene}}, 'sourceSpan': source_span})
        graph['bindings'].append({'target': target, 'property': 'position',
                                 'value': {'operation': binding_id, 'socket': 'position'}, 'sourceSpan': source_span})
    bundle['version'] = '0.3'
