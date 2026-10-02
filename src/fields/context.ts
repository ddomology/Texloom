import {OperationValidationError, type DeepReadonly, type Diagnostic} from '../ir/operations.js';
import {validatePathGeometry} from '../path-contract.js';
import {PathGeometryError, sampleGeometry, type PathGeometry} from '../path-geometry.js';
import {freezeSnapshot, validateJsonData} from '../operations/values.js';
import type {FieldContext, FieldDomainDeclaration, FieldElement} from './types.js';

const nonempty=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0;
function fail(code:string,message:string,path:string):never {
  throw new OperationValidationError([{severity:'error',code,message,path}]);
}
const point=(value:unknown):value is [number,number]=>Array.isArray(value)&&value.length===2&&value.every(v=>typeof v==='number'&&Number.isFinite(v));

/** Sorted stable topology omits coordinates and authored traversal order. */
function topology(geometry:DeepReadonly<PathGeometry>):unknown[] {
  return geometry.contours.map(contour=>({id:contour.id,closed:contour.closed??false,
    segments:contour.segments.map(segment=>({id:segment.id,kind:segment.kind})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0),
  })).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
}

interface Control {id:string; point:readonly [number,number]}
function controls(geometry:DeepReadonly<PathGeometry>):Control[] {
  const result:Control[]=[];
  for(const contour of geometry.contours) {
    result.push({id:JSON.stringify([contour.id,null,'start']),point:contour.start});
    for(const segment of contour.segments) {
      if(segment.kind==='cubic')for(const slot of ['c1','c2'] as const)
        result.push({id:JSON.stringify([contour.id,segment.id,slot]),point:segment[slot]});
      result.push({id:JSON.stringify([contour.id,segment.id,'to']),point:segment.to});
    }
  }
  return result;
}

/** Validate portable contexts before datasets are matched or evaluated. */
export function assertFieldContext(context:DeepReadonly<FieldContext>):void {
  const diagnostics=validateJsonData(context,'$.fieldContext');
  if(diagnostics.length)throw new OperationValidationError(diagnostics);
  if(!context||typeof context!=='object'||!context.geometry||!nonempty(context.geometry.id)||
      !context.domain||!nonempty(context.domain.id)||!nonempty(context.domain.key)||!['path-control','curve-sample'].includes(context.domain.kind))
    fail('FIELD_CONTEXT','Context requires geometry and domain identity.','$.fieldContext');
  if(!Number.isFinite(context.time))fail('FIELD_TIME','Context time must be finite.','$.fieldContext.time');
  if(!Array.isArray(context.elements)||!context.elements.length)fail('FIELD_ELEMENTS','Context must contain at least one element.','$.fieldContext.elements');
  const ids=new Set<string>(),indices=new Set<number>();
  context.elements.forEach((element,i)=>{
    const path=`$.fieldContext.elements[${i}]`;
    if(!element||!nonempty(element.id)||ids.has(element.id))fail('FIELD_ELEMENT_ID','Element IDs must be unique nonempty strings.',path+'.id');
    ids.add(element.id);
    if(!Number.isSafeInteger(element.index)||element.index<0||element.index>=context.elements.length||indices.has(element.index))
      fail('FIELD_ELEMENT_INDEX','Element indices must uniquely cover the traversal range.',path+'.index');
    indices.add(element.index);
    if(!Number.isFinite(element.parameter)||element.parameter<0||element.parameter>1)
      fail('FIELD_PARAMETER','Element parameter must be in [0, 1].',path+'.parameter');
    if(!point(element.position)||!point(element.originalPosition))fail('FIELD_POSITION','Element positions must be finite vec2 values.',path);
  });
}

