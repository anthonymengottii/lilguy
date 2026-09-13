// "LilGuy" mode — a reimplementation of the eyes from hesjustalittleguy.com, matched against the
// real thing rather than eyeballed. That site renders through a compiled WASM engine driven by two
// JSON data files (github.com/seojoonkim/lilguy-fork), so there is no render loop to port; instead
// the original was run headless (Playwright), driven through a grid of cursor positions, and its
// canvas read back pixel by pixel. Every constant below comes from those measurements — see
// scratchpad/pw/map-gaze.js for the harness. Notable findings the numbers overturned:
//   - the eyes are ellipses taller than they are wide, upright, with no tilt
//   - horizontal gaze is a 3D turn: the eye on the cursor's side narrows and travels less, the far
//     one keeps its width and travels further
//   - vertical gaze is asymmetric too: looking up lifts AND flattens both eyes, looking down
//     barely moves them
//   - the blink is far faster than the source JSON's nominal 783ms clip and never fully seals

export const LILGUY_SKINS = {
  // Sampled straight off the real renderer's framebuffer (Playwright + getImageData), not from the
  // JSON's nominal hex — the WASM's own RGB565 round-trip shifts them slightly.
  teal: { eye: 'rgb(101,244,205)', pupil: 'rgb(0,106,72)' },   // state 1b, the site's hero/default
  gold: { eye: '#F7EB7A', pupil: '#A91A08' },                  // state 2b
  purple: { eye: '#7B43F5', pupil: '#F6BD49' },                // state 6a
  mono: { eye: '#FFFFFF', pupil: '#000000' },                  // state 1a
};

// All geometry below was MEASURED off the real WASM renderer by driving it in a headless browser
// and reading back the canvas pixels (scratchpad/pw/map-gaze.js), then scaled from its 400x400
// canvas into our 240x240 one (factor 0.6). Numbers in the comments are the raw 400-space values.
const REF_SCALE = 0.6;
const EYE_RX = (141 / 2) * REF_SCALE;   // eye ~141 wide at rest
const EYE_RY = (158 / 2) * REF_SCALE;   // eye ~158 tall at rest (taller than wide, ratio ~0.89)
const PUPIL_R = (73 / 2) * REF_SCALE;   // pupil ~73 across, ~0.516 of the eye's width (measured both rigs)
// The pupils do NOT sit centered at rest: with the pointer centered, both reference rigs place them
// ~23px (in 400-space) toward the midline — the left eye's pupil pushed right, the right eye's
// pushed left. Measured as an absolute offset, applied here in our own canvas scale.
const PUPIL_INWARD_PX = 23 * REF_SCALE;
// The pupil foreshortens with the eye, but LESS than the outline does: the eye's own width drops
// ~27% at full deflection while the pupil measures ~19% (73 -> 59 looking left, 73 -> 62 right).
// Reusing the outline's factor squashed ours to 52 and read as too flat.
const PUPIL_SQUASH = 0.19;
// The pupil barely slides INSIDE its eye on the reference — at full deflection its offset stays
// near the resting ~22px on both axes, because the eyeball itself does the travelling. Ours was
// swinging ~30px vertically and 10..32 horizontally, so both axes are scaled down here.
const PUPIL_VERTICAL_TRAVEL = 0.12;
const PUPIL_HORIZONTAL_TRAVEL = 0.12;
const EYE_GAP = 151 * REF_SCALE;        // ~151 between eye centers
const PUPIL_MARGIN = 2;
// The eyes ARE slanted, mirrored into a shallow "V". Bounding boxes hide this entirely, and image
// moments can't recover it either: the blobs are nearly round (ratio ~0.86), so the principal axis
// is numerically unstable and antialiasing noise swamps the angle. It only shows up by fitting a
// line through each row's horizontal midpoint, which is stable — that reads -3.5deg / +5.0deg on
// the reference with the pointer centered.
//
// The constant is larger than that because the reading is not the ellipse's rotation: on a nearly
// round ellipse most of a rotation cancels out, and our canvas is smaller than the reference's, so
// fewer pixels carry it. A sweep (scratchpad/pw/calibrate-slant.js) measured the actual transfer
// as ~0.21deg of reading per degree set, putting the reference's ~4.25deg at this value.
const EYE_SLANT_DEG = 21;

