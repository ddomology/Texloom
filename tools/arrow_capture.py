"""Capture explicit editable-path arrow styles without changing legacy flags."""
from __future__ import annotations

import json
import math
from pathlib import Path
import re
import shutil


class ArrowCaptureDiagnostic(ValueError):
    pass


DEFAULTS = {'start':0,'end':1,'length':9,'width':7.56,'inset':2.52,
            'shortenStart':0,'shortenEnd':0,'tolerance':.05}
UNITS = {key:('1' if key in ('start','end') else 'bp') for key in DEFAULTS}
OPTION_SOCKETS = {'start':'start','end':'end','length':'length','width':'width','inset':'inset',
                  'shorten-start':'shortenStart','shorten-end':'shortenEnd','tolerance':'tolerance'}


def _finite(value):
    if isinstance(value,bool) or not isinstance(value,(int,float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _read(execution: Path, base: str, field: str):
    if not isinstance(base,str) or not re.fullmatch(r'scene\.tl-arrow-[1-9][0-9]*',base):
        raise ArrowCaptureDiagnostic('Invalid generated arrow filename')
    path=execution/f'{base}.{field}.txt'
    if not path.is_file():
        raise ArrowCaptureDiagnostic(f'Missing arrow sidecar: {path.name}')
    text=path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text),path


def _json(text):
    def pairs(items):
        result={}
        for key,value in items:
            if key in result:
                raise ArrowCaptureDiagnostic(f'Duplicate JSON key in arrow inputs: {key}')
            result[key]=value
        return result
    def nonfinite(value):
        raise ArrowCaptureDiagnostic(f'Arrow inputs contain nonfinite JSON value {value}')
    try:
        return json.loads(text,object_pairs_hook=pairs,parse_constant=nonfinite)
    except json.JSONDecodeError as error:
        raise ArrowCaptureDiagnostic(f'Invalid arrow inputs JSON: {error}') from error


def _option_number(text):
    if not re.fullmatch(r'[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?',text):
        raise ArrowCaptureDiagnostic('Arrow numeric option must be a literal number')
    value=int(text) if re.fullmatch(r'[-+]?\d+',text) else float(text)
    if not _finite(value):
        raise ArrowCaptureDiagnostic('Arrow numeric option must be finite')
    return value


def _options(text):
    result={}
    for entry in text.split(','):
        if not entry.strip():
            continue
        if '=' not in entry:
            raise ArrowCaptureDiagnostic(f'Arrow option requires key=value: {entry.strip()}')
        key,value=(part.strip() for part in entry.split('=',1))
        if key not in set(OPTION_SOCKETS)|{'id','collision'}:
            raise ArrowCaptureDiagnostic(f'Unknown arrow option: {key}')
        if key in result:
            raise ArrowCaptureDiagnostic(f'Duplicate arrow option: {key}')
        if not value:
            raise ArrowCaptureDiagnostic(f'Arrow option {key} must be nonempty')
        if key in ('start','end'):
            if value not in ('none','triangle','stealth'):
                raise ArrowCaptureDiagnostic('Arrow start/end must be none, triangle or stealth')
            value={'none':0,'triangle':1,'stealth':2}[value]
        elif key=='collision':
            if value not in ('error','clamp'):
                raise ArrowCaptureDiagnostic('Arrow collision must be error or clamp')
        elif key!='id':
            value=_option_number(value)
        result[key]=value
    return result


def _span(text,path,output):
    lines=text.split('\n')
    return {'file':path.relative_to(output).as_posix(),'start':{'line':1,'column':1},
            'end':{'line':len(lines),'column':len(lines[-1])+1}}


def _archive(text,path,output):
    folder=output/'arrow-sources';folder.mkdir(parents=True,exist_ok=True)
    archived=folder/path.name;temporary=archived.with_suffix(archived.suffix+'.tmp')
    shutil.copyfile(path,temporary);temporary.replace(archived)
    return _span(text,archived,output)


def _expression(text,base,socket,output):
    folder=output/'arrow-sources';folder.mkdir(parents=True,exist_ok=True)
    archived=folder/f'{base}.{socket}.expression.txt';temporary=archived.with_suffix(archived.suffix+'.tmp')
    temporary.write_bytes((text+'\n').encode('utf8'));temporary.replace(archived)
    return _span(text,archived,output)


def _input(value,unit,base,socket,output):
    if isinstance(value,dict) and set(value)=={'operation','socket'} and all(isinstance(value[k],str) and value[k] for k in ('operation','socket')):
        return {'kind':'output','ref':value}
    if _finite(value):
        return {'kind':'literal','value':{'type':'scalar','unit':unit,'value':value}}
    if isinstance(value,str):
        return {'kind':'expression','expression':value,'unit':unit,'sourceSpan':_expression(value,base,socket,output)}
    if isinstance(value,dict) and set(value)=={'node','property'} and all(isinstance(value[k],str) and value[k] for k in ('node','property')):
        return {'kind':'property','node':value['node'],'property':value['property'],'unit':unit}
    raise ArrowCaptureDiagnostic(f'Arrow {socket} requires a finite number, scalar expression, property or output reference')


def lower_arrows(records: list[dict], bundle: dict, execution: Path, output: Path) -> None:
    declarations=[record for record in records if record['type']=='arrow-file']
    if not declarations:
        return
    graph=bundle.setdefault('operationGraph',{'version':1,'operations':[],'bindings':[]})
    nodes={node['id']:node for node in bundle['nodes']};seen=set();targets=set()
    for record in declarations:
        base=record.get('file','')
        if base in seen:
            raise ArrowCaptureDiagnostic(f'Duplicate arrow declaration file: {base}')
        seen.add(base)
        options=_options(_read(execution,base,'options')[0])
        target=_read(execution,base,'target')[0].strip();node=nodes.get(target,{})
        if node.get('kind')!='path' or not node.get('geometry'):
            raise ArrowCaptureDiagnostic('Arrow target must be an existing editable path')
        if target in targets or 'arrows' in node:
            raise ArrowCaptureDiagnostic('Arrow target already has an explicit arrow declaration')
        targets.add(target)
        if 'arrowStart' in node or 'arrowEnd' in node or 'arrowSize' in node:
            raise ArrowCaptureDiagnostic('Explicit arrows cannot be combined with legacy arrowStart/arrowEnd flags')
        text,path=_read(execution,base,'inputs');values=_json(text)
        if not isinstance(values,dict) or set(values)-set(DEFAULTS):
            raise ArrowCaptureDiagnostic('Arrow inputs must be an object containing only supported numeric sockets')
        span=_archive(text,path,output)
        for option,socket in OPTION_SOCKETS.items():
            if option in options and socket in values:
                raise ArrowCaptureDiagnostic(f'Arrow {socket} specified in both options and JSON')
        inputs={key:_input(value,UNITS[key],base,key,output) for key,value in values.items()}
        static={**DEFAULTS,'collision':options.get('collision','error')}
        for option,socket in OPTION_SOCKETS.items():
            if option in options:
                value=options[option];inputs[socket]=_input(value,UNITS[socket],base,socket,output);static[socket]=value
        for key,value in values.items():
            if _finite(value):
                static[key]=value
        node['arrows']=static
        operation=options.get('id','arrows:'+target)
        graph['operations'].append({'id':operation,'operator':'arrowStyle','version':1,'spaces':{},'inputs':inputs,'sourceSpan':span})
        for key in DEFAULTS:
            graph['bindings'].append({'target':target,'property':'arrows.'+key,
                'value':{'operation':operation,'socket':key},'sourceSpan':span})
    bundle['version']='0.3'
