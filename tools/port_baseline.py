"""Comparison contracts for port baselines; no compiler/renderer implementation."""
from __future__ import annotations

from copy import deepcopy
import math
from pathlib import Path
import re


def validate_spec(spec: dict, fixture_ids: set[str]) -> list[str]:
    errors = []
    def require(condition, message):
        if not condition:
            errors.append(message)
    def text(value):
        return isinstance(value, str) and bool(value.strip())
    def texts(value):
        return isinstance(value, list) and bool(value) and all(text(v) for v in value)
    if not isinstance(spec, dict):
        return ['PortSpec must be an object']
    require(type(spec.get('schemaVersion')) is int and spec['schemaVersion'] == 1, 'schemaVersion must be 1')
    for key in ('id', 'title'):
        require(text(spec.get(key)), f'{key} is required')
    implementation = spec.get('implementation', {})
    if not isinstance(implementation, dict):
        implementation = {}
    require(implementation.get('mode') in ('independent-regression-baseline', 'independent-implementation', 'direct-copy', 'translation', 'upstream-execution'), 'implementation.mode is unsupported')
    for key in ('supportedProfile', 'excluded'):
        require(texts(implementation.get(key)), f'implementation.{key} must list the scope')
    sources = spec.get('upstream')
    require(isinstance(sources, list) and bool(sources), 'upstream sources are required')
    for i, source in enumerate(sources if isinstance(sources, list) else []):
        if not isinstance(source, dict):
            errors.append(f'upstream[{i}] must be an object')
            continue
        prefix = f'upstream[{i}]'
        require(isinstance(source.get('revision'), str) and bool(re.fullmatch(r'[0-9a-fA-F]{40}', source['revision'])), f'{prefix}.revision requires a full immutable commit SHA')
        for key in ('project', 'path', 'role'):
            require(text(source.get(key)), f'{prefix}.{key} is required')
        require(texts(source.get('symbols')), f'{prefix}.symbols is required')
        docs = source.get('documentation')
        require((text(docs) and docs.startswith('https://')) or (texts(docs) and all(v.startswith('https://') for v in docs)), f'{prefix}.documentation requires HTTPS references')
        license_info = source.get('license', {})
        if not isinstance(license_info, dict):
            license_info = {}
        require(license_info.get('status') in ('review-required', 'reviewed'), f'{prefix}.license.status is required')
        require(text(license_info.get('note')), f'{prefix}.license.note is required')
        if implementation.get('mode') in ('direct-copy', 'translation'):
            require(license_info.get('status') == 'reviewed', f'{prefix}.license must be reviewed for copied/translated code')
            require(text(license_info.get('spdx')) and text(license_info.get('noticeFile')), f'{prefix}.license needs spdx and noticeFile for code reuse')
    contract = spec.get('contract', {})
    if not isinstance(contract, dict):
        contract = {}
    for key in ('inputs', 'outputs', 'coordinates', 'errorPolicy'):
        require(texts(contract.get(key)), f'contract.{key} is required')
    fixtures = spec.get('fixtures')
    require(texts(fixtures), 'fixtures must be a nonempty ID list')
    if texts(fixtures):
        for name in fixtures:
            require(name in fixture_ids, f'Unknown fixture {name}')
    verification = spec.get('verification', {})
    if not isinstance(verification, dict):
        verification = {}
    require(text(verification.get('command')), 'verification.command is required')
    for key in ('claims', 'notEstablished'):
        require(texts(verification.get(key)), f'verification.{key} is required')
    return errors


def canonical_bundle(bundle: dict) -> dict:
    """Omit build provenance only, never coordinates, paths, source IDs or paint."""
    result = deepcopy(bundle)
    result.pop('provenance', None)
    for resource in result.get('resources', {}).values():
        resource.pop('provenance', None)
    return result


PATH_TOKEN = re.compile(r'[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?')


def path_tokens(value: str):
    # Preserve command case and ordering; whitespace/comma formatting is immaterial.
    if PATH_TOKEN.sub('', value).strip(' ,\t\r\n'):
        return None
    return [token if token.isalpha() else float(token) for token in PATH_TOKEN.findall(value)]


def compare_values(expected, actual, abs_tol=1e-7, rel_tol=1e-10) -> list[str]:
    errors = []
    def visit(a, b, path):
        if len(errors) >= 20:
            return
        if isinstance(a, (float, int)) and not isinstance(a, bool) and isinstance(b, (float, int)) and not isinstance(b, bool):
            if not (math.isfinite(a) and math.isfinite(b) and math.isclose(a, b, abs_tol=abs_tol, rel_tol=rel_tol)):
                errors.append(f'{path}: numeric difference {a!r} != {b!r}')
        elif type(a) is not type(b):
            errors.append(f'{path}: type {type(a).__name__} != {type(b).__name__}')
        elif isinstance(a, dict):
            if a.keys() != b.keys():
                errors.append(f'{path}: keys differ: missing={sorted(a.keys()-b.keys())}, extra={sorted(b.keys()-a.keys())}')
            for key in a.keys() & b.keys():
                visit(a[key], b[key], f'{path}.{key}')
        elif isinstance(a, list):
            if len(a) != len(b):
                errors.append(f'{path}: length {len(a)} != {len(b)}')
            for i, (x, y) in enumerate(zip(a, b)):
                visit(x, y, f'{path}[{i}]')
        elif isinstance(a, str) and path.endswith('.d'):
            x, y = path_tokens(a), path_tokens(b)
            if x is not None and y is not None:
                visit(x, y, path + '.tokens')
            elif a != b:
                errors.append(f'{path}: path differs')
        elif a != b:
            errors.append(f'{path}: {str(a)[:120]!r} != {str(b)[:120]!r}')
    visit(expected, actual, '$')
    return errors


def pixel_metrics(expected: Path, actual: Path) -> dict:
    from PIL import Image, ImageChops
    with Image.open(expected) as image:
        one = image.convert('RGBA')
    with Image.open(actual) as image:
        two = image.convert('RGBA')
    if one.size != two.size:
        return {'sizeMismatch': [list(one.size), list(two.size)]}
    diff = ImageChops.difference(one, two)
    histogram = diff.histogram()
    total = sum((i % 256) * n for i, n in enumerate(histogram))
    maximum = max((i % 256 for i, n in enumerate(histogram) if n), default=0)
    channels = diff.split()
    mask = channels[0]
    for channel in channels[1:]:
        mask = ImageChops.lighter(mask, channel)
    count = one.width * one.height
    changed = count - mask.histogram()[0]
    return {'changedPixels': changed, 'changedFraction': changed / count,
            'meanChannelDifference': total / (4 * count), 'maximumChannelDifference': maximum}


def within_raster(metrics: dict, policy: dict) -> bool:
    return 'sizeMismatch' not in metrics and all(
        math.isfinite(metrics[k]) and metrics[k] <= policy[k]
        for k in ('meanChannelDifference', 'changedFraction', 'maximumChannelDifference'))
