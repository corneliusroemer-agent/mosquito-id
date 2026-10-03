import { chromium } from '/workspaces/claude-devcontainer/investigations/2026-10-02-mosquito-id/10-github-pages/site/node_modules/playwright/index.mjs';

const OUT = '/tmp/mosq-shots';
const browser = await chromium.launch({ args: ['--no-sandbox'] });

async function shot(name, embeds, specs, label) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  await page.route('**/*.onnx', (r) => r.abort());
  await page.goto('http://127.0.0.1:5050/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__mosqAsync?.renderThumbnails, null, { timeout: 15000 });
  const body = `
   (async () => {
    const specs = ${JSON.stringify(specs)};
    const EMBEDS_FILE = ${JSON.stringify(embeds)};
    const A = window.__mosqAsync;
    const emb = await fetch(EMBEDS_FILE).then((r) => r.json());
    for (const k of ['species_emb','nuisance_emb']) emb[k] = Float32Array.from(emb[k]);
    A.embeds = emb;
    const N = emb.species.length;
    function makeCanvas(w,h,hue,label){const cv=document.createElement('canvas');cv.width=w;cv.height=h;const c=cv.getContext('2d');c.fillStyle='hsl('+hue+',40%,55%)';c.fillRect(0,0,w,h);c.fillStyle='#fff';c.font=Math.round(w/20)+'px sans-serif';c.fillText(label,20,Math.round(h/12));return cv;}
    const built = specs.map((spec,i)=>{
      const full = makeCanvas(2400,1800,(i*47)%360,spec.name.slice(0,6));
      const crop = makeCanvas(900,900,(i*47+20)%360,spec.name.slice(0,4));
      const sidx = emb.species.indexOf(spec.species);
      const top = spec.top;
      const spP = new Array(N).fill(0);
      if (spec.spread) { for (const [n,v] of Object.entries(spec.spread)) spP[emb.species.indexOf(n)] = v; }
      else { spP.fill((1-top)/(N-1)); spP[sidx]=top; }
      const detail = Object.fromEntries(emb.species.map((s,j)=>[s,spP[j]]));
      const scores = {};
      for (const [s,p] of Object.entries(detail)) { const g=s.split(' ')[0]; scores[g]=(scores[g]??0)+p; }
      const logits = Object.fromEntries(emb.species.map((s,j)=>[s, Math.log(Math.max(spP[j],1e-9))]));
      const p = { name: spec.name, fullCanvas: full, cropCanvas: crop, contextCanvas: full,
        detail, scores, logits, adP: null, adjacentDetail: null, verdict: null, pending:false,
        error:null, is_cropped:true, fallback:false, status:'ok', rev:0, agreement:null,
        viewsLanded:0, viewsTotal:0, fingerprint:'fp'+i, manual_full_photo:false };
      p.verdict = A.verdictFrom(spP, null, []);
      return p;
    });
    A.previews.length=0; A.includedIndices.clear();
    for (const p of built) A.previews.push(p);
    for (let i=0;i<built.length;i++) A.includedIndices.add(i);
    A.selectedIndex=0;
    document.getElementById('gallery-section').style.display='block';
    document.getElementById('results-table-section').style.display='block';
    A.renderThumbnails(); A.renderActivePhoto(); A.updatePooling(); A.renderResultsTable();
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
   })();
  `;
  await page.evaluate((src) => { (0, eval)(src); }, body);
  await page.waitForTimeout(300);
  const sel = await page.locator('#engine-select').innerText();
  console.log('---', label, '\n  dropdown:', sel.replace(/\n/g, ' | '));
  console.log('  sentence:', (await page.locator('#score-uncertain').innerText()) || '(empty)');
  const rows = await page.locator('#score-list .score-item').allInnerTexts();
  console.log('  rows:', rows.length);
  for (const r of rows.slice(0, 6)) console.log('    ', r.replace(/\n/g, ' '));
  console.log('  table:', (await page.locator('#results-table tbody tr').first().innerText()).replace(/\n/g, ' | '));
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  await page.close();
}

await shot('culico-grouped-species', 'text_embeds_culico.json', [{name:'aedes_vexans.jpg', species:'Aedes vexans', top:0.9}], 'culico, confident on a grouped species');
await shot('culico-singleton-species', 'text_embeds_culico.json', [{name:'albopictus.jpg', species:'Aedes albopictus', top:0.9}], 'culico, confident on a separable species');
await shot('culico-genus-state', 'text_embeds_culico.json', [{name:'torn.jpg', species:'Culex pipiens', top:0.30}], 'culico, under the species floor');
await shot('culico-genus-decided', 'text_embeds_culico.json', [{name:'aedes_torn.jpg', species:'Aedes aegypti', top:0, spread:{'Aedes albopictus':0.30,'Aedes aegypti':0.22,'Aedes japonicus':0.16,'Aedes koreicus':0.13}}], 'culico, genus decided, no species over the floor');
await shot('h14-species', 'text_embeds.json', [{name:'aedes_vexans.jpg', species:'Aedes vexans', top:0.9}], 'H/14, confident on a grouped species');

await browser.close();
