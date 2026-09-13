import { LilGuyEngine } from './lilguy.js';

const canvas = document.getElementById('eye');
const ctx = canvas.getContext('2d');
const lilguy = new LilGuyEngine();

function frame(now) {
  lilguy.draw(ctx, now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Gaze follows the pointer at all times (not just while pressed), matching the real site's
// mousemove-driven look-tracking. Leaving the canvas relaxes the gaze back to neutral.
canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  const nx = ((e.clientX - r.left) / r.width - 0.5) * 2;
  const ny = ((e.clientY - r.top) / r.height - 0.5) * 2;
  lilguy.setGazeTarget(nx, ny);
});
canvas.addEventListener('pointerleave', () => lilguy.setGazeTarget(null, null));

// A tap (press and release without travelling far) startles it.
const TAP_MOVE_SQ = 30 * 30;
let downX = 0, downY = 0, tracking = false;
canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  downX = e.clientX - r.left; downY = e.clientY - r.top;
  tracking = true;
});
canvas.addEventListener('pointerup', (e) => {
  if (!tracking) return;
  tracking = false;
  const r = canvas.getBoundingClientRect();
  const dx = e.clientX - r.left - downX, dy = e.clientY - r.top - downY;
  if (dx * dx + dy * dy <= TAP_MOVE_SQ) lilguy.jitter(performance.now(), 400);
});
canvas.style.touchAction = 'none';

document.getElementById('lgEyeColor').addEventListener('input', (e) => lilguy.setEyeColor(e.target.value));
document.getElementById('lgPupilColor').addEventListener('input', (e) => lilguy.setPupilColor(e.target.value));