/** Controls use traversal ordinal/(count-1); samples use global curve parameter. */
export function createFieldContext(declaration:DeepReadonly<FieldDomainDeclaration>,originalGeometry:DeepReadonly<PathGeometry>,
  currentGeometry:DeepReadonly<PathGeometry>,time:number):DeepReadonly<FieldContext> {
  const diagnostics:Diagnostic[]=[...validateJsonData(declaration,'$.fieldDomain'),...validateJsonData(originalGeometry,'$.originalGeometry'),
    ...validateJsonData(currentGeometry,'$.currentGeometry')];
  if(diagnostics.length)throw new OperationValidationError(diagnostics);
  if(!declaration||!nonempty(declaration.id)||!nonempty(declaration.geometry)||!['path-control','curve-sample'].includes(declaration.domain))
    fail('FIELD_DOMAIN','Domain requires an ID, geometry ID and supported kind.','$.fieldDomain');
  if(!Number.isFinite(time))fail('FIELD_TIME','Field time must be finite.','$.fieldContext.time');
  for(const [name,geometry] of [['originalGeometry',originalGeometry],['currentGeometry',currentGeometry]] as const) {
    const errors=validatePathGeometry(geometry);
    if(errors.length)throw new OperationValidationError(errors.map(error=>({severity:'error',code:'FIELD_GEOMETRY',message:error.message,path:`$.${name}${error.path}`})));
    if(!geometry.contours.length)fail('FIELD_GEOMETRY','Field domains require nonempty geometry.',`$.${name}`);
  }
  const shape=topology(currentGeometry);
  if(JSON.stringify(topology(originalGeometry))!==JSON.stringify(shape))
    fail('FIELD_TOPOLOGY','Original and current geometry must have the same stable topology.','$.currentGeometry');
  const elements:FieldElement[]=[];
  let identity:unknown[];
  if(declaration.domain==='path-control') {
    if(declaration.samples!==undefined)fail('FIELD_DOMAIN','Control domains cannot declare curve samples.','$.fieldDomain.samples');
    const original=new Map(controls(originalGeometry).map(control=>[control.id,control.point]));
    const current=controls(currentGeometry);
    current.forEach((control,index)=>elements.push({id:control.id,index,parameter:current.length===1?0:index/(current.length-1),
      position:[...control.point],originalPosition:[...original.get(control.id)!]}));
    identity=current.map(control=>control.id).sort();
  } else {
    if(!Array.isArray(declaration.samples)||!declaration.samples.length)fail('FIELD_SAMPLES','Curve domains require explicit samples.','$.fieldDomain.samples');
    const ids=new Set<string>();
    declaration.samples.forEach((sample,index)=>{
      const path=`$.fieldDomain.samples[${index}]`;
      if(!sample||!nonempty(sample.id)||ids.has(sample.id))fail('FIELD_ELEMENT_ID','Sample IDs must be unique nonempty strings.',path+'.id');
      ids.add(sample.id);
      if(!Number.isFinite(sample.parameter)||sample.parameter<0||sample.parameter>1)fail('FIELD_PARAMETER','Sample parameter must be in [0, 1].',path+'.parameter');
      try {
        const position=sampleGeometry(currentGeometry as PathGeometry,sample.parameter,'parameter').point;
        const originalPosition=sampleGeometry(originalGeometry as PathGeometry,sample.parameter,'parameter').point;
        if(!point(position)||!point(originalPosition))fail('FIELD_POSITION','Sampled position must be finite.',path);
        elements.push({id:sample.id,index,parameter:sample.parameter,position:[...position],originalPosition:[...originalPosition]});
      } catch(error) {
        if(error instanceof PathGeometryError)fail('FIELD_GEOMETRY',`${error.code}: ${error.message}`,path);
        throw error;
      }
    });
    identity=declaration.samples.map(sample=>({id:sample.id,parameter:sample.parameter})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  }
  const key=JSON.stringify(['texloom-field-domain/1',declaration.geometry,declaration.id,declaration.domain,shape,identity]);
  const result:FieldContext={geometry:{id:declaration.geometry},domain:{id:declaration.id,kind:declaration.domain,key},time,elements};
  assertFieldContext(result);
  return freezeSnapshot(result);
}
