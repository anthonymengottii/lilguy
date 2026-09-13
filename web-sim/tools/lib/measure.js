// The only sanctioned way to measure a rendered eye. Two hard-won rules are enforced here rather
// than left to each harness, because both were learned by publishing wrong numbers.
//
// RULE 1 — COLUMN SCAN, NEVER FLOOD FILL.
// The gap between the two eyes is 9.2px. Under antialiasing any flood fill merges them into one
// blob at deflection, and every width it reports is garbage. That produced three wrong diagnoses in
// an earlier session: the 3D turn was called unimplemented when it already worked, a "collapse" of
// state 6a was the previous check's deflected pointer, and a "fusion" of the eyes was blamed on a
// squash that did not cause it. Scanning column by column, within one half of the canvas, measures
// correctly. There is no flood fill anywhere in this repo and there should never be one.
//
// RULE 2 — BACKING STORE, NEVER CSS PIXELS.
// lark-artifact.html sets canvas width="372" but styles it max-width:420px, so a getBoundingClientRect
// reading is inflated by 420/372 = 1.129. That single factor is the whole of the README's former
// "our resting inter-eye gap is 168 against the reference's 152, the eyes are ~11% larger" finding:
// 168 / 1.129 = 148.8, and the data's own gap is 151.62. There was never a scale bug in the runtime.
// captureBackingStore reads getImageData over canvas.width/height and records the CSS ratio in its
// result, so a future inflation shows up in the output instead of hiding in it.
//
// RULE 3 — MILLISECONDS, NEVER SAMPLE COUNTS.
// Comparing our t=250 against the reference's global minimum compares different moments. Counting
// samples across two pages that read at different rates (7399 against 3315 in one window) supports
// no conclusion at all. Every harness names explicit ms offsets and uses the same ones on both sides.

const INK_ALPHA = 16; // a pixel counts as ink above this alpha, to ignore antialiasing fringe

// Read a canvas' BACKING STORE pixels. Returns {w, h, data, cssRatio} where cssRatio is the CSS
// width divided by the backing width — 1 when they agree, and the thing to check first when a
// measurement looks ~13% too big.
// The alpha channel is thresholded INSIDE the page and the mask comes back base64-packed, one bit
// per pixel. Serialising the raw RGBA array instead means 640,000 JSON numbers per capture, and a
// 36-state sweep takes 14 of those per state just to find the open frame — which turned a baseline
// run into a ten-minute job. Only the mask is ever needed; the colour never is.
export async function captureBackingStore(page, selector = 'canvas') {
  const shot = await page.evaluate(([sel, inkAlpha]) => {
    const c = document.querySelector(sel);
    if (!c) throw new Error(`no canvas matching ${sel}`);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const n = c.width * c.height;
    const bytes = new Uint8Array(Math.ceil(n / 8));
    let area = 0;
    for (let i = 0; i < n; i++) {
      if (img.data[i * 4 + 3] > inkAlpha) {
        bytes[i >> 3] |= 1 << (i & 7);
        area++;
      }
    }
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return { w: c.width, h: c.height, cssW: c.getBoundingClientRect().width, area, packed: btoa(s) };
  }, [selector, INK_ALPHA]);
  return {
    w: shot.w,
    h: shot.h,
    area: shot.area,
    packed: shot.packed,
    cssRatio: +(shot.cssW / shot.w).toFixed(4),
  };
}

// A binary ink mask over a capture. 1 = ink, 0 = background.
export function inkMask({ w, h, packed }) {
  const bytes = Buffer.from(packed, 'base64');
  const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  return { w, h, m };
}

// Intersection over union of two masks of the same dimensions.
export function iou(a, b) {
  if (a.w !== b.w || a.h !== b.h) {
    throw new Error(`mask size mismatch: ${a.w}x${a.h} vs ${b.w}x${b.h}`);
  }
  let inter = 0, union = 0;
  for (let i = 0; i < a.m.length; i++) {
    const x = a.m[i], y = b.m[i];
    if (x | y) union++;
    if (x & y) inter++;
  }
  return union ? +(inter / union).toFixed(4) : 0;
}

// Tight bounding box of the ink, or null when the mask is empty.
export function bbox({ w, h, m }) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// RULE 1. Per-column first/last ink row, restricted to one half of the canvas.
//
// `half` is 'l', 'r' or 'all'. Restricting to a half is what keeps the two eyes from being read as
// one shape: at full deflection their outlines come within a couple of pixels of each other, and any
// measure that spans the midline merges them.
//
// Returns { cols, x0, x1, width, centreX, height, meanThickness, colSd } where `cols` is the raw
// per-column [top, bottom] array so a harness can do its own statistics.
export function columnScan({ w, h, m }, half = 'all') {
  const mid = Math.floor(w / 2);
  const from = half === 'r' ? mid : 0;
  const to = half === 'l' ? mid : w;
  const cols = [];
  let x0 = -1, x1 = -1;
  for (let x = from; x < to; x++) {
    let top = -1, bottom = -1;
    for (let y = 0; y < h; y++) {
      if (!m[y * w + x]) continue;
      if (top < 0) top = y;
      bottom = y;
    }
    if (top < 0) continue;
    if (x0 < 0) x0 = x;
    x1 = x;
    cols.push({ x, top, bottom, thickness: bottom - top + 1 });
  }
  if (!cols.length) {
    return { cols, x0: null, x1: null, width: 0, centreX: null, height: 0, meanThickness: 0, colSd: 0 };
  }
  const th = cols.map((c) => c.thickness);
  const mean = th.reduce((a, b) => a + b, 0) / th.length;
  const sd = Math.sqrt(th.reduce((a, b) => a + (b - mean) ** 2, 0) / th.length);
  const tops = cols.map((c) => c.top), bottoms = cols.map((c) => c.bottom);
  return {
    cols,
    x0,
    x1,
    width: x1 - x0 + 1,
    centreX: +((x0 + x1) / 2).toFixed(2),
    height: Math.max(...bottoms) - Math.min(...tops) + 1,
    meanThickness: +mean.toFixed(2),
    colSd: +sd.toFixed(2),
  };
}

