import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Matrix4Error,composeTransform3D,determinantMatrix4,identityMatrix4,inverseMatrix4,
  multiplyMatrix4,normalMatrix3D,normalizeQuaternion,normalizeVec3,orientationMatrix4,
  quaternionFromAxisAngle,transformBounds3D,transformDirection3D,transformNormal3D,
  transformPoint3D,validateMatrix4,validateTransform3D,type Matrix4,type Vec3,
} from '../src/geometry/matrix4.js';

function near(actual:readonly number[],expected:readonly number[],tolerance=1e-12):void {
  assert.equal(actual.length,expected.length);
  actual.forEach((v,i)=>assert.ok(Number.isFinite(v)&&Math.abs(v-expected[i])<=tolerance*Math.max(1,Math.abs(expected[i])),`${i}: ${v} versus ${expected[i]}`));
}
function error(code:string,run:()=>unknown):void {assert.throws(run,(e:unknown)=>e instanceof Matrix4Error&&e.code===code&&e.diagnostics[0].code===code);}
const cross=(a:readonly number[],b:readonly number[]):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a:readonly number[],b:readonly number[])=>a.reduce((s,v,i)=>s+v*b[i],0);

test('identity, authored affine matrices and all results are detached immutable values',()=>{
  const identity=identityMatrix4(),source=[...identity] as Matrix4,transform={matrix:source};
  const copy=composeTransform3D(transform);assert.notEqual(copy,source);assert.deepEqual(copy,identity);
  source[12]=99;assert.equal(copy[12],0);assert.ok(Object.isFrozen(copy));assert.ok(Object.isFrozen(identity));
  assert.deepEqual(composeTransform3D(),identity);assert.equal(determinantMatrix4(identity),1);
  const p:Vec3=[1,2,3],out=transformPoint3D(identity,p);assert.deepEqual(out,p);assert.notEqual(out,p);assert.ok(Object.isFrozen(out));
  assert.ok(Object.isFrozen(multiplyMatrix4(identity,identity)));assert.ok(Object.isFrozen(inverseMatrix4(identity)));
  assert.ok(Object.isFrozen(normalMatrix3D(identity)));assert.ok(Object.isFrozen(normalizeQuaternion([1,2,3,4])));
});

test('right-handed Z-up quaternion rotation composes T*R*S on column vectors',()=>{
  const rotation=quaternionFromAxisAngle([0,0,2],Math.PI/2),transform={translation:[5,-4,7] as Vec3,rotation:[...rotation] as [number,number,number,number],scale:[2,3,4] as Vec3};
  const before=structuredClone(transform),m=composeTransform3D(transform);
  near(transformPoint3D(m,[3,0,1]),[5,2,11]);near(transformDirection3D(m,[3,0,1]),[0,6,4]);
  near(transformDirection3D(composeTransform3D({rotation:[...quaternionFromAxisAngle([1,0,0],Math.PI/2)]}),[0,1,0]),[0,0,1]);
  assert.deepEqual(transform,before);assert.equal(orientationMatrix4(m),1);near([determinantMatrix4(m)],[24]);
  near(composeTransform3D({rotation:rotation.map(v=>-7*v) as [number,number,number,number]}),composeTransform3D({rotation:[...rotation]}));
});

test('matrix multiplication order and affine inverse include shear and translation',()=>{
  const shear:Matrix4=[2,0,0,0,1,3,0,0,0,1,4,0,7,8,9,1];
  const inverse=inverseMatrix4(shear),p:Vec3=[3,-2,5];
  near(transformPoint3D(shear,p),[11,7,29]);near(transformPoint3D(inverse,transformPoint3D(shear,p)),p);
  near(multiplyMatrix4(shear,inverse),identityMatrix4());near(multiplyMatrix4(inverse,shear),identityMatrix4());
  near(normalMatrix3D(shear),[.5,-1/6,1/24,0,1/3,-1/12,0,0,.25]);
  const move=composeTransform3D({translation:[3,0,0]}),rotate=composeTransform3D({rotation:[...quaternionFromAxisAngle([0,0,1],Math.PI/2)]});
  near(transformPoint3D(multiplyMatrix4(move,rotate),[1,0,0]),[3,1,0]);
  near(transformPoint3D(multiplyMatrix4(rotate,move),[1,0,0]),[0,4,0]);
});

