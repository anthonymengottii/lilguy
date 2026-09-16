#include <unity.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../lark_scene.h"

// A whole state, drawn on a 240x240 panel, held to what the published web-sim page draws at the same
// scale. Those figures came from measuring that page, not from arithmetic here:
//
//   state 1b: ink 15364, eyes 93x105 + 93x105, gap 98.0
//   state 1a: ink 15197, eyes 93x105 + 94x105, gap 98.5   (white eye, HOLE pupil)
//   state 6e: ink  6449, eyes 94x70  + 94x70,  gap 99.0   (flat lid, hole pupil that overshoots it)
//
// 1a and 6e matter more than 1b here: both punch their pupils rather than filling them, and 6e's
// pupil pokes 77px above its eye in the data, so it only looks right if the lid clip bites.

static const int PANEL = 240;
static uint16_t fb[PANEL * PANEL];
static uint8_t* blob = nullptr;
static uint32_t blobLen = 0;
static lark::Reader rd;
static bool loaded = false;

void setUp() {}
void tearDown() {}

static uint8_t* slurp(const char* path, uint32_t* len) {
  FILE* f = fopen(path, "rb");
  if (!f) return nullptr;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  uint8_t* buf = (uint8_t*)malloc(n);
  size_t got = fread(buf, 1, n, f);
  fclose(f);
  *len = (uint32_t)got;
  return buf;
}
static void loadOnce() {
  if (loaded) return;
  loaded = true;
  blob = slurp("lark_data.bin", &blobLen);
  if (!blob) blob = slurp("../../lark_data.bin", &blobLen);
  if (blob) rd.open(blob, blobLen);
}
static int stateIndex(const char* want) {
  char name[16];
  for (uint16_t s = 0; s < rd.stateCount(); s++) {
    rd.stateName(s, name, sizeof name);
    if (strcmp(name, want) == 0) return (int)s;
  }
  return -1;
}

// The panel starts as background; ink is anything that is not.
static const uint16_t BG = 0x0000;
static void clear() { for (int i = 0; i < PANEL * PANEL; i++) fb[i] = BG; }
static int inkArea() {
  int n = 0;
  for (int i = 0; i < PANEL * PANEL; i++) if (fb[i] != BG) n++;
  return n;
}
// Split the drawing into its separate ink blobs by finding the empty columns between them. A scan
// that assumes a gap at the midline clips a deflected eye — web-sim learned that the hard way and
// the measurement it produced sent a whole turn model the wrong way round.
static int blobs(int* w, int* h, float* cx, int cap) {
  bool occupied[PANEL];
  for (int x = 0; x < PANEL; x++) {
    occupied[x] = false;
    for (int y = 0; y < PANEL; y++) if (fb[y * PANEL + x] != BG) { occupied[x] = true; break; }
  }
  int found = 0, start = -1;
  for (int x = 0; x <= PANEL; x++) {
    bool on = x < PANEL && occupied[x];
    if (on && start < 0) start = x;
    if (!on && start >= 0) {
      if (x - start >= 20 && found < cap) {
        int y0 = PANEL, y1 = -1;
        for (int xx = start; xx < x; xx++)
          for (int y = 0; y < PANEL; y++)
            if (fb[y * PANEL + xx] != BG) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
        w[found] = x - start;
        h[found] = y1 - y0 + 1;
        cx[found] = (start + x - 1) * 0.5f;
        found++;
      }
      start = -1;
    }
  }
  return found;
}

static void drawState(const char* id, float lookX, float lookY) {
  loadOnce();
  int si = stateIndex(id);
  TEST_ASSERT_GREATER_OR_EQUAL_INT_MESSAGE(0, si, id);
  clear();
  lark::Scene scene;
  scene.data = &rd;
  scene.stateIndex = (uint16_t)si;
  scene.background = BG;

  // At rest the lid is each eye's own rest pose. Collect them by side, the way the runtime would
  // when no clip is driving `p`.
  static float lidL[28], lidR[28];
  int nL = 0, nR = 0;
  float minX = 1e9f, maxX = -1e9f, raw[28];
  {
    lark::Reader::StateIter it = rd.state((uint16_t)si);
    lark::Reader::Node n;
    while (it.next(n)) {
      if (!n.pathCount) continue;
      int m = n.toFloats(raw, 28);
      for (int i = 0; i < m; i += 2) { if (raw[i] < minX) minX = raw[i]; if (raw[i] > maxX) maxX = raw[i]; }
    }
  }
  float mid = (minX + maxX) * 0.5f;
  {
    lark::Reader::StateIter it = rd.state((uint16_t)si);
    lark::Reader::Node n;
    while (it.next(n)) {
      if (n.kind != lark::KIND_EYE || !n.pathCount) continue;
      int m = n.toFloats(raw, 28);
      float cx, cy, w, h;
      lark::pathExtent(raw, m, &cx, &cy, &w, &h);
      if (cx > mid) { nR = m; for (int i = 0; i < m; i++) lidR[i] = raw[i]; }
      else          { nL = m; for (int i = 0; i < m; i++) lidL[i] = raw[i]; }
    }
  }
  scene.lidL = lidL; scene.lidLCount = nL;
  scene.lidR = lidR; scene.lidRCount = nR;

  lark::Gaze g;
  g.x = lookX;
  g.y = lookY;
  scene.draw(fb, PANEL, PANEL, g);
}

