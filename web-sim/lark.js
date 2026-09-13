// A runtime for the Lark scene/animation format that hesjustalittleguy.com ships as
// anim_data.json + behavior_data.json. Nothing here is a measured constant: every shape, colour,
// timing and transform is read from the data. That is the point — the previous engine
// (lilguy.js) reproduced ONE state by measuring the reference's pixels, so each new state meant
// another measuring pass. This one loads any of the 36 states as data.
//
// FORMAT, as decoded from the shipped files:
//
//   states/<id>/objs/<name>      one node of a scene graph
//       type  "path" | "group"
//       p     24 numbers = 12 points: a CLOSED CUBIC BEZIER with nodes at indices 0,3,6,9 and the
//             last control pair wrapping back to node 0. Verified against the live renderer at
//             99.2% IoU (identical 144x161 bounding boxes) — see scratchpad/pw/path-align.js.
//             Reading these as samples along the outline instead is what made an earlier attempt
//             render a visibly wobbly eye: they are control points, not samples.
//       b     [[minX,minY],[w,h]] — the node's own box. NOT a centre: for pup_l it equals the
//             exact span of the path points. Normalised anchors (anc/piv, in 0..1) resolve
//             against this box.
//       c     fill colour, 6-digit hex without '#'
//       ch    child node names (groups only)
//       z     paint order, ascending
//       ll    [x,y] look limit — how far this node may be driven by the `l` (look) lane
//       lts   [x,y] look-to-scale — DELIBERATELY UNREAD. Applying it as a squash on the pupils and
//             highlights was measured and moved the total-area spread by exactly nothing (16 -> 16),
//             because a pupil is a HOLE clipped to its eye: shrinking a hole changes no ink. What
//             deforms under gaze is the eye outline, which applyTurn handles. Do not re-test this.
//       app/dis  {c,d,t} appear/disappear curve+duration; unused while a state just sits there
//
//   animations/<clip>
//       durationMs, repeat ("l" loop | "n" once), blend, and `lanes` as a FLAT array alternating
//       [ {keypath, object}, [keyframes...] , {keypath, object}, [keyframes...] , ... ]
//       Each keyframe is {t, c, v} where `c` is a curve id and `v` the value; `u: true` means
//       "use the object's original value" (the rest pose) instead of an explicit one.
//
//   keypaths, with the value shape each carries:
//       p     array[28] or u  — a REPLACEMENT path, morphed toward. Note 14 points, where the
//                               rest pose has 12; see morphPath for how that is reconciled.
//       t     [x,y,z] px      — translation
//       s     [sx,sy]         — scale about the node's box centre
//       o     number          — opacity
//       l     [x,y] in -1..1  — look direction, scaled per-node by `ll`
//       r     {anc,ang}       — rotation by `ang` radians about normalised anchor `anc`
//       t3d   {anc,ang,piv}   — a perspective turn; approximated here, see applyT3d
//
// An empty `object` on a lane means the lane drives the whole state (the root).

// ---------------------------------------------------------------------------------------------
// Curves. The ids are indices into a table compiled into the reference's WASM, which is not
// readable, so each is an approximation chosen to match observed motion. Ids seen in the shipped
// clips: 0, 14, 15, 22, 23, 24 (24 is by far the most common).
const CURVES = {
  // Step: the segment HOLDS ITS SOURCE value and only changes when the later keyframe is reached.
  //
  // This file used to read it the other way, as a jump to the target, and that is what made the
  // pupil disappear from an eye that was still visibly open. `blink`'s pupil opacity lane is
  // (150,v=1) -> (233,v=0) -> (300,v=1), and since the curve on the LATER keyframe governs the
  // segment leading into it, target-jump drove opacity to 0 at t=151 and held it there until the
  // t=300 ease brought it back. The eye's closed path does not peak until t=250, so the pupil went
  // out roughly 100ms before the lid arrived and came back as the lid reopened.
  //
  // The measurement that justified target-jump was not imprecise, it had the wrong sign. It argued
  // that source-hold left the closed frame at 24.2% of open area — 8762px against the ~8567px of
  // two pupils — and concluded the pupils never left. But `c: "000000"` is a HOLE punched with
  // destination-out (see drawNode), so a pupil SUBTRACTS from total ink. Total area cannot detect
  // whether a pupil is present, in either direction, and that whole comparison measured nothing.
  //
  // Scope of the correct reading, audited across the shipped data: there are exactly twelve `c:0`
  // keyframes, all of them on `o` lanes on pup_l/pup_r. Eleven are the FIRST keyframe of their
  // lane, where sampleLane returns early on `t <= keys[0].t` and never evaluates a curve. Only
  // `blink`'s second keyframe (t=233, v=0) is a non-first one, and no non-opacity lane anywhere
  // uses `c:0`. So this governs `blink` and nothing else: blink2..blink5 fade on c:24 and are
  // unaffected either way.
  0: () => 0,
  14: (t) => 1 - Math.pow(1 - t, 3),                            // ease-out
  15: (t) => 1 - Math.pow(1 - t, 3),                            // ease-out (path morphs)
  22: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  23: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  24: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2), // ease-in-out
};
// Keyed on presence, not truthiness: `CURVES[c] || CURVES[24]` would send any curve that evaluates
// to a falsy function — or a future entry written as a constant rather than a function — silently to
// the ease-in-out default.
const curveFn = (c) => (c in CURVES ? CURVES[c] : CURVES[24]);

