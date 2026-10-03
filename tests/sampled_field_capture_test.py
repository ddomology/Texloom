"""Actual TeX capture, portable local payloads, source archives and failed publication."""
import base64
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
from compile import compile_scene
from import_samples import encode_samples, canonical_json, sha256
from sampled_field_capture import lower_sampled_fields, SampledFieldCaptureDiagnostic
from tests.import_samples_test import sample_input


class SampledFieldCaptureTests(unittest.TestCase):
    def setUp(self):self.temp=tempfile.TemporaryDirectory();self.folder=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def prepare(self,name,mode='external'):
        root=self.folder/name;root.mkdir();execution=root/'execution';execution.mkdir();data=root/'data';data.mkdir()
        manifest,payloads=encode_samples(sample_input(),1)
        packed=b'header'
        for c in manifest['chunks']:
            raw=payloads[c['source']['uri']]
            if mode=='inline':c['source']={'kind':'inline','data':base64.b64encode(raw).decode()}
            elif mode=='packed':c['source']={'kind':'external','uri':'all.bin','byteRange':{'offset':len(packed),'length':len(raw)}};packed+=raw
            else:(data/c['source']['uri']).write_bytes(raw)
        if mode=='packed':(data/'all.bin').write_bytes(packed+b'footer')
        (data/'manifest.json').write_bytes(canonical_json(manifest));source=root/'scene.tex';source.write_text('')
        records=[]
        for i,(kind,identifier,body) in enumerate([('bake','samples','data/manifest.json'),('field','sample','{"source":"mesh","resourceId":"output","bake":"samples","units":"m","attributes":[{"channel":"s","name":"scalar"}]}')],1):
            base=f'scene.tl-samples-{i}';(execution/f'{base}.body.txt').write_text(body+'\n');(execution/f'{base}.id.txt').write_text(identifier+'\n');records.append({'type':'samples-file','kind':kind,'file':base})
        return root,execution,source,records,manifest,payloads

    def test_external_inline_packed_keep_exact_bytes_and_archived_manifest(self):
        snapshots=[]
        for mode in ['external','inline','packed']:
            root,execution,source,records,manifest,payloads=self.prepare(mode,mode);bundle={'version':'0.1'};output=root/'output'
            report=lower_sampled_fields(records,bundle,execution,output,source);snapshots.append(bundle['bakes'])
            entry=report['declarations'][0]
            self.assertEqual((output/entry['manifest']).read_bytes(),canonical_json(manifest));self.assertEqual(entry['manifestSha256'],sha256(canonical_json(manifest)))
            self.assertEqual((output/entry['sourceSpan']['file']).read_bytes(),(execution/'scene.tl-samples-1.body.txt').read_bytes())
            self.assertEqual(entry['manifestSourceSpan']['file'],entry['manifest'])
            self.assertEqual((output/entry['manifestSourceSpan']['file']).read_bytes(),canonical_json(manifest))
            self.assertNotEqual(entry['sourceSpan']['file'],entry['manifestSourceSpan']['file'])
            for original,chunk,archive in zip(manifest['chunks'],bundle['bakes']['samples']['chunks'],entry['chunks']):
                raw=base64.b64decode(chunk['source']['data']);self.assertEqual(sha256(raw),original['sha256']);self.assertEqual((output/archive['file']).read_bytes(),raw)
            op=bundle['sampledFields']['operations'][0];self.assertEqual(json.loads((output/op['sourceSpan']['file']).read_text())['bake'],'samples')
        self.assertEqual(snapshots[0],snapshots[1]);self.assertEqual(snapshots[0],snapshots[2])

    def test_integrity_unsafe_paths_malformed_json_and_reserved_fields_are_atomic(self):
        for case in ['hash','missing','traversal','absolute','duplicate','reserved','range','base64']:
            root,execution,source,records,manifest,payloads=self.prepare(case)
            if case=='hash':manifest['chunks'][0]['sha256']='0'*64
            elif case=='missing':manifest['chunks'][0]['source']['uri']='missing.bin'
            elif case=='traversal':manifest['chunks'][0]['source']['uri']='../outside.bin'
            elif case=='absolute':manifest['chunks'][0]['source']['uri']='https://example.com/a.bin'
            elif case=='range':manifest['chunks'][0]['source']['byteRange']={'offset':1,'length':manifest['chunks'][0]['byteLength']}
            elif case=='base64':manifest['chunks'][0]['source']={'kind':'inline','data':'!'}
            (root/'data/manifest.json').write_bytes(canonical_json(manifest))
            if case=='duplicate':(root/'data/manifest.json').write_text('{"chunks":[],"chunks":[]}')
            if case=='reserved':(execution/'scene.tl-samples-2.body.txt').write_text('{"sourceSpan":{}}')
            bundle={'version':'0.1'}
            with self.subTest(case=case),self.assertRaises(SampledFieldCaptureDiagnostic) as caught:lower_sampled_fields(records,bundle,execution,root/'output',source)
            self.assertEqual(bundle,{'version':'0.1'});self.assertIsNotNone(caught.exception.sourceSpan)

    def test_native_example_hydrates_all_chunks_and_retains_sample_channels(self):
        output=self.folder/'native';bundle=compile_scene(ROOT/'examples/temporal-samples.tex',output)
        self.assertEqual(bundle['duration'],8);self.assertEqual(bundle['bakes']['external-wave']['sampleTimes'],[0,.5,1.75,3,4.5,6.25,8])
        self.assertEqual([c['sampleCount'] for c in bundle['bakes']['external-wave']['chunks']],[2,2,2,1])
        self.assertTrue(all(c['source']['kind']=='inline' for c in bundle['bakes']['external-wave']['chunks']))
        self.assertEqual(len(bundle['sampledFields']['operations']),2);self.assertEqual(len(bundle['fieldVisualization']['operations']),2)
        self.assertEqual(bundle['fieldVisualization']['operations'][0]['scalar'],{'attribute':'raw-scalar'})
        self.assertEqual(bundle['resources']['sample-domain'],json.loads((ROOT/'examples/data/temporal-samples/mesh.json').read_text()))
        self.assertEqual(json.loads((output/'bake-sources/declarations.json').read_text()),bundle['provenance']['sampledFieldCapture'])

    def test_native_topology_or_channel_error_prevents_stale_publication(self):
        root,execution,source,records,manifest,payloads=self.prepare('invalid-native')
        mesh={'kind':'mesh','version':1,'primitive':'triangles','units':'m','coordinateSpace':'object','winding':'ccw','topologyRevision':'triangle-1',
              'positions':{'version':1,'componentType':'float64','components':3,'count':3,'byteOffset':0,'byteStride':24,'data':[0,0,0,1,0,0,0,1,0]},
              'indices':{'version':1,'componentType':'uint16','components':1,'count':3,'byteOffset':0,'byteStride':2,'data':[0,1,2]},'bounds':{'min':[0,0,0],'max':[1,1,0]}}
        for case in ['topology','channel']:
            bad=copy.deepcopy(manifest)
            if case=='topology':bad['topology']['indices']=[0,2,1]
            (root/'data/manifest.json').write_bytes(canonical_json(bad))
            op={'source':'mesh','resourceId':'output','bake':'samples','units':'m','attributes':[{'channel':'missing' if case=='channel' else 's','name':'scalar'}]}
            source.write_text('\\documentclass{article}\n\\usepackage{texloom-samples}\n\\begin{document}\n\\TLScene{Bad}{320}{180}{2}\n\\loommesh{mesh}|'+json.dumps(mesh)+'|\n\\loombake{samples}{data/manifest.json}\n\\loomsampledfield{sample}|'+json.dumps(op)+'|\n\\end{document}\n')
            output=root/case;output.mkdir();(output/'bundle.json').write_text('stale')
            with self.assertRaises(Exception):compile_scene(source,output)
            self.assertFalse((output/'bundle.json').exists());self.assertFalse(json.loads((output/'compile-report.json').read_text())['success'])


if __name__=='__main__':unittest.main()
