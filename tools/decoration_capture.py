"""Lower explicit lattice decorations and endpoint braces into ordinary paths."""
from __future__ import annotations

import json
from pathlib import Path
import re
import shutil

from connector_capture import (_finite, _output, _point, _space, _transform_path,
                               ConnectorCaptureDiagnostic)


class DecorationCaptureDiagnostic(ValueError):
    pass


COMMON = {'spacing':'bp','phase':'bp','origin':'bp','startMargin':'bp','endMargin':'bp',
          'offset':'bp','size':'bp','orientation':'1','corners':'1','cusps':'1',
          'maxSamples':'1','tolerance':'bp'}
OPTION_SOCKETS = {'spacing':'spacing','phase':'phase','origin':'origin',
    'start-margin':'startMargin','end-margin':'endMargin','offset':'offset','size':'size',
    'orientation':'orientation','corners':'corners','cusps':'cusps','max-samples':'maxSamples',
    'tolerance':'tolerance','amplitude':'amplitude','resolution':'resolution',
    'symbol-scale':'symbolScale','aspect':'aspect'}
ENUMS = {'orientation':{'tangent':0,'fixed':1,'reverse':2},
         'corners':{'following':0,'skip':1,'error':2},'cusps':{'error':0,'skip':1}}


def _read(execution, base, field):
    if not isinstance(base,str) or not re.fullmatch(r'scene\.tl-decoration-[1-9][0-9]*',base):
        raise DecorationCaptureDiagnostic('Invalid generated decoration filename')
    path=execution/f'{base}.{field}.txt'
    if not path.is_file():
        raise DecorationCaptureDiagnostic(f'Missing decoration sidecar: {path.name}')
    text=path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text),path


def _json(text):
    def pairs(items):
        result={}
        for key,value in items:
            if key in result:
                raise DecorationCaptureDiagnostic(f'Duplicate JSON key in decoration inputs: {key}')
            result[key]=value
        return result
    def nonfinite(value):
        raise DecorationCaptureDiagnostic(f'Decoration inputs contain nonfinite JSON value {value}')
    try:
        return json.loads(text,object_pairs_hook=pairs,parse_constant=nonfinite)
    except json.JSONDecodeError as error:
        raise DecorationCaptureDiagnostic(f'Invalid decoration inputs JSON: {error}') from error


def _options(text, brace):
    result={}
    allowed={'id','space','amplitude','aspect','offset'} if brace else set(OPTION_SOCKETS)-{'aspect'}|{'id','space','mode'}
    for entry in text.split(','):
        if not entry.strip():
            continue
        if '=' not in entry:
            raise DecorationCaptureDiagnostic(f'Decoration option requires key=value: {entry.strip()}')
        key,value=(part.strip() for part in entry.split('=',1))
        if key not in allowed:
            raise DecorationCaptureDiagnostic(f'Unknown decoration option: {key}')
        if key in result:
            raise DecorationCaptureDiagnostic(f'Duplicate decoration option: {key}')
        if not value:
            raise DecorationCaptureDiagnostic(f'Decoration option {key} must be nonempty')
        if key in ENUMS:
            if value not in ENUMS[key]:
                raise DecorationCaptureDiagnostic(f'Decoration {key} must be one of {", ".join(ENUMS[key])}')
            value=ENUMS[key][value]
        elif key=='mode':
            if value not in ('ticks','marks','snake','symbols'):
                raise DecorationCaptureDiagnostic('Decoration mode must be ticks, marks, snake or symbols')
        elif key not in ('id','space'):
            if not re.fullmatch(r'[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?',value):
                raise DecorationCaptureDiagnostic(f'Decoration {key} must be a literal number')
            value=int(value) if re.fullmatch(r'[-+]?\d+',value) else float(value)
            if not _finite(value):
                raise DecorationCaptureDiagnostic(f'Decoration {key} must be finite')
        result[key]=value
    return result


def _span(text,path,output):
    lines=text.split('\n')
    return {'file':path.relative_to(output).as_posix(),'start':{'line':1,'column':1},
            'end':{'line':len(lines),'column':len(lines[-1])+1}}


def _archive(text,path,output):
    folder=output/'decoration-sources';folder.mkdir(parents=True,exist_ok=True)
    archived=folder/path.name;temporary=archived.with_suffix(archived.suffix+'.tmp')
    shutil.copyfile(path,temporary);temporary.replace(archived)
    return _span(text,archived,output)


def _expression(text,base,socket,output):
    folder=output/'decoration-sources';folder.mkdir(parents=True,exist_ok=True)
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
    raise DecorationCaptureDiagnostic(f'Decoration {socket} requires a finite number, scalar expression, property or output reference')


