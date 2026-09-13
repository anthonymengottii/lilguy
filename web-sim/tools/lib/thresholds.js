// Acceptance thresholds, in one place so a harness and the test that gates on it cannot disagree.
// They live here rather than in the harness files because importing a harness would run its main().

// How far below its recorded figure a state may score before the gate calls it a regression.
//
// Sized from measured noise, not picked. Our own rendering is deterministic — a given state's ink area
// is identical every run — so all the variance is on the reference side: its blink runs on a clock
// inside the WASM that cannot be stopped, and captureOpen samples a finite window of it. Over five
// full runs of ten states the worst spread was 0.0061 (2a and 6e; 6d moved only 0.0017):
//
//     2a  0.9786 .. 0.9847      6e  0.9163 .. 0.9223      1e  0.9097 .. 0.9127
//
// 0.02 is a bit over 3x that, which leaves room for a slower machine catching fewer frames while still
// failing on any real change — the fixes in this session moved states by 0.05 to 0.49.
//
// The gate is DELIBERATELY one-sided. An earlier version also failed when a state scored ABOVE its
// baseline, the idea being that an accepted improvement should be a reviewed commit rather than silent
// drift. In practice that made the suite intermittent: the baseline is recorded at one point in a
// ~0.006 noise band, so a later run landing at the top of the same band trips the upper bound with
// nothing having changed. A gate that fails at random gets switched off, which costs far more than the
// drift it was guarding against — and an improvement is not a defect. Real gains show up in
// `npm run measure:iou`, and `npm run baseline` records them.
export const IOU_EPSILON = 0.02;

// The closed blink, measured as a ribbon. The reference's own closed frame, measured live by
// tools/harness/blink-shape.js, is mean 5.51px with a per-column standard deviation of 1.02.
// Per-column sd is the statistic that matters: a bounding box cannot tell a flat ribbon from a lumpy
// one of the same extent, which is how a wrong reading once passed review.
export const RIBBON_MEAN_RANGE = [4.0, 6.5];
export const RIBBON_SD_MAX = 1.1;

// Inter-eye centre distance, against the reference at the same look. The reference runs 152 at rest
// and contracts to ~144.5 at full deflection, reaching 137 under its own rot3d clips.
export const GAP_TOLERANCE = 4;

// |widthL - widthR| while a clip with mirrored anchors runs (rot3d_2). A root turn (rot3d_1) is
// supposed to diverge and is not gated.
export const MIRROR_TOLERANCE = 2;
