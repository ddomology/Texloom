"""Executed TeX decoration capture, independent geometry and native PGF frames."""
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from compile import compile_scene,CompileDiagnostic,PT_TO_BP
from decoration_capture import lower_decorations,DecorationCaptureDiagnostic
from tests.intersection_compiler_test import samples,without_provenance


def document(body='',package=True):
    preamble=r'''\documentclass{article}
\usepackage{tikz}
\usetikzlibrary{decorations.markings}
\newwrite\ReferenceFile
\newdimen\ReferenceX
\newdimen\ReferenceY
'''+('\\usepackage{texloom-decorations}\n' if package else '\\usepackage{texloom-expressions}\n')
    nodes=r'''
\begin{document}
\TLScene{Decoration fixtures}{400}{250}{2}
\TLNode{P}{point}{"x":10,"y":20,"r":6}
\TLNode{source}{path}{"d":"M0 0L100 0","geometry":{"contours":[{"id":"line","start":[0,0],"segments":[{"id":"line","kind":"line","to":[100,0]}]}]}}
\TLNode{diagonal}{path}{"d":"M0 0L60 80","geometry":{"contours":[{"id":"line","start":[0,0],"segments":[{"id":"line","kind":"line","to":[60,80]}]}]}}
\TLNode{symbol}{path}{"d":"M0 0L2 0L0 1","transform":{"translate":[200,100],"rotate":0.8,"scale":[3,2]},"geometry":{"contours":[{"id":"symbol","start":[0,0],"segments":[{"id":"a","kind":"line","to":[2,0]},{"id":"b","kind":"line","to":[0,1]}]}]}}
'''
    for name in ('ticks','marks','snake','symbols','brace'):
        nodes+='\\TLNode{'+name+'}{path}{"d":"M0 0L1 0","geometry":{"contours":[{"id":"initial","start":[0,0],"segments":[{"id":"initial","kind":"line","to":[1,0]}]}]}}\n'
    return preamble+nodes+body+'\n\\end{document}\n'


def vertices(contour):
    return [contour['start']]+[segment['to'] for segment in contour['segments']]


