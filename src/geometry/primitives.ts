import {OperationValidationError,type DeepReadonly,type Diagnostic} from '../ir/operations.js';
import {freezeSnapshot,validateJsonData} from '../operations/values.js';
import type {PathGeometry,PathPoint,PathSegment,PathBounds} from '../path-geometry.js';

export type Primitive2D=
  |{kind:'circle';center:[number,number];radius:number}
  |{kind:'ellipse';center:[number,number];rx:number;ry:number}
  |{kind:'arc';center:[number,number];rx:number;ry:number;startAngle:number;sweepAngle:number}
  |{kind:'rectangle';origin:[number,number];width:number;height:number}
  |{kind:'roundedRectangle';origin:[number,number];width:number;height:number;cornerRadius:number}
  |{kind:'polyline';points:[number,number][];closed:boolean};
export interface PrimitivePathOptions {profile:'cubic'|'polyline';tolerance:number;maxSegments:number}
export interface PrimitivePathReport {
  profile:'cubic'|'polyline';tolerance:number;errorBound:number;segments:number;closed:boolean;
  analyticKind:Primitive2D['kind'];precision:'float64-with-roundoff-guard';
  spans:{segmentId:string;parameterInterval:[number,number];errorBound:number;source:'line'|'arc'}[];
}
export interface PrimitivePathResult {geometry:DeepReadonly<PathGeometry>;report:DeepReadonly<PrimitivePathReport>}
const TAU=2*Math.PI;
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const equal=(a:readonly number[],b:readonly number[])=>a[0]===b[0]&&a[1]===b[1];
const copy=(point:readonly [number,number]):PathPoint=>[...point];
function fail(code:string,message:string,path='$.primitive'):never {throw new OperationValidationError([{severity:'error',code,message,path}]);}

