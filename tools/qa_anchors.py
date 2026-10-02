"""Verify rendered arrow tips against captured PGF anchors through SVG matrices."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright


def run(folder):
    folder = folder.resolve()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1280, 'height': 720})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto((folder / 'player.html').as_uri() + '?capture=1')
        page.wait_for_function('Boolean(window.texloom)')
        duration = page.evaluate('window.texloom.bundle.duration')
        results = []
        for time in [duration * x for x in (0, .25, .5, .75, 1, .25)]:
            result = page.evaluate('''time => {
                const frame = window.texloom.render(time);
                const nodes = new Map(frame.nodes.map(n => [n.id, n]));
                const elements = new Map([...document.querySelectorAll('[data-node-id]')]
                    .map(el => [el.getAttribute('data-node-id'), el]));
                const screen = (id, point) => new DOMPoint(...point)
                    .matrixTransform(elements.get(id).getScreenCTM());
                return window.texloom.bundle.relations.filter(r => r.type === 'connect').flatMap(r => {
                    return ['start', 'end'].flatMap(which => {
                        const polygon = elements.get(r.target).querySelector(`[data-arrow="${which}"]`);
                        if (!polygon) return [];
                        const ref = which === 'start' ? r.from : r.to;
                        const expected = screen(ref.node, nodes.get(ref.node).anchors[ref.anchor]);
                        const point = polygon.points.getItem(0);
                        const actual = new DOMPoint(point.x, point.y).matrixTransform(polygon.getScreenCTM());
                        return [{time, edge:r.target, end:which,
                            distance:Math.hypot(expected.x-actual.x, expected.y-actual.y)}];
                    });
                });
            }''', time)
            results.extend(result)
        browser.close()
    assert results, 'No live arrowheads found for anchor verification'
    maximum = max(result['distance'] for result in results)
    assert maximum < .001, f'Rendered arrow tip diverged from PGF anchor: {maximum}px'
    assert not errors, errors
    report = {'checks': len(results), 'maximumScreenErrorPx': maximum,
              'browserErrors': errors, 'samples': results}
    (folder / 'qa').mkdir(exist_ok=True)
    (folder / 'qa' / 'anchors.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    print(json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    run(parser.parse_args().folder)
