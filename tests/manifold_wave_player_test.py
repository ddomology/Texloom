"""Independent live-mode and imported-data oracles in the actual offline player.

PDE residual, RK4 convergence and solver error bounds belong to the scientific
reference suite. These tests independently verify what each renderer consumes.
"""
import base64
import bisect
import hashlib
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
from compile import compile_scene
from tests.field_visualization_player_test import build_player,triples

ARROW_INDICES={1+(j-1)*32+i for j in [4,8,12] for i in range(2,32,4)}
STOPS=[[.025,.12,.52],[.065,.39,.28],[.98,.48,.04]]


def color(value):
    t=max(0,min(1,(value+1)/2));a,b,f=(STOPS[0],STOPS[1],2*t) if t<=.5 else (STOPS[1],STOPS[2],2*t-1)
    return [x+(y-x)*f for x,y in zip(a,b)]


class ManifoldWavePlayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        data=ROOT/'examples/data/manifold-wave'
        cls.original=json.loads((data/'samples.json').read_text(encoding='utf8'));cls.mesh=json.loads((data/'mesh.json').read_text(encoding='utf8'))
        cls.bundle=compile_scene(ROOT/'examples/manifold-wave.tex',cls.folder/'native')
        cls.player=cls.folder/'player.html';build_player(cls.folder/'native/bundle.json',cls.player)
        cls.playwright=sync_playwright().start();cls.browser=cls.playwright.chromium.launch(headless=True,args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.playwright.stop();cls.temp.cleanup()
    def open(self,mobile=False):
        page=self.browser.new_page(viewport={'width':390,'height':844} if mobile else {'width':1280,'height':720},reduced_motion='reduce')
        errors=[];requests=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('console',lambda m:errors.append(m.text) if m.type=='error' else None)
        page.on('request',lambda r:requests.append(r.url) if r.url.startswith(('http:','https:')) else None)
        page.goto(self.player.as_uri()+('' if mobile else '?capture=1'));page.evaluate('async()=>await TexloomGpuPlayer.ready');return page,errors,requests
    def compare(self,actual,expected,tolerance=4e-12):
        self.assertEqual(len(actual),len(expected))
        for a,b in zip(actual,expected):self.assertAlmostEqual(a,b,delta=tolerance)
    def sample_oracle(self,time):
        frames=self.original['frames'];times=[f['time'] for f in frames];right=bisect.bisect_left(times,time)
        if times[right]==time:left=right;alpha=0
        else:left=right-1;alpha=(time-times[left])/(times[right]-times[left])
        values={name:[a+(b-a)*alpha for a,b in zip(frames[left]['values'][name],frames[right]['values'][name])] for name in ['scalar','gradient','position']}
        return {'left':left,'right':right,'alpha':alpha,'sourceTime':time},values
    def assert_frame(self,frame,time):
        source=frame['resources']['wave-domain'];self.assertEqual(source,self.mesh)
        self.assertEqual(source['positions']['count'],482);self.assertEqual(source['indices']['count'],2880)
        points=triples(source['positions']['data']);cosine=math.cos(math.pi*time/4)
        exact=[2*x*y*cosine for x,y,z in points]
        report=frame['fieldVisualization']['exact-field'];self.compare(report['scalar'],exact);self.assertEqual(report['validity'],[True]*482)
        exact_mesh=frame['resources']['wave-exact'];self.assertEqual(exact_mesh['positions'],source['positions']);self.assertEqual(exact_mesh['normals'],source['normals'])
        bracket,values=self.sample_oracle(time);sample=frame['sampledFields']['numerical-sample'];self.assertEqual(sample['bracket'],bracket)
        self.assertEqual(sample['provenance'],{'seed':self.original['seed'],'solver':self.original['solver']})
        numeric_mesh=frame['resources']['wave-numeric'];attributes=numeric_mesh['attributes']['values']
        self.compare(attributes['raw-wave']['buffer']['data'],values['scalar']);self.compare(attributes['raw-gradient']['buffer']['data'],values['gradient'])
        self.compare(numeric_mesh['positions']['data'],values['position'])
        for name in ['indices','topologyRevision']:self.assertEqual(numeric_mesh[name],source[name])
        expected_points=triples(values['position'])
        for key,operation in [('min',min),('max',max)]:self.compare(numeric_mesh['bounds'][key],[operation(p[i] for p in expected_points) for i in range(3)])
        for n in triples(numeric_mesh['normals']['data']):self.assertAlmostEqual(math.hypot(*n),1,delta=2e-12)
        for name,mesh,raw in [('exact-field',exact_mesh,exact),('numeric-field',numeric_mesh,values['scalar'])]:
            self.assertEqual(frame['fieldVisualization'][name]['range'],{'min':-1,'max':1});self.compare(frame['fieldVisualization'][name]['scalar'],raw)
            self.compare(mesh['attributes']['values']['wave-color']['buffer']['data'],[c for value in raw for c in color(value)])
        vectors=frame['fieldVisualization']['gradient-field'];records=frame['instanceSets']['gradient-arrows']['instances']
        self.assertEqual(len(records),482);self.assertEqual(len({r['id'] for r in records}),482)
        for i,((x,y,z),record) in enumerate(zip(points,records)):
            wanted=i in ARROW_INDICES;self.assertEqual(vectors['validity'][i],wanted)
            if not wanted:self.assertFalse(record['selected']);self.assertIsNone(vectors['vector'][i]);continue
            gradient=[(2*y-4*x*x*y)*cosine,(2*x-4*x*y*y)*cosine,-4*x*y*z*cosine]
            self.compare(vectors['vector'][i],gradient);self.assertAlmostEqual(sum(a*b for a,b in zip(gradient,[x,y,z])),0,delta=2e-12)
            magnitude=math.hypot(*gradient);self.assertEqual(record['selected'],magnitude>0)
            self.compare(record['transform']['translation'],[x,y,z]);self.assertAlmostEqual(record['transform']['scale'][0],.14*magnitude,delta=2e-12)
            if magnitude>1e-12:
                qx,qy,qz,qw=record['transform']['rotation'];forward=[1-2*(qy*qy+qz*qz),2*(qx*qy+qw*qz),2*(qx*qz-qw*qy)]
                self.compare(forward,[g/magnitude for g in gradient])
        return exact,values

    def test_live_exact_and_imported_rk4_have_distinct_independent_oracles(self):
        self.assertEqual(self.bundle['duration'],8);self.assertEqual(len(self.bundle['bakes']['numerical-wave']['sampleTimes']),65)
        self.assertGreaterEqual(sum(r['kind']=='vector' for r in self.bundle['resources'].values()),12)
        page,errors,requests=self.open()
        try:
            for time in [0,.0625,.125,.9375,1,1.0625,2,3.9375,4,6,7.9375,8]:
                page.evaluate('t=>TexloomGpuPlayer.seek(t)',time);exact,sampled=self.assert_frame(page.evaluate('TexloomGpuPlayer.getFrame()'),time)
                if time==.0625:self.assertGreater(max(abs(a-b) for a,b in zip(exact,sampled['scalar'])),1e-4)
            self.assertTrue(page.evaluate('TexloomGpuPlayer.getState().sourceUnchanged'));self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_reverse_pixels_and_gradient_identities_remain_stable(self):
        page,errors,requests=self.open()
        try:
            captures={};identities=None
            for time in [0,.0625,.9375,1.0625,2,4,6,8]:
                capture=page.evaluate('t=>TexloomGpuPlayer.capture(t)',time);self.assert_frame(page.evaluate('TexloomGpuPlayer.getFrame()'),time)
                captures[time]=hashlib.sha256(base64.b64decode(capture['data'])).hexdigest()
                current=page.evaluate('TexloomGpuPlayer.getFrame().instanceSets["gradient-arrows"].instances.map(r=>r.id)')
                if identities is None:identities=current
                self.assertEqual(current,identities)
            self.assertGreater(len(set(captures.values())),4)
            for time in reversed(list(captures)):
                actual=page.evaluate('t=>TexloomGpuPlayer.capture(t)',time);self.assertEqual(hashlib.sha256(base64.b64decode(actual['data'])).hexdigest(),captures[time])
            self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_thirty_and_sixty_fps_histories_converge_to_identical_absolute_frames(self):
        page,errors,requests=self.open()
        try:
            snapshots=[]
            for fps in [30,60]:
                page.evaluate('fps=>{for(let i=0;i<=fps;i++)TexloomGpuPlayer.seek(i/fps);}',fps)
                captured=[]
                for time in [.9375,4,7.9375]:
                    image=page.evaluate('t=>TexloomGpuPlayer.capture(t).data',time);frame=page.evaluate('TexloomGpuPlayer.getFrame()');self.assert_frame(frame,time)
                    captured.append((image,frame['resources'],frame['instanceSets']))
                snapshots.append(captured)
            self.assertEqual(snapshots[0],snapshots[1]);self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_mobile_time_speed_playback_keep_data_and_labels_available(self):
        page,errors,requests=self.open(mobile=True)
        try:
            self.assertFalse(page.evaluate('document.documentElement.scrollWidth>innerWidth'))
            slider=page.get_by_label('Scene time',exact=True)
            slider.evaluate('(e)=>{e.value="1.0625";e.dispatchEvent(new Event("input",{bubbles:true}));}')
            # The time input has a .001-second step, so use its actual value.
            time=page.evaluate('TexloomGpuPlayer.getState().time');self.assert_frame(page.evaluate('TexloomGpuPlayer.getFrame()'),time)
            page.locator('#speed').select_option('0.5');page.get_by_role('button',name='Play',exact=True).click()
            page.wait_for_function('TexloomGpuPlayer.getState().time>1.1');page.get_by_role('button',name='Pause',exact=True).click()
            self.assertFalse(page.evaluate('TexloomGpuPlayer.getState().playing'));page.evaluate('TexloomGpuPlayer.seek(0)');self.assert_frame(page.evaluate('TexloomGpuPlayer.getFrame()'),0)
            self.assertEqual(errors+requests,[])
        finally:page.close()


if __name__=='__main__':unittest.main()
