"""Build a timeline AST from executed TeX declarations, without scheduling it.

The shared TypeScript compiler alone owns timing, duration, easing and property
ownership. Python preserves structure and literal values plus stable sources.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


class AnimationCaptureDiagnostic(ValueError):
    pass


def _read(execution: Path, base: str, field: str) -> tuple[str, Path]:
    if not isinstance(base, str) or not re.fullmatch(r'scene\.tl-animation-[1-9][0-9]*', base):
        raise AnimationCaptureDiagnostic('Invalid generated animation filename')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file():
        raise AnimationCaptureDiagnostic(f'Missing animation sidecar: {path.name}')
    text = path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text), path


def _json(text: str):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise AnimationCaptureDiagnostic(f'Duplicate JSON key in animation declaration: {key}')
            result[key] = value
        return result

    def nonfinite(value):
        raise AnimationCaptureDiagnostic(f'Animation declaration contains nonfinite JSON value {value}')

    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=nonfinite)
    except json.JSONDecodeError as error:
        raise AnimationCaptureDiagnostic(f'Invalid animation JSON: {error}') from error


def _span(text: str, path: Path, output: Path) -> dict:
    lines = text.split('\n')
    return {'file': path.relative_to(output).as_posix(), 'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}


def _archive(text: str, path: Path, output: Path) -> dict:
    folder = output / 'animation-sources'; folder.mkdir(parents=True, exist_ok=True)
    archived = folder / path.name; temporary = archived.with_suffix(archived.suffix + '.tmp')
    shutil.copyfile(path, temporary); temporary.replace(archived)
    return _span(text, archived, output)


def _finite_number(value) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _number(text: str, field: str) -> float:
    value = _json(text)
    if not _finite_number(value) or value < 0:
        raise AnimationCaptureDiagnostic(f'Animation {field} must be a finite nonnegative number of seconds')
    return value


def _options(text: str, allowed: set[str]) -> dict[str, str]:
    result = {}
    for entry in text.split(','):
        if not entry.strip():
            continue
        if '=' not in entry:
            raise AnimationCaptureDiagnostic(f'Animation option requires key=value: {entry.strip()}')
        key, value = (part.strip() for part in entry.split('=', 1))
        if key not in allowed:
            raise AnimationCaptureDiagnostic(f'Unknown animation option: {key}')
        if key in result:
            raise AnimationCaptureDiagnostic(f'Duplicate animation option: {key}')
        if not value:
            raise AnimationCaptureDiagnostic(f'Animation {key} must be nonempty')
        result[key] = value
    return result


def _value(value, field: str):
    if _finite_number(value) or isinstance(value, list) and len(value) >= 1 and all(_finite_number(item) for item in value):
        return value
    raise AnimationCaptureDiagnostic(f'Animation {field} must be a finite numeric scalar or vector')


def _finite_json(value) -> None:
    """Reject overflowed JSON numbers before passing nested policies to JS."""
    if isinstance(value, (int, float)) and not isinstance(value, bool) and not _finite_number(value):
        raise AnimationCaptureDiagnostic('Animation correspondence contains a nonfinite JSON number')
    if isinstance(value, dict):
        for item in value.values():
            _finite_json(item)
    elif isinstance(value, list):
        for item in value:
            _finite_json(item)


def _timing(node: dict, options: dict) -> None:
    node['duration'] = _number(options.get('duration', '1'), 'duration')
    if 'easing' in options:
        if options['easing'] not in ('linear', 'smooth', 'step'):
            raise AnimationCaptureDiagnostic('Animation easing must be linear, smooth or step')
        node['easing'] = options['easing']


def capture_animation(records: list[dict], execution: Path, output: Path) -> dict | None:
    """Preserve grouping and authored values; scheduling belongs to TypeScript."""
    declarations = [record for record in records if record['type'] == 'animation-file']
    if not declarations:
        return None
    program = None; stack = []; seen = set()
    for record in declarations:
        base = record.get('file', '')
        if not isinstance(base, str) or base in seen:
            raise AnimationCaptureDiagnostic(f'Duplicate or invalid animation declaration file: {base}')
        seen.add(base); captured = {}

        def read(field):
            text, path = _read(execution, base, field)
            captured[field] = _archive(text, path, output)
            return text

        def name(field):
            text = read(field).strip()
            if not text:
                raise AnimationCaptureDiagnostic(f'Animation {field} must be nonempty')
            return text

        kind = record.get('kind')
        if kind == 'begin':
            group = name('group')
            if group not in ('animation', 'sequence', 'parallel', 'stagger'):
                raise AnimationCaptureDiagnostic(f'Unknown animation group: {group}')
            options = _options(read('options'), {'id', 'origin'} if group == 'animation' else {'id'})
            node = {'kind': 'sequence' if group == 'animation' else group, 'children': [],
                    'sourceSpan': captured['options']}
            if 'id' in options:
                node['id'] = options['id']
            if group == 'stagger':
                node['lag'] = _number(read('lag'), 'lag')
                node['sourceSpan'] = captured['lag']
            if group == 'animation':
                if stack or program is not None:
                    raise AnimationCaptureDiagnostic('Exactly one top-level loomanimation environment is allowed')
                program = {'version': 1, 'root': node}
                if 'origin' in options:
                    program['origin'] = _number(options['origin'], 'origin')
            else:
                if not stack:
                    raise AnimationCaptureDiagnostic('Animation groups must be inside loomanimation')
                stack[-1][1]['children'].append(node)
            stack.append((group, node))
        elif kind == 'end':
            group = name('group')
            if not stack or stack[-1][0] != group:
                raise AnimationCaptureDiagnostic(f'Mismatched animation group end: {group}')
            stack.pop()
        else:
            if not stack:
                raise AnimationCaptureDiagnostic('Animation commands must be inside loomanimation')
            node = {'kind': kind}
            if kind == 'wait':
                node['duration'] = _number(read('duration'), 'duration')
                node['sourceSpan'] = captured['duration']
            elif kind == 'cue':
                node['name'] = name('name'); node['sourceSpan'] = captured['name']
            elif kind in ('tween', 'set'):
                options = _options(read('options'), {'id', 'duration', 'easing'} if kind == 'tween' else {'id'})
                node['target'] = name('target'); node['property'] = name('property')
                if 'id' in options:
                    node['id'] = options['id']
                if kind == 'tween':
                    values = _json(read('values'))
                    if not isinstance(values, dict) or set(values) - {'from', 'to'} or 'to' not in values:
                        raise AnimationCaptureDiagnostic('Tween values require to and optional from only')
                    node['duration'] = _number(options.get('duration', '1'), 'duration')
                    for key, value in values.items():
                        node[key] = _value(value, key)
                    if 'easing' in options:
                        if options['easing'] not in ('linear', 'smooth', 'step'):
                            raise AnimationCaptureDiagnostic('Tween easing must be linear, smooth or step')
                        node['easing'] = options['easing']
                    node['sourceSpan'] = captured['values']
                else:
                    node['value'] = _value(_json(read('value')), 'value')
                    node['sourceSpan'] = captured['value']
            elif kind in ('morph', 'math-transform', 'clone', 'enter', 'exit'):
                allowed = {'id'} if kind == 'clone' else {'id', 'duration', 'easing'}
                if kind in ('enter', 'exit'):
                    allowed.add('mode')
                options = _options(read('options'), allowed)
                if kind in ('morph', 'math-transform', 'clone') and 'id' not in options:
                    raise AnimationCaptureDiagnostic(f'Animation {kind} requires an explicit instance id')
                if 'id' in options:
                    node['id'] = options['id']
                if kind != 'clone':
                    _timing(node, options)
                if kind in ('morph', 'math-transform', 'clone'):
                    node['source'] = name('source')
                    if kind in ('morph', 'math-transform'):
                        node['destination'] = name('destination')
                        correspondence = _json(read('correspondence'))
                        if not isinstance(correspondence, dict):
                            raise AnimationCaptureDiagnostic(f'Animation {kind} correspondence must be a JSON object')
                        _finite_json(correspondence)
                        node['correspondence'] = correspondence
                        node['sourceSpan'] = captured['correspondence']
                    else:
                        node['sourceSpan'] = captured['source']
                else:
                    node['target'] = name('target')
                    if 'mode' in options:
                        if options['mode'] not in ('fade', 'create'):
                            raise AnimationCaptureDiagnostic('Animation mode must be fade or create')
                        node['mode'] = options['mode']
                    node['sourceSpan'] = captured['options']
            else:
                raise AnimationCaptureDiagnostic(f'Unknown animation declaration kind: {kind}')
            stack[-1][1]['children'].append(node)
    if stack:
        raise AnimationCaptureDiagnostic(f'Unclosed animation group: {stack[-1][0]}')
    if program is None:
        raise AnimationCaptureDiagnostic('Exactly one top-level loomanimation environment is required')
    return program


def lower_animation(records: list[dict], bundle: dict, execution: Path, output: Path) -> None:
    program = capture_animation(records, execution, output)
    if program is None:
        return
    if 'timeline' in bundle:
        raise AnimationCaptureDiagnostic('Timeline metadata already exists in this bundle')
    source = output / 'animation-sources' / 'program.json'
    temporary = source.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(program, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    temporary.replace(source)
    # Temporary input/output files are owned by this invocation. The authored
    # AST is archived above; no Python clock or keyframe scheduling is duplicated.
    with tempfile.TemporaryDirectory(prefix='animation-', dir=output) as folder:
        folder = Path(folder); candidate = folder / 'bundle.json'; lowered = folder / 'lowered.json'
        candidate.write_text(json.dumps({**bundle, 'version': '0.3'}, ensure_ascii=False) + '\n', encoding='utf8')
        process = subprocess.run(['node', str(ROOT / 'tools/compile-timeline.mjs'), str(candidate), str(source), str(lowered)],
                                 cwd=ROOT, capture_output=True, text=True, encoding='utf8', errors='replace', timeout=120)
        if process.returncode:
            raise AnimationCaptureDiagnostic('Shared timeline compiler rejected the animation: ' +
                                             (process.stderr.strip() or process.stdout.strip()))
        if not lowered.is_file():
            raise AnimationCaptureDiagnostic('Shared timeline compiler did not produce its bundle output')
        result = _json(lowered.read_text(encoding='utf8'))
        if not isinstance(result, dict) or not isinstance(result.get('timeline'), dict):
            raise AnimationCaptureDiagnostic('Shared timeline compiler returned an invalid bundle')
        bundle.clear(); bundle.update(result)