// Gaze response, measured per-direction with the pointer returned to center between probes and
// blink frames discarded (scratchpad/pw/clean-ref.js). Two behaviours neither the JSON nor a
// casual look reveals:
//   Horizontal is a 3D turn — the eye on the cursor's side narrows ~38/141 and travels ~31, while
//   the far eye keeps its width and travels further, ~48.
//   Vertical is NOT symmetric: looking up lifts the eyes ~32/~22 AND flattens both (~18 shorter),
//   while looking down barely moves them at all.
const GAZE_X_FAR_SHIFT = 48 * REF_SCALE;   // far eye's center travel at full deflection
const GAZE_X_NEAR_SHIFT = 31 * REF_SCALE;  // near eye's center travel
const GAZE_X_NEAR_SQUASH = 38 / 141;       // near eye narrows by ~38px of its ~141 width
const GAZE_X_FAR_GROW = 0.02;              // far eye's width is essentially unchanged
// A full sweep of the vertical axis (scratchpad/pw/sweep-vertical.js) corrected two things an
// earlier two-point probe got wrong: looking down travels just as far as looking up (~32px each
// way, not the ~4px that probe suggested), and BOTH directions flatten the eyes — down actually
// flattens hardest, to ~145 of the resting ~159.
const GAZE_UP_SHIFT = 36 * REF_SCALE;
const GAZE_DOWN_SHIFT = 41 * REF_SCALE;
// Both directions track the pointer proportionally. Two earlier attempts to curve this failed and
// are worth recording so they aren't retried: a first sweep suggested a sharp response near center
// in both directions, but that was the idle bob leaking into short samples (it produced
// non-monotonic data — the eye sitting HIGHER at a less extreme position, which is impossible).
// Averaging each position over a full idle cycle cleaned that up and left an apparent downward
// lag, fitted at p=1.3; applying it overshot, and re-measuring showed the reference itself moving
// between runs by about as much as the correction (0.59 -> 0.76 at the same point). That residual
// is measurement noise, not shape, so the response stays linear.
const GAZE_DOWN_CURVE = 1;
const GAZE_UP_FLATTEN = 12 / 158;          // ~147 tall at the top of the sweep
const GAZE_DOWN_FLATTEN = 14 / 158;        // ~145 tall at the bottom

