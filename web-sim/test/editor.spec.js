// The editor, exercised in a browser.
//
// The thing worth guarding is not that it renders — it is that an EDIT REACHES THE CANVAS. The
// editor imports the real lark.js, so a change to the data has to travel through React state, into
// a fresh LarkRuntime, and out to the pixels. Any break in that chain leaves an editor that looks
// responsive and changes nothing, which is the failure mode a screenshot cannot catch.
//
// A note on how these measure, because getting it wrong wasted a round of debugging:
//
//   - INK IS COLOUR, NOT ALPHA. The stage paints an opaque background, so counting pixels with
//     alpha > 0 counts the whole 240x240 canvas and can never see a blink.
//   - PICK A TARGET THAT SHOWS. The first attempt moved a pupil 40px on `pup_mov_1`. In state 1b
//     the pupil is a HOLE punched in the eye and clipped by the lid, so pushing it that far simply
//     clips it away and the ink is unchanged. That read as "the edit did not reach the canvas" when
//     the edit was fine and the probe was wrong — the same class of measurement error this project
//     has made before. Scaling a pupil at a wide-open moment is unmissable.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The project timeout is 15 minutes, sized for the IoU harness that opens a reference page per
// state. Nothing here takes more than a few seconds, so a stale selector would otherwise hang for
// a quarter of an hour per test instead of failing — one bad run sat for 3.2 hours before this.
test.describe.configure({ timeout: 30_000 });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDITOR = path.join(HERE, '..', 'editor');
const URL = 'http://localhost:8795/';

// The editor has its own package.json. Skip rather than fail when it has not been installed: this
// suite's other specs do not need it, and a confusing connection error helps nobody.
test.beforeAll(() => {
  test.skip(
    !fs.existsSync(path.join(EDITOR, 'node_modules')),
    'editor deps not installed — run `npm --prefix editor install`',
  );
});

// Ink and its centroid, measured on colour.
async function snapshot(page) {
  return page.evaluate(() => {
    const c = document.querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 24 || d[i + 1] > 24 || d[i + 2] > 24) {
        const p = i / 4;
        sx += p % c.width;
        sy += Math.floor(p / c.width);
        n++;
      }
    }
    return n ? { n, x: sx / n, y: sy / n } : { n: 0, x: 0, y: 0 };
  });
}

// The clip list is a rail of buttons, not a <select>: the layout follows the original tool, where
// states and animations are lists you scan rather than dropdowns you open.
const pickClip = async (page, name) => {
  // Anchored at the start and followed by end-or-tag: a clip that drives groups carries a "grupos"
  // chip inside its button, so `^name$` would never match `rot3d_2`, while a bare prefix would
  // match `blink2` when asked for `blink`.
  await page.locator('.col .list button')
    .filter({ hasText: new RegExp(`^${name}(\\s|$)`) })
    .first()
    .click();
};
const clipNames = (page) =>
  page.locator('.section-head:has-text("Animações") ~ .section-body .list button').allTextContents();
// Lane rows live on their own rail beside the keyframe ruler.
const laneRows = (page) => page.locator('.lane-rail .lane-name');
const scrubber = (page) => page.locator('.transport input[type="range"]');

test('the editor loads and draws the eyes', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  const shot = await snapshot(page);
  expect(shot.n, 'the stage should be drawing something').toBeGreaterThan(5000);
  expect(errors, 'no page errors').toEqual([]);
});

