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
    // The selection marker is drawn in white, and a group's box would bridge the two eyes into one
    // blob. Ink here means the drawing, so white is excluded.
    const lit = (x, y) => {
      const i = (y * c.width + x) * 4;
      if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) return false;
      return d[i] > 24 || d[i + 1] > 24 || d[i + 2] > 24;
    };

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

test('clicking a node on the stage selects it and shows its colour', async ({ page }) => {
  // The pick is an ID PASS: the scene is redrawn offscreen with one flat colour per node, and the
  // pixel under the cursor names the node. Reading the visible canvas instead would be wrong —
  // both pupils in 1b are 106E54, a hole punches to the background rather than to a colour, and
  // antialiased edges blend two nodes into a third value matching neither.
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const box = await page.locator('canvas').boundingBox();
  const selectedNode = () => page.locator('.colour-panel .prop b').textContent();
  // Panel coordinates -> screen. Aim well inside each target: state 1b leaves only a 5px gap
  // between the eyes, and at the canvas's display size that is under 4 screen pixels — an earlier
  // version of this test aimed at the gap's centre and landed on the eye beside it.
  const clickPanel = async (px, py) => {
    await page.mouse.click(box.x + (px / 240) * box.width, box.y + (py / 240) * box.height);
    await page.waitForTimeout(300);
  };

  await clickPanel(73, 120);
  expect(await selectedNode(), 'the middle of the left eye is its pupil').toBe('pup_l');

  await clickPanel(171, 120);
  expect(await selectedNode(), 'and the right eye its own').toBe('pup_r');

  // Near the eye's edge, past the pupil: the eye itself.
  await clickPanel(40, 120);
  expect(await selectedNode(), 'the edge of the eye is the eye').toBe('eye_l');
});

test('the colour swatch edits the document, not just the runtime', async ({ page }) => {
  // Colour lives on the node inside the state. A LarkRuntime override would look right on screen
  // and vanish on export, so this checks the drawing AND the exported JSON.
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const box = await page.locator('canvas').boundingBox();
  await page.mouse.click(box.x + (73 / 240) * box.width, box.y + (120 / 240) * box.height);
  await page.waitForTimeout(300);
  await expect(page.locator('.colour-panel .prop b')).toHaveText('pup_l');

  const pupilPixel = () => page.evaluate(() => {
    const c = document.querySelector('canvas');
    const d = c.getContext('2d').getImageData(73, 120, 1, 1).data;
    return [d[0], d[1], d[2]].join(',');
  });
  const before = await pupilPixel();

  // `<input type="color">` opens an OS picker, so it cannot be driven by typing. Two details are
  // load-bearing: React binds `input`, not `change`, and it tracks the element's value internally —
  // assigning `el.value` directly makes React treat the change as one it already knows about and
  // ignore the event. Going through the native setter is what makes it notice.
  await page.locator('.colour-panel input[type="color"]').evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, '#ff0000');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);

  expect(await pupilPixel(), 'the pupil should repaint').not.toBe(before);
  expect(await pupilPixel(), 'and be the colour asked for').toBe('255,0,0');

  // The tree's dot is a legend of the real colour, so it must follow.
  const dot = await page.locator('.tree button', { hasText: 'pup_l' }).locator('.dot')
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(dot, 'the tree dot should show the new colour').toBe('rgb(255, 0, 0)');

  // And the part the pixels cannot prove: the change is in the DOCUMENT, so it survives export.
  // A LarkRuntime override would paint identically and be gone from the downloaded file.
  const exported = await page.evaluate(async () => {
    // Intercept the download by stubbing the anchor click the export builds.
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => { captured = blob; return 'blob:stub'; };
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function noop() {};
    document.querySelector('.titlebar button:last-of-type').click();
    HTMLAnchorElement.prototype.click = realClick;
    URL.createObjectURL = realCreate;
    return captured ? JSON.parse(await captured.text()) : null;
  });
  expect(exported, 'the export should produce a document').not.toBeNull();
  expect(exported.states['1b'].objs.pup_l.c, 'the exported JSON carries the new colour')
    .toBe('FF0000');
});

