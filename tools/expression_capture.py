"""Lower explicit TeX expression sidecars; never parse TeX math or execute text.

The final arguments of loomexpr/loomparameter are captured verbatim by TeX.
Expression source spans point to archived UTF-8 sidecars, not guessed positions
inside the original TeX command. TypeScript owns expression grammar and typing.
"""
from __future__ import annotations

import json
import math
from pathlib import Path
import re
import shutil


class ExpressionCaptureDiagnostic(ValueError):
    pass


def _finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _read(execution: Path, base: str, field: str) -> tuple[str, Path]:
    if not re.fullmatch(r'scene\.tl-expression-[1-9][0-9]*', base):
        raise ExpressionCaptureDiagnostic('Invalid generated expression filename')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file():
        raise ExpressionCaptureDiagnostic(f'Missing expression sidecar: {path.name}')
    # Remove exactly TeX's final write newline. Do not detokenize/decode escapes:
    # body/default arguments were scanned verbatim and can contain literal ##.
    text = path.read_text(encoding='utf8')
    if text.endswith('\n'):
        text = text[:-1]
    return text, path


def _options(text: str) -> dict:
    options = {}
    for entry in text.split(','):
        if not entry.strip():
            continue
        if '=' not in entry:
            raise ExpressionCaptureDiagnostic(f'Expression parameter option needs key=value: {entry.strip()}')
        key, value = (part.strip() for part in entry.split('=', 1))
        if key not in ('type', 'unit', 'min', 'max'):
            raise ExpressionCaptureDiagnostic(f'Unknown expression parameter option: {key}')
        if key in options:
            raise ExpressionCaptureDiagnostic(f'Duplicate expression parameter option: {key}')
        options[key] = value
    result = {'type': options.get('type', 'scalar')}
    if result['type'] not in ('scalar', 'boolean', 'vec2'):
        raise ExpressionCaptureDiagnostic('Parameter type must be scalar, boolean or vec2')
    if 'unit' in options:
        if options['unit'] not in ('1', 'bp', 's', 'rad'):
            raise ExpressionCaptureDiagnostic('Parameter unit must be 1, bp, s or rad')
        if result['type'] == 'boolean':
            raise ExpressionCaptureDiagnostic('Boolean parameters cannot have a unit')
        result['unit'] = options['unit']
    for bound in ('min', 'max'):
        if bound in options:
            if result['type'] != 'scalar':
                raise ExpressionCaptureDiagnostic('Only scalar parameters support bounds')
            try:
                value = json.loads(options[bound])
            except (json.JSONDecodeError, ValueError) as error:
                raise ExpressionCaptureDiagnostic(f'Parameter {bound} must be a finite JSON number') from error
            if not _finite_number(value):
                raise ExpressionCaptureDiagnostic(f'Parameter {bound} must be a finite JSON number')
            result[bound] = value
    if 'min' in result and 'max' in result and result['min'] > result['max']:
        raise ExpressionCaptureDiagnostic('Parameter min cannot exceed max')
    return result


def _parameter(execution: Path, base: str) -> tuple[str, dict]:
    name = _read(execution, base, 'name')[0].strip()
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', name):
        raise ExpressionCaptureDiagnostic(f'Invalid expression parameter name: {name}')
    definition = _options(_read(execution, base, 'options')[0])
    literal, _ = _read(execution, base, 'default')
    try:
        value = json.loads(literal)
    except (json.JSONDecodeError, ValueError) as error:
        raise ExpressionCaptureDiagnostic(f'Parameter {name} default must be a JSON literal') from error
    kind = definition['type']
    valid = (_finite_number(value) if kind == 'scalar' else isinstance(value, bool) if kind == 'boolean'
             else isinstance(value, list) and len(value) == 2 and all(_finite_number(v) for v in value))
    if not valid:
        raise ExpressionCaptureDiagnostic(f'Parameter {name} default does not match finite {kind} type')
    if kind == 'scalar' and ((('min' in definition) and value < definition['min']) or
                             (('max' in definition) and value > definition['max'])):
        raise ExpressionCaptureDiagnostic(f'Parameter {name} default is outside its declared bounds')
    definition['default'] = value
    return name, definition


def _source_span(text: str, path: Path, output: Path) -> dict:
    lines = text.split('\n')
    return {'file': path.relative_to(output).as_posix(),
            'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}


def _archive_source(path: Path, output: Path) -> Path:
    # Run directories retain compilation provenance, while portable source spans
    # use stable names so identical source compiles produce identical programs.
    folder = output / 'expression-sources'
    folder.mkdir(parents=True, exist_ok=True)
    archived = folder / path.name
    temporary = archived.with_suffix(archived.suffix + '.tmp')
    shutil.copyfile(path, temporary)
    temporary.replace(archived)
    return archived


def lower_expressions(records: list[dict], bundle: dict, execution: Path, output: Path) -> None:
    """Attach one checked program only when explicit expression records exist."""
    declarations = [record for record in records if record['type'] == 'expression-file']
    if not declarations:
        return
    program = {'version': 1, 'parameters': {}, 'bindings': []}
    seen_files = set()
    for record in declarations:
        base = record.get('file', '')
        if base in seen_files:
            raise ExpressionCaptureDiagnostic(f'Duplicate expression declaration file: {base}')
        seen_files.add(base)
        if record.get('kind') == 'parameter':
            name, definition = _parameter(execution, base)
            if name in program['parameters']:
                raise ExpressionCaptureDiagnostic(f'Duplicate expression parameter: {name}')
            program['parameters'][name] = definition
        elif record.get('kind') == 'binding':
            target = _read(execution, base, 'target')[0].strip()
            prop = _read(execution, base, 'property')[0].strip()
            body, path = _read(execution, base, 'body')
            if not target or not prop:
                raise ExpressionCaptureDiagnostic('Expression target and property must be nonempty')
            archived = _archive_source(path, output)
            program['bindings'].append({'target': target, 'property': prop, 'expression': body,
                                        'sourceSpan': _source_span(body, archived, output)})
        else:
            raise ExpressionCaptureDiagnostic(f'Unknown expression declaration kind: {record.get("kind")}')
    bundle['version'] = '0.3'
    bundle['expressions'] = program
