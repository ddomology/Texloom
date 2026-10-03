import {prepareScene,NUMERIC_3D_PROFILE,copyMeshBuffers,transformPoint3D,
  type Bundle,type MeshInstance3D,type Vec3,type DeepReadonly,type Space3DEvaluation,type OwnedMeshBuffers} from '../src/index.js';

const element=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const sourceText=element('mesh-data').textContent!,source=JSON.parse(sourceText) as Bundle;
const sourceResources=JSON.stringify(source.resources),sourceNodes=source.space3d!.nodes;
const meshNodes=sourceNodes.filter((n):n is MeshInstance3D=>n.kind==='mesh');
const controls={instance:element<HTMLSelectElement>('instance'),scale:element<HTMLInputElement>('scale-x'),
  camera:element<HTMLInputElement>('camera-x'),vertex:element<HTMLSelectElement>('vertex')};
const scaleEdits=new Map<string,number>();let selected=meshNodes[0].id,vertex=0;
const cameraSource=source.space3d!.camera,cameraEditable=!!cameraSource&&!cameraSource.transform?.matrix;
const cameraDefault=cameraSource?.transform?.translation?.[0]??0;let cameraX=cameraDefault;
const colors=['#91dbb8','#e7be82','#96c8df','#d4a9cc'];
const meshes=new Map<string,OwnedMeshBuffers>();
for(const [id,resource] of Object.entries(source.resources))if(resource.kind==='mesh')meshes.set(id,copyMeshBuffers(resource));
const num=(v:number)=>Object.is(v,-0)?'0':Number.isInteger(v)?String(v):Math.abs(v)>=1e6||Math.abs(v)<.0001&&v!==0?v.toExponential(3):String(Number(v.toFixed(4)));
const text=(id:string,value:string)=>{element(id).textContent=value;};
const scaleValue=(node:MeshInstance3D)=>node.transform?.matrix?null:scaleEdits.get(node.id)??node.transform?.scale?.[0]??1;
const option=(value:string,label:string)=>{const node=document.createElement('option');node.value=value;node.textContent=label;return node;};
const point=(data:ArrayLike<number>,index:number):Vec3=>[data[index*3],data[index*3+1],data[index*3+2]];
const svgNS='http://www.w3.org/2000/svg';
const svgElement=(tag:string,attributes:Record<string,string|number>,label?:string)=>{
  const node=document.createElementNS(svgNS,tag);for(const [key,value] of Object.entries(attributes))node.setAttribute(key,String(value));
  if(label!==undefined)node.textContent=label;return node;
};
// A fixed diagram convention, deliberately separate from the scene camera and renderer capabilities.
const axonometric=(p:DeepReadonly<Vec3>):[number,number]=>[(p[0]-p[1])*Math.sqrt(3)/2,(p[0]+p[1])*.5-p[2]];

type Instance=Space3DEvaluation['instances'][number];
interface InstanceReport extends Instance {vertices:{local:Vec3;world:DeepReadonly<Vec3>;camera:DeepReadonly<Vec3>|null}[]}
let currentReport:unknown=null;
const qa={ready:false,snapshot:()=>structuredClone(currentReport)};
declare global {interface Window {texloomMeshQA:typeof qa}}
window.texloomMeshQA=Object.freeze({get ready(){return qa.ready;},snapshot:qa.snapshot});

function matrix(id:string,values:readonly number[]|undefined){
  const parent=element(id);parent.replaceChildren();
  if(!values){parent.textContent='No camera';return;}
  for(let row=0;row<4;row++){
    const line=document.createElement('div');line.setAttribute('role','row');
    for(let col=0;col<4;col++){const cell=document.createElement('span');cell.setAttribute('role','cell');cell.textContent=num(values[col*4+row]);line.append(cell);}
    parent.append(line);
  }
}