/** Portable analytic definitions; no approximation settings are part of a shape. */
export function validatePrimitive(input:unknown):Diagnostic[] {
  const errors=validateJsonData(input,'$.primitive');if(errors.length)return errors;
  const error=(code:string,message:string,path='$.primitive')=>errors.push({severity:'error',code,message,path});
  if(!object(input)){error('PRIMITIVE_TYPE','Expected an analytic primitive object.');return errors;}
  const keys:Record<string,string[]>={circle:['kind','center','radius'],ellipse:['kind','center','rx','ry'],
    arc:['kind','center','rx','ry','startAngle','sweepAngle'],rectangle:['kind','origin','width','height'],
    roundedRectangle:['kind','origin','width','height','cornerRadius'],polyline:['kind','points','closed']};
  if(typeof input.kind!=='string'||!Object.hasOwn(keys,input.kind)){error('PRIMITIVE_TYPE','Unsupported analytic primitive kind.','$.primitive.kind');return errors;}
  for(const key of Object.keys(input))if(!keys[input.kind].includes(key))error('PRIMITIVE_FIELD',`Unknown primitive field ${key}.`,'$.primitive.'+key);
  const point=(value:unknown,path:string):value is [number,number]=>{
    if(!Array.isArray(value)||value.length!==2||!value.every(finite)){error('PRIMITIVE_DOMAIN','Expected a finite [x,y] point.',path);return false;}return true;
  };
  const positive=(key:string)=>{if(!finite(input[key])||input[key]<=0)error('PRIMITIVE_DOMAIN',`${key} must be positive and finite.`,'$.primitive.'+key);};
  if(['circle','ellipse','arc'].includes(input.kind)) {
    point(input.center,'$.primitive.center');
    if(input.kind==='circle')positive('radius');else {positive('rx');positive('ry');}
    if(input.kind==='arc') {
      if(!finite(input.startAngle))error('PRIMITIVE_DOMAIN','startAngle must be finite radians.','$.primitive.startAngle');
      if(!finite(input.sweepAngle)||input.sweepAngle===0||Math.abs(input.sweepAngle)>TAU)
        error('PRIMITIVE_DOMAIN','sweepAngle must be nonzero radians in [-2π,2π].','$.primitive.sweepAngle');
    }
  } else if(input.kind==='rectangle'||input.kind==='roundedRectangle') {
    point(input.origin,'$.primitive.origin');positive('width');positive('height');
    if(input.kind==='roundedRectangle'&&(!finite(input.cornerRadius)||input.cornerRadius<0||
      finite(input.width)&&finite(input.height)&&input.cornerRadius>Math.min(input.width,input.height)/2))
      error('PRIMITIVE_DOMAIN','cornerRadius must lie in [0,min(width,height)/2].','$.primitive.cornerRadius');
  } else {
    if(typeof input.closed!=='boolean')error('PRIMITIVE_DOMAIN','Polyline closed must be boolean.','$.primitive.closed');
    if(!Array.isArray(input.points)||input.points.length<(input.closed===true?3:2))
      error('PRIMITIVE_DOMAIN','Open polylines require at least two points; closed polylines require at least three.','$.primitive.points');
    else {
      const valid=input.points.map((value,i)=>point(value,`$.primitive.points[${i}]`));
      for(let i=1;i<input.points.length;i++)if(valid[i]&&valid[i-1]&&equal(input.points[i] as number[],input.points[i-1] as number[]))
        error('PRIMITIVE_DOMAIN','Consecutive repeated polyline points create an undefined tangent.',`$.primitive.points[${i}]`);
      if(input.closed&&valid[0]&&valid.at(-1)&&equal(input.points[0] as number[],input.points.at(-1) as number[]))
        error('PRIMITIVE_DOMAIN','Closed polylines close implicitly; do not repeat the first point.','$.primitive.points');
    }
  }
  return errors;
}
function assertPrimitive(primitive:DeepReadonly<Primitive2D>):void {
  const errors=validatePrimitive(primitive);if(errors.length)throw new OperationValidationError(errors);
}
function checked(point:PathPoint,message='Primitive produced nonfinite coordinates.'):PathPoint {
  if(!point.every(Number.isFinite))fail('PRIMITIVE_NONFINITE',message);return point;
}
function unit(vector:PathPoint):PathPoint {
  const scale=Math.max(...vector.map(Math.abs));
  if(!Number.isFinite(scale)||scale===0)fail('PRIMITIVE_NONFINITE','Primitive tangent is not finitely representable.');
  const x=vector[0]/scale,y=vector[1]/scale,length=Math.hypot(x,y);return [x/length,y/length];
}
/** Avoid adding a small sweep directly to a very large authored angle. */
const phase=(angle:number)=>Math.atan2(Math.sin(angle),Math.cos(angle));
function trig(angle:number):[number,number] {
  const quarter=Math.round(angle/(Math.PI/2));
  if(angle===quarter*(Math.PI/2)) {
    const quadrant=((quarter%4)+4)%4;return quadrant===0?[1,0]:quadrant===1?[0,1]:quadrant===2?[-1,0]:[0,-1];
  }
  return [Math.cos(angle),Math.sin(angle)];
}
interface LinePiece {kind:'line';from:PathPoint;to:PathPoint;weight:number}
interface ArcPiece {kind:'arc';center:PathPoint;rx:number;ry:number;angle:number;sweep:number;weight:number}
type Piece=LinePiece|ArcPiece;
interface Pieces {pieces:Piece[];closed:boolean}
function arcPoint(piece:ArcPiece,t:number):PathPoint {
  const [cosine,sine]=trig(piece.angle+piece.sweep*t);
  return checked([piece.center[0]+piece.rx*cosine,piece.center[1]+piece.ry*sine]);
}
function arcDerivative(piece:ArcPiece,t:number):PathPoint {
  const [cosine,sine]=trig(piece.angle+piece.sweep*t);
  return checked([-piece.rx*sine,piece.ry*cosine]);
}
function piecesOf(primitive:DeepReadonly<Primitive2D>):Pieces {
  if(primitive.kind==='circle'||primitive.kind==='ellipse'||primitive.kind==='arc') {
    const rx=primitive.kind==='circle'?primitive.radius:primitive.rx,ry=primitive.kind==='circle'?primitive.radius:primitive.ry;
    const sweep=primitive.kind==='arc'?primitive.sweepAngle:TAU;
    return {closed:primitive.kind!=='arc',pieces:[{kind:'arc',center:copy(primitive.center),rx,ry,
      angle:primitive.kind==='arc'?phase(primitive.startAngle):0,sweep,weight:Math.abs(sweep)}]};
  }
  const pieces:Piece[]=[];
  const line=(from:PathPoint,to:PathPoint)=>{
    checked(from);checked(to);if(equal(from,to))return;
    const weight=Math.hypot(to[0]-from[0],to[1]-from[1]);
    if(!Number.isFinite(weight)||weight===0)fail('PRIMITIVE_NONFINITE','Edge length must be finitely representable.');
    pieces.push({kind:'line',from,to,weight});
  };
  if(primitive.kind==='polyline') {
    for(let i=1;i<primitive.points.length;i++)line(copy(primitive.points[i-1]),copy(primitive.points[i]));
    if(primitive.closed)line(copy(primitive.points.at(-1)!),copy(primitive.points[0]));
    return {pieces,closed:primitive.closed};
  }
  const [x,y]=primitive.origin,w=primitive.width,h=primitive.height;
  if(x+w===x||y+h===y)fail('PRIMITIVE_NONFINITE','A positive dimension collapses at this coordinate magnitude.');
  const r=primitive.kind==='roundedRectangle'?primitive.cornerRadius:0;
  if(r===0) {
    line([x,y],[x+w,y]);line([x+w,y],[x+w,y+h]);line([x+w,y+h],[x,y+h]);line([x,y+h],[x,y]);
  } else {
    const arc=(center:PathPoint,angle:number)=>{
      checked(center);const weight=r*Math.PI/2;if(!Number.isFinite(weight))fail('PRIMITIVE_NONFINITE','Corner arc length must be finite.');
      pieces.push({kind:'arc',center,rx:r,ry:r,angle,sweep:Math.PI/2,weight});
    };
    line([x+r,y],[x+w-r,y]);arc([x+w-r,y+r],-Math.PI/2);
    line([x+w,y+r],[x+w,y+h-r]);arc([x+w-r,y+h-r],0);
    line([x+w-r,y+h],[x+r,y+h]);arc([x+r,y+h-r],Math.PI/2);
    line([x,y+h-r],[x,y+r]);arc([x+r,y+r],Math.PI);
  }
  if(!pieces.length)fail('PRIMITIVE_NONFINITE','The requested dimensions collapse at this coordinate magnitude.');
  return {pieces,closed:true};
}
function intervals(pieces:Piece[]):[number,number][] {
  const scale=pieces.reduce((max,piece)=>Math.max(max,piece.weight),0),weights=pieces.map(piece=>piece.weight/scale),total=weights.reduce((sum,weight)=>sum+weight,0);
  let previous=0,cumulative=0;return pieces.map((_,i)=>{const start=previous;cumulative+=weights[i];previous=i===pieces.length-1?1:cumulative/total;return [start,previous];});
}
function piecePoint(piece:Piece,t:number):PathPoint {
  if(piece.kind==='arc')return arcPoint(piece,t);
  if(t===0)return copy(piece.from);if(t===1)return copy(piece.to);
  return checked([(1-t)*piece.from[0]+t*piece.to[0],(1-t)*piece.from[1]+t*piece.to[1]]);
}
function pieceTangent(piece:Piece,t:number):PathPoint {
  if(piece.kind==='line')return unit([piece.to[0]-piece.from[0],piece.to[1]-piece.from[1]]);
  const derivative=arcDerivative(piece,t),sign=Math.sign(piece.sweep);return unit([sign*derivative[0],sign*derivative[1]]);
}

