import {BufferGeometry,BufferAttribute,Mesh,MeshBasicMaterial,Line,LineBasicMaterial,Scene,Camera,WebGLRenderer,Plane,Vector3,Matrix4,
  Color,DoubleSide,FrontSide,NoToneMapping,SRGBColorSpace} from 'three';
import type {EvaluatedFrame} from '../../schema.js';
import type {MeshResource} from '../../ir/mesh.js';
import type {Curve3DResource} from '../../ir/curve3d.js';
import type {DeepReadonly} from '../../ir/operations.js';
import {GpuRenderError,validateGpuSize,validateGpuColor,validateGpuMatrix,finiteFloat32,prepareGpuGeometry,
  gpuBufferSize,gpuWireBufferSize,validateGpuTransformBounds,validateGpuOrientation,MAX_GPU_BUFFER_BYTES,MAX_GPU_TRIANGLES} from './data.js';
import {gpuCurveBufferSize,prepareGpuCurveGeometry} from './curve-data.js';
export {GpuRenderError} from './data.js';

export interface GpuRendererOptions {canvas?:HTMLCanvasElement;antialias?:boolean}
export interface GpuFrameOptions {width:number;height:number;background?:string}
export interface GpuRendererStats {state:'ready'|'lost'|'disposed';width:number;height:number;geometries:number;
  materials:number;instances:number;bufferBytes:number;renders:number;drawCalls:number;triangles:number;segments:number;contextGeneration:number}
export interface GpuRenderer {
  readonly canvas:HTMLCanvasElement;
  readonly state:'ready'|'lost'|'disposed';
  render(frame:EvaluatedFrame,options:GpuFrameOptions):void;
  stats():Readonly<GpuRendererStats>;
  dispose():void;
}
type GeometryEntry={geometry:BufferGeometry;bytes:number;wireBytes:number};
type GeometryResource=DeepReadonly<MeshResource|Curve3DResource>;
type GeometryKey={resource:GeometryResource;colorAttribute?:string};
const immutableMesh=(r:DeepReadonly<MeshResource>)=>Object.isFrozen(r)&&Object.isFrozen(r.positions)&&Object.isFrozen(r.positions.data)&&
  Object.isFrozen(r.indices)&&Object.isFrozen(r.indices.data)&&(!r.normals||Object.isFrozen(r.normals)&&Object.isFrozen(r.normals.data))&&
  (!r.attributes||Object.isFrozen(r.attributes)&&Object.isFrozen(r.attributes.values)&&Object.isFrozen(r.attributes.topology)&&Object.isFrozen(r.attributes.topology.indices)&&
    Object.values(r.attributes.values).every(a=>Object.isFrozen(a)&&Object.isFrozen(a.buffer)&&Object.isFrozen(a.buffer.data)));
const immutableCurve=(r:DeepReadonly<Curve3DResource>)=>Object.isFrozen(r)&&Object.isFrozen(r.positions)&&Object.isFrozen(r.positions.data);

