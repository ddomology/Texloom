"""Build a .tex scene to validated IR, self-contained player, SVG, optional MP4.

python tools/build.py examples/orbit.tex --out build/demo --video
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
from compile import compile_scene

ROOT=Path(__file__).resolve().parents[1]

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path);parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--video',action='store_true');parser.add_argument('--fps',type=int,default=30)
    args=parser.parse_args();out=args.out.resolve()
    bundle=compile_scene(args.source,out)
    subprocess.run(['node',str(ROOT/'tools/build-player.mjs'),str(out/'bundle.json'),str(out/'player.html')],check=True,cwd=ROOT)
    subprocess.run(['node',str(ROOT/'node_modules/tsx/dist/cli.mjs'),str(ROOT/'tools/snapshot.ts'),str(out/'bundle.json'),str(out/'snapshot.svg'),str(bundle['duration']/2)],check=True,cwd=ROOT)
    if args.video:
        subprocess.run([sys.executable,str(ROOT/'tools/export_video.py'),str(out/'player.html'),'--out',str(out/'demo.mp4'),'--fps',str(args.fps)],check=True,cwd=ROOT)
    print(json.dumps({'output':str(out),'duration':bundle['duration'],'video':args.video}))