test('nonuniform scale uses inverse-transpose unit normals perpendicular to triangle edges',()=>{
  const edgeA:Vec3=[1,0,1],edgeB:Vec3=[0,1,1],normal=cross(edgeA,edgeB),m=composeTransform3D({scale:[2,3,4],translation:[100,-20,8]});
  const result=transformNormal3D(m,normal);
  near(result,normalizeVec3([-.5,-1/3,.25]));near([Math.hypot(...result),dot(result,transformDirection3D(m,edgeA)),dot(result,transformDirection3D(m,edgeB))],[1,0,0]);
  near(result,normalizeVec3(cross(transformDirection3D(m,edgeA),transformDirection3D(m,edgeB))));
  assert.ok(Object.isFrozen(result));assert.deepEqual(normal,[-1,-1,1]);
});

test('reflection reverses geometric triangle winding without silently flipping the normal',()=>{
  const a:Vec3=[1,0,1],b:Vec3=[0,1,1],m=composeTransform3D({scale:[-2,3,4]});
  const n=transformNormal3D(m,cross(a,b)),geometric=normalizeVec3(cross(transformDirection3D(m,a),transformDirection3D(m,b)));
  assert.equal(orientationMatrix4(m),-1);assert.equal(determinantMatrix4(m),-24);
  near(n,normalizeVec3([.5,-1/3,.25]));near(geometric,n.map(v=>-v));
  assert.equal(orientationMatrix4(composeTransform3D({scale:[-2,-3,4]})),1);
});

test('transformed cube AABB includes every corner under rotation, reflection and shear',()=>{
  const bounds={min:[-1,-1,-1] as Vec3,max:[1,1,1] as Vec3},before=structuredClone(bounds);
  const m=composeTransform3D({translation:[5,-4,7],rotation:[...quaternionFromAxisAngle([0,0,1],Math.PI/2)],scale:[-2,3,4]});
  const result=transformBounds3D(m,bounds);near(result.min,[2,-6,3]);near(result.max,[8,-2,11]);
  assert.deepEqual(bounds,before);assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.min)&&Object.isFrozen(result.max));
  const shear:Matrix4=[1,0,0,0,2,1,0,0,-3,0,1,0,0,0,0,1],sheared=transformBounds3D(shear,bounds);
  near(sheared.min,[-6,-1,-1]);near(sheared.max,[6,1,1]);
  near(transformBounds3D(m,{min:[0,0,0],max:[0,0,0]}).min,[5,-4,7]);
});

test('singular forward transforms and collapsed AABBs are valid; inverse and normal are explicit errors',()=>{
  const m=composeTransform3D({scale:[0,2,3]});near(transformPoint3D(m,[4,5,6]),[0,10,18]);
  assert.equal(determinantMatrix4(m),0);assert.equal(orientationMatrix4(m),0);
  assert.deepEqual(transformDirection3D(m,[0,0,0]),[0,0,0]);
  const box=transformBounds3D(m,{min:[-1,-1,-1],max:[1,1,1]});assert.equal(box.min[0],0);assert.equal(box.max[0],0);
  error('MATRIX4_SINGULAR',()=>inverseMatrix4(m));error('MATRIX4_SINGULAR',()=>normalMatrix3D(m));error('MATRIX4_SINGULAR',()=>transformNormal3D(m,[0,0,1]));
});

test('normalization handles maximum and subnormal finite inputs without overflow or invented directions',()=>{
  const max=Number.MAX_VALUE,min=Number.MIN_VALUE;
  near(normalizeVec3([max,max,0]),[Math.SQRT1_2,Math.SQRT1_2,0]);near(normalizeVec3([min,0,0]),[1,0,0]);
  near(normalizeQuaternion([max,max,max,max]),[.5,.5,.5,.5]);near(normalizeQuaternion([min,0,0,0]),[1,0,0,0]);
  error('VECTOR3_ZERO',()=>normalizeVec3([0,0,0]));error('QUATERNION_ZERO',()=>normalizeQuaternion([0,0,0,0]));
  error('VECTOR3_ZERO',()=>quaternionFromAxisAngle([0,0,0],1));error('QUATERNION_ANGLE',()=>quaternionFromAxisAngle([0,0,1],Infinity));
  error('VECTOR3_ZERO',()=>transformNormal3D(identityMatrix4(),[0,0,0]));
});

