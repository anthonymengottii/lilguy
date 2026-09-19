#include <unity.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../lark.h"

// The runtime, held to values web-sim/lark.js produces for the same inputs. Those were printed by
// running the JS directly, not derived by hand, so a divergence here means the port drifted rather
// than that someone's arithmetic slipped.
//
// The four readings most worth guarding, because each was wrong once and each failed silently:
//   curve 0 holds its SOURCE           — a step; the pupil is there and then it is not
//   a segment takes the EARLIER curve  — the other way made blinks 480ms instead of 240
//   the replacement path rotates by 2  — offset 0 left a lumpy ribbon where the original is flat
//   rest values are per-keypath        — 1 for a scale or opacity, 0 for a translation

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
static bool findClip(const char* want, lark::Reader::Clip& out) {
  char name[16];
  for (uint16_t c = 0; c < rd.clipCount(); c++) {
    rd.clipName(c, name, sizeof name);
    if (strcmp(name, want) == 0) return rd.clip(c, out);
  }
  return false;
}
// Lanes address nodes by id since version 2 of the packed data -- names were dropped, which is what
// left `rot` and `rot3d` unable to find the groups they drive.
static bool findLane(const lark::Reader::Clip& clip, uint8_t kp, uint8_t target,
                     lark::Reader::Lane& out) {
  for (uint8_t i = 0; i < clip.laneCount; i++) {
    lark::Reader::Lane l;
    clip.lane(i, l);
    if (l.keypath == kp && l.target == target) { out = l; return true; }
  }
  return false;
}

// --- curves ---------------------------------------------------------------------------------------

void test_curves_match_the_js() {
  // Printed from lark.js: c0 is flat at 0 (a step holding its source), c14 an ease-out, c24 an
  // ease-in-out.
  TEST_ASSERT_FLOAT_WITHIN(1e-5, 0.0f, lark::curveAt(0, 0.0f));
  TEST_ASSERT_FLOAT_WITHIN(1e-5, 0.0f, lark::curveAt(0, 0.75f));
  TEST_ASSERT_FLOAT_WITHIN(1e-5, 0.0f, lark::curveAt(0, 1.0f));

  TEST_ASSERT_FLOAT_WITHIN(1e-5, 0.578125f, lark::curveAt(14, 0.25f));
  TEST_ASSERT_FLOAT_WITHIN(1e-5, 0.875000f, lark::curveAt(14, 0.50f));
  TEST_ASSERT_FLOAT_WITHIN(1e-5, 0.984375f, lark::curveAt(14, 0.75f));

  TEST_ASSERT_FLOAT_WITHIN(1e-5, 0.125000f, lark::curveAt(24, 0.25f));
  TEST_ASSERT_FLOAT_WITHIN(1e-5, 0.500000f, lark::curveAt(24, 0.50f));
  TEST_ASSERT_FLOAT_WITHIN(1e-5, 0.875000f, lark::curveAt(24, 0.75f));

  // An id the table does not carry falls through to the ease-in-out, as curveFn does.
  TEST_ASSERT_FLOAT_WITHIN(1e-5, lark::curveAt(24, 0.3f), lark::curveAt(99, 0.3f));
}

// --- the step, in the lane that exposed it -----------------------------------------------------------

void test_blink_pupil_opacity_steps_rather_than_fades() {
  loadOnce();
  lark::Reader::Clip clip;
  TEST_ASSERT_TRUE(findClip("blink", clip));
  lark::Reader::Lane lane;
  TEST_ASSERT_TRUE(findLane(clip, lark::KP_O, lark::NODE_PUP_L, lane));

  // From lark.js: 1 through t=233, 0 at 250 and 280, back to 1 at 300.
  // Curve 0 read as a jump-to-target instead would give 0 from t=151.
  const uint16_t ts[] = {0, 150, 200, 233, 250, 280, 300, 400};
  const float want[] = {1, 1, 1, 1, 0, 0, 1, 1};
  for (unsigned i = 0; i < sizeof ts / sizeof ts[0]; i++) {
    lark::Channel ch;
    lark::sampleLane(lane, ts[i], nullptr, 0, ch);
    TEST_ASSERT_TRUE(ch.present);
    TEST_ASSERT_FLOAT_WITHIN_MESSAGE(0.002f, want[i], ch.v[0], "opacity");
  }
}

// --- the lid morph ------------------------------------------------------------------------------------