const lerp = (a, b, u) => a + (b - a) * u;

// A node whose colour is exactly this is punched OUT of its group rather than filled. See drawNode.
const HOLE_COLOUR = '000000';

// How much of a node's own box the look lane may move it, per axis, on top of that node's `ll`.
// Measured off the reference rather than guessed — see the note in drawNode.
// Calibrated against the whole drawing's horizontal travel across a full pointer sweep: the
// reference moves 47px, and 0.29 moved 73px here — 55% too far. 0.29 * 47/73 = 0.187. The earlier
// 0.29 came from eye-centre travel measured by flood fill, which merges the two eyes at deflection
// and overstated it; this figure comes from a column scan of the whole drawing instead.
//
// Overshooting here also masked the 3D turn: the per-eye widths were mirroring correctly all
// along, but a slide that large reads as sliding regardless of what the widths do.
// RECALIBRATED to 0.50 against a REAL POINTER, which is the only way this constant means anything.
//
// It was 0.10, fitted by sweeping the look vector over [-1, 1] and matching the drawing's travel to
// the reference's — 23px against 23px, which looked like a clean result and was measuring the wrong
// thing. The reference's own pointer normalisation almost never reaches |look| = 1: it divides by
// min(innerWidth, innerHeight), so at 450px from the canvas centre its look is 0.5, not 1. Sweeping
// a range the reference does not use matched the endpoints of two curves that disagree everywhere in
// between, and in real use the eyes moved 6px where the reference moves 47.
//
// Re-measured by driving both pages with an actual mouse at the same offsets, taking largest-ink
// frames so neither side's blink lands in the sample (px of travel from rest):
//
//     pointer dx    50   100   200   300   450
//     reference      3     7    15    26    47
//     TX = 0.10      1     2     3     4     6
//     TX = 0.30      2     4     8    12    18
//     TX = 0.50      3     7    13    20    30
//
// 0.50 tracks the reference through the range a pointer actually spends its time in and falls short
// only at the far extreme. That shortfall is not travel: the reference's px-per-look-unit RISES from
// 54 near the centre to 94 at the edge, and a translation is linear by construction. The acceleration
// is the eye turning — the drawn extent grows faster than the slide because the far eye lengthens —
// so chasing it with more travel would overshoot the middle to fix the end.
const LOOK_TRAVEL_X = 0.50;
// Same story as the x axis — fitted over a |look| range the reference's normalisation never reaches —
// and re-measured the same way, driving both pages with a real pointer within the viewport (px of
// vertical travel from rest, the reference's box has only 200px of room below it so the sweep stays
// inside +-250):
//
//     pointer dy   -250   -150    -75    +75   +150   +250
//     reference     -17     -9     -4     -7     -3    +17
//     ours at 0.85  -33    -20    -10     -1     +7    +34
//
// Ours moved almost exactly twice as far, so 0.85 / 2. The reference's vertical response is roughly
// a third of its horizontal, which this ratio preserves.
const LOOK_TRAVEL_Y = 0.42;

// The look vector's own limit, matching the reference's `Math.min(magnitude / referenceDistance, 2)`.
// Not 1: the reference genuinely drives the gaze past unity once the pointer is more than one
// window-min away, and capping at 1 put a hard ceiling on how far the drawing could travel.
const LOOK_CAP = 2;

// THE TURN, and the convergence that goes with it.
//
// Both callers scale width. An earlier version skipped it on the look path, believing the group's
// translation already supplied a narrowing of about the right size — but that narrowing was
// columnScan clipping the deflected eye at the canvas midline. Measured as separate ink blobs, the
// widths were frozen at 143 across the whole sweep while the reference's receding eye reached 99.
//
// Height has no such source on either path. Nothing about a translation changes it, which is why it
// sat frozen at 161-162 in every pose while the reference ran 147 to 168.
// Measured across the WHOLE sweep, not just the two ends. An earlier pass fitted these from three
// points near rest and got a linear law; sweeping the reference's pointer all the way out shows the
// turn is strongly non-linear and goes much further than that sample suggested:
//
//     deflection s      0.0    0.2    0.4    0.6    0.8    1.0
//     away eye w      1.000  0.979  0.924  0.847  0.757  0.646
//     away eye h      1.000  1.019  1.031  1.056  1.080  1.099
//     near eye w      1.000  1.063  1.083  1.104  1.111  1.111
//     near eye h      1.000  0.981  0.957  0.951  0.963  1.043
//
// Fitted against the two eyes measured as SEPARATE INK BLOBS rather than by splitting the canvas at
// its midline. That distinction is the whole of this model's history: a per-half column scan clips a
// deflected eye at the split, and every earlier fit here was made against numbers that said the eye
// nearer the pointer narrows. It does not. Measured as blobs, looking right:
//
//     deflection m      0.0     0.4     0.8     1.0
//     LEFT  eye w/h   1.000   1.042   1.028   0.993  /  1.000  1.043  1.080  1.099
//     RIGHT eye w/h   1.000   0.903   0.757   0.688  /  1.000  0.963  0.932  0.920
//
// The eye on the far side of the turn RECEDES and shrinks on both axes; the near one comes forward
// and lengthens. That is ordinary foreshortening, and it is the depth cue the runtime was missing —
// not a coupled narrow-and-tall squash, which is what the clipped measurements made it look like.
//
// It is still not a cosine: a solid rotating to 90 degrees takes the receding eye to zero width, and
// the reference stops at 0.688 of rest, so the pair turns well short of edge-on.
//
// Every fit below is within 0.7% of the measured sweep across its whole range.
const TURN_W_AWAY_1 = -0.2113;
const TURN_W_AWAY_2 = -0.1043;
const TURN_W_NEAR_1 = 0.185;
const TURN_W_NEAR_2 = -0.1908;

