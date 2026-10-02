"""Independent paint-layout oracle. No importer/renderer implementation helpers."""
import math
import re

IDENTITY = (1., 0., 0., 1., 0., 0.)
NUMBER = r'[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?'


def compose(a, b):
    return (a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
            a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
            a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5])


def world(matrix, p):
    return (matrix[0]*p[0]+matrix[2]*p[1]+matrix[4],
            matrix[1]*p[0]+matrix[3]*p[1]+matrix[5])


def outline(path, matrix):
    """Absolute world-coordinate M/L/C/Z; Q/T promoted independently to cubic.

    TeX glyph/rule fixtures use this subset. Unsupported arcs fail explicitly;
    this oracle must not silently skip an unsupported contour.
    """
    tokens = re.findall('[A-Za-z]|'+NUMBER, path)
    if re.sub('[A-Za-z]|'+NUMBER, '', path).strip(' ,\r\n\t'):
        raise AssertionError('Unparsed path text')
    result = []
    i, command, previous = 0, None, None
    point = start = (0., 0.)
    cubic = quadratic = None
    counts = {'M':2, 'L':2, 'H':1, 'V':1, 'C':6, 'S':4, 'Q':4, 'T':2}
    while i < len(tokens):
        if tokens[i].isalpha():
            command = tokens[i]
            i += 1
        if command is None:
            raise AssertionError('Path starts without command')
        kind = command.upper()
        if kind == 'Z':
            result.append(('Z',))
            point = start
            cubic = quadratic = None
            previous, command = kind, None
            continue
        if kind not in counts:
            raise AssertionError('Unsupported oracle path command '+kind)
        count = counts[kind]
        args = [float(v) for v in tokens[i:i+count]]
        if len(args) != count or not all(math.isfinite(v) for v in args):
            raise AssertionError('Invalid path coordinates')
        i += count
        relative = command.islower()
        def pair(j):
            return (args[j]+(point[0] if relative else 0),
                    args[j+1]+(point[1] if relative else 0))
        if kind in ('M', 'L', 'H', 'V'):
            destination = pair(0) if kind in ('M','L') else (
                (args[0]+(point[0] if relative else 0),point[1]) if kind=='H' else
                (point[0],args[0]+(point[1] if relative else 0)))
            result.append(('M' if kind=='M' else 'L', *world(matrix,destination)))
            if kind == 'M':
                start = destination
                command = 'l' if relative else 'L'
            point = destination
            cubic = quadratic = None
        else:
            if kind in ('C','S'):
                first = pair(0) if kind=='C' else (
                    (2*point[0]-cubic[0],2*point[1]-cubic[1]) if previous in ('C','S') else point)
                second, destination = (pair(2),pair(4)) if kind=='C' else (pair(0),pair(2))
                cubic, quadratic = second, None
            else:
                control = pair(0) if kind=='Q' else (
                    (2*point[0]-quadratic[0],2*point[1]-quadratic[1]) if previous in ('Q','T') else point)
                destination = pair(2) if kind=='Q' else pair(0)
                first = tuple(point[j]+2*(control[j]-point[j])/3 for j in range(2))
                second = tuple(destination[j]+2*(control[j]-destination[j])/3 for j in range(2))
                quadratic, cubic = control, None
            result.append(('C',*world(matrix,first),*world(matrix,second),*world(matrix,destination)))
            point = destination
        previous = kind
    return result


def paint_leaves(resource):
    """Ignore transport IDs and inert grouping; retain paint order and clipping."""
    result = []
    def visit(item, matrix, paint, opacity, clips):
        matrix = compose(matrix, item.get('transform',IDENTITY))
        inherited = dict(paint)
        local = item.get('style',{})
        inherited.update((k,v) for k,v in local.items() if k!='opacity')
        if local.get('opacity',1) != 1:
            opacity = (*opacity,local['opacity'])
        if 'clip' in item:
            clip = item['clip']
            clips = (*clips, (outline(clip['d'],compose(matrix,clip.get('transform',IDENTITY))),clip.get('fillRule','nonzero')))
        if item['kind']=='group':
            for child in item['children']:
                visit(child,matrix,inherited,opacity,clips)
        elif item['kind']=='path':
            commands = outline(item['d'],matrix)
            if commands:
                result.append({'outline':commands,'paint':inherited,'opacity':opacity,'clips':clips})
        else:
            raise AssertionError('Unknown vector item '+item['kind'])
    for item in resource['items']:
        visit(item,IDENTITY,{},(),())
    return result


def maximum_difference(a, b):
    if isinstance(a,(float,int)) and not isinstance(a,bool):
        if not isinstance(b,(float,int)) or not math.isfinite(a) or not math.isfinite(b):
            raise AssertionError('Invalid numeric comparison')
        return abs(a-b)
    if isinstance(a,dict):
        if set(a)!=set(b):
            raise AssertionError('Different record keys')
        return max((maximum_difference(a[k],b[k]) for k in a),default=0)
    if isinstance(a,(list,tuple)):
        if not isinstance(b,(list,tuple)) or len(a)!=len(b):
            raise AssertionError('Different ordered leaf/command counts')
        return max((maximum_difference(x,y) for x,y in zip(a,b)),default=0)
    if a != b:
        raise AssertionError(f'Non-numeric mismatch: {a!r} != {b!r}')
    return 0


def layout_difference(a,b):
    if a['metrics']!=b['metrics']:
        raise AssertionError(f'TeX logical metrics changed: {a["metrics"]} != {b["metrics"]}')
    return {'maximumPaintCoordinateDifferenceBp':maximum_difference(paint_leaves(a),paint_leaves(b)),
            'maximumInkBoundsDifferenceBp':maximum_difference(a['inkBounds'],b['inkBounds']),
            'paintLeaves':len(paint_leaves(a))}
