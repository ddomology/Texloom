import type {DeepReadonly, Diagnostic} from '../ir/operations.js';

/** Right-handed world coordinates; +Z is up. No implicit conversion from 2D bp. */
export type Vec3 = [number, number, number];
/** Quaternion components are [x, y, z, w]. Angles accepted by helpers are radians. */
export type Quaternion = [number, number, number, number];
/** Column-major matrices acting on column vectors. PR29 matrices are affine. */
export type Matrix4 = [number,number,number,number, number,number,number,number,
  number,number,number,number, number,number,number,number];
export type Matrix3 = [number,number,number, number,number,number, number,number,number];
export type Transform3D =
  | {translation?:Vec3; rotation?:Quaternion; scale?:Vec3; matrix?:never}
  | {matrix:Matrix4; translation?:never; rotation?:never; scale?:never};
/** A nonempty axis-aligned box. An empty mesh represents its bounds separately as null. */
export interface Bounds3D {min:Vec3; max:Vec3}

export class Matrix4Error extends Error {
  readonly diagnostics: readonly Diagnostic[];
  constructor(readonly code:string, message:string, path='$') {
    super(`${code} at ${path}: ${message}`); this.name='Matrix4Error';
    this.diagnostics=Object.freeze([Object.freeze({severity:'error' as const,code,message,path})]);
  }
}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const fail=(code:string,message:string,path='$'):never=>{throw new Matrix4Error(code,message,path);};
const diagnostic=(code:string,message:string,path:string):Diagnostic=>({severity:'error',code,message,path});
const frozen=<T extends number[]>(v:T):DeepReadonly<T>=>Object.freeze(v) as DeepReadonly<T>;

/** Descriptor checks deliberately never read accessors, sparse entries, or prototype properties. */
function tupleErrors(value:unknown,length:number,path:string,code:string):Diagnostic[] {
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype||value.length!==length)
    return [diagnostic(code,`Expected an ordinary ${length}-element finite numeric tuple.`,path)];
  const descriptors=Object.getOwnPropertyDescriptors(value),errors:Diagnostic[]=[];
  if(Object.getOwnPropertySymbols(value).length||Object.keys(descriptors).length!==length+1)
    errors.push(diagnostic(code,'Numeric tuples cannot have extra properties.',path));
  for(let i=0;i<length;i++) {
    const d=descriptors[String(i)];
    if(!d||!d.enumerable||!Object.hasOwn(d,'value')||!finite(d.value))
      errors.push(diagnostic(code,'Expected a finite numeric data property.',`${path}[${i}]`));
  }
  return errors;
}
function objectErrors(value:unknown,allowed:readonly string[],path:string,code:string):Diagnostic[] {
  if(value===null||typeof value!=='object'||Array.isArray(value)||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value)))
    return [diagnostic(code,'Expected a plain data object.',path)];
  const errors:Diagnostic[]=[];
  if(Object.getOwnPropertySymbols(value).length)errors.push(diagnostic(code,'Symbol properties are unsupported.',path));
  for(const [key,d] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if(!allowed.includes(key))errors.push(diagnostic(code,`Unknown property ${key}.`,`${path}.${key}`));
    else if(!d.enumerable||!Object.hasOwn(d,'value'))errors.push(diagnostic(code,'Expected an enumerable data property.',`${path}.${key}`));
  }
  return errors;
}
function assertErrors(errors:readonly Diagnostic[]):void {
  if(errors.length){const first=errors[0];fail(first.code,first.message,first.path);}
}
function assertTuple(value:unknown,length:number,code:string,path='$'):void {assertErrors(tupleErrors(value,length,path,code));}

