"""Lower explicit curve-deformation declarations from literal TeX sidecars."""
from __future__ import annotations

import json
import math
from pathlib import Path
import re
import shutil


class DeformationCaptureDiagnostic(ValueError):
    pass


def _read(execution: Path, base: str, field: str) -> tuple[str, Path]:
    if not re.fullmatch(r'scene\.tl-deformation-[1-9][0-9]*', base):
        raise DeformationCaptureDiagnostic('Invalid generated deformation filename')
    path = execution / f'{base}.{field}.txt'
    if not path.is_file():
        raise DeformationCaptureDiagnostic(f'Missing deformation sidecar: {path.name}')
    text = path.read_text(encoding='utf8')
    return (text[:-1] if text.endswith('\n') else text), path


def _metadata(execution: Path, base: str, field: str) -> str:
    value = _read(execution, base, field)[0].strip()
    if not value:
        raise DeformationCaptureDiagnostic(f'Deformation {field} must be nonempty')
    return value


def _options(text: str) -> dict:
    raw = {}
    for entry in text.split(','):
        if not entry.strip():
            continue
        if '=' not in entry:
            raise DeformationCaptureDiagnostic(f'Deformation option requires key=value: {entry.strip()}')
        key, value = (part.strip() for part in entry.split('=', 1))
        if key not in ('mode', 'tolerance', 'max-depth', 'max-segments'):
            raise DeformationCaptureDiagnostic(f'Unknown deformation option: {key}')
        if key in raw:
            raise DeformationCaptureDiagnostic(f'Duplicate deformation option: {key}')
        raw[key] = value
    result = {'mode': raw.get('mode', 'pointwiseDeform')}
    if result['mode'] not in ('controlDeform', 'pointwiseDeform'):
        raise DeformationCaptureDiagnostic('Deformation mode must be controlDeform or pointwiseDeform')
    for key, target in [('tolerance', 'tolerance'), ('max-depth', 'maxDepth'), ('max-segments', 'maxSegments')]:
        if key not in raw:
            continue
        try:
            value = json.loads(raw[key])
        except (json.JSONDecodeError, ValueError) as error:
            raise DeformationCaptureDiagnostic(f'Deformation {key} must be a finite JSON number') from error
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise DeformationCaptureDiagnostic(f'Deformation {key} must be a finite JSON number')
        if key == 'tolerance':
            if value <= 0:
                raise DeformationCaptureDiagnostic('Deformation tolerance must be positive')
        elif not isinstance(value, int) or value < 1:
            raise DeformationCaptureDiagnostic(f'Deformation {key} must be a positive integer')
        result[target] = value
    return result


def _archive_span(text: str, path: Path, output: Path) -> dict:
    folder = output / 'deformation-sources'
    folder.mkdir(parents=True, exist_ok=True)
    archived = folder / path.name
    temporary = archived.with_suffix(archived.suffix + '.tmp')
    shutil.copyfile(path, temporary)
    temporary.replace(archived)
    lines = text.split('\n')
    return {'file': archived.relative_to(output).as_posix(),
            'start': {'line': 1, 'column': 1},
            'end': {'line': len(lines), 'column': len(lines[-1]) + 1}}


def lower_deformations(records: list[dict], bundle: dict, execution: Path, output: Path) -> None:
    declarations = [record for record in records if record['type'] == 'deformation-file']
    if not declarations:
        return
    program = {'version': 1, 'operations': []}
    seen = set()
    for record in declarations:
        base = record.get('file', '')
        if base in seen:
            raise DeformationCaptureDiagnostic(f'Duplicate deformation declaration file: {base}')
        seen.add(base)
        options = _options(_read(execution, base, 'options')[0])
        body, path = _read(execution, base, 'body')
        program['operations'].append({'id': _metadata(execution, base, 'id'),
                                      'source': _metadata(execution, base, 'source'),
                                      'target': _metadata(execution, base, 'target'),
                                      **options, 'expression': body,
                                      'sourceSpan': _archive_span(body, path, output)})
    bundle['version'] = '0.3'
    bundle['deformations'] = program
