"""Actual TeX shared instances, literal provenance and atomic publication."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from compile import compile_scene
from instance_capture import lower_instances,InstanceCaptureDiagnostic,MAX_CAPTURE_BYTES


def prototype():
    return {'kind':'mesh','version':1,'primitive':'triangles','units':'m','coordinateSpace':'object','winding':'ccw','topologyRevision':'triangle-v1',
        'positions':{'version':1,'componentType':'float64','components':3,'count':3,'byteOffset':0,'byteStride':24,'data':[0,0,0,1,0,0,0,1,0]},
        'indices':{'version':1,'componentType':'uint16','components':1,'count':3,'byteOffset':0,'byteStride':2,'data':[0,1,2]},'bounds':{'min':[0,0,0],'max':[1,1,0]}}


def operation():
    return {'prototype':'triangle','units':'m','seed':34,'source':{'kind':'points','points':[{'id':'left','position':[0,0,0]},{'id':'right','position':[2,0,0]}]},
        'position':['x','y','z'],'rotation':['0','0','0','1'],'scale':['1','1','1'],'color':['rand','rand1','rand2'],'selection':'rand3 < 1'}


def document(body=''):
    return '\\documentclass{article}\n\\usepackage{texloom-instances}\n\\begin{document}\n\\TLScene{Instances}{320}{180}{2}\n'+body+'\n\\end{document}\n'


def declaration(op=None):
    scene={'version':1,'units':'m','handedness':'right','upAxis':'z','nodes':[{'id':'points','kind':'instances','instanceSetId':'copies'}]}
    return ('\\loommesh{triangle}|'+json.dumps(prototype())+'|\n\\loominstances{copies}|'+json.dumps(operation() if op is None else op)+'|\n\\loomspace|'+json.dumps(scene)+'|')


class InstanceCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.folder=Path(self.temp.name)
    def tearDown(self):
        self.temp.cleanup()
    def records(self,name,items):
        execution=self.folder/name;execution.mkdir();records=[]
        for i,(identifier,body) in enumerate(items,1):
            base=f'scene.tl-instances-{i}'
            (execution/f'{base}.body.txt').write_text(body+'\n',encoding='utf8')
            (execution/f'{base}.id.txt').write_text(identifier+'\n',encoding='utf8')
            records.append({'type':'instances-file','file':base})
        return execution,records

    def test_native_demo_keeps_one_prototype_and_literal_expression_spans(self):
        output=self.folder/'demo'
        bundle=compile_scene(ROOT/'examples/sampled-instances.tex',output)
        self.assertEqual(bundle['version'],'0.3')
        self.assertEqual([key for key,value in bundle['resources'].items() if value['kind']=='mesh'],['arrow'])
        self.assertNotIn('sample-surface',bundle['resources'])
        op=bundle['instances']['operations'][0]
        self.assertEqual(op['id'],'directions');self.assertEqual(op['prototype'],'arrow')
        self.assertEqual(bundle['surfaces']['operations'][0]['segments'],{'u':15,'v':15})
        self.assertEqual(bundle['space3d']['nodes'][1]['instanceSetId'],'directions')
        body=(output/op['sourceSpan']['file']).read_text(encoding='utf8')
        authored=json.loads(body)
        for name in ['position','rotation','scale','color']:
            for expression,span in zip(authored[name],op['expressionSpans'][name]):
                self.assertEqual((output/span['file']).read_text(encoding='utf8'),expression+'\n')
        self.assertEqual((output/op['expressionSpans']['selection']['file']).read_text(),authored['selection']+'\n')
        self.assertEqual(json.loads((output/'instance-sources/declarations.json').read_text()),bundle['provenance']['instanceCapture'])

    def test_repeat_unused_package_and_explicit_realize(self):
        source=self.folder/'repeat.tex';op=operation()
        op['realize']={'resourceId':'realized','normalPolicy':'drop','selection':'all','instanceColorAttribute':'tint','instanceSelectionAttribute':'selected'}
        source.write_text(document(declaration(op)),encoding='utf8')
        a=compile_scene(source,self.folder/'a');b=compile_scene(source,self.folder/'b')
        self.assertEqual(a['instances'],b['instances'])
        self.assertNotIn('realized',a['resources'])
        self.assertEqual(a['instances']['operations'][0]['realize'],op['realize'])
        unused=self.folder/'unused.tex';unused.write_text(document(),encoding='utf8')
        plain=compile_scene(unused,self.folder/'unused')
        self.assertNotIn('instances',plain);self.assertEqual(plain['version'],'0.1')

    def test_authoritative_invalid_programs_remove_old_publication(self):
        variants=[]
        for change in [{'units':'cm'},{'seed':-1},{'selection':'1'},{'rotation':['0','0','0','0']},{'scale':['1bp','1','1']},{'callback':'() => 1'}]:
            variants.append({**operation(),**change})
        duplicate=operation();duplicate['source']['points'][1]['id']='left';variants.append(duplicate)
        literal=operation();literal['position'][0]='x+\\notexpanded # % λ';variants.append(literal)
        for i,op in enumerate(variants):
            with self.subTest(case=i):
                source=self.folder/f'bad-{i}.tex';output=self.folder/f'bad-{i}'
                source.write_text(document(declaration(op)),encoding='utf8');output.mkdir()
                (output/'bundle.json').write_text('stale')
                with self.assertRaises(Exception):compile_scene(source,output)
                self.assertFalse((output/'bundle.json').exists())
                self.assertFalse(json.loads((output/'compile-report.json').read_text())['success'])
                if i==len(variants)-1:
                    captured=(output/'instance-sources/scene.tl-instances-1.position-0.expression.txt').read_text(encoding='utf8')
                    self.assertEqual(captured,literal['position'][0]+'\n')

    def test_strict_json_reserved_metadata_and_budgets_are_atomic(self):
        bad=[('{"seed":1,"seed":2}','INSTANCE_CAPTURE_DUPLICATE'),('{"seed":NaN}','INSTANCE_CAPTURE_NONFINITE'),('{"seed":1e999}','INSTANCE_CAPTURE_NONFINITE'),
             ('[]','INSTANCE_CAPTURE_JSON'),('{"id":"override"}','INSTANCE_CAPTURE_FIELD'),('{"expressionSpans":{}}','INSTANCE_CAPTURE_FIELD')]
        for i,(body,code) in enumerate(bad):
            execution,records=self.records(f'bad-{i}',[('copies',body)])
            bundle={'version':'0.1','resources':{}}
            with self.assertRaises(InstanceCaptureDiagnostic) as raised:lower_instances(records,bundle,execution,self.folder/f'out-{i}')
            self.assertEqual(raised.exception.code,code);self.assertIsNotNone(raised.exception.sourceSpan)
            self.assertEqual(bundle,{'version':'0.1','resources':{}})
        execution,records=self.records('oversize',[('copies',' '*(MAX_CAPTURE_BYTES+1))])
        with self.assertRaisesRegex(InstanceCaptureDiagnostic,'INSTANCE_CAPTURE_BUDGET'):lower_instances(records,{},execution,self.folder/'oversize-out')
        execution,records=self.records('ids',[('copies','{}'),('copies','{}')])
        untouched={'version':'0.1'}
        with self.assertRaisesRegex(InstanceCaptureDiagnostic,'INSTANCE_CAPTURE_DUPLICATE'):lower_instances(records,untouched,execution,self.folder/'duplicate')
        self.assertEqual(untouched,{'version':'0.1'})
        for i,base in enumerate(['../scene.tl-instances-1','scene.tl-instances-0','scene.tl-instances-01','C:/scene.tl-instances-1']):
            with self.assertRaisesRegex(InstanceCaptureDiagnostic,'INSTANCE_CAPTURE_PATH'):lower_instances([{'type':'instances-file','file':base}],{},self.folder,self.folder/f'path-{i}')
        with self.assertRaisesRegex(InstanceCaptureDiagnostic,'INSTANCE_CAPTURE_BUDGET'):lower_instances([{'type':'instances-file'}]*17,{},self.folder,self.folder/'count')


if __name__=='__main__':unittest.main()
