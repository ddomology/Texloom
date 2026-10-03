"""Independent glTF fixture decoder and TRS/SLERP/world-normal oracle.

This file uses only the Python standard library. It imports neither the fixture
generator nor any TypeScript importer, evaluator or geometry helper.
"""
import argparse
import bisect
import copy
import hashlib
import json
import math
from pathlib import Path
import struct

TIMES=[0,.5,1,2-1/1024,2,2+1/1024,3,4,5,6,6.5,7,8]
KNOTS=[0,2,3,4,5,6,8]
SNAPSHOT_JS="frame=>({time:frame.time,resources:frame.resources,instances:frame.space3d.instances,groups:frame.space3d.groups,camera:frame.space3d.camera})"
WEB_SNAPSHOT_JS='time=>{TexloomGpuPlayer.seek(time);return ('+SNAPSHOT_JS+')(TexloomGpuPlayer.getFrame());}'


def load_asset(path):
    path=Path(path)
    if path.suffix=='.gltf':
        document=json.loads(path.read_text(encoding='utf8'))
        return document,[(path.parent/b['uri']).read_bytes() for b in document['buffers']]
    raw=path.read_bytes();magic,version,length=struct.unpack_from('<III',raw)
    if (magic,version,length)!=(0x46546c67,2,len(raw)):raise ValueError('Invalid GLB header')
    chunks=[];offset=12
    while offset<len(raw):
        size,kind=struct.unpack_from('<II',raw,offset);offset+=8
        if size%4 or offset+size>len(raw):raise ValueError('Invalid GLB chunk')
        chunks.append((kind,raw[offset:offset+size]));offset+=size
    if len(chunks)!=2 or [x[0] for x in chunks]!=[0x4e4f534a,0x004e4942]:raise ValueError('Expected JSON and BIN GLB chunks')
    document=json.loads(chunks[0][1]);return document,[chunks[1][1][:document['buffers'][0]['byteLength']]]


def accessor(document,buffers,index):
    item=document['accessors'][index];view=document['bufferViews'][item['bufferView']]
    components={'SCALAR':1,'VEC3':3,'VEC4':4}[item['type']];fmt={5123:'H',5125:'I',5126:'f'}[item['componentType']]
    size=struct.calcsize(fmt)*components;stride=view.get('byteStride',size)
    offset=view.get('byteOffset',0)+item.get('byteOffset',0);data=buffers[view['buffer']]
    if offset+(item['count']-1)*stride+size>view.get('byteOffset',0)+view['byteLength']:raise ValueError('Accessor escapes view')
    values=[list(struct.unpack_from('<'+fmt*components,data,offset+i*stride)) for i in range(item['count'])]
    return [v[0] for v in values] if components==1 else values


def normalized(vector):
    length=math.hypot(*vector)
    if not length or not math.isfinite(length):raise ValueError('Invalid reference vector')
    return [value/length for value in vector]


def slerp(a,b,t):
    a=normalized(a);b=normalized(b);dot=sum(x*y for x,y in zip(a,b))
    if dot<0:b=[-x for x in b];dot=-dot
    dot=min(1.,dot)
    if dot>1-1e-12:return normalized([x+(y-x)*t for x,y in zip(a,b)])
    angle=math.acos(dot);denominator=math.sin(angle)
    return normalized([(math.sin((1-t)*angle)*x+math.sin(t*angle)*y)/denominator for x,y in zip(a,b)])


