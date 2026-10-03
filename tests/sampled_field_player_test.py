"""Independent imported-data interpolation oracle in the actual offline GPU player."""
import base64
import bisect
import hashlib
import io
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
from compile import compile_scene
from tests.field_visualization_player_test import build_player, triples, expected_color, srgb


class SampledFieldPlayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        cls.original=json.loads((ROOT/'examples/data/temporal-samples/samples.json').read_text())
        cls.mesh=json.loads((ROOT/'examples/data/temporal-samples/mesh.json').read_text())
        cls.bundle=compile_scene(ROOT/'examples/temporal-samples.tex',cls.folder/'native')
        cls.player=cls.folder/'player.html';build_player(cls.folder/'native/bundle.json',cls.player)
        cls.playwright=sync_playwright().start();cls.browser=cls.playwright.chromium.launch(headless=True,args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.playwright.stop();cls.temp.cleanup()
    def open(self,mobile=False):
        page=self.browser.new_page(viewport={'width':390,'height':844} if mobile else {'width':960,'height':540},reduced_motion='reduce')
        errors=[];requests=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('console',lambda m:errors.append(m.text) if m.type=='error' else None)
        page.on('request',lambda r:requests.append(r.url) if r.url.startswith(('http:','https:')) else None)
        page.goto(self.player.as_uri()+('' if mobile else '?capture=1'));page.evaluate('async()=>await window.TexloomGpuPlayer.ready');return page,errors,requests
    def oracle(self,time):
        frames=self.original['frames'];times=[f['time'] for f in frames];left=bisect.bisect_left(times,time)
        if left<len(times) and times[left]==time:right=left;alpha=0
        else:right=left;left-=1;alpha=(time-times[left])/(times[right]-times[left])
        values={name:[a+(b-a)*alpha for a,b in zip(frames[left]['values'][name],frames[right]['values'][name])] for name in ['scalar','vector','position']}
        return left,right,alpha,values
    def assert_frame(self,frame,time):
        left,right,alpha,values=self.oracle(time)
        self.assertEqual(frame['resources']['sample-domain'],self.mesh)
        for op,rid in [('sample-left','sampled-left'),('sample-right','sampled-right')]:
            report=frame['sampledFields'][op];self.assertEqual(report['bracket'],{'left':left,'right':right,'alpha':alpha,'sourceTime':time})
            self.assertEqual(report['provenance'],{'solver':self.original['solver'],'seed':3601})
            mesh=frame['resources'][rid];self.assertEqual(mesh['indices'],self.mesh['indices']);self.assertEqual(mesh['topologyRevision'],self.mesh['topologyRevision'])
            attributes=mesh['attributes']['values']
            for channel,attr in [('scalar','raw-scalar'),('vector','raw-vector')]:
                self.assertEqual(attributes[attr]['buffer']['componentType'],'float64')
                for actual,want in zip(attributes[attr]['buffer']['data'],values[channel]):self.assertAlmostEqual(actual,want,delta=3e-12)
            expected=values['position'] if op=='sample-right' else self.mesh['positions']['data']
            for actual,want in zip(mesh['positions']['data'],expected):self.assertAlmostEqual(actual,want,delta=3e-12)
            points=triples(expected);self.assertEqual(mesh['bounds'],{'min':[min(p[i] for p in points) for i in range(3)],'max':[max(p[i] for p in points) for i in range(3)]})
            if op=='sample-right':
                for normal in triples(mesh['normals']['data']):self.assertAlmostEqual(math.hypot(*normal),1,delta=2e-12)
        for op,rid in [('color-left','colored-left'),('color-right','colored-right')]:
            report=frame['fieldVisualization'][op];self.assertEqual(report['range'],{'min':-1,'max':1})
            self.assertEqual(report['validity'],[True]*114)
            for actual,want in zip(report['scalar'],values['scalar']):self.assertAlmostEqual(actual,want,delta=3e-12)
            colors=triples(frame['resources'][rid]['attributes']['values']['sample-color']['buffer']['data'])
            for actual,want in zip(colors,map(expected_color,values['scalar'])):
                for a,b in zip(actual,want):self.assertAlmostEqual(a,b,delta=3e-12)
        return values

    def test_exact_knots_cross_chunk_interpolation_and_reverse_seek(self):
        page,errors,requests=self.open()
        try:
            times=[0,.25,.5,.5+1e-9,1.125,1.75-1e-9,1.75,2.375,3,3.75,4.5,5.375,6.25,7.125,8];captures={}
            for time in times:
                capture=page.evaluate('t=>TexloomGpuPlayer.capture(t)',time);frame=page.evaluate('TexloomGpuPlayer.getFrame()');values=self.assert_frame(frame,time)
                captures[time]=hashlib.sha256(base64.b64decode(capture['data'])).hexdigest()
                if time==1.125:
                    analytic=[2*x*y*math.cos(2*math.pi*time/8) for x,y,z in triples(self.mesh['positions']['data'])]
                    self.assertGreater(max(abs(a-b) for a,b in zip(analytic,values['scalar'])),.04)
            for time in reversed(times):
                actual=page.evaluate('t=>TexloomGpuPlayer.capture(t)',time)
                self.assertEqual(hashlib.sha256(base64.b64decode(actual['data'])).hexdigest(),captures[time]);self.assert_frame(page.evaluate('TexloomGpuPlayer.getFrame()'),time)
            self.assertTrue(page.evaluate('TexloomGpuPlayer.getState().sourceUnchanged'));self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_fps_history_does_not_change_the_same_absolute_sample(self):
        page,errors,requests=self.open()
        try:
            snapshots=[]
            for fps in [30,60]:
                page.evaluate('fps=>{for(let i=0;i<=fps;i++)TexloomGpuPlayer.seek(i/fps);}',fps)
                images=[];resources=[]
                for t in [1.125,2.375,5.375,8]:
                    images.append(page.evaluate('t=>TexloomGpuPlayer.capture(t).data',t));frame=page.evaluate('TexloomGpuPlayer.getFrame()');self.assert_frame(frame,t);resources.append(frame['resources'])
                snapshots.append((images,resources))
            self.assertEqual(snapshots[0],snapshots[1]);self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_imported_color_reaches_gpu_pixels_with_independent_projection(self):
        page,errors,requests=self.open()
        try:
            capture=page.evaluate('TexloomGpuPlayer.capture(1.125)');frame=page.evaluate('TexloomGpuPlayer.getFrame()');values=self.assert_frame(frame,1.125)
            colors=list(map(expected_color,values['scalar']));points=triples(self.mesh['positions']['data']);faces=triples(self.mesh['indices']['data']);d=math.sqrt(58)
            projected=[(480+(x-1.65)*112.5,270-(3*y+7*z)/d*112.5,(-7*y+3*z-58)/d) for x,y,z in points]
            image=Image.open(io.BytesIO(base64.b64decode(capture['data']))).convert('RGB');comparisons=0
            for py in range(190,351,8):
                for px in range(210,381,8):
                    hits=[]
                    for face in faces:
                        a,b,c=[projected[i] for i in face];den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
                        if den>=-40:continue
                        wa=((b[1]-c[1])*(px+.5-c[0])+(c[0]-b[0])*(py+.5-c[1]))/den;wb=((c[1]-a[1])*(px+.5-c[0])+(a[0]-c[0])*(py+.5-c[1]))/den;weights=[wa,wb,1-wa-wb]
                        if min(weights)>=0:hits.append((sum(w*p[2] for w,p in zip(weights,[a,b,c])),face,weights))
                    if not hits:continue
                    _,face,weights=max(hits)
                    if min(weights)<.2:continue
                    expected=[srgb(sum(w*colors[i][k] for w,i in zip(weights,face))) for k in range(3)];actual=image.getpixel((px,py))
                    for a,b in zip(actual,expected):self.assertLessEqual(abs(a-b),2,(px,py,actual,expected))
                    comparisons+=1
            self.assertGreater(comparisons,35);self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_mobile_real_controls_are_independent_of_data_knots(self):
        page,errors,requests=self.open(mobile=True)
        try:
            self.assertFalse(page.evaluate('document.documentElement.scrollWidth>innerWidth'))
            slider=page.get_by_label('Scene time',exact=True)
            slider.evaluate('(e)=>{e.value="2.375";e.dispatchEvent(new Event("input",{bubbles:true}));}')
            self.assert_frame(page.evaluate('TexloomGpuPlayer.getFrame()'),2.375)
            page.locator('#speed').select_option('2');page.get_by_role('button',name='Play',exact=True).click()
            page.wait_for_function('TexloomGpuPlayer.getState().time>2.4');page.get_by_role('button',name='Pause',exact=True).click()
            self.assertFalse(page.evaluate('TexloomGpuPlayer.getState().playing'));page.evaluate('TexloomGpuPlayer.seek(0)');self.assert_frame(page.evaluate('TexloomGpuPlayer.getFrame()'),0)
            self.assertEqual(errors+requests,[])
        finally:page.close()


if __name__=='__main__':unittest.main()