class DecorationCompilerTests(unittest.TestCase):
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

    def test_literal_archives_typed_inputs_and_explicit_spaces(self):
        expression='\n 10bp + \\macro + "quote" % # ## ^^M ^^J &&\n'
        point='vec2(1bp,2bp) + \\macro % ^^M'
        payload=json.dumps({'path':{'operation':'upstream','socket':'path','space':'plot:chart'},'spacing':expression,'size':{'node':'P','property':'r'}},indent=2)
        body='\\loomdecorate[orientation=reverse,corners=skip]{ticks}{'+payload+'}\n'
        body+='\\loombrace{brace}{'+json.dumps({'from':{'anchor':{'source':'node:P','query':{'towards':{'expression':point}}}},'to':[90,20]})+'}\n'
        body+=r'\loomdecorate[mode=symbols]{symbols}{{"path":"source","symbol":"symbol"}}'
        folder,records,bundle=self.capture('literal',body);lower_decorations(records,bundle,folder,folder)
        ops={op['id']:op for op in bundle['operationGraph']['operations']}
        op=ops['decoration:ticks'];self.assertEqual(op['operator'],'decoratePath')
        self.assertEqual(op['inputs']['path']['ref']['operation'],'decoration:ticks:path')
        self.assertEqual(op['inputs']['orientation']['value']['value'],2)
        self.assertEqual(op['inputs']['size']['kind'],'property')
        self.assertEqual((folder/op['sourceSpan']['file']).read_text(encoding='utf8'),payload+'\n')
        archived=op['inputs']['spacing'];self.assertEqual((folder/archived['sourceSpan']['file']).read_text(encoding='utf8'),expression+'\n')
        nested=ops['brace:brace']['inputs']['from']['query']['towards']
        self.assertTrue(nested['sourceSpan']['file'].startswith('decoration-sources/'))
        self.assertEqual((folder/nested['sourceSpan']['file']).read_text(encoding='utf8'),point+'\n')
        self.assertFalse((folder/'connector-sources').exists())
        self.assertEqual(ops['decoration:symbols']['spaces']['symbol'],{'kind':'local','node':'symbol'})
        self.assertEqual(ops['decoration:ticks:local']['spaces']['to'],{'kind':'local','node':'ticks'})

    def test_invalid_authoring_units_and_cycles_are_explicit(self):
        cases=[('mode',r'\loomdecorate[mode=random]{ticks}{{"path":"source"}}','ticks, marks'),
            ('duplicate',r'\loomdecorate[spacing=20]{ticks}{{"path":"source","spacing":30}}','both options'),
            ('wrong-profile',r'\loomdecorate[amplitude=3]{ticks}{{"path":"source"}}','not supported'),
            ('symbol-space',r'\loomdecorate[mode=symbols]{symbols}{{"path":"source","symbol":{"operation":"shape","socket":"path"}}}','explicit space'),
            ('json',r'\loomdecorate{ticks}{{"path":"source","spacing":20,"spacing":30}}','Duplicate JSON key'),
            ('target',r'\loombrace{P}{{"from":[0,0],"to":[100,0]}}','editable path')]
        for name,body,message in cases:
            with self.subTest(name=name):
                folder,records,bundle=self.capture(name,body)
                with self.assertRaisesRegex(DecorationCaptureDiagnostic,message):lower_decorations(records,bundle,folder,folder)
        with self.assertRaisesRegex(CompileDiagnostic,'unit|UNIT'):
            self.compile('unit',r'\loomdecorate{ticks}{{"path":"source","spacing":"2s"}}')
        with self.assertRaisesRegex(CompileDiagnostic,'cycle|CYCLE'):
            self.compile('cycle',r'\loomdecorate{ticks}{{"path":"ticks"}}')

    def test_regular_ticks_match_actual_pgf_marking_frames(self):
        body=r'''
\loomdecorate[spacing=20,phase=10,size=6]{ticks}{{"path":"diagonal"}}
\immediate\openout\ReferenceFile=pgf-reference.txt
\begin{tikzpicture}[x=1bp,y=1bp]
\path[postaction={decorate},decoration={markings,
 mark=between positions 10bp and 90bp step 20bp with {
  \pgfgettransformentries{\RA}{\RB}{\RC}{\RD}{\RE}{\RF}
  \immediate\write\ReferenceFile{\RA,\RB,\RC,\RD,\RE,\RF}
 }}] (0,0)--(60,80);
\end{tikzpicture}
\immediate\closeout\ReferenceFile
'''
        output,_=self.compile('pgf',body);result=samples(output/'bundle.json')[0]
        self.assertIn('frame',result,result)
        geometry=next(n for n in result['frame']['nodes'] if n['id']=='ticks')['geometry']
        reference=next(output.glob('runs/compile-*/source/pgf-reference.txt')).read_text().splitlines()
        self.assertEqual(len(reference),5);self.assertEqual(len(geometry['contours']),5)
        for contour,line,distance in zip(geometry['contours'],reference,(10,30,50,70,90)):
            numbers=[float(re.sub(r'pt$','',value)) for value in line.split(',')]
            a,b,c,d,x,y=numbers;x*=PT_TO_BP;y*=PT_TO_BP
            endpoints=vertices(contour);self.assertEqual(len(endpoints),2)
            center=[sum(p[axis] for p in endpoints)/2 for axis in range(2)]
            self.assertAlmostEqual(center[0],.6*distance,delta=1e-8)
            self.assertAlmostEqual(center[1],.8*distance,delta=1e-8)
            self.assertLess(math.dist(center,[x,y]),.004)
            expected=[[x+sign*3*c,y+sign*3*d] for sign in (-1,1)]
            for point in endpoints:self.assertLess(min(math.dist(point,p) for p in expected),.004)
            self.assertAlmostEqual(a,.6,delta=.0001);self.assertAlmostEqual(b,.8,delta=.0001)

    def test_snake_sine_and_brace_endpoint_geometry(self):
        body=r'''
\loomdecorate[mode=snake,spacing=20,amplitude=5,resolution=16]{snake}{{"path":"source"}}
\loombrace[amplitude=12,aspect=.3,offset=4]{brace}{{"from":[10,20],"to":[110,20]}}
'''
        output,_=self.compile('sine-brace',body);result=samples(output/'bundle.json')[0]
        self.assertIn('frame',result,result);nodes={node['id']:node for node in result['frame']['nodes']}
        snake=nodes['snake']['geometry']['contours'];self.assertEqual(len(snake),1)
        points=vertices(snake[0]);self.assertGreater(len(points),60)
        for x,y in points:self.assertAlmostEqual(y,5*math.sin(2*math.pi*x/20),delta=1e-7)
        self.assertAlmostEqual(points[0][0],0,delta=1e-8);self.assertAlmostEqual(points[-1][0],100,delta=1e-8)
        brace=nodes['brace']['geometry']['contours'][0]
        self.assertEqual(brace['start'],[10,24]);self.assertEqual(brace['segments'][-1]['to'],[110,24])
        self.assertEqual(sum(segment['kind']=='cubic' for segment in brace['segments']),4)
        self.assertEqual(sum(segment['kind']=='line' for segment in brace['segments']),2)
        self.assertTrue(any(math.dist(segment['to'],[40,36])<1e-8 for segment in brace['segments']))

    def test_symbol_local_geometry_phase_origin_and_reverse_sampling(self):
        body=r'''
\loomdecorate[mode=symbols,spacing=20,phase=10,origin=5,symbol-scale=2]{symbols}{{"path":"source","symbol":"symbol","offset":"time/1s*2bp"}}
\loomdecorate[mode=marks,spacing=20,phase=10,origin=5]{marks}{{"path":"source"}}
'''
        output,bundle=self.compile('symbols',body);results=samples(output/'bundle.json',(0,1,2,0))
        self.assertTrue(all('frame' in result for result in results),results)
        self.assertEqual(results[0]['frame'],results[-1]['frame'])
        source=next(node for node in bundle['nodes'] if node['id']=='source')['geometry']
        for time,result in zip((0,1,2,0),results):
            nodes={node['id']:node for node in result['frame']['nodes']}
            self.assertEqual(nodes['source']['geometry'],source)
            contours=nodes['symbols']['geometry']['contours'];self.assertEqual(len(contours),5)
            for contour,x in zip(contours,(5,25,45,65,85)):
                for actual,expected in zip(vertices(contour),[[x,2*time],[x+4,2*time],[x,2*time+2]]):
                    self.assertLess(math.dist(actual,expected),1e-10)
            self.assertGreater(len(nodes['marks']['geometry']['contours']),0)

    def test_repeat_archives_and_loading_package_are_deterministic(self):
        source=self.folder/'repeat.tex';source.write_text(document(r'\loomdecorate{ticks}{{"path":"source","phase":"time/1s*1bp"}}'),encoding='utf8')
        outputs=[self.folder/'repeat-one',self.folder/'repeat-two'];bundles=[compile_scene(source,out) for out in outputs]
        self.assertEqual(without_provenance(bundles[0]),without_provenance(bundles[1]))
        for output,bundle in zip(outputs,bundles):
            operation=bundle['operationGraph']['operations'][0];archived=output/operation['sourceSpan']['file']
            self.assertEqual(archived.read_bytes(),next(output.glob('runs/compile-*/source/'+archived.name)).read_bytes())
            value=operation['inputs']['phase'];self.assertEqual((output/value['sourceSpan']['file']).read_text(),value['expression']+'\n')
        canonical=[];source=self.folder/'empty.tex'
        for package in (False,True):
            source.write_text('\n'.join(line for line in document('',package).splitlines() if '}{path}' not in line),encoding='utf8')
            bundle=compile_scene(source,self.folder/('empty-'+str(package)))
            self.assertEqual(bundle['version'],'0.1');self.assertNotIn('operationGraph',bundle)
            canonical.append(without_provenance(bundle))
        self.assertEqual(canonical[0],canonical[1])


if __name__=='__main__':
    unittest.main()
