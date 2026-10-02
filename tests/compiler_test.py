"""Real engine and strict-import contract tests. Run with Python unittest."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from compile import compile_scene, CompileDiagnostic
from svg_import import import_svg, transform, ImportDiagnostic

class ImportTests(unittest.TestCase):
    def svg(self,content):
        folder=tempfile.TemporaryDirectory(); self.addCleanup(folder.cleanup)
        p=Path(folder.name)/'test.svg'
        p.write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 15 40 30"><g data-tex-origin-x="12" data-tex-origin-y="38"/>'+content+'</svg>')
        return import_svg(p,{'width':45,'height':20,'depth':8})

    def test_logical_box_is_not_ink_box(self):
        r=self.svg('<path d="M10 15h40v30z"/>')
        self.assertEqual(r['metrics'],{'width':45,'height':20,'depth':8})
        self.assertEqual(r['inkBounds'],[-2,-23,40,30])
        self.assertEqual(r['items'][0]['transform'],[1,0,0,1,-12,-38])

    def test_composite_opacity_clip_and_paint_order(self):
        r=self.svg('<defs><clipPath id="c"><path d="M0 0h10v10z"/></clipPath></defs><g opacity=".4" clip-path="url(#c)" transform="translate(10,20) scale(2)"><path d="M0 0h10" fill="red"/><path d="M0 0h20" fill="blue" fill-opacity=".3"/></g>')
        g=r['items'][0]['children'][0]['children'][0]
        self.assertEqual(g['style']['opacity'],.4)
        self.assertEqual(g['transform'],[2,0,0,2,10,20])
        self.assertEqual(g['children'][1]['style']['fillOpacity'],.3)
        self.assertIn('clip',g)

    def test_unsupported_graphics_fail(self):
        for content in ('<path d="M0 0h10" filter="url(#f)"/>','<path d="M0 0h10" fill="url(#gradient)"/>','<text>not outlined</text>','<use href="#missing"/>','<path d="M0 0h10" style="clip-path:url(#c)"/>','<path d="M0 0h10" display="none"/>'):
            with self.subTest(content=content),self.assertRaises(ImportDiagnostic): self.svg(content)

    def test_affine_order_and_rotation(self):
        self.assertEqual(transform('translate(10 20) scale(2 3)'),[2,0,0,3,10,20])
        self.assertEqual(transform('rotate(90 4 5)'),[0,1,-1,0,9,1])

class RealCompilerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.folder=Path(self.temp.name)

    def source(self,body):
        p=self.folder/'scene.tex'; p.write_text('\\documentclass{article}\n\\usepackage{texloom}\n\\begin{document}\n\\TLScene{Fixture}{400}{240}{2}\n'+body+'\n\\end{document}',encoding='utf8'); return p

    def test_actual_macro_execution_math_metrics_and_outlines(self):
        source=self.source(r'''\TLSetup{\newcommand{\Special}[1]{\mathbb{#1}}}
\TLMath{formula}{\frac{x_i^2}{1+x_i^2}\in\Special{R}}
\TLMath{overhang}{\smash{\frac{1}{x}}}
\TLMath{phantom}{\phantom{x_g}}
\newcommand{\Emit}{\TLNode{generated}{tex}{"resourceId":"formula","x":20,"y":40}}
\Emit
\TLNode{colored}{point}{"x":0,"y":0,"r":1,"style":{"fill":"#abcdef"}}''')
        b=compile_scene(source,self.folder/'out')
        self.assertEqual(b['nodes'][0]['id'],'generated')
        self.assertEqual(b['nodes'][1]['style']['fill'],'#abcdef')
        self.assertGreater(b['resources']['formula']['metrics']['depth'],0)
        self.assertGreater(len(b['resources']['formula']['glyphs']),3)
        self.assertEqual(b['resources']['overhang']['metrics']['height'],0)
        self.assertGreater(b['resources']['overhang']['inkBounds'][3],0)
        self.assertGreater(b['resources']['phantom']['metrics']['width'],0)
        self.assertTrue((self.folder/'out'/b['provenance']['sourceDvi']).exists())
        self.assertNotIn('<svg',json.dumps(b))

    def test_clean_rerun_and_failure_does_not_publish_old_bundle(self):
        source=self.source(r'\TLSetup{\newcommand{\Old}{x}}\TLMath{m}{\Old}')
        compile_scene(source,self.folder/'out')
        self.source(r'\TLMath{m}{\Old}')
        with self.assertRaises(CompileDiagnostic): compile_scene(source,self.folder/'out')
        self.assertFalse((self.folder/'out'/'bundle.json').exists())

    def test_duplicate_animation_tracks_rejected(self):
        source=self.source(r'\TLTrack{$camera}{zoom}{linear}{[[0,1],[2,2]]}\TLTrack{$camera}{zoom}{linear}{[[0,1],[2,3]]}')
        with self.assertRaisesRegex(CompileDiagnostic,'Multiple tracks'): compile_scene(source,self.folder/'out')

if __name__=='__main__': unittest.main()
