/** Independent test-only WebGL2 reference: no Three or Texloom rendering imports. */
export interface ReferenceDraw {positions:number[];indices:number[];model:number[];viewProjection:number[];color:string;side:'front'|'double';orientation:number;primitive?:'line-strip'}
export function renderRawReference(canvas:HTMLCanvasElement,draws:ReferenceDraw[],width:number,height:number,planes:number[][]=[]):Uint8Array {
  canvas.width=width;canvas.height=height;
  const gl=canvas.getContext('webgl2',{antialias:false,alpha:true,preserveDrawingBuffer:true,premultipliedAlpha:true});
  if(!gl)throw Error('REFERENCE_WEBGL2_UNAVAILABLE');
  const shader=(kind:number,source:string)=>{const s=gl.createShader(kind)!;gl.shaderSource(s,source);gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s)??'shader');return s;};
  const vs=shader(gl.VERTEX_SHADER,`#version 300 es
  precision highp float;in vec3 position;uniform mat4 model;uniform mat4 viewProjection;out vec3 world;
  void main(){vec4 p=model*vec4(position,1.0);world=p.xyz;gl_Position=viewProjection*p;}`);
  const fs=shader(gl.FRAGMENT_SHADER,`#version 300 es
  precision highp float;in vec3 world;uniform vec3 color;uniform int count;uniform vec4 planes[8];out vec4 pixel;
  void main(){for(int i=0;i<8;i++){if(i<count&&dot(planes[i].xyz,world)+planes[i].w<0.0)discard;}pixel=vec4(color,1.0);}`);
  const program=gl.createProgram()!;gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program)??'link');
  const vao=gl.createVertexArray()!,vertices=gl.createBuffer()!,indices=gl.createBuffer()!;
  gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,vertices);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indices);
  gl.useProgram(program);const location=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(location);gl.vertexAttribPointer(location,3,gl.FLOAT,false,0,0);
  gl.viewport(0,0,width,height);gl.clearColor(0,0,0,0);gl.clearDepth(1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.BLEND);
  gl.uniform1i(gl.getUniformLocation(program,'count'),planes.length);
  const padded=Array(32).fill(0);planes.forEach((p,i)=>p.forEach((n,j)=>padded[i*4+j]=n));gl.uniform4fv(gl.getUniformLocation(program,'planes'),padded);
  for(const draw of draws){
    if(draw.side==='double')gl.disable(gl.CULL_FACE);else {gl.enable(gl.CULL_FACE);gl.cullFace(gl.BACK);}
    gl.frontFace(draw.orientation<0?gl.CW:gl.CCW);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(draw.positions),gl.STATIC_DRAW);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint32Array(draw.indices),gl.STATIC_DRAW);
    gl.uniformMatrix4fv(gl.getUniformLocation(program,'model'),false,new Float32Array(draw.model));
    gl.uniformMatrix4fv(gl.getUniformLocation(program,'viewProjection'),false,new Float32Array(draw.viewProjection));
    gl.uniform3fv(gl.getUniformLocation(program,'color'),[1,3,5].map(i=>parseInt(draw.color.slice(i,i+2),16)/255));
    if(draw.primitive==='line-strip')gl.drawArrays(gl.LINE_STRIP,0,draw.positions.length/3);
    else gl.drawElements(gl.TRIANGLES,draw.indices.length,gl.UNSIGNED_INT,0);
  }
  const pixels=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
  gl.deleteBuffer(vertices);gl.deleteBuffer(indices);gl.deleteVertexArray(vao);gl.deleteProgram(program);gl.deleteShader(vs);gl.deleteShader(fs);
  return pixels;
}