// Three authored blinks, picked at random with equal weight (behavior rule "blink_ambient"). They
// all shut at the same speed — the lid reaches full coverage at 250ms in every one — and differ in
// how long they HOLD shut and how slowly they reopen. Earlier this was one hand-timed 120/180ms
// curve, which made every blink identical and far too quick; a high-rate capture of the reference
// showed events lasting ~340ms with a visible plateau at the bottom.
//
// Peak coverage stays at 0.87: the reference bottoms out at ~13% of open height, never a full seal.
const BLINK_MAX_COVERAGE = 0.87;
// `ease` is parallel to the segments (one shorter than keys). The shut is easeOut — a real blink is
// ballistic on the way down, and the reference's capture bears that out (0.78 0.67 0.52 0.40 0.31
// 0.26 0.20 in seven samples). A global easeInOut eased INTO the fall and took about twice as long
// to reach the bottom. The reopen is linear: easeInOut left a long trailing tail the reference
// doesn't have. Plateau segments hold the same value at both ends, so their curve is irrelevant.
// The REOPEN segment is shortened to 0.64 of its nominal length; the shut and the plateau are the
// JSON's own. Measured end to end (first frame below 85% of resting, through to a full return to
// resting) the reference takes 700ms and ours took 946ms. Splitting that by phase showed the shut
// already matched — 219ms ours against 236ms theirs — and the entire surplus sat in the reopen:
// 727ms against their 464ms. Scaling the whole clip would have broken a part that was already
// right; an earlier plan to do exactly that came from measuring with an 85% cutoff that hid the
// tail on both sides and made the reference look like it truncated its clips. It does not: 700ms
// against a 783-1017ms nominal is very nearly the whole thing.
const BLINK_CLIPS = [
  // blink: straight down and back up, no plateau. Reopen 533ms -> 341ms.
  { keys: [[0, 0], [250, 1], [591, 0]], ease: ['easeOut', 'linear'] },
  // blink2: holds shut briefly. Reopen 516ms -> 330ms.
  { keys: [[0, 0], [250, 1], [367, 1], [697, 0]], ease: ['easeOut', 'linear', 'linear'] },
  // blink3: holds shut for 200ms, the slowest of the three. Reopen 567ms -> 363ms.
  { keys: [[0, 0], [250, 1], [450, 1], [813, 0]], ease: ['easeOut', 'linear', 'linear'] },
];
// --- Ambient loops, started once at boot and never stopped (behavior rule "init") ---------------
// All four run concurrently and forever. Keyframes are verbatim from anim_data.json; the px values
// are in the reference's 400-space and get scaled like every other measurement. Earlier these were
// hand-approximated with sine waves — these are the authored tracks.
//
// idle: rocks the whole look vector up and down. The value is the same normalized [-1,1] gaze the
// pointer drives, so it is applied as a gaze offset rather than a pixel one.
const IDLE_CLIP = { durationMs: 2833, keys: [[0, 0.12], [1333, -0.12], [2833, 0.12]] };
// pup_mov_1: pupils slide down 5px, hold, return, then rest for the remainder of the loop.
const PUP_MOV_1_CLIP = { durationMs: 4367, keys: [[0, 0], [333, 5], [1717, 5], [2000, 0], [2533, 0], [4367, 0]] };
// pup_mov_2: pupils slide sideways between -3 and +3px on a shorter cycle, so the two movement
// loops drift in and out of phase with each other.
const PUP_MOV_2_CLIP = { durationMs: 2617, keys: [[0, -3], [1233, -3], [1517, 3], [2317, 3], [2617, -3]] };
// pup_scale: pupils stretch vertically to 1.1x and hold, then settle. X stays at 1 throughout.
const PUP_SCALE_CLIP = { durationMs: 2817, keys: [[0, 1], [433, 1], [667, 1.1], [1767, 1.1], [1967, 1], [2817, 1]] };

// --- Occasional whole-pair rotations (behavior_data.json rule "rot", every 6-15s) ---------------
// Four authored clips, taken verbatim from anim_data.json's `eyes.r` lanes: [timeMs, angle]. The
// angle unit is RADIANS — confirmed by measuring the reference's actual on-screen pair tilt, which
// spanned 24.5deg against the 24.6deg these values predict in radians (reading them as turns would
// have meant ~155deg). The pair rotates about its own center, which is what `anc:[0.5,0.5]` means.
const ROT_CLIPS = [
  { durationMs: 3650, keys: [[0, 0], [550, 0.05], [1433, 0.05], [1933, -0.05], [3183, -0.05], [3650, 0]] },
  { durationMs: 3650, keys: [[0, 0], [550, 0.10], [1433, 0.10], [1933, -0.10], [3183, -0.10], [3650, 0]] },
  { durationMs: 2867, keys: [[0, 0], [550, 0.10], [1150, -0.03], [2400, -0.03], [2867, 0]] },
  { durationMs: 3717, keys: [[0, 0], [550, -0.17], [1433, -0.17], [1933, 0.12], [3183, 0.26], [3717, 0]] },
];
const ROT_INTERVAL_MIN_MS = 6000, ROT_INTERVAL_MAX_MS = 15000;

// --- Occasional 3D-ish tilts (rule "rot3d", every 8-16s) ----------------------------------------
// rot3d_1 leans the whole pair; rot3d_2 counter-rotates the two eyes against each other (its two
// lanes are mirror images, group_eye_l at -0.17 while group_eye_r is at +0.17). The engine applies
// these as a perspective transform; approximated here as a rotation plus a matching width squash,
// since a sphere turning away from the viewer is what the effect reads as.
const ROT3D_CLIPS = [
  { durationMs: 1917, mirrored: false, keys: [[0, 0], [433, -0.09], [1133, -0.09], [1450, 0.05], [1917, 0]] },
  { durationMs: 1200, mirrored: true, keys: [[0, 0], [250, -0.17], [533, 0], [833, -0.17], [1200, 0]] },
];
const ROT3D_INTERVAL_MIN_MS = 8000, ROT3D_INTERVAL_MAX_MS = 16000;

