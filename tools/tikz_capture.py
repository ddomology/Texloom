"""Capture PGF measurements and lower executed declarations into public IR.

This module consumes TeX-generated records; it never interprets TikZ source.
Node geometry, text, styles, and anchors have already been evaluated by PGF.
"""
from __future__ import annotations
import math

PT_TO_BP = 72 / 72.27

CAPTURE_PREAMBLE = r'''
\makeatletter
\newwrite\TLMcapturefile
\newdimen\TLMcapturex
\newdimen\TLMcapturey
\def\TLMsavepoint#1#2{%
  \pgf@process{#2}%
  \immediate\write\TLMcapturefile{#1:\the\pgf@x,\the\pgf@y}}
\def\TLMCaptureBounds{%
  \immediate\write\TLMcapturefile{bounds:\the\pgf@picminx,\the\pgf@picminy,\the\pgf@picmaxx,\the\pgf@picmaxy}}
\def\TLMCaptureNode#1{%
  \immediate\openout\TLMcapturefile=asset.anchors
  \def\TLMcapturedname{#1}%
  \edef\TLMcapturedshape{\csname pgf@sh@ns@#1\endcsname}%
  \immediate\write\TLMcapturefile{shape:\TLMcapturedshape}%
  \@for\TLManchorname:=center,north,south,east,west,north east,north west,south east,south west,base,mid\do{%
    \ifcsname pgf@anchor@\TLMcapturedshape @\TLManchorname\endcsname
      \TLMsavepoint{\TLManchorname}{\pgfpointanchor{#1}{\TLManchorname}}%
    \else
      \immediate\write\TLMcapturefile{missing:\TLManchorname}%
    \fi}%
  \TLMCaptureBounds
  \immediate\closeout\TLMcapturefile}
\def\TLMCaptureOrigin{%
  \immediate\openout\TLMcapturefile=asset.anchors
  \TLMCaptureBounds
  \immediate\closeout\TLMcapturefile}
\makeatother
'''


def read_capture(path):
    result = {'anchors': {}, 'missing': []}
    for line in path.read_text(encoding='utf8').splitlines():
        key, value = line.split(':', 1)
        if key == 'shape':
            result['shape'] = value.strip()
        elif key == 'missing':
            result['missing'].append(value.strip())
        else:
            values = [round(float(v.strip().removesuffix('pt')) * PT_TO_BP, 8) for v in value.split(',')]
            if key == 'bounds':
                result['bounds'] = values
            else:
                result['anchors'][key] = values
    if 'bounds' not in result:
        raise ValueError('TikZ capture did not produce picture bounds')
    return result


def endpoint(value):
    parts = value.rsplit('.', 1)
    if len(parts) != 2 or not all(parts):
        raise ValueError(f'Endpoint must name a node and anchor, e.g. A.east: {value}')
    return {'node': parts[0].strip(), 'anchor': parts[1].strip()}


def lower_records(records, bundle, source_name):
    """Expand named TikZ objects after all their resources have been measured."""
    pending_animations = []
    nodes = bundle['nodes']
    for number, record in enumerate(records, 1):
        kind = record['type']
        if not kind.startswith('tikz-'):
            continue
        if kind == 'tikz-animation':
            if record['property'] == 'transform.rotate':
                record = {**record, 'to': math.radians(record['to'])}
            pending_animations.append(record)
            continue
        node = {'id': record['id'], 'source': {'file': source_name, 'declaration': number, 'line': record.get('line')}}
        if record.get('parent'):
            node['parent'] = record['parent']
        if kind in ('tikz-node', 'tikz-path'):
            resource = bundle['resources'][record['resourceId']]
            measured = resource['provenance']['pgfCapture']
            bounds = measured['bounds']
            center = measured['anchors'].get('center', [0, 0])
            node.update(kind='group', transform={'translate': [record['x'], record['y']]})
            if kind == 'tikz-node':
                node['anchors'] = {name: [round(p[0] - center[0], 8), round(center[1] - p[1], 8)] for name, p in measured['anchors'].items()}
            else:
                node['transform']['scale'] = [record['scale'], record['scale']]
            nodes.append(node)
            nodes.append({'id': record['id'] + '-art', 'kind': 'tex', 'parent': record['id'],
                          'resourceId': record['resourceId'], 'x': round(bounds[0] - center[0], 8),
                          'y': round(center[1], 8), 'source': {'file': source_name, 'declaration': number}})
        elif kind == 'tikz-connect':
            node.update(kind='path', d='M 0 0 L 0 0', arrowStart=record['arrowStart'], arrowEnd=record['arrowEnd'],
                        arrowSize=record['arrowSize'], style={'stroke': '#' + record['hex'], 'fill': 'none',
                        'strokeWidth': round(record['lineWidthPt'] * PT_TO_BP, 8), 'opacity': record['opacity'], 'lineCap': 'round'})
            nodes.append(node)
            bundle['relations'].append({'type': 'connect', 'target': node['id'], 'from': endpoint(record['from']),
                                        'to': endpoint(record['to']), 'bend': record['bend']})
        elif kind == 'tikz-label':
            node.update(kind='tex', resourceId=record['resourceId'], x=0, y=0, scale=record['scale'], style={'fill': '#' + record['hex']})
            nodes.append(node)
            bundle['relations'].append({'type': 'pathLabel', 'target': node['id'], 'path': record['path'],
                                        'position': record['position'], 'offset': record['offset'], 'rotate': record['rotate']})
        else:
            raise ValueError(f'Unknown executed TikZ record type: {kind}')
    # Normal scene nodes and generated objects retain the authored paint order.
    nodes.sort(key=lambda n: n.get('source', {}).get('declaration', 0))
    for node in nodes:
        if node.get('parent') == '':
            del node['parent']
    by_id = {n['id']: n for n in nodes}
    groups = {}
    for tween in pending_animations:
        groups.setdefault((tween['target'], tween['property']), []).append(tween)
    for (target, prop), tweens in groups.items():
        if target not in by_id:
            raise ValueError(f'Animation refers to missing object {target}')
        obj = by_id[target]
        owner, leaf = prop.split('.')
        default = {'translate': [0, 0], 'rotate': 0, 'scale': [1, 1], 'opacity': 1}[leaf]
        initial = obj.get(owner, {}).get(leaf, default)
        keys = [[0, initial]]
        end = 0
        interpolation = tweens[0]['easing']
        for tween in sorted(tweens, key=lambda t: t['start']):
            start, duration = tween['start'], tween['duration']
            if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in (start, duration)) or start < end or duration <= 0:
                raise ValueError(f'Overlapping or invalid animation intervals for {target}.{prop}')
            if tween['easing'] != interpolation:
                raise ValueError(f'One property must use one easing in v0.2: {target}.{prop}')
            if start > end:
                keys.append([start, keys[-1][1]])
            end = start + duration
            if end > bundle['duration'] + 1e-9:
                raise ValueError(f'Animation extends beyond scene duration: {target}.{prop}')
            keys.append([end, tween['to']])
        bundle['tracks'].append({'target': target, 'property': prop, 'keys': keys, 'interpolation': interpolation})