def identity():return [[float(i==j) for j in range(4)] for i in range(4)]
def multiply(a,b):return [[sum(a[i][k]*b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]
def point(matrix,p):return [sum(matrix[i][j]*p[j] for j in range(3))+matrix[i][3] for i in range(3)]
def determinant(m):return m[0][0]*(m[1][1]*m[2][2]-m[1][2]*m[2][1])-m[0][1]*(m[1][0]*m[2][2]-m[1][2]*m[2][0])+m[0][2]*(m[1][0]*m[2][1]-m[1][1]*m[2][0])
def normal(m,n):
    # Cofactor matrix / determinant is the inverse transpose; reflection is
    # retained, independently of front-face winding selection.
    cofactors=[]
    for i in range(3):
        row=[]
        for j in range(3):
            rows=[r for r in range(3) if r!=i];cols=[c for c in range(3) if c!=j]
            row.append((-1)**(i+j)*(m[rows[0]][cols[0]]*m[rows[1]][cols[1]]-m[rows[0]][cols[1]]*m[rows[1]][cols[0]]))
        cofactors.append(row)
    det=determinant(m)
    return normalized([sum(cofactors[i][j]*n[j] for j in range(3))/det for i in range(3)])
def columns(m):return [m[i][j] for j in range(4) for i in range(4)]
def rows(m):return [[m[j*4+i] for j in range(4)] for i in range(4)]
def convert(p):return [p[0],-p[2],p[1]]
C=[[1.,0.,0.,0.],[0.,0.,-1.,0.],[0.,1.,0.,0.],[0.,0.,0.,1.]]
CI=[[C[j][i] for j in range(4)] for i in range(4)]


def trs(node):
    if 'matrix' in node:return rows(node['matrix'])
    x,y,z,w=normalized(node.get('rotation',[0,0,0,1]));s=node.get('scale',[1,1,1]);t=node.get('translation',[0,0,0])
    result=[[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w),t[0]],
            [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w),t[1]],
            [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y),t[2]],[0.,0.,0.,1.]]
    for i in range(3):
        for j in range(3):result[i][j]*=s[j]
    return result


class GltfReference:
    def __init__(self,document,buffers):self.document=document;self.buffers=buffers

    def sample(self,time):
        doc=self.document;nodes=copy.deepcopy(doc['nodes']);animation=doc['animations'][0]
        for channel in animation['channels']:
            sampler=animation['samplers'][channel['sampler']];times=accessor(doc,self.buffers,sampler['input']);values=accessor(doc,self.buffers,sampler['output'])
            t=max(times[0],min(times[-1],time));left=max(0,bisect.bisect_right(times,t)-1);right=min(len(times)-1,left+1)
            alpha=0 if left==right else (t-times[left])/(times[right]-times[left]);path=channel['target']['path']
            if sampler.get('interpolation','LINEAR')=='STEP' or left==right:value=values[left]
            elif path=='rotation':value=slerp(values[left],values[right],alpha)
            else:value=[a+(b-a)*alpha for a,b in zip(values[left],values[right])]
            nodes[channel['target']['node']][path]=value
        worlds={}
        def visit(index,parent):
            world=multiply(parent,trs(nodes[index]));worlds[index]=world
            for child in nodes[index].get('children',[]):visit(child,world)
        for index in doc['scenes'][doc.get('scene',0)]['nodes']:visit(index,identity())
        instances=[];cameras=[]
        for index,world in worlds.items():
            node=nodes[index]
            if 'camera' in node:cameras.append({'nodeIndex':index,'cameraIndex':node['camera'],'worldMatrix':columns(world),
                'convertedWorldMatrix':columns(multiply(multiply(C,world),CI)),
                'convertedOpticalWorldMatrix':columns(multiply(C,world))})
            if 'mesh' not in node:continue
            for primitive_index,primitive in enumerate(doc['meshes'][node['mesh']]['primitives']):
                p=accessor(doc,self.buffers,primitive['attributes']['POSITION']);n=accessor(doc,self.buffers,primitive['attributes']['NORMAL'])
                world_p=[point(world,v) for v in p];world_n=[normal(world,v) for v in n]
                instances.append({'nodeIndex':index,'primitiveIndex':primitive_index,'meshIndex':node['mesh'],
                    'determinant':determinant(world),'worldMatrix':columns(world),
                    'convertedWorldMatrix':columns(multiply(multiply(C,world),CI)),
                    'indices':accessor(doc,self.buffers,primitive['indices']),
                    'localPositions':p,'localNormals':n,'worldPositions':world_p,'worldNormals':world_n,
                    'convertedWorldPositions':[convert(v) for v in world_p],'convertedWorldNormals':[convert(v) for v in world_n]})
        return {'time':time,'instances':instances,'cameras':cameras}


