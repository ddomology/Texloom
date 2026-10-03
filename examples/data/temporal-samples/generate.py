"""Independent analytic sample producer, not a PDE solver.

The runtime never imports this module. Regenerate into a NEW directory:
python examples/data/temporal-samples/generate.py --out build/temporal-input
"""
from pathlib import Path
import argparse
import json
import math
import sys

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tools'))
from import_samples import import_samples, canonical_json


def generate(output):
    output=Path(output)
    if output.exists():raise ValueError('Use a new output directory.')
    points=[(0.,0.,-1.)]
    for j in range(1,8):
        v=-math.pi/2+j*math.pi/8
        for i in range(16):
            u=2*math.pi*i/16;points.append((math.cos(v)*math.cos(u),math.cos(v)*math.sin(u),math.sin(v)))
    points.append((0.,0.,1.));triangles=[]
    for i in range(16):triangles.append([0,1+i,1+(i+1)%16])
    for j in range(6):
        for i in range(16):
            a=1+j*16+i;b=1+j*16+(i+1)%16;c=a+16;d=b+16
            triangles.extend([[a,b,d],[a,d,c]])
    for i in range(16):triangles.append([113,97+i,97+(i+1)%16])
    # The producer explicitly chooses outward CCW for each triangle.
    for face in triangles:
        a,b,c=[points[i] for i in face];u=[b[i]-a[i] for i in range(3)];v=[c[i]-a[i] for i in range(3)]
        n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]]
        if sum(n[i]*(a[i]+b[i]+c[i]) for i in range(3))<0:face[1],face[2]=face[2],face[1]
    indices=[i for f in triangles for i in f];positions=[v for p in points for v in p]
    buffer=lambda data,components,kind:{'version':1,'componentType':kind,'components':components,'count':len(data)//components,'byteOffset':0,'byteStride':components*(8 if kind=='float64' else 2),'data':data}
    mesh={'kind':'mesh','version':1,'primitive':'triangles','units':'m','coordinateSpace':'object','winding':'ccw','topologyRevision':'sample-domain-16x8-v1',
          'positions':buffer(positions,3,'float64'),'indices':buffer(indices,1,'uint16'),'normals':buffer(positions,3,'float64'),
          'bounds':{'min':[min(p[i] for p in points) for i in range(3)],'max':[max(p[i] for p in points) for i in range(3)]}}
    times=[0,.5,1.75,3,4.5,6.25,8];frames=[]
    for time in times:
        cosine=math.cos(2*math.pi*time/8)
        scalar=[2*x*y*cosine for x,y,z in points]
        vector=[c for x,y,z in points for c in (-y*cosine,x*cosine,0.)]
        moved=[c*(1+.3*s) for point,s in zip(points,scalar) for c in point]
        frames.append({'time':time,'values':{'scalar':scalar,'vector':vector,'position':moved}})
    data={'version':1,'units':'m','topology':{'revision':mesh['topologyRevision'],'vertexCount':len(points),'indices':indices},
          'interpolation':'linear','outside':'clamp','seed':3601,
          'solver':{'name':'analytic-sample-producer','version':'1','parameters':{'formula':'f=2*x*y*cos(2*pi*t/8); q=p*(1+0.3*f); v=(-y,x,0)*cos(2*pi*t/8)','pdeSolver':False}},
          'channels':[{'id':'scalar','kind':'scalar','componentType':'float64','unit':'1'},
                      {'id':'vector','kind':'vector','componentType':'float64','unit':'m/s'},
                      {'id':'position','kind':'position','componentType':'float64','unit':'m'}],
          'frames':frames}
    output.mkdir(parents=True)
    (output/'mesh.json').write_bytes(canonical_json(mesh));(output/'samples.json').write_bytes(canonical_json(data))
    (output/'domain.tex').write_text('\\loommesh{sample-domain}|'+json.dumps(mesh,separators=(',',':'))+'|\n',encoding='utf8',newline='\n')
    import_samples(output/'samples.json',output/'bake',2)


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--out',required=True);generate(parser.parse_args().out)
