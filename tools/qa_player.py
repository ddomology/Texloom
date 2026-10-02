"""End-to-end browser QA: seeking, controls, exported SVG parity, mobile layout."""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET
from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

def digest(data): return hashlib.sha256(data).hexdigest()
def pixel_difference(a,b):
    one=Image.open(io.BytesIO(a)).convert('RGB'); two=Image.open(io.BytesIO(b)).convert('RGB')
    if one.size!=two.size: return {'sizeMismatch':[one.size,two.size]}
    d=ImageChops.difference(one,two)
    pixels=list(d.get_flattened_data() if hasattr(d,'get_flattened_data') else d.getdata())
    return {'changedPixels':sum(any(v>0 for v in p) for p in pixels),
            'maximumChannelDifference':max(max(p) for p in pixels),
            'meanChannelDifference':sum(sum(p) for p in pixels)/(3*len(pixels))}

def run(folder):
    folder=folder.resolve(); qa=folder/'qa'; qa.mkdir(exist_ok=True)
    bundle=json.loads((folder/'bundle.json').read_text(encoding='utf8'))
    uri=(folder/'player.html').as_uri()
    report={'scene':bundle['title'],'browserErrors':[],'seek':[], 'resourceParity':[]}
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True)
        page=browser.new_page(viewport={'width':1440,'height':1000},device_scale_factor=1)
        page.on('pageerror',lambda e:report['browserErrors'].append(str(e)))
        page.goto(uri); page.wait_for_function('Boolean(window.texloom)')
        page.screenshot(path=str(qa/'desktop.png'),full_page=True)
        page.locator('#play').click()
        page.wait_for_function('window.texloom.getFrame().time > 0.1')
        page.locator('#play').click()
        report['controls']={'playAdvanced':page.evaluate('window.texloom.getFrame().time')>0.1,
                            'paused':page.locator('#play').get_attribute('aria-pressed')=='false'}
        page.locator('#timeline').evaluate('(el)=>{el.value=2;el.dispatchEvent(new Event("input",{bubbles:true}));}')
        assert page.evaluate('window.texloom.getFrame().time')==2
        page.locator('#object-list button').first.click()
        report['controls']['selectedObject']=page.locator('#selected-name').inner_text()
        with page.expect_download() as dl:
            page.locator('#download-svg').click()
        report['controls']['svgDownload']=dl.value.suggested_filename
        page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(qa/'mobile.png'),full_page=True)
        report['mobile']=page.evaluate('({width:innerWidth,content:document.documentElement.scrollWidth})')
        assert report['mobile']['width']==report['mobile']['content']
        page.set_viewport_size({'width':int(bundle['viewport']['width']),'height':int(bundle['viewport']['height'])})
        page.goto(uri+'?capture=1');page.wait_for_function('Boolean(window.texloom)')
        await_ready='async()=>{await window.texloom.ready;}'
        page.evaluate(await_ready)
        stage=page.locator('#stage')
        first={}
        times=[0,1.25,bundle['duration']/2,bundle['duration']]
        for t in times:
            page.evaluate('(t)=>window.texloom.render(t)',t)
            png=stage.screenshot();first[t]=digest(png)
            (qa/f'frame-{t:.2f}.png').write_bytes(png)
        for t in reversed(times):
            page.evaluate('(t)=>window.texloom.render(t)',t)
            same=first[t]==digest(stage.screenshot())
            report['seek'].append({'time':t,'samePixels':same});assert same
        # Serialized reference renderer output versus the browser player at the same timestamp.
        svg_path=folder/'snapshot.svg'
        if svg_path.exists():
            page.evaluate('(t)=>window.texloom.render(t)',bundle['duration']/2)
            player_png=stage.screenshot()
            reference=browser.new_page(viewport={'width':int(bundle['viewport']['width']),'height':int(bundle['viewport']['height'])})
            reference.goto(svg_path.as_uri()); svg_png=reference.screenshot()
            report['snapshotParity']=pixel_difference(player_png,svg_png)
            assert report['snapshotParity']['maximumChannelDifference']==0
            reference.close()
        # Compare each normalized vector resource against actual dvisvgm output.
        svg_ns='http://www.w3.org/2000/svg'; ET.register_namespace('',svg_ns)
        for rid,r in bundle['resources'].items():
            converted=qa/'resources'/f'{rid}.svg'
            if r['kind']!='vector' or not converted.exists():continue
            original=(folder/r['provenance']['dvi']).with_suffix('.svg')
            root=ET.parse(original).getroot()
            ox,oy=r['provenance']['baselineOriginBp']; x,y,w,h=r['inkBounds']
            width,height=math.ceil(w+40),math.ceil(h+40)
            root.set('width',str(width));root.set('height',str(height));root.set('viewBox',f'{ox+x-20} {oy+y-20} {width} {height}')
            root.set('color','#e7eee4');root.set('fill','#e7eee4')
            backdrop=ET.Element('{'+svg_ns+'}rect',{'x':str(ox+x-20),'y':str(oy+y-20),'width':str(width),'height':str(height),'fill':'#091c27'})
            root.insert(0,backdrop)
            refpath=qa/'resources'/f'{rid}-reference.svg';ET.ElementTree(root).write(refpath,encoding='unicode')
            ref=browser.new_page(viewport={'width':width,'height':height})
            ref.goto(refpath.as_uri()); a=ref.screenshot()
            ref.goto(converted.as_uri()); b=ref.screenshot(); ref.close()
            result={'resource':rid,**pixel_difference(a,b)};report['resourceParity'].append(result)
            if result['meanChannelDifference'] >= 0.05:
                (qa/'resources'/f'{rid}-reference.png').write_bytes(a)
                (qa/'resources'/f'{rid}-converted.png').write_bytes(b)
            # Native SVG rect rules lower to equivalent path geometry. Chromium
            # rasterizes their edges slightly differently (fraction bars), so
            # check both low total error and bounded sparse edge differences.
            assert result['meanChannelDifference']<0.2 and result['maximumChannelDifference']<=32 and result['changedPixels']/(width*height)<0.02,result
        browser.close()
    assert not report['browserErrors'],report['browserErrors']
    (qa/'report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps(report),flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('folder',type=Path);run(parser.parse_args().folder)
