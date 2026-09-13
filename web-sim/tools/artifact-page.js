// --- page wiring -------------------------------------------------------------------------------
// The data is authored in a 400x400 space, but nothing is ever drawn near its edges. Measured
// across all 36 states, nine pointer positions each, and every rotation clip, the union of drawn
// pixels is x 15..377, y 42..334 — so the canvas is cropped to that box plus 4px of breathing
// room, and the scene is shifted by the same offset. Cropping to the RESTING box would clip the
// eyes: the pair travels ~46px with the look and the rot clips swing it further still.
const CROP = { x: 11, y: 38, w: 372, h: 304 };
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const rt = new LarkRuntime(ANIM_DATA, '1b');
const br = new BehaviorRunner(rt, BEHAVIOR_DATA);

// Sensor 15 gates every blink rule. The original never feeds it on the web, yet it blinks every
// 2.5-5s — exactly blink_ambient's own interval — so it must carry a value there. 0.9 is an
// ASSUMPTION, exposed as a slider rather than hidden: below 0.3 the rules swap to blink4/blink5,
// the sleepy pair that never shows on the real site.
br.setSensor(15, 0.9);

const AMBIENT = ['idle', 'pup_mov_1', 'pup_mov_2', 'pup_scale'];

// Populate the state selector: all 36, in one sorted list.
const stateSel = document.getElementById('state');
for (const id of Object.keys(ANIM_DATA.states).sort()) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = id;
  if (id === '1b') opt.selected = true;
  stateSel.appendChild(opt);
}
stateSel.addEventListener('change', () => {
  rt.setState(stateSel.value);
  rt.active = [];
  // Re-run the boot rule so the ambient loops restart under the new state.
  for (const a of AMBIENT) rt.play(a, performance.now());
});

// One button per clip. The five sensor-gated ones still play here on demand; the original only
// reaches them when a sensor it never feeds on the web crosses a threshold.
const clips = document.getElementById('clips');
for (const name of Object.keys(ANIM_DATA.animations)) {
  if (AMBIENT.includes(name)) continue;
  const b = document.createElement('button');
  b.textContent = name;
  b.addEventListener('click', () => rt.play(name, performance.now()));
  clips.appendChild(b);
}

// Sensor slider: the only value this page invents, so it is adjustable and visible.
const sensorInput = document.getElementById('sensor');
const sensorVal = document.getElementById('sensorVal');
sensorInput.addEventListener('input', () => {
  const v = Number(sensorInput.value);
  br.setSensor(15, v);
  sensorVal.textContent = v.toFixed(2);
});

// Show which rules actually fired, so the behaviour layer is observable rather than implied.
const firedEl = document.getElementById('fired');
let lastLogLen = 0;
function renderFired() {
  if (br.log.length === lastLogLen) return;
  lastLogLen = br.log.length;
  const counts = {};
  for (const e of br.log) counts[e.rule] = (counts[e.rule] || 0) + 1;
  firedEl.textContent = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} x${v}`)
    .join('   ') || '—';
}

// The behaviour layer drives every clip now, including the ambient loops (rule "init" at boot) and
// the blinks (rule "blink_ambient" on its own 2.5-5s interval). The hand-written blink scheduler
// that used to live here duplicated that rule and is gone.
let look = [0, 0];
function frame(now) {
  br.update(now, look);
  // The module's draw() paints nothing behind the scene unless a background is passed, so the page
  // clears. The old inlined copy cleared inside draw() itself, which is the one behavioural way the
  // hand-maintained copy had drifted from lark.js.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(1, 0, 0, 1, -CROP.x, -CROP.y);
  rt.draw(ctx, now, { width: 400, height: 400 });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  renderFired();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// The gaze, normalised exactly the way the original's own renderer does it. This is not a detail:
// the previous reading here was a per-axis divide by the canvas half-size, clamped to +-1, and it
// was about four times too eager. At 200px from the canvas centre it produced a look of 0.952 where
// the original produces 0.222 — so the eyes slammed to their limit within half a screen and then sat
// there, which is what "not expressive" actually was. The fix is not more travel, it is the right
// curve: the original stays gentle near the centre and keeps responding far out.
//
// Copied from animation_renderer_web.js, which does:
//   - a UNIT vector times a magnitude, not an independent divide per axis, so diagonal motion does
//     not reach the limit on both axes at once;
//   - normalised against min(innerWidth, innerHeight) — the WINDOW, not the canvas, so the crop and
//     the CSS size of this page do not change the feel;
//   - capped at 2, not 1. The runtime's own clamp matches.
//
// The one thing NOT copied is the sign of y. The original negates it because its WASM works in a
// y-up space; this runtime is y-down like the canvas, and the two agree once that is accounted for —
// measured at the pixel, the drawing's centre moves from y=192 to y=221 on the original and 189 to
// 215 here for the same downward pointer, so negating here would invert a gaze that already matches.
// LOOK_CAP comes from lark.js — the build concatenates both into one scope, so declaring it here too
// is a redeclaration that kills the whole script.
function lookFromPointer(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  const dx = clientX - (r.left + r.width / 2);
  const dy = clientY - (r.top + r.height / 2);
  const mag = Math.hypot(dx, dy);
  if (!mag) return [0, 0];
  const scale = Math.min(mag / Math.min(window.innerWidth, window.innerHeight), LOOK_CAP);
  return [(dx / mag) * scale, (dy / mag) * scale];
}

window.addEventListener('pointermove', (e) => {
  look = lookFromPointer(e.clientX, e.clientY);
  rt.setLook(look[0], look[1]);
});
// Touch too. The original disables tracking entirely on a coarse pointer, so its eyes simply ignore
// a touch; here a tap or drag drives the same gaze as a mouse, which is the more useful behaviour on
// a phone and costs nothing on a desktop.
window.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (!t) return;
  look = lookFromPointer(t.clientX, t.clientY);
  rt.setLook(look[0], look[1]);
}, { passive: true });
// Leaving the window entirely relaxes the gaze back to centre.
document.addEventListener('pointerleave', () => { look = [0, 0]; rt.setLook(0, 0); });
