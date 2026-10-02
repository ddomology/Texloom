"""Certify that semantic markers have preserved native TeX vector layout.

The comparison uses ordered outlines in resource coordinates, inherited paint,
and a tree of clipping/isolated-opacity scopes. Inert transport groups and SVG
definition identifiers do not participate. This is deliberately conservative:
unsupported path commands or changed compositing structure cannot be certified.
"""
from __future__ import annotations

from dataclasses import dataclass
import math
import re


TOLERANCE_BP = 2e-6
_IDENTITY = (1., 0., 0., 1., 0., 0.)
_NUMBER = re.compile(r'[+-]?(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?')
_ARITY = {'M': 2, 'L': 2, 'H': 1, 'V': 1, 'C': 6, 'S': 4, 'Q': 4, 'T': 2}
_PAINT_KEYS = {'fill', 'stroke', 'strokeWidth', 'fillOpacity', 'strokeOpacity',
               'dash', 'lineCap', 'lineJoin', 'miterLimit', 'fillRule'}


class TextPartLayoutDiagnostic(ValueError):
    code = 'TEXT_PART_LAYOUT'

    def __init__(self, reason):
        super().__init__(f'{self.code}: {reason} Semantic markers must preserve '
                         'the native layout; mark a complete TeX atom (including '
                         'scripts or ligature-forming text), or remove the marker.')


def _fail(reason):
    raise TextPartLayoutDiagnostic(reason)


def _number(value, context):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _fail(f'{context} requires a finite number.')
    return float(value)


def _tuple(value, count, context):
    if not isinstance(value, (list, tuple)) or len(value) != count:
        _fail(f'{context} requires {count} components.')
    return tuple(_number(item, context) for item in value)


def _affine(outer, inner):
    """Matrix product using homogeneous rows, in SVG application order."""
    rows = ((outer[0], outer[2], outer[4]),
            (outer[1], outer[3], outer[5]), (0., 0., 1.))
    columns = ((inner[0], inner[1], 0.),
               (inner[2], inner[3], 0.), (inner[4], inner[5], 1.))
    product = [[sum(x*y for x, y in zip(row, column)) for column in columns]
               for row in rows[:2]]
    return _tuple((product[0][0], product[1][0], product[0][1], product[1][1],
                   product[0][2], product[1][2]), 6, 'Accumulated paint transform')


def _position(matrix, point):
    return _tuple((sum((matrix[0]*point[0], matrix[2]*point[1], matrix[4])),
                   sum((matrix[1]*point[0], matrix[3]*point[1], matrix[5]))),
                  2, 'Transformed outline coordinate')


def _tokens(text):
    if not isinstance(text, str):
        _fail('SVG path data must be a string.')
    result, cursor, comma = [], 0, False
    while cursor < len(text):
        character = text[cursor]
        if character in ' \t\r\n':
            cursor += 1
            continue
        if character == ',':
            if comma or not result or isinstance(result[-1], str):
                _fail('Malformed comma separator in SVG path data.')
            comma = True
            cursor += 1
            continue
        if character.isascii() and character.isalpha():
            if comma:
                _fail('A comma must separate SVG path coordinates.')
            result.append(character)
            cursor += 1
        else:
            match = _NUMBER.match(text, cursor)
            if match is None:
                _fail(f'Unrecognized SVG path text at offset {cursor}.')
            result.append(_number(float(match.group()), 'SVG path coordinate'))
            cursor = match.end()
            comma = False
        if len(result) > 1_000_000:
            _fail('SVG path exceeds the comparison token budget.')
    if comma:
        _fail('SVG path ends with an incomplete coordinate separator.')
    return result


