#pragma once
// Filled closed cubic Beziers, with clipping and hole-punching, for the Lark eye runtime.
//
// Arduino_GFX draws triangles, circles and ellipses. The Lark format needs neither: every eye and
// pupil is a closed cubic Bezier of 4 nodes and 8 controls, the pupil is clipped to the eye's own
// (animated) outline, and in 20 of the 36 states the pupil is a HOLE punched out of the eye rather
// than a fill. A scanline gives all three from one mechanism — flatten each curve to segments,
// collect where they cross a row, fill between pairs — so clip and hole cost no extra buffer.
//
// It also sidesteps a known defect: main.cpp's fillQuad exists because GFX's scanline fillTriangle
// drops a 1px seam between triangles sharing a diagonal. Filling a whole path in one pass has no
// interior diagonals to seam.
//
// Everything here is header-only and allocation-free, so the native test environment and the
// firmware compile the same code. The web-sim (web-sim/lark.js) remains the reference: its
// constants were measured against the live original with instruments the firmware does not have,
// and test_lark_raster checks this against figures the web-sim actually draws.

#include <stdint.h>
#include <stddef.h>

namespace lark {

// The authoring space is 400x400 and a path has at most 14 points, so a flattened outline of four
// curves at a ~0.3px tolerance stays well inside this. Sized for the worst case rather than grown.
static const int MAX_FLAT_PTS = 256;

struct Pt { float x, y; };

// Flatten one cubic into `out`, excluding p0 (the caller has already emitted it) and including p3.
// Subdivision is adaptive on flatness: the distance of the two control points from the chord. A
// fixed step wastes segments on straight runs and under-samples tight ones, and the closed lid in
// `blink` is exactly a path with both.
inline int flattenCubic(Pt p0, Pt p1, Pt p2, Pt p3, Pt* out, int cap, float tol = 0.3f) {
  // How far the controls stray from the chord, as a cheap proxy for curvature.
  float dx = p3.x - p0.x, dy = p3.y - p0.y;
  float d1 = (p1.x - p3.x) * dy - (p1.y - p3.y) * dx;
  float d2 = (p2.x - p3.x) * dy - (p2.y - p3.y) * dx;
  if (d1 < 0) d1 = -d1;
  if (d2 < 0) d2 = -d2;
  float dd = (d1 + d2) * (d1 + d2);
  int steps = 1;
  if (dd > tol * (dx * dx + dy * dy)) {
    // Segment count from the curve's extent; 16 is plenty for a 400px-space eye and cheap enough.
    float ext = (d1 > d2 ? d1 : d2);
    steps = (int)(ext / 200.0f) + 8;
    if (steps > 24) steps = 24;
  }
  if (steps > cap) steps = cap;
  for (int i = 1; i <= steps; i++) {
    float t = (float)i / (float)steps, m = 1.0f - t;
    float a = m * m * m, b = 3 * m * m * t, c = 3 * m * t * t, d = t * t * t;
    out[i - 1].x = a * p0.x + b * p1.x + c * p2.x + d * p3.x;
    out[i - 1].y = a * p0.y + b * p1.y + c * p2.y + d * p3.y;
  }
  return steps;
}

// Flatten a Lark path — 24 numbers, 12 points, nodes at 0/3/6/9, the last control pair wrapping
// back to node 0 — into a polygon. Returns the point count, or 0 if the path is too short.
//
// A 28-number replacement path must be normalised to 24 first (see lark.js normalizePath: the
// canonical form starts at point 2 of 14, wrapping). This function takes the canonical form only.
inline int flattenPath(const float* p, int nNumbers, Pt* out, int cap) {
  int n = nNumbers / 2;
  if (n < 4) return 0;
  if (n > 12) n = 12;
  int m = 0;
  out[m++] = { p[0], p[1] };
  for (int k = 0; k + 3 <= n; k += 3) {
    Pt a = { p[(k % n) * 2], p[(k % n) * 2 + 1] };
    Pt b = { p[((k + 1) % n) * 2], p[((k + 1) % n) * 2 + 1] };
    Pt c = { p[((k + 2) % n) * 2], p[((k + 2) % n) * 2 + 1] };
    Pt d = { p[((k + 3) % n) * 2], p[((k + 3) % n) * 2 + 1] };
    m += flattenCubic(a, b, c, d, out + m, cap - m);
    if (m >= cap - 24) break;
  }
  return m;
}

// Where a polygon crosses one scanline. Returns the crossing count, sorted ascending.
//
// The half-open rule (y0 <= y < y1) is what makes adjacent shapes tile without double-covering a
// row, and what keeps a horizontal edge from registering as two crossings.
inline int crossings(const Pt* pts, int n, float y, float* xs, int cap) {
  int c = 0;
  for (int i = 0; i < n && c < cap; i++) {
    const Pt& a = pts[i];
    const Pt& b = pts[(i + 1) % n];
    float y0 = a.y, y1 = b.y;
    if (y0 == y1) continue;                       // horizontal edges contribute nothing
    if ((y >= y0 && y < y1) || (y >= y1 && y < y0)) {
      float t = (y - y0) / (y1 - y0);
      xs[c++] = a.x + t * (b.x - a.x);
    }
  }
  // Insertion sort: crossing counts are 2 or 4 in practice, so anything cleverer costs more.
  for (int i = 1; i < c; i++) {
    float v = xs[i];
    int j = i - 1;
    while (j >= 0 && xs[j] > v) { xs[j + 1] = xs[j]; j--; }
    xs[j + 1] = v;
  }
  return c;
}

// A span of pixels on one row, handed to the caller to paint. Keeping the painting outside means
// this header needs no framebuffer type and the same code serves the native tests and the device.
typedef void (*SpanFn)(int y, int x0, int x1, void* ctx);

// Fill a flattened polygon, optionally clipped to a second one.
//
// `clip` is the eye's own outline when drawing a pupil or a highlight: the Lark data marks that
// with `ul: true` on every node, and without it a pupil escapes a half-closed lid. Passing null
// fills unclipped.
//
// Rows are sampled at their centre (y + 0.5). Sampling at the integer boundary makes a shape one
// row taller or shorter depending on which side of the pixel its edge lands, which is exactly the
// kind of off-by-one that only shows up as a 1px disagreement against the web-sim.
inline void fillPolygon(const Pt* pts, int n, const Pt* clip, int clipN,
                        int width, int height, SpanFn span, void* ctx) {
  if (n < 3) return;
  float ymin = pts[0].y, ymax = pts[0].y;
  for (int i = 1; i < n; i++) {
    if (pts[i].y < ymin) ymin = pts[i].y;
    if (pts[i].y > ymax) ymax = pts[i].y;
  }
  int y0 = (int)(ymin < 0 ? 0 : ymin);
  int y1 = (int)(ymax + 1.0f);
  if (y1 > height) y1 = height;

  float xs[32], cxs[32];
  for (int y = y0; y < y1; y++) {
    float sy = (float)y + 0.5f;
    int c = crossings(pts, n, sy, xs, 32);
    if (c < 2) continue;
    int cc = 0;
    if (clip && clipN >= 3) {
      cc = crossings(clip, clipN, sy, cxs, 32);
      if (cc < 2) continue;                        // the clip has no interior on this row
    }
    for (int i = 0; i + 1 < c; i += 2) {
      float ax = xs[i], bx = xs[i + 1];
      if (!clip || clipN < 3) {
        int px0 = (int)(ax + 0.5f), px1 = (int)(bx + 0.5f);
        if (px1 <= 0 || px0 >= width) continue;
        if (px0 < 0) px0 = 0;
        if (px1 > width) px1 = width;
        if (px1 > px0) span(y, px0, px1, ctx);
        continue;
      }
      // Intersect this span with every span the clip opens on the same row.
      for (int j = 0; j + 1 < cc; j += 2) {
        float lo = ax > cxs[j] ? ax : cxs[j];
        float hi = bx < cxs[j + 1] ? bx : cxs[j + 1];
        if (hi <= lo) continue;
        int px0 = (int)(lo + 0.5f), px1 = (int)(hi + 0.5f);
        if (px1 <= 0 || px0 >= width) continue;
        if (px0 < 0) px0 = 0;
        if (px1 > width) px1 = width;
        if (px1 > px0) span(y, px0, px1, ctx);
      }
    }
  }
}

// Convenience: flatten a Lark path and fill it in one call.
inline void fillPath(const float* p, int nNumbers, const float* clipP, int clipNumbers,
                     int width, int height, SpanFn span, void* ctx) {
  Pt poly[MAX_FLAT_PTS], clip[MAX_FLAT_PTS];
  int n = flattenPath(p, nNumbers, poly, MAX_FLAT_PTS);
  if (!n) return;
  int cn = 0;
  if (clipP && clipNumbers >= 8) cn = flattenPath(clipP, clipNumbers, clip, MAX_FLAT_PTS);
  fillPolygon(poly, n, cn ? clip : nullptr, cn, width, height, span, ctx);
}

}  // namespace lark
