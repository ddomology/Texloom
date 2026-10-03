"""Independent consumer oracle shared by web tests and delivery/Chalk QA.

No producer conversion or TypeScript geometry helper is imported. At stored
knots, positions and preserved normals come from the separately run bpy oracle.
Between knots, only the declared portable interpolation contract is asserted.
"""
import base64
import bisect
import hashlib
import math
import struct

SNAPSHOT_JS = r'''frame => ({
  time:frame.time,
  resources:Object.fromEntries(Object.entries(frame.resources).filter(([id,r])=>r.kind==='mesh')),
  sampledFields:frame.sampledFields??{},
  instances:frame.space3d.instances,
  groups:frame.space3d.groups
})'''
WEB_SNAPSHOT_JS = '(time)=>{TexloomGpuPlayer.seek(time);return ('+SNAPSHOT_JS+')(TexloomGpuPlayer.getFrame());}'


def triples(values):return [values[i:i+3] for i in range(0,len(values),3)]
def norm(vector):
    length=math.hypot(*vector)
    if length==0:raise AssertionError('Zero reference normal.')
    return [v/length for v in vector]
def cross(a,b):return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
def point(matrix,p):return [sum(matrix[4*j+i]*p[j] for j in range(3))+matrix[12+i] for i in range(3)]
def determinant(matrix):
    a,b,c,d,e,f,g,h,i=(matrix[k] for k in (0,4,8,1,5,9,2,6,10))
    return a*(e*i-f*h)-b*(d*i-f*g)+c*(d*h-e*g)
def normal(matrix,vector):
    a,b,c,d,e,f,g,h,i=(matrix[k] for k in (0,4,8,1,5,9,2,6,10))
    cofactors=[[e*i-f*h,f*g-d*i,d*h-e*g],[c*h-b*i,a*i-c*g,b*g-a*h],[b*f-c*e,c*d-a*f,a*e-b*d]]
    det=determinant(matrix)
    return norm([sum(row[j]*vector[j] for j in range(3))/det for row in cofactors])
def triangle_normals(positions,indices):
    points=triples(positions);sums=[[0.,0.,0.] for _ in points]
    for offset in range(0,len(indices),3):
        ia,ib,ic=indices[offset:offset+3];a,b,c=points[ia],points[ib],points[ic]
        area=cross([b[i]-a[i] for i in range(3)],[c[i]-a[i] for i in range(3)])
        for vertex in (ia,ib,ic):
            for i in range(3):sums[vertex][i]+=area[i]
    return [norm(v) for v in sums]
def identity(row):return (row['sourceObject'],row['parent'],row['isInstance'],tuple(row['persistentId']))


