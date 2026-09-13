// The regression gate. Every one of the 36 states is compared to the reference and checked against
// tools/baseline/states.json.
//
// It gates on REGRESSION only. An earlier version also failed on improvement, to force a baseline
// commit rather than silent drift, and that made the suite intermittent — the reference's own blink
// clock gives each state a ~0.006 noise band, so a run landing at the top of the band tripped the
// upper bound with nothing changed. See IOU_EPSILON for the numbers. Gains are recorded by running
// `npm run baseline` and reviewing the diff, which is the record of what a change actually did.
//
// This gate is what makes the fidelity work reviewable at all. Three earlier attempts at the pair's
// convergence were reverted because they broke OTHER states — 6a's drawn area once fell from 21363 to
// 2400 — and no single-state check could have caught that.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSim, openReference, assertSameSize } from '../tools/lib/pages.js';
import { inkMask, alignedIoU, inkArea, interEyeGap } from '../tools/lib/measure.js';
import { IOU_EPSILON } from '../tools/lib/thresholds.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = JSON.parse(
  fs.readFileSync(path.join(HERE, '..', 'tools', 'baseline', 'states.json'), 'utf8')
);

test('every state matches the reference within its recorded baseline', async ({ browser }) => {
  const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1200, height: 900 } });
  const sim = await openSim(context, { state: '1b' });
  const states = Object.keys(BASELINE);
  expect(states.length, 'baseline should cover all 36 states').toBe(36);

  const regressions = [];
  const gains = [];

  for (const state of states) {
    await sim.setState(state);
    await sim.render(0, [0, 0]);
    const simShot = await sim.capture();

    const ref = await openReference(context, { state });
    await ref.look(0, 0);                       // neutralise Playwright's (0,0) mouse
    const refShot = await ref.captureOpen();    // largest-ink frame: the reference blinks on its own
    await ref.page.close();

    assertSameSize(simShot, refShot);
    const simMask = inkMask(simShot), refMask = inkMask(refShot);
    const score = alignedIoU(simMask, refMask).aligned;
    const recorded = BASELINE[state].iou;

    if (score < BASELINE[state].floor) {
      regressions.push(`${state}: ${score.toFixed(4)} < floor ${BASELINE[state].floor.toFixed(4)}`);
    } else if (score > recorded + IOU_EPSILON) {
      // Reported, not failed: worth knowing the baseline is stale, not worth breaking the build over.
      gains.push(`${state}: ${score.toFixed(4)} vs recorded ${recorded.toFixed(4)}`);
    }

    // A state that collapses geometrically can still score passably, so guard the coarse shape too.
    expect(inkArea(simMask), `${state} drew nothing`).toBeGreaterThan(0);
    expect(interEyeGap(simMask), `${state} lost one of its eyes`).not.toBeNull();
  }
  await context.close();

  if (gains.length) {
    console.log(
      `${gains.length} state(s) now score above their baseline — re-run \`npm run baseline\` and ` +
      `commit the diff:\n  ${gains.join('\n  ')}`
    );
  }
  expect(regressions, `states regressed below their baseline:\n  ${regressions.join('\n  ')}`).toEqual([]);
});
