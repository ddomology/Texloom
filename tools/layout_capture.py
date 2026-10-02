"""Lower opt-in measured content boxes to pure layouts and explicit placements."""
from __future__ import annotations

import json
from pathlib import Path
import re
import shutil

from connector_capture import (_finite, _output, _point, _transform_path,
                               ConnectorCaptureDiagnostic)


class LayoutCaptureDiagnostic(ValueError):
    pass


UNITS = {
    'matrix': {'columns':'1','gapX':'bp','gapY':'bp','alignX':'1','alignY':'1',
               'maxWidth':'bp','maxHeight':'bp','overflow':'1'},
    'row': {'gap':'bp','crossGap':'bp','align':'1','maxWidth':'bp','maxHeight':'bp','overflow':'1'},
    'column': {'gap':'bp','crossGap':'bp','align':'1','maxWidth':'bp','maxHeight':'bp','overflow':'1'},
    'align': {'axis':'1','align':'1','at':'bp'},
    'fit': {'paddingX':'bp','paddingY':'bp'},
}
OPTIONS = {'columns':'columns','gap-x':'gapX','gap-y':'gapY','align-x':'alignX',
           'align-y':'alignY','gap':'gap','cross-gap':'crossGap','align':'align',
           'max-width':'maxWidth','max-height':'maxHeight','overflow':'overflow',
           'axis':'axis','at':'at','padding-x':'paddingX','padding-y':'paddingY'}
ENUMS = {'align-x':{'start':0,'center':1,'end':2},
         'align-y':{'baseline':0,'start':1,'center':2,'end':3},
         'align':{'start':0,'center':1,'end':2,'baseline':3},
         'overflow':{'allow':0,'error':1,'wrap':2},'axis':{'x':0,'y':1}}


def _read(execution, base, field):
    if not isinstance(base,str) or not re.fullmatch(r'scene\.tl-layout-[1-9][0-9]*',base):
        raise LayoutCaptureDiagnostic('Invalid generated layout filename')
    path=execution/f'{base}.{field}.txt'
    if not path.is_file():
        raise LayoutCaptureDiagnostic(f'Missing layout sidecar: {path.name}')
    text=path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text),path


def _json(text):
    def pairs(items):
        result={}
        for key,value in items:
            if key in result:
                raise LayoutCaptureDiagnostic(f'Duplicate JSON key in layout inputs: {key}')
            result[key]=value
        return result
    def nonfinite(value):
        raise LayoutCaptureDiagnostic(f'Layout inputs contain nonfinite JSON value {value}')
    try:
        return json.loads(text,object_pairs_hook=pairs,parse_constant=nonfinite)
    except json.JSONDecodeError as error:
        raise LayoutCaptureDiagnostic(f'Invalid layout inputs JSON: {error}') from error


def _options(text, fit):
    result={}
    allowed={'id','padding-x','padding-y'} if fit else set(OPTIONS)-{'padding-x','padding-y'}|{'mode'}
    for entry in text.split(','):
        if not entry.strip():
            continue
        if '=' not in entry:
            raise LayoutCaptureDiagnostic(f'Layout option requires key=value: {entry.strip()}')
        key,value=(part.strip() for part in entry.split('=',1))
        if key not in allowed:
            raise LayoutCaptureDiagnostic(f'Unknown layout option: {key}')
        if key in result:
            raise LayoutCaptureDiagnostic(f'Duplicate layout option: {key}')
        if not value:
            raise LayoutCaptureDiagnostic(f'Layout option {key} must be nonempty')
        if key in ENUMS:
            if value not in ENUMS[key]:
                raise LayoutCaptureDiagnostic(f'Layout {key} must be one of {", ".join(ENUMS[key])}')
            value=ENUMS[key][value]
        elif key=='mode':
            if value not in ('matrix','row','column','align'):
                raise LayoutCaptureDiagnostic('Layout mode must be matrix, row, column or align')
        elif key!='id':
            if not re.fullmatch(r'[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?',value):
                raise LayoutCaptureDiagnostic(f'Layout {key} must be a literal number')
            value=int(value) if re.fullmatch(r'[-+]?\d+',value) else float(value)
            if not _finite(value):
                raise LayoutCaptureDiagnostic(f'Layout {key} must be finite')
        result[key]=value
    return result


