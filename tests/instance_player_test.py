"""Independent sampled placement/seed oracles and GPU realization equivalence."""
import base64
import copy
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from compile import compile_scene
from tests.instance_capture_test import prototype,document


def hash32(text):
    # Public seed policy: UTF-16 FNV-1a followed by two fixed avalanche products.
    raw=text.encode('utf-16-le');value=2166136261
    for offset in range(0,len(raw),2):
        value=((value ^ int.from_bytes(raw[offset:offset+2],'little'))*16777619)&0xffffffff
    value^=value>>16;value=(value*0x7feb352d)&0xffffffff
    value^=value>>15;value=(value*0x846ca68b)&0xffffffff
    return (value^(value>>16))&0xffffffff


def random_lane(seed,operation,identifier,lane):
    return hash32(json.dumps([seed,operation,identifier,lane],ensure_ascii=False,separators=(',',':')))/2**32


def build_player(bundle,output):
    result=subprocess.run(['node',str(ROOT/'tools/build-gpu-player.mjs'),str(bundle),str(output)],cwd=ROOT,capture_output=True,text=True,encoding='utf8')
    if result.returncode:raise AssertionError(result.stdout+result.stderr)


def realization_document():
    op={'prototype':'triangle','units':'m','seed':3401,'source':{'kind':'points','points':[{'id':'left','position':[-1.5,-.5,0]},{'id':'reflected','position':[1.5,-.5,0]},{'id':'hidden','position':[0,1,0]}]},
        'scale':['1-2*index','1','1'],'color':['0.2+0.25*index','0.7-0.2*index','0.4'],'selection':'index < 2',
        'realize':{'resourceId':'baked','normalPolicy':'drop','instanceColorAttribute':'tint','instanceSelectionAttribute':'kept'}}
    scene={'version':1,'units':'m','handedness':'right','upAxis':'z','nodes':[{'id':'batch','kind':'instances','instanceSetId':'copies','material':{'kind':'unlit','color':'#ffffff','side':'front'}}],
        'camera':{'id':'view','transform':{'translation':[0,0,6]},'projection':{'kind':'orthographic','height':4,'near':.1,'far':100}}}
    return document('\\loommesh{triangle}|'+json.dumps(prototype())+'|\n\\loominstances{copies}|'+json.dumps(op)+'|\n\\loomspace|'+json.dumps(scene)+'|')


class InstancePlayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        cls.bundle=compile_scene(ROOT/'examples/sampled-instances.tex',cls.folder/'native')
        cls.player=cls.folder/'player.html';build_player(cls.folder/'native/bundle.json',cls.player)
        source=cls.folder/'realize.tex';source.write_text(realization_document(),encoding='utf8')
        fixture=compile_scene(source,cls.folder/'fixture')
        cls.instance_player=cls.folder/'instances.html';build_player(cls.folder/'fixture/bundle.json',cls.instance_player)
        realized=copy.deepcopy(fixture);realized['space3d']['nodes']=[{'id':'bake','kind':'mesh','resourceId':'baked','material':{'kind':'unlit','color':'#ffffff','side':'front','colorAttribute':'tint'}}]
        file=cls.folder/'realized.json';file.write_text(json.dumps(realized),encoding='utf8')
        cls.realized_player=cls.folder/'realized.html';build_player(file,cls.realized_player)
        cls.playwright=sync_playwright().start();cls.browser=cls.playwright.chromium.launch(headless=True,args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.playwright.stop();cls.temp.cleanup()
    def open(self,path=None,mobile=False,capture=True):
        page=self.browser.new_page(viewport={'width':390,'height':844} if mobile else {'width':960,'height':540},reduced_motion='reduce')
        errors=[];requests=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.on('console',lambda message:errors.append(message.text) if message.type=='error' else None)
        page.on('request',lambda request:requests.append(request.url) if request.url.startswith(('http:','https:')) else None)
        page.goto((path or self.player).as_uri()+('?capture=1' if capture else ''))
        page.evaluate('async()=>await window.TexloomGpuPlayer.ready')
        return page,errors,requests

    def assert_analytic(self,frame,time,density=1):
        mesh=frame['resources']['sample-surface'];records=frame['instanceSets']['directions']['instances']
        self.assertEqual(mesh['positions']['count'],256);self.assertEqual(len(records),256)
        self.assertEqual(frame['instanceSets']['directions']['prototypeResourceId'],'arrow')
        self.assertEqual([name for name,value in frame['resources'].items() if value['kind']=='mesh'],['arrow','sample-surface'])
        points=list(zip(*[iter(mesh['positions']['data'])]*3));batch=frame['space3d']['instanceBatches'][0]
        self.assertEqual(batch['prototypeResourceId'],'arrow');self.assertEqual(batch['setId'],'directions')
        identity=json.dumps(['sample-surface',mesh['topologyRevision'],'vertex'],separators=(',',':'))
        # Four independently salted lanes form the final 128-bit source identity.
        identity_hash=''.join(f'{hash32(json.dumps([identity,lane],separators=(",",":"))):08x}' for lane in range(4))
        selected=[];phase=math.pi*time/4
        for index,(point,record,evaluated) in enumerate(zip(points,records,batch['instances'])):
            x,y,z=point
            self.assertAlmostEqual(z,.2*math.cos(x)*math.sin(y),delta=2e-12)
            self.assertAlmostEqual((x+2.25)/.3,round((x+2.25)/.3),delta=2e-12)
            self.assertAlmostEqual((y+2.25)/.3,round((y+2.25)/.3),delta=2e-12)
            self.assertEqual(record['id'],f'mesh:{identity_hash}:vertex:{index}')
            randoms=[random_lane(3401,'directions',record['id'],channel) for channel in range(4)]
            yes=randoms[3]<density;self.assertEqual(record['selected'],yes);self.assertEqual(evaluated['selected'],yes)
            if yes:selected.append(record['id'])
            theta=.7*x+.4*y+phase;scale=[.34+.06*math.sin(x+y+phase),.32,.32]
            for actual,want in zip(record['transform']['translation'],[x,y,z+.12]):self.assertAlmostEqual(actual,want,delta=2e-12)
            for actual,want in zip(record['transform']['rotation'],[0,0,math.sin(theta/2),math.cos(theta/2)]):self.assertAlmostEqual(actual,want,delta=2e-12)
            self.assertEqual(record['transform']['scale'][1:],[.32,.32]);self.assertAlmostEqual(record['transform']['scale'][0],scale[0],delta=2e-12)
            expected_color=[.35+.3*randoms[0]+.2*math.cos(x+phase),.4+.3*randoms[1]+.2*math.sin(y-phase),.35+.3*randoms[2]+.2*math.sin(x+y+phase)]
            for actual,want in zip(record['color'],expected_color):self.assertAlmostEqual(actual,want,delta=2e-12)
            matrix=[math.cos(theta)*scale[0],math.sin(theta)*scale[0],0,0,-math.sin(theta)*.32,math.cos(theta)*.32,0,0,0,0,.32,0,x,y,z+.12,1]
            for actual,want in zip(evaluated['worldMatrix'],matrix):self.assertAlmostEqual(actual,want,delta=2e-12)
        return selected

    def test_256_shared_instances_follow_analytic_fields_and_seek_exactly(self):
        page,errors,requests=self.open()
        try:
            hashes={};source=self.bundle['resources']['arrow']
            for time in [0,1,2,4,6,8]:
                capture=page.evaluate('t=>window.TexloomGpuPlayer.capture(t)',time)
                frame=page.evaluate('window.TexloomGpuPlayer.getFrame()')
                self.assertEqual(len(self.assert_analytic(frame,time)),256)
                self.assertEqual(frame['resources']['arrow'],source)
                self.assertEqual(page.locator('#instance-count').inner_text(),'257')
                hashes[time]=hashlib.sha256(base64.b64decode(capture['data'])).hexdigest()
            self.assertGreater(len(set(hashes.values())),4)
            for time in reversed(list(hashes)):
                capture=page.evaluate('t=>window.TexloomGpuPlayer.capture(t)',time)
                self.assertEqual(hashlib.sha256(base64.b64decode(capture['data'])).hexdigest(),hashes[time])
            self.assertEqual(errors,[]);self.assertEqual(requests,[])
        finally:page.close()

    def test_seeded_selection_preserves_all_ids_and_parameters_on_mobile(self):
        page,errors,requests=self.open(mobile=True,capture=False)
        try:
            self.assertFalse(page.evaluate('document.documentElement.scrollWidth>innerWidth'))
            page.evaluate('window.TexloomGpuPlayer.seek(2)');full=page.evaluate('window.TexloomGpuPlayer.getFrame()')
            page.get_by_label('density',exact=True).evaluate("e=>{e.value='.5';e.dispatchEvent(new Event('input',{bubbles:true}));}")
            reduced=page.evaluate('window.TexloomGpuPlayer.getFrame()');chosen=self.assert_analytic(reduced,2,.5)
            self.assertGreater(len(chosen),80);self.assertLess(len(chosen),180)
            self.assertEqual([r['id'] for r in full['instanceSets']['directions']['instances']],[r['id'] for r in reduced['instanceSets']['directions']['instances']])
            self.assertEqual(page.locator('#instance-count').inner_text(),str(len(chosen)+1))
            page.evaluate('window.TexloomGpuPlayer.seek(6)');self.assertEqual(self.assert_analytic(page.evaluate('window.TexloomGpuPlayer.getFrame()'),6,.5),chosen)
            page.evaluate('window.TexloomGpuPlayer.setParameter("density",0)');self.assertEqual(self.assert_analytic(page.evaluate('window.TexloomGpuPlayer.getFrame()'),6,0),[])
            self.assertEqual(page.locator('#instance-count').inner_text(),'1')
            page.evaluate('window.TexloomGpuPlayer.setParameter("density",1)');page.evaluate('window.TexloomGpuPlayer.seek(2)')
            self.assertEqual(page.evaluate('window.TexloomGpuPlayer.getFrame().instanceSets'),full['instanceSets'])
            self.assertTrue(page.evaluate('window.TexloomGpuPlayer.getState().sourceUnchanged'))
            self.assertEqual(errors,[]);self.assertEqual(requests,[])
        finally:page.close()

    def test_realization_matches_native_instancing_with_reflection_and_selection(self):
        batch,errors_a,requests_a=self.open(self.instance_player)
        baked,errors_b,requests_b=self.open(self.realized_player)
        try:
            first=batch.evaluate('window.TexloomGpuPlayer.capture(0)');second=baked.evaluate('window.TexloomGpuPlayer.capture(0)')
            self.assertEqual(base64.b64decode(first['data']),base64.b64decode(second['data']))
            frame=batch.evaluate('window.TexloomGpuPlayer.getFrame()')
            records=frame['instanceSets']['copies']['instances'];self.assertEqual([r['id'] for r in records],['left','reflected','hidden'])
            self.assertEqual([r['selected'] for r in records],[True,True,False])
            resource=frame['resources']['baked'];self.assertEqual(resource['positions']['count'],6);self.assertEqual(resource['indices']['count'],6)
            self.assertEqual(resource['bounds'],{'min':[-1.5,-.5,0],'max':[1.5,.5,0]})
            self.assertEqual(frame['space3d']['instanceBatches'][0]['worldBounds'],resource['bounds'])
            self.assertEqual(resource['attributes']['values']['tint']['buffer']['data'],[.2,.7,.4]*3+[.45,.49999999999999994,.4]*3)
            self.assertEqual(frame['resources']['triangle'],prototype())
            self.assertEqual(errors_a+errors_b+requests_a+requests_b,[])
        finally:batch.close();baked.close()


if __name__=='__main__':unittest.main()
