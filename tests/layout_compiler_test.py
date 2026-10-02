"""Executed TeX layouts, native PGF baselines and independent content bounds."""
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
from layout_capture import lower_layouts,LayoutCaptureDiagnostic
from tests.intersection_compiler_test import samples,without_provenance


def document(body='',package=True,extra=''):
    preamble=r'''\documentclass[12pt]{article}
\usepackage{texloom-tikz}
\usetikzlibrary{matrix}
\newwrite\ReferenceFile
\newdimen\ReferenceX
\newdimen\ReferenceY
'''+('\\usepackage{texloom-layout}\n' if package else '\\usepackage{texloom-expressions}\n')
    nodes=r'''
\begin{document}
\begin{loomscene}[title={Layout fixtures},width=400,height=250,duration=2]
\TLText{a-art}{\rule[-4bp]{20bp}{14bp}}
\TLText{b-art}{\rule[-2bp]{30bp}{22bp}}
\TLText{c-art}{\rule[-6bp]{16bp}{14bp}}
\TLText{d-art}{\rule[-3bp]{24bp}{15bp}}
\TLNode{A}{tex}{"resourceId":"a-art","x":140,"y":80,"scale":1,"transform":{"translate":[30,20],"rotate":0.4,"scale":[2,2]}}
\TLNode{B}{tex}{"resourceId":"b-art","x":140,"y":80,"scale":1}
\TLNode{C}{tex}{"resourceId":"c-art","x":140,"y":80,"scale":1}
\TLNode{D}{tex}{"resourceId":"d-art","x":140,"y":80,"scale":1}
\TLNode{frame}{path}{"d":"M0 0L1 0","geometry":{"contours":[{"id":"initial","start":[0,0],"segments":[{"id":"initial","kind":"line","to":[1,0]}]}]}}
'''
    return preamble+nodes+extra+body+'\n\\end{loomscene}\n\\end{document}\n'


def position(node):
    return node['transform']['translate']


def bounds_at(node,bundle):
    x,y=position(node)
    if node['kind']=='tex':
        m=bundle['resources'][node['resourceId']]['metrics'];s=node.get('scale',1)
        return [x,y-m['height']*s,m['width']*s,(m['height']+m['depth'])*s]
    bx,by,w,h=node['anchorMetrics']['logicalTextBox']
    return [x+bx,y+by,w,h]


