// The 3D turn, checked where the data gives us ground truth.
//
//   node tools/harness/t3d-probe.js
//
// rot3d_2 drives t3d on exactly group_eye_l and group_eye_r, with mirrored anc [1,0] / [-1,0] and
// piv [0,1]. That makes it the one place a perspective projection can be validated without guessing:
// whatever the projection is, the two eyes must come out mirrored, and the reference renders the same
// clip for comparison.
//
// applyT3d currently fakes the projection as a 1-axis squash by |sin(ang)| and never reads `anc` at
// all. This harness exists to say whether that matters, and by how much.
import process from 'node:process';
import { launch, openSim, openReference } from '../lib/pages.js';
import { inkMask, columnScan, interEyeGap } from '../lib/measure.js';

// rot3d_2 drives t3d on the two GROUPS with mirrored anchors, so its two eyes must stay reflections
// of each other and |widthL - widthR| is a real check. rot3d_1 drives t3d on the ROOT instead — one
// turn applied to the whole pair — so its eyes are supposed to diverge, and a mirror check there
// measures nothing. Only rot3d_2 is gated.
const CLIPS = {
  rot3d_2: { dur: 1200, mirrored: true },
  rot3d_1: { dur: 1917, mirrored: false },
};

import { MIRROR_TOLERANCE } from '../lib/thresholds.js';

async function main() {
  const { browser, context } = await launch();
  try {
    const sim = await openSim(context, { state: '1b' });
    for (const [clip, { dur, mirrored }] of Object.entries(CLIPS)) {
      console.log(`\n=== ${clip} (${dur}ms, ${mirrored ? 'mirrored — gated' : 'root turn — informational'}) ===`);
      console.log('  t      widthL  widthR  gap     mirror err');
      let worst = 0;
      const steps = 9;
      for (let i = 0; i <= steps; i++) {
        const t = Math.round((dur * i) / steps);
        await sim.clear();
        await sim.play(clip, 0, 'rot');
        await sim.render(t, [0, 0]);
        const mask = inkMask(await sim.capture());
        const l = columnScan(mask, 'l'), r = columnScan(mask, 'r');
        const g = interEyeGap(mask);
        // Mirror symmetry: at any instant the two eyes should be each other's reflection, because the
        // clip's anchors are mirrored. A non-zero value here is the projection failing to mirror.
        const err = Math.abs(l.width - r.width);
        worst = Math.max(worst, err);
        console.log(
          `  ${String(t).padStart(5)}  ${String(l.width).padStart(6)}  ${String(r.width).padStart(6)}` +
          `  ${String(g ? g.gap : '—').padStart(6)}  ${err.toFixed(1)}`
        );
      }
      console.log(
        mirrored
          ? `  worst mirror error: ${worst.toFixed(1)}px (tolerance ${MIRROR_TOLERANCE}) -> ${worst <= MIRROR_TOLERANCE ? 'PASS' : 'FAIL'}`
          : `  widths diverge by up to ${worst.toFixed(1)}px, as a root turn should — not a gate`
      );
    }

    // The reference running the same clip, for scale. Its behaviour layer fires rot3d on its own
    // interval, so rather than trying to trigger it, sample a long window and report the extremes
    // the widths actually reach. Milliseconds, not sample counts.
    console.log('\n=== reference, widths observed over 6s of its own behaviour ===');
    const ref = await openReference(context, { state: '1b' });
    await ref.look(0, 0);
    let minW = Infinity, maxW = -Infinity, minGap = Infinity, maxGap = -Infinity;
    for (let i = 0; i < 60; i++) {
      const mask = inkMask(await ref.capture());
      const l = columnScan(mask, 'l');
      const g = interEyeGap(mask);
      if (l.width > 0) { minW = Math.min(minW, l.width); maxW = Math.max(maxW, l.width); }
      if (g) { minGap = Math.min(minGap, g.gap); maxGap = Math.max(maxGap, g.gap); }
      await ref.page.waitForTimeout(100);
    }
    console.log(`  left eye width ${minW}..${maxW}   inter-eye gap ${minGap}..${maxGap}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