// Sample a [timeMs, value] keyframe track at time t, easing between neighbours. The real engine
// picks a curve per keyframe (the `c` field) from a table compiled into its WASM, which we can't
// read, so each segment's curve is chosen here to match the measured shape.
//
// `easings` is optional and parallel to the SEGMENTS (one shorter than keys). Omit it and every
// segment uses easeInOut, which is what the rotation and ambient clips still do. The blink needs
// per-segment control: a high-rate capture of the reference showed it dropping ballistically —
// 0.78 0.67 0.52 0.40 0.31 0.26 0.20 in seven samples — while a global easeInOut eased INTO the
// fall and took roughly twice as long to reach the bottom. Its reopen is near-linear too, where
// easeInOut left a long trailing cauda.
function sampleTrack(keys, t, easings) {
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
    if (t >= t0 && t <= t1) {
      if (t1 === t0) return v1;
      const ease = (easings && EASINGS[easings[i]]) || easeInOut;
      return v0 + (v1 - v0) * ease((t - t0) / (t1 - t0));
    }
  }
  return last[1];
}

function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }  // fast off the mark, settles at the end
function linear(t) { return t; }
const EASINGS = { easeInOut, easeOut, linear };

export class LilGuyEngine {
  constructor(skin = 'teal') {
    this.skin = LILGUY_SKINS[skin];
    this.nextBlinkAt = 0;
    this.blinkStart = null;
    this.jitterUntil = 0;
    this.startTime = null;
    // Occasional authored clips, each on its own independent timer (behavior_data.json runs the
    // "rot" and "rot3d" rules as separate categories, so they can overlap).
    this.nextRotAt = 0; this.rotStart = null; this.rotClip = null;
    this.nextRot3dAt = 0; this.rot3dStart = null; this.rot3dClip = null;
    // Pointer-relative gaze target in [-1,1] per axis, smoothed toward with a simple lerp — the
    // real site feeds this straight into the WASM engine's own internal smoothing, which we don't
    // have; a lerp here reproduces the same "eases toward the cursor" feel.
    this.gazeX = 0; this.gazeY = 0;
    this.targetGazeX = 0; this.targetGazeY = 0;
  }

  setSkin(skin) { this.skin = LILGUY_SKINS[skin] || this.skin; }
  setEyeColor(hex) { this.skin = { ...this.skin, eye: hex }; }
  setPupilColor(hex) { this.skin = { ...this.skin, pupil: hex }; }

  // nx, ny: pointer position normalized to roughly [-1,1] relative to canvas center, or null to
  // relax back toward center (mirrors the real site: mouse-out means gaze drifts back to neutral).
  setGazeTarget(nx, ny) {
    this.targetGazeX = nx === null ? 0 : Math.max(-1, Math.min(1, nx));
    this.targetGazeY = ny === null ? 0 : Math.max(-1, Math.min(1, ny));
  }

  jitter(now, durationMs = 400) { this.jitterUntil = now + durationMs; }

