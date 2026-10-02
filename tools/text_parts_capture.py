"""Literal semantic-part declarations; native TeX still owns all typesetting.

This scanner does not expand macros or infer mathematical meaning. The SVG
importer must match every declaration to its emitted marker by ID and parent,
and the compiler must compare the marked asset with its native bare baseline.
"""
from __future__ import annotations

from pathlib import Path
import re

_PACKAGE = (Path(__file__).resolve().parents[1] / 'tex' / 'texloom-math.sty').read_text(encoding='utf8')
PART_PREAMBLE = _PACKAGE.split('% BEGIN TEXLOOM PART PREAMBLE\n', 1)[1].split('% END TEXLOOM PART PREAMBLE', 1)[0]
BARE_PART_PREAMBLE = r'\long\def\loompart#1#2{#2}' + '\n' + r'\long\def\loompartbox#1#2{#2}' + '\n'
PART_COMMANDS = frozenset(('loompart', 'loompartbox'))
PART_ID = re.compile(r'[A-Za-z][A-Za-z0-9_.:-]{0,255}\Z')
MAX_PARTS = 4096
MAX_PART_DEPTH = 64
MAX_MEASURED_DEPTH = 4
MAX_MEASURED_WORK = 4096


class TextPartCaptureDiagnostic(ValueError):
    """A source-located, stable-code failure in the literal authoring layer."""

    def __init__(self, code: str, message: str, source_span: dict | None = None):
        super().__init__(f'{code}: {message}')
        self.code = code
        self.message = message
        self.sourceSpan = source_span


def _position(source: str, offset: int) -> dict:
    return {'line': source.count('\n', 0, offset) + 1,
            'column': offset - source.rfind('\n', 0, offset)}


def _span(source: str, path: str, start: int, end: int) -> dict:
    return {'file': path, 'start': _position(source, start), 'end': _position(source, end)}


