"""Import finite external vertex samples into the portable Texloom bake contract.

This tool serializes supplied data. It does not run a solver or resample time.
Every chunk is frame-major, channel-order, vertex-order, component-order little
endian IEEE float32/float64. Times live only in the manifest. The input schema
and exact bounds are documented in docs/temporal-samples.md.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import struct
import tempfile

from space3d_capture import _json, Space3DCaptureDiagnostic

MAX_BYTES = 64 * 1024 * 1024
IDENTIFIER = re.compile(r'[A-Za-z_][A-Za-z0-9_.:-]{0,511}')


class SampleImportDiagnostic(ValueError):
    def __init__(self, code, message, source_span=None):
        super().__init__(f'{code}: {message}')
        self.code, self.sourceSpan = code, source_span


def strict_json(data, span=None):
    try:
        text = data.decode('utf8') if isinstance(data, bytes) else data
        return _json(text, span)
    except UnicodeError as error:
        raise SampleImportDiagnostic('SAMPLES_UTF8', 'Expected strict UTF-8 JSON.', span) from error
    except Space3DCaptureDiagnostic as error:
        raise SampleImportDiagnostic(error.code.replace('SPACE3D_CAPTURE_', 'SAMPLES_'),
                                     str(error).split(': ', 1)[-1], span) from error


def canonical_json(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode('utf8')


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def require(value, condition, message):
    if not condition:
        raise SampleImportDiagnostic('SAMPLES_INPUT', message)
    return value


def integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def finite(value):
    try: return type(value) in (int, float) and math.isfinite(value)
    except OverflowError: return False


def label(value, maximum):
    return isinstance(value,str) and 0<len(value.strip()) and len(value)<=maximum and not re.search(r'[\x00-\x1f]',value)


def object_keys(value, required, optional=()):
    require(value, isinstance(value, dict) and set(required) <= set(value) <= set(required) | set(optional),
            f'Expected object fields {sorted(required)}, optionally {sorted(optional)}.')


def encode_samples(value, chunk_frames=32):
    """Return manifest and payloads without writing; malformed input has no side effects."""
    object_keys(value, ['version', 'units', 'topology', 'interpolation', 'outside', 'seed', 'solver', 'channels', 'frames'])
    require(value['version'], type(value['version']) is int and value['version'] == 1, 'Input version must be 1.')
    require(value['units'], value['units'] in ['unit', 'm', 'cm', 'mm'], 'Unknown mesh units.')
    require(value['interpolation'], value['interpolation'] in ['linear', 'step'], 'Expected linear or step interpolation.')
    require(value['outside'], value['outside'] in ['clamp', 'error'], 'Expected clamp or error outside policy.')
    require(value['seed'], integer(value['seed'], 0, 2**32-1), 'Seed must be uint32.')
    object_keys(value['solver'], ['name', 'version', 'parameters'])
    require(value['solver'], all(label(value['solver'][k],256) for k in ['name', 'version'])
            and isinstance(value['solver']['parameters'], dict), 'Solver requires name, version and a finite JSON parameter object.')
    # Public callers receive the same finite/depth/value guards as file input.
    strict_json(canonical_json(value['solver']))
    topology = value['topology']; object_keys(topology, ['revision', 'vertexCount', 'indices'])
    count = topology['vertexCount']
    require(count, integer(count, 1, 65536), 'Vertex count must be in 1..65536.')
    require(topology['revision'], label(topology['revision'],512), 'Topology revision is required.')
    indices = topology['indices']
    require(indices, isinstance(indices, list) and 0 < len(indices) <= 262144 and len(indices) % 3 == 0
            and all(integer(i, 0, count-1) for i in indices), 'Topology requires bounded triangle indices.')
    channels = value['channels']; require(channels, isinstance(channels, list) and 1 <= len(channels) <= 32, 'Expected 1..32 channels.')
    ids, formats, frame_bytes = [], [], 0
    for channel in channels:
        object_keys(channel, ['id', 'kind', 'componentType', 'unit'])
        identifier = channel['id']
        require(identifier, isinstance(identifier, str) and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.:-]{0,255}',identifier) and identifier not in ids and identifier not in ['constructor','prototype','__proto__'], 'Channel identifiers must be unique safe IDs of at most 256 characters.')
        require(channel['kind'], channel['kind'] in ['scalar', 'vector', 'position'], 'Unknown channel kind.')
        require(channel['componentType'], channel['componentType'] in ['float32', 'float64'], 'Only float32/float64 channels are supported.')
        require(channel['unit'], label(channel['unit'],256), 'Channel unit must be an explicit string.')
        require(channel['unit'], channel['kind']!='position' or channel['unit']==value['units'], 'Position channel unit must equal mesh units.')
        size = count * (1 if channel['kind'] == 'scalar' else 3)
        fmt = ('f' if channel['componentType'] == 'float32' else 'd')
        frame_bytes += size * (4 if fmt == 'f' else 8); ids.append(identifier); formats.append((size, fmt))
    frames = value['frames']; require(frames, isinstance(frames, list) and 1 <= len(frames) <= 4096, 'Expected 1..4096 frames.')
    require(chunk_frames, integer(chunk_frames, 1, 4096), 'chunk_frames must be in 1..4096.')
    require(frames, math.ceil(len(frames)/chunk_frames) <= 256 and len(frames)*frame_bytes <= MAX_BYTES, 'Chunk or byte budget exceeded.')
    times, encoded = [], []
    for frame in frames:
        object_keys(frame, ['time', 'values'])
        time = frame['time']; require(time, finite(time) and (not times or time > times[-1]), 'Sample times must be finite and strictly increasing.')
        # JSON numbers become IEEE float64 in every supported runtime. Python
        # integers have unbounded precision, so authored ordering alone is not
        # enough (2**53 and 2**53+1 would be the same JavaScript timestamp).
        if type(time) is int and int(float(time)) != time:
            raise SampleImportDiagnostic('SAMPLES_TIME_PRECISION', 'Integer sample time is not exactly representable as float64.')
        if times and float(time) <= float(times[-1]):
            raise SampleImportDiagnostic('SAMPLES_TIME_PRECISION', 'Distinct sample times collapse after float64 conversion.')
        samples = frame['values']; require(samples, isinstance(samples, dict) and set(samples) == set(ids), 'Every frame must contain exactly the declared channels.')
        parts = []
        for identifier, (size, fmt) in zip(ids, formats):
            values = samples[identifier]
            require(values, isinstance(values, list) and len(values) == size and all(finite(x) for x in values), f'Channel {identifier} requires {size} finite components per frame.')
            try:
                data = struct.pack('<' + fmt * size, *values)
            except (OverflowError, struct.error) as error:
                raise SampleImportDiagnostic('SAMPLES_RANGE', f'Channel {identifier} cannot be represented as {fmt}.') from error
            require(data, all(math.isfinite(x[0]) for x in struct.iter_unpack('<'+fmt, data)), f'Channel {identifier} overflows its component type.')
            parts.append(data)
        times.append(time); encoded.append(b''.join(parts))
    manifest = {key: value[key] for key in ['version', 'units', 'topology', 'interpolation', 'outside', 'seed', 'solver', 'channels']}
    manifest.update(timeUnit='s', sampleTimes=times, chunks=[])
    payloads = {}
    for start in range(0, len(frames), chunk_frames):
        payload = b''.join(encoded[start:start+chunk_frames]); name = f'chunk-{len(payloads):03d}.bin'; payloads[name] = payload
        manifest['chunks'].append({'id':f'chunk-{len(payloads)-1}', 'startSample':start,
            'sampleCount':min(chunk_frames, len(frames)-start), 'byteLength':len(payload), 'sha256':sha256(payload),
            'source':{'kind':'external', 'uri':name}})
    return manifest, payloads


def import_samples(source, output, chunk_frames=32):
    source, output = Path(source), Path(output)
    if source.stat().st_size > MAX_BYTES:
        raise SampleImportDiagnostic('SAMPLES_BUDGET', 'Input JSON exceeds 64 MiB.')
    raw = source.read_bytes(); manifest, payloads = encode_samples(strict_json(raw), chunk_frames)
    manifest_bytes = canonical_json(manifest)
    report = {'version':1, 'sourceSha256':sha256(raw), 'manifestSha256':sha256(manifest_bytes),
              'samples':len(manifest['sampleTimes']), 'chunks':len(payloads), 'payloadBytes':sum(map(len, payloads.values())),
              'encoding':'frame-major/channel-order/vertex-order/component-order IEEE little-endian'}
    # Publishing one new directory avoids a mixture of old and new manifests.
    # Existing output is deliberately preserved, including on successful repeat imports.
    if output.exists():
        raise SampleImportDiagnostic('SAMPLES_OUTPUT', 'Output must be a new directory; existing output is never replaced.')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.samples-', dir=output.parent) as staging:
        stage = Path(staging)
        for name, payload in payloads.items(): (stage/name).write_bytes(payload)
        (stage/'manifest.json').write_bytes(manifest_bytes)
        (stage/'import-report.json').write_bytes(canonical_json(report))
        stage.rename(output)
    return manifest, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source'); parser.add_argument('--out', required=True)
    parser.add_argument('--chunk-frames', type=int, default=32)
    args = parser.parse_args()
    try:
        _, report = import_samples(args.source, args.out, args.chunk_frames)
        print(json.dumps(report, sort_keys=True)); return 0
    except (OSError, ValueError, TypeError) as error:
        parser.exit(1, str(error)+'\n')


if __name__ == '__main__': main()