class GltfOracle:
    def __init__(self,document,buffers,scope='model'):self.reference=GltfReference(document,buffers);self.scope=scope
    def assert_frame(self,case,frame,time,tolerance=2e-12):
        expected=self.reference.sample(time);root=rows(next(g['worldMatrix'] for g in frame['groups'] if g['id']==self.scope))
        actual={i['id']:i for i in frame['instances']};maxima={'worldPosition':0.,'worldNormal':0.,'worldMatrix':0.}
        expected_ids={f"{self.scope}:primitive:{item['nodeIndex']}:{item['primitiveIndex']}" for item in expected['instances']}
        case.assertEqual({key for key in actual if key.startswith(self.scope+':primitive:')},expected_ids)
        def check(values,wanted,bucket):
            case.assertEqual(len(values),len(wanted))
            for value,target in zip(values,wanted):
                error=abs(value-target);maxima[bucket]=max(maxima[bucket],error);case.assertLessEqual(error,tolerance)
        for item in expected['instances']:
            node=actual[f"{self.scope}:primitive:{item['nodeIndex']}:{item['primitiveIndex']}"]
            matrix=rows(node['worldMatrix']);mesh=frame['resources'][node['resourceId']]
            def vectors(buffer):
                size=8 if buffer['componentType']=='float64' else 4
                stride=buffer['byteStride']//size;offset=buffer['byteOffset']//size
                return [buffer['data'][offset+i*stride:offset+i*stride+3] for i in range(buffer['count'])]
            positions=vectors(mesh['positions']);normals=vectors(mesh['normals'])
            case.assertEqual(len(positions),len(item['convertedWorldPositions']));case.assertEqual(len(normals),len(item['convertedWorldNormals']))
            index_buffer=mesh['indices'];size=2 if index_buffer['componentType']=='uint16' else 4
            case.assertEqual([index_buffer['data'][(index_buffer['byteOffset']+i*index_buffer['byteStride'])//size] for i in range(index_buffer['count'])],item['indices'])
            check(node['worldMatrix'],columns(multiply(root,rows(item['convertedWorldMatrix']))),'worldMatrix')
            for p,wanted in zip(positions,item['convertedWorldPositions']):check(point(matrix,p),point(root,wanted),'worldPosition')
            case.assertEqual(len(node['normalMatrix']),9)
            for n,wanted in zip(normals,item['convertedWorldNormals']):
                transformed=normalized([sum(node['normalMatrix'][c*3+r]*n[c] for c in range(3)) for r in range(3)])
                check(transformed,normal(root,wanted),'worldNormal')
            case.assertEqual(node['worldWinding'],'cw' if determinant(root)*item['determinant']<0 else 'ccw')
        return {'sourceTime':time,'instances':len(expected['instances']),'negative':sum(i['determinant']<0 for i in expected['instances']),'maxAbsoluteErrors':maxima}


def write_reference(asset,out):
    document,buffers=load_asset(asset);reference=GltfReference(document,buffers)
    samples=[reference.sample(t) for t in TIMES]
    positions=[v for frame in samples for item in frame['instances'] for v in item['convertedWorldPositions']]
    archived=[]
    for frame in samples:
        instances=[]
        for item in frame['instances']:
            compact={key:item[key] for key in ['nodeIndex','primitiveIndex','meshIndex','determinant','worldMatrix','convertedWorldMatrix','indices']}
            for key in ['convertedWorldPositions','convertedWorldNormals']:compact[key]=[item[key][i] for i in item['indices']]
            instances.append(compact)
        archived.append({'time':frame['time'],'instances':instances,'cameras':frame['cameras']})
    report={'version':1,'profile':'independent-gltf-reference/1','sourceSha256':hashlib.sha256(Path(asset).read_bytes()).hexdigest(),
        'bufferSha256':[hashlib.sha256(b).hexdigest() for b in buffers],
        'referenceScriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'sampleTimes':TIMES,'knots':KNOTS,'coordinates':{'source':'right-handed Y-up metres','target':'right-handed Z-up metres','conversion':'(x,y,z) -> (x,-z,y)'},
        'sampledWorldBounds':{'min':[min(v[i] for v in positions) for i in range(3)],'max':[max(v[i] for v in positions) for i in range(3)]},
        'frames':archived,'archivePrecision':{'decimalPlaces':12,'zeroSign':'positive','scope':'Serialized reference floats only; runtime oracle calculations retain full precision.'},
        'scope':'Independent decoding, hierarchical TRS, shortest-path quaternion SLERP, right-continuous STEP and inverse-transpose normals. Archived point/normal lists follow each primitive indices array. These sampled bounds are not a proof of continuous extrema.'}
    def archive(value):
        if isinstance(value,float):
            rounded=round(value,12)
            return 0.0 if rounded==0 else rounded
        if isinstance(value,list):return [archive(item) for item in value]
        if isinstance(value,dict):return {key:archive(item) for key,item in value.items()}
        return value
    out.write_text(json.dumps(archive(report),separators=(',',':'),sort_keys=True)+'\n',encoding='utf8',newline='\n')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--asset',type=Path,required=True);parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args();write_reference(args.asset,args.out)