def parse_text_parts(source_tex: str, source_path: str) -> list[dict]:
    """Return parts in literal order with exact BODY source ranges.

    Offsets and columns count Unicode code points, with exclusive ends. The
    caller archives exactly ``source_tex`` at ``source_path``. Spaces/comments
    between arguments are accepted; IDs themselves must be literal ASCII. TeX
    escaped braces/percent signs and ``\\verb`` literals are not syntax. This
    deliberately handles standard TeX catcodes only, without macro expansion.
    """
    if not isinstance(source_tex, str) or not isinstance(source_path, str) or not source_path:
        raise TextPartCaptureDiagnostic('TEXT_PART_SOURCE', 'Expected TeX source and its archive path.')
    result: list[dict] = []
    ids: set[str] = set()
    unsupported: list[tuple[int, str]] = []
    measured_work = 0
    size = len(source_tex)

    def fail(code: str, message: str, start: int, end: int | None = None):
        raise TextPartCaptureDiagnostic(code, message, _span(source_tex, source_path, start, min(size, end if end is not None else start + 1)))

    def comment_end(at: int, stop: int) -> int:
        end = source_tex.find('\n', at, stop)
        return stop if end < 0 else end + 1

    def whitespace(at: int, stop: int) -> int:
        while at < stop:
            if source_tex[at].isspace():
                at += 1
            elif source_tex[at] == '%':
                at = comment_end(at, stop)
            else:
                break
        return at

    def command(at: int, stop: int) -> tuple[str, int]:
        end = at + 1
        if end >= stop:
            return '', end
        if source_tex[end].isascii() and (source_tex[end].isalpha() or source_tex[end] == '@'):
            end += 1
            while end < stop and source_tex[end].isascii() and (source_tex[end].isalpha() or source_tex[end] == '@'):
                end += 1
            return source_tex[at + 1:end], end
        return source_tex[end], end + 1

    def verb_end(at: int, stop: int) -> int:
        if at < stop and source_tex[at] == '*':
            at += 1
        if at >= stop or source_tex[at].isspace():
            return at
        end = source_tex.find(source_tex[at], at + 1, stop)
        return stop if end < 0 else end + 1

    def group(at: int, stop: int, field: str) -> tuple[int, int, int]:
        at = whitespace(at, stop)
        if at >= stop or source_tex[at] != '{':
            fail('TEXT_PART_SOURCE', f'Semantic part {field} requires a literal braced argument.', at)
        start = at + 1
        depth = 1
        at = start
        while at < stop:
            char = source_tex[at]
            if char == '%':
                at = comment_end(at, stop)
                continue
            if char == '\\':
                name, at = command(at, stop)
                if name == 'verb':
                    at = verb_end(at, stop)
                continue
            if char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
                if depth == 0:
                    return start, at, at + 1
            at += 1
        fail('TEXT_PART_SOURCE', f'Unclosed semantic part {field} argument.', start - 1, stop)

    def scan(start: int, stop: int, parent: str | None, depth: int, measured_depth: int) -> None:
        nonlocal measured_work
        at = start
        while at < stop:
            if source_tex[at] == '%':
                at = comment_end(at, stop)
                continue
            if source_tex[at] != '\\':
                at += 1
                continue
            begin = at
            name, at = command(at, stop)
            if name == 'verb':
                at = verb_end(at, stop)
                continue
            if name in ('catcode', 'catcodetable', 'scantokens', 'ExplSyntaxOn', 'obeylines', 'obeyspaces'):
                unsupported.append((begin, '\\' + name))
            if name == 'begin':
                match = re.match(r'\s*\{(verbatim\*?|Verbatim\*?|lstlisting|minted)\}', source_tex[at:stop])
                if match:
                    environment = match.group(1)
                    unsupported.append((begin, environment + ' environment'))
                    closing = source_tex.find('\\end{' + environment + '}', at + match.end(), stop)
                    at = stop if closing < 0 else closing + len(environment) + 6
                    continue
            if name not in PART_COMMANDS:
                continue
            id_start, id_end, at = group(at, stop, 'ID')
            part_id = source_tex[id_start:id_end]
            if not PART_ID.fullmatch(part_id):
                fail('TEXT_PART_ID', 'Part IDs must match [A-Za-z][A-Za-z0-9_.:-]{0,255}; expansion is not supported.', id_start, id_end)
            if part_id in ids:
                fail('TEXT_PART_ID', f'Duplicate semantic part ID {part_id}.', id_start, id_end)
            if len(result) >= MAX_PARTS or depth >= MAX_PART_DEPTH:
                fail('TEXT_PART_LIMIT', 'Semantic parts exceed 4096 declarations or 64 nested parts.', begin, at)
            next_measured_depth = measured_depth + (1 if name == 'loompartbox' else 0)
            # Mathchoice constructs all four styles before selecting one. Bound
            # authored worst-case construction work, including transparent
            # markers inside measured bodies, without guessing math context.
            measured_work += 4 ** next_measured_depth
            if next_measured_depth > MAX_MEASURED_DEPTH or measured_work > MAX_MEASURED_WORK:
                fail('TEXT_PART_LIMIT', 'Measured parts exceed 4 nested boxes or 4096 estimated mathchoice constructions.', begin, at)
            body_start, body_end, at = group(at, stop, 'body')
            ids.add(part_id)
            part = {'id': part_id, 'sourceRange': {'start': body_start, 'end': body_end},
                    'sourceSpan': _span(source_tex, source_path, body_start, body_end)}
            if parent is not None:
                part['parent'] = parent
            result.append(part)
            scan(body_start, body_end, part_id, depth + 1, next_measured_depth)

    scan(0, size, None, 0, 0)
    if result and unsupported:
        offset, construct = unsupported[0]
        fail('TEXT_PART_SOURCE_SYNTAX', f'Semantic part source does not support {construct}; use ordinary setup macros inside an atomic part.', offset)
    return result
