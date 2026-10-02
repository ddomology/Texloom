"""Capture static semantic selections; selection semantics live in TypeScript."""
from __future__ import annotations

import json
from pathlib import Path
import re
import subprocess
import tempfile

from animation_capture import _json, _finite_json

ROOT = Path(__file__).resolve().parents[1]


class TextPartViewDiagnostic(ValueError):
    code = 'TEXT_PART_VIEW'


def capture_part_views(records, execution, output):
    views = []
    seen = set()
    for record in records:
        if record['type'] != 'part-view-file':
            continue
        base = record.get('file')
        if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-part-view-[1-9][0-9]*', base) or base in seen:
            raise TextPartViewDiagnostic('Invalid or duplicate generated part-view filename')
        seen.add(base)
        folder = output / 'math-sources' / 'views'
        folder.mkdir(parents=True, exist_ok=True)
        fields = {}
        for field in ('id', 'source', 'body'):
            source = execution / f'{base}.{field}.txt'
            text = source.read_text(encoding='utf8')
            if text.endswith('\n'):
                text = text[:-1]
            fields[field] = text
            (folder / source.name).write_text(text, encoding='utf8')
        body = _json(fields['body'])
        _finite_json(body)
        if not isinstance(body, dict) or set(body) - {'query', 'style'} or 'query' not in body:
            raise TextPartViewDiagnostic('Part-view body requires query and optional style only')
        lines = fields['body'].split('\n')
        span = {'file': (folder / f'{base}.body.txt').relative_to(output).as_posix(),
                'start': {'line': 1, 'column': 1},
                'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}
        views.append({'id': fields['id'].strip(), 'sourceId': fields['source'].strip(),
                      **body, 'sourceSpan': span})
    return views


def lower_part_views(records, bundle, execution, output):
    views = capture_part_views(records, execution, output)
    if not views:
        return
    source = output / 'math-sources' / 'views' / 'program.json'
    source.write_text(json.dumps(views, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    with tempfile.TemporaryDirectory(prefix='part-views-', dir=output) as folder:
        folder = Path(folder)
        candidate, lowered = folder / 'bundle.json', folder / 'lowered.json'
        candidate.write_text(json.dumps({**bundle, 'version': '0.3'}, ensure_ascii=False), encoding='utf8')
        process = subprocess.run(['node', str(ROOT / 'tools/compile-text-part-views.mjs'),
                                  '--scene', str(candidate), '--views', str(source), '--out', str(lowered)],
                                 cwd=ROOT, capture_output=True, text=True, encoding='utf8', errors='replace', timeout=120)
        if process.returncode or not lowered.is_file():
            raise TextPartViewDiagnostic('Shared part-view compiler rejected the selection: ' +
                                         (process.stderr.strip() or process.stdout.strip()))
        result = _json(lowered.read_text(encoding='utf8'))
        bundle.clear()
        bundle.update(result)
