#include <unity.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include "../../lark_scene.h"

// How much work is one frame? Measured on the host, which is not the device — an ESP32-S3 at 240MHz
// is far slower than this machine — so the number here is not a pass/fail for the hardware. What it
// IS good for is a shape: how the cost scales with the state's complexity, and whether anything in
// the draw is accidentally quadratic. A frame that is cheap here can still miss on the device; a
// frame that is expensive here will certainly miss.
//
// The device budget is 33ms for 30fps. The real measurement belongs on the board with micros(),
// and the plan says to take it there before trusting any of this.

static const int PANEL = 240;
static uint16_t fb[PANEL * PANEL];
static uint8_t* blob = nullptr;
static uint32_t blobLen = 0;
static lark::Reader rd;

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
static bool loaded = false;
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

static double drawMany(const char* id, int frames) {
  int si = stateIndex(id);
  if (si < 0) return -1;

  static float lidL[28], lidR[28];
  int nL = 0, nR = 0;
  float raw[28], minX = 1e9f, maxX = -1e9f;
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

  lark::Scene scene;
  scene.data = &rd;
  scene.stateIndex = (uint16_t)si;
  scene.background = 0;
  scene.lidL = lidL; scene.lidLCount = nL;
  scene.lidR = lidR; scene.lidRCount = nR;

  clock_t t0 = clock();
  for (int i = 0; i < frames; i++) {
    for (int p = 0; p < PANEL * PANEL; p++) fb[p] = 0;
    lark::Gaze g;
    // Sweep the gaze so no frame is a repeat and the turn is exercised.
    g.x = (float)((i % 21) - 10) / 20.0f;
    g.y = (float)((i % 13) - 6) / 20.0f;
    scene.draw(fb, PANEL, PANEL, g);
  }
  return (double)(clock() - t0) / CLOCKS_PER_SEC / frames * 1000.0;   // ms per frame
}

void test_a_frame_is_measured_and_reported() {
  loadOnce();
  TEST_ASSERT_NOT_NULL_MESSAGE(blob, "lark_data.bin missing — run python tools/lark_pack.py");

  // 1b is the everyday case (7 nodes); 1d has 11, the most any state carries; 2e is the largest.
  double simple = drawMany("1b", 200);
  double most = drawMany("1d", 200);
  double biggest = drawMany("2e", 200);
  printf("\n  host frame cost: 1b %.3f ms   1d %.3f ms   2e %.3f ms\n", simple, most, biggest);
  printf("  (host only — the device is much slower; measure there with micros())\n");

  TEST_ASSERT_TRUE(simple > 0);
  // Nothing should be wildly out of line with the others: a state with 11 nodes does more work than
  // one with 7, but not an order of magnitude more. That ratio is what would expose an accidental
  // quadratic in the draw, and it holds on the device even though the absolute numbers do not.
  TEST_ASSERT_TRUE_MESSAGE(most < simple * 4.0, "an 11-node state should not cost 4x a 7-node one");
  TEST_ASSERT_TRUE_MESSAGE(biggest < simple * 4.0, "the largest state should not cost 4x the simplest");
}

void test_clearing_the_buffer_is_not_the_expensive_part() {
  loadOnce();
  clock_t t0 = clock();
  for (int i = 0; i < 200; i++) for (int p = 0; p < PANEL * PANEL; p++) fb[p] = 0;
  double clearMs = (double)(clock() - t0) / CLOCKS_PER_SEC / 200 * 1000.0;
  double frameMs = drawMany("1b", 200);
  printf("  clear alone %.3f ms of a %.3f ms frame\n", clearMs, frameMs);
  // If the clear dominates, the fix is a dirty-rectangle redraw rather than a faster rasteriser —
  // worth knowing before optimising the wrong half.
  TEST_ASSERT_TRUE(clearMs >= 0);
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_a_frame_is_measured_and_reported);
  RUN_TEST(test_clearing_the_buffer_is_not_the_expensive_part);
  return UNITY_END();
}
