"""Create the real Blender 4.5.9 producer acceptance scene without external assets.

blender --background --factory-startup --python tools/blender/create_fixture.py --
  --out scene.blend [--variant supported|unsupported-material|topology-change|unsupported-volume|unsupported-curve]
All distances are authored in centimetre-sized Blender units, converted by the
scene's explicit 0.01 metres per unit. No exporter helper is imported here.
"""
import argparse
import math
from pathlib import Path
import sys

import bpy


def material(name, color):
    value=bpy.data.materials.new(name);value.use_nodes=False
    value.diffuse_color=(*color,1.0)
    return value


def linear_keys(obj):
    if obj.animation_data and obj.animation_data.action:
        # Blender 4.5 still exposes legacy action fcurves for this simple slot.
        for curve in obj.animation_data.action.fcurves:
            for key in curve.keyframe_points:key.interpolation='LINEAR'


def create(output, variant='supported'):
    if bpy.app.version[:3]!=(4,5,9):raise RuntimeError('Fixture requires Blender 4.5.9.')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene=bpy.context.scene;scene.name='Texloom Producer Fixture'
    scene.unit_settings.system='METRIC';scene.unit_settings.scale_length=.01
    scene.unit_settings.length_unit='CENTIMETERS'
    scene.render.fps=30;scene.render.fps_base=1.0;scene.frame_start=1;scene.frame_end=241
    scene['texloom_fixture']='modifier-sharing-reflection-v1'
    scene['texloom_variant']=variant
    mint=material('Column Mint',(.13,.58,.37));gold=material('Orb Gold',(.82,.49,.10))

    # A ringed hexagonal column: bevel changes evaluated vertex count; twist
    # then changes positions while the preceding triangulation fixes identities.
    sides=6;rings=7;vertices=[];faces=[]
    for j in range(rings):
        z=-90+180*j/(rings-1);radius=28*(1+.12*math.cos(math.pi*z/90))
        vertices.extend((radius*math.cos(2*math.pi*i/sides),radius*math.sin(2*math.pi*i/sides),z) for i in range(sides))
    for j in range(rings-1):
        for i in range(sides):
            nxt=(i+1)%sides;a=j*sides+i;b=j*sides+nxt
            faces.append((a,b,b+sides,a+sides))
    faces.extend([tuple(reversed(range(sides))),tuple((rings-1)*sides+i for i in range(sides))])
    mesh=bpy.data.meshes.new('Column Authored Mesh');mesh.from_pydata(vertices,[],faces);mesh.update()
    column=bpy.data.objects.new('TwistedColumn',mesh);scene.collection.objects.link(column)
    column.data.materials.append(mint)
    bevel=column.modifiers.new('Evaluated Bevel','BEVEL');bevel.width=3;bevel.segments=1;bevel.limit_method='ANGLE'
    triangulate=column.modifiers.new('Stable Triangles','TRIANGULATE');triangulate.quad_method='FIXED';triangulate.ngon_method='CLIP'
    twist=column.modifiers.new('Animated Twist','SIMPLE_DEFORM');twist.deform_method='TWIST';twist.deform_axis='Z'
    for frame,angle in [(1,-.75),(121,.95),(241,-.75)]:
        twist.angle=angle;twist.keyframe_insert(data_path='angle',frame=frame)
    linear_keys(column)
    column.rotation_euler=(.12,-.18,.08)
    column.scale=(1.0,.85,1.0)

    # A collection not linked directly to the scene supplies genuine evaluated
    # depsgraph instances. All three children refer to the same Orb mesh data.
    collection=bpy.data.collections.new('Shared Orb Collection')
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2,radius=31)
    orb=bpy.context.object;orb.name='Orb';orb.data.name='Shared Orb Mesh'
    for owner in list(orb.users_collection):owner.objects.unlink(orb)
    collection.objects.link(orb);orb.data.materials.append(gold)
    for face in orb.data.polygons:face.use_smooth=True
    for name,position,scale,rotation in [
        ('OrbWest',(-92,0,-45),(1,.8,1.15),(.15,.2,-.25)),
        ('OrbEastMirror',(92,4,8),(-1.15,.8,1.05),(.2,-.3,.4)),
        ('OrbNorth',(4,5,120),(.8,.8,.8),(.0,.1,.0))]:
        instance=bpy.data.objects.new(name,None);instance.instance_type='COLLECTION';instance.instance_collection=collection
        instance.location=position;instance.scale=scale;instance.rotation_euler=rotation;scene.collection.objects.link(instance)
        if name=='OrbWest':
            for frame,location in [(1,(-92,0,-45)),(121,(-92,12,35)),(241,(-92,0,-45))]:
                instance.location=location;instance.keyframe_insert(data_path='location',frame=frame)
            linear_keys(instance)

    if variant=='unsupported-material':
        mint.use_nodes=True;nodes=mint.node_tree.nodes;nodes.clear()
        output_node=nodes.new('ShaderNodeOutputMaterial');shader=nodes.new('ShaderNodeBsdfPrincipled');noise=nodes.new('ShaderNodeTexNoise')
        mint.node_tree.links.new(noise.outputs['Color'],shader.inputs['Base Color'])
        mint.node_tree.links.new(shader.outputs['BSDF'],output_node.inputs['Surface'])
    elif variant=='topology-change':
        subdivision=column.modifiers.new('Unsupported Animated Topology','SUBSURF');subdivision.subdivision_type='SIMPLE'
        for frame,level in [(1,0),(121,1),(241,0)]:
            subdivision.levels=level;subdivision.keyframe_insert(data_path='levels',frame=frame)
        linear_keys(column)
    elif variant=='unsupported-volume':
        mint.use_nodes=True;nodes=mint.node_tree.nodes;nodes.clear()
        output_node=nodes.new('ShaderNodeOutputMaterial');shader=nodes.new('ShaderNodeBsdfPrincipled');volume=nodes.new('ShaderNodeVolumeScatter')
        mint.node_tree.links.new(shader.outputs['BSDF'],output_node.inputs['Surface'])
        mint.node_tree.links.new(volume.outputs['Volume'],output_node.inputs['Volume'])
    elif variant=='unsupported-curve':
        bpy.ops.curve.primitive_bezier_circle_add(radius=45,location=(0,0,120))
        bpy.context.object.name='Unsupported Curve Geometry'
        bpy.context.object.data.bevel_depth=2
    elif variant!='supported':raise ValueError('Unknown fixture variant.')
    scene.frame_set(1);bpy.context.view_layer.update()
    output=Path(output).resolve();output.parent.mkdir(parents=True,exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(output),check_existing=False,compress=True)
    print(f'TEXLOOM_FIXTURE: {output} ({variant})')


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--out',required=True)
    parser.add_argument('--variant',default='supported',choices=['supported','unsupported-material','topology-change','unsupported-volume','unsupported-curve'])
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    create(args.out,args.variant)


if __name__=='__main__':main()
