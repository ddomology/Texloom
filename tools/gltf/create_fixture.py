"""Create an original compact glTF 2.0 scene and equivalent GLB, without DCC software.

All geometry, materials and motion are authored here. No Khronos implementation
or sample asset is copied. Binary values are explicitly little-endian float32.
"""
import argparse
import copy
import json
import math
from pathlib import Path
import struct


def quaternion(axis,angle):
    return [math.sin(angle/2)*v for v in axis]+[math.cos(angle/2)]


def make_scene():
    data=bytearray();views=[];accessors=[]
    def accessor(values,components,kind,component=5126,target=None):
        while len(data)%4:data.append(0)
        fmt='f' if component==5126 else 'H'
        packed=struct.pack('<'+fmt*len(values),*values)
        converted=struct.unpack('<'+fmt*len(values),packed)
        view={'buffer':0,'byteOffset':len(data),'byteLength':len(packed)}
        if target is not None:view['target']=target
        views.append(view);data.extend(packed)
        item={'bufferView':len(views)-1,'componentType':component,'count':len(values)//components,'type':kind}
        if kind!='VEC4':
            item['min']=[min(converted[i::components]) for i in range(components)]
            item['max']=[max(converted[i::components]) for i in range(components)]
        accessors.append(item);return len(accessors)-1
    # Use the algebraic regular-hexagon coordinates rather than sin(k*pi/3).
    # Mathematically zero coordinates must not retain platform-libm residuals.
    height=.55*math.sqrt(3)/2
    ring=[[.55,0.,0.],[.275,0.,height],[-.275,0.,height],
        [-.55,0.,0.],[-.275,0.,-height],[.275,0.,-height]]
    positions=[];normals=[];indices=[[],[],[]]
    for i in range(6):
        for pole in [[0.,.85,0.],[0.,-.85,0.]]:
            triangle=[pole,ring[i],ring[(i+1)%6]]
            u=[triangle[1][j]-pole[j] for j in range(3)];v=[triangle[2][j]-pole[j] for j in range(3)]
            n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
            centroid=[sum(p[j] for p in triangle)/3 for j in range(3)]
            if sum(n[j]*centroid[j] for j in range(3))<0:triangle[1],triangle[2]=triangle[2],triangle[1];n=[-x for x in n]
            length=math.hypot(*n);n=[x/length for x in n]
            start=len(positions)//3;positions.extend(x for point in triangle for x in point);normals.extend(n*3)
            indices[(i+(0 if pole[1]>0 else 1))%3].extend([start,start+1,start+2])
    p=accessor(positions,3,'VEC3',target=34962);n=accessor(normals,3,'VEC3',target=34962)
    index_ids=[accessor(values,1,'SCALAR',5123,34963) for values in indices]
    translation_times=accessor([0,2,5,8],1,'SCALAR')
    translations=accessor([-1.35,0,0,-1.55,.4,0,-1.25,-.2,0,-1.35,0,0],3,'VEC3')
    rotation_times=accessor([0,3,6,8],1,'SCALAR')
    rotations=accessor([value for angle in [-.3,1.,2.,-.3] for value in quaternion([0,1,0],angle)],4,'VEC4')
    scale_times=accessor([0,2,4,6,8],1,'SCALAR')
    scales=accessor([.75,.85,.75,1.05,.75,.8,.8,1.15,.8,.9,.85,1.05,.75,.85,.75],3,'VEC3')
    materials=[{'name':name,'pbrMetallicRoughness':{'baseColorFactor':rgb+[1]},'alphaMode':'OPAQUE','extensions':{'KHR_materials_unlit':{}}}
        for name,rgb in [('Mint',[.12,.58,.39]),('Pale mint',[.35,.8,.63]),('Deep mint',[.045,.26,.2])]]
    document={'asset':{'version':'2.0','generator':'Texloom original PR39 fixture; tools/gltf/create_fixture.py'},
        'extensionsUsed':['KHR_materials_unlit'],'extensionsRequired':['KHR_materials_unlit'],
        'scene':0,'scenes':[{'name':'Three shared faceted gems','nodes':[0,4]}],
        'nodes':[
            {'name':'GemAssembly','children':[1,2,3],'translation':[.15,.08,-.1],'rotation':quaternion([0,1,0],.18)},
            {'name':'RisingGem','mesh':0,'translation':[-1.35,0,0],'rotation':quaternion([0,0,1],-.12),'scale':[.8,1.1,.8]},
            {'name':'MirroredGem','mesh':0,'translation':[0,0,0],'rotation':quaternion([0,1,0],-.3),'scale':[-1,1,.75]},
            {'name':'SteppedGem','mesh':0,'translation':[1.35,0,-.2],'scale':[.75,.85,.75]},
            {'name':'ReferenceCamera','camera':0,'translation':[0,1.1,6.2],'rotation':quaternion([1,0,0],-math.atan2(1.1,6.2))}],
        'meshes':[{'name':'Shared faceted hexagonal bipyramid','primitives':[
            {'attributes':{'POSITION':p,'NORMAL':n},'indices':index_ids[i],'material':i,'mode':4} for i in range(3)]}],
        'materials':materials,'cameras':[{'name':'Finite perspective','type':'perspective',
            'perspective':{'aspectRatio':16/9,'yfov':.8,'znear':.1,'zfar':30}}],
        'animations':[{'name':'Eight second TRS demonstration','samplers':[
            {'input':translation_times,'output':translations,'interpolation':'LINEAR'},
            {'input':rotation_times,'output':rotations,'interpolation':'LINEAR'},
            {'input':scale_times,'output':scales,'interpolation':'STEP'}],
            'channels':[{'sampler':0,'target':{'node':1,'path':'translation'}},
                {'sampler':1,'target':{'node':2,'path':'rotation'}},{'sampler':2,'target':{'node':3,'path':'scale'}}]}],
        'buffers':[{'uri':'scene.bin','byteLength':len(data)}],'bufferViews':views,'accessors':accessors}
    return document,bytes(data)


def encode_glb(document,data):
    embedded=copy.deepcopy(document);embedded['buffers'][0].pop('uri')
    raw=json.dumps(embedded,separators=(',',':'),sort_keys=True).encode('utf8');raw+=b' '*((-len(raw))%4)
    binary=data+b'\0'*((-len(data))%4)
    return struct.pack('<III',0x46546c67,2,12+8+len(raw)+8+len(binary))+struct.pack('<II',len(raw),0x4e4f534a)+raw+struct.pack('<II',len(binary),0x004e4942)+binary


def write_fixture(out):
    out.mkdir(parents=True,exist_ok=True);document,data=make_scene()
    (out/'scene.gltf').write_text(json.dumps(document,indent=2,sort_keys=True)+'\n',encoding='utf8',newline='\n')
    (out/'scene.bin').write_bytes(data);(out/'scene.glb').write_bytes(encode_glb(document,data))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--out',type=Path,required=True)
    write_fixture(parser.parse_args().out)
