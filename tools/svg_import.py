"""Strict dvisvgm transport importer. Public IR contains vector objects, not SVG.

Coordinates remain affine trees to retain clipping, group opacity and paint
order. Unsupported features stop compilation instead of silently disappearing.
"""
from __future__ import annotations
import math
import re
import xml.etree.ElementTree as ET

NUMBER = r"[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?"
IDENTITY = [1., 0., 0., 1., 0., 0.]

class ImportDiagnostic(ValueError):
    pass

def multiply(a, b):
    return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
            a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
            a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]]

def transform(raw=''):
    result = IDENTITY[:]
    remaining = re.sub(r'([A-Za-z]+)\s*\(([^)]*)\)', '', raw).strip(' ,\n')
    if remaining:
        raise ImportDiagnostic(f'Invalid transform: {raw}')
    for name, args in re.findall(r'([A-Za-z]+)\s*\(([^)]*)\)', raw):
        if re.sub(NUMBER,'',args).strip(' ,\t\r\n'):
            raise ImportDiagnostic(f'Invalid transform arguments: {raw}')
        v = [float(n) for n in re.findall(NUMBER, args)]
        if name == 'matrix' and len(v) == 6: m = v
        elif name == 'translate' and len(v) in (1,2): m = [1,0,0,1,v[0],v[1] if len(v)>1 else 0]
        elif name == 'scale' and len(v) in (1,2): m = [v[0],0,0,v[-1],0,0]
        elif name == 'rotate' and len(v) in (1,3):
            c,s = math.cos(math.radians(v[0])), math.sin(math.radians(v[0]))
            m = [c,s,-s,c,0,0]
            if len(v)==3: m=multiply(multiply([1,0,0,1,v[1],v[2]],m),[1,0,0,1,-v[1],-v[2]])
        elif name == 'skewX' and len(v)==1: m=[1,0,math.tan(math.radians(v[0])),1,0,0]
        elif name == 'skewY' and len(v)==1: m=[1,math.tan(math.radians(v[0])),0,1,0,0]
        else: raise ImportDiagnostic(f'Unsupported transform: {name} {args}')
        result=multiply(result,m)
    return [round(n,10) for n in result]

STYLE_NAMES = {'fill':'fill','stroke':'stroke','stroke-width':'strokeWidth',
 'opacity':'opacity','fill-opacity':'fillOpacity','stroke-opacity':'strokeOpacity',
 'stroke-dasharray':'dash','stroke-linecap':'lineCap','stroke-linejoin':'lineJoin',
 'stroke-miterlimit':'miterLimit','fill-rule':'fillRule'}

def style(element):
    attributes = dict(element.attrib)
    for decl in attributes.get('style','').split(';'):
        if ':' in decl:
            k,v=decl.split(':',1); attributes[k.strip()]=v.strip()
    result={}
    for k,v in attributes.items():
        if k in STYLE_NAMES:
            field=STYLE_NAMES[k]
            if 'url(' in v: raise ImportDiagnostic(f'Unsupported paint server: {k}={v}')
            if field in ('strokeWidth','opacity','fillOpacity','strokeOpacity','miterLimit'): result[field]=float(v)
            elif field=='dash': result[field]=[] if v=='none' else [float(n) for n in re.findall(NUMBER,v)]
            else: result[field]=v
        elif k in ('filter','mask','stroke-dashoffset','mix-blend-mode','isolation','vector-effect','display','visibility','color'):
            raise ImportDiagnostic(f'Unsupported graphics attribute: {k}')
    # dvisvgm emits geometry and clipping as SVG attributes. A style property
    # outside our style contract must never be silently dropped.
    for decl in element.attrib.get('style','').split(';'):
        if ':' in decl and decl.split(':',1)[0].strip() not in STYLE_NAMES:
            raise ImportDiagnostic(f'Unsupported SVG style property: {decl.split(":",1)[0].strip()}')
    return result

def local(tag): return tag.rsplit('}',1)[-1]