const TURN_H_AWAY_1 = -0.1014;
const TURN_H_AWAY_2 = 0.0212;
const TURN_H_NEAR_1 = 0.1107;
const TURN_H_NEAR_2 = -0.0122;

// The pair CONVERGES as it turns: the distance between the eye centres runs 152 at rest down to
// 126.5 at full deflection, a ratio of 0.832. This is the depth cue the runtime never had — the eyes
// only slid apart at a fixed spacing, which reads as two discs sliding rather than a head turning.
// Re-fitted from blob separation for the same reason. The pair holds its spacing at first and then
// contracts sharply — 152, 150, 139.5, 132 — which the negative quadratic carries.
const TURN_GAP_1 = -0.0290;
const TURN_GAP_2 = 0.1615;

// The turn coefficients are per unit of DEFLECTION, where 1 is the reference fully turned, so the
// look has to be scaled onto that range before it drives the turn.
//
// 1 / 0.554: sweeping the reference's pointer to the edge of its window puts its look at 0.554, and
// that is where its eyes reach the end of their swing (away eye 93x178, near 160x169, gap 126.5). An
// earlier 4.5 came from a shorter sample that only reached partial deflection and made the turn
// saturate at a third of the way out, so the eyes hit their limit early and sat there.
const TURN_GAIN = 1 / 0.554;
const clampUnit = (v) => Math.max(-1, Math.min(1, v));

// The vertical look shortens both eyes with no per-eye sign, and asymmetrically: measured as blobs
// against the reference, looking up takes 162 to 158 and looking down to 153. TURN_LIFT_Y carries the
// part that is the same either way, TURN_LIFT_BIAS the extra that only applies looking down.
const TURN_LIFT_Y = 0.0247;
const TURN_LIFT_BIAS = 0.0309;

// rot3d_2 drives the turn at ang = +-0.17 radians, which is the reference's own full-turn amplitude
// for a single eye. Dividing by it puts `ang` and the look vector on one scale, so applyTurn can be
// the single implementation both paths call.
const T3D_ANG_REF = 0.17;
// RESTING CONVERGENCE: there was never anything wrong here, and the "our gap is 168 against the
// reference's 152, the eyes are ~11% larger" finding this comment used to carry was a measurement
// artifact. lark-artifact.html sets the canvas backing store to width="372" but styles it
// max-width:420px, so anything measured through getBoundingClientRect comes back inflated by
// 420/372 = 1.129 — and 168/1.129 = 148.8, against the data's own gap of 151.62 (group_eye_l and
// group_eye_r box centres at x = 124.18 and 275.80 in state 1b).
//
// Measured properly, through the backing store, by tools/harness/gaze-sweep.js: our resting gap is
// 151.5 against the reference's 152.0, with per-eye widths matching to the pixel (144/144, 143/144).
// The runtime applies no global scale and never needed one.
//
// The deflected case is the part that remains open: the reference contracts to 146 at half
// deflection and 136 at full. Pulling each group toward the pair's centre by |look|^2 was tried and
// reverted — it contracted the gap but dragged the pupils with it, giving them a -17px vertical
// offset under a purely horizontal look, which the reference never shows. The contraction belongs to
// the t3d perspective projection applied per group, which applyT3d only approximates; rot3d_2 drives
// t3d on exactly group_eye_l and group_eye_r with mirrored anc [1,0] / [-1,0], which is where to
// verify any real projection. Do not fit a convergence constant into the look path.

// Sample one lane's keyframes at time t. `original` supplies the value for `u: true` frames.
function sampleLane(keys, t, original) {
  const valueAt = (k) => (k.u ? original : k.v !== undefined ? k.v : original);
  if (!keys.length) return original;
  if (t <= keys[0].t) return valueAt(keys[0]);
  const last = keys[keys.length - 1];
  if (t >= last.t) return valueAt(last);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t < a.t || t > b.t) continue;
    if (b.t === a.t) return valueAt(b);
    // The curve on the LATER keyframe governs the segment leading into it.
    const u = curveFn(b.c)((t - a.t) / (b.t - a.t));
    const va = valueAt(a), vb = valueAt(b);
    if (typeof va === 'number' && typeof vb === 'number') return lerp(va, vb, u);
    if (Array.isArray(va) && Array.isArray(vb)) return morphPath(va, vb, u);
    if (va && vb && typeof va === 'object') {
      // r / t3d: interpolate the angle, carry the anchors through.
      return { ...vb, ang: lerp(va.ang || 0, vb.ang || 0, u) };
    }
    return u < 1 ? va : vb;
  }
  return valueAt(last);
}

