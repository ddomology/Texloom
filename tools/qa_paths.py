"""Compare captured live geometry with native PGF art and both frame renderers."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

COMPARE = r'''async ({native, reference, time}) => {
    const api=window.texloomDual;
    const aFrame=api.prepareScene(native).sample(time), bFrame=api.prepareScene(reference).sample(time);
    const w=native.viewport.width,h=native.viewport.height;
    async function paint(frame,canvasMode){
        const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
        const ctx=canvas.getContext('2d');
        if(canvasMode) api.renderCanvas(frame,ctx);
        else {
            const url=URL.createObjectURL(new Blob([api.renderSvg(frame)],{type:'image/svg+xml'}));
            try{const img=new Image();img.src=url;await img.decode();ctx.drawImage(img,0,0);}
            finally{URL.revokeObjectURL(url)}
        }
        return ctx.getImageData(0,0,w,h).data;
    }
    const a=await paint(aFrame,true),b=await paint(bFrame,false);
    let changed=0,total=0,max=0;
    for(let i=0;i<a.length;i+=4){let different=false;for(let j=0;j<4;j++){
        const d=Math.abs(a[i+j]-b[i+j]);different ||= d>0;total+=d;max=Math.max(max,d)
    }if(different)changed++}
    return {time,changedPixels:changed,changedFraction:changed/(w*h),
        maximumChannelDifference:max,meanChannelDifference:total/a.length};
}'''

def run(page_path, bundle_path):
    bundle=json.loads(bundle_path.read_text(encoding='utf8'))
    report={'pgfReference':[],'frameParity':[],'browserErrors':[]}
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page()
        page.on('pageerror',lambda e:report['browserErrors'].append(str(e)))
        page.goto(page_path.resolve().as_uri())
        page.wait_for_function('Boolean(window.texloomDual?.ready)')
        by_id={n['id']:n for n in bundle['nodes']}
        for node in bundle['nodes']:
            if node['kind']!='path' or 'geometry' not in node:continue
            rid=node.get('source',{}).get('referenceResourceId')
            if not rid:continue
            parents=[];parent=node.get('parent')
            while parent:
                parents.insert(0,by_id[parent]);parent=by_id[parent].get('parent')
            native={**bundle,'nodes':[*parents,{**node,'reveal':1}],'tracks':[],'relations':[]}
            art=bundle['resources'][rid]
            reference_node={k:node[k] for k in ('id','parent','transform') if k in node}
            reference_node.update(kind='tex',resourceId=rid,x=art['provenance']['pgfCapture']['bounds'][0],y=0)
            reference={**native,'nodes':[*parents,reference_node]}
            result=page.evaluate(COMPARE,{'native':native,'reference':reference,'time':0})
            report['pgfReference'].append({'path':node['id'],**result})
            # Real PGF driver coordinates have another fixed-point conversion;
            # tiny edge AA differences are expected. Large offsets/fills fail.
            assert result['meanChannelDifference']<.2 and result['changedFraction']<.02,result
        assert report['pgfReference'],'No PGF reference paths were compared'
        for fraction in (0,.05,.1,1/6,1/3,.5,2/3,5/6,1):
            result=page.evaluate(COMPARE,{'native':bundle,'reference':bundle,'time':fraction*bundle['duration']})
            report['frameParity'].append(result)
            assert result['meanChannelDifference']<1 and result['changedFraction']<.06,result
        report['deformation']=page.evaluate('''()=>{
            const api=window.texloomDual,run=api.runtime;
            const path=t=>run.sample(t).nodes.find(n=>n.kind==='path'&&n.geometry);
            const a=path(2),b=path(6),c=path(10);
            return {controlCoordinatesChange:JSON.stringify(a.geometry)!==JSON.stringify(b.geometry),
                renderedCurveChanges:a.d!==b.d,
                reverseSeekStable:JSON.stringify(b)===JSON.stringify(path(6)),
                topologyStable:JSON.stringify(a.geometry.contours.map(c=>c.segments.map(s=>[s.id,s.kind])))===
                    JSON.stringify(c.geometry.contours.map(c=>c.segments.map(s=>[s.id,s.kind])))};
        }''')
        assert all(report['deformation'].values()),report['deformation']
        assert not report['browserErrors'],report['browserErrors']
        browser.close()
    (page_path.parent/'path-verification.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('page',type=Path);parser.add_argument('bundle',type=Path)
    args=parser.parse_args();run(args.page,args.bundle)