class LayoutCompilerTests(unittest.TestCase):
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
        resources={record['id']:{'metrics':{'width':20,'height':10,'depth':4}} for record in records if record['type']=='resource'}
        return folder,records,{'version':'0.1','nodes':[r['value'] for r in records if r['type']=='node'],'resources':resources}

    def compile(self,name,body='',text=None,extra=''):
        source=self.folder/(name+'.tex');source.write_text(text or document(body,extra=extra),encoding='utf8')
        output=self.folder/(name+'-out')
        return output,compile_scene(source,output)

    def frame(self,output,time=0):
        result=samples(output/'bundle.json',(time,))[0]
        self.assertIn('frame',result,result)
        return {node['id']:node for node in result['frame']['nodes']}

    def test_literal_archives_null_slots_and_explicit_parent_mappings(self):
        expression='\n 10bp + \\macro + "quote" % # ## ^^M ^^J &&\n'
        point='vec2(1bp,2bp) + \\macro % ^^M'
        payload=json.dumps({'nodes':['A',None,'B'],'gapX':expression,'origin':{'expression':point}},indent=2)
        folder,records,bundle=self.capture('literal','\\loomlayout[columns=2]{grid}{'+payload+'}\n'+r'\loomfit[padding-x=3]{frame}{{"layout":"grid"}}')
        lower_layouts(records,bundle,folder,folder);ops={op['id']:op for op in bundle['operationGraph']['operations']}
        op=ops['grid'];self.assertEqual(op['operator'],'matrixBoxLayout')
        self.assertEqual(op['inputs']['boxes'],{'kind':'boxes','nodes':['A',None,'B'],'space':{'kind':'parent','node':'A'}})
        self.assertEqual((folder/op['sourceSpan']['file']).read_text(encoding='utf8'),payload+'\n')
        for key,expected in [('gapX',expression),('origin',point)]:
            self.assertEqual((folder/op['inputs'][key]['sourceSpan']['file']).read_text(encoding='utf8'),expected+'\n')
        self.assertNotIn('grid:place:1',ops)
        placement=ops['grid:place:2'];self.assertEqual(placement['inputs']['index']['value']['value'],2)
        self.assertEqual(placement['spaces']['parent'],{'kind':'parent','node':'B'})
        self.assertEqual(placement['inputs']['mapping'],{'kind':'spaceTransform','from':{'kind':'parent','node':'A'},'to':{'kind':'parent','node':'B'}})
        self.assertEqual(ops['fit:frame']['inputs']['boxes'],op['inputs']['boxes'])
        self.assertEqual(ops['fit:frame']['inputs']['positions']['ref'],{'operation':'grid','socket':'positions'})
        self.assertEqual(ops['fit:frame:local']['spaces']['to'],{'kind':'local','node':'frame'})

    def test_matrix_matches_native_pgf_row_baselines_and_column_edges(self):
        body=r'''
\loomlayout[columns=2,gap-x=20,gap-y=9,align-x=start,align-y=baseline]{grid}{{"nodes":["A","B","C","D"],"origin":[10,30]}}
\immediate\openout\ReferenceFile=pgf-reference.txt
\begin{tikzpicture}
\matrix[matrix of nodes,nodes={anchor=base west,inner sep=0bp,outer sep=0bp},column sep=20bp,row sep=9bp] (m) {
\rule[-4bp]{20bp}{14bp} & \rule[-2bp]{30bp}{22bp} \\
\rule[-6bp]{16bp}{14bp} & \rule[-3bp]{24bp}{15bp} \\
};
\foreach \r/\c in {1/1,1/2,2/1,2/2}{
 \pgfextractx{\ReferenceX}{\pgfpointanchor{m-\r-\c}{base west}}
 \pgfextracty{\ReferenceY}{\pgfpointanchor{m-\r-\c}{base west}}
 \immediate\write\ReferenceFile{\the\ReferenceX,\the\ReferenceY}
}
\end{tikzpicture}
\immediate\closeout\ReferenceFile
'''
        output,bundle=self.compile('pgf',body);nodes=self.frame(output)
        reference=next(output.glob('runs/compile-*/source/pgf-reference.txt')).read_text().splitlines()
        pgf=[[float(re.sub(r'pt$','',v))*PT_TO_BP for v in line.split(',')] for line in reference]
        self.assertEqual(len(pgf),4)
        for index,key in enumerate(('A','B','C','D')):
            actual=position(nodes[key]);base=position(nodes['A'])
            self.assertAlmostEqual(actual[0]-base[0],pgf[index][0]-pgf[0][0],delta=.003)
            self.assertAlmostEqual(actual[1]-base[1],pgf[0][1]-pgf[index][1],delta=.003)
            self.assertEqual([nodes[key]['x'],nodes[key]['y']],[0,0])
            self.assertEqual(nodes[key]['transform']['rotate'],0)
            self.assertEqual(nodes[key]['transform']['scale'],[1,1])
        self.assertAlmostEqual(bounds_at(nodes['B'],bundle)[0]-sum(bounds_at(nodes['A'],bundle)[::2]),20,delta=.001)

    def test_unequal_depth_multiline_null_fit_and_dynamic_content_scale(self):
        extra=r'''
\loomnode[text width=50bp,align=left,inner sep=8bp,outer sep=7bp] (multiline) at (250,200) {First line\\Second line};
\TLTrack{A}{scale}{linear}{[[0,1],[2,2]]}
'''
        body=r'''
\loomlayout[columns=2,gap-y=9,align-y=baseline]{grid}{{"nodes":["A",null,"multiline","B"],"origin":[20,30],"gapX":"20bp+time/1s*5bp"}}
\loomfit[padding-x=7,padding-y=11]{frame}{{"layout":"grid"}}
'''
        output,bundle=self.compile('multiline',body,extra=extra);results=samples(output/'bundle.json',(0,2,1,0))
        self.assertTrue(all('frame' in result for result in results),results)
        self.assertEqual(results[0]['frame'],results[-1]['frame'])
        for result in results:
            nodes={node['id']:node for node in result['frame']['nodes']}
            boxes=[bounds_at(nodes[key],bundle) for key in ('A','multiline','B')]
            left=min(b[0] for b in boxes)-7;top=min(b[1] for b in boxes)-11
            right=max(b[0]+b[2] for b in boxes)+7;bottom=max(b[1]+b[3] for b in boxes)+11
            contour=nodes['frame']['geometry']['contours'][0]
            actual=[contour['start']]+[s['to'] for s in contour['segments']]
            for got,want in zip(actual,[[left,top],[right,top],[right,bottom],[left,bottom]]):
                self.assertLess(math.dist(got,want),1e-7)
            self.assertAlmostEqual(position(nodes['multiline'])[1]+nodes['multiline']['anchors']['base'][1],position(nodes['B'])[1],delta=1e-7)
        self.assertGreater(next(n for n in bundle['nodes'] if n['id']=='multiline')['anchorMetrics']['textMetrics']['height'],0)
        start={n['id']:n for n in results[0]['frame']['nodes']};end={n['id']:n for n in results[1]['frame']['nodes']}
        self.assertNotEqual(position(start['B']),position(end['B']))

    def test_row_wrap_column_and_alignment_preserve_logical_extents(self):
        output,bundle=self.compile('wrap',r'\loomlayout[mode=row,gap=10,cross-gap=7,align=baseline,max-width=65,overflow=wrap]{flow}{{"nodes":["A",null,"B","C","D"],"origin":[10,20]}}')
        nodes=self.frame(output);a,b,c,d=(bounds_at(nodes[key],bundle) for key in ('A','B','C','D'))
        self.assertAlmostEqual(b[0]-a[0]-a[2],10,delta=1e-7)
        self.assertAlmostEqual(min(c[1],d[1])-max(a[1]+a[3],b[1]+b[3]),7,delta=1e-7)
        self.assertAlmostEqual(d[0]-c[0]-c[2],10,delta=1e-7)
        self.assertEqual(position(nodes['A'])[1],position(nodes['B'])[1])
        output,bundle=self.compile('column',r'\loomlayout[mode=column,gap=13,align=end]{column}{{"nodes":["A","B"]}}')
        nodes=self.frame(output);a,b=(bounds_at(nodes[key],bundle) for key in ('A','B'))
        self.assertAlmostEqual(a[0]+a[2],b[0]+b[2],delta=1e-7)
        self.assertAlmostEqual(b[1]-a[1]-a[3],13,delta=1e-7)
        output,_=self.compile('align',r'\loomlayout[mode=align,axis=y,align=baseline,at=50]{aligned}{{"nodes":["A","B"],"positions":[[17,23],[31,42]]}}')
        nodes=self.frame(output);self.assertEqual(position(nodes['A']),[17,50]);self.assertEqual(position(nodes['B']),[31,50])

    def test_invalid_options_parent_cycles_units_and_competing_writers(self):
        cases=[('mode',r'\loomlayout[mode=random]{g}{{"nodes":["A"]}}','matrix, row'),
            ('duplicate',r'\loomlayout[gap-x=20]{g}{{"nodes":["A"],"gapX":30}}','both options'),
            ('nodes',r'\loomlayout{g}{{"nodes":["A","A"]}}','Duplicate layout target'),
            ('null',r'\loomlayout{g}{{"nodes":[null]}}','non-null'),
            ('profile',r'\loomlayout[gap=2]{g}{{"nodes":["A"]}}','not supported'),
            ('json',r'\loomlayout{g}{{"nodes":["A"],"nodes":["B"]}}','Duplicate JSON key'),
            ('fit',r'\loomfit{frame}{{"layout":"missing"}}','preceding'),
            ('policy',r'\loomlayout[overflow=wrap]{g}{{"nodes":["A"]}}','wrap requires row or column')]
        for name,body,message in cases:
            with self.subTest(name=name):
                folder,records,bundle=self.capture(name,body)
                with self.assertRaisesRegex(LayoutCaptureDiagnostic,message):lower_layouts(records,bundle,folder,folder)
        folder,records,bundle=self.capture('parent',r'\loomlayout{g}{{"nodes":["A","B"]}}')
        next(n for n in bundle['nodes'] if n['id']=='B')['parent']='parent'
        with self.assertRaisesRegex(LayoutCaptureDiagnostic,'same immediate parent'):lower_layouts(records,bundle,folder,folder)
        for name,body,message in [
            ('unit',r'\loomlayout{g}{{"nodes":["A"],"gapX":"2s"}}','unit|UNIT'),
            ('cycle',r'\loomlayout{g}{{"nodes":["A"],"gapX":{"node":"A","property":"x"}}}','cycle|CYCLE'),
            ('writer',r'\loomlayout{g}{{"nodes":["A"]}}\TLTrack{A}{x}{linear}{[[0,0],[2,10]]}','writer|WRITER|write'),
        ]:
            with self.subTest(name=name),self.assertRaisesRegex(CompileDiagnostic,message):self.compile(name,body)

    def test_repeat_archives_and_unused_package_are_deterministic(self):
        source=self.folder/'repeat.tex';source.write_text(document(r'\loomlayout[columns=2]{grid}{{"nodes":["A","B"],"gapX":"20bp+time/1s*1bp"}}'),encoding='utf8')
        outputs=[self.folder/'repeat-one',self.folder/'repeat-two'];bundles=[compile_scene(source,out) for out in outputs]
        self.assertEqual(without_provenance(bundles[0]),without_provenance(bundles[1]))
        for output,bundle in zip(outputs,bundles):
            operation=bundle['operationGraph']['operations'][0];archived=output/operation['sourceSpan']['file']
            self.assertEqual(archived.read_bytes(),next(output.glob('runs/compile-*/source/'+archived.name)).read_bytes())
            value=operation['inputs']['gapX'];self.assertEqual((output/value['sourceSpan']['file']).read_text(),value['expression']+'\n')
        canonical=[];source=self.folder/'empty.tex'
        for package in (False,True):
            source.write_text('\n'.join(line for line in document('',package,extra=r'\loomnode[inner sep=4bp] (unused) at (10,20) {$g_j$};').splitlines() if '}{path}' not in line),encoding='utf8')
            bundle=compile_scene(source,self.folder/('empty-'+str(package)))
            self.assertEqual(bundle['version'],'0.2');self.assertNotIn('operationGraph',bundle)
            canonical.append(without_provenance(bundle))
        self.assertEqual(canonical[0],canonical[1])


if __name__=='__main__':
    unittest.main()
