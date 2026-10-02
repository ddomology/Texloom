"""Real-browser checks of SVG and native Canvas consumers and shared time."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]

def fixture():
    return {'version':'0.2','title':'Compositing fixture','duration':2,'units':'bp',
        'viewport':{'width':160,'height':100},'camera':{'x':0,'y':0,'zoom':1},
        'nodes':[
            {'id':'group','kind':'group','style':{'opacity':.5,'fill':'#abcdef'},'clip':{'d':'M10 10H140V90H10Z'}},
            {'id':'red','parent':'group','kind':'path','d':'M0 10H90V90H0Z','style':{'fill':'red'}},
            {'id':'blue','parent':'group','kind':'path','d':'M60 10H160V90H60Z','style':{'fill':'blue'}},
            {'id':'nested','parent':'group','kind':'group','style':{'opacity':.6},'transform':{'translate':[15,15],'rotate':.2}},
            {'id':'tex','parent':'nested','kind':'tex','resourceId':'art','x':0,'y':50},
        ],'resources':{'art':{'kind':'vector','metrics':{'width':60,'height':50,'depth':0},'inkBounds':[0,-50,60,50],
            'items':[{'kind':'group','clip':{'d':'M0 -50H40V0H0Z','transform':[1,0,0,1,8,0]},
                'children':[{'kind':'path','d':'M0 -50H60V0H0Z M10 -40V-10H50V-40Z',
                'style':{'fill':'currentColor','fillRule':'evenodd'}}]}]}},'tracks':[],'relations':[]}

def run(page_path):
    output=page_path.resolve().parent
    report={'browserErrors':[],'parity':[],'seek':[]}
    scenes=[('opacity-clip',fixture())]
    for name in ('demo','v02','field'):
        path=ROOT/'build'/name/'bundle.json'
        if path.exists():scenes.append((name,json.loads(path.read_text(encoding='utf8'))))
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page(viewport={'width':1440,'height':1050})
        page.on('pageerror',lambda e:report['browserErrors'].append(str(e)))
        page.goto(page_path.resolve().as_uri());page.wait_for_function('Boolean(window.texloomDual?.ready)')
        for name,bundle in scenes:
            result=page.evaluate('''async ({bundle})=>{
                const api=window.texloomDual;
                const scene=api.prepareScene(bundle), frame=scene.sample(bundle.duration/2);
                const w=bundle.viewport.width,h=bundle.viewport.height;
                const native=document.createElement('canvas');native.width=w;native.height=h;
                const c=native.getContext('2d');api.renderCanvas(frame,c);
                const reference=document.createElement('canvas');reference.width=w;reference.height=h;
                const r=reference.getContext('2d');
                const url=URL.createObjectURL(new Blob([api.renderSvg(frame)],{type:'image/svg+xml'}));
                try {const img=new Image();img.src=url;await img.decode();r.drawImage(img,0,0);}finally{URL.revokeObjectURL(url)}
                const a=c.getImageData(0,0,w,h).data,b=r.getImageData(0,0,w,h).data;
                let changed=0,total=0,max=0;
                for(let i=0;i<a.length;i+=4){let diff=false;for(let j=0;j<4;j++){const d=Math.abs(a[i+j]-b[i+j]);diff ||= d>0;total+=d;max=Math.max(max,d)}if(diff)changed++}
                const first=native.toDataURL();api.renderCanvas(scene.sample(bundle.duration),c);api.renderCanvas(scene.sample(0),c);api.renderCanvas(frame,c);
                return {width:w,height:h,changedPixels:changed,maximumChannelDifference:max,meanChannelDifference:total/a.length,
                    changedFraction:changed/(w*h),reverseSeekSame:first===native.toDataURL(),
                    centerNative:[...c.getImageData(110,50,1,1).data],centerSvg:[...r.getImageData(110,50,1,1).data]};
            }''',{'bundle':bundle})
            report['parity'].append({'scene':name,**result})
            # Native Canvas and SVG share geometry, but Skia edge rasterization
            # can differ. Interior compositing is tested separately below.
            assert result['meanChannelDifference']<1 and result['changedFraction']<.06,result
            assert result['reverseSeekSame'],result
            if name=='opacity-clip':assert result['centerNative']==result['centerSvg'],result
        page.evaluate('window.texloomDual.draw(6)')
        report['contextState']=page.evaluate('''()=>{
            const api=window.texloomDual,frame=api.runtime.sample(6),canvas=document.createElement('canvas');canvas.width=960;canvas.height=540;
            const ctx=canvas.getContext('2d');ctx.translate(7,9);ctx.globalAlpha=.3;ctx.fillStyle='red';ctx.setLineDash([3,4]);
            const state=()=>JSON.stringify([ctx.getTransform().toString(),ctx.globalAlpha,ctx.fillStyle,ctx.getLineDash()]);
            const before=state();api.renderCanvas(frame,ctx);return {preserved:before===state()};
        }''')
        assert report['contextState']['preserved']
        report['hostClip']=page.evaluate('''()=>{
            const api=window.texloomDual,canvas=document.createElement('canvas');canvas.width=960;canvas.height=540;
            const ctx=canvas.getContext('2d');ctx.fillStyle='black';ctx.fillRect(0,0,960,540);
            ctx.beginPath();ctx.rect(0,0,40,540);ctx.clip();
            api.renderCanvas(api.runtime.sample(6),ctx);
            return {outside:[...ctx.getImageData(100,100,1,1).data],inside:[...ctx.getImageData(5,5,1,1).data]};
        }''')
        assert report['hostClip']['outside']==[0,0,0,255]
        assert report['hostClip']['inside']==[9,28,39,255]
        first={}
        for time in (0,3,6,9,12):
            page.evaluate('(t)=>window.texloomDual.draw(t)',time)
            first[time]=page.locator('#board').evaluate('(c)=>c.toDataURL()')
        for time in (12,3,9,0,6):
            page.evaluate('(t)=>window.texloomDual.draw(t)',time)
            same=first[time]==page.locator('#board').evaluate('(c)=>c.toDataURL()')
            report['seek'].append({'time':time,'samePixels':same});assert same
        report['timing']=page.evaluate('''()=>{
            const api=window.texloomDual, canvas=document.createElement('canvas');canvas.width=960;canvas.height=540;const ctx=canvas.getContext('2d');
            const values=[];for(let i=0;i<40;i++){const start=performance.now();api.renderCanvas(api.runtime.sample(i/40*12),ctx);values.push(performance.now()-start)}
            values.sort((a,b)=>a-b);return {samples:40,width:960,height:540,medianMs:values[20],p95Ms:values[38],scope:'sample + native Canvas render on this machine; no video encoding'};
        }''')
        for width in (1440,390):
            page.set_viewport_size({'width':width,'height':1050})
            assert page.evaluate('document.documentElement.scrollWidth===innerWidth')
            page.screenshot(path=str(output/f'dual-{width}.png'),full_page=True)
        browser.close()
    assert not report['browserErrors'],report['browserErrors']
    (output/'verification.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('page',type=Path);run(parser.parse_args().page)