def _span(text,path,output):
    lines=text.split('\n')
    return {'file':path.relative_to(output).as_posix(),'start':{'line':1,'column':1},
            'end':{'line':len(lines),'column':len(lines[-1])+1}}


def _archive(text,path,output):
    folder=output/'layout-sources';folder.mkdir(parents=True,exist_ok=True)
    archived=folder/path.name;temporary=archived.with_suffix(archived.suffix+'.tmp')
    shutil.copyfile(path,temporary);temporary.replace(archived)
    return _span(text,archived,output)


def _expression(text,base,socket,output):
    folder=output/'layout-sources';folder.mkdir(parents=True,exist_ok=True)
    archived=folder/f'{base}.{socket}.expression.txt';temporary=archived.with_suffix(archived.suffix+'.tmp')
    temporary.write_bytes((text+'\n').encode('utf8'));temporary.replace(archived)
    return _span(text,archived,output)


def _scalar(value,unit,base,socket,output):
    if _output(value):
        return {'kind':'output','ref':value}
    if _finite(value):
        return {'kind':'literal','value':{'type':'scalar','unit':unit,'value':value}}
    if isinstance(value,str):
        return {'kind':'expression','expression':value,'unit':unit,
                'sourceSpan':_expression(value,base,socket,output)}
    if isinstance(value,dict) and set(value)=={'node','property'} and all(isinstance(value[k],str) and value[k] for k in ('node','property')):
        return {'kind':'property','node':value['node'],'property':value['property'],'unit':unit}
    raise LayoutCaptureDiagnostic(f'Layout {socket} requires a finite number, scalar expression, property or output reference')


def _targets(value,nodes,bundle):
    if not isinstance(value,list) or not 1<=len(value)<=4096:
        raise LayoutCaptureDiagnostic('Layout nodes must be a list containing 1 to 4096 node IDs or null cells')
    ids=[];parent=None;first=True
    for target in value:
        if target is None:
            continue
        if not isinstance(target,str) or not target or target not in nodes:
            raise LayoutCaptureDiagnostic('Layout requires existing measured TeX nodes or measured loomnode groups')
        if target in ids:
            raise LayoutCaptureDiagnostic(f'Duplicate layout target: {target}')
        node=nodes[target]
        measured=(node.get('kind')=='tex' and isinstance(bundle.get('resources',{}).get(node.get('resourceId'),{}).get('metrics'),dict)
                  or node.get('kind')=='group' and node.get('anchorMetrics',{}).get('kind')=='pgf')
        if not measured:
            raise LayoutCaptureDiagnostic('Layout requires measured TeX nodes or measured loomnode groups')
        if first:
            parent=node.get('parent');first=False
        elif node.get('parent')!=parent:
            raise LayoutCaptureDiagnostic('Layout targets must share the same immediate parent')
        ids.append(target)
    if not ids:
        raise LayoutCaptureDiagnostic('Layout needs at least one non-null measured target')
    return {'kind':'parent','node':ids[0]}


def _points(value,space,base,output,nodes):
    if _output(value):
        return {'kind':'output','ref':value}
    if not isinstance(value,list) or len(value)>4096:
        raise LayoutCaptureDiagnostic('Layout positions requires a point list or points2d output reference')
    return {'kind':'points','space':space,'items':[
        _point(item,space,base,f'positions-{index}',output,nodes,expression_writer=_expression)
        for index,item in enumerate(value)]}


