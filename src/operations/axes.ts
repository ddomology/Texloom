import {OperationValidationError, type DeepReadonly, type LiteralValue, type Operation,
  type OperatorDefinition, type SpaceRef} from '../ir/operations.js';
import {cartesianLabelPosition, createCartesianAxes, createCartesianMapping,
  type CartesianConfig} from '../geometry/data-space.js';
import {sameSpace} from '../geometry/spaces.js';
import {validateJsonData, validateLiteralValue, validateSpaceRef} from './values.js';
import type {PathGeometry, PathPoint} from '../path-geometry.js';

const defaults = {xScale:0, yScale:0, logBase:10, xStep:1, yStep:1, tickSize:6, maxTicks:512};
const requiredNumbers = ['width','height','xMin','xMax','yMin','yMax'] as const;
const names = ['cartesianAxes','dataToScene','sceneToData','placeAxisLabel'] as const;
type Name = typeof names[number];
const scalarUnit = (key:string):'1'|'bp' =>
  ['width','height','tickSize','offsetX','offsetY'].includes(key) ? 'bp' : '1';
const scalarInput = (key:string, fallback?:number):OperatorDefinition['inputs'][string] => ({
  value:{type:'scalar',unit:scalarUnit(key)},
  ...(fallback === undefined ? {required:true} : {default:{type:'scalar',unit:scalarUnit(key),value:fallback}}),
});
const numericDefaults = (values:Record<string,number>) => Object.fromEntries(
  Object.entries(values).map(([key,value]) => [key,scalarInput(key,value)]));
const commonInputs:OperatorDefinition['inputs'] = {
  origin:{value:{type:'vec2',role:'point',space:'space'},required:true},
  ...Object.fromEntries(requiredNumbers.map(key => [key,scalarInput(key)])),
  ...numericDefaults(defaults),
};
const dataInputs = {x:scalarInput('x'),y:scalarInput('y')};
const sceneScalars = {x:{type:'scalar' as const,unit:'bp' as const},y:{type:'scalar' as const,unit:'bp' as const}};

export const axesOperatorDefinitions:OperatorDefinition[] = [
  {name:'cartesianAxes',version:1,spaces:['space'],pure:true,deterministic:true,inputs:commonInputs,
    outputs:{xAxis:{type:'path2d',space:'space'},yAxis:{type:'path2d',space:'space'},
      ticks:{type:'path2d',space:'space'},grid:{type:'path2d',space:'space'},
      xCount:{type:'scalar',unit:'1'},yCount:{type:'scalar',unit:'1'}}},
  {name:'dataToScene',version:1,spaces:['space'],pure:true,deterministic:true,
    inputs:{...commonInputs,...dataInputs},
    outputs:{point:{type:'vec2',role:'point',space:'space'},...sceneScalars}},
  {name:'sceneToData',version:1,spaces:['space'],pure:true,deterministic:true,
    inputs:{...commonInputs,point:{value:{type:'vec2',role:'point',space:'space'},required:true}},
    outputs:{x:{type:'scalar',unit:'1'},y:{type:'scalar',unit:'1'}}},
  {name:'placeAxisLabel',version:1,spaces:['space','label','parent'],pure:true,deterministic:true,
    inputs:{...commonInputs,...dataInputs,...numericDefaults({axis:-1,respectTicks:1,offsetX:0,offsetY:0}),
      anchor:{value:{type:'vec2',role:'point',space:'label'},required:true},
      mapping:{value:{type:'transform2d',from:'space',to:'parent'},required:true}},
    outputs:{transform:{type:'transform2d',from:'label',to:'parent'},opacity:{type:'scalar',unit:'1'},...sceneScalars}},
];

export const isAxesOperator = (name:string,version:number):boolean =>
  version === 1 && (names as readonly string[]).includes(name);