test('the hole toggle punches rather than paints', async ({ page }) => {
  // `000000` is a HOLE, not black: the node is cut out of what is behind it. Twenty of the 36
  // states draw their pupils this way, and reading that value as the colour black cost this
  // project most of its fidelity once.
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const box = await page.locator('canvas').boundingBox();
  await page.mouse.click(box.x + (73 / 240) * box.width, box.y + (120 / 240) * box.height);
  await page.waitForTimeout(300);

  const hole = page.locator('.colour-panel input[type="checkbox"]');
  await expect(hole, "1b's pupils are painted, not punched").not.toBeChecked();

  await hole.check();
  await page.waitForTimeout(400);

  // Punched, the pupil shows the background through the eye — so the pixel there becomes the
  // background colour rather than any node's colour.
  const px = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const d = c.getContext('2d').getImageData(73, 120, 1, 1).data;
    return [d[0], d[1], d[2]].join(',');
  });
  expect(px, 'a punched pupil shows the background').toBe('0,0,0');

  // And the swatch disables itself, because there is no colour to show.
  await expect(page.locator('.colour-panel input[type="color"]')).toBeDisabled();
});

test('dragging a node on the stage moves it', async ({ page }) => {
  // A drag edits the node's outline in the STATE, so the move applies to every clip and survives
  // export — the same place a colour change lands.
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const box = await page.locator('canvas').boundingBox();
  const at = (px, py) => ({
    x: box.x + (px / 240) * box.width,
    y: box.y + (py / 240) * box.height,
  });

  // The left pupil's centroid, found by its own colour rather than by a guessed pixel.
  const pupilY = () => page.evaluate(() => {
    const c = document.querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, 240, 240).data;
    let sy = 0, n = 0;
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 120; x++) {
        const i = (y * 240 + x) * 4;
        if (d[i] < 60 && d[i + 1] > 80 && d[i + 1] < 140 && d[i + 2] > 60 && d[i + 2] < 110) {
          sy += y;
          n++;
        }
      }
    }
    return n ? sy / n : null;
  });

  const before = await pupilY();
  expect(before, 'the left pupil should be visible to start with').not.toBeNull();

  const from = at(73, 120);
  const to = at(73, 150);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(from.x, from.y + ((to.y - from.y) * i) / 10);
  }
  await page.mouse.up();
  await page.waitForTimeout(400);

  const after = await pupilY();
  expect(after - before, 'the pupil should follow the drag downward').toBeGreaterThan(15);

  // The move is in the document, and its coordinates are exact tenths — tools/lark_pack.py asserts
  // that rather than rounding, so a drag that produced arbitrary floats would fail the export.
  const exported = await page.evaluate(async () => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = (blob) => { captured = blob; return 'blob:stub'; };
    const realClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function noop() {};
    document.querySelector('.titlebar button:last-of-type').click();
    HTMLAnchorElement.prototype.click = realClick;
    URL.createObjectURL = realCreate;
    return captured ? JSON.parse(await captured.text()) : null;
  });
  const p = exported.states['1b'].objs.pup_l.p;
  for (const v of p) {
    expect(Math.abs(Math.round(v * 10) - v * 10), `${v} must be an exact tenth`).toBeLessThan(1e-6);
  }

  // And one undo takes the whole gesture back, not one pixel of it.
  await page.locator('button:has-text("desfazer")').click();
  await page.waitForTimeout(400);
  expect(await pupilY(), 'one undo should restore the original position').toBeCloseTo(before, 0);
});

