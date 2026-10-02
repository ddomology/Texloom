import type {DeepReadonly} from '../ir/operations.js';
import type {IntersectionIncident,IntersectionPoint} from '../geometry/intersections.js';

const number=(a:number,b:number)=>a<b?-1:a>b?1:0;
const text=(a:string,b:string)=>a<b?-1:a>b?1:0;
function side(a:DeepReadonly<IntersectionIncident>,b:DeepReadonly<IntersectionIncident>,along:'a'|'b'):number {
  const ar=a[along],br=b[along],parameter=along==='a'?'parameterA':'parameterB';
  return number(ar.contourIndex,br.contourIndex)||number(ar.segmentIndex,br.segmentIndex)||
    number(a[parameter],b[parameter])||text(ar.contourId,br.contourId)||text(ar.segmentId,br.segmentId);
}

/** Source order, then the other operand and stable IDs; no history or nearest-point state. */
export function compareIntersectionIncidents(a:DeepReadonly<IntersectionIncident>,b:DeepReadonly<IntersectionIncident>,along:'a'|'b'):number {
  return side(a,b,along)||side(a,b,along==='a'?'b':'a')||text(a.contact,b.contact);
}

export function orderedIntersectionPoints(points:DeepReadonly<IntersectionPoint[]>,along:'a'|'b') {
  const candidates=points.map(point=>({point,incident:[...point.incidents].sort((a,b)=>compareIntersectionIncidents(a,b,along))[0]}));
  return candidates.sort((a,b)=>compareIntersectionIncidents(a.incident,b.incident,along)||number(a.point.point[0],b.point.point[0])||number(a.point.point[1],b.point.point[1]));
}
