"""Capture PGF measurements and lower executed declarations into public IR.

This module consumes TeX-generated records; it never interprets TikZ source.
Node geometry, text, styles, and anchors have already been evaluated by PGF.
"""
from __future__ import annotations
import copy
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
\newwrite\TLMpathfile
\newcount\TLMpathcount
\def\TLMcaptureend{\TLMcaptureend}
\def\TLMmaptoken#1#2{\expandafter\def\csname TLMop@\string#1\endcsname{#2}}
\TLMmaptoken\pgfsyssoftpath@movetotoken{M}
\TLMmaptoken\pgfsyssoftpath@linetotoken{L}
\TLMmaptoken\pgfsyssoftpath@curvetosupportatoken{A}
\TLMmaptoken\pgfsyssoftpath@curvetosupportbtoken{B}
\TLMmaptoken\pgfsyssoftpath@curvetotoken{C}
\TLMmaptoken\pgfsyssoftpath@rectcornertoken{R}
\TLMmaptoken\pgfsyssoftpath@rectsizetoken{S}
\TLMmaptoken\pgfsyssoftpath@closepathtoken{Z}
\def\TLMdumpsoft#1#2#3{%
  \ifx#1\TLMcaptureend
    \let\TLMnext\relax
  \else
    \ifcsname TLMop@\string#1\endcsname
      \immediate\write\TLMpathfile{\csname TLMop@\string#1\endcsname:#2,#3}%
    \else
      \PackageError{texloom}{Unsupported PGF soft path token \string#1}{Use a supported path or static loompath.}%
    \fi
    \let\TLMnext\TLMdumpsoft
  \fi\TLMnext}
\def\TLMunsupportedbody{\PackageError{texloom}{Unsupported live geometry body operation}{Use geometry-only path expressions; put paint options on loomgeometry and use loomnode or loompath for additional artwork.}}
\def\TLMinstallgeometryguard{%
  \def\tikz@parse@options##1]{\TLMunsupportedbody}%
  \let\tikz@fig\TLMunsupportedbody
  \let\tikz@extra\TLMunsupportedbody
  \let\tikz@to\TLMunsupportedbody
  \let\tikz@edge@plain\TLMunsupportedbody
  \let\tikz@decoration\TLMunsupportedbody
  \let\tikz@subpicture\TLMunsupportedbody
  \let\tikz@graph\TLMunsupportedbody}
\long\def\TLMCaptureGeometry#1#2{%
  \begingroup
    \global\TLMpathcount=0
    \let\TLMoriginalpath\path
    \def\path{\global\advance\TLMpathcount by1
      \ifnum\TLMpathcount>1 \PackageError{texloom}{Ambiguous live geometry: multiple path statements}{Use one loomgeometry declaration per path.}\fi
      \TLMoriginalpath}%
    \tikzset{every path/.style={}}%
    \path[#1,save path=\TLMsoftpath]\pgfextra{\TLMinstallgeometryguard}#2;
    \ifnum\TLMpathcount=1\else\PackageError{texloom}{Missing live geometry path}{Use one geometry-only path expression.}\fi
    \pgfprocessround{\TLMsoftpath}{\TLMsoftpath}%
    \immediate\openout\TLMpathfile=asset.path
    \immediate\write\TLMpathfile{protocol:pgf-soft-path-v1}%
    \immediate\write\TLMpathfile{pgfversion:\pgfversion}%
    \expandafter\TLMdumpsoft\TLMsoftpath\TLMcaptureend{0pt}{0pt}%
    \immediate\closeout\TLMpathfile
    \TLMCaptureOrigin
  \endgroup}
\makeatother
'''


def read_soft_path(path):
    """Decode executed PGF tokens, not TikZ source, into editable contour data."""
    lines = path.read_text(encoding='utf8').splitlines()
    if not lines or lines[0] != 'protocol:pgf-soft-path-v1':
        raise ValueError('Unknown PGF soft path capture protocol')
    if len(lines) < 2 or not lines[1].startswith('pgfversion:'):
        raise ValueError('PGF soft path capture is missing its producer version')
    tokens = []
    for line in lines[2:]:
        operation, value = line.split(':', 1)
        if operation not in ('M', 'L', 'A', 'B', 'C', 'R', 'S', 'Z'):
            raise ValueError(f'Unsupported PGF soft path operation {operation}')
        values = value.split(',')
        if len(values) != 2 or any(not v.strip().endswith('pt') for v in values):
            raise ValueError('PGF soft path coordinates must be TeX point pairs')
        point = [round(float(v.strip()[:-2]) * PT_TO_BP, 8) for v in values]
        if not all(math.isfinite(v) for v in point):
            raise ValueError('Non-finite PGF soft path coordinate')
        point[1] = -point[1]
        tokens.append((operation, point))
    contours, current = [], None

    def begin(point):
        nonlocal current
        current = {'id': f'contour-{len(contours)}', 'start': point, 'segments': []}
        contours.append(current)

    def segment(kind, to, **extra):
        nonlocal current
        if current is None:
            raise ValueError('PGF path segment has no initial move')
        if current.get('closed'):
            begin(current['start'].copy())
        current['segments'].append({'kind': kind, 'id': f'segment-{len(current["segments"])}', **extra, 'to': to})

    index = 0
    while index < len(tokens):
        operation, point = tokens[index]
        if operation == 'M':
            # Empty move-only contours have no paint. PGF uses these after
            # circles/ellipses to restore a current coordinate.
            if current is not None and not current['segments']:
                contours.pop()
            begin(point)
        elif operation == 'L':
            segment('line', point)
        elif operation == 'A':
            if index + 2 >= len(tokens) or tokens[index + 1][0] != 'B' or tokens[index + 2][0] != 'C':
                raise ValueError('Malformed PGF cubic control token sequence')
            segment('cubic', tokens[index + 2][1], c1=point, c2=tokens[index + 1][1])
            index += 2
        elif operation == 'R':
            if index + 1 >= len(tokens) or tokens[index + 1][0] != 'S':
                raise ValueError('Malformed PGF rectangle token sequence')
            if current is not None and not current['segments']:
                contours.pop()
            begin(point)
            size = tokens[index + 1][1]
            x, y = point
            segment('line', [round(x + size[0], 8), y])
            segment('line', [round(x + size[0], 8), round(y + size[1], 8)])
            segment('line', [x, round(y + size[1], 8)])
            current['closed'] = True
            index += 1
        elif operation == 'Z':
            if current is None or not current['segments']:
                raise ValueError('PGF close operation has no painted contour')
            current['closed'] = True
        else:
            raise ValueError(f'Orphan PGF soft path token {operation}')
        index += 1
    if current is not None and not current['segments']:
        contours.pop()
    if not contours:
        raise ValueError('Live geometry has no line or cubic segments')
    return {'geometry': {'contours': contours}, 'protocol': 'pgf-soft-path-v1',
            'pgfVersion': lines[1].split(':', 1)[1], 'coordinateSpace': 'local-bp-y-down',
            'sourceCoordinateSpace': 'PGF-TeX-pt-y-up', 'tokenCount': len(tokens)}


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


def verify_geometry_reference(resource, record):
    """Fail if additional PGF artwork cannot be represented by the live path.

    This validates already imported paint, not TeX syntax. It catches settings
    injected by user setup hooks as well as extra painted objects.
    """
    leaves = []
    defaults = {'fill': 'currentColor', 'stroke': 'none', 'strokeWidth': 1,
                'fillOpacity': 1, 'strokeOpacity': 1, 'lineCap': 'butt',
                'lineJoin': 'miter', 'fillRule': 'nonzero', 'miterLimit': 4}
    origin = resource['provenance']['baselineOriginBp']

    def walk(item, inherited, depth):
        if 'clip' in item:
            raise ValueError('Unsupported live geometry reference clip; use a scene clip or static loompath')
        matrix = item.get('transform')
        if matrix:
            allowed = [1, 0, 0, 1, -origin[0], -origin[1]] if depth == 0 else [1, 0, 0, 1, 0, 0]
            if any(abs(a - b) > 1e-7 for a, b in zip(matrix, allowed)):
                raise ValueError('Unsupported live geometry canvas transform; use native coordinate transforms or loomgroup')
        style = {**inherited, **item.get('style', {})}
        if item.get('style', {}).get('opacity', 1) != 1 or style.get('dash'):
            raise ValueError('Unsupported live geometry reference compositing or dash style')
        if item['kind'] == 'path':
            leaves.append((item['d'], style))
        for child in item.get('children', []):
            walk(child, style, depth + 1)

    for item in resource['items']:
        walk(item, defaults, 0)
    # PGF can emit fill and stroke as two identical path uses. Preserve that
    # ordinary case, while rejecting extra geometry or repeated paint actions.
    if not 1 <= len(leaves) <= 2 or len({d for d, _ in leaves}) != 1 or resource.get('glyphs'):
        raise ValueError('Ambiguous live geometry reference: expected one geometry without text')
    actual = defaults.copy()
    fills, strokes = 0, 0
    for _, style in leaves:
        if style['fill'] != 'none':
            fills += 1
            for key in ('fill', 'fillOpacity', 'fillRule'):
                actual[key] = style[key]
        if style['stroke'] != 'none':
            strokes += 1
            for key in ('stroke', 'strokeOpacity', 'strokeWidth', 'lineCap', 'lineJoin', 'miterLimit'):
                actual[key] = style[key]
    if fills != int(record['fill'] != 'none') or strokes != int(record['stroke'] != 'none'):
        raise ValueError('Ambiguous live geometry reference: extra or missing fill/stroke actions')
    if not fills:
        actual['fill'] = 'none'
    expected = {'fill': paint_color(record['fill']), 'stroke': paint_color(record['stroke']),
                'fillOpacity': record['fillOpacity'], 'strokeOpacity': record['strokeOpacity'],
                'strokeWidth': record['lineWidthPt'] * PT_TO_BP,
                'lineCap': record['lineCap'], 'lineJoin': record['lineJoin'],
                'fillRule': record['fillRule'], 'miterLimit': 10}
    for key, value in expected.items():
        # A disabled paint has no meaningful alpha or stroke metric in SVG.
        if key.startswith('fill') and key != 'fill' and expected['fill'] == 'none':
            continue
        if key not in ('fill', 'stroke', 'fillOpacity', 'fillRule') and expected['stroke'] == 'none':
            continue
        observed = actual[key]
        if key in ('fill', 'stroke'):
            observed = '#000000' if observed == 'currentColor' else observed.lower()
            value = value.lower()
        matches = abs(observed - value) < .002 if isinstance(value, (int, float)) else observed == value
        if not matches:
            raise ValueError(f'Unsupported live geometry reference paint change: {key} is {observed}, expected {value}')


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
        if kind == 'tikz-geometry':
            bundle['version'] = '0.3'
            resource = bundle['resources'][record['resourceId']]
            verify_geometry_reference(resource, record)
            captured = resource['provenance']['pgfSoftPath']
            node.update(kind='path', d='M0 0', geometry=copy.deepcopy(captured['geometry']),
                        transform={'translate': [record['x'], record['y']]},
                        reveal=record['reveal'], revealMode=record['mode'], pathTolerance=record['tolerance'],
                        style={'stroke': paint_color(record['stroke']), 'fill': paint_color(record['fill']),
                               'strokeWidth': round(record['lineWidthPt'] * PT_TO_BP, 8),
                               'lineCap': record['lineCap'], 'lineJoin': record['lineJoin'],
                               'fillRule': record['fillRule'], 'miterLimit': 10,
                               'fillOpacity': record['fillOpacity'], 'strokeOpacity': record['strokeOpacity']})
            node['source']['referenceResourceId'] = record['resourceId']
            node['source']['geometryProducer'] = 'pgf-soft-path-v1'
            nodes.append(node)
        elif kind == 'tikz-point':
            bundle['version'] = '0.3'
            node.update(kind='point', x=0, y=0, r=record['radius'], progress=record['progress'],
                        style={'stroke': paint_color(record['stroke']), 'fill': paint_color(record['fill']),
                               'strokeWidth': round(record['lineWidthPt'] * PT_TO_BP, 8)})
            nodes.append(node)
            bundle['relations'].append({'type': 'pointOnPath', 'target': node['id'], 'source': record['path'],
                                        'mode': record['mode'], 'tolerance': record['tolerance']})
        elif kind == 'tikz-direction':
            bundle['version'] = '0.3'
            node.update(kind='line', x1=0, y1=0, x2=0, y2=0,
                        style={'stroke': paint_color(record['stroke']), 'fill': 'none',
                               'strokeWidth': round(record['lineWidthPt'] * PT_TO_BP, 8), 'lineCap': 'round'})
            nodes.append(node)
            bundle['relations'].append({'type': 'pathDirection', 'target': node['id'], 'source': record['path'],
                                        'point': record['point'], 'length': record['length'], 'normal': record['normal']})
        elif kind in ('tikz-node', 'tikz-path'):
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
        if prop.startswith('geometry.'):
            parts = prop.split('.')
            if len(parts) not in (3, 4):
                raise ValueError(f'Invalid geometry animation address {prop}')
            contour = next((c for c in obj.get('geometry', {}).get('contours', []) if c['id'] == parts[1]), None)
            if contour is None:
                raise ValueError(f'Missing contour in geometry animation {target}.{prop}')
            if len(parts) == 3:
                if parts[2] != 'start':
                    raise ValueError(f'Contour animation must target start: {target}.{prop}')
                initial = contour['start']
            else:
                segment = next((s for s in contour['segments'] if s['id'] == parts[2]), None)
                if segment is None or parts[3] not in ('to', 'c1', 'c2') or parts[3] not in segment:
                    raise ValueError(f'Missing segment coordinate in geometry animation {target}.{prop}')
                initial = segment[parts[3]]
        elif prop in ('progress', 'reveal'):
            initial = obj.get(prop, 0 if prop == 'progress' else 1)
        else:
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
                raise ValueError(f'One property must use one easing: {target}.{prop}')
            if start > end:
                keys.append([start, keys[-1][1]])
            end = start + duration
            if end > bundle['duration'] + 1e-9:
                raise ValueError(f'Animation extends beyond scene duration: {target}.{prop}')
            keys.append([end, tween['to']])
        bundle['tracks'].append({'target': target, 'property': prop, 'keys': keys, 'interpolation': interpolation})


def paint_color(value):
    return 'none' if value == 'none' else '#' + value