// Bring any `p` array into the canonical 12-point form: 24 numbers, nodes at indices 0, 3, 6, 9.
//
// State poses already arrive that way (all 166 of them are exactly 24 numbers) and pass through
// untouched. Animation replacement paths arrive as 28 numbers, and their canonical form starts at
// POINT 2, wrapping: points (i + 2) mod 14 for i = 0..11.
//
// The offset is not a guess. There are only two distinct replacement paths in the whole dataset (one
// per eye), reused across all ten `p` keyframes, so all fourteen rotations of each can be scored
// directly. Rasterising each rotation and measuring per-column ribbon thickness — the statistic that
// distinguishes a flat ribbon from a lumpy one of the same extent — gives:
//
//     offset 2  mean 4.71  per-column sd 0.98   <- the reference measures 5.6 / 0.96
//     offset 13 mean 6.84  per-column sd 2.29
//     offset 10 mean 3.52  per-column sd 2.37
//     offset 0  (what this file used to read)   per-column sd 5.50
//
// Offset 2 wins by 2.3x on the deciding statistic and wins IDENTICALLY on both paths. At that offset
// the geometry is visibly flat by construction: indices 2,3,4 are an evenly spaced collinear vertical
// triple and 5,6,7 a collinear horizontal one — straight edges, which is what a closed lid is.
//
// An earlier round of nine readings (14 points as a cubic, as a polyline, as alternating quadratics,
// as Catmull-Rom, nodes-first reordering, and offsets 0/1/2/3) missed this because it rotated the FLAT
// 28-number array — desynchronising x from y — and/or truncated to 12 points before rotating, which
// discards points 12 and 13, the very ones offset 2 needs. Those two points are outline, not the
// "wrap data" this file used to call them.
//
// Doing this in one place fixes two bugs at once, which is why it is not inlined into either caller:
// morphPath pairs arrays index by index, and that pairing is only meaningful once both sides are
// canonical. Before this, a morph paired rest-pose NODES against replacement CONTROL points, so every
// intermediate frame of a blink was wrong even when both endpoints were right. Post-rotation the two
// traversals agree: rest nodes run x = 96.1 (top) -> 189.7 (right) -> 152.1 (bottom) -> 59 (left) and
// the replacement's run 131.5 -> 191.4 -> 131.5 -> 71.6, same order.
const REPLACEMENT_OFFSET = 2;
function normalizePath(p) {
  if (!Array.isArray(p)) return p;
  const n = p.length / 2;
  if (n <= 12) return p;                     // already canonical; identity, not a copy
  const out = new Array(24);
  for (let i = 0; i < 12; i++) {
    const j = (i + REPLACEMENT_OFFSET) % n;
    out[i * 2] = p[j * 2];
    out[i * 2 + 1] = p[j * 2 + 1];
  }
  return out;
}