/** Analytic evaluation: angles for conics, exact perimeter fraction for edges
 * and rounded rectangles. Join tangents are right-hand; parameter 1 is left-hand. */
export function samplePrimitive(primitive:DeepReadonly<Primitive2D>,parameter:number):{point:PathPoint;tangent:PathPoint} {
  assertPrimitive(primitive);if(!finite(parameter))fail('PRIMITIVE_DOMAIN','Sampling parameter must be finite.','$.primitive.parameter');
  const t=Math.max(0,Math.min(1,parameter)),{pieces,closed}=piecesOf(primitive),ranges=intervals(pieces);
  const index=t===1?pieces.length-1:ranges.findIndex(([,end])=>t<end),range=ranges[index],piece=pieces[index];
  const local=t===1?1:Math.max(0,Math.min(1,(t-range[0])/(range[1]-range[0])));
  return {point:closed&&t===1?piecePoint(pieces[0],0):piecePoint(piece,local),tangent:pieceTangent(piece,local)};
}

/** Tight analytic axis-aligned bounds, independent of any rendered profile. */
export function primitiveBounds(primitive:DeepReadonly<Primitive2D>):PathBounds {
  assertPrimitive(primitive);
  if(primitive.kind==='rectangle'||primitive.kind==='roundedRectangle') {
    checked([primitive.origin[0]+primitive.width,primitive.origin[1]+primitive.height]);
    return [...primitive.origin,primitive.width,primitive.height];
  }
  let points:PathPoint[];
  if(primitive.kind==='polyline')points=primitive.points.map(copy);
  else {
    const rx=primitive.kind==='circle'?primitive.radius:primitive.rx,ry=primitive.kind==='circle'?primitive.radius:primitive.ry;
    if(primitive.kind!=='arc') {
      const result:PathBounds=[primitive.center[0]-rx,primitive.center[1]-ry,2*rx,2*ry];
      if(!result.every(Number.isFinite)||!Number.isFinite(primitive.center[0]+rx)||!Number.isFinite(primitive.center[1]+ry))fail('PRIMITIVE_NONFINITE','Primitive bounds are nonfinite.');
      return result;
    }
    const piece=piecesOf(primitive).pieces[0] as ArcPiece;points=[arcPoint(piece,0),arcPoint(piece,1)];
    const lo=Math.min(piece.angle,piece.angle+piece.sweep),hi=Math.max(piece.angle,piece.angle+piece.sweep);
    for(let i=Math.ceil(lo/(Math.PI/2));i<=Math.floor(hi/(Math.PI/2));i++) {
      const quadrant=((i%4)+4)%4,c=primitive.center;
      points.push(checked(quadrant===0?[c[0]+rx,c[1]]:quadrant===1?[c[0],c[1]+ry]:quadrant===2?[c[0]-rx,c[1]]:[c[0],c[1]-ry]));
    }
  }
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const point of points){minX=Math.min(minX,point[0]);minY=Math.min(minY,point[1]);maxX=Math.max(maxX,point[0]);maxY=Math.max(maxY,point[1]);}
  const result:PathBounds=[minX,minY,maxX-minX,maxY-minY];if(!result.every(Number.isFinite))fail('PRIMITIVE_NONFINITE','Primitive bounds are nonfinite.');return result;
}