  update(now) {
    if (this.startTime === null) {
      this.startTime = now;
      this.nextBlinkAt = now + 1500 + Math.random() * 2500;
      this.nextRotAt = now + ROT_INTERVAL_MIN_MS + Math.random() * (ROT_INTERVAL_MAX_MS - ROT_INTERVAL_MIN_MS);
      this.nextRot3dAt = now + ROT3D_INTERVAL_MIN_MS + Math.random() * (ROT3D_INTERVAL_MAX_MS - ROT3D_INTERVAL_MIN_MS);
    }
    if (now >= this.nextBlinkAt && this.blinkStart === null) {
      this.blinkStart = now;
      this.blinkClip = BLINK_CLIPS[(Math.random() * BLINK_CLIPS.length) | 0];
      this.nextBlinkAt = now + 2500 + Math.random() * 2500; // behavior_data.json blink_ambient: 2.5-5s
    }
    // Each rule picks uniformly among its clips, then waits a fresh random interval.
    if (now >= this.nextRotAt && this.rotStart === null) {
      this.rotClip = ROT_CLIPS[(Math.random() * ROT_CLIPS.length) | 0];
      this.rotStart = now;
      this.nextRotAt = now + ROT_INTERVAL_MIN_MS + Math.random() * (ROT_INTERVAL_MAX_MS - ROT_INTERVAL_MIN_MS);
    }
    if (this.rotStart !== null && now - this.rotStart >= this.rotClip.durationMs) this.rotStart = null;

    if (now >= this.nextRot3dAt && this.rot3dStart === null) {
      this.rot3dClip = ROT3D_CLIPS[(Math.random() * ROT3D_CLIPS.length) | 0];
      this.rot3dStart = now;
      this.nextRot3dAt = now + ROT3D_INTERVAL_MIN_MS + Math.random() * (ROT3D_INTERVAL_MAX_MS - ROT3D_INTERVAL_MIN_MS);
    }
    if (this.rot3dStart !== null && now - this.rot3dStart >= this.rot3dClip.durationMs) this.rot3dStart = null;
    this.gazeX += (this.targetGazeX - this.gazeX) * 0.35;
    this.gazeY += (this.targetGazeY - this.gazeY) * 0.35;
  }

  // Top-lid coverage [0..BLINK_MAX_COVERAGE] for the current blink phase, 0 = fully open. Only the
  // top of the eye moves down to meet the fixed bottom, like a real squint/blink. Timing and peak
  // closure are the measured ones: a fast snap shut, a slightly slower reopen, never a full seal.
  blinkCoverage(now) {
    if (this.blinkStart === null) return 0;
    const keys = this.blinkClip.keys;
    const t = now - this.blinkStart;
    if (t >= keys[keys.length - 1][0]) { this.blinkStart = null; return 0; }
    return BLINK_MAX_COVERAGE * sampleTrack(keys, t, this.blinkClip.ease);
  }

