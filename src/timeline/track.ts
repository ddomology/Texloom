import type {Track,TrackValue} from '../schema.js';
import type {Easing} from './ast.js';

export function trackSegmentEasing(track:Track,index:number):Easing{return track.segmentEasings?.[index]??track.interpolation??'linear';}
export function trackLeftValue(track:Track,index:number):TrackValue{return track.leftValues?.[index]??track.keys[index][1];}
function blend(a:number,b:number,t:number):number {
  if(t===0)return a;if(t===1)return b;
  const difference=b-a;
  // Retain historical arithmetic unless subtraction overflow would destroy a
  // perfectly finite convex interpolation between opposite signed endpoints.
  return Number.isFinite(difference)?a+difference*t:(1-t)*a+t*b;
}
export function mixTrackValues(a:TrackValue,b:TrackValue,t:number):TrackValue {
  return typeof a==='number'?blend(a,b as number,t):a.map((v,i)=>blend(v,(b as number[])[i],t));
}
/** Exact keys are right-continuous; each outgoing segment owns [a,b). */
export function evaluateTrack(track:Track,time:number):TrackValue {
  const keys=track.keys,last=keys.length-1;
  if(time<=keys[0][0])return structuredClone(keys[0][1]);
  if(time>=keys[last][0])return structuredClone(keys[last][1]);
  let lo=0,hi=keys.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(keys[mid][0]<=time)lo=mid+1;else hi=mid;}
  const a=lo-1,b=lo,raw=(time-keys[a][0])/(keys[b][0]-keys[a][0]);
  const easing=trackSegmentEasing(track,a),t=easing==='step'?0:easing==='smooth'?raw*raw*(3-2*raw):raw;
  return mixTrackValues(keys[a][1],trackLeftValue(track,b),t);
}
/** Instantaneous nonzero sign changes are valid. Only realized continuous
 * segments and values at exact keys can make an inverse scale singular. */
export function trackHasSingularScale(track:Track):boolean {
  if(track.keys.some(([,v])=>!Array.isArray(v)||v.some(x=>x===0)))return true;
  for(let i=0;i<track.keys.length-1;i++)if(trackSegmentEasing(track,i)!=='step') {
    const a=track.keys[i][1] as number[],b=trackLeftValue(track,i+1) as number[];
    if(!Array.isArray(b)||a.some((v,j)=>b[j]===0||Math.sign(v)!==Math.sign(b[j])))return true;
  }
  return false;
}
