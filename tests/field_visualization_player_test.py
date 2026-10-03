"""Independent scalar/color/displacement oracles in the actual offline GPU player."""
import base64
import hashlib
import io
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from compile import compile_scene
from tests.field_visualization_capture_test import operation,document,declaration,color_policy


def triples(data):
    return list(zip(*[iter(data)]*3))


def expected_color(value):
    t=max(0,min(1,(value+1)/2))
    lo,hi,f=([.03,.14,.55],[.08,.48,.3],t*2) if t<=.5 else ([.08,.48,.3],[.95,.46,.04],(t-.5)*2)
    return [a+(b-a)*f for a,b in zip(lo,hi)]


def srgb(value):
    return round(255*(12.92*value if value<=.0031308 else 1.055*value**(1/2.4)-.055))


def build_player(bundle,output):
    result=subprocess.run(['node',str(ROOT/'tools/build-gpu-player.mjs'),str(bundle),str(output)],cwd=ROOT,capture_output=True,text=True,encoding='utf8')
    if result.returncode:raise AssertionError(result.stdout+result.stderr)


class FieldVisualizationPlayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        cls.bundle=compile_scene(ROOT/'examples/surface-field.tex',cls.folder/'native')
        cls.player=cls.folder/'player.html';build_player(cls.folder/'native/bundle.json',cls.player)
        cls.fixture_players={}
        for name in ['vector','invalid-auto']:
            op=operation()
            if name=='vector':del op['mask']
            else:op['scalar']='1/x';op['color']=color_policy('auto')
            source=cls.folder/f'{name}.tex';source.write_text(document(declaration(op)),encoding='utf8')
            compile_scene(source,cls.folder/name);player=cls.folder/f'{name}.html';build_player(cls.folder/name/'bundle.json',player)
            cls.fixture_players[name]=player
        cls.playwright=sync_playwright().start();cls.browser=cls.playwright.chromium.launch(headless=True,args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.playwright.stop();cls.temp.cleanup()

    def open(self,path=None,mobile=False,capture=True):
        page=self.browser.new_page(viewport={'width':390,'height':844} if mobile else {'width':960,'height':540},reduced_motion='reduce')
        errors=[];requests=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('console',lambda m:errors.append(m.text) if m.type=='error' else None)
        page.on('request',lambda r:requests.append(r.url) if r.url.startswith(('http:','https:')) else None)
        page.goto((path or self.player).as_uri()+('?capture=1' if capture else ''));page.evaluate('async()=>await window.TexloomGpuPlayer.ready')
        return page,errors,requests

    def assert_fields(self,frame,time,amplitude=.35):
        source=frame['resources']['sphere'];left=frame['resources']['colored-sphere'];right=frame['resources']['displaced-sphere']
        self.assertEqual(source['positions']['count'],114);self.assertEqual(source['indices']['count'],672);self.assertNotIn('attributes',source)
        points=triples(source['positions']['data']);normals=triples(source['normals']['data']);moved=triples(right['positions']['data'])
        report=frame['fieldVisualization'];raw=[2*x*y*math.cos(math.pi*time/4) for x,y,z in points]
        for label,mesh in [('color-stage',left),('displacement-stage',right)]:
            values=report[label]
            self.assertEqual(values['source'],'sphere');self.assertEqual(values['domain'],'vertex');self.assertEqual(values['range'],{'min':-1,'max':1})
            self.assertEqual(values['validity'],[True]*114);self.assertEqual(values['mappedValidity'],[True]*114)
            self.assertEqual(mesh['indices'],source['indices']);self.assertEqual(mesh['topologyRevision'],source['topologyRevision'])
            self.assertEqual(values['sourceNormals'],source['normals'])
            for a,b in zip(values['scalar'],raw):self.assertAlmostEqual(a,b,delta=2e-12)
            colors=triples(mesh['attributes']['values']['field-color']['buffer']['data'])
            for color,value in zip(colors,raw):
                for actual,want in zip(color,expected_color(value)):self.assertAlmostEqual(actual,want,delta=2e-12)
            self.assertEqual(mesh['attributes']['topology']['indices'],source['indices']['data'])
        for name in ['positions','indices','bounds','normals']:self.assertEqual(left[name],source[name])
        self.assertEqual(report['color-stage']['normalOrigin'],'source');self.assertEqual(report['displacement-stage']['amplitude'],amplitude)
        for point,normal,actual,value in zip(points,normals,moved,raw):
            self.assertAlmostEqual(math.sqrt(sum(x*x for x in point)),1,delta=2e-12)
            for p,n,a in zip(point,normal,actual):self.assertAlmostEqual(a,p+amplitude*value*n,delta=2e-12)
        self.assertEqual(right['bounds'],{'min':[min(p[i] for p in moved) for i in range(3)],'max':[max(p[i] for p in moved) for i in range(3)]})
        if amplitude==0:
            for name in ['positions','indices','bounds','normals']:self.assertEqual(right[name],source[name])
            self.assertEqual(report['displacement-stage']['normalOrigin'],'source')
        else:
            self.assertEqual(report['displacement-stage']['normalOrigin'],'recomputed')
            for n in triples(right['normals']['data']):self.assertAlmostEqual(math.sqrt(sum(x*x for x in n)),1,delta=2e-12)
        return points,raw

    def test_raw_field_fixed_colors_and_original_normal_displacement_are_pure_under_reverse_seek(self):
        page,errors,requests=self.open()
        try:
            captures={};original=None
            for time in [0,.5,1,2,3,4,6,8]:
                capture=page.evaluate('t=>window.TexloomGpuPlayer.capture(t)',time);frame=page.evaluate('window.TexloomGpuPlayer.getFrame()')
                self.assert_fields(frame,time)
                if original is None:original=frame['resources']['sphere']
                self.assertEqual(frame['resources']['sphere'],original)
                captures[time]=hashlib.sha256(base64.b64decode(capture['data'])).hexdigest()
            self.assertGreater(len(set(captures.values())),4)
            for time in reversed(list(captures)):
                capture=page.evaluate('t=>window.TexloomGpuPlayer.capture(t)',time)
                self.assertEqual(hashlib.sha256(base64.b64decode(capture['data'])).hexdigest(),captures[time])
            self.assertTrue(page.evaluate('window.TexloomGpuPlayer.getState().sourceUnchanged'))
            self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_visible_color_pixels_interpolate_linear_rgb_using_independent_projection(self):
        page,errors,requests=self.open()
        try:
            captured=page.evaluate('window.TexloomGpuPlayer.capture(0)');frame=page.evaluate('window.TexloomGpuPlayer.getFrame()');points,raw=self.assert_fields(frame,0)
            colors=[expected_color(x) for x in raw];faces=triples(frame['resources']['sphere']['indices']['data']);d=math.sqrt(58)
            projected=[(480+(x-1.65)*112.5,270-(3*y+7*z)/d*112.5,(-7*y+3*z-58)/d) for x,y,z in points]
            image=Image.open(io.BytesIO(base64.b64decode(captured['data']))).convert('RGB');comparisons=0
            for py in range(190,351,6):
                for px in range(210,381,6):
                    hits=[]
                    for face in faces:
                        a,b,c=[projected[i] for i in face]
                        den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
                        if den>=-40:continue
                        wa=((b[1]-c[1])*(px+.5-c[0])+(c[0]-b[0])*(py+.5-c[1]))/den
                        wb=((c[1]-a[1])*(px+.5-c[0])+(a[0]-c[0])*(py+.5-c[1]))/den
                        weights=[wa,wb,1-wa-wb]
                        if min(weights)>=0:hits.append((sum(w*p[2] for w,p in zip(weights,[a,b,c])),face,weights))
                    if not hits:continue
                    _,face,weights=max(hits)
                    if min(weights)<.2:continue
                    expected=[srgb(sum(w*colors[i][k] for w,i in zip(weights,face))) for k in range(3)]
                    actual=image.getpixel((px,py))
                    for a,b in zip(actual,expected):self.assertLessEqual(abs(a-b),2,(px,py,actual,expected))
                    comparisons+=1
            self.assertGreater(comparisons,65);self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_mobile_amplitude_controls_restore_source_geometry_and_leave_fixed_color_scale_unchanged(self):
        page,errors,requests=self.open(mobile=True,capture=False)
        try:
            self.assertFalse(page.evaluate('document.documentElement.scrollWidth>innerWidth'));page.evaluate('window.TexloomGpuPlayer.seek(1)')
            before=page.evaluate('window.TexloomGpuPlayer.getFrame()');self.assert_fields(before,1)
            slider=page.get_by_label('amplitude',exact=True)
            for amplitude in [0,.6]:
                slider.evaluate('(e,v)=>{e.value=String(v);e.dispatchEvent(new Event("input",{bubbles:true}));}',amplitude)
                changed=page.evaluate('window.TexloomGpuPlayer.getFrame()');self.assert_fields(changed,1,amplitude)
                self.assertEqual(changed['resources']['colored-sphere'],before['resources']['colored-sphere'])
                self.assertEqual(changed['resources']['sphere'],before['resources']['sphere'])
            # The range input has a .003 step; the API preserves the authored .35 exactly.
            page.evaluate('window.TexloomGpuPlayer.setParameter("amplitude",.35)')
            self.assertEqual(page.evaluate('window.TexloomGpuPlayer.getFrame().resources'),before['resources'])
            self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_vector_arrows_have_analytic_direction_and_masked_auto_range_keeps_raw_invalidity_explicit(self):
        for name in ['vector','invalid-auto']:
            page,errors,requests=self.open(self.fixture_players[name])
            try:
                capture=page.evaluate('window.TexloomGpuPlayer.capture(0)');frame=page.evaluate('window.TexloomGpuPlayer.getFrame()');report=frame['fieldVisualization']['field']
                points=triples(frame['resources']['sites']['positions']['data']);records=frame['instanceSets']['vectors']['instances'];ids=[r['id'] for r in records]
                self.assertEqual(len(ids),len(set(ids)));self.assertEqual(report['range'],{'min':-1,'max':1})
                self.assertEqual(report['scalar'],[1,0,-1,0] if name=='vector' else [1,None,-1,None])
                self.assertEqual(report['validity'],[True]*4 if name=='vector' else [True,False,True,False])
                self.assertEqual([r['selected'] for r in records],[True,True,True,False] if name=='vector' else [True,False,True,False])
                for i,(p,r) in enumerate(zip(points,records)):
                    self.assertEqual(r['transform']['translation'],list(p))
                    if not r['selected']:continue
                    vector=[-p[1],p[0],0];magnitude=math.hypot(*vector);x,y,z,w=r['transform']['rotation']
                    forward=[1-2*(y*y+z*z),2*(x*y+w*z),2*(x*z-w*y)]
                    for actual,want in zip(forward,[v/magnitude for v in vector]):self.assertAlmostEqual(actual,want,delta=2e-12)
                    self.assertAlmostEqual(r['transform']['scale'][0],.5*magnitude,delta=2e-12)
                if name=='invalid-auto':
                    colors=triples(frame['resources']['painted']['attributes']['values']['color']['buffer']['data']);self.assertEqual(colors,[(1,0,0),(.2,.2,.2),(0,0,1),(.2,.2,.2)])
                page.evaluate('window.TexloomGpuPlayer.seek(2)');self.assertEqual(page.evaluate('window.TexloomGpuPlayer.getFrame().instanceSets.vectors.instances.map(r=>r.id)'),ids)
                again=page.evaluate('window.TexloomGpuPlayer.capture(0)');self.assertEqual(again['data'],capture['data']);self.assertEqual(errors+requests,[])
            finally:page.close()


if __name__=='__main__':unittest.main()
