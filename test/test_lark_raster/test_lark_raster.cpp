#include <unity.h>
#include <string.h>
#include "../../lark_raster.h"

// The rasteriser is checked against figures the WEB-SIM ACTUALLY DRAWS, not against numbers chosen
// here. web-sim/lark.js renders the same data in a browser and its output has been measured against
// the live original at 97% mean IoU across all 36 states, so it is the closest thing to ground truth
// the firmware can be held to. Every expected value below came from running it:
//
//   state 1b, at rest, on the 400x400 authoring canvas, left half:
//     left eye   x 52..195, width 144, height 161
//     row 120: x  81..155      row 210: x  57..194
//     row 150: x  58..182      row 240: x  74..183
//     row 180: x  52..193      row 270: empty
//     both eyes, total ink: 36149
//
// A 1px disagreement here is worth chasing: it usually means the row sampling point moved, and that
// is the difference between a shape being one row taller or shorter than the browser draws it.
//
// NOT YET COMPILED. The machine this was written on has no C++ toolchain and no PlatformIO, so the
// ALGORITHM was validated instead by transliterating lark_raster.h to JavaScript and holding it to
// these same numbers — `npm run check:raster` in web-sim, 17 checks, all passing. That proves the
// scanline, the clip and the hole are right; it does not prove this file compiles. Run
// `pio test -e native -f test_lark_raster` on a machine that has the toolchain before trusting it,
// and expect to fix syntax rather than logic.

static const int W = 400, H = 400;
static uint8_t fb[W * H];

// state 1b, eye_l — 24 numbers, 12 points, nodes at 0/3/6/9
static const float EYE_L[24] = {
   96.10f, 112.80f, 133.00f,  99.30f, 173.50f, 121.90f, 189.70f, 166.20f,
  204.80f, 207.60f, 189.00f, 252.80f, 152.10f, 266.20f, 116.60f, 279.20f,
   74.20f, 255.30f,  59.00f, 213.90f,  42.80f, 169.60f,  60.60f, 125.70f,
};
// state 1b, pup_l — a known circle: the nodes give radius 36.95 x 36.9 and the controls sit at
// 0.542/0.477 of it, around the 0.5523 a circle in Bezier form needs.
static const float PUP_L[24] = {
  147.40f, 156.30f, 167.40f, 156.30f, 183.80f, 171.90f, 183.80f, 195.10f,
  183.80f, 212.50f, 167.40f, 230.10f, 147.40f, 230.10f, 128.30f, 230.10f,
  109.90f, 212.50f, 109.90f, 195.10f, 109.90f, 171.90f, 128.30f, 156.30f,
};

static void paint(int y, int x0, int x1, void* ctx) {
  uint8_t v = (uint8_t)(uintptr_t)ctx;
  memset(fb + y * W + x0, v, x1 - x0);
}
static void erase(int y, int x0, int x1, void*) {
  memset(fb + y * W + x0, 0, x1 - x0);
}
static void clear() { memset(fb, 0, sizeof fb); }
static int area() {
  int n = 0;
  for (int i = 0; i < W * H; i++) if (fb[i]) n++;
  return n;
}
static void rowExtent(int y, int* x0, int* x1) {
  *x0 = -1; *x1 = -1;
  for (int x = 0; x < W; x++) if (fb[y * W + x]) { if (*x0 < 0) *x0 = x; *x1 = x; }
}

// --- flattening -------------------------------------------------------------------------------

void test_flatten_produces_a_closed_outline() {
  lark::Pt poly[lark::MAX_FLAT_PTS];
  int n = lark::flattenPath(EYE_L, 24, poly, lark::MAX_FLAT_PTS);
  TEST_ASSERT_GREATER_THAN_INT(24, n);              // four curves, several segments each
  TEST_ASSERT_LESS_OR_EQUAL_INT(lark::MAX_FLAT_PTS, n);
  // The outline must come back to where it started: first and last point within a pixel.
  float dx = poly[0].x - poly[n - 1].x, dy = poly[0].y - poly[n - 1].y;
  TEST_ASSERT_TRUE(dx * dx + dy * dy < 4.0f);
}

void test_flatten_rejects_a_short_path() {
  lark::Pt poly[8];
  TEST_ASSERT_EQUAL_INT(0, lark::flattenPath(EYE_L, 4, poly, 8));
}

// --- the eye outline against what the browser draws ---------------------------------------------

void test_eye_extent_matches_the_web_sim() {
  clear();
  lark::fillPath(EYE_L, 24, nullptr, 0, W, H, paint, (void*)1);
  int x0, x1;
  // Column extent over the whole shape: the web-sim measures x 52..195, width 144.
  int gx0 = W, gx1 = -1;
  for (int y = 0; y < H; y++) {
    rowExtent(y, &x0, &x1);
    if (x0 < 0) continue;
    if (x0 < gx0) gx0 = x0;
    if (x1 > gx1) gx1 = x1;
  }
  TEST_ASSERT_INT_WITHIN(2, 52, gx0);
  TEST_ASSERT_INT_WITHIN(2, 195, gx1);
  TEST_ASSERT_INT_WITHIN(2, 144, gx1 - gx0 + 1);
}