test('play restarts a one-shot clip that has run to the end', async ({ page }) => {
  // A finished one-shot leaves the playhead ON the end. Pressing play there used to start and stop
  // in the same frame, which looks like a dead button.
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await pickClip(page, 'blink');
  await page.waitForTimeout(300);

  const time = () => page.locator('.transport .time').textContent();
  await scrubber(page).fill('783');          // blink's own duration
  await page.waitForTimeout(200);
  expect((await time()).trim()).toBe('0.78s / 0.78s');

  await page.locator('button.play').click();
  await page.waitForTimeout(300);
  const mid = parseFloat((await time()).trim());
  expect(mid, 'play should rewind and run, not sit at the end').toBeGreaterThan(0);
  expect(mid, 'and still be partway through').toBeLessThan(0.78);
});

test('selecting a group boxes what it contains', async ({ page }) => {
  // Groups have no path of their own — `p` is [] on all three — so they get a bounding box drawn
  // around their descendants instead. The box comes from the ID PASS rather than from the group's
  // stored `b` or its children's raw paths: those describe the rest pose, while drawNode applies
  // the look, the turn and the running clip on the way to the screen, so a box from the data would
  // sit still while the eyes move.
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  // Where the eyes actually are, with a leaf selected so no box is in the way.
  await page.locator('.tree button', { hasText: /^\s*eye_l\s*$/ }).first().click();
  await page.waitForTimeout(400);
  const eyes = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, 240, 240).data;
    const cols = [];
    for (let x = 0; x < 240; x++) {
      let on = false;
      for (let y = 0; y < 240; y++) {
        const i = (y * 240 + x) * 4;
        if (d[i] > 24 || d[i + 1] > 24 || d[i + 2] > 24) { on = true; break; }
      }
      cols.push(on);
    }
    const blobs = [];
    let s = -1;
    for (let x = 0; x <= 240; x++) {
      const on = x < 240 && cols[x];
      if (on && s < 0) s = x;
      if (!on && s >= 0) { if (x - s >= 6) blobs.push([s, x - 1]); s = -1; }
    }
    return blobs;
  });
  expect(eyes.length, 'two eyes to bound').toBe(2);

  const whiteBox = () => page.evaluate(() => {
    const c = document.querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, 240, 240).data;
    let x0 = 240, x1 = -1;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) {
        const x = (i / 4) % 240;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
    return x1 < 0 ? null : { x0, x1 };
  });

  await page.locator('.tree button', { hasText: /^\s*group_eye_l\s*$/ }).first().click();
  await page.waitForTimeout(600);
  const left = await whiteBox();
  expect(left, 'a group selection should draw a box').not.toBeNull();
  // It bounds the LEFT eye only. The first version packed node ids into one channel at 16, 32, 48,
  // 64 — and antialiasing between 32 and 64 averages to exactly 48, another node's id. Those few
  // blended pixels stretched the left group's box across the whole pair. Ids now differ in all
  // three channels so no blend can impersonate one.
  expect(left.x0).toBeLessThanOrEqual(eyes[0][0]);
  expect(left.x1, 'the left group must not reach the right eye').toBeLessThan(eyes[1][0]);

  await page.locator('.tree button', { hasText: /^\s*group_eye_r\s*$/ }).first().click();
  await page.waitForTimeout(600);
  const right = await whiteBox();
  expect(right.x0, 'and the right group must not reach the left eye').toBeGreaterThan(eyes[0][1]);

  // `eyes` contains both groups, so its box spans the pair.
  await page.locator('.tree button', { hasText: /^\s*eyes\s*$/ }).first().click();
  await page.waitForTimeout(600);
  const both = await whiteBox();
  expect(both.x0).toBeLessThanOrEqual(eyes[0][0]);
  expect(both.x1).toBeGreaterThanOrEqual(eyes[1][1]);
});

test('a group shows no colour controls', async ({ page }) => {
  // A group paints nothing, so a swatch on it would be a control that does nothing.
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  await page.locator('.tree button', { hasText: /^\s*pup_l\s*$/ }).first().click();
  await page.waitForTimeout(300);
  await expect(page.locator('.colour-panel input[type="color"]'), 'a leaf has a swatch')
    .toHaveCount(1);

  await page.locator('.tree button', { hasText: /^\s*group_eye_l\s*$/ }).first().click();
  await page.waitForTimeout(300);
  await expect(page.locator('.colour-panel input[type="color"]'), 'a group does not')
    .toHaveCount(0);
  await expect(page.locator('.colour-panel')).toContainText('grupo');
});