  draw(ctx, now) {
    this.update(now);
    const t = now - this.startTime;
    const jittering = now < this.jitterUntil;

    ctx.fillStyle = '#111111';
    ctx.fillRect(0, 0, 240, 240);

    const lidCoverage = this.blinkCoverage(now);
    // The four ambient loops, each sampled at its own period. They never stop and never sync up,
    // which is what keeps the resting face from looking metronomic.
    const idleGaze = sampleTrack(IDLE_CLIP.keys, t % IDLE_CLIP.durationMs);
    const drift = sampleTrack(PUP_MOV_1_CLIP.keys, t % PUP_MOV_1_CLIP.durationMs) * REF_SCALE;
    const driftX = sampleTrack(PUP_MOV_2_CLIP.keys, t % PUP_MOV_2_CLIP.durationMs) * REF_SCALE;
    const pupilScaleY = sampleTrack(PUP_SCALE_CLIP.keys, t % PUP_SCALE_CLIP.durationMs);

    // idle rocks the look vector itself, so it rides along with the pointer-driven gaze rather than
    // being a separate pixel offset — the engine drives both through the same `l` lane.
    const floatY = idleGaze * GAZE_UP_SHIFT;

    // Gaze, as measured off the real renderer. The two axes behave completely differently:
    //
    //   Horizontal — the pair reads as two spheres on a head turning. The eye on the SAME side the
    //   cursor is on rotates away from the viewer: it narrows and slides the SHORTER distance. The
    //   opposite eye stays its width and slides FURTHER. Both slide the same direction, so the gaze
    //   never crosses.
    //
    //   Vertical — asymmetric, and not a pure translation: looking up lifts both eyes and flattens
    //   them noticeably, while looking down barely moves them at all.
    //
    // side is -1 for the left eye and +1 for the right eye.
    const gx = this.gazeX, gy = this.gazeY;
    const eyeGeomFor = (side) => {
      const isNear = Math.sign(gx) === side && gx !== 0; // cursor is on this eye's side
      const nearness = Math.abs(gx);
      const shift = isNear ? GAZE_X_NEAR_SHIFT : GAZE_X_FAR_SHIFT;
      const widthScale = isNear
        ? 1 - nearness * GAZE_X_NEAR_SQUASH
        : 1 + nearness * GAZE_X_FAR_GROW;
      // gy < 0 is up (canvas y grows downward). Both directions travel and both flatten the eye —
      // down slightly more than up.
      const lookingUp = gy < 0;
      const dy = lookingUp
        ? gy * GAZE_UP_SHIFT
        : Math.pow(gy, GAZE_DOWN_CURVE) * GAZE_DOWN_SHIFT;
      const heightScale = 1 - Math.abs(gy) * (lookingUp ? GAZE_UP_FLATTEN : GAZE_DOWN_FLATTEN);
      return {
        dx: gx * shift,
        dy: dy + floatY,
        rx: EYE_RX * widthScale,
        ry: EYE_RY * heightScale,
        isNear, // the pupil foreshortens too, but by its own smaller factor — see drawEye
      };
    };

    // The pupil rides its own eye, offset toward the cursor and clamped so it stays inside the
    // (possibly narrowed) outline. It also carries a fixed inward bias at rest — side is -1 for the
    // left eye and +1 for the right, and the bias pushes each pupil toward the midline, so it is
    // subtracted for the left eye and added for the right.
    const pupilOffsetFor = (geom, side) => {
      const maxTravelX = Math.max(0, geom.rx - PUPIL_R - PUPIL_MARGIN);
      const maxTravelY = Math.max(0, geom.ry - PUPIL_R - PUPIL_MARGIN);
      let dx = gx * maxTravelX * PUPIL_HORIZONTAL_TRAVEL - side * PUPIL_INWARD_PX;
      dx += driftX;
      let dy = gy * maxTravelY * PUPIL_VERTICAL_TRAVEL + drift;
      const clamp = (px, py) => {
        const norm = (px / (maxTravelX || 1)) ** 2 + (py / (maxTravelY || 1)) ** 2;
        if (norm > 1) { const k = 1 / Math.sqrt(norm); return [px * k, py * k]; }
        return [px, py];
      };
      [dx, dy] = clamp(dx, dy);
      if (jittering) [dx, dy] = clamp(dx + (Math.random() - 0.5) * 10, dy + (Math.random() - 0.5) * 10);
      return [dx, dy];
    };

    const cx = 120, cy = 128;

    // The eye outline itself never deforms during a blink — it stays a clean ellipse, so it can
    // never look crushed or kinked. The blink is a second, independent clip: a horizontal band
    // that slides down from above the eye as lidCoverage goes 0 -> 1, intersected with the ellipse
    // via a second ctx.clip(). Only the sliver where both regions overlap is drawn.
    //
    // The slant goes in ctx.ellipse's own rotation argument rather than a canvas transform, so it
    // tilts the outline ALONE. The blink band and the pupil stay in screen space: rotating those
    // too would close the lid diagonally and mirror the gaze between the two eyes (cross-eyed).
    // twist: rot3d_2's per-eye counter-rotation, mirrored between the two eyes. It rides on top of
    // the eye's own resting slant, and narrows the eye to match — the clip reads as each eyeball
    // turning away from the viewer in opposite directions.
    const drawEye = (baseX, side, twist = 0) => {
      const geom = eyeGeomFor(side);
      const x = baseX + geom.dx;
      const eyeCy = cy + geom.dy;
      const [pupilDx, pupilDy] = pupilOffsetFor(geom, side);
      const eyeTwist = -side * twist;
      const twistSquash = 1 - Math.abs(Math.sin(eyeTwist)) * 0.5;
      const slantRad = (side * EYE_SLANT_DEG * Math.PI) / 180 + eyeTwist;

      ctx.save();
      // Set BOTH clips before painting anything: the ellipse, then the blink band. Filling the eye
      // before the band clip is applied would stamp it at full size and the blink would never show.
      const eyeRx = geom.rx * twistSquash;
      ctx.beginPath();
      ctx.ellipse(x, eyeCy, eyeRx, geom.ry, slantRad, 0, Math.PI * 2);
      ctx.clip();

      if (lidCoverage > 0.001) {
        // The lid edge is the EYE'S OWN ELLIPSE, copied and shifted straight DOWN by `drop`, then
        // intersected with the eye. What survives is the crescent where the two still overlap: its
        // top edge is the falling copy's arc, its bottom edge the eye's own, and the two meet at
        // both corners. That crescent is the curved line a real closing eye leaves, and it thins
        // from the top down as `drop` grows.
        //
        // Congruence is the point. Four earlier versions got this edge wrong:
        //   - a dip proportional to ry sank past the bottom near full coverage and sealed the eye
        //     shut (0.35 at coverage 0.87 overran by 3.6px; the eye vanished entirely)
        //   - a dip taken from the remaining slack inverted the effect: slack shrinks as the lid
        //     descends, so the bow was 7px wide open and 0px shut — strongest where invisible
        //   - a quadratic through the eye's left/right extremes was the wrong CURVE: a parabola is
        //     pointier in the middle than an ellipse, so it clipped the sliver before it reached
        //     the corners and the closed eye measured 0.54 of its open width, reading as an oval
        //   - shifting the copy UP and cutting it out with evenodd kept the ring between the two
        //     ellipses rather than a lid, so the eye closed from the BOTTOM up
        // Shifting down and intersecting fixes the direction and keeps the corners meeting, so the
        // crescent holds nearly the eye's full width however thin it gets.
        //
        // The copy carries the same slantRad: an unrotated edge would cross the tilted eye
        // crookedly and thin one corner before the other. drop spans 0 to a hair under 2*ry, so a
        // trace of the crescent always survives — the reference never seals fully either.
        const drop = lidCoverage * (geom.ry * 2 - 0.75);
        ctx.beginPath();
        ctx.ellipse(x, eyeCy + drop, eyeRx, geom.ry, slantRad, 0, Math.PI * 2);
        ctx.clip(); // intersect: only the overlap with the falling copy remains
      }

      ctx.fillStyle = this.skin.eye;
      ctx.fillRect(x - eyeRx - 2, eyeCy - geom.ry - 2, eyeRx * 2 + 4, geom.ry * 2 + 4);
      // The pupil narrows with the eye, by the same factor: when the eyeball turns away from the
      // viewer the pupil is riding that same sphere, so it foreshortens too. Measured on the
      // reference: looking left takes the left pupil from 73 wide down to 59 (~-19%), matching the
      // outline's own squash. Drawing it as a fixed circle left ours visibly too round in profile.
      const pupilSquash = geom.isNear ? 1 - Math.abs(gx) * PUPIL_SQUASH : 1;
      ctx.fillStyle = this.skin.pupil;
      ctx.beginPath();
      ctx.ellipse(x + pupilDx, eyeCy + pupilDy, PUPIL_R * pupilSquash, PUPIL_R * pupilScaleY, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    // Authored rotation clips, applied around the pair's own center. rot spins the pair as a unit;
    // rot3d either leans the pair (rot3d_1) or counter-rotates the two eyes against each other
    // (rot3d_2, whose two lanes are mirror images). The engine does the latter as a perspective
    // transform, approximated here as a per-eye rotation plus a matching width squash — a sphere
    // turning away from the viewer is what it reads as.
    const rotAngle = this.rotStart === null ? 0 : sampleTrack(this.rotClip.keys, now - this.rotStart);
    let pairLean = 0, perEyeTwist = 0;
    if (this.rot3dStart !== null) {
      const a = sampleTrack(this.rot3dClip.keys, now - this.rot3dStart);
      if (this.rot3dClip.mirrored) perEyeTwist = a; else pairLean = a;
    }

    ctx.save();
    if (rotAngle !== 0 || pairLean !== 0) {
      ctx.translate(cx, cy);
      ctx.rotate(rotAngle + pairLean);
      ctx.translate(-cx, -cy);
    }
    drawEye(cx - EYE_GAP / 2, -1, perEyeTwist);
    drawEye(cx + EYE_GAP / 2, 1, perEyeTwist);
    ctx.restore();
  }
}
