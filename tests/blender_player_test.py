"""Actual Blender evaluated geometry in the native offline WebGL player."""
import base64
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'tools'))
from compile import compile_scene
from tests.field_visualization_player_test import build_player
from tests.blender_oracle import BlenderOracle,WEB_SNAPSHOT_JS


class BlenderPlayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        data=ROOT/'examples/data/blender-evaluated'
        cls.manifest=json.loads((data/'manifest.json').read_text(encoding='utf8'))
        cls.reference=json.loads((data/'reference.json').read_text(encoding='utf8'))
        cls.bundle=compile_scene(ROOT/'examples/blender-evaluated.tex',cls.folder/'native')
        cls.oracle=BlenderOracle(cls.manifest,cls.reference,cls.bundle['provenance']['blenderImports'][0])
        cls.player=cls.folder/'player.html';build_player(cls.folder/'native/bundle.json',cls.player)
        cls.playwright=sync_playwright().start();cls.browser=cls.playwright.chromium.launch(headless=True,args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.playwright.stop();cls.temp.cleanup()
    def open(self,mobile=False):
        page=self.browser.new_page(viewport={'width':390,'height':844} if mobile else {'width':1280,'height':720},reduced_motion='reduce')
        errors=[];requests=[];page.on('pageerror',lambda e:errors.append(str(e)));page.on('console',lambda m:errors.append(m.text) if m.type=='error' else None)
        page.on('request',lambda r:requests.append(r.url) if r.url.startswith(('http:','https:')) else None)
        page.goto(self.player.as_uri()+('' if mobile else '?capture=1'));page.evaluate('async()=>await TexloomGpuPlayer.ready');return page,errors,requests

    def test_every_blender_knot_matches_world_coordinates_normals_and_shared_prototypes(self):
        self.assertEqual(self.bundle['duration'],8)
        for label in ['title-art','modifier-count-art','space-formula-art','normal-formula-art','limits-art']:
            self.assertEqual(self.bundle['resources'][label]['kind'],'vector')
        self.assertEqual(self.manifest['coordinates']['metersPerBlenderUnit'],self.reference['metersPerBlenderUnit'])
        self.assertAlmostEqual(self.reference['metersPerBlenderUnit'],.01,delta=1e-8)
        page,errors,requests=self.open()
        try:
            for time in [0,.25,1,2,4,6,8]:
                result=self.oracle.assert_frame(self,page.evaluate(WEB_SNAPSHOT_JS,time),time)
                self.assertTrue(result['exactBlenderKnot']);self.assertEqual(result['instances'],4)
            self.assertTrue(page.evaluate('TexloomGpuPlayer.getState().sourceUnchanged'));self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_fractional_bake_interpolation_and_reverse_pixels_are_deterministic(self):
        page,errors,requests=self.open()
        try:
            captures={};frames={}
            for time in [.125,.5,1.5,3,5,7]:
                frame=page.evaluate(WEB_SNAPSHOT_JS,time);self.oracle.assert_frame(self,frame,time);frames[time]=frame
                image=page.evaluate('t=>TexloomGpuPlayer.capture(t).data',time)
                captures[time]=hashlib.sha256(base64.b64decode(image)).hexdigest()
            self.assertGreater(len(set(captures.values())),3)
            for time in reversed(list(captures)):
                self.assertEqual(page.evaluate(WEB_SNAPSHOT_JS,time),frames[time])
                image=page.evaluate('t=>TexloomGpuPlayer.capture(t).data',time)
                self.assertEqual(hashlib.sha256(base64.b64decode(image)).hexdigest(),captures[time])
            self.assertTrue(page.evaluate('TexloomGpuPlayer.getState().sourceUnchanged'));self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_thirty_and_sixty_fps_histories_reach_identical_absolute_frames(self):
        page,errors,requests=self.open()
        try:
            results=[]
            for fps in [30,60]:
                page.evaluate('fps=>{for(let i=0;i<=fps;i++)TexloomGpuPlayer.seek(i/fps);}',fps)
                states=[]
                for time in [.5,4,7]:
                    frame=page.evaluate(WEB_SNAPSHOT_JS,time);self.oracle.assert_frame(self,frame,time)
                    states.append((frame,page.evaluate('t=>TexloomGpuPlayer.capture(t).data',time)))
                results.append(states)
            self.assertEqual(results[0],results[1]);self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_mobile_controls_keep_native_labels_and_geometry_available(self):
        page,errors,requests=self.open(mobile=True)
        try:
            self.assertFalse(page.evaluate('document.documentElement.scrollWidth>innerWidth'))
            slider=page.get_by_label('Scene time',exact=True)
            slider.evaluate('(e)=>{e.value="1.5";e.dispatchEvent(new Event("input",{bubbles:true}));}')
            self.oracle.assert_frame(self,page.evaluate(WEB_SNAPSHOT_JS,1.5),1.5)
            page.locator('#speed').select_option('0.5');page.get_by_role('button',name='Play',exact=True).click()
            page.wait_for_function('TexloomGpuPlayer.getState().time>1.55');page.get_by_role('button',name='Pause',exact=True).click()
            self.assertFalse(page.evaluate('TexloomGpuPlayer.getState().playing'))
            self.oracle.assert_frame(self,page.evaluate(WEB_SNAPSHOT_JS,0),0)
            self.assertEqual(errors+requests,[])
        finally:page.close()


if __name__=='__main__':unittest.main()