def _path(value,space,graph,operation,socket,span,require_space=False):
    if isinstance(value,str) and value:
        actual={'kind':'local','node':value} if require_space else space
        return {'kind':'path','node':value,'space':actual},actual
    if _output(value):
        if require_space:
            raise DecorationCaptureDiagnostic('Symbol output reference requires explicit space')
        return {'kind':'output','ref':value},space
    if isinstance(value,dict) and set(value)=={'operation','socket','space'} and _output({k:v for k,v in value.items() if k!='space'}):
        actual=_space(value['space']);ref={'kind':'output','ref':{k:v for k,v in value.items() if k!='space'}}
        if not require_space and actual!=space:
            ref=_transform_path(graph,operation+':'+socket,ref,actual,space,span)
            actual=space
        return ref,actual
    raise DecorationCaptureDiagnostic(f'Decoration {socket} requires a path node ID or output reference with optional explicit space')


def lower_decorations(records: list[dict],bundle: dict,execution: Path,output: Path) -> None:
    declarations=[record for record in records if record['type']=='decoration-file']
    if not declarations:
        return
    graph=bundle.setdefault('operationGraph',{'version':1,'operations':[],'bindings':[]})
    nodes={node['id']:node for node in bundle['nodes']};seen=set();targets=set()
    for record in declarations:
        base=record.get('file','')
        if base in seen:
            raise DecorationCaptureDiagnostic(f'Duplicate decoration declaration file: {base}')
        seen.add(base)
        if record.get('kind') not in ('decorate','brace'):
            raise DecorationCaptureDiagnostic('Unknown decoration declaration kind')
        brace=record['kind']=='brace';options=_options(_read(execution,base,'options')[0],brace)
        target=_read(execution,base,'target')[0].strip();node=nodes.get(target,{})
        if node.get('kind')!='path' or not node.get('geometry'):
            raise DecorationCaptureDiagnostic('Decoration target must be an existing editable path')
        if target in targets:
            raise DecorationCaptureDiagnostic('Decoration target already has a geometry declaration')
        targets.add(target)
        operation=options.get('id',('brace:' if brace else 'decoration:')+target)
        text,path=_read(execution,base,'inputs');values=_json(text)
        if not isinstance(values,dict):
            raise DecorationCaptureDiagnostic('Decoration inputs must be a JSON object')
        span=_archive(text,path,output)
        try:
            space=_space(options.get('space','scene'));spaces={'space':space}
            if brace:
                units={'amplitude':'bp','aspect':'1','offset':'bp'};required={'from','to'}
                runtime='bracePath';inputs={key:_point(values[key],space,base,key,output,nodes,expression_writer=_expression)
                    for key in required if key in values}
            else:
                mode=options.get('mode','ticks');units=dict(COMMON);required={'path'}
                if mode=='snake':
                    units.update(amplitude='bp',resolution='1')
                if mode=='symbols':
                    units['symbolScale']='1';required.add('symbol')
                runtime='repeatPathSymbols' if mode=='symbols' else 'decoratePath';inputs={}
                for key in required:
                    if key in values:
                        inputs[key],actual=_path(values[key],space,graph,operation,key,span,key=='symbol')
                        if key=='symbol':
                            spaces['symbol']=actual
                if mode!='symbols':
                    inputs['mode']=_scalar({'ticks':0,'marks':1,'snake':2}[mode],'1',base,'mode',output)
            if not required<=set(values) or set(values)-required-set(units):
                raise DecorationCaptureDiagnostic(f'Decoration requires {", ".join(sorted(required))} and only the selected profile numeric sockets')
            for option,socket in OPTION_SOCKETS.items():
                if option not in options:
                    continue
                if socket not in units:
                    raise DecorationCaptureDiagnostic(f'Decoration {option} is not supported by this profile')
                if socket in values:
                    raise DecorationCaptureDiagnostic(f'Decoration {socket} specified in both options and JSON')
                inputs[socket]=_scalar(options[option],units[socket],base,socket,output)
            for key in units:
                if key in values:
                    inputs[key]=_scalar(values[key],units[key],base,key,output)
        except ConnectorCaptureDiagnostic as error:
            raise DecorationCaptureDiagnostic(str(error)) from error
        graph['operations'].append({'id':operation,'operator':runtime,'version':1,
            'spaces':spaces,'inputs':inputs,'sourceSpan':span})
        local={'kind':'local','node':target};value={'kind':'output','ref':{'operation':operation,'socket':'path'}}
        if local!=space:
            value=_transform_path(graph,operation+':local',value,space,local,span)
        graph['bindings'].append({'target':target,'property':'geometry','value':value['ref'],'sourceSpan':span})
    bundle['version']='0.3'
