"""Independent angular truth and negative provenance tests for the sphere wave."""
import json
import math
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'tools'))
import reference_wave as reference
from wave_samples import build_dataset, integrate_mode, ModeState

DATA = ROOT/'examples/data/manifold-wave'


def write_json(path,value):
    path.write_text(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n',encoding='utf8',newline='\n')


class AngularWaveReferenceTests(unittest.TestCase):
    def test_initial_conditions_period_peak_and_l2_are_distinct(self):
        report = reference.reference_checks()
        self.assertEqual(report['initialAmplitude'],1)
        self.assertEqual(report['initialVelocity'],0)
        self.assertEqual(report['period'],8)
        self.assertEqual(report['peakAmplitude'],1)
        self.assertAlmostEqual(report['l2Squared'],16*math.pi/15,places=14)
        self.assertAlmostEqual(report['quadratureL2Squared'],16*math.pi/15,places=10)
        for time,q in [(0,1),(2,0),(4,-1),(6,0),(8,1)]:
            self.assertAlmostEqual(reference.exact_mode(time)[0],q,places=14)
        for theta in (0,math.pi):
            for phi in (0,1,3):
                self.assertLess(max(map(abs,reference.angular_gradient(theta,phi))),1e-14)

    def test_independent_laplace_beltrami_and_pde_fd_scaling(self):
        for radius,speed in [(1,reference.DEFAULT_SPEED),(2,reference.DEFAULT_SPEED),(.75,1.5*reference.DEFAULT_SPEED)]:
            report = reference.reference_checks(radius,speed)
            self.assertLess(report['angularEigenResidual'],1e-12)
            self.assertTrue(all(1.9<order<2.1 for order in report['finiteDifferenceObservedOrder']))
            self.assertAlmostEqual(report['period'],2*math.pi*radius/(speed*math.sqrt(6)),places=13)
            self.assertAlmostEqual(report['quadratureL2Squared']/radius**2,16*math.pi/15,places=10)

    def test_actual_rk4_fourth_order_against_independent_trigonometric_truth(self):
        report = reference.convergence_report(integrate_mode)
        self.assertEqual([r['steps'] for r in report['runs']],[32,64,128])
        self.assertTrue(all(3.9<order<4.1 for order in report['observedOrder']))
        self.assertGreater(report['runs'][0]['maxScaledPhaseSpaceError'],1e-5)

    def test_closed_form_masquerading_as_numeric_algorithm_is_not_convergence_evidence(self):
        def analytic(omega,steps,duration):
            return tuple(ModeState(duration*i/steps,math.cos(omega*duration*i/steps),
                                   -omega*math.sin(omega*duration*i/steps)) for i in range(steps+1))
        with self.assertRaises(reference.ReferenceError): reference.convergence_report(analytic)

    def test_radius_speed_and_gradient_dimensions_are_respected(self):
        kwargs = dict(steps=128,stored_knots=9,longitudes=8,latitudes=4)
        base = build_dataset(**kwargs)
        scaled = build_dataset(radius=2,speed=2*reference.DEFAULT_SPEED,**kwargs)
        slower = build_dataset(radius=2,duration=16,**kwargs)
        self.assertAlmostEqual(scaled['model']['parameters']['omega'],base['model']['parameters']['omega'])
        self.assertAlmostEqual(slower['model']['parameters']['omega'],base['model']['parameters']['omega']/2)
        self.assertEqual(base['modeStates'],scaled['modeStates'])
        for left,right in zip(base['modeStates'],slower['modeStates']):
            self.assertEqual(left['q'],right['q'])
            self.assertEqual(left['qdot']/2,right['qdot'])
            self.assertEqual(left['t']*2,right['t'])
        for a,b in zip(base['samples']['frames'],scaled['samples']['frames']):
            self.assertEqual(a['values']['scalar'],b['values']['scalar'])
            for g,h in zip(a['values']['gradient'],b['values']['gradient']):self.assertEqual(g/2,h)

    def test_display_gain_changes_only_display_positions(self):
        kwargs = dict(steps=64,stored_knots=5,longitudes=8,latitudes=4)
        visible = build_dataset(**kwargs)
        flat = build_dataset(display_amplitude=0,**kwargs)
        self.assertEqual(visible['modeStates'],flat['modeStates'])
        for a,b in zip(visible['samples']['frames'],flat['samples']['frames']):
            self.assertEqual(a['values']['scalar'],b['values']['scalar'])
            self.assertEqual(a['values']['gradient'],b['values']['gradient'])
            self.assertEqual(b['values']['position'],flat['mesh']['positions']['data'])


class WaveDatasetAcceptanceTests(unittest.TestCase):
    def test_committed_dataset_and_reference_report_are_reproducible(self):
        report = reference.validate_dataset(DATA)
        saved = reference.read_json(DATA/'validation.json')
        # Source identities and structure are exact; libm implementations can
        # change last-bit residuals, especially finite-difference cancellation.
        def compare(left,right):
            if isinstance(left,float):
                self.assertTrue(math.isclose(left,right,rel_tol=1e-4,abs_tol=1e-12),(left,right))
            elif isinstance(left,dict):
                self.assertEqual(set(left),set(right))
                for key in left: compare(left[key],right[key])
            elif isinstance(left,list):
                self.assertEqual(len(left),len(right))
                for a,b in zip(left,right): compare(a,b)
            else: self.assertEqual(left,right)
        compare(report,saved)
        self.assertEqual(report['sampleChecks']['vertices'],482)
        self.assertEqual(report['sampleChecks']['storedKnots'],65)
        self.assertLess(report['sampleChecks']['maxAmplitudeError'],1e-9)
        self.assertLess(report['sampleChecks']['maxGradientNormalDot'],1e-12)
        interpolation = report['interpolation']
        self.assertGreater(interpolation['measuredExactKnotLinearError'],1e-3)
        self.assertLessEqual(interpolation['measuredTotalLinearError'],interpolation['totalAmplitudeBound'])
        self.assertLess(report['sampleChecks']['maxAmplitudeError']*1e6,
                        interpolation['measuredExactKnotLinearError'])

    def copied(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        target = Path(folder.name)/'data'
        shutil.copytree(DATA,target)
        return target

    def mutate(self,name,change):
        target = self.copied()
        path = target/name
        value = reference.read_json(path)
        change(value)
        write_json(path,value)
        return target

    def test_raw_scalar_corruption_fails_independent_assembly_check(self):
        target = self.mutate('samples.json',lambda d:d['frames'][7]['values']['scalar'].__setitem__(77,0.8))
        with self.assertRaisesRegex(reference.ReferenceError,'Raw channels'):
            reference.validate_dataset(target)

    def test_non_tangent_or_wrong_gradient_is_rejected(self):
        target = self.mutate('samples.json',lambda d:d['frames'][0]['values']['gradient'].__setitem__(2,0.4))
        with self.assertRaisesRegex(reference.ReferenceError,'Raw channels|not tangent'):
            reference.validate_dataset(target)

    def test_display_position_is_independently_checked(self):
        target = self.mutate('samples.json',lambda d:d['frames'][0]['values']['position'].__setitem__(40,5))
        with self.assertRaisesRegex(reference.ReferenceError,'Raw channels'):
            reference.validate_dataset(target)

    def test_sample_clock_cannot_be_relabelled(self):
        target = self.mutate('samples.json',lambda d:d['frames'][3].update(time=.4))
        with self.assertRaisesRegex(reference.ReferenceError,'sample time'):
            reference.validate_dataset(target)

    def test_formula_and_normalization_claims_are_semantically_validated(self):
        for change in [lambda d:d['normalization'].update(l2NormSquared=1),
                       lambda d:d['scope'].update(generalMeshPdeSolver=True),
                       lambda d:d['formulas'].update(gradient='ambient gradient'),
                       lambda d:d['parameters'].update(longitudes=48)]:
            target = self.mutate('model.json',change)
            with self.subTest(change=change),self.assertRaises(reference.ReferenceError):
                reference.validate_dataset(target)

    def test_rehashed_solver_scope_lie_still_fails_semantic_validation(self):
        target = self.mutate('samples.json',lambda d:d['solver']['parameters'].update(generalMeshPdeSolver=True))
        manifest = reference.read_json(target/'bake/manifest.json')
        manifest['solver'] = reference.read_json(target/'samples.json')['solver']
        write_json(target/'bake/manifest.json',manifest)
        imported = reference.read_json(target/'bake/import-report.json')
        imported.update(sourceSha256=reference.digest(target/'samples.json'),
                        manifestSha256=reference.digest(target/'bake/manifest.json'))
        write_json(target/'bake/import-report.json',imported)
        producer = reference.read_json(target/'report.json')
        producer['files'] = {name:reference.digest(target/name) for name in producer['files']}
        producer['manifestSha256'] = reference.digest(target/'bake/manifest.json')
        write_json(target/'report.json',producer)
        with self.assertRaisesRegex(reference.ReferenceError,'solver metadata'):
            reference.validate_dataset(target)

    def test_stored_exact_solution_cannot_claim_actual_rk4_replay(self):
        target = self.mutate('mode-states.json',lambda states:states[17].update(
            q=math.cos(2*math.pi*states[17]['t']/8)))
        with self.assertRaisesRegex(reference.ReferenceError,'replay'):
            reference.validate_dataset(target)

    def test_producer_report_counts_and_profile_are_checked(self):
        for key,value in [('sampleCount',64),('integrationSteps',512),('profile','mesh-fem'),
                          ('payloadBytes',0),('chunks',1)]:
            target = self.mutate('report.json',lambda d:d.update({key:value}))
            with self.subTest(key=key),self.assertRaisesRegex(reference.ReferenceError,'report counts'):
                reference.validate_dataset(target)

    def test_binary_corruption_and_stale_source_hashes_are_rejected(self):
        target = self.copied()
        chunk = target/'bake/chunk-000.bin'
        raw = bytearray(chunk.read_bytes());raw[-1] ^= 1;chunk.write_bytes(raw)
        with self.assertRaisesRegex(reference.ReferenceError,'hash mismatch'):
            reference.validate_dataset(target)
        target = self.mutate('model.json',lambda d:d['sourceProfile']['importer'].update(sha256='0'*64))
        producer = reference.read_json(target/'report.json')
        producer['files']['model.json'] = reference.digest(target/'model.json')
        write_json(target/'report.json',producer)
        with self.assertRaisesRegex(reference.ReferenceError,'importer source hash'):
            reference.validate_dataset(target)


if __name__=='__main__':unittest.main()
