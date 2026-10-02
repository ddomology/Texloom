# TikZ / PGF and Manim adoption study

Research date: 2026-10-02. Scope: official upstream sources and the current
Texloom v0.2 repository. Recommendations below are engineering conclusions,
not claims that arbitrary TikZ or Manim programs can already be converted.

## Architectural conclusion

Keep TeX as one authoring frontend, a versioned scene bundle as the interchange,
and one absolute-time evaluator feeding independent renderers. Broaden the
bundle with typed geometry, operation dependencies, resources, and author IDs.
Preserve original TeX/DVI and producer versions as provenance. They are not
sufficient substitutes for the semantic scene graph.

The current repository already has the correct boundary: `createEvaluator`
owns timing and dependencies, and `renderSvg` consumes evaluated state.
`loomnode` preserves PGF anchors, whereas `loompath` currently preserves only
static vector appearance. The immediate gap is native reusable geometry and a
second real rendering consumer. Chalkspace's present adapter places an SVG
overlay; it does not yet consume paths into its chalk material system.

## What to reuse from PGF

PGF has three software layers: the driver/system layer, a basic graphics layer,
and syntax frontends including TikZ. Graphics scopes carry transforms and paint
state. This supports adding a capture adapter while continuing to execute actual
TikZ. Scope boundaries must be interpreted carefully: TeX groups and PGF graphics
scopes do not give every setting identical lifetimes.
[Official hierarchy source](https://github.com/pgf-tikz/pgf/blob/master/doc/generic/pgf/pgfmanual-en-base-scopes.tex)

PGF's soft-path stage retains move, line, cubic, rectangle, and close operations
before backend emission. `pgfsyssoftpath@getcurrentpath` exposes this representation.
This is a useful geometry capture point. Capture original and decorated paths as
different objects when both matter. Record unit conversion, coordinate space,
paint, source location, and an explicit author ID alongside each capture.
[Official soft-path source](https://github.com/pgf-tikz/pgf/blob/master/doc/generic/pgf/pgfmanual-en-pgfsys-paths.tex)

| PGF facility | Adoption in Texloom | Remaining work |
| --- | --- | --- |
| Shapes, anchors, text layout, styles | Keep invoking PGF; export measured vector resources and explicit node anchors | Version fixtures, missing-anchor diagnostics, broader shape samples |
| Soft paths | Capture commands into a typed path resource | Preserve subpaths, winding, closure and unpainted guide paths |
| Coordinate transforms | Record normalized geometry plus the selected local transform contract | Distinguish coordinate transforms from canvas transforms and text behavior |
| Math / plot sampling | Execute at build time and retain samples / domain / units | A separate expression IR is needed for portable live parameter changes |
| Intersections | Use PGF as a reference for supported fixtures | Runtime solver needs tolerances and explicit branch-selection semantics |
| Decorations and arrow tips | First import PGF's final paint geometry | Dynamic regeneration needs typed parameters and operators |
| Graph drawing | Run an optional LuaTeX producer and export layout positions | Animated graph layout requires topology and a stable node map |

Coordinate transforms affect placement differently from canvas transforms;
blindly treating all PGF transformations as an SVG group changes stroke widths
and text. Exporters need deliberate lowering and comparison fixtures.
[Official transformation source](https://github.com/pgf-tikz/pgf/blob/master/doc/generic/pgf/pgfmanual-en-tikz-transformations.tex)

The math parser evaluates numerical expressions; plots may use coordinates,
external tables, sampled expressions, or gnuplot. Exporting the resulting path
does not retain the function that generated it. Treat PGF math as a compile-time
producer initially; preserve plot gaps and domain metadata rather than silently
joining discontinuities. Gnuplot-backed sources require their own producer path.
[Official math source](https://github.com/pgf-tikz/pgf/blob/master/doc/generic/pgf/pgfmanual-en-math-parsing.tex),
[official plot source](https://github.com/pgf-tikz/pgf/blob/master/doc/generic/pgf/pgfmanual-en-tikz-plots.tex)

PGF decorations construct geometry from a path. Importing that constructed result
is broad static support; maintaining a changing brace, zigzag or repeated marking
requires a live decoration operator with declared inputs. This distinction should
appear in the capability report.
[Official decoration source](https://github.com/pgf-tikz/pgf/blob/master/doc/generic/pgf/pgfmanual-en-tikz-decorations.tex)

PGF intersections expose solution counts, segment indices and optional ordering
along a path. For moving scenes, solution index alone is insufficient when
intersections appear, disappear or exchange order. Texloom should define policies
such as `firstAlong(path)`, author-selected branch, and `missing: hide|error`;
never substitute the origin for a missing geometric result.
[Official intersection implementation](https://github.com/pgf-tikz/pgf/blob/master/tex/generic/pgf/libraries/pgflibraryintersections.code.tex)

PGF graph drawing has a separate Lua algorithm layer and bindings to display
systems. Its TikZ integration requires LuaTeX. An optional layout producer can
reuse this division without making LuaTeX mandatory for ordinary scenes.
[Official graph-drawing architecture](https://github.com/pgf-tikz/pgf/blob/master/doc/generic/pgf/pgfmanual-en-gd-overview.tex),
[official user manual](https://pgf-tikz.github.io/pgf/pgfmanual.pdf)

## What to adopt from Manim

Manim's `Mobject` hierarchy carries subobjects; structural and point alignment
prepare objects for interpolation. Texloom should make correspondence explicit:
stable subobject IDs, named formula parts, and an authored mapping between source
and destination. Geometry being numerically alignable does not mean its parts
have the intended mathematical correspondence.
[Mobject API](https://docs.manim.community/en/stable/reference/manim.mobject.mobject.Mobject.html)

`VMobject` stores cubic geometry and exposes partial paths. A transferable design
is a geometry kernel providing evaluation, derivatives, splitting, bounds and
subpaths. Reveal should return an actual partial path available to both Canvas
and SVG; an SVG-only dash trick cannot be the canonical animation result. Specify
whether progress means cubic parameter, segment proportion or arc length.
[VMobject API](https://docs.manim.community/en/stable/reference/manim.mobject.types.vectorized_mobject.VMobject.html),
[partial-path implementation](https://docs.manim.community/en/stable/_modules/manim/mobject/types/vectorized_mobject.html#VMobject.pointwise_become_partial)

`Transform` copies and aligns target structure before interpolating. Start with
same-topology interpolation; add resampling and matching as explicit preparation
operations. Preserve contour orientation and holes; unsupported correspondence
should produce a diagnostic or an explicitly requested crossfade.
[Transform source](https://docs.manim.community/en/stable/_modules/manim/animation/transform.html#Transform.begin)

`TransformMatchingTex` matches subobjects through their TeX string keys. Repeated
identical symbols are ambiguous for teaching; author IDs and source spans can
provide better deterministic identity in Texloom. Glyph contours do not encode
pen stroke order, so outline reveal must not be described as recovered handwriting.
[TransformMatchingTex API](https://docs.manim.community/en/stable/reference/manim.animation.transform_matching_parts.TransformMatchingTex.html)

`AnimationGroup` computes child timing and supports overlap through `lag_ratio`.
Texloom can lower `sequence`, `parallel`, `stagger` and time remapping into fixed
intervals and absolute-time tracks. Conflict validation should happen after this
lowering, with deliberate composition modes rather than implicit last writer wins.
[AnimationGroup API](https://docs.manim.community/en/stable/reference/manim.animation.composition.AnimationGroup.html)

Manim's scene update loop passes elapsed `dt` to updaters as well as interpolating
animation progress. Arbitrary Python updaters can depend on previous state and
external data. They cannot be copied as JSON relations and remain random-seek
safe. Support pure typed dependencies, or bake a producer's simulation output
with explicit timestamps, interpolation and provenance.
[Current scene update source](https://docs.manim.community/en/stable/_modules/manim/scene/scene.html#Scene.update_to_time)

The internals guide describes static/moving separation and type-based drawing
batches, but explicitly states that its architectural account targets v0.16.0
and primarily Cairo. Use it as a design reference, not a promise about every
current backend. Texloom can cache immutable resources and operation results
while retaining paint order and isolated group opacity.
[Manim internals guide and version caveat](https://docs.manim.community/en/stable/guides/deep_dive.html)

## Reuse, porting and licenses

Prefer normal tool invocation plus adapters for TeX/PGF layout and external
simulation generation. Reading an algorithm and implementing an independently
specified operation is a different engineering activity from translating source
files. Any copied or translated code needs a recorded upstream file, revision,
license, copyright notice and modifications.

PGF's top-level notice offers its code under GPL version 2 or LPPL version 1.3c;
documentation has GFDL version 1.2 or LPPL version 1.3c. Check individual file
headers and the chosen license before a source port; the distinction matters
because documentation and code are not under identical terms.
[PGF license notice](https://github.com/pgf-tikz/pgf/blob/master/doc/generic/pgf/licenses/LICENSE)

Manim Community has MIT notices for 3Blue1Brown LLC and the Manim Community
Developers. The notices require copyright and permission notices with copied
or substantial portions. Dependencies and example assets need separate checks.
This study does not copy upstream implementation into Texloom.
[MIT notice](https://github.com/ManimCommunity/manim/blob/main/LICENSE),
[community MIT notice](https://github.com/ManimCommunity/manim/blob/main/LICENSE.community)

## Next implementation sequence and acceptance gates

1. **Shared consumers:** native Canvas renderer beside SVG, using the same
   evaluated frame. Verify resource baseline, transforms, clips, currentColor,
   arrowheads and nested group opacity against browser SVG. Consume it in a real
   Chalkspace host. Record backend capability decisions instead of silently
   dropping unsupported objects.
2. **Geometry kernel:** typed multi-contour paths and explicit point identity;
   cubic evaluation/split/derivative/bounds, arc-length tables with tolerance,
   reveal and point/tangent/normal constraints. Test degeneracy, zero-length
   paths, parent transforms and random seeking.
3. **PGF capture:** attach named soft paths to that geometry; compare several
   library-generated fixtures to native PGF output. Retain unsupported constructs
   as named static resources only when the importer can reproduce them.
4. **Animation composition:** sequence/parallel/stagger, formula-part mapping and
   prepared path morphs. Require an explicit correspondence report for morphs.
5. **Broader producers:** graph layouts, plots, mesh/field and sampled simulation
   resources. Add renderer capabilities and baked output fallbacks per resource;
   portable geometry is not equivalent to arbitrary Blender modifiers or Python
   programs.

The first milestone demonstrates that adding one geometry operation reaches web,
SVG/video and Chalkspace through a common evaluated frame. Later milestones
expand the kinds of mathematics represented; none claims complete conversion of
the combined TikZ, Blender and Manim ecosystems.
