"""Produce a bounded degree-two sphere wave by single-mode Galerkin reduction.

The spatial eigenfunction is fixed to F(p)=2*x*y/R**2. Its modal coefficient
is integrated as a genuine classical RK4 oscillator; no analytic time solution
is evaluated here. The mesh samples that one smooth spherical mode and is not
a spatial finite-element/discrete-Laplacian PDE solver. Absolute displaced
positions are a display channel and never change the mathematical sphere.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import tempfile
from typing import NamedTuple

from import_samples import MAX_BYTES, canonical_json, import_samples

PROFILE = 'sphere-degree-2-single-mode-rk4'
DEFAULT_RADIUS = 1.0
DEFAULT_SPEED = 2 * math.pi / (8 * math.sqrt(6))
DEFAULT_DURATION = 8.0
DEFAULT_STEPS = 1024
DEFAULT_STORED_KNOTS = 65
DEFAULT_LONGITUDES = 32
DEFAULT_LATITUDES = 16
DEFAULT_DISPLAY_AMPLITUDE = .28
SEED = 3701
MAX_STEPS = 262144


class WaveSampleError(ValueError):
    def __init__(self, code, message):
        super().__init__(f'{code}: {message}')
        self.code = code


class ModeState(NamedTuple):
    t: float
    q: float
    qdot: float


def _finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _positive(value, name):
    if not _finite(value) or value <= 0:
        raise WaveSampleError('WAVE_PARAMETERS', f'{name} must be positive and finite.')
    return float(value)


def _integer(value, name, lower, upper):
    if type(value) is not int or not lower <= value <= upper:
        raise WaveSampleError('WAVE_PARAMETERS', f'{name} must be an integer in {lower}..{upper}.')
    return value


def integrate_mode(omega, steps, duration=DEFAULT_DURATION):
    """Return all (t,q,qdot) states, including the initial state, for classical RK4.

    Initial conditions are q(0)=1, qdot(0)=0. Index-derived times avoid an
    accumulating clock. This pure numerical recurrence intentionally permits
    coarse finite steps so independent convergence/stability studies can inspect
    its behavior. Nonfinite arithmetic is rejected, never written as sample data.
    """
    omega = _positive(omega, 'omega')
    duration = _positive(duration, 'duration')
    steps = _integer(steps, 'steps', 1, MAX_STEPS)
    omega_squared = omega * omega
    h = duration / steps
    if not _finite(omega_squared) or omega_squared == 0 or not _finite(h) or h == 0:
        raise WaveSampleError('WAVE_RANGE', 'Frequency squared and time step must be finite and nonzero.')
    q, qdot = 1.0, 0.0
    states = [ModeState(0.0, q, qdot)]
    for index in range(1, steps + 1):
        # y=(q,qdot), y'=(qdot,-omega^2*q), with the classical 1/6,1/3,1/3,1/6 tableau.
        k1_q, k1_v = qdot, -omega_squared * q
        k2_q = qdot + .5 * h * k1_v
        k2_v = -omega_squared * (q + .5 * h * k1_q)
        k3_q = qdot + .5 * h * k2_v
        k3_v = -omega_squared * (q + .5 * h * k2_q)
        k4_q = qdot + h * k3_v
        k4_v = -omega_squared * (q + h * k3_q)
        next_q = q + h * (k1_q + 2 * k2_q + 2 * k3_q + k4_q) / 6
        next_v = qdot + h * (k1_v + 2 * k2_v + 2 * k3_v + k4_v) / 6
        # Multiply by the fraction first so a finite duration cannot overflow a
        # duration*index intermediate. Production 8/1024 times are exact binary fractions.
        time = duration * (index / steps)
        if not all(_finite(v) for v in (k1_q, k1_v, k2_q, k2_v, k3_q, k3_v, k4_q, k4_v, next_q, next_v, time)):
            raise WaveSampleError('WAVE_RANGE', f'RK4 arithmetic is nonfinite at step {index}.')
        if time <= states[-1].t:
            raise WaveSampleError('WAVE_TIME_PRECISION', 'Distinct integration times collapse in float64.')
        q, qdot = next_q, next_v
        states.append(ModeState(time, q, qdot))
    return tuple(states)


def _buffer(data, components, component_type='float64'):
    return {'version': 1, 'componentType': component_type, 'components': components,
            'count': len(data) // components, 'byteOffset': 0,
            'byteStride': components * (8 if component_type == 'float64' else 4), 'data': data}


def _sphere(radius, longitudes, latitudes):
    positions = [0.0, 0.0, -radius]
    normals = [0.0, 0.0, -1.0]
    # One vertex per pole; periodic longitude is welded by index construction.
    # Interior ring j occupies indices 1+(j-1)*longitudes ... j*longitudes.
    for j in range(1, latitudes):
        latitude = -math.pi / 2 + math.pi * j / latitudes
        cv, sv = math.cos(latitude), math.sin(latitude)
        for i in range(longitudes):
            longitude = 2 * math.pi * i / longitudes
            normal = [cv * math.cos(longitude), cv * math.sin(longitude), sv]
            positions.extend(radius * component for component in normal)
            normals.extend(normal)
    north = len(positions) // 3
    positions.extend([0.0, 0.0, radius])
    normals.extend([0.0, 0.0, 1.0])
    indices = []
    for i in range(longitudes):
        indices.extend([0, 1 + (i + 1) % longitudes, 1 + i])
    for j in range(latitudes - 2):
        lower, upper = 1 + j * longitudes, 1 + (j + 1) * longitudes
        for i in range(longitudes):
            following = (i + 1) % longitudes
            indices.extend([lower + i, lower + following, upper + following,
                            lower + i, upper + following, upper + i])
    last = 1 + (latitudes - 2) * longitudes
    for i in range(longitudes):
        indices.extend([north, last + i, last + (i + 1) % longitudes])
    return {'kind': 'mesh', 'version': 1, 'primitive': 'triangles', 'units': 'm',
            'coordinateSpace': 'object', 'winding': 'ccw',
            'topologyRevision': f'wave-domain-{longitudes}x{latitudes}-v1',
            'positions': _buffer(positions, 3), 'indices': _buffer(indices, 1, 'uint32'),
            'normals': _buffer(normals, 3),
            'bounds': {'min': [min(positions[axis::3]) for axis in range(3)],
                       'max': [max(positions[axis::3]) for axis in range(3)]}}


def _sha(data):
    return hashlib.sha256(data).hexdigest()


def _source_profile():
    tools = Path(__file__).resolve().parent
    return {'generator': {'path': 'tools/wave_samples.py', 'sha256': _sha((tools / 'wave_samples.py').read_bytes())},
            'importer': {'path': 'tools/import_samples.py', 'sha256': _sha((tools / 'import_samples.py').read_bytes())}}


def build_dataset(*, radius=DEFAULT_RADIUS, speed=DEFAULT_SPEED, duration=DEFAULT_DURATION,
                  steps=DEFAULT_STEPS, stored_knots=DEFAULT_STORED_KNOTS,
                  longitudes=DEFAULT_LONGITUDES, latitudes=DEFAULT_LATITUDES,
                  display_amplitude=DEFAULT_DISPLAY_AMPLITUDE):
    """Build finite JSON data in memory; no files, transport, renderer or random state.

    Parameters remain restricted to this single degree-two mode. Spatial grid
    resolution changes only sample locations, never the modal ODE or a PDE mesh.
    """
    radius, speed, duration = (_positive(value, name) for value, name in
                               [(radius, 'radius'), (speed, 'speed'), (duration, 'duration')])
    steps = _integer(steps, 'steps', 1, MAX_STEPS)
    stored_knots = _integer(stored_knots, 'stored_knots', 2, 4096)
    longitudes = _integer(longitudes, 'longitudes', 4, 512)
    latitudes = _integer(latitudes, 'latitudes', 2, 512)
    if not _finite(display_amplitude) or display_amplitude < 0:
        raise WaveSampleError('WAVE_PARAMETERS', 'display_amplitude must be finite and nonnegative.')
    display_amplitude = float(display_amplitude)
    if steps % (stored_knots - 1):
        raise WaveSampleError('WAVE_KNOTS', 'Stored knots must land exactly on integration steps.')
    count = 2 + longitudes * (latitudes - 1)
    if count > 65536 or stored_knots * count * 7 * 8 > MAX_BYTES or math.ceil(stored_knots / 8) > 256:
        raise WaveSampleError('WAVE_BUDGET', 'Vertex, chunk or binary payload budget exceeded.')
    radius_squared = radius * radius
    if not _finite(radius_squared) or radius_squared == 0:
        raise WaveSampleError('WAVE_RANGE', 'Squared sphere radius is outside finite nonzero float64 range.')
    eigenvalue = 6 / radius_squared
    l2_norm_squared = (16 * math.pi / 15) * radius_squared
    omega = (speed / radius) * math.sqrt(6)
    if not all(_finite(value) and value > 0 for value in (eigenvalue, l2_norm_squared, omega)):
        raise WaveSampleError('WAVE_RANGE', 'Physical derived parameters are outside finite nonzero float64 range.')
    states = integrate_mode(omega, steps, duration)
    stride = steps // (stored_knots - 1)
    stored = states[::stride]
    mesh = _sphere(radius, longitudes, latitudes)
    positions, normals = mesh['positions']['data'], mesh['normals']['data']
    modes, gradients = [], []
    for vertex in range(count):
        nx, ny, nz = normals[3 * vertex:3 * vertex + 3]
        # Equivalent scaled form of 2xy/R² and its spherical gradient:
        # (2/R²)(y,x,0) - (4xy/R⁴)p. No radius powers in the per-vertex arithmetic.
        mode = 2 * nx * ny
        radial = 4 * nx * ny
        gradient = [(2 * ny - radial * nx) / radius,
                    (2 * nx - radial * ny) / radius, -radial * nz / radius]
        if not all(_finite(value) for value in [mode, *gradient]):
            raise WaveSampleError('WAVE_RANGE', 'Spatial mode or surface gradient is nonfinite.')
        modes.append(mode)
        gradients.extend(gradient)
    frames = []
    for state in stored:
        scalar = [value * state.q for value in modes]
        gradient = [value * state.q for value in gradients]
        display = [position + display_amplitude * scalar[index // 3] * normals[index]
                   for index, position in enumerate(positions)]
        if not all(_finite(value) for channel in (scalar, gradient, display) for value in channel):
            raise WaveSampleError('WAVE_RANGE', 'A stored field channel is nonfinite.')
        frames.append({'time': state.t, 'values': {'scalar': scalar, 'gradient': gradient, 'position': display}})
    channels = [{'id': 'scalar', 'kind': 'scalar', 'componentType': 'float64', 'unit': '1'},
                {'id': 'gradient', 'kind': 'vector', 'componentType': 'float64', 'unit': '1/m'},
                {'id': 'position', 'kind': 'position', 'componentType': 'float64', 'unit': 'm'}]
    parameters = {'radius': radius, 'speed': speed, 'omega': omega, 'duration': duration,
                  'steps': steps, 'storedKnots': stored_knots, 'longitudes': longitudes,
                  'latitudes': latitudes, 'displayAmplitude': display_amplitude, 'seed': SEED}
    source_profile = _source_profile()
    samples = {'version': 1, 'units': 'm', 'topology': {'revision': mesh['topologyRevision'],
                'vertexCount': count, 'indices': list(mesh['indices']['data'])},
               'interpolation': 'linear', 'outside': 'clamp', 'seed': SEED,
               'solver': {'name': PROFILE, 'version': '1', 'parameters': {
                   **parameters, 'equation': 'u_tt=c^2 Delta_S u', 'spatialMode': 'F(p)=2*x*y/R^2',
                   'method': 'single-mode spectral/Galerkin reduction; classical RK4 in time',
                   'initialQ': 1, 'initialQdot': 0, 'generalMeshPdeSolver': False,
                   'generatorSha256': source_profile['generator']['sha256']}},
               'channels': channels, 'frames': frames}
    model = {'version': 1, 'profile': PROFILE, 'parameters': parameters,
             'units': {'radius': 'm', 'speed': 'm/s', 'omega': '1/s', 'duration': 's',
                       'displayAmplitude': 'm', 'scalar': '1', 'gradient': '1/m'},
             'formulas': {'equation': 'u_tt = c^2 Delta_S u', 'mode': 'F(p)=2*x*y/R^2; u(p,t)=F(p)*q(t)',
                          'modeOde': 'q_ddot + omega^2*q = 0; omega=c*sqrt(6)/R',
                          'initialPosition': 'q(0)=1; u(p,0)=F(p)',
                          'initialVelocity': 'qdot(0)=0; u_t(p,0)=0',
                          'gradient': 'grad_S u=q(t)*[(2/R^2)*(y,x,0)-(4*x*y/R^4)*p]',
                          'displayPosition': 'p_display=p+displayAmplitude*u(p,t)*n0(p); n0(p)=p/R'},
             'normalization': {'peak': 1, 'l2NormSquared': l2_norm_squared, 'l2NormSquaredUnit': 'm^2'},
             'eigenproblem': {'degree': 2, 'eigenvalue': eigenvalue, 'eigenvalueUnit': '1/m^2'},
             'integration': {'scheme': 'classical-RK4', 'order': 4, 'stepSize': duration / steps,
                             'storedStepStride': stride, 'initialState': {'q': 1, 'qdot': 0},
                             'stateUnits': {'t': 's', 'q': '1', 'qdot': '1/s'}},
             'geometry': {'meshId': 'wave-domain', 'topologyRevision': mesh['topologyRevision'],
                          'vertexCount': count, 'triangleCount': len(mesh['indices']['data']) // 3,
                          'orientation': 'outward-ccw', 'normals': 'radial-analytic'},
             'scope': {'singleModeGalerkin': True, 'generalMeshPdeSolver': False,
                       'displayDisplacementChangesPde': False},
             'sourceProfile': source_profile}
    return {'mesh': mesh, 'samples': samples, 'model': model,
            'modeStates': [{'t': state.t, 'q': state.q, 'qdot': state.qdot} for state in stored]}


def build_samples(**configuration):
    """Pure-data convenience API used by independent numerical validation."""
    return build_dataset(**configuration)['samples']


def generate(output):
    """Atomically publish one canonical production dataset into a NEW directory."""
    output = Path(output)
    if output.exists():
        raise WaveSampleError('WAVE_OUTPUT', 'Output must be a new directory; existing data is never replaced.')
    dataset = build_dataset()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.wave-', dir=output.parent) as temporary:
        stage = Path(temporary)
        for name, key in [('mesh.json', 'mesh'), ('samples.json', 'samples'),
                          ('model.json', 'model'), ('mode-states.json', 'modeStates')]:
            (stage / name).write_bytes(canonical_json(dataset[key]))
        (stage / 'domain.tex').write_bytes(b'\\loommesh{wave-domain}|' + canonical_json(dataset['mesh']).rstrip(b'\n') + b'|\n')
        _, import_report = import_samples(stage / 'samples.json', stage / 'bake', chunk_frames=8)
        files = {path.relative_to(stage).as_posix(): _sha(path.read_bytes())
                 for path in sorted(stage.rglob('*')) if path.is_file()}
        report = {'version': 1, 'profile': PROFILE, 'generator': dataset['model']['sourceProfile']['generator'],
                  'integrationSteps': DEFAULT_STEPS, 'sampleCount': DEFAULT_STORED_KNOTS,
                  'vertexCount': dataset['model']['geometry']['vertexCount'],
                  'triangleCount': dataset['model']['geometry']['triangleCount'],
                  'chunks': import_report['chunks'], 'payloadBytes': import_report['payloadBytes'],
                  'seed': SEED, 'files': files, 'importReportPath': 'bake/import-report.json',
                  'manifestSha256': files['bake/manifest.json']}
        (stage / 'report.json').write_bytes(canonical_json(report))
        stage.rename(output)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, help='A new output directory for the canonical production profile.')
    args = parser.parse_args()
    try:
        report = generate(args.out)
        print(json.dumps({key: report[key] for key in ['profile', 'integrationSteps', 'sampleCount', 'vertexCount', 'triangleCount', 'chunks', 'payloadBytes', 'manifestSha256']}, sort_keys=True))
        return 0
    except (OSError, ValueError, TypeError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
