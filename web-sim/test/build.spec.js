// Two things this guards.
//
// 1. The generated page is in sync with its sources. If someone edits lark.js and forgets to rebuild,
//    or edits lark-artifact.html directly, this fails — which is the whole point of generating it.
// 2. The generated page actually RUNS. A textual match proves nothing on its own: the strip could
//    produce valid-looking JS that throws on load, and the published artifact would be a blank canvas.
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ARTIFACT = path.join(ROOT, 'lark-artifact.html');

test('lark-artifact.html is up to date with its sources', () => {
  const before = fs.readFileSync(ARTIFACT, 'utf8');
  execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build-artifact.js')], { cwd: ROOT });
  const after = fs.readFileSync(ARTIFACT, 'utf8');
  expect(
    after,
    'lark-artifact.html is stale or was hand-edited — run `npm run build` and commit the result'
  ).toBe(before);
});

test('the generated page loads and renders', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:8794/lark-artifact.html', { waitUntil: 'load' });

  // Give the render loop a couple of frames.
  await page.waitForFunction(() => {
    const c = document.querySelector('#stage');
    if (!c) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 16) return true;
    return false;
  }, null, { timeout: 10000 });

  expect(errors, `the page threw on load:\n  ${errors.join('\n  ')}`).toEqual([]);

  // The controls the page is for: all 36 states selectable, and clip buttons present.
  expect(await page.locator('#state option').count()).toBe(36);
  expect(await page.locator('#clips button').count()).toBeGreaterThan(0);

  // The gaze actually responds to a pointer. Everything above passes on a page whose pointer wiring
  // is dead — and that is not hypothetical: a redeclared const in the page wiring once threw at load
  // and left a blank canvas, and separately the eyes moved 6px where the reference moves 47 while
  // every other check stayed green. A few px of travel is enough to catch both.
  const drawnX0 = () => page.evaluate(() => {
    const c = document.querySelector('#stage');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let x = 0; x < c.width; x++) {
      for (let y = 0; y < c.height; y++) if (d[(y * c.width + x) * 4 + 3] > 16) return x;
    }
    return -1;
  });
  const box = await page.locator('#stage').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
  const centred = await drawnX0();
  await page.mouse.move(box.x + box.width / 2 + 400, box.y + box.height / 2);
  await page.waitForTimeout(300);
  const deflected = await drawnX0();
  expect(
    deflected - centred,
    `the gaze barely moved for a 400px pointer offset (${centred} -> ${deflected}); ` +
    `is the pointer wiring live and is LOOK_TRAVEL_X sane?`
  ).toBeGreaterThan(5);

  // The colour controls reach the drawing. Worth a gate because the interesting case is silent: in
  // the 20 states whose pupil is the data's 000000 the renderer punches a hole rather than filling,
  // and a colour asked for there has to override that or the picker looks broken in most states.
  const topColour = () => page.evaluate(() => {
    const c = document.querySelector('#stage');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const n = {};
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] <= 16) continue;
      const k = [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
      n[k] = (n[k] || 0) + 1;
    }
    return Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  });

  // 1a: white eye, hole pupil — the case an override has to be able to fill.
  await page.evaluate(() => {
    const s = document.getElementById('state');
    s.value = '1a';
    s.dispatchEvent(new Event('change'));
    const set = (id, v) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input')); };
    set('cEye', '#1040ff');
    set('cPupL', '#ffcc00');
  });
  await page.waitForTimeout(400);
  const [eyeHex] = await topColour();
  expect(eyeHex, 'the eye colour picker did not reach the canvas').toBe('1040ff');
  const filledPupil = await page.evaluate(() => {
    const c = document.querySelector('#stage');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i+3] > 16 && d[i] > 0xe0 && d[i+1] > 0xb0 && d[i+2] < 0x40) n++;
    }
    return n;
  });
  expect(filledPupil, 'a pupil the data draws as a hole was not filled by the picker').toBeGreaterThan(20);

  // Reset restores the data's own colours, hole included.
  await page.evaluate(() => document.getElementById('cReset').click());
  await page.waitForTimeout(400);
  const [resetHex] = await topColour();
  expect(resetHex, 'reset did not restore the state colours').toBe('ffffff');

  // No module syntax survived — it would have thrown above, but say so explicitly.
  const html = await page.content();
  expect(/^\s*(export|import)\s/m.test(html)).toBe(false);
});
