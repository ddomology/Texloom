import type {Bundle,Node,PathNode,GroupNode} from '../schema.js';
import type {TimelineProgram,TimelineNode} from './ast.js';
import {TIMELINE_MAX_DEPTH,TIMELINE_MAX_NODES} from './ast.js';
import type {MorphOperation,MorphProgram} from './morph.js';
import {OperationValidationError,type SourceSpan} from '../ir/operations.js';
import {validateSourceSpan} from '../operations/values.js';

type Obj=Record<string,any>;
const object=(v:unknown):v is Obj=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const named=(v:unknown):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0;
/** Expand authoring conveniences to ordinary nodes, numeric actions and a
 * portable geometry program. Endpoints are authored local snapshots. */
export function materializeTimeline(program:TimelineProgram,input:Bundle):{
  program:TimelineProgram;bundle:Bundle;generatedNodes:Node[];morphs?:MorphProgram;
} {
  const bundle=structuredClone(input),generatedNodes:Node[]=[],operations:MorphOperation[]=[];
  const authored=new Map(input.nodes.map(n=>[n.id,n])),reserved=new Set(input.nodes.map(n=>n.id));
  let count=0;
  const fail=(message:string,path:string,span?:SourceSpan):never=>{throw new OperationValidationError([
    {severity:'error',code:'TIMELINE_INSTANCE',message,path,...(span?{sourceSpan:span}:{})}]);};
  const keys=(raw:Obj,allowed:string[],path:string)=>{for(const key of Object.keys(raw))if(!allowed.includes(key))fail(`Unknown ${raw.kind} field ${key}.`,path+'.'+key,raw.sourceSpan);};
  const source=(id:unknown,path:string,span?:SourceSpan):PathNode=>{
    const node=typeof id==='string'?authored.get(id):undefined;
    if(!node||node.kind!=='path'||!node.geometry)fail('A snapshot source must name an authored editable path.',path,span);
    return node as PathNode;
  };
  const reserve=(id:unknown,path:string,span?:SourceSpan):string=>{
    if(!named(id)||id==='$camera'||reserved.has(id))fail('Instance and generated child IDs must be nonempty and distinct from all scene nodes.',path,span);
    reserved.add(id as string);return id as string;
  };
  const visit=(raw:unknown,path:string,depth:number):unknown=>{
    if(++count>TIMELINE_MAX_NODES||depth>TIMELINE_MAX_DEPTH)throw new OperationValidationError([
      {severity:'error',code:'TIMELINE_LIMIT',message:'Timeline authoring size limit exceeded.',path}]);
    if(!object(raw))return raw; // The canonical timeline validator supplies diagnostics.
    if(raw.sourceSpan!==undefined){const errors=validateSourceSpan(raw.sourceSpan,path+'.sourceSpan');if(errors.length)throw new OperationValidationError(errors);}
    if(['sequence','parallel','stagger'].includes(raw.kind)&&Array.isArray(raw.children))
      return {...raw,children:raw.children.map((c:unknown,i:number)=>visit(c,`${path}.children[${i}]`,depth+1))};
    const span=raw.sourceSpan,common=['kind','id','sourceSpan'];
    if(raw.kind==='enter'||raw.kind==='exit'){
      keys(raw,[...common,'target','duration','easing','mode'],path);
      if(raw.mode!==undefined&&!['fade','create'].includes(raw.mode))fail('Entrance/exit mode must be fade or create.',path+'.mode',span);
      return {kind:'tween',...(raw.id===undefined?{}:{id:raw.id}),target:raw.target,
        property:raw.mode==='create'?'reveal':'style.opacity',duration:raw.duration,
        from:raw.kind==='enter'?0:1,to:raw.kind==='enter'?1:0,
        ...(raw.easing===undefined?{}:{easing:raw.easing}),...(span?{sourceSpan:span}:{})};
    }
    if(raw.kind!=='morph'&&raw.kind!=='clone')return raw;
    keys(raw,[...common,'source',...(raw.kind==='morph'?['destination','duration','easing','correspondence']:[])],path);
    const original=source(raw.source,path+'.source',span),id=reserve(raw.id,path+'.id',span);
    const opacity=original.style?.opacity??1;
    const provenance={...(original.source??{}),transition:{kind:raw.kind,instance:id,source:original.id,
      ...(raw.kind==='morph'?{destination:raw.destination}:{}),coordinates:'authored-local'}};
    const show={kind:'set',id:raw.kind==='clone'?id:`${id}:appear`,target:id,property:'style.opacity',value:opacity,...(span?{sourceSpan:span}:{})};
    if(raw.kind==='clone'){
      generatedNodes.push({...structuredClone(original),id,visible:true,style:{...original.style,opacity:0},source:provenance});
      return show;
    }
    source(raw.destination,path+'.destination',span);
    const group:GroupNode={id,kind:'group',morphProgress:0,visible:true,style:{opacity:0},source:provenance,
      ...(original.parent===undefined?{}:{parent:original.parent}),
      ...(original.transform===undefined?{}:{transform:structuredClone(original.transform)}),
      ...(original.clip===undefined?{}:{clip:structuredClone(original.clip)})};
    generatedNodes.push(group);
    for(const suffix of ['shape','leaving','entering']){
      const childId=reserve(`${id}:${suffix}`,path+'.id',span),child=structuredClone(original);
      child.id=childId;child.parent=id;child.visible=true;delete child.transform;delete child.clip;
      child.style={...child.style};delete child.style.opacity;
      child.source={transition:{instance:id,role:suffix,source:original.id,destination:raw.destination}};
      if(suffix!=='shape'){
        child.geometry={contours:[]};child.d='M 0 0';child.style.opacity=0;child.reveal=1;
        delete child.arrows;delete child.arrowStart;delete child.arrowEnd;delete child.arrowSize;
      }
      generatedNodes.push(child);
    }
    operations.push({id,instance:id,source:original.id,destination:raw.destination,correspondence:raw.correspondence,...(span?{sourceSpan:span}:{})});
    return {kind:'sequence',children:[show,{kind:'tween',id,target:id,property:'morphProgress',duration:raw.duration,from:0,to:1,
      ...(raw.easing===undefined?{}:{easing:raw.easing}),...(span?{sourceSpan:span}:{})}],...(span?{sourceSpan:span}:{})};
  };
  const root=visit(program.root,'$.timelineProgram.root',1) as TimelineNode;
  bundle.nodes.push(...generatedNodes);
  const morphs=operations.length?{version:1 as const,operations:[...(bundle.morphs?.operations??[]),...operations]}:undefined;
  if(morphs)bundle.morphs=morphs;
  return {program:{...program,root},bundle,generatedNodes,...(morphs?{morphs}:{})};
}