void test_1b_at_rest_matches_the_panel() {
  drawState("1b", 0, 0);
  int w[4], h[4];
  float cx[4];
  int n = blobs(w, h, cx, 4);
  TEST_ASSERT_EQUAL_INT_MESSAGE(2, n, "the two eyes should be separate blobs");
  TEST_ASSERT_INT_WITHIN_MESSAGE(4, 93, w[0], "left eye width");
  TEST_ASSERT_INT_WITHIN_MESSAGE(4, 105, h[0], "left eye height");
  TEST_ASSERT_INT_WITHIN_MESSAGE(4, 93, w[1], "right eye width");
  TEST_ASSERT_INT_WITHIN_MESSAGE(4, 105, h[1], "right eye height");
  TEST_ASSERT_FLOAT_WITHIN_MESSAGE(5.0f, 98.0f, cx[1] - cx[0], "inter-eye gap");
  TEST_ASSERT_INT_WITHIN(1200, 15364, inkArea());
}

void test_1a_punches_its_pupil() {
  // 1a is a white eye with a 000000 pupil. If the hole is read as black it fills instead, and the
  // ink comes out HIGHER than the reference rather than lower.
  drawState("1a", 0, 0);
  int solid = inkArea();
  TEST_ASSERT_INT_WITHIN(1200, 15197, solid);

  // There is a hole inside the left eye: a run of background with ink on both sides of it. Searched
  // for rather than sampled at a guessed pixel — 1a's pupil is 15x19 in scene units, under 10x13 on
  // the panel, and an earlier version of this test poked at a row it does not even cover.
  int w[4], h[4];
  float cx[4];
  TEST_ASSERT_EQUAL_INT(2, blobs(w, h, cx, 4));
  int leftStart = (int)(cx[0] - w[0] / 2.0f), leftEnd = (int)(cx[0] + w[0] / 2.0f);
  bool holeFound = false;
  for (int y = 0; y < PANEL && !holeFound; y++) {
    bool seenInk = false, seenGapAfterInk = false;
    for (int x = leftStart; x <= leftEnd && x < PANEL; x++) {
      uint16_t v = fb[y * PANEL + x];
      if (v != BG) {
        if (seenGapAfterInk) { holeFound = true; break; }   // ink, gap, ink on one row
        seenInk = true;
      } else if (seenInk) {
        seenGapAfterInk = true;
      }
    }
  }
  TEST_ASSERT_TRUE_MESSAGE(holeFound, "the pupil should be punched out of the eye, leaving a hole");
}

void test_6e_clips_a_pupil_that_overshoots_its_lid() {
  // 6e's pupil reaches 77px above its eye in the data. Without the lid clip the drawing is much
  // taller than the flat eye it belongs to.
  drawState("6e", 0, 0);
  int w[4], h[4];
  float cx[4];
  int n = blobs(w, h, cx, 4);
  TEST_ASSERT_EQUAL_INT(2, n);
  TEST_ASSERT_INT_WITHIN_MESSAGE(5, 70, h[0], "6e is a flat lid; an unclipped pupil makes it tall");
  TEST_ASSERT_INT_WITHIN_MESSAGE(5, 94, w[0], "6e eye width");
  TEST_ASSERT_INT_WITHIN(900, 6449, inkArea());
}

void test_the_gaze_moves_the_drawing() {
  drawState("1b", 0, 0);
  int w[4], h[4];
  float cx0[4];
  blobs(w, h, cx0, 4);
  float restGap = cx0[1] - cx0[0];

  drawState("1b", 0.554f, 0);
  int w2[4], h2[4];
  float cx1[4];
  TEST_ASSERT_EQUAL_INT(2, blobs(w2, h2, cx1, 4));

  // Looking right: the drawing shifts right, the pair converges, and the receding (right) eye
  // narrows while the advancing one does not.
  TEST_ASSERT_TRUE_MESSAGE(cx1[0] > cx0[0], "the drawing should move with the gaze");
  TEST_ASSERT_TRUE_MESSAGE(cx1[1] - cx1[0] < restGap, "the pair should converge");
  TEST_ASSERT_TRUE_MESSAGE(w2[1] < w[1], "the receding eye should narrow");
}

void test_looking_up_raises_the_drawing() {
  // The squash pivots on the edge the gaze heads away from. Pivoting always at the bottom made the
  // top edge stop climbing and come back — the eyes read as centring instead of looking up.
  int tops[3];
  const float looks[3] = { 0.0f, -0.3f, -0.6f };
  for (int i = 0; i < 3; i++) {
    drawState("1b", 0, looks[i]);
    int t = PANEL;
    for (int y = 0; y < PANEL && t == PANEL; y++)
      for (int x = 0; x < PANEL; x++)
        if (fb[y * PANEL + x] != BG) { t = y; break; }
    tops[i] = t;
  }
  TEST_ASSERT_TRUE_MESSAGE(tops[1] < tops[0], "looking up should raise the top edge");
  TEST_ASSERT_TRUE_MESSAGE(tops[2] < tops[1], "and keep raising it, not fold back");
}

void test_nothing_is_drawn_outside_the_panel() {
  // The disc is what the hardware shows; writing past the buffer is the failure that would not be
  // visible until it corrupted something else.
  for (float lx = -1.0f; lx <= 1.0f; lx += 0.5f)
    for (float ly = -1.0f; ly <= 1.0f; ly += 0.5f) {
      drawState("2e", lx, ly);              // 2e is the largest state
      TEST_ASSERT_TRUE(inkArea() > 0);
    }
  // Reaching here without a crash or a sanitiser trip is the assertion.
  TEST_ASSERT_TRUE(true);
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_1b_at_rest_matches_the_panel);
  RUN_TEST(test_1a_punches_its_pupil);
  RUN_TEST(test_6e_clips_a_pupil_that_overshoots_its_lid);
  RUN_TEST(test_the_gaze_moves_the_drawing);
  RUN_TEST(test_looking_up_raises_the_drawing);
  RUN_TEST(test_nothing_is_drawn_outside_the_panel);
  return UNITY_END();
}
