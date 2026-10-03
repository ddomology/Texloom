"""Actual pinned Blender producer tests; no mock replaces evaluated geometry.

Set BLENDER_EXE to Blender 4.5.9. TEXLOOM_REQUIRE_BLENDER=1 makes missing Blender
a failure, as used by both full acceptance gates. Normal developer runs can skip
this optional external-tool suite explicitly when the executable is absent.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import sys

ROOT=Path(__file__).resolve().parents[1]
TOOLS=ROOT/'tools/blender'
TIMES=[0,.25,1,2,4,6,8]
sys.path.insert(0,str(ROOT/'tools'))
from port_baseline import validate_spec


def load(path):return json.loads(path.read_text(encoding='utf8'))
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def tree(folder):return {p.relative_to(folder).as_posix():sha(p) for p in sorted(folder.rglob('*')) if p.is_file()}
def triples(values):return [values[i:i+3] for i in range(0,len(values),3)]
def point(matrix,p):return [sum(matrix[c*4+r]*p[c] for c in range(3))+matrix[12+r] for r in range(3)]
def normal(matrix,n):
    v=[sum(matrix[c*3+r]*n[c] for c in range(3)) for r in range(3)];length=math.hypot(*v)
    return [x/length for x in v]
def triangle_normal(points):
    a,b,c=points;u=[b[i]-a[i] for i in range(3)];v=[c[i]-a[i] for i in range(3)]
    n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];length=math.hypot(*n)
    return [x/length for x in n]


class BlenderPortSpecTests(unittest.TestCase):
    def test_pinned_upstream_contract_and_fixture_registry(self):
        spec=load(ROOT/'docs/ports/features/pr38-blender-producer.json')
        suite=load(ROOT/'tests/fixtures/blender-producer/suite.json')
        self.assertEqual(validate_spec(spec,{f['id'] for f in suite['fixtures']}),[])
        self.assertEqual(spec['implementation']['mode'],'upstream-execution')
        self.assertEqual(spec['upstream'][0]['revision'],'8bf95cbd38d1456c94e9d751f3804eea4d5b137b')
        for fixture in suite['fixtures']:
            self.assertIn(fixture['source'],fixture['inputs'])
            for relative in fixture['inputs']+fixture['tests']:
                file=(ROOT/relative).resolve();self.assertTrue(file.is_relative_to(ROOT));self.assertTrue(file.is_file(),relative)


class BlenderProducerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        configured=os.environ.get('BLENDER_EXE')
        required=os.environ.get('TEXLOOM_REQUIRE_BLENDER')=='1'
        if not configured:
            if required:raise RuntimeError('BLENDER_EXE is required for this acceptance gate.')
            raise unittest.SkipTest('Set BLENDER_EXE to pinned Blender 4.5.9 for actual producer tests.')
        cls.blender=Path(configured).resolve()
        if not cls.blender.is_file():raise RuntimeError(f'BLENDER_EXE does not exist: {cls.blender}')
        version=subprocess.run([str(cls.blender),'--version'],capture_output=True,text=True,timeout=30,check=True).stdout
        if not version.startswith('Blender 4.5.9'):raise RuntimeError(f'Expected Blender 4.5.9, got {version.splitlines()[0]}')
        pinned=load(TOOLS/'toolchain.json')
        if 'build hash: '+pinned['buildHash'] not in version:raise RuntimeError('Blender build hash does not match the pinned toolchain.')
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        cls.addClassCleanup(cls.temp.cleanup)
        cls.source=cls.folder/'fixture.blend'
        cls.run_blender(TOOLS/'create_fixture.py',['--out',str(cls.source)])
        cls.source_hash=sha(cls.source)
        cls.reference_file=cls.folder/'reference.json'
        cls.run_blender(TOOLS/'reference_scene.py',['--out',str(cls.reference_file),'--times',','.join(map(str,TIMES))],cls.source)
        cls.reference=load(cls.reference_file)
        cls.export=cls.folder/'export'
        cls.run_blender(TOOLS/'export_scene.py',['--out',str(cls.export),'--times',','.join(map(str,TIMES))],cls.source)
        cls.manifest=load(cls.export/'manifest.json')
        base={'version':'0.3','title':'Independent Blender acceptance','duration':8,'units':'bp',
              'viewport':{'width':640,'height':400},'camera':{'x':0,'y':0,'zoom':1},'nodes':[],'tracks':[],'relations':[],'resources':{}}
        request=cls.folder/'request.json';request.write_text(json.dumps({'bundle':base,'imports':[{'id':'fixture','manifest':cls.manifest}]}),encoding='utf8')
        lowered=cls.folder/'lowered.json'
        subprocess.run(['node','tools/lower-blender.mjs',str(request),str(lowered)],cwd=ROOT,capture_output=True,text=True,check=True,timeout=60)
        cls.lowered=load(lowered);entry=cls.folder/'evaluate.mjs';compiled=cls.folder/'evaluate-bundle.mjs';evaluations=cls.folder/'frames.json'
        entry.write_text('import {readFileSync,writeFileSync} from "node:fs";\n'
            'import {createEvaluator} from '+json.dumps((ROOT/'src/evaluate.ts').as_posix())+';\n'
            'const input=JSON.parse(readFileSync(process.argv[2],"utf8")),before=JSON.stringify(input.bundle),evaluate=createEvaluator(input.bundle);\n'
            'const times='+json.dumps(TIMES)+';const sample=t=>{const f=evaluate(t);return {time:f.time,instances:f.space3d.instances.map(i=>({...i,mesh:f.resources[i.resourceId]}))};};\n'
            'writeFileSync(process.argv[3],JSON.stringify({frames:times.map(sample),reverse:[...times].reverse().map(sample),sourceUnchanged:JSON.stringify(input.bundle)===before}));\n',encoding='utf8')
        subprocess.run(['node','-e','require("esbuild").buildSync({entryPoints:[process.argv[1]],outfile:process.argv[2],bundle:true,platform:"node",format:"esm",target:"es2022"})',str(entry),str(compiled)],cwd=ROOT,capture_output=True,text=True,check=True,timeout=60)
        subprocess.run(['node',str(compiled),str(lowered),str(evaluations)],cwd=ROOT,capture_output=True,text=True,check=True,timeout=60)
        cls.evaluations=load(evaluations)

    @classmethod
    def run_blender(cls,script,args,source=None,success=True):
        command=[str(cls.blender),'--background','--factory-startup']
        if source:command.append(str(source))
        command.extend(['--python-exit-code','1','--python',str(script),'--',*args])
        result=subprocess.run(command,cwd=ROOT,text=True,capture_output=True,timeout=180)
        if success and result.returncode:raise AssertionError(result.stdout+'\n'+result.stderr)
        if not success and not result.returncode:raise AssertionError('Expected failure: '+result.stdout)
        return result

    def fixture_variant(self,variant):
        source=self.folder/(variant+'.blend')
        if not source.exists():self.run_blender(TOOLS/'create_fixture.py',['--out',str(source),'--variant',variant])
        return source

    def test_reference_really_contains_modifier_instances_reflection_and_units(self):
        reference=self.reference
        self.assertEqual(reference['sourceBlendSha256'],self.source_hash)
        self.assertEqual(reference['referenceScriptSha256'],sha(TOOLS/'reference_scene.py'))
        self.assertEqual(reference['metersPerBlenderUnit'],.009999999776482582)
        self.assertEqual(reference['sampleTimes'],TIMES)
        first=reference['frames'][0]['instances'];self.assertEqual(len(first),4)
        column=next(p for p in first if p['sourceObject']=='TwistedColumn')
        self.assertGreater(column['evaluatedVertexCount'],column['authoredVertexCount'])
        orbs=[p for p in first if p['sourceObject']=='Orb'];self.assertEqual(len(orbs),3)
        self.assertTrue(all(p['isInstance'] for p in orbs));self.assertEqual(len({p['parent'] for p in orbs}),3)
        self.assertEqual(sum(p['determinant']<0 for p in first),1)
        middle=next(p for p in reference['frames'][4]['instances'] if p['sourceObject']=='TwistedColumn')
        self.assertNotEqual(column['localPositions'],middle['localPositions'])
        self.assertEqual(column['triangles'],middle['triangles'])

    def test_manifest_provenance_and_repeated_export_are_deterministic(self):
        manifest=self.manifest
        self.assertEqual(manifest['profile'],'blender-evaluated/1')
        self.assertEqual(manifest['producer']['version'],'4.5.9')
        self.assertEqual(manifest['producer']['script']['sha256'],sha(TOOLS/'export_scene.py'))
        self.assertEqual(manifest['source']['blend']['sha256'],self.source_hash)
        self.assertEqual(manifest['coordinates']['units'],'m')
        self.assertEqual(manifest['coordinates']['upAxis'],'z');self.assertEqual(manifest['coordinates']['handedness'],'right')
        self.assertEqual(manifest['time']['sampleTimes'],TIMES)
        repeated=self.folder/'repeated'
        self.run_blender(TOOLS/'export_scene.py',['--out',str(repeated),'--times',','.join(map(str,TIMES))],self.source)
        self.assertEqual(tree(self.export),tree(repeated));self.assertEqual(sha(self.source),self.source_hash)

    def test_every_exported_knot_matches_independent_blender_world_geometry_and_normals(self):
        mapping=self.lowered['reports'][0]['mappings'];reports=self.manifest['report']['objects'];maximum_position=0;maximum_normal=0
        for reference,actual in zip(self.reference['frames'],self.evaluations['frames']):
            self.assertEqual(reference['time'],actual['time']);self.assertEqual(len(actual['instances']),4)
            by_id={item['id']:item for item in actual['instances']}
            for source in reference['instances']:
                matches=[r for r in reports if r['sourceObject']==source['sourceObject'] and r['parent']==source['parent'] and r['persistentId']==source['persistentId']]
                self.assertEqual(len(matches),1);report=matches[0]
                if report['setId'] is not None:
                    instances=[i for i in mapping['instances'] if i['setId']==report['setId'] and i['elementId']==report['instanceId']]
                    self.assertEqual(len(instances),1);node_id=instances[0]['nodeId']
                else:node_id=mapping['nodes'][report['nodeId']]
                instance=by_id[node_id];mesh=instance['mesh'];positions=triples(mesh['positions']['data']);normals=triples(mesh['normals']['data'])
                self.assertEqual(len(positions),len(source['cornerWorldPositionsMeters']))
                self.assertEqual(instance['orientation'],-1 if source['determinant']<0 else 1)
                self.assertEqual(instance['worldWinding'],'cw' if source['determinant']<0 else 'ccw')
                for index,(position,expected) in enumerate(zip(positions,source['cornerWorldPositionsMeters'])):
                    world=point(instance['worldMatrix'],position);error=max(abs(a-b) for a,b in zip(world,expected));maximum_position=max(maximum_position,error)
                    self.assertLessEqual(error,3e-7,(reference['time'],source['sourceObject'],source['parent'],index))
                    actual_normal=normal(instance['normalMatrix'],normals[index])
                    if report['normalPolicy']=='preserved-corner':expected_normal=source['cornerWorldNormals'][index]
                    else:
                        triangle=index//3;expected_normal=triangle_normal(source['cornerWorldPositionsMeters'][3*triangle:3*triangle+3])
                        if source['determinant']<0:expected_normal=[-x for x in expected_normal]
                    error=max(abs(a-b) for a,b in zip(actual_normal,expected_normal));maximum_normal=max(maximum_normal,error)
                    self.assertLessEqual(error,3e-5,(reference['time'],source['sourceObject'],source['parent'],index,'normal'))
        self.assertTrue(self.evaluations['sourceUnchanged'])
        self.assertEqual(self.evaluations['frames'],list(reversed(self.evaluations['reverse'])))
        self.assertLessEqual(maximum_position,3e-7);self.assertLessEqual(maximum_normal,3e-5)

    def test_shared_prototype_and_animated_bake_contract_remain_explicit(self):
        reports=self.manifest['report']['objects'];orbs=[r for r in reports if r['sourceObject']=='Orb']
        self.assertEqual(len(orbs),3);self.assertEqual(len({r['resourceId'] for r in orbs}),1)
        self.assertTrue(any(r['setId'] is not None for r in orbs))
        column=next(r for r in reports if r['sourceObject']=='TwistedColumn')
        self.assertEqual(column['geometry'],'baked');self.assertEqual(column['normalPolicy'],'recomputed-triangle')
        self.assertGreater(column['evaluatedVertices'],column['originalVertices'])
        self.assertTrue(self.manifest['bakes']);self.assertTrue(self.manifest['sampledFields']['operations'])
        self.assertTrue(any(r['transform']=='baked-trs' for r in orbs))
        self.assertEqual(len(self.manifest['resources']),2)
        for bake in self.manifest['bakes'].values():
            self.assertEqual(bake['sampleTimes'],TIMES);self.assertEqual(bake['interpolation'],'linear')
            self.assertEqual(bake['channels'][0]['kind'],'position');self.assertEqual(bake['channels'][0]['unit'],'m')

    def test_unsupported_material_rejection_preserves_existing_output(self):
        source=self.fixture_variant('unsupported-material');before=tree(self.export)
        result=self.run_blender(TOOLS/'export_scene.py',['--out',str(self.export),'--times','0,4,8'],source,success=False)
        self.assertIn('BLENDER_OUTPUT',result.stdout+result.stderr)
        self.assertEqual(tree(self.export),before)
        new=self.folder/'unsupported-new'
        result=self.run_blender(TOOLS/'export_scene.py',['--out',str(new),'--times','0,4,8'],source,success=False)
        self.assertIn('BLENDER_UNSUPPORTED_MATERIAL',result.stdout+result.stderr)
        self.assertFalse(new.exists())

    def test_topology_change_is_rejected_without_partial_publication(self):
        source=self.fixture_variant('topology-change');out=self.folder/'topology-output'
        result=self.run_blender(TOOLS/'export_scene.py',['--out',str(out),'--times','0,4,8'],source,success=False)
        self.assertIn('TOPOLOGY',result.stdout+result.stderr);self.assertFalse(out.exists())

    def test_explicit_material_fallback_is_recorded_and_not_shader_execution(self):
        source=self.fixture_variant('unsupported-material');out=self.folder/'material-fallback'
        self.run_blender(TOOLS/'export_scene.py',['--out',str(out),'--times','0,4,8','--unsupported-material','fallback'],source)
        result=load(out/'manifest.json');self.assertEqual(result['report']['config']['materialPolicy'],'fallback')
        self.assertTrue(result['report']['unsupported'])
        self.assertTrue(any('MATERIAL' in item['code'] for item in result['report']['unsupported']))
        self.assertEqual(result['producer']['version'],'4.5.9')
        self.assertNotIn('node_tree',json.dumps(result))

    def test_bad_sample_times_fail_without_output(self):
        for index,times in enumerate(['0,0','1,0','0,nan','0,inf','-1,0']):
            target=self.folder/f'bad-times-{index}'
            self.run_blender(TOOLS/'export_scene.py',['--out',str(target),'--times',times],self.source,success=False)
            self.assertFalse(target.exists())

    def test_visible_unsupported_curve_is_not_silently_dropped(self):
        source=self.fixture_variant('unsupported-curve');out=self.folder/'curve-output'
        result=self.run_blender(TOOLS/'export_scene.py',['--out',str(out),'--times','0,4,8'],source,success=False)
        self.assertIn('BLENDER_UNSUPPORTED_GEOMETRY',result.stdout+result.stderr);self.assertFalse(out.exists())

    def test_connected_volume_requires_explicit_recorded_fallback(self):
        source=self.fixture_variant('unsupported-volume');out=self.folder/'volume-output'
        result=self.run_blender(TOOLS/'export_scene.py',['--out',str(out),'--times','0,4,8'],source,success=False)
        self.assertIn('BLENDER_UNSUPPORTED_MATERIAL',result.stdout+result.stderr);self.assertFalse(out.exists())
        fallback=self.folder/'volume-fallback'
        self.run_blender(TOOLS/'export_scene.py',['--out',str(fallback),'--times','0,4,8','--unsupported-material','fallback'],source)
        records=load(fallback/'manifest.json')['report']['unsupported']
        self.assertTrue(any('volume' in item['message'].lower() for item in records))

    def test_retained_sample_memory_budget_fails_before_publication(self):
        script=self.folder/'budget-check.py';destination=self.folder/'budget-output'
        script.write_text('import importlib.util\nimport bpy\n'
            'spec=importlib.util.spec_from_file_location("producer",'+repr(str(TOOLS/'export_scene.py'))+')\n'
            'module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\n'
            'module.MAX_BYTES=1024\n'
            'try:module.collect_frames(bpy,[0,0.25,1,2,4,6,8],"error",[])\n'
            'except Exception as error:\n'
            ' assert str(error).startswith("BLENDER_BUDGET:"),str(error)\n'
            ' print("RAW_SAMPLE_BUDGET_REJECTED")\n'
            'else:raise AssertionError("Expected raw sample budget rejection")\n',encoding='utf8')
        result=self.run_blender(script,[],self.source)
        self.assertIn('RAW_SAMPLE_BUDGET_REJECTED',result.stdout);self.assertFalse(destination.exists())

    def test_large_translation_does_not_hide_animated_shear(self):
        script=self.folder/'shear-check.py'
        script.write_text('import importlib.util\nfrom mathutils import Matrix\n'
            'spec=importlib.util.spec_from_file_location("producer",'+repr(str(TOOLS/'export_scene.py'))+')\n'
            'module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)\n'
            'matrix=Matrix.Identity(4);matrix[0][1]=.2;matrix[0][3]=1e8\n'
            'values=[float(matrix[r][c]) for c in range(4) for r in range(4)]\n'
            'try:module.trs_tracks([values,values],[0,1],"sheared")\n'
            'except Exception as error:\n'
            ' assert str(error).startswith("BLENDER_ANIMATED_SHEAR:"),str(error)\n'
            ' print("LARGE_TRANSLATION_SHEAR_REJECTED")\n'
            'else:raise AssertionError("Expected animated shear rejection")\n',encoding='utf8')
        result=self.run_blender(script,[],self.source)
        self.assertIn('LARGE_TRANSLATION_SHEAR_REJECTED',result.stdout)


if __name__=='__main__':unittest.main()
