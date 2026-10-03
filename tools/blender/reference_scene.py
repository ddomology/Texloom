"""Record an independent Blender depsgraph coordinate/normal oracle.

Run in pinned Blender 4.5.9 after loading the fixture. This script never imports
the exporter or its axis, unit, normal, matrix, identity or triangulation helpers.
The world-coordinate oracle uses Blender's own mathutils operations directly.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sys

import bpy


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def vector(value):return [float(x) for x in value]
def matrix(value):return [float(value[row][column]) for column in range(4) for row in range(4)]


def reference(times):
    if bpy.app.version[:3]!=(4,5,9):raise RuntimeError('Reference requires Blender 4.5.9.')
    scene=bpy.context.scene;factor=float(scene.unit_settings.scale_length);fps=scene.render.fps/scene.render.fps_base
    records=[]
    for time in times:
        exact=scene.frame_start+time*fps;frame=math.floor(exact);scene.frame_set(frame,subframe=exact-frame)
        graph=bpy.context.evaluated_depsgraph_get();instances=[]
        for item in graph.object_instances:
            evaluated=item.object
            if evaluated.type!='MESH':continue
            original=evaluated.original;owner=item.parent.original.name if item.is_instance and item.parent else None
            transform=item.matrix_world.copy();normal_transform=transform.to_3x3().inverted().transposed()
            mesh=evaluated.to_mesh(preserve_all_data_layers=True,depsgraph=graph)
            try:
                mesh.calc_loop_triangles()
                local=[vector(v.co) for v in mesh.vertices]
                world=[vector((transform@v.co)*factor) for v in mesh.vertices]
                triangles=[list(triangle.vertices) for triangle in mesh.loop_triangles]
                # Corner normals preserve both smooth and split/flat shading.
                normals=[];corner_vertices=[];corner_positions=[]
                for triangle in mesh.loop_triangles:
                    for vertex_index,loop_index in zip(triangle.vertices,triangle.loops):
                        corner_vertices.append(int(vertex_index));corner_positions.append(world[vertex_index])
                        n=normal_transform@mesh.corner_normals[loop_index].vector
                        if n.length==0:raise RuntimeError('Reference encountered a zero normal.')
                        normals.append(vector(n.normalized()))
                instances.append({'sourceObject':original.name,'parent':owner,'isInstance':bool(item.is_instance),
                    'persistentId':[int(v) for v in item.persistent_id],
                    'matrixWorld':matrix(transform),'determinant':float(transform.to_3x3().determinant()),
                    'authoredVertexCount':len(original.data.vertices),'evaluatedVertexCount':len(mesh.vertices),
                    'triangleCount':len(triangles),'localPositions':local,'worldPositionsMeters':world,
                    'triangles':triangles,'cornerVertexIndices':corner_vertices,
                    'cornerWorldPositionsMeters':corner_positions,'cornerWorldNormals':normals,
                    'materials':[{'name':m.name,'color':vector(m.diffuse_color),'usesNodes':m.use_nodes} for m in mesh.materials if m]})
            finally:evaluated.to_mesh_clear()
        instances.sort(key=lambda r:(r['sourceObject'],r['parent'] or '',r['persistentId']))
        records.append({'time':time,'blenderFrame':exact,'instances':instances})
    return {'version':1,'profile':'independent-blender-depsgraph-reference/1',
        'blenderVersion':bpy.app.version_string,'sourceBlendSha256':sha(bpy.data.filepath),
        'referenceScriptSha256':sha(__file__),'metersPerBlenderUnit':factor,
        'sampleTimes':times,'frames':records,
        'normalPolicy':'Independent inverse-transpose world normal from evaluated Blender loop normal; no determinant sign multiplication.',
        'scope':'Exact evaluated samples only; no claim of exact Blender motion between exported knots.'}


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--out',required=True);parser.add_argument('--times',default='0,0.25,1,2,4,6,8')
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    times=[float(t) for t in args.times.split(',')]
    if not times or any(not math.isfinite(t) or t<0 for t in times) or any(a>=b for a,b in zip(times,times[1:])):raise ValueError('Times must be finite, nonnegative and strictly increasing.')
    result=reference(times);output=Path(args.out).resolve();output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,sort_keys=True,separators=(',',':'),allow_nan=False)+'\n',encoding='utf8',newline='\n')
    print(f'TEXLOOM_REFERENCE: {output}')


if __name__=='__main__':main()
