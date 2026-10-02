"""Lower explicit TeX curve-field declarations from literal sidecar files."""
from __future__ import annotations

import json
from pathlib import Path
import re
import shutil


class FieldCaptureDiagnostic(ValueError):
    pass


def _read(execution: Path, base: str, field: str) -> tuple[str, Path]:
    if not re.fullmatch(r'scene\.tl-field-[1-9][0-9]*', base):
        raise FieldCaptureDiagnostic('Invalid generated field filename')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file():
        raise FieldCaptureDiagnostic(f'Missing field sidecar: {path.name}')
    text = path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text), path


def _metadata(execution: Path, base: str, field: str) -> str:
    value = _read(execution, base, field)[0].strip()
    if not value:
        raise FieldCaptureDiagnostic(f'Field {field} must be nonempty')
    return value


def _options(text: str, allowed: tuple[str, ...]) -> dict[str, str]:
    result = {}
    for entry in text.split(','):
        if not entry.strip():
            continue
        if '=' not in entry:
            raise FieldCaptureDiagnostic(f'Field option requires key=value: {entry.strip()}')
        key, value = (part.strip() for part in entry.split('=', 1))
        if key not in allowed:
            raise FieldCaptureDiagnostic(f'Unknown field option: {key}')
        if key in result:
            raise FieldCaptureDiagnostic(f'Duplicate field option: {key}')
        result[key] = value
    return result


def _json_array(text: str, field: str) -> list:
    def invalid_constant(value):
        raise FieldCaptureDiagnostic(f'Field {field} contains nonfinite JSON value {value}')

    def object_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise FieldCaptureDiagnostic(f'Duplicate JSON key in field {field}: {key}')
            result[key] = value
        return result

    try:
        value = json.loads(text, parse_constant=invalid_constant, object_pairs_hook=object_pairs)
    except json.JSONDecodeError as error:
        raise FieldCaptureDiagnostic(f'Invalid field {field} JSON: {error}') from error
    if not isinstance(value, list):
        raise FieldCaptureDiagnostic(f'Field {field} must be a JSON array')
    return value


def _archive_span(text: str, path: Path, output: Path) -> dict:
    folder = output / 'field-sources'
    folder.mkdir(parents=True, exist_ok=True)
    archived = folder / path.name
    temporary = archived.with_suffix(archived.suffix + '.tmp')
    shutil.copyfile(path, temporary)
    temporary.replace(archived)
    lines = text.split('\n')
    return {'file': archived.relative_to(output).as_posix(),
            'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}


def lower_fields(records: list[dict], bundle: dict, execution: Path, output: Path) -> None:
    declarations = [record for record in records if record['type'] == 'field-program-file']
    if not declarations:
        return
    program = {'version': 1, 'domains': [], 'operations': [], 'bindings': []}
    seen = set()
    for record in declarations:
        base = record.get('file', '')
        if base in seen:
            raise FieldCaptureDiagnostic(f'Duplicate field declaration file: {base}')
        seen.add(base)
        kind = record.get('kind')
        if kind == 'domain':
            domain = {'id': _metadata(execution, base, 'id'),
                      'geometry': _metadata(execution, base, 'geometry'),
                      'domain': _metadata(execution, base, 'domain')}
            samples = _json_array(_read(execution, base, 'samples')[0], 'samples')
            if domain['domain'] == 'curve-sample':
                domain['samples'] = samples
            elif domain['domain'] == 'path-control':
                if samples:
                    raise FieldCaptureDiagnostic('Path-control domains derive elements from geometry; samples must be []')
            else:
                raise FieldCaptureDiagnostic('Field domain must be path-control or curve-sample')
            program['domains'].append(domain)
        elif kind == 'operation':
            options = _options(_read(execution, base, 'options')[0], ('position',))
            if options.get('position', 'current') not in ('current', 'original'):
                raise FieldCaptureDiagnostic('Field position mode must be current or original')
            body, path = _read(execution, base, 'body')
            operation = {'id': _metadata(execution, base, 'id'),
                         'domain': _metadata(execution, base, 'domain'),
                         'kind': _metadata(execution, base, 'operation-kind'),
                         'expression': body, 'sourceSpan': _archive_span(body, path, output)}
            if operation['kind'] not in ('capture', 'evaluate', 'setPosition'):
                raise FieldCaptureDiagnostic('Field operation must be capture, evaluate or setPosition')
            if 'position' in options:
                operation['position'] = options['position']
            program['operations'].append(operation)
        elif kind == 'binding':
            options = _options(_read(execution, base, 'options')[0], ('from', 'to'))
            body, path = _read(execution, base, 'targets')
            binding = {'domain': _metadata(execution, base, 'domain'),
                       'field': _metadata(execution, base, 'field'),
                       'property': _metadata(execution, base, 'property'),
                       'targets': _json_array(body, 'targets'),
                       'sourceSpan': _archive_span(body, path, output)}
            if options:
                if set(options) != {'from', 'to'} or any(not re.fullmatch(r'[0-9A-Fa-f]{6}', color) for color in options.values()):
                    raise FieldCaptureDiagnostic('Field color ramp requires from and to as six hexadecimal digits without #')
                binding['ramp'] = {key: '#' + options[key].upper() for key in ('from', 'to')}
            program['bindings'].append(binding)
        else:
            raise FieldCaptureDiagnostic(f'Unknown field declaration kind: {kind}')
    bundle['version'] = '0.3'
    bundle['fields'] = program
