import type {DeepReadonly, Diagnostic} from '../ir/operations.js';
import {freezeSnapshot} from '../operations/values.js';
import {validateAssetJson} from './package.js';

/** Portable numeric backing storage. Byte offsets/strides are independent of host endianness. */
export interface NumericBuffer {
  version:1;
  componentType:'float32'|'float64'|'uint16'|'uint32';
  components:1|2|3|4;
  count:number;
  byteOffset:number;
  byteStride:number;
  data:number[];
}
export type OwnedNumericArray=Float32Array|Float64Array|Uint16Array|Uint32Array;
export const MAX_BUFFER_COMPONENTS=262_144;
export class BufferError extends Error {
  readonly code:string;
  readonly diagnostics:DeepReadonly<Diagnostic[]>;
  constructor(diagnostics:readonly Diagnostic[]) {
    super(diagnostics.map(d=>`${d.code}: ${d.message} (${d.path??'$'})`).join('\n'));
    this.name='BufferError';this.code=diagnostics[0]?.code??'BUFFER_INVALID';
    this.diagnostics=freezeSnapshot(diagnostics);
  }
}
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const bytes=(type:NumericBuffer['componentType'])=>type==='uint16'?2:type==='float64'?8:4;

export function validateNumericBuffer(input:unknown,path='$.buffer'):Diagnostic[] {
  const out=validateAssetJson(input,path);if(out.length)return out;
  const fail=(code:string,message:string,where=path)=>out.push({severity:'error',code,message,path:where});
  if(!object(input)){fail('BUFFER_TYPE','Expected a numeric buffer descriptor.');return out;}
  for(const key of Object.keys(input))if(!['version','componentType','components','count','byteOffset','byteStride','data'].includes(key))
    fail('BUFFER_PROPERTY',`Unsupported property ${key}.`,`${path}.${key}`);
  if(input.version!==1)fail('BUFFER_VERSION','Supported numeric buffer version is 1.',`${path}.version`);
  if(!['float32','float64','uint16','uint32'].includes(input.componentType as string))fail('BUFFER_COMPONENT_TYPE','Expected float32, float64, uint16 or uint32.',`${path}.componentType`);
  if(![1,2,3,4].includes(input.components as number))fail('BUFFER_COMPONENTS','Each element requires 1–4 components.',`${path}.components`);
  for(const key of ['count','byteOffset','byteStride'])if(!Number.isSafeInteger(input[key])||(input[key] as number)<0)
    fail('BUFFER_LAYOUT',`${key} must be a nonnegative safe integer.`,`${path}.${key}`);
  if(!Array.isArray(input.data)){fail('BUFFER_DATA','Expected a numeric JSON array.',`${path}.data`);return out;}
  if(input.data.length>MAX_BUFFER_COMPONENTS)fail('BUFFER_LIMIT',`Backing data exceeds ${MAX_BUFFER_COMPONENTS} components.`,`${path}.data`);
  if(out.length)return out;
  const value=input as unknown as NumericBuffer,size=bytes(value.componentType);
  if(value.byteOffset%size!==0||value.byteStride%size!==0||value.byteStride<value.components*size)
    fail('BUFFER_ALIGNMENT','Offset and stride must be component-aligned; stride must contain a complete element.');
  const end=value.count===0?value.byteOffset:value.byteOffset+(value.count-1)*value.byteStride+value.components*size;
  if(!Number.isSafeInteger(end)||end>value.data.length*size)
    fail('BUFFER_RANGE','The addressed elements exceed the backing data.');
  if(!Number.isSafeInteger(value.count*value.components)||value.count*value.components>MAX_BUFFER_COMPONENTS)
    fail('BUFFER_LIMIT',`The compact output exceeds ${MAX_BUFFER_COMPONENTS} components.`);
  for(let i=0;i<value.data.length;i++){
    const n=value.data[i];
    if(typeof n!=='number'||!Number.isFinite(n)){fail('BUFFER_VALUE','Components must be finite numbers.',`${path}.data[${i}]`);break;}
    if(value.componentType==='float32'){
      if(!Number.isFinite(Math.fround(n))){fail('BUFFER_OVERFLOW','A component overflows float32.',`${path}.data[${i}]`);break;}
    }else if(value.componentType!=='float64'&&(!Number.isInteger(n)||n<0||n>(value.componentType==='uint16'?65_535:4_294_967_295))){
      fail('BUFFER_VALUE',`A component is outside ${value.componentType}.`,`${path}.data[${i}]`);break;
    }
  }
  return out;
}

/** Every call creates compact caller-owned storage; mutating it cannot affect a resource or another consumer. */
export function copyNumericBuffer(input:unknown,path='$.buffer'):OwnedNumericArray {
  const diagnostics=validateNumericBuffer(input,path);if(diagnostics.length)throw new BufferError(diagnostics);
  const value=input as NumericBuffer,size=bytes(value.componentType),length=value.count*value.components;
  const result=value.componentType==='float32'?new Float32Array(length):value.componentType==='float64'?new Float64Array(length):value.componentType==='uint16'?new Uint16Array(length):new Uint32Array(length);
  const offset=value.byteOffset/size,stride=value.byteStride/size;
  for(let i=0;i<value.count;i++)for(let c=0;c<value.components;c++)result[i*value.components+c]=value.data[offset+i*stride+c];
  return result;
}

export function snapshotNumericBuffer(input:unknown,path='$.buffer'):DeepReadonly<NumericBuffer> {
  const diagnostics=validateNumericBuffer(input,path);if(diagnostics.length)throw new BufferError(diagnostics);
  return freezeSnapshot(input as NumericBuffer);
}
