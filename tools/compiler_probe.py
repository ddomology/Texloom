"""Measured, bounded DVI-versus-LuaTeX extraction probe on identical math."""
from pathlib import Path
import json
from compile import asset_document, compile_scene, run, version, write_json

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'build'/'compiler-probe'
BODY=r'\frac{x_i^2}{1+x_i^2}+\sum_{n=0}^{\infty}a_n'
LUA=r'''
function probe(boxnum)
  local b=tex.box[boxnum]
  local count={}
  local glyphs=0
  local function walk(head)
    for n in node.traverse(head) do
      local name=node.type(n.id)
      count[name]=(count[name] or 0)+1
      if name=="glyph" then glyphs=glyphs+1 end
      if n.head then walk(n.head) end
    end
  end
  walk(b.head)
  local parts={}
  for k,v in pairs(count) do parts[#parts+1]='"'..k..'":'..v end
  table.sort(parts)
  local conv=72/72.27/65536
  local f=assert(io.open("node-probe.json","w"))
  f:write('{"metrics":{"width":'..b.width*conv..',"height":'..b.height*conv..',"depth":'..b.depth*conv..'},"glyphCount":'..glyphs..',"nodeCounts":{'..table.concat(parts,',')..'}}')
  f:close()
end
'''

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    source=OUT/'probe.tex'
    source.write_text(r'\documentclass{article}\usepackage{texloom}\begin{document}\TLScene{Probe}{400}{200}{1}\TLMath{probe}{'+BODY+r'}\null\end{document}',encoding='utf8')
    bundle=compile_scene(source,OUT/'dvi')
    dvi=bundle['resources']['probe']
    lua=OUT/'lua'; lua.mkdir(exist_ok=True)
    (lua/'node-probe.lua').write_text(LUA,encoding='utf8')
    text=asset_document(BODY,'math','')
    text=text.replace(r'\immediate\openout\TLmetrics',r'\directlua{dofile("node-probe.lua"); probe(\number\TLbox)}'+'\n'+r'\immediate\openout\TLmetrics')
    (lua/'probe.tex').write_text(text,encoding='utf8')
    execution=run(['lualatex','-no-shell-escape','-interaction=nonstopmode','-halt-on-error','probe.tex'],lua)
    data=json.loads((lua/'node-probe.json').read_text())
    dvi_report=json.loads((OUT/'dvi'/'compile-report.json').read_text())
    report={'fixture':BODY,'toolchain':{**bundle['provenance']['toolchain'],'lualatex':version('lualatex')},
        'dvi':{'metricsBp':dvi['metrics'],'glyphInstances':len(dvi['glyphs']),'compilerCommands':dvi_report['commands']},
        'lua':{**data,'seconds':execution['seconds']},
        'absoluteMetricDifferenceBp':{key:abs(dvi['metrics'][key]-data['metrics'][key]) for key in ('width','height','depth')},
        'decision':'DVI + explicit TeX declarations is v0.1 primary route. It reuses proven glyph outline conversion and PGF driver output; LuaTeX probe confirms accessible structured node information but does not yet extract equivalent TikZ/paint trees.',
        'scope':'One formula on this machine; timings are observations, not a performance benchmark. Neither output infers mathematical meaning or parametric geometry from ordinary TeX.'}
    write_json(OUT/'comparison.json',report)
    print(json.dumps(report,indent=2))

if __name__=='__main__': main()
