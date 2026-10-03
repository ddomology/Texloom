"""Actual browser pixels guard the per-leaf presentation boundary."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]


class PresentationCanvasTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        folder = Path(cls.temp.name)
        entry = folder / 'entry.mjs'
        entry.write_text(
            f"export {{renderCanvas}} from {json.dumps((ROOT / 'src/render-canvas.ts').as_posix())};\n"
            f"export {{createChalkspaceCanvasLayer,boardProjectionMatrix}} from {json.dumps((ROOT / 'adapters/chalkspace-canvas.ts').as_posix())};\n",
            encoding='utf8')
        cls.script = folder / 'browser.js'
        # esbuild/bin/esbuild is a JS launcher on Windows but can be an ELF
        # executable on Linux. Use its public Node API on both platforms.
        command = ['node', '-e', "require('esbuild').buildSync({entryPoints:[process.argv[1]],bundle:true,"
                   "format:'iife',globalName:'API',outfile:process.argv[2]})", str(entry), str(cls.script)]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr)
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.temp.cleanup()

    def test_hook_preserves_group_opacity_clip_and_native_projection(self):
        page = self.browser.new_page()
        try:
            page.add_script_tag(path=str(self.script))
            result = page.evaluate('''() => {
              const canvas=()=>{const c=document.createElement('canvas');c.width=854;c.height=480;return c;};
              const frame={time:1,viewport:{width:100,height:50},camera:{x:3,y:2,zoom:1.1,rotation:.12},resources:{ink:{kind:'vector',items:[{kind:'path',d:'M0 0L10 0L5 -8Z',style:{fill:'currentColor'}}]}},nodes:[
                {id:'group',kind:'group',style:{opacity:.55},clip:{d:'M0 0H90V45H0Z'},transform:{translate:[4,2]}},
                {id:'a',kind:'point',parent:'group',x:20,y:20,r:14,style:{fill:'#aaff88'}},
                {id:'b',kind:'point',parent:'group',x:35,y:20,r:14,style:{fill:'#ffaa88'},transform:{rotate:.1}},
                {id:'label',kind:'tex',parent:'group',resourceId:'ink',x:62,y:30,scale:1.3,style:{fill:'#ffffff'}},
              ]};
              const a=canvas(),b=canvas(),placement={x:1,y:1.3,width:9.3},view={frameWidth:16,frameHeight:9,cameraY:4.8};
              const first=API.createChalkspaceCanvasLayer(placement),second=API.createChalkspaceCanvasLayer(placement);
              first.draw(frame,a.getContext('2d'),view);
              const matrices=[],preserved=[];
              const rect=second.draw(frame,b.getContext('2d'),view,{paintNode(node,ctx,draw){
                matrices.push([node.id,...['a','b','c','d','e','f'].map(k=>ctx.getTransform()[k])]);
                const before=JSON.stringify(ctx.getTransform());draw(ctx);preserved.push(before===JSON.stringify(ctx.getTransform()));
              }});
              const equal=a.toDataURL()===b.toDataURL();
              const projection=API.boardProjectionMatrix(frame,placement,view,854),m=matrices[0].slice(1);
              const local=[20,20],world=[24,22],px=projection[0]*world[0]+projection[2]*world[1]+projection[4],py=projection[1]*world[0]+projection[3]*world[1]+projection[5];
              const bx=rect.x+(m[0]*local[0]+m[2]*local[1]+m[4])*rect.width/Math.ceil(rect.width);
              const by=rect.y+(m[1]*local[0]+m[3]*local[1]+m[5])*rect.height/Math.ceil(rect.height);
              first.dispose();second.dispose();return {equal,preserved,ids:matrices.map(m=>m[0]),error:Math.hypot(px-bx,py-by)};
            }''')
            self.assertTrue(result['equal'])
            self.assertEqual(result['ids'], ['a', 'b', 'label'])
            self.assertTrue(all(result['preserved']))
            # Chromium's Canvas transform stores coefficients at float precision;
            # this is < 1/10,000 pixel, well below raster placement resolution.
            self.assertLess(result['error'], 1e-4)
        finally:
            page.close()

    def test_prefix_painter_does_not_mutate_the_frame_or_paint_the_terminal_arrow(self):
        page = self.browser.new_page()
        try:
            page.add_script_tag(path=str(self.script))
            result = page.evaluate('''() => {
              const line=(x)=>({contours:[{id:'c',start:[10,25],segments:[{kind:'line',id:'s',to:[x,25]}]}]});
              const frame={time:1,viewport:{width:100,height:50},camera:{x:0,y:0,zoom:1},resources:{},nodes:[
                {id:'path',kind:'path',d:'M10 25L90 25',style:{fill:'none',stroke:'#ffffff',strokeWidth:4},
                 resolvedArrows:{shaft:line(90),startTip:{contours:[]},endTip:{contours:[{id:'tip',start:[90,25],segments:[{kind:'line',id:'l',to:[80,20]},{kind:'line',id:'r',to:[80,30]}],closed:true}]}}}
              ]};
              const before=JSON.stringify(frame),canvas=document.createElement('canvas');canvas.width=100;canvas.height=50;
              const ctx=canvas.getContext('2d');
              API.renderCanvas(frame,ctx,{background:'transparent',paintNode:(node,c,draw)=>draw(c,{strokePrefix:line(45)})});
              const data=ctx.getImageData(0,0,100,50).data;let left=0,right=0;
              for(let y=0;y<50;y++)for(let x=0;x<100;x++){if(data[(y*100+x)*4+3]){if(x<46)left++;else right++;}}
              return {unchanged:before===JSON.stringify(frame),left,right};
            }''')
            self.assertTrue(result['unchanged'])
            self.assertGreater(result['left'], 100)
            self.assertEqual(result['right'], 0)
        finally:
            page.close()
