"""Package a validated compiled scene with exact, hash-addressed resource bytes.

python tools/package-scene.py build/demo/bundle.json --out build/demo/package
Use --inline for embedded JSON or --packed for explicit ranges in one data file.
"""
import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--inline', action='store_true')
    mode.add_argument('--packed', action='store_true')
    args = parser.parse_args()
    command = ['node', str(ROOT/'tools/package-scene.mjs'), str(args.bundle.resolve()), '--out', str(args.out.resolve())]
    if args.inline:
        command.append('--inline')
    if args.packed:
        command.append('--packed')
    return subprocess.run(command, cwd=ROOT).returncode


if __name__ == '__main__':
    sys.exit(main())
