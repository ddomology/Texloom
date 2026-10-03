# 3D curves and transported frames (PR32)

`Bundle.curves3d` generates sampled native 3D polylines and places existing mesh or group nodes along them. Sampling uses absolute scene time and the same typed parameter declarations as other expression programs. No callback, playback history, external frame counter or renderer object travels in the bundle.

## Authoring

```json
{
  "version": 1,
  "operations": [{
    "id": "helix",
    "resourceId": "helix",
    "units": "unit",
    "domain": [0, 12.566370614359172],
    "segments": 160,
    "position": ["radius*cos(u)", "radius*sin(u)", "0.18*u"],
    "frame": {
      "seed": {"kind": "up", "up": [0, 0, 1]},
      "twist": 1.5707963267948966,
      "closedSeam": "preserve"
    }
  }],
  "followers": [{
    "id": "move-arrow",
    "curveNode": "helix-path",
    "target": "traveller",
    "progress": "time / 8s"
  }]
}
```

The corresponding `space3d.nodes` contains a curve instance and a follower target:

```json
[
  {"kind": "group", "id": "common"},
  {"kind": "curve", "id": "helix-path", "resourceId": "helix",
   "parent": "common", "color": "#7bbcf5"},
  {"kind": "group", "id": "traveller", "parent": "common"}
]
```

Attach existing mesh children and native TeX overlays to `traveller`. This introduces no instancing, sweep or tube API. Each declared generated resource is available in `frame.resources`; no placeholder buffers belong in the authored bundle. Generated IDs must be distinct from all authored resources and surface outputs.

The optional TeX package `texloom-curve3d` captures literal JSON:

```tex
\loomspatialcurve{helix}|{"units":"unit","domain":[0,12.566370614359172],"segments":160,"position":["cos(u)","sin(u)","0.18*u"],"frame":{"seed":{"kind":"up","up":[0,0,1]}}}|
\loomfollowcurve{traveller}|{"id":"move-arrow","curveNode":"helix-path","progress":"time / 8s"}|
```

The compiler injects `resourceId`/`target`, defaults missing IDs to the corresponding argument, and archives JSON and expression source spans. See [the native example](../examples/curve-frames.tex).

## Numerical meaning

- The local coordinate `u` is dimensionless. Every coordinate expression returns a dimensionless scalar interpreted in the explicitly declared `unit`, `m`, `cm` or `mm` chart. These units must match `space3d.units`; there is no implicit bp conversion. A scene parameter named `u` is rejected. Time retains seconds, so normalize it explicitly, for example `time / 8s`.
- A fixed increasing grid samples both domain endpoints. Length is the sum of sampled chord lengths, not an analytic or certified curve length. `segments` is the author-controlled approximation budget; narrow features between samples can be missed.
- Follower `progress` is normalized chord length in `[0,1]`, including both endpoints. Invalid progress is an error; clamping or wrapping must be explicit in the authored expression. The scene evaluator clamps its input time to the scene duration before evaluating expressions.
- Vertex tangents use normalized sums of incoming and outgoing **unit** chord directions. Open endpoints use the adjoining chord. Duplicate adjacent points and reversing cusps are errors.
- Frames use discrete shortest-arc parallel transport. Local **+X is tangent**, **+Y is normal**, and **+Z is binormal**. Between grid vertices the frame quaternion uses shortest-path spherical interpolation. Its `tangent` is consequently the rotated +X direction; `chordTangent` separately records the actual piecewise-linear path direction. They need not be equal inside a segment.
- An explicit `seed` is required. `{kind:"up",up:[...]}` projects the supplied up direction orthogonally to the first tangent. A parallel or zero up direction is rejected. `{kind:"quaternion",rotation:[x,y,z,w]}` requires its +X direction to agree with the first tangent; the implementation does not silently rotate a mismatched seed.
- Optional `twist` is a total angle in radians distributed by sampled chord length. Default is zero. Its magnitude is bounded to one million turns. Each chord must carry strictly less than π radians of the combined seam correction and explicit twist. An under-resolved program raises `FRAME3D_TWIST_RESOLUTION`; increase `segments` rather than relying on shortest-path quaternion interpolation to recover unrecorded turns.
- `closed:true` requires endpoint agreement within `closureTolerance` (default `1e-9` in object units), then stores the last position exactly equal to the first. `closedSeam:"preserve"` keeps transported holonomy; `"distribute"` distributes the correction that closes the untwisted frame. Authored twist is applied afterward and can deliberately leave a seam. Reports include the base seam angle, applied correction and final seam angle. Open curves accept only the preserve policy.

## Coordinate and ownership rules

The curve instance and follower target must have the **same parent**, and the referenced curve instance must have an **identity local transform** with no transform tracks. Put any shared translation, quaternion rotation, scale or affine transform on their common group. The follower supplies its target's local translation and rotation; ancestor transforms apply once.

Targets are existing mesh or group nodes with TRS transforms. Their authored translation/rotation are replaced, while scale remains authored and may have a scale track. Matrix targets, multiple followers for one target, and target translation/rotation tracks are rejected. Camera targets are unsupported. A TeX overlay parented to a moving group follows its evaluated world transform normally.

There are at most 16 curve operations, 8192 segments per curve, 32768 segments across the program and 256 followers. Errors retain available declaration/expression spans. Invalid geometry, overflow, ambiguous transport and out-of-range progress fail the sample; the evaluator publishes no partial spatial frame.

## Evaluation and consumers

`prepareCurveProgram3D(program,bundle)` captures immutable declarations, compiles expressions once, validates the default sample, and exposes `baseResources`, `baseTransforms` and `sample(time,parameters?)`. The low-level sampler uses its supplied absolute time; `createEvaluator` supplies the already-clamped scene time.

`frame.curves3d.curves[operationId]` contains the generated `resourceId`, sampled `curve`, and prepared `frames`, including transport reports. `frame.curves3d.followers[followerId]` contains `curveNode`, `target`, `progress` and the complete frame `sample`: position, parameter, cumulative length, total length, segment index, local fraction, quaternion, tangent, chord tangent, normal and binormal.

`frame.space3d.curves[]` contains evaluated instance visibility, opaque color (default `#d4d9e2`), world/model-view matrices, world bounds and topology revision. GPU consumers draw a line strip with depth and world clipping; thickness and material lighting are not part of this contract. Native overlays remain a separate projected layer.

For lower-level consumers, `prepareSpace3DSampler` retains its existing first four arguments and adds an optional fifth dictionary of initial `{translation,rotation}` follower values. Each sample accepts current dynamic resource metadata as its second argument and the exact declared follower dictionary as its third. Preparation snapshots all declarations; subsequent caller mutation cannot alter validation or evaluation. Current bounds are checked before world transforms. Scale is never overwritten by this dictionary.

Runtime manifests inventory generated curve resources separately from transported assets. Capabilities are `curve.polyline.3d`, `frame.transport.3d` and `constraint.curve-follow.3d`; numeric and GPU profiles recognize them. The 2D-only renderer profiles reject spatial output explicitly.

## Acceptance coverage

Numeric tests exercise line, circle, helix, inflection, closed holonomy, seed orientation, reverse direction and singular/cusp cases. Program tests cover typed expressions and parameter overrides, immutable snapshots, follower scale, transformed parents, native overlay anchors, exact reverse/FPS-independent sampling, source spans, malformed contexts, writer conflicts, capability reporting, and coexistence with generated surfaces. Resource, package and renderer tests cover packed/inline/external transport and native line-strip output independently.