void test_lid_morph_matches_the_js() {
  loadOnce();
  lark::Reader::Clip clip;
  TEST_ASSERT_TRUE(findClip("blink", clip));
  lark::Reader::Lane lane;
  TEST_ASSERT_TRUE(findLane(clip, lark::KP_P, lark::NODE_EYE_L, lane));

  // 1b's eye_l rest pose, which the `u: true` keyframes resolve to.
  static const float REST[24] = {
     96.10f, 112.80f, 133.00f,  99.30f, 173.50f, 121.90f, 189.70f, 166.20f,
    204.80f, 207.60f, 189.00f, 252.80f, 152.10f, 266.20f, 116.60f, 279.20f,
     74.20f, 255.30f,  59.00f, 213.90f,  42.80f, 169.60f,  60.60f, 125.70f,
  };
  // A DELIBERATE DIVERGENCE FROM THE JS, at t=250. lark.js's morphPath returns the raw keyframe at
  // u >= 1, so the browser sees 28 numbers there and tracePath normalises them on the way to the
  // canvas. This port normalises at the morph's endpoints instead, so the same sample is already
  // canonical at 24.
  //
  // The pixels are identical either way: normalizePath is idempotent — normalising the canonical
  // form returns it unchanged — so normalising early and again at draw time gives what normalising
  // once at draw time gives. Doing it here means every path leaving sampleLane has one shape, which
  // is worth more on a device where the next stage has no room to re-check.
  struct { uint16_t t; float x, y; int n; } want[] = {
    {   0,  96.100f, 112.800f, 24 },
    { 125, 113.800f, 178.050f, 24 },
    { 250, 131.500f, 243.300f, 24 },   // the JS reports 71.6,223.8 over 28 — see above
    { 400, 109.235f, 161.220f, 24 },
    { 600,  97.533f, 118.082f, 24 },
    { 783,  96.100f, 112.800f, 24 },
  };
  for (unsigned i = 0; i < sizeof want / sizeof want[0]; i++) {
    lark::Channel ch;
    lark::sampleLane(lane, want[i].t, REST, 24, ch);
    TEST_ASSERT_TRUE(ch.present);
    TEST_ASSERT_EQUAL_INT(want[i].n, ch.pathCount);
    TEST_ASSERT_FLOAT_WITHIN(0.06f, want[i].x, ch.path[0]);
    TEST_ASSERT_FLOAT_WITHIN(0.06f, want[i].y, ch.path[1]);
  }
}

// --- path normalisation ---------------------------------------------------------------------------------

void test_replacement_path_rotates_by_two() {
  // From lark.js: the raw 28-number path starts 71.6 223.8 191.4 247.2 131.5 243.3, and its
  // canonical form starts 131.5 243.3 192.3 243.3 191.4 215.1 — point 2 of 14, wrapping.
  static const float RAW[28] = {
     71.6f, 223.8f, 191.4f, 247.2f, 131.5f, 243.3f, 192.3f, 243.3f,
    191.4f, 215.1f, 191.4f, 226.5f, 191.4f, 237.9f, 164.6f, 247.2f,
    131.5f, 247.2f,  98.5f, 247.2f,  71.6f, 237.9f,  71.6f, 226.5f,
     71.6f, 215.1f,  70.7f, 243.3f,
  };
  float out[28];
  int n = lark::normalizePath(RAW, 28, out);
  TEST_ASSERT_EQUAL_INT(24, n);
  const float want[6] = { 131.5f, 243.3f, 192.3f, 243.3f, 191.4f, 215.1f };
  for (int i = 0; i < 6; i++) TEST_ASSERT_FLOAT_WITHIN(0.06f, want[i], out[i]);

  // A 24-number path passes through untouched — the identity that keeps every state pose intact.
  float in24[24], out24[24];
  for (int i = 0; i < 24; i++) in24[i] = (float)i * 3.5f;
  TEST_ASSERT_EQUAL_INT(24, lark::normalizePath(in24, 24, out24));
  for (int i = 0; i < 24; i++) TEST_ASSERT_EQUAL_FLOAT(in24[i], out24[i]);
}

// --- the turn -----------------------------------------------------------------------------------------------