test('alt-clicking the stage climbs to the containing group', async ({ page }) => {
  // Groups draw nothing, so the id pass can never return one — alt is the only way to reach
  // `eyes` or `group_eye_*` from the stage.
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(900);

  const box = await page.locator('canvas').boundingBox();
  const pt = {
    x: box.x + (73 / 240) * box.width,
    y: box.y + (120 / 240) * box.height,
  };
  const selected = () => page.locator('.colour-panel .prop b').textContent();

  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(350);
  expect(await selected(), 'a plain click picks the leaf').toBe('pup_l');

  const altClick = async () => {
    await page.keyboard.down('Alt');
    await page.mouse.click(pt.x, pt.y);
    await page.keyboard.up('Alt');
    await page.waitForTimeout(350);
  };

  await altClick();
  expect(await selected(), 'alt climbs to the direct parent').toBe('group_eye_l');
  await altClick();
  expect(await selected(), 'and again to the root group').toBe('eyes');
});

test('the editor imports nothing from outside the repository', () => {
  // A Vercel build failed with `Could not load /vercel/lilguy-fork/public/anim_data.json`: the app
  // aliased its scene data to a sibling directory that is checked in nowhere. It built on one
  // machine and could not build anywhere else — and no browser test could catch that, because the
  // dev server happily served the file that was there.
  //
  // So this is a source check rather than a behaviour one: nothing under editor/src may reach above
  // web-sim, and the Vite config may not alias a path outside it.
  const SRC = path.join(EDITOR, 'src');
  const offenders = [];

  for (const file of fs.readdirSync(SRC)) {
    if (!/\.(jsx?|css)$/.test(file)) continue;
    const text = fs.readFileSync(path.join(SRC, file), 'utf8');
    for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1] || m[2];
      if (!spec.startsWith('.')) continue;                 // a package, or an alias
      // `src/x` -> `..` is web-sim's own root, which is fine; `../..` leaves it.
      const resolved = path.resolve(SRC, spec.split('?')[0]);
      const rel = path.relative(path.join(EDITOR, '..'), resolved);
      if (rel.startsWith('..')) offenders.push(`${file}: ${spec}`);
    }
  }
  expect(offenders, 'these imports point outside web-sim').toEqual([]);

  // Strip comments before checking the config: the file EXPLAINS this rule, naming `lilguy-fork`
  // and `../../..` as the thing not to do, and a plain text search flags its own documentation.
  const config = fs.readFileSync(path.join(EDITOR, 'vite.config.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  expect(config, 'the config must not alias anything outside the repo').not.toMatch(/lilguy-fork/);
  expect(config, 'nor reach up past web-sim').not.toMatch(/\.\.\/\.\.\/\.\./);
});

