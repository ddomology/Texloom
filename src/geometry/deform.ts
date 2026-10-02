import {OperationValidationError, type DeepReadonly} from '../ir/operations.js';
import {freezeSnapshot, validateJsonData} from '../operations/values.js';
import {validatePathGeometry} from '../path-contract.js';
import {evaluateSegment, splitSegment, type PathGeometry, type PathPoint, type PathSegment} from '../path-geometry.js';
import type {ExpressionValue} from '../fields/ast.js';
import {affineDeformation, boundDeformation, deformationError, deformationParameters, evaluateDeformation,
  DeformationIntervalUncertain, outward, type CompiledDeformation, type Rectangle} from './deform-expression.js';

export type DeformationMode='controlDeform'|'pointwiseDeform';
export interface DeformationOptions {
  mode:DeformationMode;time:number;parameters?:Readonly<Record<string,ExpressionValue>>;
  tolerance?:number;maxDepth?:number;maxSegments?:number;
}
export interface DeformationSegmentReport {
  contourId:string;sourceSegmentId:string|null;outputSegmentId:string;
  sourceInterval:[number,number];parameterInterval:[number,number];closing:boolean;errorBound:number;
  /** Control-dependent endpoint maps can create a new implicit closing edge. */
  synthetic?:'closing-edge';
}
export interface DeformationReport {
  method:'control'|'affine-exact'|'adaptive-polyline';sourceSegments:number;outputSegments:number;
  maxErrorBound:number;tolerance:number;subdivisions:number;maxDepthReached:number;
  tangentPolicy:'control-curve'|'affine-curve'|'polyline-right-hand';
  /** Error is curve-image to chord, in local bp; it is not a derivative bound. */
  boundPolicy:'exact-control-map'|'affine-real-arithmetic'|'interval-image-to-chord';
  precision:'float64-with-outward-arithmetic-and-libm-guard';
  segments:DeformationSegmentReport[];
}
export interface DeformationResult {geometry:DeepReadonly<PathGeometry>;report:DeepReadonly<DeformationReport>}
interface SourceSegment {contourId:string;start:PathPoint;segment:PathSegment;closing:boolean;u0:number;u1:number}
const same=(a:readonly number[],b:readonly number[])=>a[0]===b[0]&&a[1]===b[1];
const copy=(p:readonly [number,number]):PathPoint=>[...p];
const drawable=(start:PathPoint,segment:PathSegment)=>!same(start,segment.to)||segment.kind==='cubic'&&(!same(start,segment.c1)||!same(start,segment.c2));

/** All source segments survive; only drawable segments consume global parameter. */
function sourceSegments(geometry:DeepReadonly<PathGeometry>):SourceSegment[] {
  const result:SourceSegment[]=[];
  for(const contour of geometry.contours) {
    let start=copy(contour.start);
    for(const segment of contour.segments) {
      result.push({contourId:contour.id,start,segment:structuredClone(segment) as PathSegment,closing:false,u0:0,u1:0});start=copy(segment.to);
    }
    if(contour.closed&&!same(start,contour.start))result.push({contourId:contour.id,start,segment:{id:`${contour.id}:close`,kind:'line',to:copy(contour.start)},closing:true,u0:0,u1:0});
  }
  const count=result.filter(entry=>drawable(entry.start,entry.segment)).length;
  let index=0;
  for(const entry of result) {entry.u0=count?index/count:0;if(drawable(entry.start,entry.segment))index++;entry.u1=count?index/count:0;}
  return result;
}
function provenance(source:SourceSegment,outputSegmentId:string,t0=0,t1=1,errorBound=0):DeformationSegmentReport {
  return {contourId:source.contourId,sourceSegmentId:source.segment.id,outputSegmentId,sourceInterval:[t0,t1],
    parameterInterval:[source.u0+(source.u1-source.u0)*t0,source.u0+(source.u1-source.u0)*t1],closing:source.closing,errorBound};
}
/** Exact/control mapping preserves authored segments, but an implicit closing
 * edge can appear/disappear when its two mapped endpoints separate/collapse. */
