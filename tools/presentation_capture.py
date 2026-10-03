"""Capture literal presentation intent; the shared IR validator owns its semantics."""
from pathlib import Path
import json
import re


def lower_presentation(records, bundle, execution, output):
    declarations = [r for r in records if r.get('type') == 'presentation-file']
    if not declarations:
        return
    if len(declarations) != 1:
        raise ValueError('PRESENTATION_DECLARATION: declare one presentation program per scene')
    name = declarations[0].get('file')
    if not isinstance(name, str) or not re.fullmatch(r'scene\.tl-presentation-[1-9][0-9]*', name):
        raise ValueError('PRESENTATION_CAPTURE: invalid generated filename')
    path = Path(execution) / (name + '.program.txt')
    if path.stat().st_size > 2_000_000:
        raise ValueError('PRESENTATION_BUDGET: capture exceeds 2 MB')
    text = path.read_text(encoding='utf8')

    def pairs(values):
        result = {}
        for key, value in values:
            if key in result:
                raise ValueError(f'PRESENTATION_CAPTURE: duplicate JSON key {key}')
            result[key] = value
        return result

    def nonfinite(value):
        raise ValueError(f'PRESENTATION_CAPTURE: nonfinite JSON value {value}')

    program = json.loads(text, object_pairs_hook=pairs, parse_constant=nonfinite)
    archive = Path(output) / 'presentation-sources' / 'program.json'
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.write_text(text, encoding='utf8', newline='\n')
    lines = text.rstrip('\n').split('\n')
    span = {'file': archive.relative_to(output).as_posix(), 'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}
    if isinstance(program, dict) and isinstance(program.get('events'), list):
        for event in program['events']:
            if isinstance(event, dict):
                event.setdefault('sourceSpan', span)
    bundle['version'] = '0.3'
    bundle['presentation'] = program
