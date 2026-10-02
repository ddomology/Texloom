"""Package the verified named-TikZ example and current source for offline use."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def package(out):
    source = ROOT / 'build' / 'v02'
    out = out.resolve()
    target = out / 'demo'
    bundle = json.loads((source / 'bundle.json').read_text(encoding='utf8'))
    qa = json.loads((source / 'qa' / 'report.json').read_text(encoding='utf8'))
    anchors = json.loads((source / 'qa' / 'anchors.json').read_text(encoding='utf8'))
    verification = json.loads((ROOT / 'build' / 'verification-v02.json').read_text(encoding='utf8'))
    for name in ('player.html', 'bundle.json', 'snapshot.svg', 'demo.mp4', 'demo.mp4.json', 'compile-report.json'):
        copy(source / name, target / name)
    artifacts = [bundle['provenance']['sourceDvi']]
    artifacts += [r['provenance']['dvi'] for r in bundle['resources'].values() if r['kind'] == 'vector']
    for name in artifacts:
        parent = (source / name).parent
        for path in parent.iterdir():
            if path.is_file() and path.suffix in ('.dvi', '.tex', '.svg', '.metrics', '.jsonl', '.anchors'):
                copy(path, target / path.relative_to(source))
    for original, name in [('report.json', 'qa-report.json'), ('anchors.json', 'anchor-report.json'),
                           ('desktop.png', 'player-preview.png'),
                           (f'frame-{bundle["duration"]/2:.2f}.png', 'poster.png')]:
        copy(source / 'qa' / original, target / name)
    copy(ROOT / 'examples' / 'commutative.tex', out / 'commutative.tex')
    copy(ROOT / 'README.md', out / 'README.md')
    copy(ROOT / 'tex' / 'README-v02.md', out / 'authoring-guide.md')
    copy(ROOT / 'build' / 'verification-v02.json', out / 'verification.json')
    manifest = {'version': '0.2.0', 'scene': bundle['title'], 'duration': bundle['duration'],
                'nodes': len(bundle['nodes']), 'resources': len(bundle['resources']),
                'tracks': len(bundle['tracks']), 'relations': len(bundle['relations']),
                'verification': verification, 'snapshotParity': qa['snapshotParity'],
                'anchors': {'checks': anchors['checks'], 'maximumScreenErrorPx': anchors['maximumScreenErrorPx']},
                'mp4Sha256': hashlib.sha256((target / 'demo.mp4').read_bytes()).hexdigest()}
    with zipfile.ZipFile(out / 'Texloom-v0.2-source.zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(ROOT.rglob('*')):
            if not path.is_file():
                continue
            rel = path.relative_to(ROOT)
            if any(part in ('.git', 'node_modules', 'build', '__pycache__', '.venv') for part in rel.parts):
                continue
            if path.suffix in ('.pyc', '.log', '.aux'):
                continue
            archive.write(path, Path('Texloom') / rel)
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf8')
    print(json.dumps(manifest))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    package(parser.parse_args().output)
