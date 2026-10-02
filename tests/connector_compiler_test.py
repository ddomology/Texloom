"""Executed TeX connector declarations, PGF references and measured label poses."""
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'tools'))
from compile import compile_scene, CompileDiagnostic, PT_TO_BP
from connector_capture import lower_connectors, ConnectorCaptureDiagnostic
from tests.intersection_compiler_test import samples, without_provenance


def document(body='', package=True):
    preamble = r'''\documentclass{article}
\usepackage{tikz}
\newwrite\ReferenceFile
\newdimen\ReferenceX
\newdimen\ReferenceY
'''+('\\usepackage{texloom-connectors}\n' if package else '\\usepackage{texloom-expressions}\n')
    nodes = r'''
\begin{document}
\TLScene{Connector fixtures}{400}{250}{2}
\TLNode{A}{ellipse}{"cx":20,"cy":30,"rx":10,"ry":6}
\TLNode{B}{ellipse}{"cx":180,"cy":120,"rx":8,"ry":8}
\TLNode{P}{point}{"x":0,"y":0,"r":2}
\TLMath{art}{x_g^\alpha}
\TLNode{L}{tex}{"resourceId":"art","x":17,"y":31}
\TLNode{M}{tex}{"resourceId":"art","x":0,"y":0}
\TLNode{N}{tex}{"resourceId":"art","x":0,"y":0}
'''
    for name in ('s','h','v','c'):
        nodes += '\\TLNode{edge-'+name+'}{path}{"d":"M0 0L1 0","geometry":{"contours":[{"id":"initial","start":[0,0],"segments":[{"id":"initial","kind":"line","to":[1,0]}]}]}}\n'
    return preamble+nodes+body+'\n\\end{document}\n'


def transformed_anchor(frame, node_id):
    node = next(n for n in frame['nodes'] if n['id']==node_id)
    metrics = frame['resources'][node['resourceId']]['metrics']
    scale = node.get('scale',1)
    x = scale*metrics['width']/2
    y = scale*(metrics['depth']-metrics['height'])/2
    transform = node.get('transform',{})
    sx,sy=transform.get('scale',[1,1]);tx,ty=transform.get('translate',[0,0]);angle=transform.get('rotate',0)
    return [tx+math.cos(angle)*sx*x-math.sin(angle)*sy*y,
            ty+math.sin(angle)*sx*x+math.cos(angle)*sy*y]


class ConnectorCompilerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def capture(self,name,body,text=None):
        folder=self.folder/name;folder.mkdir()
        (folder/'scene.tex').write_text(text or document(body),encoding='utf8')
        env=os.environ.copy();env['TEXINPUTS']=str(ROOT/'tex')+os.pathsep+env.get('TEXINPUTS','')
        result=subprocess.run(['latex','-no-shell-escape','-interaction=nonstopmode','-halt-on-error','scene.tex'],cwd=folder,env=env,capture_output=True,text=True,encoding='utf8',errors='replace')
        self.assertEqual(result.returncode,0,result.stdout[-5000:]+result.stderr)
        records=[json.loads(line) for line in (folder/'scene.tl.jsonl').read_text(encoding='utf8').splitlines()]
        bundle={'version':'0.1','nodes':[r['value'] for r in records if r['type']=='node'],'resources':{}}
        return folder,records,bundle

    def compile(self,name,body,text=None):
        source=self.folder/(name+'.tex');source.write_text(text or document(body),encoding='utf8')
        output=self.folder/(name+'-out')
        return output,compile_scene(source,output)

    def test_literal_capture_inline_anchor_and_label_spaces_are_exact(self):
        expression='\n vec2(1bp,2bp) + \\macro + "quote" % # ## ^^M ^^J &&\n'
        payload=json.dumps({'from':{'anchor':{'source':'node:A','query':{'towards':{'expression':expression}},'outerSep':[2,3]}},'to':[100,80]},indent=2)
        body='\\loomconnector[space=plot:chart]{edge-s}{'+payload+'}\n'+r'''
\loompathlabel[at=.5,rotate=upright,inner-sep=[2,3]]{L}{{"path":{"operation":"connector:edge-s","socket":"path","space":"plot:chart"},"offset":"2bp+time/1s*1bp"}}
'''
        folder,records,bundle=self.capture('literal',body)
        next(n for n in bundle['nodes'] if n['id']=='L')['transform']={'scale':[1.25,-.75]}
        lower_connectors(records,bundle,folder,folder)
        connector,local,path,label=bundle['operationGraph']['operations']
        point=connector['inputs']['from']['query']['towards']
        self.assertEqual(point['expression'],expression)
        self.assertEqual((folder/point['sourceSpan']['file']).read_text(encoding='utf8'),expression+'\n')
        self.assertEqual((folder/connector['sourceSpan']['file']).read_text(encoding='utf8'),payload+'\n')
        self.assertEqual(local['spaces']['to'],{'kind':'local','node':'edge-s'})
        self.assertEqual(path['spaces']['to'],{'kind':'parent','node':'L'})
        self.assertEqual(label['inputs']['anchor'],{'kind':'textAnchor','node':'L','anchor':'center','innerSep':[2,3]})
        self.assertEqual([label['inputs'][key]['value']['value'] for key in ('scaleX','scaleY')],[1.25,-.75])
        self.assertEqual([b['property'] for b in bundle['operationGraph']['bindings']],['geometry','transform','x','y'])

    def test_invalid_lowering_and_malformed_node_metadata_have_diagnostics(self):
        cases=[('order',r'\loomconnector[order=vertical]{edge-s}{{"from":[0,0],"to":[1,1]}}','requires route=orthogonal'),
               ('handles',r'\loomconnector[route=cubic]{edge-c}{{"from":[0,0],"to":[1,1],"handleA":[2,2]}}','requires exactly'),
               ('space',r'\loompathlabel[space=scene]{L}{{"path":"edge-s"}}','Unknown label option'),
               ('duplicate',r'\loompathlabel[at=.5]{L}{{"path":"edge-s","parameter":0.7}}','both options'),
               ('target',r'\loompathlabel{P}{{"path":"edge-s"}}','raw TeX node')]
        for name,body,message in cases:
            with self.subTest(name=name):
                folder,records,bundle=self.capture('invalid-'+name,body)
                with self.assertRaisesRegex(ConnectorCaptureDiagnostic,message):lower_connectors(records,bundle,folder,folder)
        malformed=[('transform-null','transform',None),('scale-number','scale',2),('scale-null','scale',None),('scale-empty','scale',[]),('scale-nonfinite','scale',[1,'bad']),('metrics-null','anchorMetrics',None),('metrics-number','anchorMetrics',2),('metrics-array','anchorMetrics',[])]
        for name,key,value in malformed:
            with self.subTest(name=name):
                body=(r'\loomconnector{edge-s}{{"from":{"anchor":{"source":"node:A","query":"east"}},"to":[100,80]}}' if key=='anchorMetrics' else r'\loompathlabel{L}{{"path":"edge-s"}}')
                target='A' if key=='anchorMetrics' else 'L'
                extra={key:value} if key!='scale' else {'transform':{'scale':value}}
                text=document(body)
                marker='\\TLNode{'+target+'}{'+('ellipse' if target=='A' else 'tex')+'}{'
                text=text.replace(marker,marker+json.dumps(extra)[1:-1]+',',1)
                folder,records,bundle=self.capture(name,body,text)
                with self.assertRaises(ConnectorCaptureDiagnostic):lower_connectors(records,bundle,folder,folder)

    def test_native_pgf_routes_parameter_labels_and_independent_length(self):
        body=r'''
\loomconnector{edge-s}{{"from":[10,20],"to":[90,80]}}
\loomconnector[route=orthogonal,order=horizontal]{edge-h}{{"from":[10,20],"to":[90,80]}}
\loomconnector[route=orthogonal,order=vertical]{edge-v}{{"from":[10,20],"to":[90,80]}}
\loomconnector[route=cubic]{edge-c}{{"from":[10,20],"to":[90,80],"handleA":[15,95],"handleB":[60,-10]}}
\loompathlabel[mode=parameter,at=.5]{L}{{"path":"edge-h"}}
\loompathlabel[mode=length,at=.5]{M}{{"path":"edge-h"}}
\loompathlabel[mode=parameter,at=.25]{N}{{"path":"edge-c"}}
\immediate\openout\ReferenceFile=pgf-reference.txt
\begin{tikzpicture}[x=1bp,y=1bp]
 \path (10,20)-|(90,80) coordinate[pos=.5] (horizontal);
 \path (10,20)|-(90,80) coordinate[pos=.5] (vertical);
 \path (10,20)..controls(15,95)and(60,-10)..(90,80) coordinate[pos=.25] (cubic);
 \foreach \name in {horizontal,vertical,cubic}{
  \pgfextractx{\ReferenceX}{\pgfpointanchor{\name}{center}}
  \pgfextracty{\ReferenceY}{\pgfpointanchor{\name}{center}}
  \immediate\write\ReferenceFile{\the\ReferenceX,\the\ReferenceY}}
\end{tikzpicture}
\immediate\closeout\ReferenceFile
'''
        output,_=self.compile('pgf',body)
        result=samples(output/'bundle.json')[0];self.assertIn('frame',result,result)
        frame=result['frame'];nodes={n['id']:n for n in frame['nodes']}
        self.assertEqual(nodes['edge-s']['geometry']['contours'][0]['segments'][0]['to'],[90,80])
        self.assertEqual([s['to'] for s in nodes['edge-h']['geometry']['contours'][0]['segments']],[[90,20],[90,80]])
        self.assertEqual([s['to'] for s in nodes['edge-v']['geometry']['contours'][0]['segments']],[[10,80],[90,80]])
        pgf=[[float(v.removesuffix('pt'))*PT_TO_BP for v in line.split(',')] for line in next(output.glob('runs/compile-*/source/pgf-reference.txt')).read_text().splitlines()]
        self.assertEqual(len(pgf),3)
        cubic=[.75**3*10+3*.75**2*.25*15+3*.75*.25**2*60+.25**3*90,
               .75**3*20+3*.75**2*.25*95+3*.75*.25**2*(-10)+.25**3*80]
        for actual,expected in zip(pgf,[[90,20],[10,80],cubic]):
            for x,y in zip(actual,expected):self.assertAlmostEqual(x,y,delta=.02)
        for label,expected in [('L',pgf[0]),('M',[80,20]),('N',cubic)]:
            for x,y in zip(transformed_anchor(frame,label),expected):self.assertAlmostEqual(x,y,delta=.02)
        self.assertGreater(abs(transformed_anchor(frame,'L')[0]-transformed_anchor(frame,'M')[0]),9)

    def test_reflected_parent_metrics_and_live_anchor_changes_are_stateless(self):
        body=r'''
\TLNode{panel}{group}{"transform":{"translate":[100,100],"scale":[-2,1.5]}}
\TLTrack{A}{rx}{linear}{[[0,10],[1,18],[2,10]]}
\TLTrack{L}{scale}{linear}{[[0,1.3],[1,1.8],[2,1.3]]}
\loomconnector{edge-s}{{"from":{"anchor":{"source":"node:A","query":"east","outerSep":4}},"to":{"anchor":{"source":"node:B","query":"west"}}}}
\loompathlabel[mode=parameter,at=.3,offset=6,rotate=upright]{L}{{"path":{"operation":"connector:edge-s","socket":"path","space":"scene"}}}
'''
        text=document(body).replace('\\TLNode{L}{tex}{','\\TLNode{L}{tex}{"parent":"panel","scale":1.3,"transform":{"translate":[99,88],"rotate":1.1,"scale":[-1.25,0.8]},',1)
        text=text.replace('\\TLNode{edge-s}{path}{','\\TLNode{edge-s}{path}{"parent":"panel","transform":{"translate":[7,-3],"scale":[1.2,0.9]},',1)
        output,_=self.compile('reflected',body,text)
        results=samples(output/'bundle.json',(0,1,2,0));self.assertTrue(all('frame' in r for r in results),results)
        frames=[r['frame'] for r in results];self.assertEqual(frames[0],frames[-1])
        for frame,radius in zip(frames,[10,18,10,10]):
            start=[(20+radius+4-100)/(-2),(30-100)/1.5];end=[(172-100)/(-2),(120-100)/1.5]
            dx,dy=end[0]-start[0],end[1]-start[1];length=math.hypot(dx,dy)
            expected=[start[0]+.3*dx-6*dy/length,start[1]+.3*dy+6*dx/length]
            for x,y in zip(transformed_anchor(frame,'L'),expected):self.assertAlmostEqual(x,y,delta=1e-8)
            label=next(n for n in frame['nodes'] if n['id']=='L');self.assertEqual([label['x'],label['y']],[0,0])

    def test_repeat_compiles_and_empty_package_preserve_compatibility(self):
        body=r'''
\loomconnector[route=cubic]{edge-c}{{"from":[0,0],"to":[100,50],"handleA":{"expression":"vec2(20bp,30bp)"},"handleB":[80,40]}}
\loompathlabel{L}{{"path":"edge-c","parameter":"0.25+time/8s"}}
'''
        source=self.folder/'repeat.tex';source.write_text(document(body),encoding='utf8')
        outputs=[]
        for i in range(2):
            output=self.folder/('repeat-out-'+str(i));outputs.append((output,compile_scene(source,output)))
        self.assertEqual(without_provenance(outputs[0][1]),without_provenance(outputs[1][1]))
        for output,bundle in outputs:
            for operation in bundle['operationGraph']['operations']:
                archived=output/operation['sourceSpan']['file']
                self.assertEqual(archived.read_bytes(),next(output.glob('runs/compile-*/source/'+archived.name)).read_bytes())
        canonical=[]
        source=self.folder/'empty.tex'
        for package in (False,True):
            source.write_text('\n'.join(line for line in document('',package).splitlines() if '}{path}' not in line),encoding='utf8')
            bundle=compile_scene(source,self.folder/('empty-out-'+str(package)))
            self.assertNotIn('operationGraph',bundle);self.assertEqual(bundle['version'],'0.1')
            canonical.append(without_provenance(bundle))
        self.assertEqual(canonical[0],canonical[1])

    def test_shared_validation_rejects_writer_cycles_units_and_space_mismatch(self):
        cases=[('cycle',r'\loomconnector{edge-s}{{"from":"L","to":[100,20]}}\loompathlabel{L}{{"path":"edge-s"}}','cycle|CYCLE'),
               ('units',r'\loompathlabel{L}{{"path":"edge-s","offset":"2s"}}','unit|UNIT'),
               ('bare-space',r'\loomconnector{edge-s}{{"from":[0,0],"to":[100,20]}}\loompathlabel{L}{{"path":{"operation":"connector:edge-s","socket":"path"}}}','space|SPACE')]
        for name,body,message in cases:
            with self.subTest(name=name):
                with self.assertRaisesRegex(CompileDiagnostic,message):self.compile(name,body)


if __name__=='__main__':
    unittest.main()
