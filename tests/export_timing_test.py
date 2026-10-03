"""Exact capture clocks and the exporter's asynchronous readiness boundary."""
from fractions import Fraction
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from export_timing import FrameSchedule
from export_video import export


class ExportTimingTests(unittest.TestCase):
    def test_decimal_interval_has_no_spurious_extra_frame(self):
        schedule = FrameSchedule.create(.1, .2, .3, 30)
        self.assertEqual(schedule.frames, 6)
        self.assertEqual(schedule.sample(3)['sourceTime'], .2)
        self.assertEqual(schedule.sample(3)['exactTime'], {'numerator': 1, 'denominator': 5})
        self.assertEqual(schedule.manifest()['paddingDuration'], 0)

    def test_common_30_60_instants_and_reverse_sampling_are_identical(self):
        a = FrameSchedule.create(.125, 1, 2, 30)
        b = FrameSchedule.create(.125, 1, 2, 60)
        for i in reversed(range(a.frames)):
            self.assertEqual(a.sample(i)['sourceTime'], b.sample(2*i)['sourceTime'])
            self.assertEqual(a.sample(i)['exactTime'], b.sample(2*i)['exactTime'])
        self.assertEqual(a.sample(0)['sourceTime'], .125)

    def test_partial_frame_duration_is_explicit_and_never_samples_end(self):
        schedule = FrameSchedule.create(.1, .201, .5, 30)
        self.assertEqual(schedule.frames, 7)
        self.assertLess(schedule.sample(6)['sourceTime'], .301)
        self.assertAlmostEqual(schedule.manifest()['paddingDuration'], float(Fraction(7,30)-Fraction(201,1000)))
        self.assertEqual(schedule.manifest()['exactEnd'], {'numerator':301, 'denominator':1000})

    def test_invalid_intervals_and_fps_reject_before_capture(self):
        for args in [(0,0,1,30),(-1,1,1,30),(1,1,1,30),(0,float('nan'),1,30),
                     (0,1,float('inf'),30),(True,1,2,30),(0,1,2,True),
                     (0,1,2,30.5),(0,1,2,0),(0,1,2,121),(0,1e6,1e6,120),
                     (1e16,4,1e16+4,1)]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                FrameSchedule.create(*args)

    def test_indices_are_strict_and_endpoint_is_excluded(self):
        schedule = FrameSchedule.create(0,1,1,30)
        for index in [-1,30,True,.5]:
            with self.subTest(index=index), self.assertRaises(ValueError):
                schedule.sample(index)

    def test_default_remaining_duration_keeps_exact_scene_endpoint(self):
        schedule = FrameSchedule.create(.10000000000000002,None,1,30)
        self.assertEqual(schedule.end,Fraction(1))
        self.assertEqual(schedule.start,Fraction('0.10000000000000002'))
        self.assertLess(schedule.sample(schedule.frames-1)['sourceTime'],1)


class ExportReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.folder = Path(self.temp.name)
        self.player = self.folder / 'player.html'
        self.player.write_text('''<!doctype html><div id="stage"></div><script>
        let prepared=false;
        window.texloom={bundle:{duration:1,viewport:{width:200,height:100}},
          ready:new Promise(r=>setTimeout(()=>{prepared=true;r()},30)),
          render:async t=>{if(!prepared)throw Error('not ready');
            await new Promise(r=>setTimeout(r,5));
            document.querySelector('#stage').innerHTML=`<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="100" fill="white"/><rect x="${100*t}" y="10" width="20" height="20" fill="blue"/></svg>`;}
        };</script>''',encoding='utf8')

    def tearDown(self):
        self.temp.cleanup()

    def test_still_waits_for_preparation_and_async_render(self):
        from PIL import Image
        output = self.folder/'frame.png'
        result = export(self.player, output, 30, 200, 100, None, .5)
        with Image.open(output) as image:
            self.assertEqual(image.convert('RGB').getpixel((55,15)), (0,0,255))
            self.assertEqual(image.convert('RGB').getpixel((5,15)), (255,255,255))
        self.assertEqual(result['time'], .5)
        self.assertEqual(len(result['inputRevision']),64)

    def test_zero_duration_scene_can_export_still_at_zero(self):
        self.player.write_text(self.player.read_text(encoding='utf8').replace('duration:1','duration:0'),encoding='utf8')
        result = export(self.player,self.folder/'zero.png',30,200,100,None,0)
        self.assertEqual(result['time'],0)

    @unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'FFmpeg and FFprobe required for actual video test')
    def test_video_uses_exact_offset_frames_and_preserves_output_on_render_failure(self):
        output = self.folder/'clip.mp4'
        result = export(self.player,output,30,200,100,.2,None,start=.1)
        self.assertEqual(result['frames'],6)
        self.assertEqual(result['samples'][0]['sourceTime'],.1)
        self.assertEqual(result['samples'][3]['sourceTime'],.2)
        self.assertGreater(len({s['imageSha256'] for s in result['samples']}),1)
        info=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-count_frames','-show_entries','stream=nb_read_frames','-of','json',str(output)],text=True))
        self.assertEqual(int(info['streams'][0]['nb_read_frames']),6)
        before = output.read_bytes()
        self.player.write_text(self.player.read_text(encoding='utf8').replace('if(!prepared)', "if(t>.15)throw Error('render failed');if(!prepared)"),encoding='utf8')
        with self.assertRaisesRegex(Exception, 'render failed'):
            export(self.player,output,30,200,100,.2,None,start=.1)
        self.assertEqual(output.read_bytes(),before)
        self.assertFalse(list(self.folder.glob('*.partial.mp4')))