/** Browser-only construction; importing this module does not access DOM or create a context. */
export function createGpuRenderer(options:GpuRendererOptions={}):GpuRenderer {
  if(options===null||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!['canvas','antialias'].includes(k))||
    options.antialias!==undefined&&typeof options.antialias!=='boolean')throw new GpuRenderError('GPU_OPTIONS','Expected canvas and optional boolean antialias.');
  if(typeof document==='undefined')throw new GpuRenderError('GPU_BROWSER','GPU rendering requires a browser canvas.');
  const canvas=options.canvas??document.createElement('canvas');
  if(!(canvas instanceof HTMLCanvasElement))throw new GpuRenderError('GPU_CANVAS','Expected an HTMLCanvasElement.');
  const context=canvas.getContext('webgl2',{alpha:true,antialias:options.antialias??true,depth:true,stencil:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
  if(!context)throw new GpuRenderError('GPU_WEBGL2','WebGL2 is unavailable; this renderer has no implicit fallback.');
  const attributes=context.getContextAttributes();
  if(!attributes?.alpha||!attributes.depth||!attributes.preserveDrawingBuffer||!attributes.premultipliedAlpha)
    throw new GpuRenderError('GPU_CONTEXT_ATTRIBUTES','Canvas context must preserve its drawing buffer and support alpha, premultiplied alpha and depth.');
  const maximumBuffer=context.getParameter(context.MAX_RENDERBUFFER_SIZE) as number;
  const maximumViewport=context.getParameter(context.MAX_VIEWPORT_DIMS) as Int32Array;
  let renderer:WebGLRenderer;
  try{renderer=new WebGLRenderer({canvas,context,alpha:true,antialias:options.antialias??true,preserveDrawingBuffer:true});}
  catch(cause){throw new GpuRenderError('GPU_INITIALIZATION',cause instanceof Error?cause.message:String(cause));}
  renderer.outputColorSpace=SRGBColorSpace;renderer.toneMapping=NoToneMapping;renderer.setPixelRatio(1);
  renderer.sortObjects=false;renderer.autoClear=true;
  renderer.debug.onShaderError=()=>{throw new GpuRenderError('GPU_SHADER','WebGL shader compilation or linking failed.');};
  const scene=new Scene(),camera=new Camera();
  // Three camera auto-updates remove camera scale. Texloom's evaluated affine view is authoritative.
  scene.matrixAutoUpdate=false;scene.matrixWorldAutoUpdate=false;camera.matrixAutoUpdate=false;camera.matrixWorldAutoUpdate=false;
  const geometries=new Map<GeometryKey,GeometryEntry>(),materials=new Map<string,MeshBasicMaterial|LineBasicMaterial>(),meshes=new Map<string,Mesh>(),lines=new Map<string,Line>();
  let geometryKeys=new WeakMap<GeometryResource,Map<string,GeometryKey>>();
  const geometryKey=(resource:GeometryResource,colorAttribute?:string):GeometryKey=>{
    let variants=geometryKeys.get(resource);if(!variants){variants=new Map();geometryKeys.set(resource,variants);}
    const name=colorAttribute??'';let key=variants.get(name);if(!key){key={resource,...(colorAttribute===undefined?{}:{colorAttribute})};variants.set(name,key);}return key;
  };
  const modelViews=new WeakMap<Mesh|Line,readonly number[]>();
  let state:GpuRendererStats['state']='ready',renders=0,generation=1,forceResize=true,width=0,height=0,drawCalls=0,triangles=0,segments=0;
  function clearCaches(){for(const entry of geometries.values())entry.geometry.dispose();for(const material of materials.values())material.dispose();
    geometries.clear();geometryKeys=new WeakMap();materials.clear();meshes.clear();lines.clear();scene.clear();drawCalls=0;triangles=0;segments=0;}
  const lost=(event:Event)=>{event.preventDefault();if(state==='disposed')return;state='lost';clearCaches();};
  const restored=()=>{if(state==='disposed')return;clearCaches();generation++;forceResize=true;state='ready';};
  canvas.addEventListener('webglcontextlost',lost);canvas.addEventListener('webglcontextrestored',restored);
  const assertReady=()=>{
    if(state==='disposed')throw new GpuRenderError('GPU_DISPOSED','Renderer is disposed.');
    if(state==='lost'||context.isContextLost())throw new GpuRenderError('GPU_CONTEXT_LOST','WebGL context is lost; wait for restoration before rendering.');
  };
  return Object.freeze({canvas,get state(){return state;},
    render(frame:EvaluatedFrame,output:GpuFrameOptions){
      assertReady();validateGpuSize(output?.width,output?.height);const background=output.background??'transparent';validateGpuColor(background,true);
      if(output.width>maximumBuffer||output.height>maximumBuffer||output.width>maximumViewport[0]||output.height>maximumViewport[1])
        throw new GpuRenderError('GPU_SIZE','Output exceeds this WebGL context\'s drawing limits.');
      const space=frame?.space3d,view=space?.camera;
      if(!space||!view?.projectionMatrix)throw new GpuRenderError('GPU_PROJECTION','An evaluated 3D camera with projection is required.');
      const projection=view.projectionMatrix;
      validateGpuMatrix(projection,'projection');validateGpuMatrix(view.worldMatrix,'camera world');validateGpuMatrix(view.viewMatrix,'view');
      if(space.instances.length+space.curves.length>4096)throw new GpuRenderError('GPU_BUDGET','At most 4096 mesh and curve instances are supported.');
      const neededGeometry=new Set<GeometryKey>(),neededWire=new Set<GeometryKey>(),neededMaterials=new Set<string>(),ids=new Set<string>();let drawnTriangles=0,drawnSegments=0;
      const draws=space.instances.filter(instance=>instance.visible).map(instance=>{
        if(ids.has(instance.id))throw new GpuRenderError('GPU_INSTANCE','Duplicate evaluated instance ID.');ids.add(instance.id);
        const resource=frame.resources[instance.resourceId];
        if(!resource||resource.kind!=='mesh')throw new GpuRenderError('GPU_RESOURCE',`Missing mesh ${instance.resourceId}.`);
        if(!immutableMesh(resource))throw new GpuRenderError('GPU_RESOURCE_MUTABLE','Render an evaluated frame with immutable mesh resources.');
        validateGpuMatrix(instance.worldMatrix,'instance world');validateGpuMatrix(instance.modelViewMatrix,'model view');
        validateGpuOrientation(instance.worldMatrix,instance.orientation);
        if(Math.sign(new Matrix4().fromArray(instance.worldMatrix).determinantAffine())!==instance.orientation)
          throw new GpuRenderError('GPU_PRECISION','Backend determinant arithmetic cannot retain the evaluated front-face orientation.');
        validateGpuTransformBounds(resource.bounds,instance.modelViewMatrix,projection);
        const material=instance.material;validateGpuColor(material?.color);
        if(material.kind!=='unlit'||!['front','double'].includes(material.side)||typeof material.wireframe!=='boolean')throw new GpuRenderError('GPU_MATERIAL','Only opaque unlit front/double materials with boolean wireframe are supported.');
        // Validate the selection before caching a variant, including untrusted evaluated frames.
        gpuBufferSize(resource,material.colorAttribute);
        const key=geometryKey(resource,material.colorAttribute);neededGeometry.add(key);if(material.wireframe)neededWire.add(key);
        drawnTriangles+=resource.indices.count/3;
        if(drawnTriangles>MAX_GPU_TRIANGLES)throw new GpuRenderError('GPU_BUDGET','Frame exceeds one million drawn triangles.');
        const materialKey=`${material.color.toLowerCase()}:${material.side}:${material.wireframe}:${material.colorAttribute!==undefined}`;neededMaterials.add(materialKey);
        return {instance,resource,material,materialKey,key};
      });
      const curveDraws=space.curves.filter(instance=>instance.visible).map(instance=>{
        if(ids.has(instance.id))throw new GpuRenderError('GPU_INSTANCE','Duplicate evaluated instance ID.');ids.add(instance.id);
        const resource=frame.resources[instance.resourceId];
        if(!resource||resource.kind!=='curve3d')throw new GpuRenderError('GPU_RESOURCE',`Missing curve ${instance.resourceId}.`);
        if(!immutableCurve(resource))throw new GpuRenderError('GPU_RESOURCE_MUTABLE','Render an evaluated frame with immutable curve resources.');
        validateGpuMatrix(instance.worldMatrix,'curve world');validateGpuMatrix(instance.modelViewMatrix,'curve model view');
        validateGpuTransformBounds(resource.bounds,instance.modelViewMatrix,projection);validateGpuColor(instance.color);
        drawnSegments+=Math.max(0,resource.positions.count-1);
        if(drawnSegments>1_000_000)throw new GpuRenderError('GPU_BUDGET','Frame exceeds one million drawn line segments.');
        const materialKey=`line:${instance.color.toLowerCase()}`;neededMaterials.add(materialKey);const key=geometryKey(resource);neededGeometry.add(key);
        return {instance,resource,materialKey,key};
      });
      const bytes=[...neededGeometry].reduce((total,key)=>{const r=key.resource;return total+(r.kind==='curve3d'?gpuCurveBufferSize(r):gpuBufferSize(r,key.colorAttribute)+(neededWire.has(key)?gpuWireBufferSize(r,key.colorAttribute):geometries.get(key)?.wireBytes??0));},0);
      if(bytes>MAX_GPU_BUFFER_BYTES)throw new GpuRenderError('GPU_BUDGET','Frame exceeds 128 MiB vertex/index uploads including derived wireframe indices.');
      if(space.clippingPlanes.length>8)throw new GpuRenderError('GPU_CLIPPING','At most eight world clipping planes are supported.');
      const planes=space.clippingPlanes.map(p=>new Plane(new Vector3(...p.normal.map((n,i)=>finiteFloat32(n,`clip normal ${i}`)) as [number,number,number]),finiteFloat32(p.constant,'clip constant')));
      camera.matrixWorld.fromArray(view.worldMatrix);camera.matrixWorldInverse.fromArray(view.viewMatrix);camera.projectionMatrix.fromArray(projection);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      // Validate Three's view-space clipping uniforms before any upload.
      for(const p of planes){const projected=p.clone().applyMatrix4(camera.matrixWorldInverse);
        [projected.normal.x,projected.normal.y,projected.normal.z,projected.constant].forEach(n=>finiteFloat32(n,'view clipping plane'));}
      const added:GeometryKey[]=[];
      try{for(const key of neededGeometry)if(!geometries.has(key)){
        const resource=key.resource;
        const data:{positions:Float32Array;bytes:number;indices?:Uint16Array|Uint32Array;colors?:Float32Array}=resource.kind==='mesh'?prepareGpuGeometry(resource,key.colorAttribute):prepareGpuCurveGeometry(resource),geometry=new BufferGeometry();
        geometry.setAttribute('position',new BufferAttribute(data.positions,3));
        if(data.colors)geometry.setAttribute('color',new BufferAttribute(data.colors,3));
        if(data.indices)geometry.setIndex(new BufferAttribute(data.indices,1));
        geometries.set(key,{geometry,bytes:data.bytes,wireBytes:0});added.push(key);
      }}catch(cause){for(const resource of added){geometries.get(resource)!.geometry.dispose();geometries.delete(resource);}throw cause;}
      for(const [key,entry] of geometries)if(!neededGeometry.has(key)){entry.geometry.dispose();geometries.delete(key);}
      for(const [key,material] of materials)if(!neededMaterials.has(key)){material.dispose();materials.delete(key);}
      const meshIds=new Set(draws.map(d=>d.instance.id)),curveIds=new Set(curveDraws.map(d=>d.instance.id));
      for(const [id,mesh] of meshes)if(!meshIds.has(id)){scene.remove(mesh);meshes.delete(id);}
      for(const [id,line] of lines)if(!curveIds.has(id)){scene.remove(line);lines.delete(id);}
      for(const key of neededWire)geometries.get(key)!.wireBytes=gpuWireBufferSize(key.resource as DeepReadonly<MeshResource>,key.colorAttribute);
      for(const {instance,key,material,materialKey} of draws){
        if(!materials.has(materialKey)){
          const value=new MeshBasicMaterial({color:material.color,side:material.side==='double'?DoubleSide:FrontSide,
            toneMapped:false,transparent:false,opacity:1,depthTest:true,depthWrite:true,wireframe:material.wireframe,vertexColors:material.colorAttribute!==undefined});
          // Three computes this before the material hook. Use the evaluated matrix for the actual uniform.
          value.onBeforeRender=(_renderer,_scene,_camera,_geometry,object)=>object.modelViewMatrix.fromArray(modelViews.get(object as Mesh)!);
          materials.set(materialKey,value);
        }
        let mesh=meshes.get(instance.id);
        if(!mesh){mesh=new Mesh(geometries.get(key)!.geometry,materials.get(materialKey)!);mesh.matrixAutoUpdate=false;mesh.matrixWorldAutoUpdate=false;mesh.frustumCulled=false;meshes.set(instance.id,mesh);scene.add(mesh);}
        mesh.geometry=geometries.get(key)!.geometry;mesh.material=materials.get(materialKey)!;mesh.matrixWorld.fromArray(instance.worldMatrix);
        modelViews.set(mesh,instance.modelViewMatrix!);
      }
      for(const {instance,key,materialKey} of curveDraws){
        if(!materials.has(materialKey)){
          const value=new LineBasicMaterial({color:instance.color,toneMapped:false,transparent:false,opacity:1,depthTest:true,depthWrite:true});
          value.onBeforeRender=(_renderer,_scene,_camera,_geometry,object)=>object.modelViewMatrix.fromArray(modelViews.get(object as Line)!);
          materials.set(materialKey,value);
        }
        let line=lines.get(instance.id);
        if(!line){line=new Line(geometries.get(key)!.geometry,materials.get(materialKey)!);line.matrixAutoUpdate=false;line.matrixWorldAutoUpdate=false;line.frustumCulled=false;lines.set(instance.id,line);scene.add(line);}
        line.geometry=geometries.get(key)!.geometry;line.material=materials.get(materialKey)!;line.matrixWorld.fromArray(instance.worldMatrix);
        modelViews.set(line,instance.modelViewMatrix!);
      }
      // Preserve frame instance order for deterministic equal-depth ties after arbitrary prior renders.
      scene.children=[...draws.map(d=>meshes.get(d.instance.id)!),...curveDraws.map(d=>lines.get(d.instance.id)!)];
      renderer.clippingPlanes=planes;
      if(forceResize||width!==output.width||height!==output.height){renderer.setSize(output.width,output.height,false);width=output.width;height=output.height;forceResize=false;}
      renderer.setClearColor(new Color(background==='transparent'?'#000000':background),background==='transparent'?0:1);
      renderer.render(scene,camera);renders++;drawCalls=renderer.info.render.calls;triangles=renderer.info.render.triangles;segments=renderer.info.render.lines;
      if(context.isContextLost())throw new GpuRenderError('GPU_CONTEXT_LOST','Context was lost during rendering.');
    },
    stats(){return Object.freeze({state,width,height,geometries:geometries.size,materials:materials.size,instances:meshes.size+lines.size,
      bufferBytes:[...geometries.values()].reduce((n,e)=>n+e.bytes+e.wireBytes,0),renders,drawCalls,triangles,segments,contextGeneration:generation});},
    dispose(){if(state==='disposed')return;state='disposed';canvas.removeEventListener('webglcontextlost',lost);canvas.removeEventListener('webglcontextrestored',restored);
      clearCaches();renderer.dispose();renderer.forceContextLoss();},
  });
}