export function validateMatrix4(input:unknown,path='$'):Diagnostic[] {
  const errors=tupleErrors(input,16,path,'MATRIX4_TYPE');if(errors.length)return errors;
  const m=input as Matrix4;
  if(m[3]!==0||m[7]!==0||m[11]!==0||m[15]!==1)
    errors.push(diagnostic('MATRIX4_AFFINE','Expected affine last row [0, 0, 0, 1]; projection matrices are separate.',path));
  return errors;
}
export function validateTransform3D(input:unknown,path='$'):Diagnostic[] {
  const errors=objectErrors(input,['translation','rotation','scale','matrix'],path,'TRANSFORM3D_TYPE');if(errors.length)return errors;
  const t=input as Record<string,unknown>;
  if(Object.hasOwn(t,'matrix')) {
    if(['translation','rotation','scale'].some(key=>Object.hasOwn(t,key)))
      errors.push(diagnostic('TRANSFORM3D_EXCLUSIVE','matrix cannot be combined with translation, rotation or scale.',path));
    errors.push(...validateMatrix4(t.matrix,`${path}.matrix`));
  } else {
    for(const key of ['translation','scale'])if(Object.hasOwn(t,key))errors.push(...tupleErrors(t[key],3,`${path}.${key}`,'VECTOR3_TYPE'));
    if(Object.hasOwn(t,'rotation')) {
      const qe=tupleErrors(t.rotation,4,`${path}.rotation`,'QUATERNION_TYPE');errors.push(...qe);
      if(!qe.length&&(t.rotation as number[]).every(v=>v===0))errors.push(diagnostic('QUATERNION_ZERO','A quaternion must have nonzero norm.',`${path}.rotation`));
    }
  }
  return errors;
}
function assertMatrix(m:DeepReadonly<Matrix4>):void {assertErrors(validateMatrix4(m));}

/** Exact binary arithmetic is used for determinant sign and exceptional overflow cancellation.
 * It avoids a tolerance that would misclassify a small but invertible affine transform as singular.
 * Finite IEEE doubles have bounded (at most a few thousand bit) intermediate integer sizes here. */
interface Binary {n:bigint;e:number}
const bits=new DataView(new ArrayBuffer(8));
function binary(value:number):Binary {
  if(value===0)return {n:0n,e:0};
  bits.setFloat64(0,value,false);const word=bits.getBigUint64(0,false),exp=Number((word>>52n)&2047n);
  let n=word&((1n<<52n)-1n);if(exp)n|=1n<<52n;if(word>>63n)n=-n;
  return {n,e:exp?exp-1075:-1074};
}
function addBinary(a:Binary,b:Binary):Binary {
  if(!a.n)return b;if(!b.n)return a;const e=Math.min(a.e,b.e);
  return {n:(a.n<<BigInt(a.e-e))+(b.n<<BigInt(b.e-e)),e};
}
function productBinary(a:Binary,b:Binary):Binary {return {n:a.n*b.n,e:a.e+b.e};}
function differenceProduct(a:number,b:number,c:number,d:number):Binary {
  const first=productBinary(binary(a),binary(b)),second=productBinary(binary(c),binary(d));
  return addBinary(first,{n:-second.n,e:second.e});
}
function ratioNumber(a:Binary,b:Binary,underflowError=false):number {
  if(!b.n)fail('MATRIX4_SINGULAR','The linear transform is singular.');if(!a.n)return 0;
  const negative=(a.n<0n)!==(b.n<0n),n=a.n<0n?-a.n:a.n,d=b.n<0n?-b.n:b.n;
  let k=n.toString(2).length-d.toString(2).length;
  if(k>=0?n<(d<<BigInt(k)):(n<<BigInt(-k))<d)k--;
  const top=k+a.e-b.e;
  if(top>1023)fail('MATRIX4_RANGE','The result exceeds the finite numeric range.');
  const quantum=Math.max(top-52,-1074),shift=a.e-b.e-quantum;
  const numerator=shift>=0?n<<BigInt(shift):n,denominator=shift>=0?d:d<<BigInt(-shift);
  let q=numerator/denominator;const remainder=numerator%denominator;
  if(remainder*2n>denominator||(remainder*2n===denominator&&(q&1n)!==0n))q++;
  const result=Number(q)*2**quantum;
  if(!Number.isFinite(result)||underflowError&&result===0)fail('MATRIX4_RANGE','A nonzero result cannot be represented as a finite nonzero number.');
  return negative?-result:result;
}
const one:Binary={n:1n,e:0};
/** Compensated ordinary arithmetic; exact fallback when a product over/underflows. */
function dot(a:readonly number[],b:readonly number[]):number {
  let sum=0,correction=0,exact=false;
  for(let i=0;i<a.length;i++) {
    const p=a[i]*b[i],next=sum+p;
    if(!Number.isFinite(p)||!Number.isFinite(next)||p===0&&a[i]!==0&&b[i]!==0){exact=true;break;}
    correction+=Math.abs(sum)>=Math.abs(p)?(sum-next)+p:(p-next)+sum;sum=next;
  }
  const result=sum+correction;
  if(!exact&&Number.isFinite(result))return result;
  let value:Binary={n:0n,e:0};for(let i=0;i<a.length;i++)value=addBinary(value,productBinary(binary(a[i]),binary(b[i])));
  return ratioNumber(value,one);
}
function cofactors(m:DeepReadonly<Matrix4>):{values:Binary[];det:Binary} {
  const [a,d,g,,b,e,h,,c,f,i]=m;
  const values=[differenceProduct(e,i,f,h),differenceProduct(f,g,d,i),differenceProduct(d,h,e,g),
    differenceProduct(c,h,b,i),differenceProduct(a,i,c,g),differenceProduct(b,g,a,h),
    differenceProduct(b,f,c,e),differenceProduct(c,d,a,f),differenceProduct(a,e,b,d)];
  const det=addBinary(addBinary(productBinary(binary(a),values[0]),productBinary(binary(b),values[1])),productBinary(binary(c),values[2]));
  return {values,det};
}