test('determinant sign stays defined beyond representable determinant magnitude without epsilon singularity',()=>{
  const large=composeTransform3D({scale:[1e200,1e200,-1e200]}),small=composeTransform3D({scale:[1e-200,1e-200,1e-200]});
  assert.equal(orientationMatrix4(large),-1);assert.equal(orientationMatrix4(small),1);
  error('MATRIX4_RANGE',()=>determinantMatrix4(large));error('MATRIX4_RANGE',()=>determinantMatrix4(small));
  near(inverseMatrix4(small),composeTransform3D({scale:[1e200,1e200,1e200]}));
  near([determinantMatrix4(composeTransform3D({scale:[1e300,1e-300,1]}))],[1]);
  const almostSingular:Matrix4=[1,1,0,0,1,1+Number.EPSILON,0,0,0,0,1,0,0,0,0,1];
  assert.equal(determinantMatrix4(almostSingular),Number.EPSILON);assert.equal(orientationMatrix4(almostSingular),1);
  near(multiplyMatrix4(almostSingular,inverseMatrix4(almostSingular)),identityMatrix4());
});

test('normal calculation preserves small inputs amplified by scale and excludes translation overflow',()=>{
  const m=composeTransform3D({scale:[1e308,1e-308,1]});
  near(transformNormal3D(m,[1e308,1e-308,0]),[Math.SQRT1_2,Math.SQRT1_2,0]);
  near(transformNormal3D(m,[1,0,0]),[1,0,0]);near(transformNormal3D(m,[0,1,0]),[0,1,0]);
  const translationOverflow=composeTransform3D({scale:[.5,1,1],translation:[Number.MAX_VALUE,0,0]});
  error('MATRIX4_RANGE',()=>inverseMatrix4(translationOverflow));near(transformNormal3D(translationOverflow,[1,0,0]),[1,0,0]);
});

test('forward arithmetic preserves finite cancellation and diagnoses genuinely overflowing results',()=>{
  const max=Number.MAX_VALUE,min=Number.MIN_VALUE;
  const cancellation:Matrix4=[max,0,0,0,max,1,0,0,0,0,1,0,0,0,0,1];
  near(transformPoint3D(cancellation,[2,-2,1]),[0,-2,1]);
  const b:Matrix4=[2,-2,0,0,0,0,0,0,0,0,0,0,0,0,0,1];assert.equal(multiplyMatrix4(cancellation,b)[0],0);
  const compensated:Matrix4=[1,0,0,0,1,1,0,0,1,0,1,0,0,0,0,1];assert.equal(transformPoint3D(compensated,[max,1,-max])[0],1);
  const tiny:Matrix4=[.5,0,0,0,.5,1,0,0,0,0,1,0,0,0,0,1];assert.equal(transformPoint3D(tiny,[min,min,0])[0],min);
  error('MATRIX4_RANGE',()=>transformPoint3D(composeTransform3D({scale:[max,1,1]}),[2,0,0]));
  error('MATRIX4_RANGE',()=>inverseMatrix4(composeTransform3D({scale:[min,1,1]})));
  error('MATRIX4_RANGE',()=>transformBounds3D(composeTransform3D({scale:[max,1,1]}),{min:[1,0,0],max:[2,1,1]}));
});

test('strict affine/TRS/tuple validation rejects malformed data without invoking accessors',()=>{
  const perspective=[...identityMatrix4()] as Matrix4;perspective[11]=1;assert.equal(validateMatrix4(perspective)[0].code,'MATRIX4_AFFINE');
  assert.equal(validateTransform3D({matrix:identityMatrix4(),scale:[1,1,1]})[0].code,'TRANSFORM3D_EXCLUSIVE');
  assert.ok(validateTransform3D({rotation:[0,0,0,0]}).some(d=>d.code==='QUATERNION_ZERO'));
  for(const bad of [null,[],{rotation:[1,2,3]},{scale:[1,NaN,1]},{translation:[1,2,Infinity]},{unknown:1},{scale:undefined}])assert.ok(validateTransform3D(bad).length);
  let reads=0;const accessor={get rotation(){reads++;return [0,0,0,1];}};
  assert.ok(validateTransform3D(accessor).length);assert.equal(reads,0);
  const tuple=[...identityMatrix4()];Object.defineProperty(tuple,0,{enumerable:true,get(){reads++;return 1;}});
  assert.ok(validateMatrix4(tuple).length);assert.equal(reads,0);
  assert.ok(validateMatrix4(new Float64Array(identityMatrix4())).length);
  const extra=Object.assign([...identityMatrix4()],{extra:1});assert.ok(validateMatrix4(extra).length);
  assert.ok(validateMatrix4(new Array(16)).length);
  error('BOUNDS3D_ORDER',()=>transformBounds3D(identityMatrix4(),{min:[1,0,0],max:[0,1,1]}));
  error('BOUNDS3D_TYPE',()=>transformBounds3D(identityMatrix4(),null as any));
  error('VECTOR3_TYPE',()=>transformPoint3D(identityMatrix4(),[1,2,Infinity]));
});
