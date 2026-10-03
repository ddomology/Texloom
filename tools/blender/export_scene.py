"""Export Blender 4.5.9 evaluated meshes as bounded, portable Texloom data.

Run Blender --background source.blend --python export_scene.py -- --out NEW_DIR
--times 0,0.25,1,2,4,6,8. Times are seconds from scene.frame_start. Blender
evaluates every declared knot; consumers interpolate the resulting samples and
never execute Blender modifiers, shaders, drivers, or dependency graphs.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
from pathlib import Path
import struct
import sys
import tempfile

PINNED_VERSION = (4, 5, 9)
MAX_OBJECTS = 256
MAX_RESOURCES = 64
MAX_VERTICES = 65536
MAX_TRIANGLES = 87381
MAX_SAMPLES = 256
MAX_BYTES = 64 * 1024 * 1024
CHUNK_FRAMES = 8
SEED = 3801


class BlenderExportError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(f'{code}: {message}')


def require(condition, code, message):
    if not condition:
        raise BlenderExportError(code, message)


def canonical(value):
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'),
                       allow_nan=False) + '\n').encode('utf8')


def sha(value):
    return hashlib.sha256(value).hexdigest()


def finite(values, context):
    require(all(type(x) in (int, float) and math.isfinite(x) for x in values),
            'BLENDER_NONFINITE', f'Nonfinite values in {context}.')


def parse_times(text):
    try:
        values = [float(item.strip()) for item in text.split(',')]
    except (AttributeError, ValueError) as error:
        raise BlenderExportError('BLENDER_TIMES', 'Times must be comma-separated finite seconds.') from error
    require(1 <= len(values) <= MAX_SAMPLES and all(math.isfinite(t) for t in values)
            and values[0] == 0 and all(a < b for a, b in zip(values, values[1:])),
            'BLENDER_TIMES', 'Declare 1..256 strictly increasing finite times starting at zero.')
    return values


def normalize(vector, context):
    values = [float(x) for x in vector]
    finite(values, context)
    length = math.hypot(*values)
    require(math.isfinite(length) and length > 0, 'BLENDER_NORMAL', f'Zero normal in {context}.')
    return [x / length for x in values]


def buffer(data, components, component_type='float64'):
    return {'version': 1, 'componentType': component_type, 'components': components,
            'count': len(data) // components, 'byteOffset': 0,
            'byteStride': components * (8 if component_type == 'float64' else 4), 'data': data}


def linear_hex(color):
    rgb = [float(x) for x in color[:3]]
    finite(rgb, 'material RGB')
    require(all(0 <= x <= 1 for x in rgb), 'BLENDER_MATERIAL', 'Material RGB must be in linear [0,1].')
    encoded = [12.92*x if x <= .0031308 else 1.055*x**(1/2.4)-.055 for x in rgb]
    return '#' + ''.join(f'{min(255,max(0,math.floor(x*255+.5))):02x}' for x in encoded)


def material_for(mesh, evaluated, policy, unsupported):
    """Only an opaque constant diffuse/Principled base color is represented."""
    used = sorted({p.material_index for p in mesh.polygons})
    materials = evaluated.material_slots
    reasons = []
    if len(used) > 1:
        reasons.append('Multiple face materials are outside the single-color profile.')
    index = used[0] if used else 0
    material = materials[index].material if index < len(materials) else None
    if material is None:
        rgba = (.8, .8, .8, 1)
        label = '(default)'
    else:
        label = material.name
        rgba = tuple(material.diffuse_color)
        if material.use_nodes:
            nodes = material.node_tree.nodes
            outputs = [n for n in nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output]
            shader = None
            if len(outputs) == 1 and len(outputs[0].inputs['Surface'].links) == 1:
                shader = outputs[0].inputs['Surface'].links[0].from_node
            if shader is None or shader.type != 'BSDF_PRINCIPLED':
                reasons.append('Surface must directly reference one Principled BSDF.')
            elif shader.inputs['Base Color'].is_linked or shader.inputs['Alpha'].is_linked:
                reasons.append('Linked color or opacity is unsupported.')
            else:
                rgba = tuple(shader.inputs['Base Color'].default_value)
                if shader.inputs['Alpha'].default_value != 1:
                    reasons.append('Transparent material is unsupported.')
                for name in ('Transmission Weight', 'Emission Strength'):
                    socket = shader.inputs.get(name)
                    if socket and (socket.is_linked or socket.default_value != 0):
                        reasons.append(f'{name} is outside the opaque unlit color profile.')
            if len(outputs) == 1 and outputs[0].inputs['Displacement'].is_linked:
                reasons.append('Material displacement is unsupported.')
            if len(outputs) == 1 and outputs[0].inputs['Volume'].is_linked:
                reasons.append('Material volume is unsupported.')
        elif rgba[3] != 1:
            reasons.append('Transparent diffuse material is unsupported.')
    if reasons:
        message = ' '.join(reasons)
        entry = {'code': 'BLENDER_UNSUPPORTED_MATERIAL', 'subject': evaluated.original.name + ':' + label,
                 'message': message}
        if entry not in unsupported:
            unsupported.append(entry)
        require(policy == 'fallback', 'BLENDER_UNSUPPORTED_MATERIAL', entry['subject'] + ': ' + message)
        # A declared opaque viewport-color proxy. No unsupported shader executes.
        rgba = tuple(material.diffuse_color) if material else (.8, .8, .8, 1)
    return linear_hex(rgba)


def entry_identity(entry):
    obj = entry.object.original
    parent = entry.parent.original.name if entry.parent else (obj.parent.name if obj.parent else None)
    persistent = [int(x) for x in entry.persistent_id]
    identity = [obj.name, parent, bool(entry.is_instance), persistent]
    return 'object-' + sha(canonical(identity))[:24], parent, persistent


def converted_matrix(matrix, unit_scale):
    # p_m = s*p_blender; M_m = S*M_blender*S^-1. Linear axes stay unchanged.
    result = [float(matrix[row][column]) for column in range(4) for row in range(4)]
    for index in (12, 13, 14):
        result[index] *= unit_scale
    finite(result, 'world matrix')
    require(result[3] == result[7] == result[11] == 0 and result[15] == 1,
            'BLENDER_MATRIX', 'Expected an affine instance transform.')
    a,b,c,d,e,f,g,h,i = (result[k] for k in (0,4,8,1,5,9,2,6,10))
    determinant = a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g)
    require(math.isfinite(determinant) and determinant != 0,
            'BLENDER_SINGULAR_TRANSFORM', 'Singular world transforms are unsupported.')
    return result


def mesh_snapshot(evaluated, depsgraph, unit_scale, material_policy, unsupported):
    """Temporary evaluated data is owned by this call and released on every path."""
    mesh = None
    try:
        mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
        require(mesh is not None, 'BLENDER_MESH', f'Cannot evaluate mesh {evaluated.name}.')
        require(len(mesh.vertices) <= MAX_VERTICES and len(mesh.polygons) <= MAX_TRIANGLES,
                'BLENDER_BUDGET', 'Evaluated mesh exceeds the geometry budget.')
        mesh.calc_loop_triangles()
        require(0 < len(mesh.loop_triangles) <= MAX_TRIANGLES and 3*len(mesh.loop_triangles) <= MAX_VERTICES,
                'BLENDER_BUDGET', 'Triangle-corner mesh must contain 1..65536 vertices.')
        color = material_for(mesh, evaluated, material_policy, unsupported)
        positions, normals, source_corners = [], [], []
        for triangle in mesh.loop_triangles:
            for loop_index in triangle.loops:
                vertex_index = mesh.loops[loop_index].vertex_index
                positions.extend(float(x)*unit_scale for x in mesh.vertices[vertex_index].co)
                normals.extend(normalize(mesh.corner_normals[loop_index].vector, 'evaluated corner normal'))
                source_corners.append([int(loop_index), int(vertex_index), int(triangle.polygon_index)])
        finite(positions, 'evaluated positions')
        # Original vertex/loop incidence is retained even though output indices
        # are sequential; topology changes cannot hide behind corner expansion.
        topology = {'vertices': len(mesh.vertices), 'loops': len(mesh.loops),
                    'polygons': [list(p.vertices) for p in mesh.polygons], 'corners': source_corners}
        return {'positions': positions, 'normals': normals, 'topology': topology,
                'evaluatedVertices': len(mesh.vertices), 'color': color}
    finally:
        if mesh is not None:
            evaluated.to_mesh_clear()


def collect_frames(bpy, times, material_policy, unsupported):
    scene = bpy.context.scene
    fps = float(scene.render.fps) / float(scene.render.fps_base)
    scale = float(scene.unit_settings.scale_length)
    finite([fps, scale], 'scene units/time')
    require(fps > 0 and scale > 0, 'BLENDER_UNITS', 'Positive scene FPS and meters per unit are required.')
    original_frame, original_subframe = scene.frame_current, scene.frame_subframe
    all_frames = []
    retained_snapshot_bytes = 0
    try:
        for time in times:
            frame_value = scene.frame_start + time*fps
            require(math.isfinite(frame_value) and -1048574 <= frame_value <= 1048574,
                    'BLENDER_TIMES', 'Requested time exceeds Blender frame limits.')
            frame = math.floor(frame_value)
            scene.frame_set(frame, subframe=frame_value-frame)
            depsgraph = bpy.context.evaluated_depsgraph_get()
            current = {}
            for entry in depsgraph.object_instances:
                evaluated = entry.object
                if not entry.show_self:
                    continue
                if evaluated.type in ('EMPTY', 'LIGHT', 'CAMERA'):
                    continue
                require(evaluated.type == 'MESH', 'BLENDER_UNSUPPORTED_GEOMETRY',
                        f'Visible {evaluated.type} geometry {evaluated.original.name} is outside the mesh profile.')
                require(len(current) < MAX_OBJECTS, 'BLENDER_BUDGET', 'At most 256 evaluated mesh instances.')
                key, parent, persistent = entry_identity(entry)
                require(key not in current, 'BLENDER_INSTANCE_ID', 'Duplicate evaluated instance identity.')
                obj = evaluated.original
                data = mesh_snapshot(evaluated, depsgraph, scale, material_policy, unsupported)
                retained_snapshot_bytes += 8*(len(data['positions'])+len(data['normals']))
                require(retained_snapshot_bytes <= MAX_BYTES, 'BLENDER_BUDGET',
                        'Retained sampled positions and normals exceed 64 MiB before publication.')
                data.update(key=key, sourceObject=obj.name, sourceData=obj.data.name,
                            parent=parent, persistentId=persistent, isInstance=bool(entry.is_instance),
                            originalVertices=len(obj.data.vertices),
                            modifiers=[{'name':m.name,'type':m.type} for m in obj.modifiers if m.show_viewport],
                            matrix=converted_matrix(entry.matrix_world, scale))
                current[key] = data
            require(current, 'BLENDER_EMPTY', 'No evaluated mesh instances are available.')
            if all_frames:
                require(set(current) == set(all_frames[0]), 'BLENDER_INSTANCE_TOPOLOGY',
                        'The set of evaluated instances changes at a declared sample time.')
            all_frames.append(current)
    finally:
        scene.frame_set(original_frame, subframe=original_subframe)
    return all_frames, fps, scale


def mesh_resource(first):
    positions, normals = first['positions'], first['normals']
    count = len(positions)//3
    indices = list(range(count))
    return {'kind':'mesh','version':1,'primitive':'triangles','units':'m','coordinateSpace':'object','winding':'ccw',
            'topologyRevision':'blender-triangles-' + sha(canonical(first['topology']))[:24],
            'positions':buffer(positions,3),'normals':buffer(normals,3),
            'indices':buffer(indices,1,'uint32'),
            'bounds':{'min':[min(positions[j::3]) for j in range(3)],
                      'max':[max(positions[j::3]) for j in range(3)]}}


def bake_resource(mesh, frames, times, source_sha):
    # PR36's existing frame-major/channel-order float64 LE position contract.
    chunks = []
    for start in range(0,len(times),CHUNK_FRAMES):
        selected = frames[start:start+CHUNK_FRAMES]
        raw = b''.join(struct.pack('<'+'d'*len(frame['positions']),*frame['positions']) for frame in selected)
        chunks.append({'id':f'chunk-{len(chunks)}','startSample':start,'sampleCount':len(selected),
                       'byteLength':len(raw),'sha256':sha(raw),
                       'source':{'kind':'inline','data':base64.b64encode(raw).decode('ascii')}})
    return {'version':1,'units':'m','timeUnit':'s',
            'topology':{'revision':mesh['topologyRevision'],'vertexCount':mesh['positions']['count'],
                        'indices':mesh['indices']['data']},
            'sampleTimes':times,'interpolation':'linear','outside':'clamp','seed':SEED,
            'solver':{'name':'Blender evaluated dependency graph','version':'4.5.9',
                      'parameters':{'sourceBlendSha256':source_sha,'normalPolicy':'recomputed-triangle',
                                    'topologyPolicy':'fixed-exact-corner-incidence'}},
            'channels':[{'id':'position','kind':'position','componentType':'float64','unit':'m'}],
            'chunks':chunks}


def trs_tracks(matrices, times, target):
    from mathutils import Matrix
    records = []
    previous_quaternion = None
    previous_signs = None
    for values in matrices:
        matrix = Matrix([[values[column*4+row] for column in range(4)] for row in range(4)])
        location, quaternion, scale = matrix.decompose()
        reconstructed = Matrix.LocRotScale(location, quaternion, scale)
        # Translation magnitude cannot relax the shear rejection criterion.
        # Decomposition uses Blender's float32 mathutils; inspect only its
        # linear block and retain our meter-converted translation in float64.
        error = max(abs(float(reconstructed[row][column])-values[column*4+row])
                    for row in range(3) for column in range(3))
        linear_scale = max(abs(values[column*4+row]) for row in range(3) for column in range(3))
        tolerance = 1e-6 * linear_scale
        require(error <= tolerance, 'BLENDER_ANIMATED_SHEAR',
                'Animated transform cannot be represented by validated TRS; shear requires a different profile.')
        signs = tuple(1 if x>0 else -1 if x<0 else 0 for x in scale)
        require(0 not in signs and (previous_signs is None or signs == previous_signs),
                'BLENDER_ANIMATED_SCALE', 'Animated scales must remain nonzero with consistent signs.')
        previous_signs = signs
        if previous_quaternion is not None and quaternion.dot(previous_quaternion)<0:
            quaternion.negate()
        previous_quaternion = quaternion.copy()
        records.append({'translation':values[12:15],
                        'rotation':[float(quaternion.x),float(quaternion.y),float(quaternion.z),float(quaternion.w)],
                        'scale':[float(x) for x in scale]})
    return records[0], [{'target':target,'property':name,'keys':[[t,r[name]] for t,r in zip(times,records)],
                         'interpolation':'linear'} for name in ('translation','rotation','scale')]


def build_manifest(bpy, times, material_policy):
    require(tuple(bpy.app.version)==PINNED_VERSION, 'BLENDER_VERSION', 'This producer requires Blender 4.5.9.')
    require(material_policy in ('error','fallback'), 'BLENDER_MATERIAL_POLICY', 'Unknown material policy.')
    times = parse_times(','.join(str(t) for t in times))
    source = Path(bpy.data.filepath)
    # Blender may mark a freshly loaded file dirty during version/depsgraph
    # initialization. The supported entry point loads source.blend immediately
    # before this script; the hash authenticates that saved source, not an
    # imaginary byte serialization of Blender's in-memory dependency graph.
    require(source.is_file(), 'BLENDER_SOURCE', 'A saved source .blend is required.')
    source_hash = sha(source.read_bytes())
    unsupported = []
    snapshots, fps, unit_scale = collect_frames(bpy,times,material_policy,unsupported)
    resources, bakes, operations, records, groups = {}, {}, [], [], {}
    total_vertices = total_triangles = total_bake_bytes = 0
    for key in sorted(snapshots[0]):
        frames = [snapshot[key] for snapshot in snapshots]
        first = frames[0]
        require(all(f['topology']==first['topology'] for f in frames), 'BLENDER_TOPOLOGY_CHANGE',
                f"Evaluated mesh topology changes for {first['sourceObject']}.")
        require(all(f['color']==first['color'] for f in frames), 'BLENDER_ANIMATED_MATERIAL',
                'Animated material color is unsupported by this profile.')
        moving_geometry = any(f['positions'] != first['positions'] for f in frames[1:])
        require(moving_geometry or all(f['normals']==first['normals'] for f in frames),
                'BLENDER_ANIMATED_NORMALS', 'Independent normal animation without position change is unsupported.')
        moving_transform = any(f['matrix'] != first['matrix'] for f in frames[1:])
        fingerprint = sha(canonical({'positions':[f['positions'] for f in frames],
                                     'normals':first['normals'],'topology':first['topology']}))[:24]
        base_id = 'mesh-'+fingerprint
        rendered_id = 'sampled-'+fingerprint if moving_geometry else base_id
        if base_id not in resources:
            mesh = mesh_resource(first)
            resources[base_id] = mesh
            total_vertices += mesh['positions']['count']
            total_triangles += mesh['indices']['count']//3
            require(len(resources)<=MAX_RESOURCES and total_vertices<=MAX_VERTICES and total_triangles<=MAX_TRIANGLES,
                    'BLENDER_BUDGET', 'Aggregate mesh budget exceeded.')
            if moving_geometry:
                require(len(bakes)<16, 'BLENDER_BUDGET', 'At most 16 deforming meshes.')
                bake_id = 'bake-'+fingerprint
                payload_bytes = len(times)*len(first['positions'])*8
                require(total_bake_bytes+payload_bytes <= MAX_BYTES, 'BLENDER_BUDGET', 'Aggregate bake exceeds 64 MiB.')
                total_bake_bytes += payload_bytes
                bakes[bake_id] = bake_resource(mesh,frames,times,source_hash)
                operations.append({'id':'sample-'+fingerprint,'source':base_id,'resourceId':rendered_id,
                                   'bake':bake_id,'units':'m','attributes':[],
                                   'position':{'channel':'position','normalPolicy':'recompute','degenerateNormalPolicy':'error'}})
        row = {name:first[name] for name in ('key','sourceObject','sourceData','isInstance','parent','persistentId','originalVertices','evaluatedVertices','modifiers')}
        row.update(resourceId=rendered_id,nodeId=None,setId=None,instanceId=None,
                   outputVertices=len(first['positions'])//3,geometry='baked' if moving_geometry else 'converted',
                   transform='baked-trs' if moving_transform else 'preserved-matrix',
                   normalPolicy='recomputed-triangle' if moving_geometry else 'preserved-corner',material=first['color'])
        record = {'row':row,'frames':frames,'animated':moving_transform}
        records.append(record)
        if not moving_transform:
            groups.setdefault((rendered_id,first['color']),[]).append(record)
    nodes, sets, tracks = [], {}, []
    for (resource_id,color),members in sorted(groups.items()):
        if len(members)<2:
            continue
        suffix = sha(canonical([resource_id,color,[r['row']['key'] for r in members]]))[:24]
        set_id,node_id = 'set-'+suffix,'batch-'+suffix
        instances=[]
        for record in members:
            row=record['row'];instance_id='instance-'+row['key'][7:]
            row.update(nodeId=None,setId=set_id,instanceId=instance_id)
            instances.append({'id':instance_id,'transform':{'matrix':record['frames'][0]['matrix']}})
        sets[set_id]={'version':1,'prototypeResourceId':resource_id,'units':'m','instances':instances}
        nodes.append({'id':node_id,'kind':'instances','instanceSetId':set_id,
                      'material':{'kind':'unlit','color':color,'side':'front'}})
    for record in records:
        row=record['row']
        if row['setId'] is not None:
            continue
        node_id='node-'+row['key'][7:];row['nodeId']=node_id
        transform={'matrix':record['frames'][0]['matrix']}
        if record['animated']:
            transform, sampled_tracks=trs_tracks([f['matrix'] for f in record['frames']],times,node_id)
            tracks.extend(sampled_tracks)
        nodes.append({'id':node_id,'kind':'mesh','resourceId':row['resourceId'],'transform':transform,
                      'material':{'kind':'unlit','color':row['material'],'side':'front'}})
    config={'materialPolicy':material_policy,'normalPolicy':'corner-static-triangle-recomputed-bake',
            'triangulation':'evaluated-loop-triangles','interpolation':'linear','chunkFrames':CHUNK_FRAMES,
            'seed':SEED,'blenderBuildHash':bpy.app.build_hash.decode('ascii')}
    report={'config':config,'configSha256':sha(canonical(config)),
            'counts':{'objects':len(records),'resources':len(resources),'instanceSets':len(sets),
                      'instances':sum(len(s['instances']) for s in sets.values()),'bakes':len(bakes),
                      'vertices':total_vertices,'triangles':total_triangles,'bakeBytes':total_bake_bytes},
            'objects':[record['row'] for record in records],
            'preserved':['Right-handed Z-up basis.','Static affine matrices including shear and negative scale.',
                         'Shared evaluated prototype geometry.','Static evaluated corner-normal directions.'],
            'converted':['Scene length scale applied once to local positions and world translation in meters.',
                         'EMPTY containers, LIGHT and CAMERA objects are excluded by profile; the TeX scene supplies its camera and annotations.',
                         'Evaluated loop triangles expanded to stable triangle corners.',
                         'Opaque constant linear RGB converted to sRGB #rrggbb unlit color; lighting and PBR shading are not exported.',
                         'Changing geometry uses recomputed triangle normals; source corner normals are not mislabelled as deformed normals.'],
            'baked':['Evaluated positions at explicitly declared times; linear interpolation is a playback approximation.',
                     'Animated transforms sampled as validated TRS; quaternion interpolation takes the shortest arc.'],
            'unsupported':unsupported}
    return {'version':1,'profile':'blender-evaluated/1',
            'producer':{'name':'Blender','version':'4.5.9','script':{'path':'tools/blender/export_scene.py','sha256':sha(Path(__file__).read_bytes())}},
            'source':{'blend':{'path':source.name,'sha256':source_hash},'scene':bpy.context.scene.name},
            'coordinates':{'units':'m','handedness':'right','upAxis':'z','metersPerBlenderUnit':unit_scale},
            'time':{'unit':'s','duration':times[-1],'sampleTimes':times,'fps':fps,'frameStart':bpy.context.scene.frame_start},
            'resources':resources,'instanceSets':sets,'bakes':bakes,'sampledFields':{'version':1,'operations':operations},
            'space3d':{'version':1,'units':'m','handedness':'right','upAxis':'z','nodes':nodes,'tracks':tracks},
            'report':report}


def export_scene(output, times, material_policy='error'):
    import bpy
    output=Path(output)
    require(not output.exists(), 'BLENDER_OUTPUT', 'Output must be a new directory; existing files are never replaced.')
    manifest=build_manifest(bpy,times,material_policy)
    data=canonical(manifest)
    require(len(data)<=128*1024*1024, 'BLENDER_BUDGET', 'Encoded manifest exceeds 128 MiB.')
    output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.blender-export-',dir=output.parent) as temporary:
        stage=Path(temporary)
        (stage/'manifest.json').write_bytes(data)
        (stage/'report.json').write_bytes(canonical(manifest['report']))
        stage.rename(output)
    return manifest


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out',required=True,type=Path)
    parser.add_argument('--times',required=True)
    parser.add_argument('--unsupported-material',choices=('error','fallback'),default='error')
    argv=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    args=parser.parse_args(argv)
    try:
        manifest=export_scene(args.out,parse_times(args.times),args.unsupported_material)
        print(json.dumps({'status':'exported','manifest':str(args.out/'manifest.json'),
                          'manifestSha256':sha(canonical(manifest)),'counts':manifest['report']['counts']},sort_keys=True))
    except (OSError,ValueError,TypeError,RuntimeError) as error:
        print(str(error),file=sys.stderr)
        raise SystemExit(1)


if __name__=='__main__':
    main()
