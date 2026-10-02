"""Generate external scalar-field samples of a known planar standing wave.

This is an analytical data fixture, not a manifold/PDE numerical solver.
u(x,y,t)=sin(pi*x) sin(pi*y) cos(sqrt(2)*pi*t) on [0,1]^2.
The receiving engine only loads/interpolates the sampled scalar values.
"""
import json
import math
from pathlib import Path

rows, columns, duration, sample_rate = 24, 40, 6, 30
times = [i / sample_rate for i in range(duration * sample_rate + 1)]
samples = [[
    math.sin(math.pi * x / (columns-1)) * math.sin(math.pi * y / (rows-1)) *
    math.cos(math.sqrt(2) * math.pi * t)
    for y in range(rows) for x in range(columns)
] for t in times]
resource = {'kind':'scalar-field', 'rows':rows, 'columns':columns, 'times':times,
            'samples':samples, 'range':[-1,1], 'interpolation':'linear',
            'provenance': {'generator':'tools/generate_field.py',
                'method':'analytical samples; not a numerical PDE solver',
                'formula':'sin(pi*x)*sin(pi*y)*cos(sqrt(2)*pi*t)',
                'domain':'[0,1]^2', 'ordering':'row-major, y down'}}
path = Path(__file__).resolve().parents[1] / 'examples/data/wave-grid.json'
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(resource, separators=(',', ':')), encoding='utf8')
print(f'External field: {columns} x {rows}, {len(times)} samples -> {path.name}')
