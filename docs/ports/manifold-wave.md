# PR37: a verified single-mode wave on a sphere

This port adds a scientific sample producer and a separately implemented
reference verifier. It uses the PR36 temporal bake contract without changing the
runtime's scientific meaning. The producer performs a numerical time integration;
the browser and Chalkspace consume stored scalar, gradient and display-position
channels.

## Mathematical contract

The physical domain is the fixed sphere `S_R^2` in metres. The model is

```text
u_tt = c² Δ_S u,                       c in m/s
F(p) = 2xy/R²,
u(p,t) = F(p) q(t),
q'' + ω²q = 0,  ω = c√6/R,
q(0) = 1,  q'(0) = 0.
```

The sign convention is `Δ_S F = -6F/R²`. For `R=1` and
`c=2π/(8√6)`, the reference solution has `ω=π/4` and period eight seconds.
The mode has peak magnitude one. Its squared L2 norm is `16πR²/15`; it is
**not** normalized to L2 norm one.

The mode is a real degree-two spherical harmonic. The spherical-harmonic
definition and normalization convention are described in
[NIST DLMF §14.30](https://dlmf.nist.gov/14.30#i); the spherical-coordinate
Laplacian and eigenvalue relations appear in
[§14.30(iv)](https://dlmf.nist.gov/14.30#iv).
[DLMF §14.2(ii)](https://dlmf.nist.gov/14.2#ii) supplies the associated Legendre
equation behind separation into angular modes. Our calculations below use the
explicit real mode and do not rely on a spherical-harmonic library's phase or
normalization convention.

### Independent angular derivation

With colatitude `θ` and azimuth `φ`, the verifier starts with

```text
p = R(sinθ cosφ, sinθ sinφ, cosθ),
F = sin²θ sin(2φ),
F_θ = 2 sinθ cosθ sin(2φ),
F_φ = 2 sin²θ cos(2φ),
Δ_S F = [F_θθ + cotθ F_θ + F_φφ/sin²θ]/R² = -6F/R².
```

It constructs `∇_S F=(F_θ e_θ + (F_φ/sinθ)e_φ)/R` using the orthonormal
angular basis. The expression `F_φ/sinθ=2 sinθ cos(2φ)` stays finite at the
poles. This independently agrees with the producer's Cartesian expression

```text
∇_S u = q(t)[(2/R²)(y,x,0) - (4xy/R⁴)p].
```

The norm follows by integrating `sin⁵θ sin²(2φ) R²` over the angular rectangle.
The verifier also independently quadratures this integral and
`∫|∇_S F|² dA = (6/R²)∫F² dA`. No vertex-area weighting or display mesh is used
for those continuum integrals.

## What the producer actually computes

`tools/wave_samples.py` projects onto the one-dimensional spatial span of `F`.
Because that span is an eigenspace and the initial data lie in it, this spatial
reduction is exact for this initial-value problem. It then integrates the
two-component oscillator `(q,q')` with the classical fourth-order Runge–Kutta
method. It does not call cosine to obtain time samples.

Production settings are:

| Item | Value |
| --- | --- |
| Physical radius | 1 m |
| Duration | 8 s |
| Integration steps | 1024, with `dt=1/128` s |
| Stored knots | 65, every 16 steps / 0.125 s |
| Surface sample grid | 32 longitudes, 16 latitude intervals |
| Mesh | 482 vertices, 960 outward triangles, welded poles and seam |
| Binary storage | float64 little-endian; nine chunks |
| Display amplitude | 0.28 m |

Changing the number of surface sample points changes the geometry and sampling
density. It does not change the differential operator or constitute a spatial
PDE refinement experiment. General initial data, multimode coupling, arbitrary
manifolds, boundary conditions, finite elements and mesh Laplacians remain future
work.

### Raw fields and display geometry

| Channel | Unit | Meaning |
| --- | --- | --- |
| `scalar` | `1` | Dimensionless `F(p) q(t)` on the original sphere |
| `gradient` | `1/m` | Tangential gradient on the original sphere |
| `position` | `m` | Absolute display position `p + 0.28 u(p,t)n₀(p)` |

Here `n₀=p/R` is the **original** normal. The displaced sphere is a visualization
of the scalar field; it is not the domain on which the PDE is solved. The
gradient is not velocity and is not the gradient on the deformed display mesh.
Recomputed display normals affect lighting only. A zero display amplitude leaves
all physical fields and time states unchanged.

## Independent acceptance checks

`tools/reference_wave.py` does not import the producer's closed-form, gradient,
normalization or energy helpers. Its scientific truth is implemented in angular
coordinates. It imports only `integrate_mode` as the algorithm under test and for
an exact replay of the declared numerical provenance.

The ordinary Python test suite discovers
`tests/scientific/manifold_wave_test.py` through that directory's `__init__.py`.
It verifies:

1. Initial conditions, period, peak normalization and continuum L2 norm.
2. Angular Laplace–Beltrami identity and second-order finite-difference PDE
   residual convergence at points away from the coordinate poles.
3. Radius and wave-speed scaling, plus the gradient's inverse-length dimension.
4. RK4 convergence at 32, 64 and 128 steps against an independent cosine/sine
   solution. The norm is the maximum over all steps of
   `hypot(q-cos(ωt), q'/ω+sin(ωt))`, avoiding a misleading one-component
   end-of-period cancellation.
5. Every stored vertex and knot: scalar value, angularly reconstructed gradient,
   gradient tangency, radial display position and exact time-grid identity.
6. Replay of all stored modal states from the declared RK4 algorithm. This
   provenance check is separate from the exact-solution error measurement.
7. Separate interpolation and integration error measurements and bounds.
8. Current generator/importer hashes, all artifact hashes, chunk lengths and
   hashes, independently decoded binary values, topology, channel units and
   model/report/solver metadata agreement.

Negative tests alter raw scalar, gradient and position channels; timestamps;
normalization and model claims; stored mode states; chunk bytes; source hashes;
and producer report counts. A consistently rehashed false solver-scope claim is
also rejected: matching hashes alone are not scientific validation.

## Error accounting

The time integrator and playback interpolation have different errors. At stored
knots the numerical solution is compared to the exact solution. Between knots,
PR36 linearly interpolates saved values; it does not evaluate the cosine or run
the ODE again.

For the amplitude `q(t)=cos(ωt)` with knot spacing at most `h`, linear
interpolation of **exact** endpoint values has error at most `ω²h²/8`.
Interpolating numerical endpoints adds at most the maximum endpoint error.
Since `|F|≤1`, the same bound applies to the scalar field. This bound is not a
claim about gradient or position units; their fixed spatial factors must also
be applied.

For the integrator, write the phase-space state as `(q,q'/ω)`. When
`a=ω dt≤1`, the RK4 amplification polynomial at `ia` has magnitude at most one,
while the exponential Taylor remainder has norm at most `a⁵/120`. Telescoping
over `N` steps gives the conservative bound `N a⁵/120`, with a small additional
floating-point allowance in acceptance. The report separately records measured
errors; this argument does not cover unstable coarse steps.

`validation.json` records measured residuals and convergence orders rather than
placing machine-specific numbers in this document. The production interpolation
bound is approximately `0.001205`; it is much larger than the RK4 knot error.
Visual agreement alone cannot establish solver accuracy.

## Reproduce the evidence

Run from the repository root. Production generation publishes only into a new
directory and does not replace an existing dataset:

```sh
python tools/wave_samples.py --out build/manifold-wave-reproduced
python tools/reference_wave.py --data build/manifold-wave-reproduced
python -m unittest discover -s tests/scientific -p '*_test.py' -v
```

To revalidate the checked-in corpus explicitly:

```sh
python tools/reference_wave.py --data examples/data/manifold-wave --out examples/data/manifold-wave/validation.json
```

`report.json` is the producer's artifact report. `validation.json` is the
independent reference report, including its own source SHA-256, producer report
SHA-256 and verified source/artifact identities. The reference writes a passed
report only after every check succeeds. These hashes establish reproducibility
and change detection, not third-party certification.

Finite differences are sampled away from poles, and all numeric acceptance
uses floating-point arithmetic. The analytic derivation explains the continuum
model; the executable checks provide finite regression evidence, not a formal
proof or a general-purpose PDE solver qualification.
