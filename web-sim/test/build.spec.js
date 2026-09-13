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

  // No module syntax survived — it would have thrown above, but say so explicitly.
  const html = await page.content();
  expect(/^\s*(export|import)\s/m.test(html)).toBe(false);
});
