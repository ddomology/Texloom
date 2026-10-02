import type {Primitive2D} from '../geometry/primitives.js';
import type {PathBounds,PathPoint} from '../path-geometry.js';

export const anchorNames=['center','north','north east','east','south east','south','south west','west','north west',
  'base','base west','base east','mid'] as const;
export type AnchorName=typeof anchorNames[number];
export type AnchorQuery={kind:'named';name:AnchorName}|{kind:'border';direction:[number,number]};
/** Local bp, baseline origin (0,0), with positive y pointing down. */
export interface TextMetrics {width:number;height:number;depth:number}
export interface TextLayoutMetrics {metrics:TextMetrics;inkBounds:PathBounds}
interface ProviderBounds {revision:string;logicalBounds?:PathBounds;inkBounds?:PathBounds}
export type AnchorShape=Extract<Primitive2D,{kind:'circle'|'ellipse'|'rectangle'|'roundedRectangle'}>;
export type AnchorProvider=
  |(ProviderBounds&{kind:'shape';primitive:AnchorShape;logicalBounds:PathBounds;inkBounds:PathBounds;
      anchorBounds:PathBounds;outerSep:[number,number]})
  |(ProviderBounds&{kind:'text';metrics:TextMetrics;logicalBounds:PathBounds;inkBounds:PathBounds;
      anchorBounds:PathBounds;innerSep:[number,number];outerSep:[number,number]})
  |(ProviderBounds&{kind:'measured';anchors:Partial<Record<AnchorName,PathPoint>>});
