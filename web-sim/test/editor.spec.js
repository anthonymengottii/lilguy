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

const clipSelect = (page) => page.locator('.right select').first();
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

test('playing a blink closes the eyes', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await clipSelect(page).selectOption('blink');
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
  await clipSelect(page).selectOption('blink');
  await page.waitForTimeout(300);
  await scrubber(page).fill('0');          // wide open: the pupils are fully visible
  await page.waitForTimeout(250);

  const before = await snapshot(page);

  // Find a pupil SCALE lane and blow it up. Scale at a wide-open moment changes the drawing in a
  // way nothing else could account for.
  const rows = page.locator('.lane');
  const count = await rows.count();
  let edited = false;
  for (let i = 0; i < count; i++) {
    const name = await rows.nth(i).locator('.lane-name').textContent();
    if (!/escala/.test(name)) continue;
    await rows.nth(i).locator('.key').first().click();
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

test('the clip list holds the shipped clips', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(600);
  const names = await clipSelect(page).locator('option').allTextContents();
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