function exactProvenance(sources:SourceSegment[],output:DeepReadonly<PathGeometry>):DeformationSegmentReport[] {
  const byId=new Map(sources.map(source=>[JSON.stringify([source.contourId,source.segment.id]),source]));
  const contourEnd=new Map(sources.map(source=>[source.contourId,source.u1]));
  return sourceSegments(output).map(segment=>{
    const source=byId.get(JSON.stringify([segment.contourId,segment.segment.id]));
    if(source)return provenance(source,segment.segment.id);
    const seam=contourEnd.get(segment.contourId)??0;
    return {contourId:segment.contourId,sourceSegmentId:null,outputSegmentId:segment.segment.id,
      sourceInterval:[1,1],parameterInterval:[seam,seam],closing:true,errorBound:0,synthetic:'closing-edge'};
  });
}

/**
 * Detached deterministic deformation. Pointwise output is a certified-envelope
 * polyline for the supported expression subset, never a fit through sparse samples.
 * Its ordinary path parameterization is by output segments; provenance retains
 * source parameter intervals. Tangents are consequently segmentwise/right-hand.
 */
export function deformGeometry(input:DeepReadonly<PathGeometry>,compiled:CompiledDeformation,options:DeformationOptions):DeformationResult {
  const errors=validateJsonData(input,'$.deformation.geometry');
  errors.push(...validateJsonData(options,'$.deformation.options'));
  errors.push(...validatePathGeometry(input).map(error=>({severity:'error' as const,code:'DEFORMATION_GEOMETRY',message:error.message,path:'$.deformation.geometry'+error.path})));
  if(errors.length)throw new OperationValidationError(errors);
  if(!options||!['controlDeform','pointwiseDeform'].includes(options.mode))deformationError(compiled,'DEFORMATION_MODE','Expected controlDeform or pointwiseDeform.');
  if(Object.keys(options).some(key=>!['mode','time','parameters','tolerance','maxDepth','maxSegments'].includes(key)))
    deformationError(compiled,'DEFORMATION_OPTIONS','Unknown deformation option.');
  if(!Number.isFinite(options.time))deformationError(compiled,'DEFORMATION_TIME','Deformation time must be finite.');
  const tolerance=options.tolerance??.25,maxDepth=options.maxDepth??16,maxSegments=options.maxSegments??32768;
  if(!Number.isFinite(tolerance)||tolerance<=0)deformationError(compiled,'DEFORMATION_TOLERANCE','Tolerance must be a positive finite local-bp length.');
  if(!Number.isSafeInteger(maxDepth)||maxDepth<1||maxDepth>24||!Number.isSafeInteger(maxSegments)||maxSegments<1||maxSegments>131072)
    deformationError(compiled,'DEFORMATION_BUDGET','maxDepth must be 1–24 and maxSegments 1–131072.');
  const parameters=deformationParameters(compiled,options.parameters),geometry=structuredClone(input) as PathGeometry,sources=sourceSegments(input);
  const report:DeformationReport={method:'control',sourceSegments:sources.length,outputSegments:sources.length,maxErrorBound:0,tolerance,subdivisions:0,maxDepthReached:0,
    tangentPolicy:'control-curve',boundPolicy:'exact-control-map',precision:'float64-with-outward-arithmetic-and-libm-guard',segments:[]};
  if(sources.length>maxSegments)deformationError(compiled,'DEFORMATION_BUDGET','Source segment count exceeds maxSegments.');
  if(options.mode==='controlDeform') {
    const controls:PathPoint[]=[];
    for(const contour of geometry.contours) {controls.push(contour.start);for(const segment of contour.segments) {
      if(segment.kind==='cubic')controls.push(segment.c1,segment.c2);controls.push(segment.to);
    }}
    const values=controls.map((position,index)=>evaluateDeformation(compiled,options.time,parameters,{position,index,count:controls.length,parameter:controls.length>1?index/(controls.length-1):0}));
    let next=0;for(const contour of geometry.contours) {contour.start=values[next++];for(const segment of contour.segments) {
      if(segment.kind==='cubic') {segment.c1=values[next++];segment.c2=values[next++];}segment.to=values[next++];
    }}
    report.segments=exactProvenance(sources,geometry);
    // Control-dependent maps may open a formerly coincident final endpoint. It
    // remains a legitimate closed control polygon, including its closing edge.
    report.outputSegments=report.segments.length;
    if(report.outputSegments>maxSegments)deformationError(compiled,'DEFORMATION_BUDGET','Mapped closing edges exceed maxSegments.');
    return freezeSnapshot({geometry,report});
  }
  if(['index','count'].some(name=>Object.prototype.hasOwnProperty.call(compiled.parameterTypes,name)))
    deformationError(compiled,'DEFORMATION_CONTEXT','index/count are only defined for controlDeform.');
  const affine=affineDeformation(compiled,options.time,parameters);
  if(affine) {
    const map=(point:PathPoint):PathPoint=>{
      // Symbolic coefficients establish affinity only. Preserve the expression's
      // arithmetic order/domain checks instead of canceling overflowing terms.
      return evaluateDeformation(compiled,options.time,parameters,{position:point,parameter:0});
    };
    for(const contour of geometry.contours) {contour.start=map(contour.start);for(const segment of contour.segments) {
      if(segment.kind==='cubic') {segment.c1=map(segment.c1);segment.c2=map(segment.c2);}segment.to=map(segment.to);
    }}
    report.method='affine-exact';report.tangentPolicy='affine-curve';report.boundPolicy='affine-real-arithmetic';report.segments=exactProvenance(sources,geometry);
    report.outputSegments=report.segments.length;
    return freezeSnapshot({geometry,report});
  }
  report.method='adaptive-polyline';report.tangentPolicy='polyline-right-hand';report.boundPolicy='interval-image-to-chord';report.outputSegments=0;
  const sourceByContour=new Map<string,SourceSegment[]>();for(const source of sources)sourceByContour.set(source.contourId,[...(sourceByContour.get(source.contourId)??[]),source]);
  const pointAt=(source:SourceSegment,t:number)=>evaluateDeformation(compiled,options.time,parameters,
    {position:evaluateSegment(source.start,source.segment,t),parameter:source.u0+(source.u1-source.u0)*t});
  let parameterCursor=0;
  for(const contour of geometry.contours) {
    const segments=sourceByContour.get(contour.id)??[],originalStart=copy(contour.start);
    const initial=segments.length?pointAt(segments[0],0):evaluateDeformation(compiled,options.time,parameters,{position:originalStart,parameter:parameterCursor});
    contour.start=initial;contour.segments=[];
    for(const source of segments) {
      const start=pointAt(source,0),end=pointAt(source,1);
      const visit=(localStart:PathPoint,segment:PathSegment,t0:number,t1:number,a:PathPoint,b:PathPoint,depth:number,branch:string):void=>{
        report.maxDepthReached=Math.max(report.maxDepthReached,depth);
        const sourcePoints=[localStart,...(segment.kind==='cubic'?[segment.c1,segment.c2]:[]),segment.to];
        const scale=Math.max(1,...sourcePoints.flat().map(Math.abs));
        // De Casteljau's convex-combination arithmetic is widened to cover its
        // accumulated Float64 error before feeding the expression enclosure.
        const padding=64*Number.EPSILON*scale*(depth+1);
        const rectangle:Rectangle=[0,1].map(axis=>[outward(Math.min(...sourcePoints.map(p=>p[axis]))-padding,-1),
          outward(Math.max(...sourcePoints.map(p=>p[axis]))+padding,1)]) as unknown as Rectangle;
        const u0=source.u0+(source.u1-source.u0)*t0,u1=source.u0+(source.u1-source.u0)*t1;
        let errorBound=Infinity,uncertain:DeformationIntervalUncertain|undefined;
        try {
          const bound=boundDeformation(compiled,rectangle,[outward(u0,-1),outward(u1,1)],options.time,parameters);
          errorBound=rectangleDistance(bound,a,b);
        } catch(error) {if(error instanceof DeformationIntervalUncertain)uncertain=error;else throw error;}
        if(errorBound<=tolerance) {
          if(report.outputSegments>=maxSegments)deformationError(compiled,'DEFORMATION_BUDGET',`Pointwise deformation exceeded ${maxSegments} output segments.`);
          const id=JSON.stringify([source.segment.id,branch]);
          contour.segments.push({id,kind:'line',to:b});report.outputSegments++;
          report.maxErrorBound=Math.max(report.maxErrorBound,errorBound);report.segments.push(provenance(source,id,t0,t1,errorBound));return;
        }
        if(depth>=maxDepth)deformationError(compiled,uncertain?'DEFORMATION_INTERVAL_DOMAIN':'DEFORMATION_TOLERANCE',
          uncertain?`Cannot certify interval at depth ${maxDepth}: ${uncertain.message}`:`Cannot meet ${tolerance}bp tolerance at depth ${maxDepth}; bound is ${errorBound}bp.`,uncertain?.node);
        if(report.subdivisions>=maxSegments)deformationError(compiled,'DEFORMATION_BUDGET',`Pointwise subdivision exceeded ${maxSegments} splits.`);
        const midpoint=(t0+t1)/2,[left,right]=splitSegment(localStart,segment,.5),mapped=pointAt(source,midpoint);
        report.subdivisions++;
        visit(localStart,left,t0,midpoint,a,mapped,depth+1,branch+'0');
        visit(left.to,right,midpoint,t1,mapped,b,depth+1,branch+'1');
      };
      visit(source.start,source.segment,0,1,start,end,0,'');parameterCursor=source.u1;
    }
    if(contour.closed&&contour.segments.length) {
      const last=contour.segments.at(-1)!,distance=Math.hypot(last.to[0]-contour.start[0],last.to[1]-contour.start[1]);
      if(distance!==0) {
        const allowance=Math.min(tolerance/32,64*Number.EPSILON*Math.max(1,...last.to.map(Math.abs),...contour.start.map(Math.abs)));
        if(distance>allowance)deformationError(compiled,'DEFORMATION_CLOSURE','Pointwise deformation maps the two sides of a closed contour seam to different positions.');
        const leaf=report.segments.at(-1)!;
        if(leaf.errorBound+distance>tolerance)deformationError(compiled,'DEFORMATION_TOLERANCE','Closing-seam roundoff exceeds tolerance.');
        leaf.errorBound=outward(leaf.errorBound+distance,1);report.maxErrorBound=Math.max(report.maxErrorBound,leaf.errorBound);last.to=copy(contour.start);
      }
    }
  }
  return freezeSnapshot({geometry,report});
}

/** Distance to a convex segment is convex: rectangle corners bound its interior. */
function rectangleDistance(rectangle:Rectangle,a:PathPoint,b:PathPoint):number {
  const dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);
  if(!Number.isFinite(length))return Infinity;
  const distance=(x:number,y:number):number=>{
    if(length===0)return Math.hypot(x-a[0],y-a[1]);
    const ux=dx/length,uy=dy/length,along=(x-a[0])*ux+(y-a[1])*uy;
    const t=Math.max(0,Math.min(length,along));return Math.hypot(x-a[0]-t*ux,y-a[1]-t*uy);
  };
  const result=Math.max(...rectangle[0].flatMap(x=>rectangle[1].map(y=>distance(x,y))));
  const scale=Math.max(1,...rectangle.flat().map(Math.abs),...a.map(Math.abs),...b.map(Math.abs));
  return outward(result+64*Number.EPSILON*scale,1);
}
