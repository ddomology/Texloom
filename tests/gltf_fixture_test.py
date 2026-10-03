"""Independent, self-authored glTF fixture and shared-runtime acceptance."""
import base64
import copy
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1];DATA=ROOT/'examples/data/gltf-profile'
sys.path.insert(0,str(ROOT/'tools'))
from port_baseline import validate_spec
from tests.gltf_oracle import (C,CI,GltfOracle,GltfReference,KNOTS,TIMES,accessor,columns,determinant,
    identity,load_asset,multiply,normal,normalized,point,rows,slerp,trs,write_reference)


def generator():
    spec=importlib.util.spec_from_file_location('gltf_fixture_generator',ROOT/'tools/gltf/create_fixture.py')
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


class GltfFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.document,cls.buffers=load_asset(DATA/'scene.gltf')

    def test_independent_port_spec_and_registered_sources(self):
        spec=json.loads((ROOT/'docs/ports/features/pr39-gltf-profile.json').read_text())
        suite=json.loads((DATA/'suite.json').read_text())
        self.assertEqual(validate_spec(spec,{row['id'] for row in suite['fixtures']}),[])
        self.assertEqual(spec['upstream'][0]['revision'],'8e691206fa2e981fc3b8c8bc57e671595576c971')
        for fixture in suite['fixtures']:
            for path in fixture['inputs']+fixture['tests']:
                self.assertTrue((ROOT/path).is_file(),path)

    def test_original_gltf_and_glb_are_semantically_identical_and_repeatable(self):
        embedded,buffers=load_asset(DATA/'scene.glb');external=copy.deepcopy(self.document);external['buffers'][0].pop('uri')
        self.assertEqual(embedded,external);self.assertEqual(buffers,self.buffers)
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);generator().write_fixture(folder)
            for name in ['scene.gltf','scene.glb','scene.bin']:self.assertEqual((folder/name).read_bytes(),(DATA/name).read_bytes())

    def test_declared_float32_bounds_alignment_and_outward_faces_are_real(self):
        doc=self.document;mesh=doc['meshes'][0];seen=[]
        for primitive in mesh['primitives']:
            points=accessor(doc,self.buffers,primitive['attributes']['POSITION']);normals=accessor(doc,self.buffers,primitive['attributes']['NORMAL'])
            index=accessor(doc,self.buffers,primitive['indices']);seen.extend(index)
            item=doc['accessors'][primitive['attributes']['POSITION']]
            self.assertEqual(item['min'],[min(p[i] for p in points) for i in range(3)])
            self.assertEqual(item['max'],[max(p[i] for p in points) for i in range(3)])
            for i in range(0,len(index),3):
                a,b,c=[points[j] for j in index[i:i+3]];u=[b[j]-a[j] for j in range(3)];v=[c[j]-a[j] for j in range(3)]
                cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
                center=[(a[j]+b[j]+c[j])/3 for j in range(3)]
                self.assertGreater(sum(cross[j]*center[j] for j in range(3)),0)
                for vertex in index[i:i+3]:
                    for n,expected in zip(normals[vertex],normalized(cross)):self.assertAlmostEqual(n,expected,delta=3e-8)
        self.assertEqual(sorted(seen),list(range(36)))
        for view in doc['bufferViews']:self.assertEqual(view['byteOffset']%4,0)

    def test_shared_mesh_hierarchy_reflection_and_normal_inverse_transpose(self):
        self.assertEqual([self.document['nodes'][i]['mesh'] for i in [1,2,3]],[0,0,0])
        reference=GltfReference(self.document,self.buffers).sample(3.5)
        self.assertEqual(len(reference['instances']),9);self.assertEqual(sum(x['determinant']<0 for x in reference['instances']),3)
        # A known reflected nonuniform transform distinguishes inverse transpose
        # from both a direct direction transform and a winding-sign normal flip.
        matrix=trs({'scale':[-2,3,.5]});expected=normalized([-.5,1/3,2])
        for x,y in zip(normal(matrix,normalized([1,1,1])),expected):self.assertAlmostEqual(x,y,delta=1e-15)
        self.assertNotEqual(normal(matrix,[1,0,0]),[1,0,0])

    def test_slerp_short_path_sign_equivalence_and_known_midpoint(self):
        a=[0,0,0,1];b=[0,1,0,0];q=slerp(a,b,.5)
        for x,y in zip(q,[0,math.sqrt(.5),0,math.sqrt(.5)]):self.assertAlmostEqual(x,y,delta=2e-15)
        for x,y in zip(point(trs({'rotation':q}),[1,0,0]),[0,0,-1]):self.assertAlmostEqual(x,y,delta=1e-15)
        self.assertEqual(slerp(a,[0,0,0,-1],.7),a)

    def test_step_is_right_continuous_and_linear_translation_is_not_step(self):
        reference=GltfReference(self.document,self.buffers)
        def mat(t,node):return next(i['worldMatrix'] for i in reference.sample(t)['instances'] if i['nodeIndex']==node)
        self.assertEqual(mat(2-1e-6,3),mat(1,3));self.assertEqual(mat(2,3),mat(2+1e-6,3))
        self.assertNotEqual(mat(2-1e-6,3),mat(2,3));self.assertNotEqual(mat(.5,1),mat(0,1))
        for x,y,z in zip(mat(.5,1),mat(0,1),mat(1,1)):self.assertAlmostEqual(x,(y+z)/2,delta=2e-15)

    def test_archive_reference_is_current_deterministic_and_container_independent(self):
        original=(DATA/'reference.json').read_bytes();report=json.loads(original)
        self.assertEqual(report['sampleTimes'],TIMES);self.assertEqual(report['knots'],KNOTS)
        self.assertEqual(report['sourceSha256'],hashlib.sha256((DATA/'scene.gltf').read_bytes()).hexdigest())
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'reference.json';write_reference(DATA/'scene.gltf',path);self.assertEqual(path.read_bytes(),original)
        doc,buffers=load_asset(DATA/'scene.glb')
        for t in TIMES:self.assertEqual(GltfReference(doc,buffers).sample(t),GltfReference(self.document,self.buffers).sample(t))


class GltfRuntimeOracleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.addClassCleanup(cls.temp.cleanup);folder=Path(cls.temp.name)
        entry=folder/'entry.mjs';compiled=folder/'compiled.mjs';result=folder/'frames.json'
        cls.document,cls.buffers=load_asset(DATA/'scene.gltf');embedded,binary=load_asset(DATA/'scene.glb')
        assets=[{'document':d,'buffers':[base64.b64encode(b).decode() for b in bs]} for d,bs in [(cls.document,cls.buffers),(embedded,binary)]]
        request=folder/'request.json';request.write_text(json.dumps(assets),encoding='utf8')
        entry.write_text('import {readFileSync,writeFileSync} from "node:fs";\n'
            'import {mergeGltfAssets} from '+json.dumps((ROOT/'src/resources/gltf-profile.ts').as_posix())+';\n'
            'import {exportGltfAsset} from '+json.dumps((ROOT/'src/resources/gltf-export.ts').as_posix())+';\n'
            'import {createEvaluator} from '+json.dumps((ROOT/'src/evaluate.ts').as_posix())+';\n'
            'const assets=JSON.parse(readFileSync(process.argv[2],"utf8"));const times='+json.dumps(TIMES)+';\n'
            'const base={version:"0.3",title:"Independent glTF",duration:8,units:"bp",viewport:{width:640,height:360},camera:{x:0,y:0,zoom:1},nodes:[],tracks:[],relations:[],resources:{}};\n'
            'const results=assets.map(asset=>{const before=JSON.stringify(asset),{bundle,reports}=mergeGltfAssets(base,[{id:"model",asset,options:{camera:0}}]);'
            'const evaluate=createEvaluator(bundle);const capture=f=>({time:f.time,resources:f.resources,instances:f.space3d.instances,groups:f.space3d.groups,camera:f.space3d.camera});const snapshot=t=>capture(evaluate(t));'
            'const frames=times.map(snapshot),reverse=[...times].reverse().map(snapshot).reverse();'
            'const bundleBefore=JSON.stringify(bundle),exported=exportGltfAsset(bundle);'
            'const roundtrip=mergeGltfAssets(base,[{id:"roundtrip",asset:exported.asset,options:{camera:0}}]);const again=createEvaluator(roundtrip.bundle);'
            'const warned=mergeGltfAssets({...base,diagnostics:[{severity:"warning",code:"NOTE",message:"Non-fatal author note"}]},[{id:"model",asset}]);'
            'return {reports,frames,reverse,exported,roundtrip:times.map(t=>capture(again(t))),warningDiagnostics:warned.bundle.diagnostics,bundleUnchanged:JSON.stringify(bundle)===bundleBefore,unchanged:JSON.stringify(asset)===before}});'
            'writeFileSync(process.argv[3],JSON.stringify(results));',encoding='utf8')
        commands=[['node','-e','require("esbuild").buildSync({entryPoints:[process.argv[1]],outfile:process.argv[2],bundle:true,platform:"node",format:"esm",logLevel:"silent"})',str(entry),str(compiled)],
            ['node',str(compiled),str(request),str(result)]]
        for command in commands:
            completed=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,timeout=60)
            if completed.returncode:raise RuntimeError((completed.stdout+'\n'+completed.stderr)[-12000:])
        cls.results=json.loads(result.read_text());cls.oracle=GltfOracle(cls.document,cls.buffers)

    def test_every_knot_and_intermediate_world_point_normal_matches_independent_oracle(self):
        for result in self.results:
            for time,frame in zip(TIMES,result['frames']):self.oracle.assert_frame(self,frame,time)

    def test_containers_share_resources_and_reverse_samples_without_mutation(self):
        first,second=self.results
        self.assertEqual(first['frames'],second['frames'])
        for result in self.results:
            self.assertTrue(result['unchanged']);self.assertEqual(result['frames'],result['reverse'])
            for frame in result['frames']:
                ids=[item['resourceId'] for item in frame['instances']]
                self.assertEqual(len(ids),9);self.assertEqual(len(set(ids)),3)

    def test_warning_only_native_diagnostics_are_preserved(self):
        for result in self.results:
            self.assertEqual(result['warningDiagnostics'],[{'severity':'warning','code':'NOTE','message':'Non-fatal author note'}])

    def test_selected_static_camera_preserves_optical_axis_after_coordinate_conversion(self):
        expected=GltfReference(self.document,self.buffers).sample(0)['cameras'][0]['convertedOpticalWorldMatrix']
        optical=rows(expected);near=.1;far=30;f=1/math.tan(.8/2);aspect=16/9
        for result in self.results:
            for frame in result['frames']:
                for actual,wanted in zip(frame['camera']['worldMatrix'],expected):self.assertAlmostEqual(actual,wanted,delta=2e-12)
                self.assertAlmostEqual(frame['camera']['projection']['fovY'],.8)
                # Independent pinhole projection of known world landmarks;
                # do not obtain the reference view matrix from runtime helpers.
                for landmark in [[0,0,0],[1,0,.5],[-1,.25,-.3]]:
                    delta=[landmark[i]-optical[i][3] for i in range(3)]
                    view=[sum(optical[j][i]*delta[j] for j in range(3)) for i in range(3)]
                    wanted=[f/aspect*view[0]/-view[2],f*view[1]/-view[2],((far+near)/(near-far)*view[2]+2*far*near/(near-far))/-view[2]]
                    vp=rows(frame['camera']['viewProjectionMatrix']);clip=[sum(vp[i][j]*landmark[j] for j in range(3))+vp[i][3] for i in range(4)]
                    for actual,target in zip([v/clip[3] for v in clip[:3]],wanted):self.assertAlmostEqual(actual,target,delta=2e-12)

    def test_delivery_roundtrip_preserves_fixture_spatial_meaning_with_reported_float32_rounding(self):
        original=GltfReference(self.document,self.buffers)
        for result in self.results:
            exported=result['exported'];asset=exported['asset'];report=exported['report']
            binary=[base64.b64decode(b) for b in asset['buffers']]
            self.assertEqual(report['output']['bufferSha256'],[hashlib.sha256(b).hexdigest() for b in binary])
            self.assertFalse(exported['sidecar']['roundTrip']);self.assertEqual(exported['sidecar']['native']['title'],'Independent glTF')
            self.assertEqual(report['direction'],'export');self.assertEqual(report['unsupported'],[])
            self.assertLessEqual(report['precision']['maxAbsoluteError'],1e-7)
            self.assertTrue(result['bundleUnchanged'])
            delivered=GltfReference(asset['document'],binary);oracle=GltfOracle(asset['document'],binary,'roundtrip')
            for t,frame,before in zip(TIMES,result['roundtrip'],result['frames']):
                oracle.assert_frame(self,frame,t)
                new={item['nodeIndex']:item for item in delivered.sample(t)['instances']}
                for item in original.sample(t)['instances']:
                    node_id=f"model:primitive:{item['nodeIndex']}:{item['primitiveIndex']}"
                    actual=new[report['mappings']['nodes'][node_id]]
                    self.assertEqual(actual['indices'],item['indices'])
                    for field in ['convertedWorldPositions','convertedWorldNormals']:
                        for a,b in zip(actual[field],item[field]):
                            for value,wanted in zip(a,b):self.assertAlmostEqual(value,wanted,delta=2e-6)
                for value,wanted in zip(frame['camera']['worldMatrix'],before['camera']['worldMatrix']):self.assertAlmostEqual(value,wanted,delta=2e-12)


if __name__=='__main__':unittest.main()