function wireframe(instances:InstanceReport[]){
  const svg=document.getElementById('wireframe')!;svg.replaceChildren(svgElement('title',{},'Diagnostic triangle wireframe in world coordinates'));
  const axes:Vec3[]=[[0,0,0],[2,0,0],[0,2,0],[0,0,2]];
  const projected=[...axes.map(axonometric),...instances.filter(i=>i.visible).flatMap(i=>i.vertices.map(v=>axonometric(v.world)))];
  let xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity;
  for(const [x,y] of projected){xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);}
  const scale=Math.min(610/Math.max(xmax-xmin,1),305/Math.max(ymax-ymin,1));
  const screen=(p:DeepReadonly<Vec3>):[number,number]=>{const [x,y]=axonometric(p);return [380+(x-(xmin+xmax)/2)*scale,202+(y-(ymin+ymax)/2)*scale];};
  const origin=screen(axes[0]);
  for(let axis=1;axis<4;axis++){
    const end=screen(axes[axis]);svg.append(svgElement('line',{x1:origin[0],y1:origin[1],x2:end[0],y2:end[1],stroke:'#627d6a','stroke-width':1,'stroke-dasharray':'4 4'}));
    svg.append(svgElement('text',{x:end[0]+8,y:end[1]+4,fill:'#a4b9ad','font-size':12,'font-family':'monospace'},['','x','y','z'][axis]));
  }
  instances.forEach((instance,index)=>{
    if(!instance.visible)return;
    const buffer=meshes.get(instance.resourceId)!,seen=new Set<string>(),color=colors[index%colors.length];
    const group=svgElement('g',{'data-instance':instance.id,opacity:instance.id===selected?1:.58});
    for(let triangle=0;triangle<buffer.indices.length;triangle+=3)for(let side=0;side<3;side++){
      const a=buffer.indices[triangle+side],b=buffer.indices[triangle+(side+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`;
      if(seen.has(key))continue;seen.add(key);
      const p=screen(instance.vertices[a].world),q=screen(instance.vertices[b].world);
      group.append(svgElement('line',{x1:p[0],y1:p[1],x2:q[0],y2:q[1],stroke:color,'stroke-width':instance.id===selected?1.9:1.3,'stroke-linecap':'round'}));
    }
    if(instance.vertices.length){
      const centroid=[0,1,2].map(axis=>instance.vertices.reduce((sum,v)=>sum+v.world[axis],0)/instance.vertices.length) as Vec3;
      const center=screen(centroid);
      group.append(svgElement('text',{x:center[0],y:instance.vertices.reduce((bottom,v)=>Math.max(bottom,screen(v.world)[1]),-Infinity)+26,
        fill:color,'font-size':12,'font-family':'monospace','text-anchor':'middle'},instance.id));
      if(instance.id===selected){const p=screen(instance.vertices[vertex].world);group.append(svgElement('circle',{cx:p[0],cy:p[1],r:5,fill:color,stroke:'#0b2118','stroke-width':2}));}
    }
    svg.append(group);
  });
}

function syncControls(){
  const node=meshNodes.find(n=>n.id===selected)!,value=scaleValue(node),buffer=meshes.get(node.resourceId)!;
  controls.instance.value=selected;controls.scale.disabled=value===null;element<HTMLButtonElement>('reflect').disabled=value===null;
  controls.scale.min=String(Math.min(-3,value??0));controls.scale.max=String(Math.max(3,value??0));
  controls.scale.value=String(value??0);text('scale-value',value===null?'Matrix authored':num(value));
  controls.camera.disabled=!cameraEditable;controls.camera.min=String(Math.min(-8,cameraDefault));controls.camera.max=String(Math.max(8,cameraDefault));
  controls.camera.value=String(cameraX);text('camera-value',cameraEditable?`${num(cameraX)} ${source.space3d!.units}`:'Not editable');
  const count=buffer.positions.length/3;vertex=Math.max(0,Math.min(vertex,count-1));
  controls.vertex.replaceChildren(...Array.from({length:count},(_,i)=>option(String(i),String(i))));
  if(!count)controls.vertex.append(option('0','Empty'));controls.vertex.disabled=!count;controls.vertex.value=String(vertex);
}

function update(){
  try{
    syncControls();const authored=JSON.parse(sourceText) as Bundle;
    for(const node of authored.space3d!.nodes)if(node.kind==='mesh'&&scaleEdits.has(node.id)){
      const previous=node.transform??{};
      if(previous.matrix)throw Error('A matrix-authored node has no independently editable local x scale.');
      node.transform={...previous,scale:[scaleEdits.get(node.id)!,previous.scale?.[1]??1,previous.scale?.[2]??1]};
    }
    if(cameraEditable&&authored.space3d!.camera){
      const previous=authored.space3d!.camera.transform??{};
      if(previous.matrix)throw Error('A matrix-authored camera has no independently editable local translation.');
      authored.space3d!.camera.transform={...previous,translation:[cameraX,previous.translation?.[1]??0,previous.translation?.[2]??0]};
    }
    const runtime=prepareScene(authored);runtime.require(NUMERIC_3D_PROFILE);const frame=runtime.sample(0),spatial=frame.space3d!;
    const instances:InstanceReport[]=spatial.instances.map(instance=>{
      const data=meshes.get(instance.resourceId)!.positions;
      const vertices=Array.from({length:data.length/3},(_,index)=>{
        const local=point(data,index),world=transformPoint3D(instance.worldMatrix,local);
        return {local,world,camera:spatial.camera?transformPoint3D(spatial.camera.viewMatrix,world):null};
      });
      return {...instance,vertices};
    });
    const instance=instances.find(i=>i.id===selected)!,buffer=meshes.get(instance.resourceId)!;
    wireframe(instances);text('readout-title',instance.id);
    text('orientation',instance.orientation===0?'COLLAPSED · NO WINDING':`${instance.orientation===1?'PRESERVING +1':'REFLECTED −1'} · ${instance.worldWinding!.toUpperCase()}`);
    const rows=element('coordinates');rows.replaceChildren();const chosen=instance.vertices[vertex];
    for(const [label,coords] of [['Object',chosen?.local],['World',chosen?.world],['Camera',chosen?.camera]] as const){
      const tr=document.createElement('tr');const heading=document.createElement('td');heading.textContent=label;tr.append(heading);
      for(let axis=0;axis<3;axis++){const cell=document.createElement('td');cell.textContent=coords?num(coords[axis]):'—';tr.append(cell);}rows.append(tr);
    }
    text('resource-note',`${instance.resourceId} · ${buffer.positions.length/3} vertices · ${buffer.triangleCount} triangles · shared by ${instances.filter(i=>i.resourceId===instance.resourceId).length} instances`);
    text('bounds-min',instance.worldBounds?instance.worldBounds.min.map(num).join(', '):'Empty');
    text('bounds-max',instance.worldBounds?instance.worldBounds.max.map(num).join(', '):'Empty');
    matrix('world-matrix',instance.worldMatrix);matrix('view-matrix',spatial.camera?.viewMatrix);
    currentReport={selected,vertex,localScaleX:scaleValue(meshNodes.find(n=>n.id===selected)!),cameraLocalX:cameraEditable?cameraX:null,
      units:spatial.units,sourceUnchanged:JSON.stringify(authored.resources)===sourceResources,instances,camera:spatial.camera,
      resources:[...meshes].map(([id,b])=>({id,positions:Array.from(b.positions),indices:Array.from(b.indices),triangleCount:b.triangleCount,
        referencedBy:instances.filter(i=>i.resourceId===id).map(i=>i.id)})),diagnostics:spatial.diagnostics};
    element('error').hidden=true;qa.ready=true;
  }catch(error){qa.ready=false;const message=element('error');message.textContent=error instanceof Error?error.message:String(error);message.hidden=false;}
}

try{
  controls.instance.replaceChildren(...meshNodes.map(node=>option(node.id,node.id)));
  controls.instance.addEventListener('change',()=>{selected=controls.instance.value;vertex=0;update();});
  controls.scale.addEventListener('input',()=>{scaleEdits.set(selected,Number(controls.scale.value));update();});
  controls.camera.addEventListener('input',()=>{cameraX=Number(controls.camera.value);update();});
  controls.vertex.addEventListener('change',()=>{vertex=Number(controls.vertex.value);update();});
  element('reflect').addEventListener('click',()=>{const node=meshNodes.find(n=>n.id===selected)!,value=scaleValue(node);if(value!==null){scaleEdits.set(selected,-value);update();}});
  element('reset').addEventListener('click',()=>{scaleEdits.clear();cameraX=cameraDefault;selected=meshNodes[0].id;vertex=0;update();});
  text('mesh-count',String(meshes.size));text('instance-count',String(meshNodes.length));
  text('vertex-count',String([...meshes.values()].reduce((sum,b)=>sum+b.positions.length/3,0)));
  text('triangle-count',String([...meshes.values()].reduce((sum,b)=>sum+b.triangleCount,0)));
  text('basis',`Right-handed · Z up · ${source.space3d!.units}`);
  const legend=element('legend');meshNodes.forEach((node,index)=>{
    const item=document.createElement('span'),dot=document.createElement('i');dot.style.background=colors[index%colors.length];
    item.append(dot,document.createTextNode(`${node.id} / ${node.resourceId}`));legend.append(item);
  });
  update();
}catch(error){const message=element('error');message.hidden=false;message.textContent=error instanceof Error?error.message:String(error);}