class BlenderOracle:
    def __init__(self,manifest,reference,import_report):
        self.manifest,self.reference,self.report=manifest,reference,import_report
        if manifest['source']['blend']['sha256']!=reference['sourceBlendSha256']:
            raise AssertionError('Blender producer and independent oracle used different .blend bytes.')
        self.exact={frame['time']:{identity(row):row for row in frame['instances']} for frame in reference['frames']}
        self.nodes={row['id']:row for row in manifest['space3d']['nodes']}
        self.sampled={op['resourceId']:op for op in manifest.get('sampledFields',{}).get('operations',[])}
        self.decoded={name:self.decode_bake(bake) for name,bake in manifest.get('bakes',{}).items()}

    @staticmethod
    def decode_bake(bake):
        frames=[];count=bake['topology']['vertexCount']
        for chunk in bake['chunks']:
            if chunk['source']['kind']!='inline':raise AssertionError('Expected archived inline Blender bake.')
            raw=base64.b64decode(chunk['source']['data'],validate=True)
            if len(raw)!=chunk['byteLength'] or hashlib.sha256(raw).hexdigest()!=chunk['sha256']:raise AssertionError('Corrupt oracle bake bytes.')
            if chunk['startSample']!=len(frames):raise AssertionError('Noncontiguous bake coverage.')
            offset=0
            for _ in range(chunk['sampleCount']):
                values={}
                for channel in bake['channels']:
                    size=count*(1 if channel['kind']=='scalar' else 3);fmt='f' if channel['componentType']=='float32' else 'd'
                    values[channel['id']]=list(struct.unpack_from('<'+fmt*size,raw,offset));offset+=size*(4 if fmt=='f' else 8)
                frames.append(values)
            if offset!=len(raw):raise AssertionError('Trailing bake bytes.')
        return frames

    def sampled_positions(self,op,time):
        bake=self.manifest['bakes'][op['bake']];times=bake['sampleTimes'];t=max(times[0],min(times[-1],time));right=bisect.bisect_left(times,t)
        if times[right]==t:left=right;alpha=0
        else:left=right-1;alpha=(t-times[left])/(times[right]-times[left])
        values=self.decoded[op['bake']];channel=op['position']['channel']
        expected=[a+(b-a)*alpha for a,b in zip(values[left][channel],values[right][channel])]
        return expected,{'left':left,'right':right,'alpha':alpha,'sourceTime':t}

    def assert_frame(self,case,frame,time):
        def compare(actual,expected,tolerance=2e-6):
            case.assertEqual(len(actual),len(expected))
            for a,b in zip(actual,expected):case.assertAlmostEqual(a,b,delta=tolerance)
        case.assertEqual(frame['time'],time)
        root=next(g['worldMatrix'] for g in frame['groups'] if g['id']==self.report['rootId'])
        actual_by_id={row['id']:row for row in frame['instances']}
        # Every immutable base resource is still the producer's byte-decoded JSON.
        for local,resource in self.manifest['resources'].items():
            case.assertEqual(frame['resources'][self.report['mappings']['resources'][local]],resource)
        for output,op in self.sampled.items():
            expected,bracket=self.sampled_positions(op,time)
            mesh=frame['resources'][self.report['mappings']['resources'][output]]
            compare(mesh['positions']['data'],expected,2e-13)
            case.assertEqual(frame['sampledFields'][self.report['mappings']['operations'][op['id']]]['bracket'],bracket)
            case.assertEqual(mesh['indices'],self.manifest['resources'][op['source']]['indices'])
            own_normals=triangle_normals(expected,mesh['indices']['data'])
            for actual,wanted in zip(triples(mesh['normals']['data']),own_normals):compare(actual,wanted,2e-11)
        seen=set();negative=0;shared={}
        for row in self.manifest['report']['objects']:
            if row['setId'] is None:node_id=self.report['mappings']['nodes'][row['nodeId']]
            else:
                mapping=[r for r in self.report['mappings']['instances'] if r['setId']==row['setId'] and r['elementId']==row['instanceId']]
                case.assertEqual(len(mapping),1);node_id=mapping[0]['nodeId']
            instance=actual_by_id[node_id];seen.add(node_id)
            case.assertEqual(instance['resourceId'],self.report['mappings']['resources'][row['resourceId']])
            shared.setdefault(row['sourceData'],set()).add(instance['resourceId'])
            mesh=frame['resources'][instance['resourceId']]
            positions=triples(mesh['positions']['data']);normals=triples(mesh['normals']['data'])
            world=[point(instance['worldMatrix'],p) for p in positions]
            world_normals=[normal(instance['worldMatrix'],n) for n in normals]
            # Also verify the renderer-facing inverse-transpose matrix itself.
            matrix=instance['normalMatrix'];case.assertIsNotNone(matrix)
            for n,wanted in zip(normals,world_normals):compare(norm([sum(matrix[3*j+i]*n[j] for j in range(3)) for i in range(3)]),wanted,2e-11)
            sign=-1 if determinant(instance['worldMatrix'])<0 else 1
            case.assertEqual(instance['orientation'],sign);case.assertEqual(instance['worldWinding'],'cw' if sign<0 else 'ccw');negative+=sign<0
            if time not in self.exact:continue
            ref=self.exact[time][identity(row)]
            expected_world=[point(root,p) for p in ref['cornerWorldPositionsMeters']]
            case.assertEqual(len(world),len(expected_world))
            for actual,wanted in zip(world,expected_world):compare(actual,wanted)
            expected_sign=-1 if ref['determinant']*determinant(root)<0 else 1
            case.assertEqual(sign,expected_sign)
            if row['normalPolicy']=='preserved-corner':
                for actual,wanted in zip(world_normals,ref['cornerWorldNormals']):compare(actual,normal(root,wanted),3e-6)
            else:
                # Geometric world cross product includes determinant sign;
                # the normal contract deliberately does not flip reflections.
                for i in range(0,len(expected_world),3):
                    a,b,c=expected_world[i:i+3]
                    geometric=norm(cross([b[j]-a[j] for j in range(3)],[c[j]-a[j] for j in range(3)]))
                    expected_normal=[sign*v for v in geometric]
                    for actual in world_normals[i:i+3]:compare(actual,expected_normal,4e-5)
        case.assertEqual(seen,set(actual_by_id));case.assertGreaterEqual(negative,1)
        # The fixture's three orb entries must reuse one prototype buffer.
        orb_ids=[ids for name,ids in shared.items() if 'Orb' in name]
        case.assertEqual(len(orb_ids),1);case.assertEqual(len(orb_ids[0]),1)
        return {'instances':len(seen),'negative':negative,'exactBlenderKnot':time in self.exact}