void test_turn_matches_the_measured_reference() {
  // Measured as separate ink blobs, looking right, against a 144x162 rest:
  //   receding (away, s=+1): width 0.688 of rest, height 0.920
  //   advancing (near, s=-1): width ~1.0, height 1.099
  lark::Turn away = lark::turnFactors(1.0f, 1.0f, 1.0f, true);
  TEST_ASSERT_FLOAT_WITHIN(0.02f, 0.684f, away.sx);       // 1 - 0.2113 - 0.1043
  TEST_ASSERT_FLOAT_WITHIN(0.02f, 0.920f, away.sy);       // 1 - 0.1014 + 0.0212

  lark::Turn near = lark::turnFactors(-1.0f, 1.0f, 1.0f, true);
  TEST_ASSERT_FLOAT_WITHIN(0.02f, 0.994f, near.sx);       // 1 + 0.185 - 0.1908
  TEST_ASSERT_FLOAT_WITHIN(0.02f, 1.099f, near.sy);       // 1 + 0.1107 - 0.0122

  // At rest nothing moves.
  lark::Turn still = lark::turnFactors(0.0f, 1.0f, 1.0f, true);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 1.0f, still.sx);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 1.0f, still.sy);

  // scaleWidth off leaves width alone but still turns the height — the look path used to need this.
  lark::Turn noW = lark::turnFactors(1.0f, 1.0f, 1.0f, false);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 1.0f, noW.sx);
  TEST_ASSERT_FLOAT_WITHIN(0.02f, 0.920f, noW.sy);
}

void test_turn_is_clamped_against_collapse() {
  // A per-node scale once took state 6a's drawn area from 21363 to 2400. Nothing the coefficients
  // can produce may go below half.
  for (float s = -4.0f; s <= 4.0f; s += 0.5f) {
    lark::Turn t = lark::turnFactors(s, 0.1f, 0.1f, true);
    TEST_ASSERT_TRUE(t.sx >= 0.5f);
    TEST_ASSERT_TRUE(t.sy >= 0.5f);
  }
}

// --- the vertical look ----------------------------------------------------------------------------------------

void test_lift_squashes_and_is_asymmetric() {
  // Measured: looking up takes the height to 0.796 of rest, down to 0.815, and the pair's spacing
  // opens looking down while closing looking up.
  lark::Lift rest = lark::liftFactors(0.0f);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 1.0f, rest.h);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 1.0f, rest.gap);

  lark::Lift up = lark::liftFactors(-0.667f);
  lark::Lift down = lark::liftFactors(0.667f);
  TEST_ASSERT_TRUE(up.h < 1.0f);
  TEST_ASSERT_TRUE(down.h < 1.0f);
  TEST_ASSERT_TRUE(up.h < down.h);                 // up squashes harder
  TEST_ASSERT_TRUE(up.gap < 1.0f);                 // looking up pulls the pair together
  TEST_ASSERT_TRUE(down.gap > 1.0f);               // looking down spreads it

  // Beyond the fitted range it saturates rather than running away.
  lark::Lift far = lark::liftFactors(-3.0f);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, up.h, far.h);
}

// --- convergence ------------------------------------------------------------------------------------------------

void test_convergence_pulls_in_as_the_gaze_swings() {
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 0.0f, lark::convergePull(0.0f));
  float half = lark::convergePull(0.277f);
  float full = lark::convergePull(0.554f);
  TEST_ASSERT_TRUE(full > half);
  TEST_ASSERT_TRUE(half > 0.0f);
  // At full deflection the pair closes from 152 to about 126.5, a pull near 0.168.
  TEST_ASSERT_FLOAT_WITHIN(0.02f, 0.1325f, full);
  // Symmetric: looking left pulls as much as looking right.
  TEST_ASSERT_FLOAT_WITHIN(1e-5, full, lark::convergePull(-0.554f));
}

// --- t3d --------------------------------------------------------------------------------------------------------

void test_t3d_mirrored_anchors_give_both_eyes_the_same_sign() {
  // rot3d_2 ships anc [1,0] with ang -0.17 on the left group and [-1,0] with +0.17 on the right.
  // Both must come out +1: one head turning, not two eyes diverging.
  float l = lark::t3dDeflection(-0.17f, 1.0f);
  float r = lark::t3dDeflection(0.17f, -1.0f);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 1.0f, l);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 1.0f, r);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 0.0f, lark::t3dDeflection(0.0f, 1.0f));
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_curves_match_the_js);
  RUN_TEST(test_blink_pupil_opacity_steps_rather_than_fades);
  RUN_TEST(test_lid_morph_matches_the_js);
  RUN_TEST(test_replacement_path_rotates_by_two);
  RUN_TEST(test_turn_matches_the_measured_reference);
  RUN_TEST(test_turn_is_clamped_against_collapse);
  RUN_TEST(test_lift_squashes_and_is_asymmetric);
  RUN_TEST(test_convergence_pulls_in_as_the_gaze_swings);
  RUN_TEST(test_t3d_mirrored_anchors_give_both_eyes_the_same_sign);
  return UNITY_END();
}