// Split the drawing into its separate ink blobs by finding the columns with no ink between them, and
// return each one's own box. Use this, not a per-half scan, for anything that measures a single eye.
//
// RULE 1 says never to flood fill, and this is not one: it is a column-occupancy scan, which is the
// same measurement columnScan makes, asking where the gaps are instead of assuming one at the midline.
// That assumption is wrong under deflection and it produced a second round of bad numbers after the
// flood-fill round. A per-half scan reported the eye nearer the pointer NARROWING to 133 while the
// far one widened; measured as blobs the truth is the opposite and much larger — the receding eye
// goes to 98 while the advancing one holds its width and lengthens. A whole turn model was fitted to
// the clipped version before the blobs showed it backwards.
//
// Returns [] when the shapes have merged into one blob, which is itself a finding: the reference's
// eyes never merge, staying 131.5px apart even at full deflection.
export function inkBlobs({ w, h, m }, minWidth = 20) {
  const occupied = new Array(w).fill(0);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) if (m[y * w + x]) { occupied[x] = 1; break; }
  }
  const runs = [];
  let start = -1;
  for (let x = 0; x < w; x++) {
    if (occupied[x]) { if (start < 0) start = x; }
    else if (start >= 0) { runs.push([start, x - 1]); start = -1; }
  }
  if (start >= 0) runs.push([start, w - 1]);
  return runs
    .filter(([a, b]) => b - a >= minWidth)
    .map(([x0, x1]) => {
      let y0 = h, y1 = -1;
      for (let x = x0; x <= x1; x++) {
        for (let y = 0; y < h; y++) if (m[y * w + x]) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      return { x0, x1, w: x1 - x0 + 1, h: y1 - y0 + 1, cx: +((x0 + x1) / 2).toFixed(2) };
    });
}

// Distance between the two eyes' centres, and each eye's own box.
//
// Measured from blobs rather than canvas halves — see inkBlobs. Falls back to the per-half scan when
// the two have merged, so the caller still gets a number, but `merged` says the per-eye figures are
// then a split-at-the-midline approximation and not the shapes themselves.
export function interEyeGap(mask) {
  const blobs = inkBlobs(mask);
  if (blobs.length === 2) {
    const [l, r] = blobs;
    return {
      gap: +(r.cx - l.cx).toFixed(2),
      centreL: l.cx, centreR: r.cx,
      widthL: l.w, widthR: r.w,
      heightL: l.h, heightR: r.h,
      merged: false,
    };
  }
  const l = columnScan(mask, 'l');
  const r = columnScan(mask, 'r');
  if (l.centreX === null || r.centreX === null) return null;
  return {
    gap: +(r.centreX - l.centreX).toFixed(2),
    centreL: l.centreX, centreR: r.centreX,
    widthL: l.width, widthR: r.width,
    heightL: l.height, heightR: r.height,
    merged: true,
  };
}

// Total ink area, for the coarse "did this state collapse" check that caught 6a falling from 21363
// to 2400 under a reverted per-node squash.
export function inkArea({ m }) {
  let n = 0;
  for (let i = 0; i < m.length; i++) n += m[i];
  return n;
}

// Translate a mask by whole pixels. Used only to separate a SHAPE error from a PLACEMENT one.
export function shiftMask({ w, h, m }, dx, dy) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= w) continue;
      out[y * w + x] = m[sy * w + sx];
    }
  }
  return { w, h, m: out };
}

// The reference's WASM paints the scene 5px higher in its 400x400 box than the data's own
// coordinates put it. It is a constant: identical across states, independent of gaze, and it
// survives every clip. Nothing in animation_renderer_web.js applies a transform — the canvas is a
// plain 400x400 with no scale and no translate — so the offset lives inside the opaque renderer, and
// it is placement, not geometry.
//
// Reporting raw IoU therefore understates fidelity badly: state 1b scores 0.931 raw and 0.989 once
// the 5px is taken out, with eye widths already matching to the pixel (144/144). alignedIoU searches
// a small window and returns both numbers plus the offset it found, so a genuine shape regression
// (which no shift can rescue) stays visible while this known constant stops drowning it.
// Searched as two 1-D passes rather than a full grid: the offset is a pure translation, so x and y
// are separable, and a 17x17 grid over a 400x400 mask is 46M pixel comparisons per state — slow
// enough that a 36-state sweep stops being something you re-run freely.
export function alignedIoU(simMask, refMask, radius = 8) {
  const raw = iou(simMask, refMask);
  let best = { iou: raw, dx: 0, dy: 0 };
  for (let dy = -radius; dy <= radius; dy++) {
    const score = iou(shiftMask(simMask, 0, dy), refMask);
    if (score > best.iou) best = { iou: score, dx: 0, dy };
  }
  for (let dx = -radius; dx <= radius; dx++) {
    const score = iou(shiftMask(simMask, dx, best.dy), refMask);
    if (score > best.iou) best = { iou: score, dx, dy: best.dy };
  }
  return { raw, aligned: best.iou, dx: best.dx, dy: best.dy };
}
