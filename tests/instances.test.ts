import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotInstanceSet3D,validateInstanceSet3D,exactInstanceSetBounds,type InstanceSet3D} from '../src/ir/instances.ts';
import type {MeshResource} from '../src/ir/mesh.ts';
import type {NumericBuffer} from '../src/resources/buffers.ts';
import {quaternionFromAxisAngle} from '../src/geometry/matrix4.ts';

const buffer=(data:number[],components:1|3,componentType:NumericBuffer['componentType']='float64'):NumericBuffer=>({version:1,componentType,components,count:data.length/components,byteOffset:0,byteStride:components*(componentType==='float64'?8:4),data});
const mesh=():MeshResource=>({kind:'mesh',version:1,primitive:'triangles',units:'unit',coordinateSpace:'object',winding:'ccw',topologyRevision:'tri',positions:buffer([0,0,0,1,0,0,0,1,0],3),indices:buffer([0,1,2],1,'uint32'),bounds:{min:[0,0,0],max:[1,1,0]}});
const set=():InstanceSet3D=>({version:1,prototypeResourceId:'prototype',units:'unit',instances:[{id:'first'},{id:'second',transform:{translation:[2,0,1]},color:[.25,.5,.75],selected:false}]});
const code=(fn:()=>unknown,expected:string)=>assert.throws(fn,(error:any)=>error.diagnostics?.some((d:any)=>d.code===expected));

test('instance sets retain portable stable records and detached frozen transforms, without prototype copies',()=>{
  const source=set(),before=JSON.stringify(source),frozen=snapshotInstanceSet3D(source,mesh());
  assert.equal(JSON.stringify(frozen),before);assert.deepEqual(Object.keys(frozen),['version','prototypeResourceId','units','instances']);
  assert.ok(Object.isFrozen(frozen.instances[1].transform));assert.ok(Object.isFrozen(frozen.instances[1].color));
  source.instances[1].color![0]=1;source.instances[0].id='edited';assert.equal(frozen.instances[0].id,'first');assert.equal(frozen.instances[1].color![0],.25);
  assert.deepEqual(exactInstanceSetBounds(frozen,mesh()),{min:[0,0,0],max:[1,1,0]});
  assert.deepEqual(exactInstanceSetBounds(frozen,mesh(),{selection:'all'}),{min:[0,0,0],max:[3,1,1]});
});

test('bounds use actual transformed vertices rather than the larger transformed prototype box',()=>{
  const source=set();source.instances=[{id:'rotated',transform:{rotation:[...quaternionFromAxisAngle([0,0,1],Math.PI/4)]}}];
  const bounds=exactInstanceSetBounds(source,mesh())!;
  assert.ok(Math.abs(bounds.max[1]-Math.SQRT1_2)<1e-15);assert.ok(Math.abs(bounds.min[0]+Math.SQRT1_2)<1e-15);
  const unreferenced=mesh();unreferenced.positions=buffer([...unreferenced.positions.data,4,3,2],3);unreferenced.bounds={min:[0,0,0],max:[4,3,2]};
  assert.deepEqual(exactInstanceSetBounds(set(),unreferenced),unreferenced.bounds);
});

test('invalid record identities, policies, versions, transforms and units have contextual diagnostics',()=>{
  const cases:[(value:any)=>void,string][]=[
    [v=>v.version=2,'INSTANCE_VERSION'],[v=>v.units='px','INSTANCE_UNITS'],[v=>v.prototypeResourceId=' ','INSTANCE_PROTOTYPE'],
    [v=>v.instances[1].id='first','INSTANCE_ID'],[v=>v.instances[0].id='','INSTANCE_ID'],[v=>v.instances[0].selected=1,'INSTANCE_SELECTION'],
    [v=>v.instances[0].color=[1.1,0,0],'INSTANCE_COLOR'],[v=>v.instances[0].extra=true,'INSTANCE_PROPERTY'],
    [v=>v.instances=null,'INSTANCE_LIMIT'],[v=>v.instances=Array.from({length:4097},(_,i)=>({id:String(i)})),'INSTANCE_LIMIT'],
  ];
  for(const [change,expected] of cases){const value=set();change(value);code(()=>snapshotInstanceSet3D(value),expected);}
  const units=set();units.units='cm';code(()=>snapshotInstanceSet3D(units,mesh()),'INSTANCE_UNIT_MISMATCH');
  const bad=set();bad.instances[0].transform={scale:[NaN,1,1]};assert.ok(validateInstanceSet3D(bad).some(d=>d.severity==='error'));
  code(()=>exactInstanceSetBounds(set(),mesh(),{selection:'other'} as any),'INSTANCE_OPTIONS');
  code(()=>exactInstanceSetBounds(set(),mesh(),null as any),'INSTANCE_OPTIONS');
});

test('validation does not invoke getters and exact bounds bound work before matrix traversal',()=>{
  let reads=0;const value:any=set();Object.defineProperty(value.instances[0],'transform',{enumerable:true,get(){reads++;throw Error('invoked');}});
  code(()=>snapshotInstanceSet3D(value),'ASSET_JSON_VALUE');assert.equal(reads,0);
  const large=mesh();large.positions=buffer(Array.from({length:1000*3},(_,i)=>i%3===0?i/3:0),3);large.bounds={min:[0,0,0],max:[999,0,0]};
  const many=set();many.instances=Array.from({length:4096},(_,i)=>({id:String(i)}));
  code(()=>exactInstanceSetBounds(many,large),'INSTANCE_BOUND_BUDGET');
});

test('empty, wholly unselected and degenerate prototypes have explicit finite outcomes',()=>{
  const emptySet=set();emptySet.instances=[];assert.equal(exactInstanceSetBounds(emptySet,mesh()),null);
  const empty=mesh();empty.positions=buffer([],3);empty.indices=buffer([],1,'uint32');empty.bounds=null;
  assert.equal(exactInstanceSetBounds(set(),empty),null);
  const hidden=set();hidden.instances.forEach(i=>i.selected=false);assert.equal(exactInstanceSetBounds(hidden,mesh()),null);
  const collapsed=set();collapsed.instances=[{id:'flat',transform:{scale:[0,0,0]}}];assert.deepEqual(exactInstanceSetBounds(collapsed,mesh()),{min:[0,0,0],max:[0,0,0]});
});
