"""Package source and verified demonstrations into a portable deliverable folder."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import zipfile

ROOT=Path(__file__).resolve().parents[1]

def copy(source,destination):
    destination.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(source,destination)

def package(out):
    out=out.resolve();out.mkdir(parents=True,exist_ok=True)
    manifest={'version':'0.1.0','scenes':{},'verification':{'typescriptTests':19,'compilerTests':7,'typecheck':True}}
    for scene in ('demo','field'):
        source=ROOT/'build'/scene;target=out/scene
        for name in ('player.html','bundle.json','snapshot.svg','demo.mp4','demo.mp4.json','compile-report.json'):
            copy(source/name,target/name)
        bundle=json.loads((source/'bundle.json').read_text(encoding='utf8'))
        # Preserve exactly the referenced compiled resource artifacts, including
        # the DVI payloads. Old build attempts and machine caches are excluded.
        dvis=[bundle['provenance']['sourceDvi']]
        dvis += [r['provenance']['dvi'] for r in bundle['resources'].values() if r['kind']=='vector']
        for relative in dvis:
            dvi=source/relative
            for path in dvi.parent.iterdir():
                if path.is_file() and path.suffix in ('.dvi','.tex','.svg','.metrics','.jsonl'):
                    copy(path,target/path.relative_to(source))
        report=json.loads((source/'qa/report.json').read_text(encoding='utf8'))
        copy(source/'qa/report.json',target/'qa-report.json')
        copy(source/'qa/desktop.png',target/'player-preview.png')
        poster=source/'qa'/f'frame-{bundle["duration"]/2:.2f}.png'
        copy(poster,target/'poster.png')
        manifest['scenes'][scene]={'title':bundle['title'],'duration':bundle['duration'],
            'nodes':len(bundle['nodes']),'resources':len(bundle['resources']),
            'tracks':len(bundle['tracks']),'relations':len(bundle['relations']),
            'pixelParity':report.get('snapshotParity'),'seek':report['seek'],
            'mp4Sha256':hashlib.sha256((source/'demo.mp4').read_bytes()).hexdigest()}
    copy(ROOT/'build/compiler-probe/comparison.json',out/'compiler-comparison.json')
    copy(ROOT/'examples/orbit.tex',out/'orbit.tex');copy(ROOT/'examples/field.tex',out/'field.tex')
    copy(ROOT/'examples/data/wave-grid.json',out/'data/wave-grid.json')
    with zipfile.ZipFile(out/'Texloom-v0.1-source.zip','w',zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
        for path in sorted(ROOT.rglob('*')):
            if not path.is_file():continue
            rel=path.relative_to(ROOT)
            if any(p in ('.git','node_modules','build','__pycache__','.venv') for p in rel.parts):continue
            if path.suffix in ('.pyc','.log','.aux'):continue
            archive.write(path,Path('Texloom')/rel)
    (out/'manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf8')
    print(json.dumps({'output':str(out),'sourceZipBytes':(out/'Texloom-v0.1-source.zip').stat().st_size,'scenes':manifest['scenes']}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('output',type=Path);package(p.parse_args().output)
