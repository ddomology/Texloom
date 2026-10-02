"""Native TeX semantic capture: independently authored bare layout references."""
import copy
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'tools'))
from compile import compile_scene
from tests.text_parts_oracle import layout_difference, paint_leaves, outline, maximum_difference

# The reference strings are authored independently, not obtained by the capture
# parser stripping its own marker syntax. This guards the production baseline.
CASES = {
 'fraction': ('math', r'\loompart{fraction}{\frac{\loompart{numerator}{x_1+2}}{\loompart{denominator}{y^3-1}}}', r'\frac{x_1+2}{y^3-1}'),
 'scripts': ('math', r'\loompart{term}{x_{\loompart{index}{i+1}}^{\loompart{power}{n-1}}}', r'x_{i+1}^{n-1}'),
 'limits': ('math', r'\loompart{sum}{\sum_{\loompart{lower}{k=0}}^{\loompart{upper}{N}}}x_k', r'\sum_{k=0}^{N}x_k'),
 'delimiters': ('math', r'\loompart{expression}{\left(\loompart{left}{x}+\frac{1}{x}\right)}', r'\left(x+\frac{1}{x}\right)'),
 'middle': ('math', r'\left\{\loompart{setvar}{x}\middle|\loompart{condition}{x>0}\right\}', r'\left\{x\middle|x>0\right\}'),
 'repeated': ('math', r'\loompart{first-x}{x}+\loompart{second-x}{x}=2x', r'x+x=2x'),
 'aligned': ('math', r'\begin{aligned}\loompart{row-one-left}{a}&=\loompart{row-one-right}{b+c}\\\loompart{row-two-left}{d}&=\loompart{row-two-right}{e+f}\end{aligned}', r'\begin{aligned}a&=b+c\\d&=e+f\end{aligned}'),
 'phantom': ('math', r'a+\loompart{blank}{\phantom{\frac{x}{y}}}+\loompart{visible}{b}', r'a+\phantom{\frac{x}{y}}+b'),
 'empty': ('math', r'a+\loompart{empty}{}+b', r'a++b'),
 'fonts': ('math', r'\loompart{sans}{\mathsf{A}}+\loompart{bold}{\mathbf{B}}+\loompart{blackboard}{\mathbb{R}}+\loompart{calligraphic}{\mathcal{F}}', r'\mathsf{A}+\mathbf{B}+\mathbb{R}+\mathcal{F}'),
 'word': ('text', r'An \loompart{word}{office} is open.', r'An office is open.'),
 'paragraph': ('text', r'\vbox{\hsize=90pt\noindent A small \loompart{phrase}{paragraph with several ordinary words spanning more than one line} ends here.}', r'\vbox{\hsize=90pt\noindent A small paragraph with several ordinary words spanning more than one line ends here.}'),
 'operators': ('math', r'a\loompart{plus}{+}b\loompart{equal}{=}c\loompart{relation}{\leq}d', r'a+b=c\leq d'),
 'nested': ('math', r'\loompart{whole}{\loompart{first-x}{x}+\loompart{second-x}{x}}', r'x+x'),
 'macro': ('math', r'\loompart{field}{\RR}', r'\RR'),
}
BOX_CASES = {
 'box-x': (r'a+\loompartbox{x}{x}+b',r'a+x+b'),
 'box-phantom': (r'a+\loompartbox{ghost}{\phantom{x^2}}+b',r'a+\phantom{x^2}+b'),
 'box-styles': (r'a^{\loompartbox{sup}{x_{\loompartbox{sub}{i}}}}+\loompartbox{frac}{\frac{x+1}{x-1}}',r'a^{x_i}+\frac{x+1}{x-1}'),
}
BOX_REFERENCES = {'measure-x':r'x','measure-ghost':r'\phantom{x^2}',
                  'measure-sup':r'\scriptstyle x_i','measure-sub':r'\scriptscriptstyle i',
                  'measure-frac':r'\frac{x+1}{x-1}'}


def document(body, setup=r'\newcommand{\RR}{\mathbb{R}}'):
    return ('\\documentclass{article}\n\\usepackage{texloom,texloom-math}\n\\begin{document}\n'
            '\\TLScene{Semantic parts}{500}{300}{2}\n'+
            ('\\TLSetup{'+setup+'}\n' if setup else '')+body+'\n\\end{document}\n')


def declaration(kind, name, body):
    return ('\\TLMath' if kind=='math' else '\\TLText')+'{'+name+'}{'+body+'}\n'


def resolve(resource, address):
    items=resource['items']
    for index in address:
        item=items[index]
        items=item.get('children',[])
    return item


def source_slice(text,span):
    lines=text.splitlines(keepends=True)
    def offset(position):
        return sum(len(line) for line in lines[:position['line']-1])+position['column']-1
    return text[offset(span['start']):offset(span['end'])]


class TextPartsCompilerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.folder=Path(cls.temp.name)
        declarations=''.join(declaration(kind,name,marked)+declaration(kind,name+'-bare',bare)
                             for name,(kind,marked,bare) in CASES.items())
        declarations+=''.join(declaration('math',name,marked)+declaration('math',name+'-bare',bare)
                              for name,(marked,bare) in BOX_CASES.items())
        declarations+=''.join(declaration('math',name,body) for name,body in BOX_REFERENCES.items())
        cls.source=cls.folder/'corpus.tex'
        cls.source.write_text(document(declarations),encoding='utf8')
        cls.output=cls.folder/'corpus'
        cls.bundle=compile_scene(cls.source,cls.output)

    def compile(self,name,body,setup=r'\newcommand{\RR}{\mathbb{R}}'):
        source=self.folder/(name+'.tex')
        source.write_text(document(body,setup),encoding='utf8')
        output=self.folder/name
        return output,compile_scene(source,output)

    def assert_archived_diagnostic(self,error,name):
        span=getattr(error,'sourceSpan',None)
        self.assertIsInstance(span,dict,'Semantic compile failures need a truthful archived source location')
        archived=self.folder/name/span['file']
        self.assertTrue(archived.is_file(),span)
        text=archived.read_text(encoding='utf8')
        self.assertGreaterEqual(span['start']['line'],1)
        self.assertGreaterEqual(span['start']['column'],1)
        self.assertTrue(source_slice(text,span),'Failure span should identify the relevant nonempty authored text')

    def test_native_metrics_outlines_world_positions_and_line_breaks_are_unchanged(self):
        for name in CASES:
            with self.subTest(name=name):
                marked=self.bundle['resources'][name]
                bare=self.bundle['resources'][name+'-bare']
                difference=layout_difference(bare,marked)
                self.assertLessEqual(difference['maximumPaintCoordinateDifferenceBp'],2e-6)
                self.assertLessEqual(difference['maximumInkBoundsDifferenceBp'],2e-6)
                self.assertTrue(marked['textParts']['parts'])
                self.assertNotIn('textParts',bare)
        paragraph=self.bundle['resources']['paragraph']
        self.assertGreater(paragraph['metrics']['height'],50)

    def test_body_source_ranges_direct_ownership_and_leaf_addresses(self):
        for name in CASES:
            with self.subTest(name=name):
                resource=self.bundle['resources'][name]
                parts=resource['textParts']['parts']
                self.assertEqual(resource['textParts']['version'],1)
                self.assertEqual(len({part['id'] for part in parts}),len(parts))
                occupied=set()
                for part in parts:
                    bounds=part['sourceRange']
                    self.assertGreaterEqual(bounds['start'],0)
                    self.assertLessEqual(bounds['end'],len(resource['sourceTex']))
                    self.assertNotIn('logicalBox',part,'Transparent ranges cannot claim unmeasured TeX height/depth')
                    for address in part['paintPaths']:
                        self.assertEqual(resolve(resource,address)['kind'],'path')
                        self.assertNotIn(tuple(address),occupied)
                        occupied.add(tuple(address))
        repeated=self.bundle['resources']['repeated']
        parts={part['id']:part for part in repeated['textParts']['parts']}
        for name in ('first-x','second-x'):
            bounds=parts[name]['sourceRange']
            self.assertEqual(repeated['sourceTex'][bounds['start']:bounds['end']],'x')
        self.assertNotEqual(parts['first-x']['sourceRange'],parts['second-x']['sourceRange'])
        self.assertTrue(parts['first-x']['paintPaths'])
        self.assertTrue(parts['second-x']['paintPaths'])
        self.assertTrue(set(map(tuple,parts['first-x']['paintPaths'])).isdisjoint(map(tuple,parts['second-x']['paintPaths'])))
        nested={part['id']:part for part in self.bundle['resources']['nested']['textParts']['parts']}
        self.assertEqual(nested['first-x']['parent'],'whole')
        self.assertEqual(nested['second-x']['parent'],'whole')
        self.assertTrue(nested['whole']['paintPaths'],'Parent owns its plus sign directly')

    def test_empty_and_phantom_keep_identity_without_fabricated_ink_or_logical_box(self):
        for name,partid in [('empty','empty'),('phantom','blank')]:
            resource=self.bundle['resources'][name]
            part=next(p for p in resource['textParts']['parts'] if p['id']==partid)
            self.assertEqual(part['paintPaths'],[])
            self.assertNotIn('logicalBox',part)
        phantom=self.bundle['resources']['phantom']
        self.assertGreater(phantom['metrics']['height'],10)

    def test_opt_in_atomic_boxes_measure_native_math_styles_and_phantom_logical_extent(self):
        for name in BOX_CASES:
            difference=layout_difference(self.bundle['resources'][name+'-bare'],self.bundle['resources'][name])
            self.assertLessEqual(difference['maximumPaintCoordinateDifferenceBp'],2e-6)
            self.assertLessEqual(difference['maximumInkBoundsDifferenceBp'],2e-6)
        for resource_id,part_id in [('box-x','x'),('box-phantom','ghost'),('box-styles','sup'),('box-styles','sub'),('box-styles','frac')]:
            resource=self.bundle['resources'][resource_id]
            part=next(p for p in resource['textParts']['parts'] if p['id']==part_id)
            native=self.bundle['resources']['measure-'+part_id]['metrics']
            logical=part['logicalBox']
            self.assertAlmostEqual(logical[2],native['width'],delta=2e-7)
            self.assertAlmostEqual(logical[3],native['height']+native['depth'],delta=2e-7)
            if part_id in ('x','ghost'):
                self.assertAlmostEqual(logical[1],-native['height'],delta=2e-6)
            if part_id=='ghost':
                self.assertEqual(part['paintPaths'],[])
                self.assertGreater(logical[2],0)
                self.assertGreater(logical[3],0)

    def test_source_ranges_and_paint_addresses_are_deterministic(self):
        _,again=self.compile('repeated-again',declaration('math','repeated',CASES['repeated'][1]))
        expected=self.bundle['resources']['repeated']
        actual=again['resources']['repeated']
        def identity(resource):
            return [{key:part[key] for key in ('id','parent','sourceRange','paintPaths') if key in part}
                    for part in resource['textParts']['parts']]
        self.assertEqual(identity(expected),identity(actual))
        self.assertEqual(layout_difference(expected,actual)['maximumPaintCoordinateDifferenceBp'],0)
        precision=actual['provenance']['textPartsValidation']['sourcePrecision']
        self.assertEqual(set(precision.values()),{'original-literal'})
        for part in actual['textParts']['parts']:
            span=part['sourceSpan']
            archived=self.folder/'repeated-again'/span['file']
            self.assertEqual(source_slice(archived.read_text(encoding='utf8'),span),'x')

    def test_native_proof_and_source_precision_are_backed_by_archived_files(self):
        normalize=lambda s:re.sub(r'\\([A-Za-z@]+)\s+',r'\\\1',s).strip()
        for name in (*CASES,*BOX_CASES):
            with self.subTest(name=name):
                resource=self.bundle['resources'][name]
                proof=resource['provenance']['textPartsValidation']
                self.assertTrue(proof['metricsExact'])
                self.assertLessEqual(proof['maxCoordinateDifferenceBp'],2e-6)
                self.assertLessEqual(proof['maxInkBoundsDifferenceBp'],2e-6)
                self.assertEqual(proof['toleranceBp'],2e-6)
                native=(self.output/resource['provenance']['dvi']).parent/'native'
                for key,filename in [('nativeDviSha256','asset.dvi'),('nativeSvgSha256','asset.svg')]:
                    self.assertEqual(proof[key],hashlib.sha256((native/filename).read_bytes()).hexdigest())
                generated=self.output/proof['generatedSource']
                self.assertEqual(generated.read_text(encoding='utf8'),resource['sourceTex'])
                for part in resource['textParts']['parts']:
                    precision=proof['sourcePrecision'][part['id']]
                    self.assertIn(precision,('original-literal','generated-asset'))
                    span=part['sourceSpan']
                    archived=self.output/span['file']
                    text=archived.read_text(encoding='utf8')
                    source=part['sourceRange']
                    body=resource['sourceTex'][source['start']:source['end']]
                    if precision=='generated-asset':
                        self.assertEqual(span['file'],proof['generatedSource'])
                        self.assertEqual(source_slice(text,span),body)
                    else:
                        self.assertEqual(text,self.source.read_text(encoding='utf8'))
                        self.assertEqual(normalize(source_slice(text,span)),normalize(body))

    def test_real_equal_symbols_select_by_identity_and_nested_overlap_is_explicit(self):
        script=r'''import {readFile} from 'node:fs/promises';import {build} from 'esbuild';
const code=await build({entryPoints:['src/index.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {selectTextParts}=await import('data:text/javascript;base64,'+Buffer.from(code.outputFiles[0].text).toString('base64'));
const b=JSON.parse(await readFile(process.argv[1],'utf8')),before=JSON.stringify(b);
const select=(name,ids,scope='descendants',overlap='error')=>selectTextParts(b.resources[name],{ids,scope,overlap});
const left=select('repeated',['first-x']),right=select('repeated',['second-x']),both=select('repeated',['second-x','first-x']);
const direct=select('nested',['whole'],'exact'),nested=select('nested',['whole']),dedup=select('nested',['whole','first-x'],'descendants','ancestor-wins');
let overlap;try{select('nested',['whole','first-x']);}catch(e){overlap=e.diagnostics.map(d=>d.code);}
const empty=select('empty',['empty']);
console.log(JSON.stringify({left,right,both,direct,nested,dedup,overlap,empty,immutable:Object.isFrozen(left)&&Object.isFrozen(left.items),unchanged:before===JSON.stringify(b)}));'''
        result=subprocess.run(['node','--input-type=module','-e',script,str(self.output/'bundle.json')],cwd=ROOT,
                              capture_output=True,text=True,encoding='utf8',errors='replace')
        self.assertEqual(result.returncode,0,result.stderr[-10000:])
        selected=json.loads(result.stdout)
        self.assertTrue(selected['immutable'])
        self.assertTrue(selected['unchanged'])
        self.assertEqual(selected['left']['partIds'],['first-x'])
        self.assertEqual(selected['right']['partIds'],['second-x'])
        self.assertEqual(len(selected['left']['leaves']),1)
        self.assertEqual(len(selected['right']['leaves']),1)
        left=paint_leaves({'items':selected['left']['items']})[0]['outline']
        right=paint_leaves({'items':selected['right']['items']})[0]['outline']
        dx=right[0][1]-left[0][1]
        self.assertGreater(dx,5)
        self.assertEqual(len(left),len(right))
        for a,b in zip(left,right):
            self.assertEqual(a[0],b[0])
            for i in range(1,len(a)):
                self.assertAlmostEqual(b[i]-a[i],dx if i%2 else 0,delta=2e-6)
        self.assertEqual([leaf['partId'] for leaf in selected['both']['leaves']],['first-x','second-x'])
        self.assertEqual(len(selected['direct']['leaves']),1)
        self.assertEqual(len(selected['nested']['leaves']),3)
        self.assertEqual(selected['nested']['items'],selected['dedup']['items'])
        self.assertIn('TEXT_PART_OVERLAP',selected['overlap'])
        self.assertEqual(selected['empty']['items'],[])
        self.assertEqual(selected['empty']['partIds'],['empty'])

    def test_unsafe_ligature_and_operator_limits_fail_instead_of_publishing_changed_layout(self):
        cases=[('ligature','text',r'f\loompart{i}{i} ffi office'),
               ('operator-limits','math',r'\loompart{sum}{\sum}_{i=1}^n'),
               ('boxed-operator','math',r'a\loompartbox{plus}{+}b')]
        for name,kind,body in cases:
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError,r'TEXT_PART|layout|metrics|preserv') as raised:
                    self.compile(name,declaration(kind,'bad',body))
                self.assert_archived_diagnostic(raised.exception,name)
                self.assertFalse((self.folder/name/'bundle.json').exists())

    def test_suppressed_macro_generated_and_duplicate_parts_are_rejected(self):
        cases=[('suppressed-phantom',r'\phantom{\loompart{lost}{x}}+y',''),
               ('unused-mathchoice',r'\mathchoice{\loompart{display}{D}}{\loompart{text}{T}}{S}{s}',''),
               ('duplicate',r'\loompart{x}{x}+\loompart{x}{x}',''),
               ('macro-generated',r'\Generated',r'\newcommand{\Generated}{\loompart{hidden}{x}}')]
        for name,body,setup in cases:
            with self.subTest(name=name):
                with self.assertRaisesRegex(ValueError,r'TEXT_PART|part|marker') as raised:
                    self.compile(name,declaration('math','bad',body),setup)
                self.assert_archived_diagnostic(raised.exception,name)
                self.assertFalse((self.folder/name/'bundle.json').exists())


class PaintOracleTests(unittest.TestCase):
    def test_normalization_accounts_for_path_syntax_and_affine_coordinates(self):
        self.assertEqual(outline('M0 0h3v2z',[2,0,0,3,5,7]),[('M',5,7),('L',11,7),('L',11,13),('Z',)])
        self.assertEqual(outline('M0 0q3 6 6 0',[1,0,0,1,0,0]),[('M',0,0),('C',2,4,4,4,6,0)])
        bare={'items':[{'kind':'path','d':'M5 7L11 7L11 13Z'}]}
        nested={'items':[{'kind':'group','transform':[2,0,0,3,5,7],'children':[{'kind':'path','d':'M0 0h3v2z'}]}]}
        self.assertEqual(maximum_difference(paint_leaves(bare),paint_leaves(nested)),0)
        moved=copy.deepcopy(nested)
        moved['items'][0]['transform'][4]+=.01
        self.assertAlmostEqual(maximum_difference(paint_leaves(bare),paint_leaves(moved)),.01)


if __name__=='__main__':
    unittest.main()