def _outline(text, matrix):
    """Parse complete polynomial SVG paths, retaining subpath and paint order.

    Smooth commands are expanded using their own previous control, quadratics
    are degree-elevated, and all controls are transformed before comparison.
    Elliptical arcs require a separate exact conic contract; they are rejected.
    """
    tokens = _tokens(text)
    output, cursor, command = [], 0, None
    current = origin = (0., 0.)
    last_cubic = last_quadratic = None
    previous = None
    while cursor < len(tokens):
        if isinstance(tokens[cursor], str):
            command = tokens[cursor]
            cursor += 1
        elif command is None:
            _fail('SVG path coordinates appear without a command.')
        kind = command.upper()
        if not output and kind != 'M':
            _fail('SVG path must begin with a moveto command.')
        if kind == 'A':
            _fail('Cannot certify SVG elliptical arc commands (A/a); use a polynomial path for this annotated resource.')
        if kind == 'Z':
            output.append(('Z', ()))
            current = origin
            last_cubic = last_quadratic = None
            previous, command = kind, None
            continue
        if kind not in _ARITY:
            _fail(f'Unsupported SVG path command {command!r}.')
        count = _ARITY[kind]
        operands = tokens[cursor:cursor+count]
        if len(operands) != count or any(isinstance(item, str) for item in operands):
            _fail(f'Incomplete operands for SVG path command {command}.')
        cursor += count
        relative = command.islower()
        offset = current if relative else (0., 0.)
        pairs = [tuple(operands[i+j]+offset[j] for j in (0, 1))
                 for i in range(0, count-1, 2)]
        if kind in ('M', 'L', 'H', 'V'):
            if kind == 'H':
                destination = (operands[0]+offset[0], current[1])
            elif kind == 'V':
                destination = (current[0], operands[0]+offset[1])
            else:
                destination = pairs[0]
            output.append(('M' if kind == 'M' else 'L', _position(matrix, destination)))
            if kind == 'M':
                origin = destination
                command = 'l' if relative else 'L'
            current = destination
            last_cubic = last_quadratic = None
        else:
            if kind in ('Q', 'T'):
                control = pairs[0] if kind == 'Q' else tuple(
                    2*current[j]-last_quadratic[j] if previous in ('Q', 'T') else current[j]
                    for j in (0, 1))
                destination = pairs[-1]
                controls = (tuple((current[j]+2*control[j])/3 for j in (0, 1)),
                            tuple((destination[j]+2*control[j])/3 for j in (0, 1)), destination)
                last_quadratic, last_cubic = control, None
            else:
                first = pairs[0] if kind == 'C' else tuple(
                    2*current[j]-last_cubic[j] if previous in ('C', 'S') else current[j]
                    for j in (0, 1))
                destination = pairs[-1]
                controls = (first, pairs[-2], destination)
                last_cubic, last_quadratic = pairs[-2], None
            coordinates = tuple(component for point in controls for component in _position(matrix, point))
            output.append(('C', coordinates))
            current = destination
        previous = kind
    return tuple(output)


@dataclass
class _Leaf:
    outline: tuple
    paint: dict
    stroke_linear: tuple | None


@dataclass
class _Scope:
    children: list
    opacity: float
    clip: tuple | None
    clip_rule: str | None


def _paint_tree(resource):
    leaves = 0
    visited = 0

    def visit(item, matrix, inherited, depth):
        nonlocal leaves, visited
        visited += 1
        if depth > 128 or visited > 131072:
            _fail('Vector paint tree exceeds the comparison depth or item budget.')
        if not isinstance(item, dict) or item.get('kind') not in ('group', 'path'):
            _fail('Unknown vector paint item.')
        matrix = _affine(matrix, _tuple(item.get('transform', _IDENTITY), 6, 'Paint transform'))
        local_style = item.get('style', {})
        if not isinstance(local_style, dict) or set(local_style)-_PAINT_KEYS-{'opacity'}:
            _fail('Unsupported vector paint style.')
        paint = dict(inherited)
        paint.update((key, value) for key, value in local_style.items() if key != 'opacity')
        opacity = _number(local_style.get('opacity', 1), 'Paint opacity')
        if not 0 <= opacity <= 1:
            _fail('Paint opacity must be in [0,1].')
        clip = item.get('clip')
        clip_outline = clip_rule = None
        if clip is not None:
            if not isinstance(clip, dict) or 'd' not in clip:
                _fail('Malformed vector clip.')
            clip_matrix = _affine(matrix, _tuple(clip.get('transform', _IDENTITY), 6, 'Clip transform'))
            clip_outline = _outline(clip['d'], clip_matrix)
            clip_rule = clip.get('fillRule', 'nonzero')
            if clip_rule not in ('nonzero', 'evenodd'):
                _fail('Unsupported clip fill rule.')
        if item['kind'] == 'group':
            children = item.get('children', [])
            if not isinstance(children, list):
                _fail('Paint group children must be a list.')
            content = [entry for child in children for entry in visit(child, matrix, paint, depth+1)]
        else:
            if 'children' in item:
                _fail('A path cannot contain paint children.')
            outline = _outline(item.get('d'), matrix)
            # Stroke geometry also depends on the affine pen, even when the
            # centerline is unchanged. Unspecified stroke is inherited from the
            # host and must not be assumed absent during resource comparison.
            pen = None if paint.get('stroke') == 'none' or paint.get('strokeWidth') == 0 else matrix[:4]
            content = [_Leaf(outline, paint, pen)] if outline else []
            leaves += len(content)
        if content and (opacity != 1 or clip_outline is not None):
            return [_Scope(content, opacity, clip_outline, clip_rule)]
        return content

    if not isinstance(resource, dict) or resource.get('kind') != 'vector' or not isinstance(resource.get('items'), list):
        _fail('Layout comparison requires two vector resources.')
    tree = [entry for item in resource['items'] for entry in visit(item, _IDENTITY, {}, 0)]
    return tree, leaves


