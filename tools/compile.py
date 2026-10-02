"""Compile trusted authored TeX into a versioned Texloom object bundle.

Usage: python tools/compile.py examples/orbit.tex --out build/demo
TeX is executed with shell escape disabled. Run untrusted TeX in an OS sandbox.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import tempfile

from svg_import import import_svg, ImportDiagnostic
from tikz_capture import CAPTURE_PREAMBLE, ANCHOR_CAPTURE_PREAMBLE, read_capture, read_soft_path, lower_records
from expression_capture import lower_expressions
from field_capture import lower_fields
from deformation_capture import lower_deformations
from coordinate_capture import lower_coordinates
from shape_capture import lower_shapes
from anchor_capture import lower_anchors
from curve_capture import lower_curves
from intersection_capture import lower_intersections
from connector_capture import lower_connectors

ROOT=Path(__file__).resolve().parents[1]
PT_TO_BP=72/72.27

class CompileDiagnostic(ValueError): pass

def decode_detokenized(text):
    # TeX's detokenize/write representation doubles parameter-character tokens.
    # Restore a single serialization layer, including CSS hex colors and #1 in
    # user macro definitions. A source ## becomes #### and returns to ##.
    return text.replace('##', '#')

def digest(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def write_json(path,data):
    path=Path(path); temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    temporary.replace(path)

def run(command,cwd,env=None):
    start=time.perf_counter()
    p=subprocess.run(command,cwd=cwd,env=env,capture_output=True,text=True,encoding='utf8',errors='replace')
    log=' '.join(map(str,command))+'\n'+p.stdout+'\n'+p.stderr
    if p.returncode: raise CompileDiagnostic(log[-12000:])
    return {'command':list(map(str,command)),'seconds':round(time.perf_counter()-start,4),'output':p.stdout+p.stderr}

def version(executable):
    p=subprocess.run([executable,'--version'],capture_output=True,text=True,encoding='utf8',errors='replace')
    return p.stdout.splitlines()[0] if p.stdout else 'unknown'

def asset_document(body,kind,setup,anchor_capture=False):
    content=(r'$\displaystyle '+body+'$') if kind=='math' else body
    return r'''\documentclass[12pt]{article}
\usepackage[T1]{fontenc}
\usepackage{lmodern,amsmath,amssymb,tikz}
\usetikzlibrary{arrows.meta,calc,shapes.geometric}
\pagestyle{empty}
'''+setup+CAPTURE_PREAMBLE+(ANCHOR_CAPTURE_PREAMBLE if anchor_capture else '')+r'''
\newsavebox{\TLbox}
\newwrite\TLmetrics
\begin{document}
\setbox\TLbox=\hbox{'''+content+r'''}
\immediate\openout\TLmetrics=asset.metrics
\immediate\write\TLmetrics{\the\wd\TLbox,\the\ht\TLbox,\the\dp\TLbox}
\immediate\closeout\TLmetrics
\noindent\hbox{\special{dvisvgm:raw <g data-tex-origin-x='{?x}' data-tex-origin-y='{?y}'/>}\box\TLbox}
\end{document}
'''

def compile_resource(resource,execution,out,setup,commands,anchor_capture=False):
    rid=resource['id']
    if not re.fullmatch(r'[A-Za-z][\w-]*',rid): raise CompileDiagnostic(f'Invalid resource ID: {rid}')
    path=execution/resource['file']
    if path.parent!=execution or not path.exists(): raise CompileDiagnostic(f'Missing generated TeX asset {path.name}')
    body=decode_detokenized(path.read_text(encoding='utf8')).strip()
    folder=out/'assets'/rid; folder.mkdir(parents=True,exist_ok=True)
    (folder/'asset.tex').write_text(asset_document(body,resource['kind'],setup,anchor_capture),encoding='utf8')
    result=run(['latex','-no-shell-escape','-interaction=nonstopmode','-halt-on-error','asset.tex'],folder)
    commands.append({'resource':rid,**{k:v for k,v in result.items() if k!='output'}})
    values=(folder/'asset.metrics').read_text().strip().split(',')
    metrics={k:round(float(v.removesuffix('pt'))*PT_TO_BP,8) for k,v in zip(('width','height','depth'),values)}
    result=run(['dvisvgm','--no-fonts','--exact-bbox','--bbox=min','--precision=6','--currentcolor','--output=asset.svg','asset.dvi'],folder)
    commands.append({'resource':rid,**{k:v for k,v in result.items() if k!='output'}})
    vector=import_svg(folder/'asset.svg',metrics,body)
    vector['provenance'].update({'engine':'latex-dvi','dvi':str((folder/'asset.dvi').relative_to(out)).replace('\\','/'),
        'dviSha256':digest(folder/'asset.dvi'),'texSha256':digest(folder/'asset.tex'),'svgTransportSha256':digest(folder/'asset.svg'),
        'logicalMetricsTeXPt':{k:float(v.removesuffix('pt')) for k,v in zip(('width','height','depth'),values)}})
    if resource['kind'] in ('tikz-node','tikz-path','tikz-geometry'):
        vector['provenance']['pgfCapture']=read_capture(folder/'asset.anchors')
        vector.setdefault('capabilities',[]).append('pgf-measured-anchors' if resource['kind']=='tikz-node' else 'pgf-native-path')
    if resource['kind']=='tikz-geometry':
        vector['provenance']['pgfSoftPath']=read_soft_path(folder/'asset.path')
        vector['provenance']['pgfSoftPathSha256']=digest(folder/'asset.path')
        vector.setdefault('capabilities',[]).append('pgf-editable-soft-path')
    return vector

def scalar_resource(path):
    r=json.loads(path.read_text(encoding='utf8'))
    if r.get('kind')!='scalar-field': raise CompileDiagnostic('Field file kind must be scalar-field')
    columns,rows=r.get('columns'),r.get('rows')
    if not all(isinstance(n,int) and not isinstance(n,bool) and 2<=n<=4096 for n in (columns,rows)): raise CompileDiagnostic('Invalid field grid dimensions')
    times=r.get('times',[]); samples=r.get('samples',[])
    if len(times)<1 or len(times)!=len(samples) or any(not isinstance(t,(int,float)) or not math.isfinite(t) for t in times): raise CompileDiagnostic('Invalid field times')
    if any(b<=a for a,b in zip(times,times[1:])): raise CompileDiagnostic('Field times must strictly increase')
    if any(len(s)!=columns*rows or any(not isinstance(v,(int,float)) or not math.isfinite(v) for v in s) for s in samples): raise CompileDiagnostic('Invalid field samples')
    if r.get('interpolation') not in ('linear','step'): raise CompileDiagnostic('Invalid field interpolation')
    bounds=r.get('range',[])
    if len(bounds)!=2 or not all(isinstance(x,(int,float)) and math.isfinite(x) for x in bounds) or bounds[0]>=bounds[1]: raise CompileDiagnostic('Invalid field range')
    r.setdefault('provenance',{}).update({'fileSha256':digest(path),'sourceFile':path.name})
    return r

def compile_scene(source,out):
    source=Path(source).resolve(); out=Path(out).resolve(); out.mkdir(parents=True,exist_ok=True)
    # Each run owns fresh TeX state. In particular removing TLSetup from a source
    # must not retain an earlier generated preamble, aux, or asset body.
    previous_bundle=out/'bundle.json'
    if previous_bundle.is_file(): previous_bundle.unlink()
    write_json(out/'compile-report.json',{'success':False,'status':'compiling','diagnostics':[]})
    runs=out/'runs'; runs.mkdir(exist_ok=True)
    run_root=Path(tempfile.mkdtemp(prefix='compile-',dir=runs))
    execution=run_root/'source'; execution.mkdir()
    shutil.copyfile(source,execution/'scene.tex')
    env=os.environ.copy(); env['TEXINPUTS']=str(ROOT/'tex')+os.pathsep+str(source.parent)+os.pathsep+env.get('TEXINPUTS','')
    commands=[]
    result=run(['latex','-no-shell-escape','-interaction=nonstopmode','-halt-on-error','scene.tex'],execution,env)
    commands.append({k:v for k,v in result.items() if k!='output'})
    records=[]
    for line_no,line in enumerate((execution/'scene.tl.jsonl').read_text(encoding='utf8').splitlines(),1):
        try: records.append(json.loads(decode_detokenized(line)))
        except json.JSONDecodeError as e: raise CompileDiagnostic(f'Invalid declaration JSON at generated record {line_no}: {e}') from e
    scenes=[r for r in records if r['type']=='scene']
    if len(scenes)!=1: raise CompileDiagnostic('Exactly one TLScene declaration is required')
    scene=scenes[0]
    anchor_capture=any(record['type']=='anchor-profile' for record in records)
    for record in records:
        if record['type']=='tikz-geometry' and record['stroke']=='none' and record['fill']=='none':
            raise CompileDiagnostic('Live geometry currently requires draw or fill paint for its PGF reference artifact')
    bundle={'version':scene.get('version','0.1'),'title':scene['title'],'duration':scene['duration'],'viewport':{'width':scene['width'],'height':scene['height']},
            'units':'bp','nodes':[],'tracks':[],'relations':[],'resources':{},'camera':{'x':0,'y':0,'zoom':1},'diagnostics':[]}
    setup_path=execution/'scene.tl-setup.tex'; setup=decode_detokenized(setup_path.read_text(encoding='utf8')) if setup_path.exists() else ''
    tikz_setup_path=execution/'scene.tl-tikz-setup.tex'
    if tikz_setup_path.exists(): setup+='\n'+decode_detokenized(tikz_setup_path.read_text(encoding='utf8'))
    seen_resources=set()
    for number,record in enumerate(records,1):
        kind=record['type']
        if kind in ('node','track','relation'):
            val=record['value']
            if kind=='node': val['source']={'file':source.name,'declaration':number,'line':record.get('line')}
            if kind=='node' and record.get('rotationUnit')=='degrees': val['transform']['rotate']=math.radians(val['transform']['rotate'])
            bundle[{'node':'nodes','track':'tracks','relation':'relations'}[kind]].append(val)
        elif kind=='camera': bundle['camera']=record['value']
        elif kind=='document': bundle['document']=record['value']
        elif kind in ('resource','field-file'):
            rid=record['id']
            if rid in seen_resources: raise CompileDiagnostic(f'Duplicate resource ID: {rid}')
            seen_resources.add(rid)
            if kind=='resource':
                vector=compile_resource(record,execution,run_root,setup,commands,anchor_capture)
                vector['provenance']['dvi']=str((run_root/vector['provenance']['dvi']).relative_to(out)).replace('\\','/')
                bundle['resources'][rid]=vector
            else: bundle['resources'][rid]=scalar_resource((source.parent/record['file']).resolve())
        elif kind not in ('scene','expression-file','field-program-file','deformation-file','coordinate-file','shape-file','anchor-profile','anchor-file','curve-file','intersection-file','connector-file') and not kind.startswith('tikz-'): raise CompileDiagnostic(f'Unknown declaration type {kind}')
    if bundle['version'] in ('0.2','0.3'): lower_records(records,bundle,source.name)
    lower_expressions(records,bundle,execution,out)
    lower_fields(records,bundle,execution,out)
    lower_deformations(records,bundle,execution,out)
    lower_coordinates(records,bundle,execution,out)
    lower_shapes(records,bundle,execution,out)
    lower_anchors(records,bundle,execution,out)
    lower_curves(records,bundle,execution,out)
    lower_intersections(records,bundle,execution,out)
    lower_connectors(records,bundle,execution,out)
    node_ids=[n['id'] for n in bundle['nodes']]
    if len(set(node_ids))!=len(node_ids): raise CompileDiagnostic('Duplicate scene node ID')
    targets=[(t['target'],t['property']) for t in bundle['tracks']]
    if len(set(targets))!=len(targets): raise CompileDiagnostic('Multiple tracks target the same property')
    bundle['provenance']={'compiler':'texloom-python-v'+bundle['version'],'sourceFile':source.name,'sourceSha256':digest(source),
        'frontend':'executed LaTeX declarations','typesetting':'TeX boxes + DVI + dvisvgm transport + strict vector import',
        'toolchain':{'latex':version('latex'),'dvisvgm':version('dvisvgm')},'sourceDvi':str((execution/'scene.dvi').relative_to(out)).replace('\\','/'),
        'sourceDviSha256':digest(execution/'scene.dvi'),'units':{'texPtPerInch':72.27,'sceneBpPerInch':72},
        'compatibility':('Executed named TikZ wrappers; real PGF anchors, artwork and declared editable soft paths; explicit runtime relations. Arbitrary TikZ source does not gain inferred animation semantics.' if bundle['version'] in ('0.2','0.3') else 'Explicit v0.1 scene DSL and supported vector transport; arbitrary TeX animation semantics are not inferred.')}
    # One shared validator defines the interchange contract for compiler and player.
    # Validate before publishing; malformed tracks or resources cannot be reported
    # as a successful scene merely because their TeX happened to compile.
    candidate=run_root/'candidate.json'; write_json(candidate,bundle)
    validation=run(['node',str(ROOT/'tools/validate-bundle.mjs'),str(candidate)],ROOT)
    bundle['diagnostics'].extend(json.loads(validation['output'].strip()))
    candidate.unlink()
    write_json(out/'bundle.json',bundle); write_json(out/'compile-report.json',{'success':True,'commands':commands,'records':len(records),
        'nodes':len(bundle['nodes']),'resources':len(bundle['resources']),'diagnostics':bundle['diagnostics']})
    return bundle

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('source'); parser.add_argument('--out',required=True); args=parser.parse_args()
    try:
        bundle=compile_scene(args.source,args.out)
        print(f'Compiled {bundle["title"]}: {len(bundle["nodes"])} nodes, {len(bundle["resources"])} resources -> {Path(args.out)/"bundle.json"}')
    except (CompileDiagnostic,ImportDiagnostic,KeyError,OSError,ValueError) as e:
        out=Path(args.out); out.mkdir(parents=True,exist_ok=True)
        write_json(out/'compile-report.json',{'success':False,'diagnostics':[{'severity':'error','code':'COMPILER_ERROR','message':str(e)}]})
        print(str(e),file=sys.stderr); return 1
    return 0

if __name__=='__main__': sys.exit(main())
