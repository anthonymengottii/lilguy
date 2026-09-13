// IoU of every state against the reference.
//
//   node tools/harness/iou-states.js            measure and print
//   node tools/harness/iou-states.js --write    also write tools/baseline/states.json
//   node tools/harness/iou-states.js --state 6a just one state
//
// Both sides render the same 400x400 authoring box at look [0,0] with the clock at t=0 and no clips
// running, so the comparison is of rest poses only. Ambient loops are deliberately absent: a blink
// landing in one capture and not the other would swamp the geometry being measured.
//
// The baseline this writes is what makes a fidelity change acceptable or rejectable. Three earlier
// attempts at the pair's convergence were reverted because they broke OTHER states — 6a's drawn area
// fell from 21363 to 2400 — and a single-state check could not have caught that.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { launch, openSim, openReference, assertSameSize } from '../lib/pages.js';
import { inkMask, bbox, inkArea, interEyeGap, alignedIoU } from '../lib/measure.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, '..', 'baseline', 'states.json');

// IOU_EPSILON lives in ../lib/thresholds.js, not here: importing this file would run its main().
import { IOU_EPSILON } from '../lib/thresholds.js';

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const only = argv.includes('--state') ? argv[argv.indexOf('--state') + 1] : null;

  const { browser, context } = await launch();
  const results = {};
  try {
    const sim = await openSim(context, { state: '1b' });
    const states = only ? [only] : await sim.states();
    console.log(`measuring ${states.length} state(s)`);

    for (const state of states) {
      await sim.setState(state);
      await sim.render(0, [0, 0]);
      const simShot = await sim.capture();

      // A fresh reference page per state: single-eye.html reads data-state once, at construction.
      // captureOpen, not capture: the reference blinks on a clock we cannot reach, so take the
      // largest-ink frame out of a timed series. A single shot lands mid-blink often enough that the
      // first run of this harness reported IoU 0.03 on a 258x25 bbox.
      const ref = await openReference(context, { state });
      // Park the pointer dead centre FIRST. Playwright's mouse starts at (0,0), which on this layout
      // sits up and to the left of the reference's box — so its gaze is deflected and every width and
      // centre is measured off a turned eye. Leaving this out cost an IoU of 0.825 and a reference
      // gap of 147 that looked like a real convergence difference.
      await ref.look(0, 0);
      const refShot = await ref.captureOpen();
      await ref.page.close();

      assertSameSize(simShot, refShot);
      const simMask = inkMask(simShot), refMask = inkMask(refShot);
      const al = alignedIoU(simMask, refMask);
      const score = al.aligned;
      results[state] = {
        iou: score,
        rawIou: al.raw,
        offset: { dx: al.dx, dy: al.dy },
        floor: +(score - IOU_EPSILON).toFixed(4),
        simBBox: bbox(simMask),
        refBBox: bbox(refMask),
        simArea: inkArea(simMask),
        refArea: inkArea(refMask),
        simGap: interEyeGap(simMask),
        refGap: interEyeGap(refMask),
        cssRatio: { sim: simShot.cssRatio, ref: refShot.cssRatio },
      };
      const g = results[state];
      console.log(
        `${state}  IoU ${score.toFixed(4)} (raw ${al.raw.toFixed(4)} @ ${al.dx},${al.dy})` +
        `  gap sim ${g.simGap ? g.simGap.gap : '—'} / ref ${g.refGap ? g.refGap.gap : '—'}` +
        `  area ${g.simArea}/${g.refArea}`
      );
    }
  } finally {
    await browser.close();
  }

  const scores = Object.values(results).map((r) => r.iou);
  console.log(
    `\n${scores.length} states  min ${Math.min(...scores).toFixed(4)}  ` +
    `mean ${(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4)}  max ${Math.max(...scores).toFixed(4)}`
  );
  const worst = Object.entries(results).sort((a, b) => a[1].iou - b[1].iou).slice(0, 6);
  console.log('worst:', worst.map(([k, v]) => `${k}=${v.iou.toFixed(3)}`).join(' '));

  if (write) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify(results, null, 2) + '\n');
    console.log(`\nwrote ${BASELINE}`);
  }
  return results;
}

main().catch((e) => { console.error(e.message); process.exit(1); });
