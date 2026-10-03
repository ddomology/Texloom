"""Independent byte-level checks for the external sample importer."""
import copy
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
from import_samples import encode_samples, import_samples, strict_json, canonical_json, SampleImportDiagnostic


def sample_input():
    return {'version':1,'units':'m','topology':{'revision':'triangle-1','vertexCount':3,'indices':[0,1,2]},
            'interpolation':'linear','outside':'clamp','seed':36,'solver':{'name':'test-producer','version':'1','parameters':{}},
            'channels':[{'id':'s','kind':'scalar','componentType':'float32','unit':'1'},
                        {'id':'v','kind':'vector','componentType':'float64','unit':'m/s'},
                        {'id':'p','kind':'position','componentType':'float64','unit':'m'}],
            'frames':[{'time':t,'values':{'s':[.1+t,2+t,3+t],'v':[t,1,2]*3,'p':[0,0,t,1,0,t,0,1,t]}} for t in [0,.25,2]]}


class ImportSamplesTests(unittest.TestCase):
    def test_mixed_precision_nonuniform_time_and_channel_order_exact_bytes(self):
        source=sample_input();before=copy.deepcopy(source);manifest,payloads=encode_samples(source,2)
        self.assertEqual(source,before);self.assertEqual(manifest['sampleTimes'],[0,.25,2]);self.assertEqual([c['sampleCount'] for c in manifest['chunks']],[2,1])
        frames=[]
        for frame in source['frames']:
            frames.append(struct.pack('<3f9d9d',*frame['values']['s'],*frame['values']['v'],*frame['values']['p']))
        self.assertEqual(list(payloads.values()),[frames[0]+frames[1],frames[2]])
        for c in manifest['chunks']:
            raw=payloads[c['source']['uri']];self.assertEqual(c['byteLength'],len(raw));self.assertEqual(c['sha256'],hashlib.sha256(raw).hexdigest())

    def test_deterministic_manifest_hash_and_atomic_new_directory_publication(self):
        with tempfile.TemporaryDirectory() as folder:
            folder=Path(folder);source=folder/'input.json';source.write_bytes(canonical_json(sample_input()))
            a,ar=import_samples(source,folder/'a',2);b,br=import_samples(source,folder/'b',2)
            self.assertEqual(ar,br);self.assertEqual(a,b)
            for item in (folder/'a').iterdir():self.assertEqual(item.read_bytes(),(folder/'b'/item.name).read_bytes())
            self.assertEqual(ar['manifestSha256'],hashlib.sha256((folder/'a/manifest.json').read_bytes()).hexdigest())
            with self.assertRaisesRegex(SampleImportDiagnostic,'SAMPLES_OUTPUT'):import_samples(source,folder/'a',2)
            source.write_text('{"bad":NaN}')
            with self.assertRaises(SampleImportDiagnostic):import_samples(source,folder/'failed')
            self.assertFalse((folder/'failed').exists());self.assertEqual(json.loads((folder/'a/manifest.json').read_text()),a)

    def test_strict_duplicate_nonfinite_and_shape_rejections(self):
        for text in ['{"x":1,"x":2}','{"x":NaN}','{"x":1e999}','{"x":'+('9'*400)+'}']:
            with self.assertRaises(SampleImportDiagnostic):strict_json(text)
        changes=[lambda x:x['frames'][1].update(time=0),lambda x:x['frames'][0]['values']['s'].pop(),
                 lambda x:x['frames'][0]['values'].update(extra=[]),lambda x:x['topology']['indices'].__setitem__(2,3),
                 lambda x:x.update(seed=True),lambda x:x['channels'][0].update(id='__proto__'),
                 lambda x:x['channels'][0].update(id='a'*257),lambda x:x['channels'][2].update(unit='cm'),
                 lambda x:x['solver'].update(name='bad\nname'),lambda x:x['frames'][0]['values']['s'].__setitem__(0,1e100),
                 lambda x:x['frames'][0].update(topology={'changed':True}),lambda x:x.update(callback='run()')]
        for change in changes:
            value=sample_input();change(value)
            with self.subTest(value=str(value)[:90]),self.assertRaises((SampleImportDiagnostic,ValueError)):encode_samples(value,2)
        for size in [0,True,4097]:
            with self.assertRaises(SampleImportDiagnostic):encode_samples(sample_input(),size)

    def test_one_sample_negative_origin_and_step_are_explicit(self):
        source=sample_input();source['frames']=source['frames'][:1];source['frames'][0]['time']=-2;source['interpolation']='step';source['outside']='error'
        manifest,payloads=encode_samples(source,1);self.assertEqual(manifest['sampleTimes'],[-2]);self.assertEqual(manifest['interpolation'],'step');self.assertEqual(len(payloads),1)

    def test_python_integer_times_cannot_collapse_in_float64_runtime(self):
        source=sample_input();source['frames']=source['frames'][:2]
        for left,right in [(2**53,2**53+1),(-2**53-1,-2**53)]:
            source['frames'][0]['time']=left;source['frames'][1]['time']=right
            with self.subTest(times=[left,right]),self.assertRaisesRegex(SampleImportDiagnostic,'SAMPLES_TIME_PRECISION'):
                encode_samples(source,1)
        source['frames'][1]['time']=10**400
        source['frames'][0]['time']=0
        with self.assertRaisesRegex(SampleImportDiagnostic,'SAMPLES_INPUT'):encode_samples(source,1)
        source=sample_input();source['frames']=source['frames'][:1];source['frames'][0]['time']=2**53+3
        with self.assertRaisesRegex(SampleImportDiagnostic,'SAMPLES_TIME_PRECISION'):encode_samples(source,1)
        source=sample_input();source['frames'][0]['values']['v'][0]=10**400
        with self.assertRaisesRegex(SampleImportDiagnostic,'SAMPLES_INPUT'):encode_samples(source,1)


if __name__=='__main__':unittest.main()