// Interpolate between two point arrays.
//
// Both sides are normalised first, so a 12-point rest pose and a 14-point replacement are paired
// node-to-node and control-to-control. See normalizePath for why the pairing only holds after that.
//
// An earlier version padded the shorter array by repeating its last control pair to make the
// lengths match. That invented geometry: the repeated points land on top of an existing node and
// drag the closing segment inward as the morph runs.
function morphPath(a, b, u) {
  if (u <= 0) return a;
  if (u >= 1) return b;
  const na = normalizePath(a), nb = normalizePath(b);
  const n = Math.min(24, na.length, nb.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = lerp(na[i], nb[i], u);
  return out;
}

// Trace a `p` array as a closed cubic Bezier: nodes every 3rd point, last control wrapping to
// node 0.
//
// The array is normalised first, so a 14-point replacement path is rotated into its canonical
// 12-point form rather than truncated. Truncating is what this function used to do, and it silently
// discarded the two points that carry the closed lid's straight edges — see normalizePath.
//
// Measure the result with per-column ribbon thickness, never with a bounding box. The previous
// reading matched the reference's closed box to 3px (259x25 against 256x24) and was still wrong: a
// box cannot distinguish the reference's flat 5.6px ribbon from the ~10px lumpy one that reading
// produced. tools/harness/blink-shape.js measures the statistic that can.
function tracePath(ctx, rawP) {
  const p = normalizePath(rawP);
  const n = Math.min(12, Math.floor(p.length / 2));
  if (n < 4) return;
  const X = (i) => p[(i % n) * 2], Y = (i) => p[(i % n) * 2 + 1];
  ctx.moveTo(X(0), Y(0));
  for (let k = 0; k + 3 <= n; k += 3) {
    ctx.bezierCurveTo(X(k + 1), Y(k + 1), X(k + 2), Y(k + 2), X(k + 3), Y(k + 3));
  }
  ctx.closePath();
}

export class LarkRuntime {
  // animData: the parsed anim_data.json. stateId: which of its 36 states to render.
  constructor(animData, stateId = '1b') {
    this.data = animData;
    this.setState(stateId);
    this.active = [];     // running clip instances
    this.look = [0, 0];   // pointer-driven look vector, -1..1 per axis
  }

  setState(stateId) {
    const state = this.data.states[stateId];
    if (!state) throw new Error(`unknown state: ${stateId}`);
    this.stateId = stateId;
    this.state = state;
    this.objs = state.objs;
    this.roots = state.rootObjs || Object.keys(state.objs).filter((k) => !this.parentOf(k));
  }

  parentOf(name) {
    for (const [k, o] of Object.entries(this.objs)) if ((o.ch || []).includes(name)) return k;
    return null;
  }

  // Start a clip by name. Clips of the same category replace each other in the reference's
  // behaviour layer; here the caller decides, and `play` simply adds an instance.
  // Start a clip. Clips belonging to a CATEGORY replace whatever else that category is running:
  // that is what categories are for in behavior_data, and without it instances pile up. A slow
  // pointer drag fired blink_look on nearly every frame, leaving 31 concurrent blink instances
  // aged 6ms to 523ms — and because channelsFor lets the last writer win, the newest one (still at
  // the very start of its clip, eye wide open) overwrote all the others every frame. The result
  // was 31 blinks fired and not one frame of a closed eye.
  play(clipName, now, category = null) {
    const clip = this.data.animations[clipName];
    if (!clip) return null;
    if (category) this.active = this.active.filter((a) => a.category !== category);
    const inst = { clip, name: clipName, start: now, category };
    this.active.push(inst);
    return inst;
  }

  setLook(x, y) { this.look = [x, y]; }

  update(now) {
    this.active = this.active.filter((i) => {
      if (i.clip.repeat === 'l') return true;             // loops never end
      return now - i.start < i.clip.durationMs;
    });
  }

  // Collect every lane value that applies to one object at time `now`, from all running clips.
  channelsFor(name, now) {
    const out = {};
    for (const inst of this.active) {
      const { lanes, durationMs, repeat } = inst.clip;
      let t = now - inst.start;
      if (repeat === 'l') t %= durationMs;
      for (let i = 0; i < lanes.length; i += 2) {
        const head = lanes[i], keys = lanes[i + 1];
        if (!head || head.object !== name) continue;
        const orig = this.originalFor(name, head.keypath);
        out[head.keypath] = sampleLane(keys, t, orig);
      }
    }
    return out;
  }

  // The look vector reaching the nodes. Every clip that drives `l` drives it on the ROOT
  // (object: ""), never on a named node, so it is resolved once here rather than per node —
  // injecting it for any node that asked applied the offset twice, once on the group and once on
  // the eye inside it, measuring as double the reference's travel.
  //
  // Clip and pointer ADD rather than replace: `idle` rocks `l` by +-0.12 forever, so taking the
  // clip's value when present left the pointer permanently suppressed and the gaze dead, while
  // taking the pointer's value would drop the ambient bob. The reference does both at once.
  //
  // The cap is 2, matching the reference's own `Math.min(magnitude / referenceDistance, 2)`. It used
  // to be 1, and with the pointer already saturating four times too early that put a hard ceiling on
  // the whole gaze: the drawing stopped travelling at x0 = 64 no matter how far the pointer went,
  // against the reference's 99. Clamping at 1 also erased the ambient `idle` bob entirely whenever
  // the pointer sat at an extreme, which is exactly when the eyes most looked dead.
  lookFor(now) {
    const clip = this.channelsFor('', now).l || [0, 0];
    const p = this.look;
    return [
      Math.max(-LOOK_CAP, Math.min(LOOK_CAP, clip[0] + p[0])),
      Math.max(-LOOK_CAP, Math.min(LOOK_CAP, clip[1] + p[1])),
    ];
  }

  originalFor(name, keypath) {
    const o = this.objs[name];
    if (keypath === 'p') return o ? o.p : null;
    if (keypath === 's') return [1, 1];
    if (keypath === 't') return [0, 0, 0];
    if (keypath === 'o') return 1;
    if (keypath === 'l') return [0, 0];
    return null;
  }

  // A node's box, used to resolve normalised anchors. It is NOT a clip rectangle — clipping every
  // node to its own `b` was measured across all 36 states and changed nothing, because `b` is just
  // the path's bounding box. See the note in drawNode.
  boxOf(name) {
    const b = this.objs[name].b;
    return { x: b[0][0], y: b[0][1], w: b[1][0], h: b[1][1] };
  }

  // The lid a node is clipped to: the `eye_*` path inside the same group. A node's own eye is its
  // lid, so eye_l and eye_r clip to themselves, which is a no-op and is skipped.
  //
  // The pupil and the highlight paths are SIBLINGS of the eye inside group_eye_*, not its children,
  // so there is no parent relationship to read this from — it has to be looked up by group.
  // `now` matters: during a blink the eye's `p` lane replaces its outline, and the pupil has to be
  // clipped to the CLOSING lid, not to the rest pose. Taking the rest pose here would leave the pupil
  // visible through a shut eye.
  lidFor(name, now) {
    if (/^eye_/.test(name)) return null;
    const parent = this.parentOf(name);
    if (!parent) return null;
    const eye = (this.objs[parent].ch || []).find((c) => /^eye_/.test(c));
    if (!eye) return null;
    return this.channelsFor(eye, now).p || this.objs[eye].p;
  }

  // The turn, as the reference actually renders it.
  //
  // `anc` here is NOT a normalised 0..1 anchor the way `r`'s is — rot3d_2 ships [1,0] on the left
  // group and [-1,0] on the right, alongside mirrored angles (-0.17 and +0.17). It is a signed axis
  // vector, and `-anc[0] * ang` gives both eyes the same sign, which is what makes a turn read as one
  // head rotating rather than two eyes diverging.
  applyT3d(ctx, box, v) {
    const ang = v.ang || 0;
    if (!ang) return;
    const anc = v.anc || [1, 0];
    // Positive s = this eye turning AWAY from the viewer.
    const s = (-(anc[0] || 1) * ang) / T3D_ANG_REF;
    this.applyTurn(ctx, box, s, v.piv);
  }

  // A turn of `s` about the eye's own box, where s = +1 is fully turned away and -1 fully toward.
  //
  // NOT a perspective divide, and that is a measured conclusion rather than a shortcut. The reference
  // turns one eye to 133x168 and the other to 157x156 from a 144x162 rest — the near eye ends up
  // SHORTER than rest. A pinhole projection cannot do that: it magnifies both axes together on the
  // near side, so width and height move the same way. Sweeping 11340 configurations of axis position,
  // angle, focal distance and pivot over the rest ellipse, the number that both widen and shorten is
  // ZERO, and the best fit to the near eye misses by 13.8px with the height inverted (169 where 156 is
  // wanted). Threading such a projection through tracePath would also touch every node in the file,
  // which is the blast radius that broke state 6a in three earlier attempts.
  //
  // What it measures as is a quadratic in the signed deflection, per axis — see the table above the
  // TURN_ constants for the sweep it is fitted to.
  //
  // `lift` is the vertical-look term: a further multiplicative factor on height with no per-eye sign.
  // `scaleWidth` is false on the LOOK path and true on the t3d lane, for a reason that is entirely
  // about where the width comes from. On the look path the group translates, and columnScan's per-half
  // split already turns that translation into an apparent narrowing of very nearly the right size, so
  // scaling on top double-counts. On the t3d lane nothing translates — rot3d_2 turns a group in
  // place — so there the width law is the only thing that can narrow the eye at all.
  applyTurn(ctx, box, s, piv, lift = 1, scaleWidth = true) {
    if (!s && lift === 1) return;
    const u = clampUnit(s);
    const p = piv || [0.5, 0.5];
    const cx = box.x + box.w / 2;
    // Height grows about the pivot's edge rather than the centre, so a turning eye keeps its footing
    // instead of stretching symmetrically out of the socket.
    const py = box.y + (p[1] || 0) * box.h;

    // Every law is fitted against deflection as a POSITIVE magnitude, with a separate pair of
    // coefficients per sign, so the branch picks the pair and `m` supplies the magnitude. Feeding the
    // signed u into a fit made for magnitudes flips it: at u = -1 the height law yielded 1.486 where
    // the reference measures 1.043, and the near eye rendered 240px tall against 169.
    const m = Math.abs(u);
    const away = u >= 0;
    const w = !scaleWidth ? 1
      : away ? 1 + TURN_W_AWAY_1 * m + TURN_W_AWAY_2 * m * m
             : 1 + TURN_W_NEAR_1 * m + TURN_W_NEAR_2 * m * m;
    const h = away
      ? 1 + TURN_H_AWAY_1 * m + TURN_H_AWAY_2 * m * m
      : 1 + TURN_H_NEAR_1 * m + TURN_H_NEAR_2 * m * m;

    // Clamped so that editing a coefficient can never reproduce the collapse a per-node scale once
    // caused (6a's drawn area fell 21363 -> 2400). The fitted range bottoms out at 0.646.
    const sx = Math.max(0.5, w);
    const sy = Math.max(0.5, h * lift);
    ctx.translate(cx, py);
    ctx.scale(sx, sy);
    ctx.translate(-cx, -py);
  }

  // The x of the pair's centre, for deciding which side of it a group sits on. Derived from the
  // state's own geometry rather than from node names, so a state that lays its eyes out differently
  // still turns the right way.
  pairCentreX() {
    if (this._pairCx !== undefined && this._pairCxState === this.stateId) return this._pairCx;
    let min = Infinity, max = -Infinity;
    for (const o of Object.values(this.objs)) {
      if (!o.b) continue;
      min = Math.min(min, o.b[0][0]);
      max = Math.max(max, o.b[0][0] + o.b[1][0]);
    }
    this._pairCxState = this.stateId;
    this._pairCx = (min + max) / 2;
    return this._pairCx;
  }

  drawNode(ctx, name, now, inheritedAlpha = 1) {
    const o = this.objs[name];
    if (!o) return;
    const ch = this.channelsFor(name, now);
    const box = this.boxOf(name);

    const alpha = inheritedAlpha * (ch.o !== undefined ? ch.o : 1);
    if (alpha <= 0.001) return;

    ctx.save();

    // Translation, in plain pixels.
    if (ch.t) ctx.translate(ch.t[0] || 0, ch.t[1] || 0);

    // LOOK. `l` is always driven on the root, and each node consumes it through its own `ll`
    // (travel limit) or `lts` (look-to-scale).
    //
    // The scale factors are calibrated against the reference, driven through a pointer grid
    // (scratchpad/pw/lark-gaze.js): its eye centres travel 66px horizontally and ~50px vertically
    // end to end. With ll = [0.8, 0.9] on a 142x161 box that gives 33/(0.8*142) = 0.29 and
    // 25/(0.9*161) = 0.17. An earlier guess of 0.5 on both axes overshot to 123px and 157px.
    const look = this.lookFor(now);
    if (look[0] || look[1]) {
      // Translate the GROUP, using the `ll` of the eye inside it, so the eye and its pupil travel
      // together. `ll` sits on eye_l/eye_r, but the pupil is their SIBLING inside group_eye_*, not
      // their child — so moving the eye node alone left the pupil behind, and their changing
      // relative offset read as the pupil sliding around inside the socket. Measured on the
      // reference, the pupil barely moves within its eye at all: 4px horizontally and 7px
      // vertically across a full pointer sweep, against 55px and 56px here before this fix. It
      // follows the cursor because the whole eye travels, not under its own steam.
      const llSource = o.ll ? o : (o.ch || []).map((c) => this.objs[c]).find((c) => c && c.ll);
      if (llSource && !o.ll) {
        ctx.translate(look[0] * llSource.ll[0] * box.w * LOOK_TRAVEL_X,
                      look[1] * llSource.ll[1] * box.h * LOOK_TRAVEL_Y);
      }
      // THE TURN. This used to say the per-eye turn "needs no extra code", on the grounds that
      // translating the group inside a fixed root already produced mirrored widths. That was wrong,
      // and the widths it cited were an artifact of the instrument: columnScan splits at the canvas
      // midline, so a translating eye gets clipped by the split and appears to change width. The
      // geometry underneath never changed at all. The tell is that our height was frozen at 161-162
      // in every pose while the reference ran 147 to 168, and our total ink area varied 0.04% against
      // the reference's 5.8% — area conservation is the signature of pure translation.
      //
      // A real turn is not optional for the look to read as a gaze rather than a slide, so the same
      // applyTurn the t3d lane uses is driven here from the look vector. Positive s is the eye
      // turning AWAY, which for a rightward look is the LEFT eye, so the sign comes from which side
      // of the pair this group sits on — read from its own box, not from its name.
      //
      // Three earlier attempts to force this with per-node scales were measured and reverted, kept
      // here so they are not retried: squashing each eye about its centre, squashing about its
      // outer edge, and scaling the pupil by `lts`. All broke states with other geometry (6a's
      // drawn area fell from 21363 to 2400). This differs in the way that matters: it is applied at
      // exactly ONE level of the tree — the same `llSource && !o.ll` guard that selects the two eye
      // groups and nothing else — so the factor cannot compound down a chain, and applyTurn clamps.
      //
      // `lts` stays unread, deliberately. It was measured as a squash on the pupils and highlights
      // and moved the total-area spread by exactly nothing (16 -> 16), because the pupil is a hole
      // clipped to the eye: shrinking a hole changes no ink. The variation lives in the eye outline.
      if (llSource && !o.ll) {
        // Which eye RECEDES. Looking right, the head turns right, so the eye on the RIGHT goes away
        // from the viewer and the left one comes forward — measured as blobs, the right eye shrinks to
        // 0.688 of its width while the left lengthens to 1.099 of its height. An earlier version had
        // this backwards, from per-half measurements that clipped the deflected eye at the midline.
        const side = box.x + box.w / 2 > this.pairCentreX() ? 1 : -1;
        // TURN_GAIN puts the turn on the same scale as the travel. The turn coefficients were fitted
        // against per-eye boxes at the reference's own full deflection, which its pointer reaches at a
        // look of about 0.22 — not 1 — so feeding the raw look here left the eyes turning about a
        // fifth as much as they should, and the area spread that proves they turn at all fell from
        // 3.94% to 0.89%. One constant drives both, so a future change to one cannot silently leave
        // the slide and the turn disagreeing.
        const away = clampUnit(side * look[0] * TURN_GAIN);
        // The vertical look shortens both eyes with no per-eye sign, and more when looking down.
        const ly = clampUnit(look[1] * TURN_GAIN);
        const lift = 1 - TURN_LIFT_Y * Math.abs(ly) - TURN_LIFT_BIAS * Math.max(0, -ly);

        // CONVERGENCE — the depth cue. As the pair turns, the distance between the eye centres
        // contracts: 152 at rest down to 126.5 at full deflection, measured by sweeping the
        // reference's pointer right out to the edge of its window. Without it the two eyes keep a
        // fixed spacing however far they swing, which is what reads as two discs sliding across a
        // surface rather than a head turning to look at you.
        //
        // Pulling toward the pair's centre was tried once before and reverted because it dragged the
        // pupils with it, giving them -17px of vertical offset under a purely horizontal look. It does
        // not here, because the pull is horizontal only and is applied to the same group the eye and
        // its pupil both sit inside, so they travel together and their relative offset never changes.
        // scaleWidth = true. It was false, on the grounds that the group's translation already
        // supplied the width change — but that "width change" was columnScan clipping a deflected eye
        // at the canvas midline, not geometry. Measured as separate blobs the widths sat frozen at
        // 143 through the whole sweep while the reference's receding eye went to 99.
        this.applyTurn(ctx, box, away, [0.5, 1], lift, true);

        const mag = Math.abs(clampUnit(look[0] * TURN_GAIN));
        const pull = TURN_GAP_1 * mag + TURN_GAP_2 * mag * mag;
        ctx.translate((this.pairCentreX() - (box.x + box.w / 2)) * pull, 0);
      }
    }

    // Scale about the box centre.
    if (ch.s) {
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
      ctx.translate(cx, cy);
      ctx.scale(ch.s[0], ch.s[1]);
      ctx.translate(-cx, -cy);
    }

    // Rotation about a normalised anchor.
    if (ch.r && ch.r.ang) {
      const anc = ch.r.anc || [0.5, 0.5];
      const ax = box.x + anc[0] * box.w, ay = box.y + anc[1] * box.h;
      ctx.translate(ax, ay);
      ctx.rotate(ch.r.ang);
      ctx.translate(-ax, -ay);
    }

    if (ch.t3d) this.applyT3d(ctx, box, ch.t3d);

    if (o.type === 'group') {
      // Children paint in ascending z.
      const kids = (o.ch || []).slice().sort((a, b) => (this.objs[a]?.z ?? 0) - (this.objs[b]?.z ?? 0));
      for (const k of kids) this.drawNode(ctx, k, now, alpha);
    } else {
      // `ul: true` — "use lid", on every node in every state — means a path is clipped to its
      // SIBLING EYE's outline. The eye itself is the lid: in the half-lidded states its path is a
      // shallow crescent, and anything inside the group (pupil, highlights) is cut to it.
      //
      // Measured three readings against the reference across the eight states that span the range
      // (aligned IoU, so the reference's constant 2-5px vertical placement offset is out of it):
      //
      //   state   no clip   clipped to own `b`   clipped to the eye's path
      //   6e       0.427          0.427                   0.663
      //   6b       0.638          0.638                   0.760
      //   6d       0.658          0.658                   0.710
      //   3e       0.584          0.584                   0.632
      //   1b       0.994          0.994                   0.994
      //   5a       0.997          0.997                   0.997
      //
      // So `b` is NOT a clip rectangle — clipping to it changes nothing anywhere, because it is the
      // path's own bounding box (plus, on groups, the union of the children's). It stays what it was:
      // the box that normalised anchors resolve against. The eye's path is the clip, and it only bites
      // where the pupil would otherwise escape a half-closed lid, which is why the states that already
      // matched are untouched.
      // `c: "000000"` is not the colour black — it is a HOLE. The node is punched out of whatever its
      // group has already painted, so the page background shows through.
      //
      // Reading it as a black fill is what held two thirds of the states back, and it hid behind the
      // fact that the reference's own page background is #111: a black pupil on a near-black ground
      // looks right to the eye and is only wrong to a measurement. The residual told the real story —
      // our extra ink formed a ring, and "reference draws what we do not" was 140px out of 14345, so
      // the outer silhouette was already correct and only the middle was filled in wrongly.
      //
      // Aligned IoU, black-as-fill against black-as-hole:
      //
      //   6e 0.664 -> 0.918     1e 0.593 -> 0.912     3e 0.632 -> 0.934
      //   6b 0.756 -> 0.934     6d 0.714 -> 0.930     5d 0.800 -> 0.942
      //   1d 0.840 -> 0.956     5c 0.847 -> 0.951
      //
      // and the states with a coloured pupil (1b, 5a, 6f, 2e) are bit-identical either way, because
      // the rule never fires for them. Every state whose pupil is "000000" was in the failing set and
      // no state with a coloured pupil was — 1a/3a/4a are the exceptions that prove it, scoring ~0.98
      // with a black pupil simply because theirs is small enough not to matter much.
      const p = ch.p || o.p;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = `#${o.c}`;
      const lid = o.ul ? this.lidFor(name, now) : null;
      if (lid) {
        ctx.beginPath();
        tracePath(ctx, lid);
        ctx.clip();
      }
      if (o.c === HOLE_COLOUR) ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      tracePath(ctx, p);
      ctx.fill();
    }

    ctx.restore();
  }

  draw(ctx, now, { width = 400, height = 400, background = null } = {}) {
    this.update(now);
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);
    }
    const roots = this.roots.slice().sort((a, b) => (this.objs[a]?.z ?? 0) - (this.objs[b]?.z ?? 0));
    for (const r of roots) this.drawNode(ctx, r, now);
  }
}

export { tracePath, sampleLane, morphPath, normalizePath, CURVES, REPLACEMENT_OFFSET };