def lower_layouts(records: list[dict],bundle: dict,execution: Path,output: Path) -> None:
    declarations=[record for record in records if record['type']=='layout-file']
    if not declarations:
        return
    graph=bundle.setdefault('operationGraph',{'version':1,'operations':[],'bindings':[]})
    nodes={node['id']:node for node in bundle['nodes']};seen=set();layouts={}
    for record in declarations:
        base=record.get('file','')
        if base in seen:
            raise LayoutCaptureDiagnostic(f'Duplicate layout declaration file: {base}')
        seen.add(base)
        if record.get('kind') not in ('layout','fit'):
            raise LayoutCaptureDiagnostic('Unknown layout declaration kind')
        fit=record['kind']=='fit';options=_options(_read(execution,base,'options')[0],fit)
        target=_read(execution,base,'target')[0].strip()
        if not target:
            raise LayoutCaptureDiagnostic('Layout ID or fit target must be nonempty')
        text,path=_read(execution,base,'inputs');values=_json(text)
        if not isinstance(values,dict):
            raise LayoutCaptureDiagnostic('Layout inputs must be a JSON object')
        span=_archive(text,path,output)
        mode='fit' if fit else options.get('mode','matrix');units=UNITS[mode]
        if mode=='matrix' and options.get('overflow')==2:
            raise LayoutCaptureDiagnostic('Layout matrix overflow supports allow or error; wrap requires row or column')
        required={'layout'} if fit else {'nodes','positions'} if mode=='align' else {'nodes'}
        optional=set(units)|({'origin'} if mode in ('matrix','row','column') else set())
        if not required<=set(values) or set(values)-required-optional:
            raise LayoutCaptureDiagnostic(f'Layout {mode} requires {", ".join(sorted(required))} and only its supported sockets')
        try:
            if fit:
                source=values['layout']
                if not isinstance(source,str) or source not in layouts:
                    raise LayoutCaptureDiagnostic('Fit layout must reference a preceding layout declaration ID')
                node=nodes.get(target,{})
                if node.get('kind')!='path' or not node.get('geometry'):
                    raise LayoutCaptureDiagnostic('Fit target must be an existing editable path')
                saved=layouts[source];space=saved['space'];boxes=saved['boxes']
                operation=options.get('id','fit:'+target);runtime='fitBoxBounds'
                inputs={'boxes':boxes,'positions':{'kind':'output','ref':{'operation':source,'socket':'positions'}}}
            else:
                if target in layouts:
                    raise LayoutCaptureDiagnostic(f'Duplicate layout declaration ID: {target}')
                space=_targets(values['nodes'],nodes,bundle)
                boxes={'kind':'boxes','nodes':values['nodes'],'space':space}
                operation=target
                runtime={'matrix':'matrixBoxLayout','row':'distributeBoxLayout','column':'distributeBoxLayout','align':'alignBoxLayout'}[mode]
                inputs={'boxes':boxes}
                if mode=='align':
                    inputs['positions']=_points(values['positions'],space,base,output,nodes)
                else:
                    inputs['origin']=_point(values.get('origin',[0,0]),space,base,'origin',output,nodes,expression_writer=_expression)
                if mode in ('row','column'):
                    inputs['axis']=_scalar(0 if mode=='row' else 1,'1',base,'axis',output)
            for option,socket in OPTIONS.items():
                if option not in options:
                    continue
                if socket not in units:
                    raise LayoutCaptureDiagnostic(f'Layout {option} is not supported by {mode}')
                if socket in values:
                    raise LayoutCaptureDiagnostic(f'Layout {socket} specified in both options and JSON')
                inputs[socket]=_scalar(options[option],units[socket],base,socket,output)
            for key in units:
                if key in values:
                    inputs[key]=_scalar(values[key],units[key],base,key,output)
        except ConnectorCaptureDiagnostic as error:
            raise LayoutCaptureDiagnostic(str(error)) from error
        graph['operations'].append({'id':operation,'operator':runtime,'version':1,
            'spaces':{'space':space},'inputs':inputs,'sourceSpan':span})
        if fit:
            local={'kind':'local','node':target};value={'kind':'output','ref':{'operation':operation,'socket':'path'}}
            value=_transform_path(graph,operation+':local',value,space,local,span)
            graph['bindings'].append({'target':target,'property':'geometry','value':value['ref'],'sourceSpan':span})
            continue
        layouts[target]={'space':space,'boxes':boxes}
        for index,node_id in enumerate(values['nodes']):
            if node_id is None:
                continue
            placement=operation+':place:'+str(index);parent={'kind':'parent','node':node_id}
            graph['operations'].append({'id':placement,'operator':'boxPlacement','version':1,
                'spaces':{'space':space,'node':{'kind':'local','node':node_id},'parent':parent},
                'inputs':{'positions':{'kind':'output','ref':{'operation':operation,'socket':'positions'}},
                    'index':_scalar(index,'1',base,'index',output),
                    'mapping':{'kind':'spaceTransform','from':space,'to':parent}},'sourceSpan':span})
            for property in ('transform','x','y') if nodes[node_id]['kind']=='tex' else ('transform',):
                graph['bindings'].append({'target':node_id,'property':property,
                    'value':{'operation':placement,'socket':property},'sourceSpan':span})
    bundle['version']='0.3'
