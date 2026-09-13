// The closed-blink silhouette, measured as a ribbon.
//
//   node tools/harness/blink-shape.js              measure ours against the reference
//   node tools/harness/blink-shape.js --write      also write tools/baseline/blink.json
//   node tools/harness/blink-shape.js --offsets    score all 14 rotations of the replacement path
//
// THE STATISTIC THAT MATTERS is per-column standard deviation of thickness, not the bounding box.
// A bbox cannot tell a flat ribbon from a lumpy one of the same extent, and that is exactly how an
// earlier reading passed review: it reproduced the reference's closed box to 3px (259x25 against
// 256x24) while leaving a ~10px irregular ribbon where the reference has a flat ~5.4px one.
//
// Measured live off the reference by this harness: mean thickness 5.6px, per-column sd 0.96.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { launch, openSim, openReference } from '../lib/pages.js';
import { inkMask, columnScan, inkArea, bbox } from '../lib/measure.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.join(HERE, '..', 'baseline', 'blink.json');

import { RIBBON_MEAN_RANGE, RIBBON_SD_MAX } from '../lib/thresholds.js';

// `blink` holds its closed pose around t=250: the p lane's replacement keyframe sits there, and the
// opacity lane runs (150, v=1) -> (233, v=0) -> (300, v=1), so the pupil is gone across that window.
const SAMPLE_MS = [200, 233, 250, 266, 283];

function ribbon(mask) {
  // Scan each half separately. At the closed pose the two ribbons are ~9px apart vertically-thin
  // shapes; a scan across the midline would join them and the thickness statistics would be of one
  // fused blob. This is the flood-fill lesson in its sharpest form.
  const l = columnScan(mask, 'l');
  const r = columnScan(mask, 'r');
  return {
    left: { meanThickness: l.meanThickness, colSd: l.colSd, width: l.width, height: l.height },
    right: { meanThickness: r.meanThickness, colSd: r.colSd, width: r.width, height: r.height },
    area: inkArea(mask),
    bbox: bbox(mask),
  };
}

// The reference's own closed frame: sample until the ink area bottoms out. Minimum area is the
// closed eye by construction, the mirror of captureOpen's maximum.
async function referenceClosed(ref, { samples = 90, everyMs = 40 } = {}) {
  let best = null, bestArea = Infinity;
  for (let i = 0; i < samples; i++) {
    const shot = await ref.capture();
    const mask = inkMask(shot);
    const area = inkArea(mask);
    if (area < bestArea) { bestArea = area; best = mask; }
    if (i < samples - 1) await ref.page.waitForTimeout(everyMs);
  }
  return best;
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes('--write');
  const { browser, context } = await launch();
  const out = { reference: null, sim: {} };
  try {
    // --- reference ---
    const ref = await openReference(context, { state: '1b' });
    await ref.look(0, 0);
    const refClosed = await referenceClosed(ref);
    out.reference = ribbon(refClosed);
    console.log('reference closed frame:');
    console.log(`  left  mean ${out.reference.left.meanThickness}  sd ${out.reference.left.colSd}  h ${out.reference.left.height}`);
    console.log(`  right mean ${out.reference.right.meanThickness}  sd ${out.reference.right.colSd}  h ${out.reference.right.height}`);
    await ref.page.close();

    // --- ours, across the blink clips ---
    const sim = await openSim(context, { state: '1b' });
    for (const clip of ['blink', 'blink2', 'blink3', 'blink5']) {
      out.sim[clip] = [];
      for (const t of SAMPLE_MS) {
        await sim.clear();
        await sim.play(clip, 0, 'blink');
        await sim.render(t, [0, 0]);
        const mask = inkMask(await sim.capture());
        const r = ribbon(mask);
        out.sim[clip].push({ t, ...r });
      }
      // The closed frame is the minimum-area sample.
      const closed = out.sim[clip].reduce((a, b) => (b.area < a.area ? b : a));
      console.log(
        `${clip} closed @t=${closed.t}:  left mean ${closed.left.meanThickness} sd ${closed.left.colSd} h ${closed.left.height}` +
        ` | right mean ${closed.right.meanThickness} sd ${closed.right.colSd} h ${closed.right.height}`
      );
    }
  } finally {
    await browser.close();
  }

  // Verdict against the reference.
  const blink = out.sim.blink;
  if (blink) {
    const closed = blink.reduce((a, b) => (b.area < a.area ? b : a));
    const ok = ['left', 'right'].every((side) => {
      const s = closed[side];
      return s.meanThickness >= RIBBON_MEAN_RANGE[0] && s.meanThickness <= RIBBON_MEAN_RANGE[1] && s.colSd <= RIBBON_SD_MAX;
    });
    console.log(`\nverdict: ${ok ? 'PASS' : 'FAIL'} (want mean ${RIBBON_MEAN_RANGE.join('-')}, sd <= ${RIBBON_SD_MAX})`);
  }

  if (write) {
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n');
    console.log(`wrote ${BASELINE}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