def _compare_outline(reference, marked, location):
    if len(reference) != len(marked):
        _fail(f'Ordered outline command count changed at {location}.')
    maximum = 0.
    for index, (left, right) in enumerate(zip(reference, marked)):
        if left[0] != right[0] or len(left[1]) != len(right[1]):
            _fail(f'Outline command or subpath structure changed at {location}, command {index}.')
        for a, b in zip(left[1], right[1]):
            delta = abs(a-b)
            maximum = max(maximum, delta)
            if delta > TOLERANCE_BP:
                _fail(f'Native outline moved by {delta:.9g} bp at {location}, command {index}; tolerance is {TOLERANCE_BP:g} bp.')
    return maximum


def _compare_tree(reference, marked, location='paint'):
    if len(reference) != len(marked):
        _fail(f'Paint order or clip/opacity grouping changed at {location}.')
    maximum = 0.
    for index, (left, right) in enumerate(zip(reference, marked)):
        at = f'{location}[{index}]'
        if type(left) is not type(right):
            _fail(f'Isolated opacity or clip scope changed at {at}.')
        if isinstance(left, _Leaf):
            if left.paint != right.paint:
                _fail(f'Effective inherited paint changed at {at}.')
            if left.stroke_linear != right.stroke_linear:
                _fail(f'Affine stroke geometry changed at {at}.')
            maximum = max(maximum, _compare_outline(left.outline, right.outline, at))
        else:
            if left.opacity != right.opacity or left.clip_rule != right.clip_rule or (left.clip is None) != (right.clip is None):
                _fail(f'Isolated opacity or clipping changed at {at}.')
            if left.clip is not None:
                maximum = max(maximum, _compare_outline(left.clip, right.clip, at+'.clip'))
            maximum = max(maximum, _compare_tree(left.children, right.children, at+'.children'))
    return maximum


def assert_same_layout(reference_vector, marked_vector):
    """Return an audit report, or raise TEXT_PART_LAYOUT without partial success.

    Logical metrics must match exactly. Converted paint/control coordinates and
    the imported ink bounds may differ by at most 2e-6 bp, accommodating decimal
    transport precision. This tolerance is not applied to style or compositing.
    """
    for resource in (reference_vector, marked_vector):
        if not isinstance(resource, dict) or not isinstance(resource.get('metrics'), dict):
            _fail('TeX resource logical metrics are missing.')
        metrics = resource['metrics']
        if set(metrics) != {'width', 'height', 'depth'}:
            _fail('TeX logical metrics require width, height and depth.')
        for key, value in metrics.items():
            _number(value, f'TeX {key}')
    if reference_vector['metrics'] != marked_vector['metrics']:
        _fail(f'TeX logical metrics changed: {reference_vector["metrics"]} -> {marked_vector["metrics"]}.')
    reference_ink = _tuple(reference_vector.get('inkBounds'), 4, 'Native ink bounds')
    marked_ink = _tuple(marked_vector.get('inkBounds'), 4, 'Marked ink bounds')
    maximum_ink = max(abs(a-b) for a, b in zip(reference_ink, marked_ink))
    if maximum_ink > TOLERANCE_BP:
        _fail(f'Native ink bounds changed by {maximum_ink:.9g} bp; tolerance is {TOLERANCE_BP:g} bp.')
    reference, reference_count = _paint_tree(reference_vector)
    marked, marked_count = _paint_tree(marked_vector)
    if reference_count != marked_count:
        _fail(f'Native paint leaf count changed from {reference_count} to {marked_count}; a ligature or glyph may have been split.')
    maximum_coordinate = _compare_tree(reference, marked)
    return {'metricsExact': True, 'paintLeaves': reference_count,
            'maxCoordinateDifferenceBp': maximum_coordinate,
            'maxInkBoundsDifferenceBp': maximum_ink, 'toleranceBp': TOLERANCE_BP}