export function identityMatrix4():DeepReadonly<Matrix4> {return frozen<Matrix4>([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);}
/** a*b applies b first, then a. */
export function multiplyMatrix4(a:DeepReadonly<Matrix4>,b:DeepReadonly<Matrix4>):DeepReadonly<Matrix4> {
  assertMatrix(a);assertMatrix(b);const result=Array<number>(16).fill(0);result[15]=1;
  for(let c=0;c<4;c++)for(let r=0;r<3;r++)result[c*4+r]=dot([a[r],a[4+r],a[8+r],a[12+r]],[b[c*4],b[c*4+1],b[c*4+2],b[c*4+3]]);
  return frozen(result as Matrix4);
}
function unit(values:readonly number[],code:string):number[] {
  const maximum=Math.max(...values.map(Math.abs));if(maximum===0)fail(code,'Cannot normalize a zero vector.');
  const scaled=values.map(v=>v/maximum),length=Math.hypot(...scaled);return scaled.map(v=>v/length);
}
export function normalizeVec3(v:DeepReadonly<Vec3>):DeepReadonly<Vec3> {assertTuple(v,3,'VECTOR3_TYPE');return frozen(unit(v,'VECTOR3_ZERO') as Vec3);}
export function normalizeQuaternion(q:DeepReadonly<Quaternion>):DeepReadonly<Quaternion> {assertTuple(q,4,'QUATERNION_TYPE');return frozen(unit(q,'QUATERNION_ZERO') as Quaternion);}
/** Positive angles rotate by the right-hand rule around axis. */
export function quaternionFromAxisAngle(axis:DeepReadonly<Vec3>,radians:number):DeepReadonly<Quaternion> {
  if(!finite(radians))fail('QUATERNION_ANGLE','The angle must be a finite number of radians.');
  const a=normalizeVec3(axis),s=Math.sin(radians/2);return normalizeQuaternion([a[0]*s,a[1]*s,a[2]*s,Math.cos(radians/2)]);
}
/** Translation * normalized quaternion rotation * scale, or an authored affine matrix. */
export function composeTransform3D(t:DeepReadonly<Transform3D>={}):DeepReadonly<Matrix4> {
  assertErrors(validateTransform3D(t));if(t.matrix)return frozen([...t.matrix] as Matrix4);
  const [x,y,z,w]=normalizeQuaternion(t.rotation??[0,0,0,1]),[sx,sy,sz]=t.scale??[1,1,1],[tx,ty,tz]=t.translation??[0,0,0];
  // Normalization roundoff can put a rotation coefficient a few ulps outside [-1,1].
  const r=(v:number)=>Math.max(-1,Math.min(1,v));
  return frozen<Matrix4>([r(1-2*(y*y+z*z))*sx,r(2*(x*y+z*w))*sx,r(2*(x*z-y*w))*sx,0,
    r(2*(x*y-z*w))*sy,r(1-2*(x*x+z*z))*sy,r(2*(y*z+x*w))*sy,0,
    r(2*(x*z+y*w))*sz,r(2*(y*z-x*w))*sz,r(1-2*(x*x+y*y))*sz,0,tx,ty,tz,1]);
}
/** Determinant magnitude must be representable; use orientationMatrix4 for sign alone. */
export function determinantMatrix4(m:DeepReadonly<Matrix4>):number {assertMatrix(m);return ratioNumber(cofactors(m).det,one,true);}
export function orientationMatrix4(m:DeepReadonly<Matrix4>):-1|0|1 {assertMatrix(m);const n=cofactors(m).det.n;return n<0n?-1:n>0n?1:0;}
/** Column-major inverse-transpose of the linear 3x3 part; translation is irrelevant. */
export function normalMatrix3D(m:DeepReadonly<Matrix4>):DeepReadonly<Matrix3> {
  assertMatrix(m);const {values:c,det}=cofactors(m);if(!det.n)fail('MATRIX4_SINGULAR','Normals require an invertible linear transform.');
  return frozen([0,3,6,1,4,7,2,5,8].map(i=>ratioNumber(c[i],det,true)) as Matrix3);
}
export function inverseMatrix4(m:DeepReadonly<Matrix4>):DeepReadonly<Matrix4> {
  assertMatrix(m);const {values:c,det}=cofactors(m);if(!det.n)fail('MATRIX4_SINGULAR','Cannot invert a singular affine transform.');
  const a=c.map(v=>ratioNumber(v,det,true));
  const tx=-dot([a[0],a[3],a[6]],[m[12],m[13],m[14]]),ty=-dot([a[1],a[4],a[7]],[m[12],m[13],m[14]]),tz=-dot([a[2],a[5],a[8]],[m[12],m[13],m[14]]);
  return frozen<Matrix4>([a[0],a[1],a[2],0,a[3],a[4],a[5],0,a[6],a[7],a[8],0,tx,ty,tz,1]);
}
export function transformPoint3D(m:DeepReadonly<Matrix4>,p:DeepReadonly<Vec3>):DeepReadonly<Vec3> {
  assertMatrix(m);assertTuple(p,3,'VECTOR3_TYPE');const v=[...p,1];
  return frozen([0,1,2].map(r=>dot([m[r],m[4+r],m[8+r],m[12+r]],v)) as Vec3);
}
/** An unnormalized direction; translation is ignored and a zero direction is valid. */
export function transformDirection3D(m:DeepReadonly<Matrix4>,v:DeepReadonly<Vec3>):DeepReadonly<Vec3> {
  assertMatrix(m);assertTuple(v,3,'VECTOR3_TYPE');return frozen([0,1,2].map(r=>dot([m[r],m[4+r],m[8+r]],v)) as Vec3);
}
/** Inverse-transpose unit normal; it does not include the determinant sign for triangle winding. */
export function transformNormal3D(m:DeepReadonly<Matrix4>,n:DeepReadonly<Vec3>):DeepReadonly<Vec3> {
  assertTuple(n,3,'VECTOR3_TYPE');if(n.every(v=>v===0))fail('VECTOR3_ZERO','Cannot normalize a zero normal.');
  const a=normalMatrix3D(m),products=[0,1,2].map(r=>[0,1,2].reduce((s,c)=>addBinary(s,productBinary(binary(a[c*3+r]),binary(n[c]))),{n:0n,e:0}));
  // Normalize the result, not the inputs: a very small input component may be amplified by scale.
  const magnitude=(v:Binary):Binary=>({n:v.n<0n?-v.n:v.n,e:v.e});
  let maximum:Binary={n:0n,e:0};
  for(const p of products){const v=magnitude(p);if(addBinary(v,{n:-maximum.n,e:maximum.e}).n>0n)maximum=v;}
  if(!maximum.n)fail('VECTOR3_ZERO','The transformed normal has zero norm.');
  return normalizeVec3(products.map(v=>ratioNumber(v,maximum)) as Vec3);
}
export function transformBounds3D(m:DeepReadonly<Matrix4>,bounds:DeepReadonly<Bounds3D>):DeepReadonly<Bounds3D> {
  assertMatrix(m);assertErrors(objectErrors(bounds,['min','max'],'$','BOUNDS3D_TYPE'));
  assertTuple(bounds.min,3,'BOUNDS3D_TYPE','$.min');assertTuple(bounds.max,3,'BOUNDS3D_TYPE','$.max');
  if(bounds.min.some((v,i)=>v>bounds.max[i]))fail('BOUNDS3D_ORDER','Each minimum must be less than or equal to its maximum.');
  const minimum:Vec3=[Infinity,Infinity,Infinity],maximum:Vec3=[-Infinity,-Infinity,-Infinity];
  for(let corner=0;corner<8;corner++) {
    const p=transformPoint3D(m,[0,1,2].map(i=>(corner&(1<<i))?bounds.max[i]:bounds.min[i]) as Vec3);
    for(let i=0;i<3;i++){minimum[i]=Math.min(minimum[i],p[i]);maximum[i]=Math.max(maximum[i],p[i]);}
  }
  return Object.freeze({min:frozen(minimum),max:frozen(maximum)});
}
