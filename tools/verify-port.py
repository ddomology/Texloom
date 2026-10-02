"""Rebuild and verify registered port references. Never updates goldens implicitly.

python tools/verify-port.py
python tools/verify-port.py --runtime-only  # frozen compiler output, no TeX
python tools/verify-port.py --record --reason "Reviewed reference migration"
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
from importlib.metadata import version as package_version
import json
import math
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile

from port_baseline import canonical_bundle, compare_values, pixel_metrics, validate_spec, within_raster

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'tests/fixtures/ports'
SUITE = FIXTURES / 'suite.json'
REFERENCE = FIXTURES / 'reference'


def load(path):
    def reject(value):
        raise ValueError(f'Nonfinite JSON value: {value}')
    return json.loads(Path(path).read_text(encoding='utf8'), parse_constant=reject)


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf8', newline='\n')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def inside(root, relative):
    if not isinstance(relative, str) or not relative:
        raise ValueError('Expected relative path')
    target = (root / relative).resolve()
    if Path(relative).is_absolute() or not target.is_relative_to(root.resolve()):
        raise ValueError(f'Path outside {root.name}: {relative}')
    return target


def command(args, log_dir, name, timeout=240, env=None):
    print(f'  {name}', flush=True)
    result = subprocess.run(list(map(str, args)), cwd=ROOT, capture_output=True,
                            text=True, encoding='utf8', errors='replace', timeout=timeout, env=env)
    log_dir.mkdir(parents=True, exist_ok=True)
    (log_dir / f'{name}.log').write_text(result.stdout + '\n' + result.stderr, encoding='utf8')
    if result.returncode:
        raise RuntimeError(f'{name} failed ({result.returncode}); see {log_dir / (name + ".log")}\n' + (result.stdout + result.stderr)[-2000:])
    return result.stdout.strip()


def suite_and_specs():
    suite = load(SUITE)
    fixtures = suite.get('fixtures', [])
    if type(suite.get('schemaVersion')) is not int or suite['schemaVersion'] != 1 or not fixtures:
        raise ValueError('Missing or invalid fixture suite')
    ids = set()
    for fixture in fixtures:
        name = fixture['id']
        if not re.fullmatch(r'[a-z][a-z0-9-]*', name) or name in ids:
            raise ValueError(f'Invalid or duplicate fixture ID: {name}')
        ids.add(name)
        if fixture['source'] not in fixture['inputs']:
            raise ValueError(f'{name}: source must be hashed in inputs')
        for path in fixture['inputs']:
            if not inside(ROOT, path).is_file():
                raise ValueError(f'{name}: missing input {path}')
        times = fixture['times']
        if not times or any(isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0 for t in times) or times != sorted(set(times)):
            raise ValueError(f'{name}: times must be unique sorted nonnegative numbers')
    for key in ('rasterTolerance', 'consumerTolerance'):
        policy = suite[key]
        if set(policy) != {'meanChannelDifference', 'changedFraction', 'maximumChannelDifference'} or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in policy.values()):
            raise ValueError(f'Invalid {key}')
        if policy['changedFraction'] > 1 or policy['maximumChannelDifference'] > 255:
            raise ValueError(f'Invalid raster units in {key}')
    numeric = suite['numericTolerance']
    if set(numeric) != {'absolute', 'relative'} or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0 for v in numeric.values()):
        raise ValueError('Invalid numeric tolerance')
    specs = sorted(p for p in (ROOT / 'docs/ports').glob('*.json') if not p.name.endswith('.template.json'))
    if not specs:
        raise ValueError('No active PortSpec found')
    errors, spec_ids = [], set()
    for path in specs:
        spec = load(path)
        errors.extend(f'{path.name}: {error}' for error in validate_spec(spec, ids))
        if spec.get('id') in spec_ids:
            errors.append(f'{path.name}: duplicate PortSpec ID')
        spec_ids.add(spec.get('id'))
    if errors:
        raise ValueError('\n'.join(errors))
    return suite, {p.relative_to(ROOT).as_posix(): sha(p) for p in specs}


def toolchain(logs, runtime_only):
    result = {'platform': platform.platform(), 'python': sys.version, 'pythonExecutable': sys.executable,
              'packages': {key: package_version(key) for key in ('playwright', 'Pillow')},
              'dependencyFiles': {p: sha(ROOT / p) for p in ('package-lock.json', 'requirements-port.txt')}}
    result['node'] = command(['node', '--version'], logs, 'node-version')
    result['implementationFiles'] = {
        p.relative_to(ROOT).as_posix(): sha(p)
        for folder in ('src', 'tex', 'tools', 'adapters')
        for p in sorted((ROOT / folder).rglob('*'))
        if p.is_file() and p.suffix in ('.py', '.ts', '.mjs', '.sty')
    }
    if not runtime_only:
        result['latex'] = command(['latex', '--version'], logs, 'latex-version').splitlines()[0]
        result['dvisvgm'] = command(['dvisvgm', '--version'], logs, 'dvisvgm-version').splitlines()[0]
        result['texFiles'] = {}
        for name in ('latex.ltx', 'pgf.sty', 'pgfsyssoftpath.code.tex', 'lmodern.sty', 'amsmath.sty', 'lmr10.pfb'):
            found = command(['kpsewhich', name], logs, 'kpse-' + name).splitlines()
            if not found or not Path(found[0]).is_file():
                raise RuntimeError(f'Missing TeX reference file: {name}')
            result['texFiles'][name] = {'sha256': sha(found[0]), 'path': found[0]}
        fmt = command(['kpsewhich', '-engine=pdftex', '-format=fmt', 'latex.fmt'], logs, 'latex-format').splitlines()
        if not fmt or not Path(fmt[0]).is_file():
            raise RuntimeError('Missing latex.fmt')
        result['texFormat'] = {'sha256': sha(fmt[0]), 'path': fmt[0]}
    return result


def comparable_toolchain(manifest):
    # Machine paths are provenance; format bytes and versions are profile evidence.
    return {key: manifest.get(key) for key in ('platform', 'python', 'node', 'latex', 'dvisvgm', 'packages', 'browser', 'dependencyFiles')} | {
        'texFiles': {k: v['sha256'] for k, v in manifest.get('texFiles', {}).items()},
        'texFormatSha256': manifest.get('texFormat', {}).get('sha256')}


def compare_json(expected, actual, suite, label):
    policy = suite['numericTolerance']
    errors = compare_values(expected, actual, policy['absolute'], policy['relative'])
    if errors:
        raise RuntimeError(label + '\n' + '\n'.join(errors))


def validate_reference(suite, specs):
    manifest = load(REFERENCE / 'manifest.json')
    if manifest.get('schemaVersion') != 1 or manifest.get('suiteSha256') != sha(SUITE):
        raise RuntimeError('Reference suite has changed; review before --record --reason')
    if manifest.get('specHashes') != specs:
        raise RuntimeError('PortSpec contract changed; review and record the reference explicitly')
    required = {'toolchain.json'}
    for fixture in suite['fixtures']:
        name = fixture['id']
        required.update(f'{name}/{filename}' for filename in ('bundle.json', 'observations.json'))
        for i in range(len(fixture['times'])):
            required.update(f'{name}/frame-{i}.{ext}' for ext in ('svg', 'png'))
        current_inputs = {p: sha(ROOT / p) for p in fixture['inputs']}
        if manifest.get('inputHashes', {}).get(name) != current_inputs:
            raise RuntimeError(f'{name}: reference input hashes differ; review the fixture source/data change')
    if set(manifest.get('artifacts', {})) != required:
        raise RuntimeError('Reference artifact inventory is incomplete or unexpected')
    for name, digest in manifest['artifacts'].items():
        path = inside(REFERENCE, name)
        if not path.is_file() or sha(path) != digest:
            raise RuntimeError(f'Missing or modified reference artifact: {name}')
    return manifest


def capture(page, bundle, times, folder):
    results = []
    for i, time in enumerate(times):
        images = page.evaluate('async ({bundle,time}) => window.portCapture(bundle,time)', {'bundle': bundle, 'time': time})
        for kind in ('svg', 'canvas'):
            output = folder / (f'frame-{i}.png' if kind == 'svg' else f'canvas-{i}.png')
            output.write_bytes(base64.b64decode(images[kind].split(',', 1)[1]))
        results.append(pixel_metrics(folder / f'frame-{i}.png', folder / f'canvas-{i}.png'))
    return results


def run(args, output, report):
    suite, specs = suite_and_specs()
    report.update(specs=specs, fixtureCount=len(suite['fixtures']), mode='runtime-only' if args.runtime_only else 'full')
    if args.spec_only:
        report.update(success=True, mode='spec-only')
        return
    if args.record and (not args.reason or not args.reason.strip() or args.runtime_only):
        raise ValueError('--record requires a nonempty --reason and a full source build')
    if not args.record:
        validate_reference(suite, specs)
        report['referenceManifestSha256'] = sha(REFERENCE / 'manifest.json')
    logs = output / 'logs'
    chain = toolchain(logs, args.runtime_only)
    # All four fixtures are required. No optional build-directory discovery.
    tsx = ROOT / 'node_modules/tsx/dist/cli.mjs'
    from playwright.sync_api import sync_playwright
    command(['node', ROOT / 'tools/build-port-browser.mjs', output / 'capture.js'], logs, 'build-browser')
    browser_errors = []
    report['fixtures'] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        chain['browser'] = {'name': 'chromium', 'version': browser.version,
                            'executable': playwright.chromium.executable_path}
        # Executable path varies; browser version is the relevant raster identity.
        chain['browser'].pop('executable')
        save(output / 'toolchain.json', chain)
        if not args.record:
            old = load(REFERENCE / 'toolchain.json')
            drift = compare_values(comparable_toolchain(old), comparable_toolchain(chain))
            report['toolchain'] = {'matchesReference': not drift, 'differences': drift,
                'policy': 'Drift is reported; semantic and raster tolerances are never widened. Runtime-only does not validate TeX.'}
        page = browser.new_page(device_scale_factor=1)
        page.on('pageerror', lambda error: browser_errors.append(str(error)))
        page.set_content('<!doctype html><meta charset="utf-8"><title>Port regression</title>')
        page.add_script_tag(path=str(output / 'capture.js'))
        for fixture in suite['fixtures']:
            name = fixture['id']
            print(f'Fixture: {name}', flush=True)
            folder = output / name
            folder.mkdir()
            if args.runtime_only:
                bundle = load(REFERENCE / name / 'bundle.json')
                save(folder / 'bundle.json', bundle)
            else:
                command([sys.executable, ROOT / 'tools/compile.py', ROOT / fixture['source'], '--out', folder / 'first'], logs, name + '-compile-1')
                command([sys.executable, ROOT / 'tools/compile.py', ROOT / fixture['source'], '--out', folder / 'repeat'], logs, name + '-compile-2')
                raw = load(folder / 'first/bundle.json')
                bundle = canonical_bundle(raw)
                repeated = canonical_bundle(load(folder / 'repeat/bundle.json'))
                if bundle != repeated:
                    raise RuntimeError(name + ': same-toolchain repeated compilation was not exactly equal after provenance removal')
                save(folder / 'build-provenance.json', {'bundle': raw.get('provenance'),
                     'resources': {k: v.get('provenance') for k, v in raw['resources'].items()}})
                save(folder / 'bundle.json', bundle)
            if not args.record:
                compare_json(load(REFERENCE / name / 'bundle.json'), bundle, suite, name + ': compiled semantic regression')
            command(['node', tsx, ROOT / 'tools/port-regression.ts', folder / 'bundle.json', folder, json.dumps(fixture['times'])], logs, name + '-observe')
            if not args.record:
                compare_json(load(REFERENCE / name / 'observations.json'), load(folder / 'observations.json'), suite, name + ': evaluated frame regression')
            parity = capture(page, bundle, fixture['times'], folder)
            entry = {'id': name, 'times': fixture['times'], 'repeatCompilation': not args.runtime_only,
                     'reverseSeek': True, 'inputAndPriorFramesUnchanged': True, 'independentRuntime': True,
                     'consumerParity': parity, 'historicalRaster': [], 'semanticSha256': sha(folder / 'bundle.json'),
                     'observationsSha256': sha(folder / 'observations.json')}
            report['fixtures'].append(entry)
            for i, metrics in enumerate(parity):
                if not within_raster(metrics, suite['consumerTolerance']):
                    raise RuntimeError(f'{name} at {fixture["times"][i]}: SVG/Canvas mismatch {metrics}')
                if not args.record:
                    metrics = pixel_metrics(REFERENCE / name / f'frame-{i}.png', folder / f'frame-{i}.png')
                    entry['historicalRaster'].append(metrics)
                    if not within_raster(metrics, suite['rasterTolerance']):
                        raise RuntimeError(f'{name} at {fixture["times"][i]}: historical raster regression {metrics}')
            if not args.runtime_only:
                command(['node', ROOT / 'tools/build-player.mjs', folder / 'bundle.json', folder / 'player.html'], logs, name + '-player')
        browser.close()
    if browser_errors:
        raise RuntimeError('Browser errors: ' + '\n'.join(browser_errors))
    # Tests are part of the single-command gate, including independent math contracts.
    command(['node', ROOT / 'node_modules/typescript/bin/tsc', '--noEmit'], logs, 'typecheck')
    # Shell glob expansion is not portable on Windows; enumerate explicitly.
    test_env = os.environ.copy()
    test_env['TEXLOOM_REFERENCE_ROOT'] = str(output)
    command(['node', tsx, '--test', *sorted((ROOT / 'tests').glob('*.test.ts'))], logs, 'typescript-tests', env=test_env)
    pattern = 'port_*_test.py' if args.runtime_only else '*_test.py'
    # Real-TeX integration cases compile several assets each; allow the growing
    # suite to finish on Windows as well as CI without weakening any assertions.
    command([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-p', pattern, '-v'], logs, 'python-tests', timeout=600)
    report['tests'] = {'typecheck': True, 'typescript': True, 'pythonPattern': pattern, 'passed': True}
    if args.record:
        artifacts = {}
        # Only publish references after every fixture and test passes. Manifest is last.
        for fixture in suite['fixtures']:
            name = fixture['id']
            filenames = ['bundle.json', 'observations.json'] + [f'frame-{i}.{ext}' for i in range(len(fixture['times'])) for ext in ('svg', 'png')]
            for filename in filenames:
                target = REFERENCE / name / filename
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(output / name / filename, target)
                artifacts[f'{name}/{filename}'] = sha(target)
        shutil.copyfile(output / 'toolchain.json', REFERENCE / 'toolchain.json')
        artifacts['toolchain.json'] = sha(REFERENCE / 'toolchain.json')
        save(REFERENCE / 'manifest.json', {'schemaVersion': 1, 'suiteSha256': sha(SUITE),
            'baselineRevision': suite['baselineRevision'], 'recordedAt': datetime.now(timezone.utc).isoformat(),
            'reason': args.reason, 'specHashes': specs, 'inputHashes': {f['id']: {p: sha(ROOT / p) for p in f['inputs']} for f in suite['fixtures']},
            'artifacts': artifacts})
        report['recorded'] = True
    report['success'] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--spec-only', action='store_true')
    parser.add_argument('--runtime-only', action='store_true')
    parser.add_argument('--record', action='store_true')
    parser.add_argument('--reason')
    args = parser.parse_args()
    if (args.spec_only and (args.record or args.runtime_only or args.reason)) or (args.reason and not args.record):
        parser.error('Use --spec-only alone; --reason belongs to --record')
    root = ROOT / 'build/port-verification'
    root.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix='run-', dir=root))
    report = {'success': False, 'startedAt': datetime.now(timezone.utc).isoformat(), 'output': str(output)}
    try:
        run(args, output, report)
    except (Exception, KeyboardInterrupt) as error:
        report['error'] = str(error) or type(error).__name__
        print(report['error'], file=sys.stderr, flush=True)
    save(output / 'report.json', report)
    save(root / 'latest.json', {'success': report['success'], 'report': str(output / 'report.json')})
    print(json.dumps({'success': report['success'], 'report': str(output / 'report.json')}, ensure_ascii=False), flush=True)
    return 0 if report['success'] else 1


if __name__ == '__main__':
    sys.exit(main())
