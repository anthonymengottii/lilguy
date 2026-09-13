// Opening and driving the two pages a measurement compares: our harness page on 8794 and the
// reference's real WASM renderer on 8793.
//
// Both sides fail LOUDLY here. A reference that never painted and a runtime with a rendering bug both
// look like a blank canvas, and an earlier session burned real time on that ambiguity. openReference
// and openSim each wait for ink and throw naming the port and the URL if none arrives.
import { chromium } from '@playwright/test';
import { captureBackingStore } from './measure.js';

export const SIM_ORIGIN = 'http://localhost:8794';
export const REF_ORIGIN = 'http://localhost:8793';
export const LIVE_ORIGIN = 'https://hesjustalittleguy.com';

const INK_TIMEOUT_MS = 10000;

export async function launch() {
  const browser = await chromium.launch();
  // A fixed device scale factor keeps the backing store equal to the CSS box on pages that size
  // their canvas in CSS. Our harness page has no CSS sizing at all, so this only matters for the
  // reference.
  const context = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1200, height: 900 } });
  return { browser, context };
}

// Wait until a canvas has painted something. Returns the ink area.
async function waitForInk(page, selector, where) {
  const deadline = Date.now() + INK_TIMEOUT_MS;
  let area = 0;
  while (Date.now() < deadline) {
    try {
      area = (await captureBackingStore(page, selector)).area;
      if (area > 0) return area;
    } catch {
      // canvas not in the DOM yet
    }
    await page.waitForTimeout(120);
  }
  throw new Error(
    `no ink on ${selector} at ${where} after ${INK_TIMEOUT_MS}ms. ` +
    `Is the server running? Check that the .wasm is served as application/wasm — ` +
    `WebAssembly.instantiateStreaming rejects any other content type and the page then renders nothing.`
  );
}

// Our harness page: a bare 400x400 canvas, no CSS scaling, no CROP, and a clock the caller drives.
export async function openSim(context, { state = '1b' } = {}) {
  const page = await context.newPage();
  const url = `${SIM_ORIGIN}/tools/harness/harness.html?state=${encodeURIComponent(state)}`;
  page.on('pageerror', (e) => { throw new Error(`sim page error: ${e.message}`); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__larkReady === true, null, { timeout: INK_TIMEOUT_MS });
  await page.evaluate(() => window.__lark.render(0, [0, 0]));
  await waitForInk(page, '#stage', url);
  return {
    page,
    url,
    // Render one frame at an explicit millisecond offset.
    render: (now, look = [0, 0], opts = {}) =>
      page.evaluate(([n, l, o]) => window.__lark.render(n, l, o), [now, look, opts]),
    setState: (id) => page.evaluate((s) => window.__lark.setState(s), id),
    play: (name, start = 0, category = null) =>
      page.evaluate(([n, s, c]) => window.__lark.play(n, s, c), [name, start, category]),
    clear: () => page.evaluate(() => window.__lark.clear()),
    capture: () => captureBackingStore(page, '#stage'),
    states: () => page.evaluate(() => window.__lark.states),
    clips: () => page.evaluate(() => window.__lark.clips),
  };
}

// The reference. single-eye.html hardcodes data-state="1b", so the state is injected before the
// renderer scripts run rather than by editing a file in lilguy-fork — the reference stays pristine.
export async function openReference(context, { state = '1b', origin = REF_ORIGIN } = {}) {
  const page = await context.newPage();
  await page.addInitScript((s) => {
    document.addEventListener('DOMContentLoaded', () => {
      const el = document.querySelector('.animation-renderer');
      if (el) el.setAttribute('data-state', s);
    }, { once: true });
  }, state);
  const url = `${origin}/single-eye.html`;
  await page.goto(url, { waitUntil: 'load' });
  // The renderer creates its own canvas inside .animation-renderer.
  await page.waitForSelector('.animation-renderer canvas', { timeout: INK_TIMEOUT_MS });
  await waitForInk(page, '.animation-renderer canvas', url);
  return {
    page,
    url,
    capture: () => captureBackingStore(page, '.animation-renderer canvas'),
    // The reference blinks on its own, every 2.5-5s, and cannot be told not to: its clock and its
    // behaviour layer live inside the WASM. A single capture therefore lands on a closed eye often
    // enough to matter — the first run of iou-states caught exactly that and reported IoU 0.03 with
    // a 258x25 reference bbox, which is a blink, not a rest pose.
    //
    // So sample repeatedly and keep the frame with the MOST ink. The open eye is strictly larger
    // than any point in a blink, so max-area is the rest pose by construction. Sampling is in
    // milliseconds rather than frame counts, per the rule in measure.js.
    // The window has to outlast a blink, not merely contain a few frames. The reference blinks every
    // 2.5-5s and a blink runs ~800ms, so a short series can land entirely inside one: sampled at the
    // [1,-1] corner, 25 consecutive frames ran 167, 166, 165, 164, 143, 45, 26 — a height range of
    // 26..167 for one fixed gaze. Max-area still picks the open frame correctly, but only if an open
    // frame is in the series at all, and when it was not the harness reported per-eye height errors
    // that swung 6-10px between identical runs.
    //
    // 14 x 90ms was 1.3s of wall time. 2.4s clears the longest blink with margin.
    async captureOpen({ samples = 24, everyMs = 100 } = {}) {
      let best = null;
      for (let i = 0; i < samples; i++) {
        // shot.area is computed in-page, so picking the open frame costs no mask unpacking.
        const shot = await captureBackingStore(page, '.animation-renderer canvas');
        if (!best || shot.area > best.area) best = shot;
        if (i < samples - 1) await page.waitForTimeout(everyMs);
      }
      return best;
    },
    // Move the pointer to drive the reference's gaze. Coordinates are page pixels; the reference's
    // wrap div sits at left:500 top:300 with a 400x400 box.
    async look(nx, ny) {
      const box = await page.locator('.animation-renderer').boundingBox();
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      await page.mouse.move(cx + nx * (box.width / 2), cy + ny * (box.height / 2));
      await page.waitForTimeout(250); // let its own easing settle
    },
  };
}

// Resize our capture or the reference's so two masks can be compared. Both render a 400x400 box, so
// in practice this is a no-op guard that throws early rather than producing a meaningless IoU.
export function assertSameSize(a, b) {
  if (a.w !== b.w || a.h !== b.h) {
    throw new Error(
      `canvas size mismatch: sim ${a.w}x${a.h} (cssRatio ${a.cssRatio}) vs ref ${b.w}x${b.h} (cssRatio ${b.cssRatio}). ` +
      `A cssRatio other than 1 means something is measuring CSS pixels.`
    );
  }
}