test('the stage maps the authoring space onto the disc', async ({ page }) => {
  // The bug this exists for: Stage drew straight into the canvas without the authoring-space
  // transform the published page applies. `draw` renders in 400x400 units, so an unmapped 240px
  // canvas showed the scene at 1:1 — most of the second eye off the right edge, the bottom cut off
  // at y=239. Every other test here still passed, because they only asked whether there was ink and
  // whether it changed, never WHERE it was.
  //
  // The figures are the ones this project already measures elsewhere: state 1b draws two eyes
  // 93px wide with their centres 98px apart (web-sim/tools/baseline/states.json, and the same
  // numbers in lark_scene.h's tests).
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const geom = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const lit = (x, y) => { const i = (y * c.width + x) * 4; return d[i] > 24 || d[i + 1] > 24 || d[i + 2] > 24; };

    // Column scan, not a split down the middle: halving the canvas clips a deflected eye, and
    // measuring that way once sent a whole turn model the wrong way round.
    const cols = [];
    for (let x = 0; x < c.width; x++) {
      let on = false;
      for (let y = 0; y < c.height; y++) if (lit(x, y)) { on = true; break; }
      cols.push(on);
    }
    const blobs = [];
    let start = -1;
    for (let x = 0; x <= c.width; x++) {
      const on = x < c.width && cols[x];
      if (on && start < 0) start = x;
      if (!on && start >= 0) { if (x - start >= 6) blobs.push({ x0: start, x1: x - 1 }); start = -1; }
    }
    let top = c.height, bot = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) if (lit(x, y)) { if (y < top) top = y; if (y > bot) bot = y; break; }
    }
    return { w: c.width, h: c.height, top, bot, blobs };
  });

  expect(geom.blobs.length, 'the two eyes should be separate blobs').toBe(2);
  for (const b of geom.blobs) {
    expect(b.x1 - b.x0 + 1, 'each eye is about 93px wide').toBeGreaterThan(80);
    expect(b.x1 - b.x0 + 1, 'each eye is about 93px wide').toBeLessThan(106);
  }
  const gap = ((geom.blobs[1].x0 + geom.blobs[1].x1) - (geom.blobs[0].x0 + geom.blobs[0].x1)) / 2;
  expect(gap, 'the eye centres sit ~98px apart').toBeGreaterThan(88);
  expect(gap, 'the eye centres sit ~98px apart').toBeLessThan(108);

  // Nothing may touch an edge: the drawing lives inside the disc, and ink at y=239 means it is
  // being cut off rather than framed.
  expect(geom.top, 'the drawing must not touch the top edge').toBeGreaterThan(2);
  expect(geom.bot, 'the drawing must not be cut off at the bottom').toBeLessThan(geom.h - 3);
  expect(geom.blobs[0].x0, 'nor the left edge').toBeGreaterThan(2);
  expect(geom.blobs[1].x1, 'nor the right edge').toBeLessThan(geom.w - 3);
});

test('playing a blink closes the eyes', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await pickClip(page, 'blink');
  await page.waitForTimeout(300);

  await scrubber(page).fill('0');
  await page.waitForTimeout(250);
  const open = await snapshot(page);

  // blink runs 783ms and is tightest around the middle.
  let lowest = open.n;
  for (const t of [150, 200, 250, 300, 350]) {
    await scrubber(page).fill(String(t));
    await page.waitForTimeout(150);
    const s = await snapshot(page);
    if (s.n < lowest) lowest = s.n;
  }
  expect(lowest, 'scrubbing into the blink should close the eyes').toBeLessThan(open.n * 0.4);
});

test('an edit reaches the canvas, and undo takes it back', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await pickClip(page, 'blink');
  await page.waitForTimeout(300);
  await scrubber(page).fill('0');          // wide open: the pupils are fully visible
  await page.waitForTimeout(250);

  const before = await snapshot(page);

  // Find a pupil SCALE lane and blow it up. Scale at a wide-open moment changes the drawing in a
  // way nothing else could account for.
  const rows = laneRows(page);
  const count = await rows.count();
  let edited = false;
  for (let i = 0; i < count; i++) {
    const name = await rows.nth(i).textContent();
    if (!/escala/.test(name)) continue;
    // Click the LANE to open it (which selects its first keyframe), then pick a keyframe from the
    // graph. `.kf` is one flat list across every lane, so indexing it by lane number lands on
    // whatever keyframe happens to be at that position — usually the wrong lane's.
    await rows.nth(i).click();
    await page.waitForTimeout(200);
    await page.locator('.curve-key').nth(1).click();
    await page.waitForTimeout(150);

    const rest = page.locator('.inspector input[type="checkbox"]');
    if (await rest.isChecked()) { await rest.uncheck(); await page.waitForTimeout(150); }

    // Fields are [time, x, y] for a scale lane.
    await page.locator('.inspector input[type="number"]').nth(1).fill('3');
    await page.waitForTimeout(400);
    edited = true;
    break;
  }
  expect(edited, 'blink should have a pupil scale lane to edit').toBe(true);

  const after = await snapshot(page);
  expect(
    after.n !== before.n || Math.abs(after.x - before.x) > 0.5,
    'tripling a pupil scale must change the drawing',
  ).toBe(true);

  await page.locator('button:has-text("desfazer")').click();
  await page.waitForTimeout(400);
  const undone = await snapshot(page);
  expect(undone.n, 'undo should restore the previous drawing').toBe(before.n);
});

test('undo is unavailable until something is edited', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  await expect(page.locator('button:has-text("desfazer")')).toBeDisabled();
  await expect(page.locator('button:has-text("refazer")')).toBeDisabled();
});

