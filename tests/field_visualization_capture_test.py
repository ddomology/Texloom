"""Real TeX field declarations, exact source archives and atomic validation."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from compile import compile_scene
from field_visualization_capture import lower_field_visualization, FieldVisualizationCaptureDiagnostic, MAX_CAPTURE_BYTES


def source_mesh():
    return {'kind':'mesh','version':1,'primitive':'triangles','units':'m','coordinateSpace':'object','winding':'ccw','topologyRevision':'field-sites-v1',
        'positions':{'version':1,'componentType':'float64','components':3,'count':4,'byteOffset':0,'byteStride':24,'data':[1,0,0,0,1,0,-1,0,0,0,0,0]},
        'indices':{'version':1,'componentType':'uint16','components':1,'count':3,'byteOffset':0,'byteStride':2,'data':[0,1,2]},
        'normals':{'version':1,'componentType':'float64','components':3,'count':4,'byteOffset':0,'byteStride':24,'data':[0,0,1]*4},
        'bounds':{'min':[-1,0,0],'max':[1,1,0]}}


def arrow_mesh():
    mesh=source_mesh();mesh['topologyRevision']='field-arrow-v1'
    mesh['positions']['count']=3;mesh['positions']['data']=[0,-.07,0,.5,0,0,0,.07,0]
    mesh['normals']['count']=3;mesh['normals']['data']=[0,0,1]*3
    mesh['bounds']={'min':[0,-.07,0],'max':[.5,.07,0]}
    return mesh


def color_policy(mode='fixed'):
    return {'attribute':'color','stops':[{'position':0,'color':[0,0,1]},{'position':.5,'color':[0,1,0]},{'position':1,'color':[1,0,0]}],
        'range':{'mode':'fixed','min':-1,'max':1} if mode=='fixed' else {'mode':'auto'},'outOfRange':'clamp','invalidColor':[.2,.2,.2]}


def operation():
    return {'source':'sites','resourceId':'painted','units':'m','scalar':'x','vector':['-y','x','0'],'mask':'index < 3','invalidPolicy':'mask',
        'color':color_policy(),'arrows':{'instanceSetId':'vectors','prototype':'arrow','up':[0,0,1],'lengthScale':'0.5','zeroPolicy':'hide','color':[1,.6,.1]}}


def document(body=''):
    return '\\documentclass{article}\n\\usepackage{texloom-fields}\n\\usepackage{texloom-field}\n\\begin{document}\n\\TLScene{Surface fields}{320}{180}{2}\n'+body+'\n\\end{document}\n'


def declaration(op=None):
    scene={'version':1,'units':'m','handedness':'right','upAxis':'z','nodes':[{'id':'painted','kind':'mesh','resourceId':'painted','material':{'kind':'unlit','color':'#ffffff','colorAttribute':'color'}},{'id':'vectors','kind':'instances','instanceSetId':'vectors','material':{'kind':'unlit','color':'#ffffff','side':'double'}}],
        'camera':{'id':'view','transform':{'translation':[0,0,5]},'projection':{'kind':'orthographic','height':3,'near':.1,'far':20}}}
    return ('\\loommesh{sites}|'+json.dumps(source_mesh())+'|\n\\loommesh{arrow}|'+json.dumps(arrow_mesh())+
            '|\n\\loomfieldvisualization{field}|'+json.dumps(operation() if op is None else op)+'|\n\\loomspace|'+json.dumps(scene)+'|')


class FieldVisualizationCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.folder=Path(self.temp.name)
    def tearDown(self):
        self.temp.cleanup()
    def records(self,name,items):
        execution=self.folder/name;execution.mkdir();records=[]
        for i,(identifier,body) in enumerate(items,1):
            base=f'scene.tl-field-visualization-{i}'
            (execution/f'{base}.body.txt').write_text(body+'\n',encoding='utf8')
            (execution/f'{base}.id.txt').write_text(identifier+'\n',encoding='utf8')
            records.append({'type':'field-visualization-file','file':base})
        return execution,records

    def test_native_comparison_retains_declarations_and_exact_decoded_expressions(self):
        output=self.folder/'demo';bundle=compile_scene(ROOT/'examples/surface-field.tex',output)
        self.assertEqual(bundle['version'],'0.3');self.assertEqual(bundle['duration'],8)
        self.assertFalse(any(r['kind']=='mesh' for r in bundle['resources'].values()))
        self.assertEqual(bundle['surfaces']['operations'][0]['segments'],{'u':16,'v':8})
        self.assertEqual([o['id'] for o in bundle['fieldVisualization']['operations']],['color-stage','displacement-stage'])
        for op in bundle['fieldVisualization']['operations']:
            authored=json.loads((output/op['sourceSpan']['file']).read_text(encoding='utf8'))
            self.assertEqual(authored['scalar'],op['scalar'])
            self.assertEqual((output/op['expressionSpans']['scalar']['file']).read_text(),op['scalar']+'\n')
            if 'displacement' in op:
                self.assertEqual((output/op['expressionSpans']['amplitude']['file']).read_text(),'amplitude\n')
        self.assertEqual(json.loads((output/'field-visualization-sources/declarations.json').read_text()),bundle['provenance']['fieldVisualizationCapture'])

    def test_vector_mask_auto_range_repeat_and_legacy_macro_package_coexist(self):
        source=self.folder/'fixture.tex';op=operation();op['color']=color_policy('auto')
        source.write_text(document(declaration(op)),encoding='utf8')
        a=compile_scene(source,self.folder/'a');b=compile_scene(source,self.folder/'b')
        self.assertEqual(a['fieldVisualization'],b['fieldVisualization']);self.assertNotIn('painted',a['resources'])
        captured=a['fieldVisualization']['operations'][0]
        for expression,span in zip(op['vector'],captured['expressionSpans']['vector']):
            self.assertEqual((self.folder/'a'/span['file']).read_text(),expression+'\n')
        for key,text in [('mask','index < 3'),('lengthScale','0.5')]:
            self.assertEqual((self.folder/'a'/captured['expressionSpans'][key]['file']).read_text(),text+'\n')
        unused=self.folder/'unused.tex';unused.write_text(document(),encoding='utf8')
        plain=compile_scene(unused,self.folder/'unused');self.assertNotIn('fieldVisualization',plain)

    def test_authoritative_invalid_programs_remove_stale_publication(self):
        variants=[]
        for change in [{'units':'cm'},{'mask':'1'},{'scalar':'1bp'},{'callback':'() => 1'}]:
            variants.append({**operation(),**change})
        literal=operation();literal['scalar']='x+\\notexpanded # % λ';variants.append(literal)
        for i,op in enumerate(variants):
            with self.subTest(case=i):
                source=self.folder/f'bad-{i}.tex';output=self.folder/f'bad-{i}'
                source.write_text(document(declaration(op)),encoding='utf8');output.mkdir();(output/'bundle.json').write_text('stale')
                with self.assertRaises(Exception):compile_scene(source,output)
                self.assertFalse((output/'bundle.json').exists());self.assertFalse(json.loads((output/'compile-report.json').read_text())['success'])
                if i==len(variants)-1:
                    self.assertEqual((output/'field-visualization-sources/scene.tl-field-visualization-1.scalar.expression.txt').read_text(encoding='utf8'),literal['scalar']+'\n')

    def test_strict_json_and_reserved_metadata_fail_before_attaching_any_program(self):
        bad=[('{"scalar":"x","scalar":"y"}','FIELD_VISUALIZATION_CAPTURE_DUPLICATE'),('{"x":NaN}','FIELD_VISUALIZATION_CAPTURE_NONFINITE'),
             ('{"x":1e999}','FIELD_VISUALIZATION_CAPTURE_NONFINITE'),('[]','FIELD_VISUALIZATION_CAPTURE_JSON'),
             ('{"id":"override"}','FIELD_VISUALIZATION_CAPTURE_FIELD'),('{"sourceSpan":{}}','FIELD_VISUALIZATION_CAPTURE_FIELD'),
             ('{"expressionSpans":{}}','FIELD_VISUALIZATION_CAPTURE_FIELD')]
        for i,(body,code) in enumerate(bad):
            execution,records=self.records(f'bad-{i}',[('field',body)]);bundle={'version':'0.1','resources':{}}
            with self.assertRaises(FieldVisualizationCaptureDiagnostic) as caught:lower_field_visualization(records,bundle,execution,self.folder/f'out-{i}')
            self.assertEqual(caught.exception.code,code);self.assertIsNotNone(caught.exception.sourceSpan);self.assertEqual(bundle,{'version':'0.1','resources':{}})

    def test_bounded_sidecars_identifiers_and_duplicate_declarations_remain_atomic(self):
        execution,records=self.records('oversize',[('field',' '*(MAX_CAPTURE_BYTES+1))])
        with self.assertRaisesRegex(FieldVisualizationCaptureDiagnostic,'CAPTURE_BUDGET'):lower_field_visualization(records,{},execution,self.folder/'size')
        execution,records=self.records('duplicate',[('field','{}'),('field','{}')]);bundle={'version':'0.1'}
        with self.assertRaisesRegex(FieldVisualizationCaptureDiagnostic,'CAPTURE_DUPLICATE'):lower_field_visualization(records,bundle,execution,self.folder/'dupe')
        self.assertEqual(bundle,{'version':'0.1'})
        for base in ['../scene.tl-field-visualization-1','scene.tl-field-visualization-0','scene.tl-field-visualization-01']:
            with self.assertRaisesRegex(FieldVisualizationCaptureDiagnostic,'CAPTURE_PATH'):lower_field_visualization([{'type':'field-visualization-file','file':base}],{},self.folder,self.folder/'path')
        with self.assertRaisesRegex(FieldVisualizationCaptureDiagnostic,'CAPTURE_BUDGET'):lower_field_visualization([{'type':'field-visualization-file'}]*17,{},self.folder,self.folder/'count')
        execution,records=self.records('bad-id',[('../bad','{}')])
        with self.assertRaisesRegex(FieldVisualizationCaptureDiagnostic,'CAPTURE_ID'):lower_field_visualization(records,{},execution,self.folder/'id')


if __name__=='__main__':unittest.main()
