"""Literal range/source diagnostics independent of TeX execution."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from text_parts_capture import parse_text_parts, TextPartCaptureDiagnostic


class TextPartsCaptureTests(unittest.TestCase):
    def parse(self, source):
        return parse_text_parts(source, 'math-sources/example.tex')

    def test_nested_body_ranges_count_codepoints_and_preserve_comments(self):
        source = 'α😀\n' + r'\loompart{outer}{x_{\loompartbox{inner}{i}} % } ignored' + '\n+1}'
        outer, inner = self.parse(source)
        self.assertEqual(outer['sourceRange']['start'], source.index('x_'))
        self.assertEqual(source[outer['sourceRange']['start']:outer['sourceRange']['end']],
                         r'x_{\loompartbox{inner}{i}} % } ignored' + '\n+1')
        self.assertEqual(source[inner['sourceRange']['start']:inner['sourceRange']['end']], 'i')
        self.assertEqual(inner['parent'], 'outer')
        self.assertEqual(outer['sourceSpan']['start'], {'line': 2, 'column': 18})
        self.assertEqual(outer['sourceSpan']['end'], {'line': 3, 'column': 3})

    def test_comments_escapes_and_verbatim_do_not_create_declarations(self):
        source = (r'% \loompart{comment}{x}' + '\n' + r'\\loompart{escaped}{x} '
                  + r'\verb|\loompart{literal}{x}| \verb*+\loompart{star}{x}+'
                  + '\n' + r'\loompart % between args' + '\n{real}% second gap\n'
                  + r'{\{x\}\%}')
        parts = self.parse(source)
        self.assertEqual([part['id'] for part in parts], ['real'])
        span = parts[0]['sourceRange']
        self.assertEqual(source[span['start']:span['end']], r'\{x\}\%')

    def test_empty_body_and_atomic_math_macro(self):
        source = r'\loompart{empty}{} + \loompartbox{whole}{\ordinarymacro{x}}'
        empty, whole = self.parse(source)
        self.assertEqual(empty['sourceRange']['start'], empty['sourceRange']['end'])
        self.assertEqual(source[whole['sourceRange']['start']:whole['sourceRange']['end']], r'\ordinarymacro{x}')

    def test_duplicate_dynamic_and_invalid_identifiers_fail_with_source(self):
        for source in (r'\loompart{x}{1}\loompart{x}{2}', r'\loompart{\name}{x}',
                       r'\loompart{ leading}{x}', r'\loompart{bad\"id}{x}'):
            with self.subTest(source=source), self.assertRaises(TextPartCaptureDiagnostic) as caught:
                self.parse(source)
            self.assertEqual(caught.exception.code, 'TEXT_PART_ID')
            self.assertEqual(caught.exception.sourceSpan['file'], 'math-sources/example.tex')

    def test_missing_or_unbalanced_arguments_fail(self):
        for source in (r'\loompart x{x}', r'\loompart{x}x', r'\loompart{x}{x', r'\loompart{x}'):
            with self.subTest(source=source), self.assertRaises(TextPartCaptureDiagnostic) as caught:
                self.parse(source)
            self.assertEqual(caught.exception.code, 'TEXT_PART_SOURCE')

    def test_catcode_and_verbatim_contexts_are_explicitly_unsupported(self):
        for prefix in (r'\catcode`\%=12 ', r'\ExplSyntaxOn ',
                       '\\begin{verbatim}\n\\loompart{fake}{x}\n\\end{verbatim}\n'):
            with self.subTest(prefix=prefix), self.assertRaises(TextPartCaptureDiagnostic) as caught:
                self.parse(prefix + r'\loompart{x}{x}')
            self.assertEqual(caught.exception.code, 'TEXT_PART_SOURCE_SYNTAX')

    def test_unused_parser_and_depth_budget(self):
        self.assertEqual(self.parse(r'\ordinarymacro{x} + y'), [])
        source = 'x'
        for index in range(65):
            source = r'\loompart{p' + str(index) + '}{' + source + '}'
        with self.assertRaises(TextPartCaptureDiagnostic) as caught:
            self.parse(source)
        self.assertEqual(caught.exception.code, 'TEXT_PART_LIMIT')

    def test_measured_nesting_and_construction_work_have_separate_caps(self):
        source = 'x'
        for index in range(4):
            source = r'\loompartbox{p' + str(index) + '}{' + source + '}'
        self.assertEqual(len(self.parse(source)), 4)
        with self.assertRaises(TextPartCaptureDiagnostic) as caught:
            self.parse(r'\loompartbox{p4}{' + source + '}')
        self.assertEqual(caught.exception.code, 'TEXT_PART_LIMIT')
        siblings = ''.join(r'\loompartbox{p' + str(index) + '}{x}' for index in range(1024))
        self.assertEqual(len(self.parse(siblings)), 1024)
        with self.assertRaises(TextPartCaptureDiagnostic) as caught:
            self.parse(siblings + r'\loompartbox{overflow}{x}')
        self.assertEqual(caught.exception.code, 'TEXT_PART_LIMIT')


if __name__ == '__main__':
    unittest.main()
