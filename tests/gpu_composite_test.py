"""Same evaluated GPU+TeX frame through standalone and real board placement."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from compile import compile_scene


class GpuCompositeTests(unittest.TestCase):
    def test_board_placement_copies_the_same_gpu_and_native_tex_frame(self):
        self.assert_scene_composites('gpu-cube.tex')

    def test_generated_surfaces_share_exact_pixels_and_source_clock_with_board(self):
        self.assert_scene_composites('parametric-surfaces.tex')

    def test_curve_frames_share_exact_pixels_and_source_clock_with_board(self):
        self.assert_scene_composites('curve-frames.tex')

    def assert_scene_composites(self, source):
        with tempfile.TemporaryDirectory() as temporary:
            folder=Path(temporary)
            bundle=compile_scene(ROOT/'examples'/source,folder/'compiled')
            entry=folder/'entry.ts'
            code='\n'.join([
                f'import {{prepareScene}} from {json.dumps((ROOT/"src/index.ts").as_posix())};',
                f'import {{createSceneCanvasRenderer}} from {json.dumps((ROOT/"src/renderers/scene-canvas.ts").as_posix())};',
                f'import {{createChalkspaceCanvasLayer,prepareChalkspaceLecture}} from {json.dumps((ROOT/"adapters/chalkspace-canvas.ts").as_posix())};',
                'const bundle='+json.dumps(bundle)+';',
                r'''
const runtime=prepareScene(bundle),renderer=createSceneCanvasRenderer();
const ink=document.createElement('canvas');ink.width=640;ink.height=Math.round(640*bundle.viewport.height/bundle.viewport.width);
const board=document.createElement('canvas');board.width=1280;board.height=720;
// This is a readback/capture host: pin the software backend before the first
// paint. Chromium can otherwise migrate after reads and round fractional-alpha
// native outline pixels differently across capture histories.
const a=ink.getContext('2d',{willReadFrequently:true}),b=board.getContext('2d',{willReadFrequently:true});
window.captureBackends=()=>[a,b].map(ctx=>ctx.getContextAttributes().willReadFrequently);
const placement={x:0,y:2.25,width:8},view={frameWidth:16,frameHeight:9,cameraY:4.5};
const layer=createChalkspaceCanvasLayer(placement);
const referencePixels=new Map();
window.checkFrame=(time)=>{
  const frame=runtime.sample(time);renderer.render(frame,a,{background:'transparent'});
  b.resetTransform();b.clearRect(0,0,1280,720);b.translate(3,7);b.globalAlpha=.3;
  const rect=layer.draw(frame,b,view),state={matrix:Array.from(['a','b','c','d','e','f'],k=>b.getTransform()[k]),alpha:b.globalAlpha};
  const expected=a.getImageData(0,0,ink.width,ink.height).data;
  const actual=b.getImageData(rect.x,rect.y,ink.width,ink.height).data;
  let differing=0,painted=0;for(let i=0;i<expected.length;i++){if(expected[i]!==actual[i])differing++;if(i%4===3&&expected[i]>0)painted++;}
  let reverseDifferences=0,maxDifference=0;const examples=[],before=referencePixels.get(time);
  if(before){for(let i=0;i<expected.length;i++)if(expected[i]!==before[i]){reverseDifferences++;maxDifference=Math.max(maxDifference,Math.abs(expected[i]-before[i]));if(examples.length<8)examples.push({x:Math.floor(i/4)%ink.width,y:Math.floor(i/4/ink.width),channel:i%4,before:before[i],after:expected[i]});}}
  else referencePixels.set(time,new Uint8ClampedArray(expected));
  return {differing,painted,state,rect,png:ink.toDataURL(),overlays:frame.space3d.overlays,reverseDifferences,maxDifference,examples};
};
window.checkLecture=async()=>{
  const lecture=await prepareChalkspaceLecture({contract:'texloom-lecture/1',scenes:{solid:bundle},clips:[
    {id:'solid',scene:'solid',placement,timing:{start:1,duration:bundle.duration,after:'hold'}}]});
  const key=lecture.frameKey(2,'gpu'),next=lecture.frameKey(2.01,'gpu');
  const frame=lecture.sample(2)[0].frame,reference=runtime.sample(1);
  const parity=JSON.stringify(frame.space3d)===JSON.stringify(reference.space3d);
  const result={parity,distinct:key!==next,held:lecture.frameKey(99,'gpu')===lecture.frameKey(100,'gpu')};
  lecture.dispose();try{lecture.sample(0)}catch(e){result.disposed=String(e).includes('DISPOSED')}
  return result;
};
window.finish=()=>{renderer.dispose();layer.dispose();try{renderer.render(runtime.sample(0),a)}catch(e){return String(e).includes('DISPOSED')}return false;};
window.checkBackground=()=>{
  const frame=runtime.sample(1);renderer.render(frame,a,{background:'transparent'});const transparent=ink.toDataURL();
  renderer.render(frame,a,{background:'none'});const none=ink.toDataURL();let error=false;
  try{renderer.render(frame,a,{background:'not-a-color'})}catch(e){error=String(e).includes('Unsupported Canvas paint')}
  return {noneSame:none===transparent,error,unchanged:ink.toDataURL()===none};
};
'''])
            entry.write_text(code,encoding='utf8')
            result=subprocess.run(['node','-e',"require('esbuild').buildSync({entryPoints:[process.argv[1]],outfile:process.argv[2],bundle:true,platform:'browser',format:'iife',target:'es2022'})",str(entry),str(folder/'script.js')],cwd=ROOT,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            html=folder/'index.html'
            html.write_text('<!doctype html><script>'+ (folder/'script.js').read_text(encoding='utf8').replace('</script','<\\/script')+'</script>',encoding='utf8')
            with sync_playwright() as manager:
                browser=manager.chromium.launch(args=['--use-angle=swiftshader','--enable-unsafe-swiftshader'])
                page=browser.new_page();errors=[]
                page.on('pageerror',lambda error:errors.append(str(error)))
                page.goto(html.as_uri())
                self.assertEqual(page.evaluate('captureBackends()'),[True,True])
                images={}
                for time in [0,1,2.3,4,7.2]:
                    state=page.evaluate('(t)=>checkFrame(t)',time)
                    self.assertEqual(state['differing'],0)
                    self.assertGreater(state['painted'],1000)
                    self.assertEqual(state['state']['matrix'],[1,0,0,1,3,7])
                    self.assertAlmostEqual(state['state']['alpha'],.3,places=6)
                    self.assertTrue(any(o['visible'] for o in state['overlays']))
                    images[time]=state['png']
                self.assertGreater(len(set(images.values())),3)
                for time in [7.2,0,2.3,1,4]:
                    state=page.evaluate('(t)=>checkFrame(t)',time)
                    self.assertEqual(state['differing'],0,{'time':time,'webBoardChannels':state['differing']})
                    self.assertEqual(state['reverseDifferences'],0,{'time':time,**{k:state[k] for k in ('reverseDifferences','maxDifference','examples')}})
                    self.assertEqual(state['png'],images[time])
                self.assertEqual(page.evaluate('checkLecture()'),{'parity':True,'distinct':True,'held':True,'disposed':True})
                self.assertEqual(page.evaluate('checkBackground()'),{'noneSame':True,'error':True,'unchanged':True})
                self.assertTrue(page.evaluate('finish()'))
                self.assertEqual(errors,[])
                browser.close()
