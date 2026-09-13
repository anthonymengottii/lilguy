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

// Per-eye HEIGHT against the reference at the same look. Height is the channel that shows whether the
// eyes turn or merely slide: before the coupled turn landed, ours was frozen at 161-162 in every pose
// while the reference ran 147 to 168, and no gate could see it because gaze-sweep collected height
// and threw it away.
//
// 9, sized from measured run-to-run spread rather than from the model's own error. The turn tracks
// the reference to 0-1px on the horizontal looks — [1,0] measures 150/168 and 129/155 against an
// identical reference — so the model is not what sets this number.
//
// The reference's blink is. It runs on a clock inside its WASM that cannot be stopped, and sampling
// it at one fixed gaze gave heights of 167, 166, 165, 164, 143, 45, 26 across consecutive frames.
// captureOpen picks the largest-area frame, which is the right one, but only if the series contains
// an open frame at all — at 1.3s of wall time it sometimes did not, and identical runs disagreed by
// 6-10px. The window is now 2.4s, longer than a blink, which brought the spread to 4-7px; this
// tolerance sits above that with margin. Widening a threshold to swallow noise is the wrong fix and
// was not the fix here — the sampling was.
export const HEIGHT_TOLERANCE = 9;

// How closely the spread of total ink area across a pointer sweep must track the reference's.
//
// This is the one number that distinguishes "the eyes turn" from "the eyes slide", because a pure
// translation conserves area exactly. Ours was 0.04% against the reference's 4-9%; it is now within a
// point of it. The band is wide because the REFERENCE side is noisy: it blinks on a clock inside its
// WASM, and a sweep that happens to catch more closed frames reads a larger spread — repeated runs
// gave 4.07% and 9.33% for the same build. So this gates the failure mode that matters (a spread near
// zero, meaning the turn stopped working) and deliberately does not police the upper end.
export const AREA_SPREAD_MIN = 0.02;
