// Gaze geometry across a pointer sweep: how far the drawing travels, how each eye's width changes,
// and — the open question — whether the distance between the eye centres contracts under deflection.
//
//   node tools/harness/gaze-sweep.js            measure ours against the reference
//   node tools/harness/gaze-sweep.js --write    also write tools/baseline/gaze.json
//
// THE NUMBER THIS HARNESS EXISTS TO GET RIGHT is the inter-eye gap, and it is the number a previous
// session got wrong twice over:
//
//   1. Flood fill merged the two eyes at deflection (they sit 9.2px apart), so every width was junk.
//      Fixed by columnScan, which never spans the midline.
//   2. getBoundingClientRect readings were inflated 420/372 = 1.129x by the demo page's CSS, turning
//      a correct 151.6 into 168 and inventing an "eyes are ~11% larger" scale bug that did not exist.
//      Fixed by captureBackingStore.
//
// A third trap is live here and caught this harness during development: Playwright's mouse starts at
// (0,0), which deflects the reference's gaze before a single measurement is taken. Every reference
// capture must be preceded by an explicit look().
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { launch, openSim, openReference } from '../lib/pages.js';
import { inkMask, columnScan, interEyeGap, inkArea } from '../lib/measure.js';
import { GAP_TOLERANCE, HEIGHT_TOLERANCE, AREA_SPREAD_MIN } from '../lib/thresholds.js';


const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, '..', 'baseline', 'gaze.json');

// Rest, half and full deflection in both directions, plus the vertical axis. The reference's own
// figures for the gap are 152 / 146 / 136 at rest / half / full.
const LOOKS = [
  [0, 0],
  [0.5, 0], [1, 0],
  [-0.5, 0], [-1, 0],
  [0, 0.5], [0, 1],
  [0, -1],
  [1, 1], [-1, -1],
];

function sample(mask) {
  const g = interEyeGap(mask);
  const l = columnScan(mask, 'l'), r = columnScan(mask, 'r');
  const all = columnScan(mask, 'all');
  return {
    gap: g ? g.gap : null,
    centreL: g ? g.centreL : null,
    centreR: g ? g.centreR : null,
    widthL: l.width,
    widthR: r.width,
    heightL: l.height,
    heightR: r.height,
    drawingX0: all.x0,
    drawingX1: all.x1,
    area: inkArea(mask),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const { browser, context } = await launch();
  const out = { sim: [], ref: [], cssRatio: null };
  try {
    const sim = await openSim(context, { state: '1b' });
    for (const look of LOOKS) {
      await sim.clear();
      await sim.render(0, look);
      const shot = await sim.capture();
      out.cssRatio = shot.cssRatio;
      out.sim.push({ look, ...sample(inkMask(shot)) });
    }

    const ref = await openReference(context, { state: '1b' });
    for (const look of LOOKS) {
      await ref.look(look[0], look[1]);
      // Largest-ink frame: the reference blinks on its own clock and a closed eye would corrupt every
      // width here.
      const shot = await ref.captureOpen({ samples: 10, everyMs: 80 });
      out.ref.push({ look, ...sample(inkMask(shot)) });
    }
    await ref.page.close();
  } finally {
    await browser.close();
  }

  console.log(`canvas cssRatio ${out.cssRatio} (anything but 1 means CSS pixels are leaking in)\n`);
  console.log('look        sim gap  ref gap   dGap   sim wL/hL wR/hR    ref wL/hL wR/hR    dW  dH');
  let worst = 0, worstH = 0;
  for (let i = 0; i < LOOKS.length; i++) {
    const s = out.sim[i], r = out.ref[i];
    const d = s.gap !== null && r.gap !== null ? +(s.gap - r.gap).toFixed(2) : null;
    if (d !== null) worst = Math.max(worst, Math.abs(d));
    const dW = Math.max(Math.abs(s.widthL - r.widthL), Math.abs(s.widthR - r.widthR));
    const dH = Math.max(Math.abs(s.heightL - r.heightL), Math.abs(s.heightR - r.heightR));
    worstH = Math.max(worstH, dH);
    console.log(
      `${JSON.stringify(s.look).padEnd(11)} ${String(s.gap).padStart(6)}  ${String(r.gap).padStart(7)}  ` +
      `${String(d).padStart(6)}   ${`${s.widthL}/${s.heightL} ${s.widthR}/${s.heightR}`.padEnd(17)}` +
      `${`${r.widthL}/${r.heightL} ${r.widthR}/${r.heightR}`.padEnd(18)}${String(dW).padStart(3)}${String(dH).padStart(4)}`
    );
  }
  const travelSim = Math.max(...out.sim.map((s) => s.drawingX0)) - Math.min(...out.sim.map((s) => s.drawingX0));
  const travelRef = Math.max(...out.ref.map((s) => s.drawingX0)) - Math.min(...out.ref.map((s) => s.drawingX0));

  // Area spread: the statistic that separates a turn from a slide. A pure translation conserves area
  // exactly, so a near-zero spread means the eyes only slide however good the other numbers look.
  const spread = (rows) => {
    const v = rows.map((x) => x.area);
    return (Math.max(...v) - Math.min(...v)) / Math.min(...v);
  };
  const spreadSim = spread(out.sim), spreadRef = spread(out.ref);

  console.log(`\nhorizontal travel: sim ${travelSim}px  ref ${travelRef}px`);
  const pass = [];
  const gate = (name, ok, detail) => { pass.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); };
  gate('gap', worst <= GAP_TOLERANCE, `worst ${worst.toFixed(2)}px, tolerance ${GAP_TOLERANCE}px`);
  gate('per-eye height', worstH <= HEIGHT_TOLERANCE, `worst ${worstH}px, tolerance ${HEIGHT_TOLERANCE}px`);
  gate('area spread', spreadSim >= AREA_SPREAD_MIN,
    `sim ${(spreadSim * 100).toFixed(2)}%, ref ${(spreadRef * 100).toFixed(2)}%, floor ${(AREA_SPREAD_MIN * 100).toFixed(0)}%` +
    ` (a spread near zero means the eyes slide without turning)`);
  console.log(pass.every(Boolean) ? '\nall gates PASS' : '\nsome gates FAIL');

  if (write) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n');
    console.log(`wrote ${BASELINE}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
