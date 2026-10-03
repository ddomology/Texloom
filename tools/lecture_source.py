"""Executed single-file lecture capture and revision-bound atomic source repair."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
MAX_SOURCE_BYTES = 2 * 1024 * 1024
MAX_CAPTURE_BYTES = 8 * 1024 * 1024
MAX_FIELD_BYTES = 256 * 1024
MAX_BLOCKS = 256
MAX_DEPENDENCY_BYTES = 128 * 1024 * 1024
MAX_DEPENDENCY_FILES = 4096
IDENTIFIER = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,127}')
RESERVED_IDENTIFIER = re.compile(r'(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])', re.IGNORECASE)
REVISION = re.compile(r'[0-9a-f]{64}')
KINDS = frozenset(('definition', 'theorem', 'lemma', 'corollary', 'proof', 'example', 'remark', 'explanation'))


class LectureSourceError(ValueError):
    def __init__(self, code, message, source_span=None):
        super().__init__(f'{code}: {message}')
        self.code, self.sourceSpan = code, source_span


def fail(code, message, span=None):
    raise LectureSourceError(code, message, span)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def _read(path, maximum):
    size = path.stat().st_size
    if size > maximum:
        fail('LECTURE_BUDGET', f'Input exceeds {maximum} bytes: {path.name}')
    with path.open('rb') as stream:
        data = stream.read(size + 1)
    if len(data) != size:
        fail('LECTURE_SOURCE_CHANGED', 'Source size changed during capture.')
    return data


def _text(raw):
    try:
        return raw.decode('utf8')
    except UnicodeError as error:
        raise LectureSourceError('LECTURE_UTF8', 'Expected UTF-8 source and capture files.') from error


def _save(path, data, mode=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if mode is not None:
            os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _json(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + '\n').encode('utf8')


def _line_column(text, offset):
    return {'line': text.count('\n', 0, offset) + 1, 'column': offset - text.rfind('\n', 0, offset)}


def _span(source, text, start=0, end=None, precision='document'):
    end = len(text) if end is None else end
    return {'file': source.name, 'start': _line_column(text, start), 'end': _line_column(text, end),
            'startOffset': start, 'endOffset': end, 'offsetUnit': 'unicode-code-point', 'precision': precision}


def _skip(text, pos):
    while pos < len(text):
        if text[pos].isspace():
            pos += 1
        elif text[pos] == '%':
            newline = text.find('\n', pos)
            pos = len(text) if newline < 0 else newline + 1
        else:
            break
    return pos


def _group(text, pos):
    pos = _skip(text, pos)
    if pos >= len(text) or text[pos] != '{':
        return None
    start, pos, depth = pos + 1, pos + 1, 1
    while pos < len(text):
        char = text[pos]
        if char == '\\':
            pos += 2
            continue
        if char == '%':
            newline = text.find('\n', pos)
            pos = len(text) if newline < 0 else newline + 1
            continue
        if char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                return text[start:pos], pos + 1
        pos += 1
    return None


def _literal_blocks(text):
    """Locate top-level literal wrappers, never expand or execute TeX semantics.

    A location is used only when executed capture and physical ending line agree.
    Macro-generated or ambiguous calls fall back to the complete source range.
    """
    found, pos, depth = [], 0, 0
    while pos < len(text):
        if text[pos] == '%':
            pos = _skip(text, pos)
            continue
        if text[pos] == '\\':
            start = pos
            pos += 1
            end = pos
            while end < len(text) and (text[end].isalpha() or text[end] == '@'):
                end += 1
            name = text[pos:end]
            pos = end if end != pos else min(pos + 1, len(text))
            if name == 'loomblock' and depth == 0:
                args, cursor = [], pos
                for _ in range(5):
                    group = _group(text, cursor)
                    if group is None:
                        break
                    arg, cursor = group
                    args.append(arg)
                if len(args) == 5:
                    found.append({'start': start, 'end': cursor, 'args': args,
                                  'line': _line_column(text, cursor)['line']})
                    pos = cursor
            continue
        if text[pos] == '{':
            depth += 1
        elif text[pos] == '}':
            depth = max(depth - 1, 0)
        pos += 1
    return found


def _normal_tokens(text):
    # Compare default-catcode literal token spelling, including detokenize's
    # trailing spaces after control words. This is only a conservative locator.
    result, pos, space = [], 0, False
    while pos < len(text):
        c = text[pos]
        if c == '%':
            newline = text.find('\n', pos)
            pos = len(text) if newline < 0 else newline + 1
            continue
        if c == '\\':
            if space and result:
                result.append(' ')
            space = False
            end = pos + 1
            if end < len(text) and text[end].isalpha():
                while end < len(text) and text[end].isalpha():
                    end += 1
                result.append(text[pos:end])
                pos = end
                while pos < len(text) and text[pos].isspace():
                    pos += 1
            else:
                result.append(text[pos:min(pos + 2, len(text))])
                pos += 2
            continue
        if c.isspace():
            space = True
        else:
            if space and result:
                result.append(' ')
            space = False
            result.append(c)
        pos += 1
    # Keep control-word boundaries: ["\\alpha", "x"] must not compare equal
    # to the single control word ["\\alphax"].
    return tuple(result)


def _dependencies(execution, source, env):
    """Reject additional authored inputs; system TeX files remain toolchain data."""
    recorder = execution / 'notes.fls'
    if not recorder.is_file():
        fail('LECTURE_DEPENDENCY', 'TeX recorder output is required.')
    # TeX distribution search without the authored source directory. Resolve each
    # dependency using that clean environment, so arbitrary absolute includes do
    # not silently enter a source revision that hashes only one .tex file.
    clean = env.copy()
    clean.pop('TEXINPUTS', None)
    root_result = subprocess.run(['kpsewhich', '-var-value=TEXMFROOT'], cwd=execution, env=clean,
                                 capture_output=True, text=True, encoding='utf8', errors='replace', timeout=15)
    distribution_root = Path(root_result.stdout.strip()).resolve() if root_result.returncode == 0 and root_result.stdout.strip() else None
    checked = set()
    for line in recorder.read_text(encoding='utf8', errors='replace').splitlines():
        if not line.startswith('INPUT '):
            continue
        candidate = Path(line[6:])
        if not candidate.is_absolute():
            candidate = execution / candidate
        candidate = candidate.resolve()
        if candidate in checked or not candidate.is_file():
            continue
        checked.add(candidate)
        if candidate.is_relative_to(execution.resolve()) or candidate == (ROOT / 'tex/texloom-lecture.sty').resolve():
            continue
        if candidate.is_relative_to(source.parent.resolve()):
            fail('LECTURE_DEPENDENCY', f'Additional authored input is not supported by the single-file source contract: {candidate.name}')
        if distribution_root is not None and candidate.is_relative_to(distribution_root):
            continue
        args = ['kpsewhich', '-all']
        if candidate.suffix == '.fmt':
            args.extend(['-engine=pdftex', '-format=fmt'])
        result = subprocess.run([*args, candidate.name], cwd=execution, env=clean,
                                capture_output=True, text=True, encoding='utf8', errors='replace', timeout=15)
        resolved = result.stdout.strip().splitlines()
        if result.returncode or candidate not in {Path(item).resolve() for item in resolved}:
            fail('LECTURE_DEPENDENCY', f'Untracked input is not a resolved TeX toolchain file: {candidate.name}')


def scene_dependencies(source: Path, out: Path, package_root: Path | None = None) -> dict:
    """Hash authored inputs from the original compile's opt-in TeX recorders.

    This covers TeX reads, including generated paragraph/asset passes. Python
    scene producers read data separately; the harness additionally snapshots the
    bounded source package before and after compilation to cover those files.
    """
    source, out = Path(source).resolve(), Path(out).resolve()
    package_root = Path(package_root or source.parent).resolve()
    recorders = sorted((out / 'runs').glob('**/*.fls'))
    if not recorders or len(recorders) > MAX_DEPENDENCY_FILES:
        fail('LECTURE_DEPENDENCY', 'Expected bounded original TeX recorder files; compile with trace_inputs=True.')
    clean = os.environ.copy()
    clean.pop('TEXINPUTS', None)
    result = subprocess.run(['kpsewhich', '-var-value=TEXMFROOT'], cwd=out, env=clean,
                            capture_output=True, text=True, encoding='utf8', errors='replace', timeout=15)
    distribution = Path(result.stdout.strip()).resolve() if result.returncode == 0 and result.stdout.strip() else None
    # All fixed Texloom styles are tracked by the compiler/toolchain revision.
    texloom_styles = (ROOT / 'tex').resolve()
    dependencies, checked, total, recorder_bytes = {}, set(), 0, 0

    def remember(path):
        nonlocal total
        if str(path) in dependencies:
            return
        if len(dependencies) >= MAX_DEPENDENCY_FILES:
            fail('LECTURE_DEPENDENCY_BUDGET', 'Too many authored input files.')
        raw = _read(path, MAX_DEPENDENCY_BYTES - total)
        total += len(raw)
        dependencies[str(path)] = sha256(raw)

    remember(source)
    for recorder in recorders:
        if not recorder.resolve().is_relative_to(out):
            fail('LECTURE_DEPENDENCY', 'Recorder path leaves the compiled output.')
        raw = _read(recorder, MAX_CAPTURE_BYTES - recorder_bytes)
        recorder_bytes += len(raw)
        lines = _text(raw).splitlines()
        workdir = recorder.parent
        pwd = [line[4:] for line in lines if line.startswith('PWD ')]
        if pwd:
            if len(set(pwd)) != 1 or not Path(pwd[0]).is_absolute():
                fail('LECTURE_DEPENDENCY', 'Recorder has an ambiguous working directory.')
            workdir = Path(pwd[0]).resolve()
        if not workdir.is_relative_to(out):
            fail('LECTURE_DEPENDENCY', 'Recorder working directory leaves the compiled output.')
        for line in lines:
            if not line.startswith('INPUT '):
                continue
            path = Path(line[6:])
            path = (workdir / path).resolve() if not path.is_absolute() else path.resolve()
            if path in checked:
                continue
            checked.add(path)
            if not path.is_file():
                fail('LECTURE_DEPENDENCY', f'Recorded input no longer exists: {path}')
            # Generated captures/auxiliary files are immutable build artifacts,
            # not additional user dependencies. The original source is above.
            if path.is_relative_to(out) or path.is_relative_to(texloom_styles):
                continue
            if path.is_relative_to(package_root):
                remember(path)
                continue
            if distribution is not None and path.is_relative_to(distribution):
                continue
            args = ['kpsewhich', '-all']
            if path.suffix == '.fmt':
                args.extend(['-engine=pdftex', '-format=fmt'])
            resolved = subprocess.run([*args, path.name], cwd=out, env=clean, capture_output=True,
                                      text=True, encoding='utf8', errors='replace', timeout=15)
            if resolved.returncode == 0 and path in {Path(p).resolve() for p in resolved.stdout.strip().splitlines()}:
                continue
            fail('LECTURE_DEPENDENCY', f'Authored TeX input leaves the source package: {path}')
    return dependencies


def capture_lecture(source: Path, out: Path) -> dict:
    source, out = Path(source).resolve(), Path(out).resolve()
    if source.suffix.lower() != '.tex':
        fail('LECTURE_SOURCE_PATH', 'The single-file lecture source must be a .tex file.')
    raw = _read(source, MAX_SOURCE_BYTES)
    text = _text(raw)
    out.mkdir(parents=True, exist_ok=True)
    notes_path = out / 'notes.json'
    if notes_path.is_file():
        notes_path.unlink()
    execution = Path(tempfile.mkdtemp(prefix='lecture-capture-', dir=out))
    (execution / 'notes.tex').write_bytes(raw)
    env = os.environ.copy()
    env['TEXINPUTS'] = str(ROOT / 'tex') + os.pathsep + str(source.parent) + os.pathsep + env.get('TEXINPUTS', '')
    try:
        result = subprocess.run(['latex', '-no-shell-escape', '-recorder', '-interaction=nonstopmode', '-halt-on-error', 'notes.tex'],
                                cwd=execution, env=env, capture_output=True, text=True, encoding='utf8', errors='replace', timeout=60)
    except subprocess.TimeoutExpired as error:
        fail('LECTURE_TEX_TIMEOUT', 'Lecture capture exceeded 60 seconds.')
    _save(out / 'capture.log', (result.stdout + '\n' + result.stderr).encode('utf8'))
    if result.returncode:
        fail('LECTURE_TEX', (result.stdout + '\n' + result.stderr)[-6000:])
    _dependencies(execution, source, env)
    record_file = execution / 'notes.tl-lecture.jsonl'
    if not record_file.is_file():
        fail('LECTURE_CAPTURE', 'Missing texloom-lecture records.')
    try:
        records = [json.loads(line) for line in _text(_read(record_file, MAX_FIELD_BYTES)).splitlines() if line.strip()]
    except ValueError as error:
        raise LectureSourceError('LECTURE_CAPTURE', 'Invalid capture record JSON.') from error
    if len(records) > MAX_BLOCKS * 2 + 2:
        fail('LECTURE_BUDGET', 'Too many lecture declarations.')
    result = {'contract': 'texloom-notes/1', 'id': '', 'title': '', 'setup': '', 'blocks': [], 'scenes': [], 'sourceRevision': sha256(raw)}
    headers, setups, ids, files, total = 0, 0, set(), set(), 0
    portable_ids = set()
    literals = _literal_blocks(text)
    for record in records:
        if not isinstance(record, dict) or set(record) != {'type', 'file', 'line'} or type(record['line']) is not int or record['line'] < 1:
            fail('LECTURE_CAPTURE', 'Malformed declaration record.')
        base = record['file']
        if not isinstance(base, str) or not re.fullmatch(r'notes\.tl-lecture-[1-9][0-9]*', base) or base in files:
            fail('LECTURE_CAPTURE', 'Invalid or repeated generated sidecar name.')
        files.add(base)
        kind = record['type']
        fields = {'lecture': ('id', 'title'), 'setup': ('setup',), 'block': ('id', 'kind', 'title', 'tex', 'say'), 'scene': ('block', 'file', 'caption')}.get(kind)
        if fields is None:
            fail('LECTURE_CAPTURE', 'Unsupported declaration type.')
        values = {}
        for field in fields:
            path = execution / f'{base}.{field}.txt'
            if not path.is_file() or path.resolve().parent != execution.resolve():
                fail('LECTURE_CAPTURE', 'Missing or redirected field sidecar.')
            data = _read(path, MAX_FIELD_BYTES)
            total += len(data)
            if total > MAX_CAPTURE_BYTES:
                fail('LECTURE_BUDGET', 'Combined fields exceed 8 MiB.')
            value = _text(data).replace('\r\n', '\n')
            values[field] = (value[:-1] if value.endswith('\n') else value).replace('##', '#').strip()
            _save(out / 'lecture-sources' / path.name, data)
        if kind == 'lecture':
            headers += 1
            if headers != 1 or not IDENTIFIER.fullmatch(values['id']) or RESERVED_IDENTIFIER.fullmatch(values['id']) or not values['title']:
                fail('LECTURE_HEADER', 'Exactly one header with a safe ID and nonempty title is required.')
            result.update(values)
        elif kind == 'setup':
            setups += 1
            if setups != 1:
                fail('LECTURE_SETUP', 'At most one lecture setup declaration is allowed.')
            result['setup'] = values['setup']
        elif kind == 'block':
            if not IDENTIFIER.fullmatch(values['id']) or RESERVED_IDENTIFIER.fullmatch(values['id']) or values['id'].casefold() in portable_ids:
                fail('LECTURE_ID', 'Block IDs must be unique safe identifiers of at most 128 characters.')
            if values['kind'] not in KINDS or not values['tex'] or not values['say']:
                fail('LECTURE_BLOCK', 'Expected a known block kind and nonempty TeX and spoken text.')
            ids.add(values['id'])
            portable_ids.add(values['id'].casefold())
            matches = [item for item in literals if item['line'] == record['line'] and all(_normal_tokens(a) == _normal_tokens(values[field]) for a, field in zip(item['args'], fields))]
            span = _span(source, text)
            if len(matches) == 1:
                span = _span(source, text, matches[0]['start'], matches[0]['end'], 'literal-wrapper')
            result['blocks'].append({**values, 'sourceSpan': span})
            if len(result['blocks']) > MAX_BLOCKS:
                fail('LECTURE_BUDGET', 'At most 256 lecture blocks are supported.')
        else:
            relative = values['file']
            if not re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\.tex', relative) or any(part in ('.', '..') for part in relative.split('/')):
                fail('LECTURE_SCENE_PATH', 'Scene use requires a contained portable relative .tex path.')
            target = (source.parent / relative).resolve()
            if not target.is_relative_to(source.parent) or not target.is_file():
                fail('LECTURE_SCENE_PATH', 'Scene source is missing or outside the note package.')
            result['scenes'].append(values)
    if headers != 1 or not result['blocks']:
        fail('LECTURE_HEADER', 'A lecture requires exactly one header and at least one block.')
    if any(scene['block'] not in ids for scene in result['scenes']):
        fail('LECTURE_SCENE_BLOCK', 'Every scene must refer to a declared block.')
    if _read(source, MAX_SOURCE_BYTES) != raw:
        fail('LECTURE_SOURCE_CHANGED', 'Source changed while capture was running.')
    _save(out / 'lecture-sources' / source.name, raw)
    _save(notes_path, _json(result))
    return result


def apply_repair(source: Path, build_manifest: dict, request: dict) -> dict:
    source = Path(source).resolve()
    if not isinstance(build_manifest, dict) or not isinstance(request, dict):
        fail('LECTURE_REPAIR_REQUEST', 'Manifest and repair request must be objects.')
    for key, manifest_key in [('expectedSourceRevision', 'sourceRevision'), ('expectedArtifactRevision', 'artifactRevision')]:
        expected = request.get(key)
        if not isinstance(expected, str) or not REVISION.fullmatch(expected) or expected != build_manifest.get(manifest_key):
            fail('LECTURE_REPAIR_REVISION', f'{key} must match the build manifest revision.')
    raw = _read(source, MAX_SOURCE_BYTES)
    if sha256(raw) != request['expectedSourceRevision']:
        fail('LECTURE_REPAIR_STALE', 'The source has changed since this build.')
    text = _text(raw)
    span = request.get('sourceSpan')
    if not isinstance(span, dict) or span.get('file') != source.name:
        fail('LECTURE_REPAIR_SPAN', 'The repair span must identify this exact source filename.')
    start, end = span.get('startOffset'), span.get('endOffset')
    if type(start) is not int or type(end) is not int or not 0 <= start <= end <= len(text) or span.get('offsetUnit', 'unicode-code-point') != 'unicode-code-point':
        fail('LECTURE_REPAIR_SPAN', 'Expected bounded half-open Unicode code-point offsets.')
    for key, offset in [('start', start), ('end', end)]:
        if key in span and span[key] != _line_column(text, offset):
            fail('LECTURE_REPAIR_SPAN', 'Line/column coordinates disagree with the offsets.')
    expected, replacement = request.get('expectedText'), request.get('replacement')
    if not isinstance(expected, str) or not isinstance(replacement, str) or text[start:end] != expected:
        fail('LECTURE_REPAIR_TEXT', 'The exact expected text does not match the source span.')
    try:
        updated = (text[:start] + replacement + text[end:]).encode('utf8')
    except UnicodeError as error:
        raise LectureSourceError('LECTURE_REPAIR_UTF8', 'Replacement must contain valid Unicode scalar values.') from error
    if len(updated) > MAX_SOURCE_BYTES:
        fail('LECTURE_REPAIR_BUDGET', 'Repaired source exceeds the source byte budget.')
    # Recheck immediately before the single atomic source replacement.
    if _read(source, MAX_SOURCE_BYTES) != raw:
        fail('LECTURE_REPAIR_STALE', 'Source changed during repair validation.')
    new_revision = sha256(updated)
    audit = {'contract': 'texloom-repair-audit/1', 'source': source.name,
             'sourceRevisionBefore': sha256(raw), 'sourceRevisionAfter': new_revision,
             'artifactRevision': request['expectedArtifactRevision'], 'sourceSpan': span,
             'expectedText': expected, 'replacement': replacement}
    audit_path = source.parent / f'.{source.name}.repair-{uuid.uuid4().hex}.json'
    # Write the complete audit before replacing the source; mark an unapplied
    # audit explicitly if publication fails, without modifying source bytes.
    _save(audit_path, _json({**audit, 'status': 'pending'}))
    try:
        if _read(source, MAX_SOURCE_BYTES) != raw:
            fail('LECTURE_REPAIR_STALE', 'Source changed before atomic publication.')
        _save(source, updated, mode=stat.S_IMODE(source.stat().st_mode))
    except (OSError, LectureSourceError):
        _save(audit_path, _json({**audit, 'status': 'not-applied'}))
        raise
    try:
        _save(audit_path, _json({**audit, 'status': 'applied'}))
    except OSError as error:
        raise LectureSourceError('LECTURE_REPAIR_AUDIT_STATUS',
                                 f'Source was updated to {new_revision}; the durable audit remains pending at {audit_path}.') from error
    return {'sourceRevision': new_revision, 'previousSourceRevision': sha256(raw),
            'artifactRevision': request['expectedArtifactRevision'], 'audit': str(audit_path), 'changed': updated != raw}