test('manual look mode dials in a gaze without the mouse, and holds it', async ({ page }) => {
  // Stage's own pointer handler drives `look` on every pointermove and resets it to [0, 0] the
  // instant the cursor leaves the canvas — fine for "follow my mouse", useless for holding one
  // exact angle while working elsewhere in the editor. LookPad exists to bypass that entirely, so
  // the test that matters is not "typing a number moves the eyes" but "moving the mouse over the
  // stage afterward does NOT move them back".
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  const eyeCentroid = () => page.evaluate(() => {
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
    return n ? { x: sx / n, y: sy / n } : null;
  });

  const centred = await eyeCentroid();

  await page.getByText('controle manual').click();
  const xInput = page.locator('.lookpad-fields input').first();
  const yInput = page.locator('.lookpad-fields input').nth(1);
  await xInput.fill('1.8');
  await xInput.blur();
  await page.waitForTimeout(300);

  const dialedIn = await eyeCentroid();
  expect(dialedIn.x, 'typing an X value should move the drawing').toBeGreaterThan(centred.x + 10);

  // The part that actually matters: crossing the stage with the mouse must not undo it.
  const stageCanvas = page.locator('.bezel canvas');
  const box = await stageCanvas.boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(200);

  expect(await xInput.inputValue(), 'the field must not have been overwritten').toBe('1.8');
  const afterMouse = await eyeCentroid();
  expect(afterMouse.x, 'the drawing must not have snapped back').toBeGreaterThan(centred.x + 10);

  // Dragging the pad's own dot also works, and lands near the corner it was dropped on.
  const square = page.locator('.lookpad-square');
  const sbox = await square.boundingBox();
  await page.mouse.move(sbox.x + sbox.width * 0.05, sbox.y + sbox.height * 0.05);
  await page.mouse.down();
  await page.mouse.move(sbox.x + sbox.width * 0.05, sbox.y + sbox.height * 0.05);
  await page.mouse.up();
  await page.waitForTimeout(200);
  const xAfterDrag = parseFloat(await xInput.inputValue());
  const yAfterDrag = parseFloat(await yInput.inputValue());
  expect(xAfterDrag, 'dragging near the top-left corner sets a negative x').toBeLessThan(-1);
  expect(yAfterDrag, 'and a negative y').toBeLessThan(-1);

  // Turning manual mode off hands control back to the mouse.
  await page.getByText('controle manual').click();
  await expect(page.locator('.lookpad-square')).toHaveCount(0);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(200);
  const backToMouse = await eyeCentroid();
  // Centred pointer over the middle of the disc: the gaze should read close to neutral again,
  // not still pinned at the corner the pad was left on.
  expect(Math.abs(backToMouse.x - centred.x), 'mouse control should resume').toBeLessThan(30);
});

test('the selection box follows a node under a manual look, not just at rest', async ({ page }) => {
  // The bug this exists for: the selection ring was traced from the node's RAW path in the base
  // authoring-space transform, while the actual eye is drawn through drawNode's own chain of
  // translate/scale/rotate for the look, the turn and the pair's convergence. At look=[0,0] those
  // two agree closely enough to look right; away from centre they diverge, and the ring was seen
  // floating over empty background while the real eye sat elsewhere on the disc entirely.
  //
  // Fixed by reading the box from the id pass (the same mechanism click-to-select uses) rather than
  // recomputing the transform by hand, so this checks that the drawn selection box actually
  // overlaps the node's own colour on screen, under a gaze extreme enough to expose the old bug.
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  // eye_l is selected by default; drive the look hard down-left, which is where the divergence was
  // photographed: the box sat near the panel centre while the eye migrated into the top-left corner.
  await page.getByText('controle manual').click();
  const xInput = page.locator('.lookpad-fields input').first();
  const yInput = page.locator('.lookpad-fields input').nth(1);
  await xInput.fill('-2');
  await xInput.blur();
  await yInput.fill('-2');
  await yInput.blur();
  await page.waitForTimeout(300);

  const overlap = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const isWhiteDash = (i) => d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200 && d[i + 3] > 0;
    const isEyeInk = (i) => d[i + 1] > 120 && d[i] < 160 && !isWhiteDash(i);   // the mint eye colour

    // The selection box outline: its own bounding rectangle in pixel space.
    let bx0 = c.width, by0 = c.height, bx1 = -1, by1 = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (!isWhiteDash(i)) continue;
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
    }
    if (bx1 < 0) return { hasBox: false };

    // Does any eye-coloured ink fall inside that rectangle? If the box is floating over empty
    // background while the eye sits elsewhere, this is false.
    let inkInsideBox = 0;
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const i = (y * c.width + x) * 4;
        if (isEyeInk(i)) inkInsideBox++;
      }
    }
    return { hasBox: true, inkInsideBox };
  });

  expect(overlap.hasBox, 'a selection box should be drawn').toBe(true);
  expect(overlap.inkInsideBox, 'the box must overlap the eye it outlines, not float over background')
    .toBeGreaterThan(20);
});