def primitive_path(el):
    tag=local(el.tag); a=el.attrib; f=lambda k,d=0: float(a.get(k,d))
    if tag=='path': return a.get('d','')
    if tag=='line': return f'M {f("x1")} {f("y1")} L {f("x2")} {f("y2")}'
    if tag in ('polygon','polyline'):
        pts=re.findall(NUMBER,a.get('points',''))
        if len(pts)%2: raise ImportDiagnostic('Odd polygon coordinates')
        return 'M '+' '.join(pts)+(' Z' if tag=='polygon' else '')
    if tag=='rect':
        if f('rx') or f('ry'): raise ImportDiagnostic('Rounded rect transport unsupported; use paths')
        x,y,w,h=f('x'),f('y'),f('width'),f('height')
        return f'M {x} {y} h {w} v {h} h {-w} Z'
    if tag in ('circle','ellipse'):
        x,y=f('cx'),f('cy'); rx=f('r') if tag=='circle' else f('rx'); ry=f('r') if tag=='circle' else f('ry')
        return f'M {x-rx} {y} a {rx} {ry} 0 1 0 {2*rx} 0 a {rx} {ry} 0 1 0 {-2*rx} 0 Z'
    raise ImportDiagnostic(f'Unsupported SVG element: {tag}')

def import_svg(svg_path, metrics, source_tex='', text_parts=None):
    root=ET.parse(svg_path).getroot()
    ids={el.attrib['id']:el for el in root.iter() if 'id' in el.attrib}
    origins=[el for el in root.iter() if 'data-tex-origin-x' in el.attrib]
    if len(origins)!=1: raise ImportDiagnostic('Expected exactly one measured TeX baseline origin')
    ox=float(origins[0].attrib['data-tex-origin-x']); oy=float(origins[0].attrib['data-tex-origin-y'])
    box=[float(n) for n in root.attrib.get('viewBox','').split()]
    if len(box)!=4: raise ImportDiagnostic('Missing SVG ink viewBox')
    glyphs=[]
    declarations={p['id']:p for p in (text_parts or [])}
    captured=set()
    def parse(el, stack=()):
        tag=local(el.tag)
        if tag=='svg' and el is not root:
            raise ImportDiagnostic('Nested SVG viewports are unsupported; flatten them before import')
        if 'data-tex-origin-x' in el.attrib or tag in ('defs','title','desc','metadata'): return None
        if tag=='use':
            ref=el.attrib.get('href',el.attrib.get('{http://www.w3.org/1999/xlink}href',''))
            if not ref.startswith('#') or ref[1:] not in ids: raise ImportDiagnostic(f'Unresolved vector reference {ref}')
            if ref in stack: raise ImportDiagnostic(f'Cyclic vector reference {ref}')
            child=parse(ids[ref[1:]],stack+(ref,))
            tr=multiply(transform(el.attrib.get('transform','')),[1,0,0,1,float(el.attrib.get('x',0)),float(el.attrib.get('y',0))])
            item={'kind':'group','transform':tr,'children':[child] if child else []}
            glyphs.append({'outlineId':ref[1:],'position':[float(el.attrib.get('x',0))-ox,float(el.attrib.get('y',0))-oy]})
        elif tag in ('g','svg'):
            children=[child for child in (parse(c,stack) for c in el) if child is not None]
            item={'kind':'group','children':children}
            if 'transform' in el.attrib: item['transform']=transform(el.attrib['transform'])
        else:
            item={'kind':'path','d':primitive_path(el)}
            if 'transform' in el.attrib: item['transform']=transform(el.attrib['transform'])
        st=style(el)
        if st: item['style']=st
        if 'data-texloom-part' in el.attrib:
            part_id=el.attrib['data-texloom-part']
            if text_parts is None or part_id not in declarations:
                raise ImportDiagnostic(f'TEXT_PART_SOURCE: emitted part {part_id!r} has no literal source declaration; mark the outer macro call instead')
            if tag!='g' or part_id in captured:
                raise ImportDiagnostic(f'TEXT_PART_DUPLICATE: part {part_id!r} must ship exactly one group')
            captured.add(part_id)
            item['_textPartId']=part_id
            if 'data-texloom-box' in el.attrib:
                values=el.attrib['data-texloom-box'].split()
                if len(values)!=3 or any(not re.fullmatch(NUMBER+r'pt',v) for v in values):
                    raise ImportDiagnostic('TEXT_PART_BOX: expected measured TeX width/height/depth in pt')
                width,height,depth=[float(v[:-2])*72/72.27 for v in values]
                try: x,y=float(el.attrib['data-texloom-x']),float(el.attrib['data-texloom-y'])
                except (KeyError,ValueError) as error: raise ImportDiagnostic('TEXT_PART_BOX: missing measured baseline') from error
                if not all(math.isfinite(v) for v in (x,y,width,height,depth)) or width<0 or height+depth<0:
                    raise ImportDiagnostic('TEXT_PART_BOX: unsupported negative or nonfinite logical extent')
                item['_textPartBox']=[x,y-height,width,height+depth]
        if 'clip-path' in el.attrib:
            match=re.fullmatch(r'url\(#([^)]+)\)',el.attrib['clip-path'])
            if not match or match[1] not in ids: raise ImportDiagnostic('Unresolved clip path')
            clip=ids[match[1]]
            if clip.attrib.get('clipPathUnits','userSpaceOnUse')!='userSpaceOnUse': raise ImportDiagnostic('objectBoundingBox clips unsupported')
            if len(clip)!=1: raise ImportDiagnostic('Clip transport requires a single composite path')
            child=clip[0]; cm=multiply(transform(clip.attrib.get('transform','')),transform(child.attrib.get('transform','')))
            item['clip']={'d':primitive_path(child),'transform':cm,'fillRule':child.attrib.get('clip-rule','nonzero')}
        return item
    tree=parse(root)
    if 'style' not in tree: tree['style']={'fill':'currentColor'}
    else: tree['style'].setdefault('fill','currentColor')
    tree={'kind':'group','transform':[1,0,0,1,-ox,-oy],'children':[tree]}
    vector={'kind':'vector','items':[tree],'metrics':metrics,
            'inkBounds':[round(box[0]-ox,7),round(box[1]-oy,7),box[2],box[3]],
            'sourceTex':source_tex,'glyphs':glyphs,
            'capabilities':['glyph-outlines','affine-groups','paint-order','group-opacity','clip-path'],
            'provenance':{'transport':'dvisvgm-svg','baselineOriginBp':[ox,oy]}}
    if text_parts is not None:
        missing=set(declarations)-captured
        if missing:
            raise ImportDiagnostic(f'TEXT_PART_SUPPRESSED: marks {sorted(missing)} did not ship; place the mark outside phantom, inactive branches or discarded material')
        parts={key:{**value,'paintPaths':[]} for key,value in declarations.items()}
        def visit(item,address,parent=None,matrix=None):
            matrix=multiply(matrix or IDENTITY,item.get('transform',IDENTITY))
            marker=item.pop('_textPartId',None)
            if marker is not None:
                if parts[marker].get('parent')!=parent:
                    raise ImportDiagnostic(f'TEXT_PART_NESTING: source and emitted hierarchy differ at {marker!r}')
                parent=marker
                logical=item.pop('_textPartBox',None)
                if logical is not None:
                    x,y,w,h=logical
                    corners=[(matrix[0]*px+matrix[2]*py+matrix[4],matrix[1]*px+matrix[3]*py+matrix[5])
                             for px,py in ((x,y),(x+w,y),(x,y+h),(x+w,y+h))]
                    xs,ys=zip(*corners)
                    parts[marker]['logicalBox']=[min(xs),min(ys),max(xs)-min(xs),max(ys)-min(ys)]
            if item['kind']=='path' and parent is not None: parts[parent]['paintPaths'].append(address)
            for index,child in enumerate(item.get('children',[])): visit(child,address+[index],parent,matrix)
        visit(tree,[0])
        if parts:
            vector['textParts']={'version':1,'parts':list(parts.values())}
            vector['capabilities'].append('semantic-text-parts')
    return vector
