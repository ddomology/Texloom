"""Real TeX arrow declarations and native PGF tip-geometry references."""
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from compile import compile_scene,CompileDiagnostic
from arrow_capture import lower_arrows,ArrowCaptureDiagnostic
from tests.intersection_compiler_test import samples,without_provenance


def document(body='',package=True):
    return r'''\documentclass{article}
\usepackage{tikz}
\usetikzlibrary{arrows.meta}
\pagestyle{empty}
'''+('\\usepackage{texloom-arrows}\n' if package else '\\usepackage{texloom-expressions}\n')+r'''
\begin{document}
\TLScene{Arrow fixtures}{300}{200}{2}
\TLNode{P}{point}{"x":0,"y":0,"r":8}
\TLNode{edge}{path}{"d":"M0 0L100 0","geometry":{"contours":[{"id":"line","start":[0,0],"segments":[{"id":"line","kind":"line","to":[100,0]}]}]},"style":{"stroke":"#123456","strokeWidth":2,"fill":"none"}}
\TLNode{other}{path}{"d":"M0 20L100 20","geometry":{"contours":[{"id":"line","start":[0,20],"segments":[{"id":"line","kind":"line","to":[100,20]}]}]}}
'''+body+'\n\\end{document}\n'


def vertices(geometry):
    contour=geometry['contours'][0]
    return [contour['start']]+[segment['to'] for segment in contour['segments']]


def svg_vertices(data):
    tokens=re.findall(r'[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?',data)
    points=[];x=y=0.;index=0;command=''
    while index<len(tokens):
        if tokens[index].isalpha():command=tokens[index];index+=1
        if command=='Z':break
        if command in ('M','L'):
            x,y=float(tokens[index]),float(tokens[index+1]);index+=2
        elif command=='H':x=float(tokens[index]);index+=1
        elif command=='V':y=float(tokens[index]);index+=1
        else:raise AssertionError('Unexpected native PGF tip SVG command: '+command)
        points.append([x,y])
    return points


class ArrowCompilerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def capture(self,name,body):
        folder=self.folder/name;folder.mkdir();(folder/'scene.tex').write_text(document(body),encoding='utf8')
        env=os.environ.copy();env['TEXINPUTS']=str(ROOT/'tex')+os.pathsep+env.get('TEXINPUTS','')
        result=subprocess.run(['latex','-no-shell-escape','-interaction=nonstopmode','-halt-on-error','scene.tex'],cwd=folder,env=env,capture_output=True,text=True,encoding='utf8',errors='replace')
        self.assertEqual(result.returncode,0,result.stdout[-5000:]+result.stderr)
        records=[json.loads(line) for line in (folder/'scene.tl.jsonl').read_text(encoding='utf8').splitlines()]
        return folder,records,{'version':'0.1','nodes':[r['value'] for r in records if r['type']=='node'],'resources':{}}

    def compile(self,name,body,text=None):
        source=self.folder/(name+'.tex');source.write_text(text or document(body),encoding='utf8')
        output=self.folder/(name+'-out')
        return output,compile_scene(source,output)

    def test_literal_archive_and_typed_inputs_preserve_source_exactly(self):
        expression='\n 9bp + \\macro + "quote" % # ## ^^M ^^J &&\n'
        payload=json.dumps({'length':expression,'width':{'node':'P','property':'r'},'inset':{'operation':'supplied','socket':'value'}},indent=2)
        folder,records,bundle=self.capture('literal','\\loomarrows[start=stealth,end=triangle,tolerance=.05,collision=clamp]{edge}{'+payload+'}')
        lower_arrows(records,bundle,folder,folder)
        operation=bundle['operationGraph']['operations'][0];node=next(n for n in bundle['nodes'] if n['id']=='edge')
        self.assertEqual(operation['operator'],'arrowStyle');self.assertEqual(operation['spaces'],{})
        self.assertEqual(node['arrows']['start'],2);self.assertEqual(node['arrows']['end'],1);self.assertEqual(node['arrows']['collision'],'clamp')
        self.assertEqual(operation['inputs']['length']['unit'],'bp')
        self.assertEqual((folder/operation['inputs']['length']['sourceSpan']['file']).read_text(encoding='utf8'),expression+'\n')
        self.assertEqual((folder/operation['sourceSpan']['file']).read_text(encoding='utf8'),payload+'\n')
        self.assertEqual(len(bundle['operationGraph']['bindings']),8)
        self.assertEqual(operation['inputs']['width']['kind'],'property')
        self.assertEqual(operation['inputs']['inset']['kind'],'output')

    def test_invalid_authoring_is_diagnosed_before_publication(self):
        cases=[('tip',r'\loomarrows[end=latex]{edge}{{}}','none, triangle or stealth'),
               ('duplicate',r'\loomarrows{edge}{{}}\loomarrows{edge}{{}}','already has'),
               ('conflict',r'\loomarrows[length=12]{edge}{{"length":13}}','both options'),
               ('policy',r'\loomarrows[collision=ignore]{edge}{{}}','error or clamp'),
               ('target',r'\loomarrows{P}{{}}','editable path'),
               ('json',r'\loomarrows{edge}{{"length":9,"length":12}}','Duplicate JSON key')]
        for name,body,message in cases:
            with self.subTest(name=name):
                folder,records,bundle=self.capture(name,body)
                with self.assertRaisesRegex(ArrowCaptureDiagnostic,message):lower_arrows(records,bundle,folder,folder)
        folder,records,bundle=self.capture('legacy',r'\loomarrows{edge}{{}}')
        next(n for n in bundle['nodes'] if n['id']=='edge')['arrowEnd']=True
        with self.assertRaisesRegex(ArrowCaptureDiagnostic,'legacy'):lower_arrows(records,bundle,folder,folder)
        next(n for n in bundle['nodes'] if n['id']=='edge')['arrowEnd']=False
        with self.assertRaisesRegex(ArrowCaptureDiagnostic,'legacy'):lower_arrows(records,bundle,folder,folder)

    def test_filled_triangle_and_stealth_match_actual_pgf_dimensions(self):
        body=r'''
\loomarrows[end=triangle,length=12,width=8,inset=3]{edge}{{}}
\loomarrows[end=stealth,length=12,width=8,inset=3]{other}{{}}
\begin{tikzpicture}[x=1bp,y=1bp]
\draw[-{Triangle[length=12bp,width=8bp,line width=0pt]},line width=1bp] (0,0)--(100,0);
\draw[-{Stealth[length=12bp,width=8bp,inset=3bp,line width=0pt]},line width=1bp] (0,-20)--(100,-20);
\end{tikzpicture}
'''
        output,bundle=self.compile('pgf',body)
        result=samples(output/'bundle.json')[0];self.assertIn('frame',result,result)
        nodes={n['id']:n for n in result['frame']['nodes']}
        dvi=output/bundle['provenance']['sourceDvi'];svg=output/'pgf-reference.svg'
        command=subprocess.run(['dvisvgm','--no-fonts','--exact-bbox','--bbox=min','--precision=6','--output='+str(svg),str(dvi)],capture_output=True,text=True,encoding='utf8',errors='replace')
        self.assertEqual(command.returncode,0,command.stdout+command.stderr)
        paths=[element for element in ET.parse(svg).getroot().iter() if element.tag.endswith('}path')]
        tips=[svg_vertices(path.attrib['d']) for path in paths if path.attrib.get('fill')!='none']
        shafts=[svg_vertices(path.attrib['d']) for path in paths if path.attrib.get('fill')=='none']
        self.assertEqual(len(tips),2);self.assertEqual(len(shafts),2)
        for name,reference,shaft,cut in zip(('edge','other'),tips,shafts,(12,9)):
            actual=vertices(nodes[name]['resolvedArrows']['endTip']);origin=reference[0];nose=actual[0]
            normalized=[[point[0]-origin[0],point[1]-origin[1]] for point in reference]
            for point in actual:
                p=[point[0]-nose[0],point[1]-nose[1]]
                self.assertLess(min(math.dist(p,q) for q in normalized),.002)
            self.assertAlmostEqual(max(p[0] for p in normalized)-min(p[0] for p in normalized),12,delta=.002)
            self.assertAlmostEqual(max(p[1] for p in normalized)-min(p[1] for p in normalized),8,delta=.002)
            self.assertAlmostEqual(origin[0]-shaft[-1][0],cut,delta=.002)
            self.assertAlmostEqual(nodes[name]['resolvedArrows']['report']['shaftTrimEnd'],cut,delta=1e-9)

    def test_live_styles_preserve_original_geometry_and_reverse_evaluation(self):
        body=r'''
\TLTrack{P}{r}{linear}{[[0,8],[1,10],[2,8]]}
\loomarrows[end=stealth,inset=3]{edge}{{"length":"12bp+2bp*time/1s","width":{"node":"P","property":"r"},"shortenEnd":"2bp*time/1s"}}
'''
        text=document(body).replace('\\TLNode{edge}{path}{','\\TLNode{edge}{path}{"transform":{"translate":[20,30],"rotate":0.2,"scale":[-2,1.5]},',1)
        output,bundle=self.compile('live',body,text)
        results=samples(output/'bundle.json',(0,1,2,0));self.assertTrue(all('frame' in r for r in results),results)
        frames=[r['frame'] for r in results];self.assertEqual(frames[0],frames[-1])
        authored=next(n for n in bundle['nodes'] if n['id']=='edge')
        self.assertNotIn('resolvedArrows',authored)
        for frame,time,width in zip(frames,(0,1,2,0),(8,10,8,8)):
            node=next(n for n in frame['nodes'] if n['id']=='edge');resolved=node['resolvedArrows']
            self.assertEqual(node['geometry'],authored['geometry'])
            self.assertEqual(re.sub(r'\s+','',node['d']),re.sub(r'\s+','',authored['d']))
            self.assertEqual(node['transform'],authored['transform'])
            self.assertEqual(node['arrows']['width'],width)
            self.assertAlmostEqual(resolved['report']['end']['visualTip'][0],100-2*time,delta=1e-8)
            self.assertAlmostEqual(resolved['report']['shaftTrimEnd'],2*time+(12+2*time)-3,delta=1e-8)

    def test_collision_and_profile_errors_are_explicit(self):
        short=document(r'\loomarrows[start=triangle,end=triangle,length=9]{edge}{{}}').replace('"d":"M0 0L100 0"','"d":"M0 0L10 0"').replace('"to":[100,0]','"to":[10,0]')
        output,_=self.compile('collision-error','',short)
        self.assertIn('ARROW_COLLISION',samples(output/'bundle.json')[0]['error'])
        output,_=self.compile('collision-clamp','',short.replace('length=9]','length=9,collision=clamp]'))
        result=samples(output/'bundle.json')[0];self.assertIn('frame',result,result)
        arrow=next(n for n in result['frame']['nodes'] if n['id']=='edge')['resolvedArrows']
        self.assertGreater(arrow['report']['scale'],0);self.assertLess(arrow['report']['scale'],1)
        self.assertLess(arrow['report']['shaftTrimStart']+arrow['report']['shaftTrimEnd'],10)
        with self.assertRaises(CompileDiagnostic):self.compile('width',r'\loomarrows[width=-1]{edge}{{}}')
        output,_=self.compile('inset',r'\loomarrows[end=stealth,length=3,inset=4]{edge}{{}}')
        self.assertIn('ARROW_INSET',samples(output/'bundle.json')[0]['error'])
        with self.assertRaisesRegex(CompileDiagnostic,'unit|UNIT'):
            self.compile('unit',r'\loomarrows{edge}{{"length":"2s"}}')

    def test_repeat_archives_and_loading_package_are_deterministic(self):
        source=self.folder/'repeat.tex';source.write_text(document(r'\loomarrows[end=stealth]{edge}{{"length":"12bp+time/1s*1bp"}}'),encoding='utf8')
        outputs=[self.folder/'repeat-one',self.folder/'repeat-two'];bundles=[compile_scene(source,out) for out in outputs]
        self.assertEqual(without_provenance(bundles[0]),without_provenance(bundles[1]))
        for output,bundle in zip(outputs,bundles):
            operation=bundle['operationGraph']['operations'][0]
            archived=output/operation['sourceSpan']['file']
            self.assertEqual(archived.read_bytes(),next(output.glob('runs/compile-*/source/'+archived.name)).read_bytes())
            value=operation['inputs']['length'];self.assertEqual((output/value['sourceSpan']['file']).read_text(encoding='utf8'),value['expression']+'\n')
        canonical=[];source=self.folder/'empty.tex'
        for package in (False,True):
            source.write_text('\n'.join(line for line in document('',package).splitlines() if '}{path}' not in line),encoding='utf8')
            bundle=compile_scene(source,self.folder/('empty-'+str(package)))
            self.assertEqual(bundle['version'],'0.1');self.assertNotIn('operationGraph',bundle)
            canonical.append(without_provenance(bundle))
        self.assertEqual(canonical[0],canonical[1])


if __name__=='__main__':
    unittest.main()
