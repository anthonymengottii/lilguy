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
//       lts   [x,y] look-to-scale — squash applied to this node as it looks away
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
  // Step: the segment jumps to its TARGET value immediately and holds it. Used only on opacity.
  // Holding the SOURCE value instead makes the pupil's invisible window infinitely narrow — in
  // `blink` the lane is (150,v=1) -> (233,v=0) -> (300,v=1), so source-hold means opacity is 1
  // right up to t=233 and already climbing again at t=234. A full sweep showed exactly that: our
  // closed frame floored at 24.2% of open area, which is 8762px against the ~8567px of two
  // pupils — the eye shut correctly and the pupils never left. The reference stays under 8% for
  // ~150ms. In blink2..blink5 the c:0 keyframe carries v=1 and the fade to 0 runs on c:24, so
  // both readings agree there and only `blink` distinguishes them.
  0: () => 1,
  14: (t) => 1 - Math.pow(1 - t, 3),                            // ease-out
  15: (t) => 1 - Math.pow(1 - t, 3),                            // ease-out (path morphs)
  22: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  23: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  24: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2), // ease-in-out
};
const curveFn = (c) => CURVES[c] || CURVES[24];

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
// RECALIBRATED to 0.10 after the lid-clip and hole fixes. 0.187 was fitted when a black pupil was
// still being filled rather than punched out, so "the drawing" whose travel was being matched was a
// different shape than the reference's — and the constant absorbed that difference. Swept against the
// reference's own per-eye widths at five pointer positions, summed absolute width error:
//
//     travelX   0.187   0.14   0.12   0.10   0.09   0.08
//     err @0.5     10      4      2      0      1     11
//     err @1.0     20      8      6      6      6      5
//
// 0.10 is the first value that matches half deflection exactly and it holds the extreme; below 0.08
// the eyes stop moving enough and half deflection breaks outright. End-to-end travel also comes down
// from 43px to near the reference's 23px.
const LOOK_TRAVEL_X = 0.10;
const LOOK_TRAVEL_Y = 0.17;
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
  lookFor(now) {
    const clip = this.channelsFor('', now).l || [0, 0];
    const p = this.look;
    return [
      Math.max(-1, Math.min(1, clip[0] + p[0])),
      Math.max(-1, Math.min(1, clip[1] + p[1])),
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

  // rot3d: the engine does a true perspective transform. Without its projection maths, a turn away
  // from the viewer is approximated as a rotation about `piv` plus a width squash proportional to
  // sin(ang) — a sphere turning away is what the effect reads as on screen.
  applyT3d(ctx, box, v) {
    const ang = v.ang || 0;
    if (!ang) return;
    const piv = v.piv || [0.5, 0.5];
    const px = box.x + piv[0] * box.w, py = box.y + piv[1] * box.h;
    ctx.translate(px, py);
    ctx.scale(Math.max(0.05, 1 - Math.abs(Math.sin(ang)) * 0.5), 1);
    ctx.rotate(ang);
    ctx.translate(-px, -py);
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
      // The per-eye turn needs no extra code: translating the group inside a fixed root already
      // produces it. Measured by column scan (scratchpad/pw/turn-geometry.js), widths mirror
      // across a sweep — 160->112 on one eye while the other goes 112->159, against the
      // reference's 144->112 and 144->159 — and the pupil's position across its eye tracks too.
      //
      // Three earlier attempts to force this with per-node scales were measured and reverted, kept
      // here so they are not retried: squashing each eye about its centre, squashing about its
      // outer edge, and scaling the pupil by `lts`. All broke states with other geometry (6a's
      // drawn area fell from 21363 to 2400), and none was needed.
      //
      // STILL MISSING: the pair's perspective under DEFLECTION. At rest we now measure 151.5
      // against the reference's 152.0 (the old 164/168 figures were CSS-pixel readings — see the
      // note above LOOK_TRAVEL_X), but the reference contracts to 146 at half deflection and 136 at
      // full, and ours does not contract. That belongs to the t3d projection applied to the group,
      // which applyT3d only approximates.
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
