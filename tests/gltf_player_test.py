"""Native glTF geometry and glTF interpolation through the actual web player."""
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
from tests.gltf_oracle import GltfOracle,load_asset,TIMES,WEB_SNAPSHOT_JS


class GltfPlayerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory();cls.folder=Path(cls.temp.name)
        document,buffers=load_asset(ROOT/'examples/data/gltf-profile/scene.gltf')
        cls.oracle=GltfOracle(document,buffers)
        cls.bundle=compile_scene(ROOT/'examples/gltf-profile.tex',cls.folder/'native')
        cls.player=cls.folder/'player.html';build_player(cls.folder/'native/bundle.json',cls.player)
        cls.playwright=sync_playwright().start()
        cls.browser=cls.playwright.chromium.launch(headless=True,args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
    @classmethod
    def tearDownClass(cls):cls.browser.close();cls.playwright.stop();cls.temp.cleanup()

    def open(self,mobile=False):
        page=self.browser.new_page(viewport={'width':390,'height':844} if mobile else {'width':1280,'height':720},reduced_motion='reduce')
        errors=[];requests=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('console',lambda m:errors.append(m.text) if m.type=='error' else None)
        page.on('request',lambda r:requests.append(r.url) if r.url.startswith(('http:','https:')) else None)
        page.goto(self.player.as_uri()+('' if mobile else '?capture=1'))
        page.evaluate('async()=>await TexloomGpuPlayer.ready')
        return page,errors,requests

    def test_every_time_matches_independent_gltf_decode_and_matrix_normal_oracle(self):
        for label in ['title-art','basis-art','basis-formula-art','world-formula-art']:
            self.assertEqual(self.bundle['resources'][label]['kind'],'vector')
        page,errors,requests=self.open()
        try:
            for time in TIMES:
                frame=page.evaluate(WEB_SNAPSHOT_JS,time)
                checked=self.oracle.assert_frame(self,frame,time)
                self.assertEqual(checked['instances'],9);self.assertEqual(checked['negative'],3)
                self.assertEqual(len(set(i['resourceId'] for i in frame['instances'])),3)
            self.assertTrue(page.evaluate('TexloomGpuPlayer.getState().sourceUnchanged'))
            self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_step_boundary_and_reverse_seek_produce_identical_captures(self):
        page,errors,requests=self.open()
        try:
            frames={};images={}
            for time in TIMES:
                frames[time]=page.evaluate(WEB_SNAPSHOT_JS,time)
                self.oracle.assert_frame(self,frames[time],time)
                images[time]=page.evaluate('t=>TexloomGpuPlayer.capture(t).data',time)
                self.assertTrue(base64.b64decode(images[time]).startswith(b'\x89PNG'))
            self.assertGreater(len(set(images.values())),6)
            for time in reversed(TIMES):
                self.assertEqual(page.evaluate(WEB_SNAPSHOT_JS,time),frames[time])
                self.assertEqual(page.evaluate('t=>TexloomGpuPlayer.capture(t).data',time),images[time])
            self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_animation_is_independent_of_thirty_or_sixty_fps_playback_history(self):
        page,errors,requests=self.open()
        try:
            histories=[]
            for fps in [30,60]:
                page.evaluate('fps=>{for(let i=0;i<=fps;i++)TexloomGpuPlayer.seek(i/fps);}',fps)
                samples=[]
                for time in [1.999999,2,2.000001,4.5,7]:
                    frame=page.evaluate(WEB_SNAPSHOT_JS,time);self.oracle.assert_frame(self,frame,time)
                    samples.append((frame,page.evaluate('t=>TexloomGpuPlayer.capture(t).data',time)))
                histories.append(samples)
            self.assertEqual(histories[0],histories[1]);self.assertEqual(errors+requests,[])
        finally:page.close()

    def test_mobile_controls_drive_the_same_gltf_source_clock(self):
        page,errors,requests=self.open(mobile=True)
        try:
            self.assertFalse(page.evaluate('document.documentElement.scrollWidth>innerWidth'))
            slider=page.get_by_label('Scene time',exact=True)
            slider.evaluate('(e)=>{e.value="2";e.dispatchEvent(new Event("input",{bubbles:true}));}')
            self.assertEqual(page.evaluate('TexloomGpuPlayer.getState().time'),2)
            self.oracle.assert_frame(self,page.evaluate(WEB_SNAPSHOT_JS,2),2)
            page.locator('#speed').select_option('0.5');page.get_by_role('button',name='Play',exact=True).click()
            page.wait_for_function('TexloomGpuPlayer.getState().time>2.05')
            page.get_by_role('button',name='Pause',exact=True).click()
            self.assertFalse(page.evaluate('TexloomGpuPlayer.getState().playing'))
            self.oracle.assert_frame(self,page.evaluate(WEB_SNAPSHOT_JS,0),0)
            self.assertEqual(errors+requests,[])
        finally:page.close()


if __name__=='__main__':unittest.main()