/** Hermite error <= sup||f''''|| h^4/384. Chord error <= sup||f''|| h^2/8.
 * For an elliptic arc both derivative suprema are bounded by max(rx,ry). */
export function primitiveToPath(primitive:DeepReadonly<Primitive2D>,options:PrimitivePathOptions):PrimitivePathResult {
  assertPrimitive(primitive);const errors=validateJsonData(options,'$.primitive.options');if(errors.length)throw new OperationValidationError(errors);
  if(!options||!['cubic','polyline'].includes(options.profile)||Object.keys(options).some(key=>!['profile','tolerance','maxSegments'].includes(key)))
    fail('PRIMITIVE_OPTIONS','Expected cubic/polyline profile and numeric tolerance/maxSegments.','$.primitive.options');
  if(!finite(options.tolerance)||options.tolerance<=0)fail('PRIMITIVE_TOLERANCE','Tolerance must be positive finite bp.','$.primitive.options.tolerance');
  if(!Number.isSafeInteger(options.maxSegments)||options.maxSegments<1||options.maxSegments>131072)
    fail('PRIMITIVE_BUDGET','maxSegments must be an integer from 1 through 131072.','$.primitive.options.maxSegments');
  if(primitive.kind==='polyline'&&primitive.points.length-(primitive.closed?0:1)>options.maxSegments)
    fail('PRIMITIVE_BUDGET','Polyline source edges exceed maxSegments.');
  const bounds=primitiveBounds(primitive),{pieces,closed}=piecesOf(primitive),ranges=intervals(pieces);
  const coordinateScale=Math.max(1,...bounds.map(Math.abs),Math.abs(bounds[0]+bounds[2]),Math.abs(bounds[1]+bounds[3]));
  const guard=128*Number.EPSILON*coordinateScale;
  const exactPolyline=primitive.kind==='polyline',roundoff=exactPolyline?0:guard;
  if(roundoff>=options.tolerance)fail('PRIMITIVE_TOLERANCE','Requested tolerance is below the Float64 coordinate roundoff allowance.');
  const counts:number[]=[],errorBounds:number[]=[];let total=0;
  for(const piece of pieces) {
    let count=1,bound=roundoff;
    if(piece.kind==='arc') {
      const radius=Math.max(piece.rx,piece.ry),power=options.profile==='cubic'?4:2,divisor=options.profile==='cubic'?384:8;
      const available=options.tolerance-roundoff;
      // Logarithms avoid overflow while estimating a count. The actual bound is
      // checked below, so a rounded-down estimate can never waive quality.
      const estimate=Math.exp((Math.log(radius)-Math.log(available)-Math.log(divisor))/power)*Math.abs(piece.sweep);
      count=Math.max(1,Math.ceil(Math.abs(piece.sweep)/(Math.PI/2)),Math.ceil(estimate));
      if(!Number.isFinite(count)||count>options.maxSegments)fail('PRIMITIVE_BUDGET','Requested angular approximation exceeds maxSegments.');
      const error=()=>{const h=Math.abs(piece.sweep)/count;return radius*(h**power/divisor)+roundoff;};
      bound=error();while(bound>options.tolerance&&count<=options.maxSegments){count++;bound=error();}
    }
    total+=count;if(total>options.maxSegments)fail('PRIMITIVE_BUDGET','Primitive approximation exceeds maxSegments.');
    counts.push(count);errorBounds.push(bound);
  }
  const start=piecePoint(pieces[0],0),segments:PathSegment[]=[],report:PrimitivePathReport={profile:options.profile,tolerance:options.tolerance,
    errorBound:0,segments:total,closed,analyticKind:primitive.kind,precision:'float64-with-roundoff-guard',spans:[]};
  for(const [i,piece] of pieces.entries())for(let j=0;j<counts[i];j++) {
    const count=counts[i],t0=j/count,t1=(j+1)/count,id=`piece-${i}-segment-${j}`;
    const a=piecePoint(piece,t0),last=i===pieces.length-1&&j===count-1,b=closed&&last?copy(start):piecePoint(piece,t1);
    if(piece.kind==='line'||options.profile==='polyline')segments.push({id,kind:'line',to:b});
    else {
      const h=piece.sweep/count,da=arcDerivative(piece,t0),db=arcDerivative(piece,t1);
      const c1=checked([a[0]+h/3*da[0],a[1]+h/3*da[1]]),c2=checked([b[0]-h/3*db[0],b[1]-h/3*db[1]]);
      segments.push({id,kind:'cubic',c1,c2,to:b});
    }
    const interval=ranges[i],errorBound=errorBounds[i];report.errorBound=Math.max(report.errorBound,errorBound);
    report.spans.push({segmentId:id,parameterInterval:[interval[0]+(interval[1]-interval[0])*t0,interval[0]+(interval[1]-interval[0])*t1],errorBound,source:piece.kind});
  }
  return freezeSnapshot({geometry:{contours:[{id:'primitive',start,segments,closed}]},report});
}