/** Data coordinates enter as dimensionless scalars; only mapped geometry carries bp. */
export function executeAxesOperation(op:DeepReadonly<Operation>, values:Readonly<Record<string,LiteralValue>>):Record<string,LiteralValue>|undefined {
  if (!isAxesOperator(op.operator,op.version)) return;
  function fail(code:string,message:string,suffix=''):never {
    throw new OperationValidationError([{severity:'error',code,message:`${op.operator}@1 (${op.id}): ${message}`,
      path:`$.operations[${JSON.stringify(op.id)}]${suffix}`,
      ...(op.sourceSpan ? {sourceSpan:structuredClone(op.sourceSpan)} : {})}]);
  }
  try {
    const jsonErrors = validateJsonData(values,'$.inputs');
    if (jsonErrors.length) fail(jsonErrors[0].code,jsonErrors[0].message,'.inputs');
    if (!values || typeof values !== 'object' || Array.isArray(values)) fail('AXIS_INPUT','Expected input record.','.inputs');
    const name = op.operator as Name, definition = axesOperatorDefinitions.find(item => item.name === name)!;
    for (const key of Object.keys(values)) if (!Object.hasOwn(definition.inputs,key))
      fail('UNKNOWN_PROPERTY',`Unknown input ${key}.`,`.inputs.${key}`);
    for (const key of Object.keys(op.spaces ?? {})) if (!definition.spaces.includes(key))
      fail('UNKNOWN_PROPERTY',`Unknown coordinate space ${key}.`,`.spaces.${key}`);
    const space = (key:string):SpaceRef => {
      const value = op.spaces?.[key];
      if (validateSpaceRef(value).length) fail('OPERATION_RUNTIME_SPACE',`Expected valid ${key} space.`,`.spaces.${key}`);
      return structuredClone(value!) as SpaceRef;
    };
    const chart = space('space');
    const input = (key:string):LiteralValue => {
      const value = Object.hasOwn(values,key) ? values[key] : undefined;
      if (!value) fail('OPERATION_RUNTIME_TYPE',`Missing input ${key}.`,`.inputs.${key}`);
      const errors = validateLiteralValue(value);
      if (errors.length) fail(errors[0].code,errors[0].message,`.inputs.${key}`);
      return value;
    };
    const number = (key:string,fallback?:number):number => {
      if (!Object.hasOwn(values,key) && fallback !== undefined) return fallback;
      const value = input(key);
      if (value.type !== 'scalar') fail('OPERATION_RUNTIME_TYPE',`${key} requires a scalar.`,`.inputs.${key}`);
      if ((value.unit ?? '1') !== scalarUnit(key))
        fail('OPERATION_RUNTIME_UNIT',`${key} requires ${scalarUnit(key)} units.`,`.inputs.${key}.unit`);
      return value.value;
    };
    const point = (key:string,expected:SpaceRef):PathPoint => {
      const value = input(key);
      if (value.type !== 'vec2' || value.role !== 'point') fail('OPERATION_RUNTIME_TYPE',`${key} requires a point.`,`.inputs.${key}`);
      if (!sameSpace(value.space,expected)) fail('OPERATION_RUNTIME_SPACE',`${key} must use the declared coordinate space.`,`.inputs.${key}.space`);
      return [...value.value];
    };
    const scale = (key:'xScale'|'yScale'):'linear'|'log' => {
      const value = number(key,defaults[key]);
      if (value !== 0 && value !== 1) fail('AXIS_ENUM',`${key} must be 0 (linear) or 1 (log).`,`.inputs.${key}`);
      return value === 0 ? 'linear' : 'log';
    };
    const config:CartesianConfig = {origin:point('origin',chart),width:number('width'),height:number('height'),
      xMin:number('xMin'),xMax:number('xMax'),yMin:number('yMin'),yMax:number('yMax'),xScale:scale('xScale'),yScale:scale('yScale'),
      logBase:number('logBase',defaults.logBase),xStep:number('xStep',defaults.xStep),yStep:number('yStep',defaults.yStep),
      tickSize:number('tickSize',defaults.tickSize),maxTicks:number('maxTicks',defaults.maxTicks)};
    const scalar = (value:number,unit:'1'|'bp'):LiteralValue => ({type:'scalar',value,unit});
    const path = (value:DeepReadonly<PathGeometry>):LiteralValue =>
      ({type:'path2d',space:structuredClone(chart),value:structuredClone(value) as PathGeometry});
    let result:Record<string,LiteralValue>;
    if (name === 'cartesianAxes') {
      const axes = createCartesianAxes(config);
      result = {xAxis:path(axes.xAxis),yAxis:path(axes.yAxis),ticks:path(axes.ticks),grid:path(axes.grid),
        xCount:scalar(axes.xTicks.length,'1'),yCount:scalar(axes.yTicks.length,'1')};
    } else if (name === 'dataToScene') {
      const mapped = createCartesianMapping(config).dataToScene(number('x'),number('y'));
      result = {point:{type:'vec2',role:'point',space:structuredClone(chart),value:[...mapped]},
        x:scalar(mapped[0],'bp'),y:scalar(mapped[1],'bp')};
    } else if (name === 'sceneToData') {
      const mapped = createCartesianMapping(config).sceneToData(point('point',chart));
      result = {x:scalar(mapped[0],'1'),y:scalar(mapped[1],'1')};
    } else {
      const axis = number('axis',-1),respectTicks = number('respectTicks',1);
      if (axis !== -1 && axis !== 0 && axis !== 1) fail('AXIS_ENUM','axis must be -1 (point), 0 (x), or 1 (y).','.inputs.axis');
      if (respectTicks !== 0 && respectTicks !== 1) fail('AXIS_ENUM','respectTicks must be 0 or 1.','.inputs.respectTicks');
      const label = space('label'),parent = space('parent'),anchor = point('anchor',label),mapping = input('mapping');
      if (mapping.type !== 'transform2d') fail('OPERATION_RUNTIME_TYPE','mapping requires an affine transform.','.inputs.mapping');
      if (!sameSpace(mapping.from,chart) || !sameSpace(mapping.to,parent))
        fail('OPERATION_RUNTIME_SPACE','mapping must map the axis space to the target parent space.','.inputs.mapping');
      const placement = cartesianLabelPosition(config,number('x'),number('y'),axis === -1 ? 'point' : axis === 0 ? 'x' : 'y',respectTicks === 1);
      const x = placement.position[0]+number('offsetX',0)-anchor[0],y = placement.position[1]+number('offsetY',0)-anchor[1];
      const [a,b,c,d,e,f] = mapping.value;
      result = {transform:{type:'transform2d',from:label,to:parent,value:[a,b,c,d,a*x+c*y+e,b*x+d*y+f]},
        opacity:scalar(placement.visible ? 1 : 0,'1'),x:scalar(0,'bp'),y:scalar(0,'bp')};
    }
    for (const [socket,value] of Object.entries(result)) {
      const errors = validateLiteralValue(value);
      if (errors.length) fail('OPERATION_NONFINITE_OUTPUT',`Invalid ${socket} output: ${errors[0].message}`,`.outputs.${socket}`);
    }
    return result;
  } catch (error) {
    if (error instanceof OperationValidationError) throw error;
    fail((error as {code?:string})?.code ?? 'AXIS_DOMAIN',error instanceof Error ? error.message : String(error));
  }
}