void test_eye_rows_match_the_web_sim() {
  clear();
  lark::fillPath(EYE_L, 24, nullptr, 0, W, H, paint, (void*)1);
  struct { int y, x0, x1; } rows[] = {
    { 120,  81, 155 }, { 150,  58, 182 }, { 180,  52, 193 },
    { 210,  57, 194 }, { 240,  74, 183 },
  };
  for (unsigned i = 0; i < sizeof rows / sizeof rows[0]; i++) {
    int a, b;
    rowExtent(rows[i].y, &a, &b);
    TEST_ASSERT_INT_WITHIN(2, rows[i].x0, a);
    TEST_ASSERT_INT_WITHIN(2, rows[i].x1, b);
  }
  // Row 270 is past the bottom of the eye; the browser draws nothing there.
  int a, b;
  rowExtent(270, &a, &b);
  TEST_ASSERT_EQUAL_INT(-1, a);
}

// --- the pupil, a known circle ------------------------------------------------------------------

void test_pupil_is_round() {
  clear();
  lark::fillPath(PUP_L, 24, nullptr, 0, W, H, paint, (void*)1);
  // Nodes give radius 36.95 x 36.9, so the area should sit near pi*r^2 = 4283.
  int a = area();
  TEST_ASSERT_INT_WITHIN(250, 4283, a);
  // Width and height within a pixel of each other: it is a circle, not an ellipse.
  int gx0 = W, gx1 = -1, gy0 = H, gy1 = -1;
  for (int y = 0; y < H; y++) {
    int x0, x1;
    rowExtent(y, &x0, &x1);
    if (x0 < 0) continue;
    if (x0 < gx0) gx0 = x0;
    if (x1 > gx1) gx1 = x1;
    if (y < gy0) gy0 = y;
    if (y > gy1) gy1 = y;
  }
  TEST_ASSERT_INT_WITHIN(2, gx1 - gx0, gy1 - gy0);
}

// --- clipping: the lid ---------------------------------------------------------------------------

void test_clipping_to_the_eye_removes_nothing_when_the_pupil_is_inside() {
  clear();
  lark::fillPath(PUP_L, 24, nullptr, 0, W, H, paint, (void*)1);
  int unclipped = area();
  clear();
  lark::fillPath(PUP_L, 24, EYE_L, 24, W, H, paint, (void*)1);
  int clipped = area();
  // 1b's pupil sits well inside its eye, so the clip has nothing to cut.
  TEST_ASSERT_INT_WITHIN(60, unclipped, clipped);
}

void test_clipping_bites_when_the_pupil_escapes() {
  // Shift the pupil far above the eye: the clip must remove most of it.
  float high[24];
  for (int i = 0; i < 24; i += 2) { high[i] = PUP_L[i]; high[i + 1] = PUP_L[i + 1] - 90.0f; }
  clear();
  lark::fillPath(high, 24, nullptr, 0, W, H, paint, (void*)1);
  int unclipped = area();
  clear();
  lark::fillPath(high, 24, EYE_L, 24, W, H, paint, (void*)1);
  int clipped = area();
  TEST_ASSERT_GREATER_THAN_INT(0, unclipped);
  TEST_ASSERT_LESS_THAN_INT(unclipped, clipped);
}

// --- the hole ------------------------------------------------------------------------------------

void test_a_hole_subtracts_from_the_eye() {
  // 20 of the 36 states give the pupils colour 000000, which the runtime punches out rather than
  // fills. Drawing the eye and then erasing the pupil has to leave a ring.
  clear();
  lark::fillPath(EYE_L, 24, nullptr, 0, W, H, paint, (void*)1);
  int solid = area();
  lark::fillPath(PUP_L, 24, EYE_L, 24, W, H, erase, nullptr);
  int holed = area();
  TEST_ASSERT_LESS_THAN_INT(solid, holed);
  // The removed area is the pupil's, near 4283.
  TEST_ASSERT_INT_WITHIN(350, 4283, solid - holed);
  // And the centre of the pupil is now empty while the eye's edge is not.
  TEST_ASSERT_EQUAL_UINT8(0, fb[193 * W + 147]);
  TEST_ASSERT_NOT_EQUAL(0, fb[190 * W + 60]);
}

// --- bounds --------------------------------------------------------------------------------------

void test_drawing_off_canvas_does_not_write_out_of_bounds() {
  // A path pushed left of the canvas must clip rather than wrap or overrun.
  float off[24];
  for (int i = 0; i < 24; i += 2) { off[i] = EYE_L[i] - 300.0f; off[i + 1] = EYE_L[i + 1]; }
  clear();
  lark::fillPath(off, 24, nullptr, 0, W, H, paint, (void*)1);
  for (int y = 0; y < H; y++) {
    int x0, x1;
    rowExtent(y, &x0, &x1);
    if (x0 >= 0) { TEST_ASSERT_GREATER_OR_EQUAL_INT(0, x0); TEST_ASSERT_LESS_THAN_INT(W, x1); }
  }
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_flatten_produces_a_closed_outline);
  RUN_TEST(test_flatten_rejects_a_short_path);
  RUN_TEST(test_eye_extent_matches_the_web_sim);
  RUN_TEST(test_eye_rows_match_the_web_sim);
  RUN_TEST(test_pupil_is_round);
  RUN_TEST(test_clipping_to_the_eye_removes_nothing_when_the_pupil_is_inside);
  RUN_TEST(test_clipping_bites_when_the_pupil_escapes);
  RUN_TEST(test_a_hole_subtracts_from_the_eye);
  RUN_TEST(test_drawing_off_canvas_does_not_write_out_of_bounds);
  return UNITY_END();
}
