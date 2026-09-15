// No C++ compiler here, so validate the SCANLINE LOGIC by transliterating lark_raster.h to JS and
// holding it to the same targets the C++ test uses. If the algorithm is wrong this catches it; the
// C++ syntax still needs a real build before it can be trusted.
const W = 400, H = 400;
const fb = new Uint8Array(W * H);

const EYE_L = [96.10,112.80,133.00,99.30,173.50,121.90,189.70,166.20,204.80,207.60,189.00,252.80,
               152.10,266.20,116.60,279.20,74.20,255.30,59.00,213.90,42.80,169.60,60.60,125.70];
const PUP_L = [147.40,156.30,167.40,156.30,183.80,171.90,183.80,195.10,183.80,212.50,167.40,230.10,
               147.40,230.10,128.30,230.10,109.90,212.50,109.90,195.10,109.90,171.90,128.30,156.30];

function flattenCubic(p0, p1, p2, p3, out, tol = 0.3) {
  const dx = p3.x - p0.x, dy = p3.y - p0.y;
  let d1 = Math.abs((p1.x - p3.x) * dy - (p1.y - p3.y) * dx);
  let d2 = Math.abs((p2.x - p3.x) * dy - (p2.y - p3.y) * dx);
  const dd = (d1 + d2) * (d1 + d2);
  let steps = 1;
  if (dd > tol * (dx * dx + dy * dy)) {
    const ext = Math.max(d1, d2);
    steps = Math.min(24, Math.floor(ext / 200) + 8);
  }
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, m = 1 - t;
    const a = m*m*m, b = 3*m*m*t, c = 3*m*t*t, d = t*t*t;
    out.push({ x: a*p0.x + b*p1.x + c*p2.x + d*p3.x, y: a*p0.y + b*p1.y + c*p2.y + d*p3.y });
  }
}
function flattenPath(p) {
  let n = p.length / 2;
  if (n < 4) return [];
  if (n > 12) n = 12;
  const out = [{ x: p[0], y: p[1] }];
  for (let k = 0; k + 3 <= n; k += 3) {
    const g = (i) => ({ x: p[(i % n) * 2], y: p[(i % n) * 2 + 1] });
    flattenCubic(g(k), g(k+1), g(k+2), g(k+3), out);
  }
  return out;
}
function crossings(pts, y) {
  const xs = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    if (a.y === b.y) continue;
    if ((y >= a.y && y < b.y) || (y >= b.y && y < a.y)) {
      xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
    }
  }
  return xs.sort((u, v) => u - v);
}
function fillPolygon(pts, clip, span) {
  if (pts.length < 3) return;
  let ymin = pts[0].y, ymax = pts[0].y;
  for (const q of pts) { if (q.y < ymin) ymin = q.y; if (q.y > ymax) ymax = q.y; }
  const y0 = Math.max(0, Math.floor(ymin)), y1 = Math.min(H, Math.floor(ymax + 1));
  for (let y = y0; y < y1; y++) {
    const sy = y + 0.5;
    const xs = crossings(pts, sy);
    if (xs.length < 2) continue;
    let cxs = null;
    if (clip) { cxs = crossings(clip, sy); if (cxs.length < 2) continue; }
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const ax = xs[i], bx = xs[i + 1];
      if (!cxs) { emit(y, ax, bx, span); continue; }
      for (let j = 0; j + 1 < cxs.length; j += 2) {
        const lo = Math.max(ax, cxs[j]), hi = Math.min(bx, cxs[j + 1]);
        if (hi > lo) emit(y, lo, hi, span);
      }
    }
  }
}
function emit(y, ax, bx, span) {
  let p0 = Math.round(ax), p1 = Math.round(bx);
  if (p1 <= 0 || p0 >= W) return;
  p0 = Math.max(0, p0); p1 = Math.min(W, p1);
  if (p1 > p0) span(y, p0, p1);
}
const fill = (p, clip, v) => fillPolygon(flattenPath(p), clip ? flattenPath(clip) : null,
  (y, x0, x1) => fb.fill(v, y * W + x0, y * W + x1));
const clear = () => fb.fill(0);
const area = () => { let n = 0; for (let i = 0; i < fb.length; i++) if (fb[i]) n++; return n; };
const rowExtent = (y) => { let a = -1, b = -1; for (let x = 0; x < W; x++) if (fb[y*W+x]) { if (a < 0) a = x; b = x; } return [a, b]; };

let pass = 0, fail = 0;
const check = (name, ok, got, want) => {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '   got ' + got + ', want ' + want); }
};

console.log('flattening');
const poly = flattenPath(EYE_L);
check('outline has enough segments', poly.length > 24, poly.length, '>24');
const d = Math.hypot(poly[0].x - poly[poly.length-1].x, poly[0].y - poly[poly.length-1].y);
check('outline closes', d < 2, d.toFixed(2), '<2');

console.log('\neye against the web-sim (x 52..195, width 144)');
clear(); fill(EYE_L, null, 1);
let gx0 = W, gx1 = -1;
for (let y = 0; y < H; y++) { const [a,b] = rowExtent(y); if (a < 0) continue; gx0 = Math.min(gx0,a); gx1 = Math.max(gx1,b); }
check('left edge', Math.abs(gx0 - 52) <= 2, gx0, 52);
check('right edge', Math.abs(gx1 - 195) <= 2, gx1, 195);
check('width', Math.abs((gx1-gx0+1) - 144) <= 2, gx1-gx0+1, 144);

console.log('\nrows against the web-sim');
for (const [y, wx0, wx1] of [[120,81,155],[150,58,182],[180,52,193],[210,57,194],[240,74,183]]) {
  const [a,b] = rowExtent(y);
  check(`row ${y}`, Math.abs(a-wx0) <= 2 && Math.abs(b-wx1) <= 2, `${a}..${b}`, `${wx0}..${wx1}`);
}
const [e] = rowExtent(270);
check('row 270 empty', e === -1, e, -1);

console.log('\npupil is a circle (r 36.95, area ~4283)');
clear(); fill(PUP_L, null, 1);
const pa = area();
check('area', Math.abs(pa - 4283) <= 250, pa, 4283);

console.log('\nclipping');
clear(); fill(PUP_L, null, 1); const unclipped = area();
clear(); fill(PUP_L, EYE_L, 1); const clipped = area();
check('pupil inside the eye survives the clip', Math.abs(unclipped - clipped) <= 60, clipped, unclipped);
const high = PUP_L.map((v, i) => i % 2 ? v - 90 : v);
clear(); fill(high, null, 1); const hu = area();
clear(); fill(high, EYE_L, 1); const hc = area();
check('pupil escaping the lid is cut', hc < hu, hc, '<' + hu);

console.log('\nhole');
clear(); fill(EYE_L, null, 1); const solid = area();
fillPolygon(flattenPath(PUP_L), flattenPath(EYE_L), (y,x0,x1) => fb.fill(0, y*W+x0, y*W+x1));
const holed = area();
check('hole removes the pupil', Math.abs((solid - holed) - 4283) <= 350, solid - holed, 4283);
check('pupil centre is empty', fb[193*W+147] === 0, fb[193*W+147], 0);
check('eye edge is not', fb[190*W+60] !== 0, fb[190*W+60], '!=0');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
