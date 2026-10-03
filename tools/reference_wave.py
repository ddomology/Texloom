"""Independent angular-coordinate verification of the PR37 wave dataset.

The producer's Cartesian formula/gradient helpers are deliberately not imported.
Only its numerical integrator is exercised as a system under test, against this
module's own exact time solution. Run: python tools/reference_wave.py --data DIR
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SPEED = 2 * math.pi / (8 * math.sqrt(6))


class ReferenceError(ValueError):
    """A scientific or provenance acceptance condition failed."""


def require(condition, message):
    if not condition:
        raise ReferenceError(message)


def angular_field(theta, phi):
    return math.sin(theta) ** 2 * math.sin(2 * phi)


def angular_gradient(theta, phi, radius=1.0, amplitude=1.0):
    """Use the orthonormal theta/phi basis; pole limits are zero without division."""
    s, c, sp, cp = math.sin(theta), math.cos(theta), math.sin(phi), math.cos(phi)
    d_theta = 2 * s * c * math.sin(2 * phi)
    d_phi_over_sin = 2 * s * math.cos(2 * phi)
    e_theta, e_phi = (c * cp, c * sp, -s), (-sp, cp, 0.0)
    return tuple(amplitude / radius * (d_theta * a + d_phi_over_sin * b)
                 for a, b in zip(e_theta, e_phi))


def angular_laplacian(theta, phi, radius=1.0):
    """Explicit angular derivatives, rather than importing the eigenvalue helper."""
    s, c, azimuth = math.sin(theta), math.cos(theta), math.sin(2 * phi)
    theta_theta = 2 * (c*c - s*s) * azimuth
    cot_theta_theta = 2 * c*c * azimuth
    phi_phi_over_sin_squared = -4 * azimuth
    return (theta_theta + cot_theta_theta + phi_phi_over_sin_squared) / radius**2


def exact_mode(time, radius=1.0, speed=DEFAULT_SPEED):
    omega = speed * math.sqrt(6) / radius
    return math.cos(omega * time), -omega * math.sin(omega * time)


def point_angles(point, radius):
    theta = math.acos(max(-1.0, min(1.0, point[2] / radius)))
    return theta, math.atan2(point[1], point[0])


def reference_checks(radius=1.0, speed=DEFAULT_SPEED):
    """Independent quadrature and finite differences; no production mesh is used."""
    require(radius > 0 and speed > 0, 'Positive radius and speed are required.')
    norm = stiffness = 0.0
    n_theta, n_phi = 256, 64
    # Simpson in colatitude, periodic trapezoidal quadrature in azimuth.
    for j in range(n_theta + 1):
        theta = math.pi * j / n_theta
        weight = (1 if j in (0, n_theta) else 4 if j % 2 else 2)
        area = weight * math.sin(theta) * radius**2
        norm += area * sum(angular_field(theta, 2*math.pi*k/n_phi)**2 for k in range(n_phi))
        stiffness += area * sum(sum(g*g for g in angular_gradient(theta, 2*math.pi*k/n_phi, radius)) for k in range(n_phi))
    scale = math.pi / (3*n_theta) * (2*math.pi/n_phi)
    norm *= scale
    stiffness *= scale
    expected_norm = 16*math.pi*radius**2/15
    omega = speed*math.sqrt(6)/radius
    points = [(0.37, 0.23, 0.31), (0.83, 1.11, 1.17),
              (1.4, 2.21, 2.07), (2.2, 4.01, 3.11)]
    eigen_residual = max(abs(angular_laplacian(t,p,radius)+6/radius**2*angular_field(t,p)) for t,p,_ in points)
    finite_differences = []
    # h is radians in space and seconds in time. The tests additionally vary R,c.
    for h in (0.02, 0.01, 0.005):
        residual = 0.0
        for theta, phi, time in points:
            u = lambda a,b,t: angular_field(a,b)*math.cos(omega*t)
            center = u(theta,phi,time)
            theta_first = (u(theta+h,phi,time)-u(theta-h,phi,time))/(2*h)
            theta_second = (u(theta+h,phi,time)-2*center+u(theta-h,phi,time))/h**2
            phi_second = (u(theta,phi+h,time)-2*center+u(theta,phi-h,time))/h**2
            lap = (theta_second+math.cos(theta)/math.sin(theta)*theta_first
                   +phi_second/math.sin(theta)**2)/radius**2
            second_time = (u(theta,phi,time+h)-2*center+u(theta,phi,time-h))/h**2
            residual = max(residual, abs(second_time-speed**2*lap))
        finite_differences.append({'h':h,'maxPdeResidual':residual})
    fd_orders = [math.log(a['maxPdeResidual']/b['maxPdeResidual'],2)
                 for a,b in zip(finite_differences,finite_differences[1:])]
    require(abs(norm-expected_norm) < 2e-9*radius**2, 'Angular L2 quadrature failed.')
    require(abs(stiffness-6/radius**2*expected_norm) < 2e-6, 'Angular Dirichlet quadrature failed.')
    require(eigen_residual < 2e-13/radius**2, 'Angular eigenfunction identity failed.')
    require(all(1.9 < order < 2.1 for order in fd_orders), 'PDE finite differences did not converge at second order.')
    return {'radius':radius,'speed':speed,'omega':omega,'period':2*math.pi/omega,
            'initialAmplitude':exact_mode(0,radius,speed)[0],
            'initialVelocity':exact_mode(0,radius,speed)[1],
            'peakAmplitude':angular_field(math.pi/2,math.pi/4),
            'l2Squared':expected_norm,'quadratureL2Squared':norm,
            'quadratureDirichletEnergy':stiffness,
            'quadratureRule':{'theta':'composite Simpson','thetaIntervals':n_theta,
                              'phi':'periodic trapezoidal','phiIntervals':n_phi},
            'angularEigenResidual':eigen_residual,
            'finiteDifferencePde':finite_differences,'finiteDifferenceObservedOrder':fd_orders}


def convergence_report(integrator=None):
    # Import the numerical algorithm only, never the producer's reference math.
    if integrator is None:
        from wave_samples import integrate_mode
        integrator = integrate_mode
    omega, runs = 2*math.pi/8, []
    for steps in (32,64,128):
        states = integrator(omega, steps, 8)
        require(len(states)==steps+1, 'Convergence integrator must return every step.')
        error = max(math.hypot(s.q-math.cos(omega*s.t),
                               s.qdot/omega+math.sin(omega*s.t)) for s in states)
        require(error > 0 and math.isfinite(error), 'Numerical convergence error must be nonzero and finite.')
        runs.append({'steps':steps,'stepSize':8/steps,'maxScaledPhaseSpaceError':error})
    orders = [math.log(a['maxScaledPhaseSpaceError']/b['maxScaledPhaseSpaceError'],2)
              for a,b in zip(runs,runs[1:])]
    require(all(3.9 < order < 4.1 for order in orders), 'RK4 observed order must be approximately four.')
    return {'norm':'max over all steps of hypot(q-cos(w*t), qdot/w+sin(w*t))',
            'runs':runs,'observedOrder':orders}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_json(path):
    def pairs(items):
        out = {}
        for key,value in items:
            require(key not in out, f'Duplicate JSON key {key} in {path}.')
            out[key] = value
        return out
    value = json.loads(Path(path).read_text(encoding='utf8'),object_pairs_hook=pairs,
                       parse_constant=lambda x: (_ for _ in ()).throw(ReferenceError('Nonfinite JSON.')))
    def finite(item):
        if isinstance(item,float): require(math.isfinite(item), 'Nonfinite JSON number.')
        elif isinstance(item,list):
            for x in item: finite(x)
        elif isinstance(item,dict):
            for x in item.values(): finite(x)
    finite(value)
    return value


def close(actual, expected, tolerance, message):
    require(isinstance(actual,(int,float)) and not isinstance(actual,bool)
            and math.isfinite(actual) and abs(actual-expected)<=tolerance, message)


def verify_bake(folder, samples):
    """Decode/authenticate persisted bytes independently of the importer/runtime."""
    manifest_path = folder/'bake/manifest.json'
    manifest = read_json(manifest_path)
    import_report = read_json(folder/'bake/import-report.json')
    require(import_report['sourceSha256']==digest(folder/'samples.json'), 'Importer source hash mismatch.')
    require(import_report['manifestSha256']==digest(manifest_path), 'Importer manifest hash mismatch.')
    for key in ('topology','solver','channels','units','interpolation','outside','seed'):
        require(manifest[key]==samples[key], f'Bake {key} differs from imported samples.')
    require(manifest['timeUnit']=='s', 'Bake time unit must be seconds.')
    require(manifest['sampleTimes']==[f['time'] for f in samples['frames']], 'Bake sample times differ.')
    channels = samples['channels']
    count = samples['topology']['vertexCount']
    next_frame = payload_bytes = 0
    for chunk in manifest['chunks']:
        require(chunk['startSample']==next_frame and chunk['sampleCount']>0, 'Bake chunk coverage is invalid.')
        source = chunk['source']
        require(source['kind']=='external', 'Reference corpus requires external chunks.')
        path = (folder/'bake'/source['uri']).resolve()
        require(path.is_relative_to((folder/'bake').resolve()), 'Chunk must stay within the dataset.')
        raw = path.read_bytes()
        require(len(raw)==chunk['byteLength'] and hashlib.sha256(raw).hexdigest()==chunk['sha256'], 'Bake chunk hash or size mismatch.')
        offset = 0
        for frame_index in range(next_frame,next_frame+chunk['sampleCount']):
            require(frame_index<len(samples['frames']), 'Bake chunk extends beyond samples.')
            for channel in channels:
                components = count*(1 if channel['kind']=='scalar' else 3)
                require(channel['componentType'] in ('float32','float64'), 'Unknown storage type.')
                fmt = 'f' if channel['componentType']=='float32' else 'd'
                size = components*(4 if fmt=='f' else 8)
                require(offset+size<=len(raw), 'Truncated channel payload.')
                decoded = struct.unpack_from('<'+fmt*components,raw,offset)
                expected = samples['frames'][frame_index]['values'][channel['id']]
                require(len(expected)==components, 'Incorrect channel length.')
                # Compare to the declared encoding, without using producer helpers.
                encoded_expected = struct.unpack('<'+fmt*components,struct.pack('<'+fmt*components,*expected))
                require(decoded==encoded_expected, 'Binary channel data differs from source JSON.')
                offset += size
        require(offset==len(raw), 'Trailing bytes in bake chunk.')
        next_frame += chunk['sampleCount']
        payload_bytes += len(raw)
    require(next_frame==len(samples['frames']), 'Bake does not cover every stored frame.')
    require(import_report['samples']==next_frame and import_report['chunks']==len(manifest['chunks'])
            and import_report['payloadBytes']==payload_bytes, 'Importer counts do not match the files.')
    return {'verifiedChunks':len(manifest['chunks']),'verifiedPayloadBytes':payload_bytes,
            'manifestSha256':digest(manifest_path)}


def validate_dataset(folder):
    folder = Path(folder)
    model, mesh, samples, states, producer = [read_json(folder/name) for name in
        ('model.json','mesh.json','samples.json','mode-states.json','report.json')]
    require(model['version']==1 and model['profile']=='sphere-degree-2-single-mode-rk4', 'Unrecognized scientific model profile.')
    p = model['parameters']
    radius, speed, duration = p['radius'],p['speed'],p['duration']
    require(all(type(x) in (int,float) and math.isfinite(x) and x>0 for x in (radius,speed,duration)), 'Invalid physical parameters.')
    omega = speed*math.sqrt(6)/radius
    close(p['omega'],omega,1e-14*omega,'Model frequency does not match c*sqrt(6)/R.')
    require(type(p['steps']) is int and p['steps']>0 and type(p['storedKnots']) is int
            and p['storedKnots']>1 and p['steps']%(p['storedKnots']-1)==0, 'Invalid numerical time grid.')
    expected_units = {'radius':'m','speed':'m/s','omega':'1/s','duration':'s',
                      'displayAmplitude':'m','scalar':'1','gradient':'1/m'}
    require(model['units']==expected_units, 'Model units differ from the specified SI contract.')
    require(model['scope']=={'singleModeGalerkin':True,'generalMeshPdeSolver':False,
                            'displayDisplacementChangesPde':False}, 'Model scope claims do not match the implemented method.')
    require(model['formulas']=={
        'equation':'u_tt = c^2 Delta_S u',
        'mode':'F(p)=2*x*y/R^2; u(p,t)=F(p)*q(t)',
        'modeOde':'q_ddot + omega^2*q = 0; omega=c*sqrt(6)/R',
        'initialPosition':'q(0)=1; u(p,0)=F(p)',
        'initialVelocity':'qdot(0)=0; u_t(p,0)=0',
        'gradient':'grad_S u=q(t)*[(2/R^2)*(y,x,0)-(4*x*y/R^4)*p]',
        'displayPosition':'p_display=p+displayAmplitude*u(p,t)*n0(p); n0(p)=p/R'},
        'Model formula declarations differ from the verified profile.')
    close(model['normalization']['peak'],1,0,'Mode must have unit peak, not unit L2 norm.')
    close(model['normalization']['l2NormSquared'],16*math.pi*radius**2/15,1e-13*radius**2,'Incorrect mode normalization.')
    require(model['normalization']['l2NormSquaredUnit']=='m^2', 'Incorrect norm unit.')
    require(model['eigenproblem']['degree']==2 and model['eigenproblem']['eigenvalueUnit']=='1/m^2', 'Incorrect eigenspace or eigenvalue unit.')
    close(model['eigenproblem']['eigenvalue'],6/radius**2,1e-13/radius**2,'Incorrect model eigenvalue.')
    integration = model['integration']
    require(integration['scheme']=='classical-RK4' and integration['order']==4
            and integration['initialState']=={'q':1,'qdot':0}
            and integration['stateUnits']=={'t':'s','q':'1','qdot':'1/s'}, 'Incorrect integration declaration.')
    close(integration['stepSize'],duration/p['steps'],0,'Integration step size differs.')
    require(integration['storedStepStride']==p['steps']//(p['storedKnots']-1), 'Incorrect stored stride.')
    geometry = model['geometry']
    require(geometry['meshId']=='wave-domain' and geometry['orientation']=='outward-ccw'
            and geometry['normals']=='radial-analytic', 'Incorrect physical geometry declaration.')
    require(mesh['units']=='m' and mesh['winding']=='ccw' and mesh['coordinateSpace']=='object'
            and mesh['primitive']=='triangles', 'Incorrect source mesh representation.')
    positions, normals = mesh['positions']['data'],mesh['normals']['data']
    indices = mesh['indices']['data']
    count = mesh['positions']['count']
    require(type(p['longitudes']) is int and p['longitudes']>=4
            and type(p['latitudes']) is int and p['latitudes']>=2
            and count==2+p['longitudes']*(p['latitudes']-1)
            and len(indices)==6*p['longitudes']*(p['latitudes']-1), 'Sampling grid declaration differs from geometry.')
    require(len(positions)==3*count==len(normals) and len(indices)%3==0
            and all(type(i) is int and 0<=i<count for i in indices), 'Invalid physical mesh buffers.')
    require(geometry['vertexCount']==count and geometry['triangleCount']==len(indices)//3
            and geometry['topologyRevision']==mesh['topologyRevision'], 'Model geometry counts differ from mesh.')
    require(samples['topology']=={'revision':mesh['topologyRevision'],'vertexCount':count,'indices':indices}, 'Imported topology differs from physical mesh.')
    require(samples['units']=='m' and samples['interpolation']=='linear' and samples['outside']=='clamp'
            and samples['seed']==p['seed'], 'Incorrect sampling declaration.')
    require(samples['solver']=={'name':'sphere-degree-2-single-mode-rk4','version':'1',
            'parameters':dict(p,initialQ=1,initialQdot=0,
                equation='u_tt=c^2 Delta_S u',spatialMode='F(p)=2*x*y/R^2',
                method='single-mode spectral/Galerkin reduction; classical RK4 in time',
                generalMeshPdeSolver=False,
                generatorSha256=model['sourceProfile']['generator']['sha256'])},
            'Sample solver metadata differs from the verified model and source identity.')
    require(samples['channels']==[
        {'id':'scalar','kind':'scalar','componentType':'float64','unit':'1'},
        {'id':'gradient','kind':'vector','componentType':'float64','unit':'1/m'},
        {'id':'position','kind':'position','componentType':'float64','unit':'m'}], 'Channel roles, storage precision or units differ.')
    require(len(states)==len(samples['frames'])==p['storedKnots'], 'Stored time count differs from model.')
    points = [positions[i:i+3] for i in range(0,len(positions),3)]
    source_normals = [normals[i:i+3] for i in range(0,len(normals),3)]
    angles = []
    for point,normal in zip(points,source_normals):
        close(math.sqrt(sum(x*x for x in point)),radius,5e-14*radius,'Source vertex is off the physical sphere.')
        for x,n in zip(point,normal): close(n,x/radius,5e-14,'Source normal is not radial.')
        angles.append(point_angles(point,radius))
    for i in range(0,len(indices),3):
        a,b,c = [points[k] for k in indices[i:i+3]]
        ab,ac = [b[j]-a[j] for j in range(3)],[c[j]-a[j] for j in range(3)]
        cross = (ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0])
        require(sum(cross[j]*(a[j]+b[j]+c[j]) for j in range(3))>0, 'Mesh face is degenerate or not outward.')
    metrics = {key:0.0 for key in ('maxAmplitudeError','maxVelocityError','maxScalarError',
                'maxGradientError','maxGradientNormalDot','maxDisplayPositionError',
                'maxScalarAssemblyError','maxGradientAssemblyError','maxDisplayAssemblyError')}
    expected_times = [duration*(i/(p['storedKnots']-1)) for i in range(p['storedKnots'])]
    from wave_samples import integrate_mode
    # This is algorithm replay as a provenance check, not our truth oracle.
    replay = integrate_mode(p['omega'],p['steps'],duration)[::integration['storedStepStride']]
    for index,(state,frame,time) in enumerate(zip(states,samples['frames'],expected_times)):
        require(set(state)=={'t','q','qdot'}, 'Unexpected mode-state schema.')
        close(state['t'],time,0,'Stored mode time differs from declared grid.')
        close(frame['time'],time,0,'Imported sample time differs from declared grid.')
        require((state['t'],state['q'],state['qdot'])==tuple(replay[index]),
                'Stored mode states do not replay the declared RK4 algorithm.')
        expected_q,expected_v = exact_mode(time,radius,speed)
        metrics['maxAmplitudeError'] = max(metrics['maxAmplitudeError'],abs(state['q']-expected_q))
        metrics['maxVelocityError'] = max(metrics['maxVelocityError'],abs(state['qdot']-expected_v))
        values = frame['values']
        require(set(values)=={'scalar','gradient','position'} and len(values['scalar'])==count
                and len(values['gradient'])==len(values['position'])==3*count, 'Incomplete or malformed raw channels.')
        for i,(point,normal,(theta,phi)) in enumerate(zip(points,source_normals,angles)):
            field = angular_field(theta,phi)
            scalar,assembled = field*expected_q,field*state['q']
            raw = values['scalar'][i]
            metrics['maxScalarError'] = max(metrics['maxScalarError'],abs(raw-scalar))
            metrics['maxScalarAssemblyError'] = max(metrics['maxScalarAssemblyError'],abs(raw-assembled))
            gradient = angular_gradient(theta,phi,radius,expected_q)
            assembled_gradient = angular_gradient(theta,phi,radius,state['q'])
            vector = values['gradient'][3*i:3*i+3]
            metrics['maxGradientNormalDot'] = max(metrics['maxGradientNormalDot'],abs(sum(a*b for a,b in zip(vector,normal))))
            for j in range(3):
                metrics['maxGradientError'] = max(metrics['maxGradientError'],abs(vector[j]-gradient[j]))
                metrics['maxGradientAssemblyError'] = max(metrics['maxGradientAssemblyError'],abs(vector[j]-assembled_gradient[j]))
                actual_position = values['position'][3*i+j]
                display = point[j]+p['displayAmplitude']*scalar*normal[j]
                assembled_display = point[j]+p['displayAmplitude']*assembled*normal[j]
                metrics['maxDisplayPositionError'] = max(metrics['maxDisplayPositionError'],abs(actual_position-display))
                metrics['maxDisplayAssemblyError'] = max(metrics['maxDisplayAssemblyError'],abs(actual_position-assembled_display))
    close(states[0]['q'],1,0,'Incorrect initial amplitude.')
    close(states[0]['qdot'],0,0,'Incorrect initial velocity.')
    # For production1024 steps, errors are far below 1e-8. Coarse test datasets
    # use the measured RK4 bound below rather than pretending every grid is exact.
    phase = omega*duration/p['steps']
    require(phase<=1, 'Reference bound requires omega*dt <= 1.')
    # In the (q,qdot/omega) norm, RK4 is multiplication by R(i*phase).
    # For phase<=1, |R(i*phase)|<=1. The exponential Taylor integral remainder
    # has norm <= phase^5/120, giving this telescoping global bound.
    integration_bound = p['steps']*phase**5/120
    require(metrics['maxAmplitudeError']<=integration_bound+5e-13
            and metrics['maxVelocityError']<=omega*integration_bound+5e-13, 'Numerical trajectory exceeds the RK4 reference bound.')
    require(metrics['maxScalarAssemblyError']<5e-13 and metrics['maxGradientAssemblyError']<2e-12/radius
            and metrics['maxDisplayAssemblyError']<2e-12*max(radius,abs(p['displayAmplitude'])), 'Raw channels disagree with independent angular reconstruction.')
    require(metrics['maxGradientNormalDot']<5e-13/radius, 'Raw gradient is not tangent to the physical sphere.')
    # Compare between knots, separately from the RK4 endpoint error.
    interpolation_error = max_total_error = 0.0
    for i in range(len(states)-1):
        left,right = states[i],states[i+1]
        for alpha in (.125,.25,.5,.75,.875):
            time = left['t']+(right['t']-left['t'])*alpha
            q = exact_mode(time,radius,speed)[0]
            exact_linear = (1-alpha)*exact_mode(left['t'],radius,speed)[0]+alpha*exact_mode(right['t'],radius,speed)[0]
            numeric_linear = (1-alpha)*left['q']+alpha*right['q']
            interpolation_error = max(interpolation_error,abs(exact_linear-q))
            max_total_error = max(max_total_error,abs(numeric_linear-q))
    max_gap = max(b-a for a,b in zip(expected_times,expected_times[1:]))
    interpolation_bound = omega**2*max_gap**2/8
    require(interpolation_error<=interpolation_bound+1e-14 and max_total_error<=interpolation_bound+metrics['maxAmplitudeError']+1e-14, 'Time interpolation exceeds its separate endpoint/curvature bound.')
    provenance = verify_provenance(folder,model,producer)
    provenance['bake'] = verify_bake(folder,samples)
    require(producer['version']==1 and producer['profile']==model['profile']
            and producer['integrationSteps']==p['steps'] and producer['sampleCount']==len(states)
            and producer['vertexCount']==count and producer['triangleCount']==len(indices)//3
            and producer['seed']==p['seed'] and producer['chunks']==provenance['bake']['verifiedChunks']
            and producer['payloadBytes']==provenance['bake']['verifiedPayloadBytes'],
            'Producer report counts or profile differ from verified artifacts.')
    return {'version':1,'status':'passed',
            'reference':{'path':'tools/reference_wave.py','sha256':digest(__file__),
                         'coordinateFormula':'sin(theta)^2*sin(2*phi)',
                         'independence':'No producer closed-form, gradient, normalization or energy helper is imported.'},
            'referenceChecks':reference_checks(radius,speed),'rk4Convergence':convergence_report(),
            'sampleChecks':dict(metrics,vertices=count,storedKnots=len(states),integrationAmplitudeBound=integration_bound),
            'interpolation':{'maxGap':max_gap,'maxSecondDerivative':omega**2,
                             'amplitudeErrorBound':interpolation_bound,
                             'measuredExactKnotLinearError':interpolation_error,
                             'measuredTotalLinearError':max_total_error,
                             'totalAmplitudeBound':interpolation_bound+metrics['maxAmplitudeError'],
                             'scope':'Amplitude; |F|<=1 gives the same scalar bound. Not a solver error.'},
            'provenance':provenance,
            'limits':['One exact spatial eigenspace with numerically integrated time coefficients.',
                      'No general mesh PDE solver or spatial discretization convergence is claimed.',
                      'The radial displacement is a display mapping; the PDE domain stays the original sphere.',
                      'Finite differences avoid coordinate poles; angular gradients use their finite pole limits.',
                      'Checks sample floating-point expressions and are not a formal proof.']}


def verify_provenance(folder, model, report):
    """Authenticate current source files and every producer-declared artifact."""
    required = {'mesh.json','samples.json','model.json','mode-states.json','domain.tex',
                'bake/manifest.json','bake/import-report.json'}
    require(required<=set(report['files']), 'Producer report omits required source artifact hashes.')
    hashes = {}
    for name,expected in report['files'].items():
        path = (folder/name).resolve()
        require(path.is_relative_to(folder.resolve()), 'Artifact path leaves the dataset.')
        actual = digest(path)
        require(actual==expected,f'Producer artifact hash mismatch: {name}.')
        hashes[name] = actual
    for role,relative in (('generator','tools/wave_samples.py'),('importer','tools/import_samples.py')):
        entry = model['sourceProfile'][role]
        require(entry['path']==relative and entry['sha256']==digest(ROOT/relative), f'{role} source hash mismatch.')
    require(report['generator']==model['sourceProfile']['generator'], 'Producer source identities disagree.')
    require(report['importReportPath']=='bake/import-report.json'
            and report['manifestSha256']==digest(folder/'bake/manifest.json'), 'Producer importer provenance mismatch.')
    return {'files':hashes,'producerReportSha256':digest(folder/'report.json'),
            'sourceProfile':model['sourceProfile']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data',required=True,type=Path)
    parser.add_argument('--out',type=Path)
    args = parser.parse_args()
    try:
        report = validate_dataset(args.data)
        target = args.out or args.data/'validation.json'
        # No report is published if any check above fails.
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text(json.dumps(report,sort_keys=True,indent=2,allow_nan=False)+'\n',encoding='utf8',newline='\n')
        print(json.dumps({'status':report['status'],'report':str(target),
                          'rk4ObservedOrder':report['rk4Convergence']['observedOrder']}))
    except (OSError,ValueError,KeyError,TypeError,struct.error) as error:
        parser.exit(1,str(error)+'\n')


if __name__=='__main__': main()