test('the curve graph draws the runtime\'s own easing', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await pickClip(page, 'blink');
  await page.waitForTimeout(400);

  await expect(page.locator('.curve-svg')).toHaveCount(1);
  expect(await page.locator('.curve-key').count(), 'keyframes should be plotted').toBeGreaterThan(0);

  // CURVE 0 IS A STEP that holds its SOURCE value, and the pupils' `o` lanes use it. Drawn as a
  // ramp the graph would misrepresent every keyframe that uses it — and this project has already
  // paid for reading that curve the wrong way once. A step's path holds flat levels and jumps
  // between them, so its rendered y values collapse to a couple of distinct heights.
  const rows = laneRows(page);
  const count = await rows.count();
  let opened = false;
  for (let i = 0; i < count; i++) {
    const name = await rows.nth(i).textContent();
    if (!/opacidade/.test(name)) continue;
    await rows.nth(i).click();
    opened = true;
    break;
  }
  expect(opened, 'blink should carry an opacity lane').toBe(true);
  await page.waitForTimeout(300);

  const d = await page.locator('.curve-line').first().getAttribute('d');
  const ys = [...d.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => Number(m[1]));
  const levels = new Set(ys.map((y) => y.toFixed(1)));
  expect(levels.size, 'curve 0 must draw as a step, not a ramp').toBeLessThanOrEqual(3);
});

test('dragging a point on the graph edits the value', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await pickClip(page, 'blink');
  await page.waitForTimeout(400);

  // Open a scale lane, whose values are continuous and safe to drag.
  const rows = laneRows(page);
  let openedScale = false;
  for (let i = 0; i < await rows.count(); i++) {
    const name = await rows.nth(i).textContent();
    if (!/escala/.test(name)) continue;
    await rows.nth(i).click();
    openedScale = true;
    break;
  }
  expect(openedScale, 'blink should carry a scale lane').toBe(true);
  await page.waitForTimeout(300);

  // Confirm the graph is showing the lane we asked for: an earlier version of this test dragged a
  // point on whatever lane happened to be open, which was an opacity lane already pinned at the top
  // of its range — so the drag had nowhere to go and "no change" proved nothing.
  await expect(page.locator('.curve-legend .lane-target')).toContainText('s');

  const pt = page.locator('.curve-key').nth(1);
  const before = await pt.getAttribute('cy');
  const box = await pt.boundingBox();
  const svg = await page.locator('.curve-svg').boundingBox();
  // Drag toward the middle of the plot, whichever way that is, so the target is never already at
  // the edge it is being pushed against.
  const midY = svg.y + svg.height / 2;
  const toY = Math.abs(box.y - midY) < 30 ? midY + 50 : midY;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, toY, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  const after = await page.locator('.curve-key').nth(1).getAttribute('cy');
  expect(after, 'dragging a point upward should change its value').not.toBe(before);

  // And the whole drag is ONE undo, not one per pixel — that is what the merge key is for.
  await page.locator('button:has-text("desfazer")').click();
  await page.waitForTimeout(400);
  const undone = await page.locator('.curve-key').nth(1).getAttribute('cy');
  expect(undone, 'one undo should take the whole drag back').toBe(before);
});

test('the object tree offers the groups, not just the leaves', async ({ page }) => {
  // A lane can only be authored on a node the picker offers. `rot` drives `eyes` and `rot3d_2`
  // drives `group_eye_l`/`group_eye_r` -- so filtering the groups out, as this once did, makes
  // exactly those clips impossible to author or to understand.
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  // The tree is a rail of buttons now, indented by depth, the way the original tool lists objects.
  const nodes = page.locator('.tree button');
  const names = (await nodes.allTextContents()).map((t) => t.trim());

  for (const n of ['eyes', 'group_eye_l', 'group_eye_r', 'eye_l', 'pup_r']) {
    expect(names.includes(n), `${n} should be offered`).toBe(true);
  }

  // Depth shows as indentation, and a group precedes everything it contains.
  const eyesIdx = names.indexOf('eyes');
  const eyeLIdx = names.indexOf('eye_l');
  expect(eyesIdx, '`eyes` should come before its descendants').toBeLessThan(eyeLIdx);

  const pads = await nodes.evaluateAll((els) =>
    els.map((e) => parseFloat(getComputedStyle(e).paddingLeft)));
  expect(pads[eyeLIdx], 'a leaf should be indented past its group')
    .toBeGreaterThan(pads[eyesIdx]);
});

test('the clip list holds the shipped clips', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  const names = await clipNames(page);
  expect(names.length, 'the data ships 15 clips').toBe(15);
  // The ones the firmware's five live rules depend on must be there and selectable.
  for (const n of ['blink', 'blink2', 'blink3', 'idle', 'pup_mov_1', 'pup_scale']) {
    expect(names.some((t) => t.startsWith(n)), `${n} should be listed`).toBe(true);
  }
  // Clips that only drive scene groups are flagged, because on the device they play and draw
  // nothing — see lark_behavior.h.
  expect(names.some((t) => t.startsWith('rot_1') && t.includes('grupos')),
    'group-only clips should be marked').toBe(true);
});
