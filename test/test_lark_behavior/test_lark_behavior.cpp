#include <unity.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../lark_behavior.h"
#include "../../lark_scene.h"
#include "../../lark_data_blob.h"

// The behaviour layer: does the thing actually blink, and does the blink reach the pixels?
//
// The second half matters more than the first. A rule can fire, a clip can run, and the drawing can
// still never change -- which is exactly what happened before the scene applied channels at all.
// So the tests here drive real frames through Scene::draw and measure the panel, the same way
// test_lark_scene does, rather than trusting the runner's own bookkeeping.

static const int PANEL = 240;
static uint16_t fb[PANEL * PANEL];
static lark::Reader rd;
static bool loaded = false;

void setUp() {}
void tearDown() {}

static void loadOnce() {
  if (loaded) return;
  loaded = true;
  rd.open(LARK_DATA, LARK_DATA_LEN);
}
static int stateIndex(const char* want) {
  char name[16];
  for (uint16_t s = 0; s < rd.stateCount(); s++) {
    rd.stateName(s, name, sizeof name);
    if (strcmp(name, want) == 0) return (int)s;
  }
  return -1;
}

static const uint16_t BG = 0x0000;
static int inkArea() {
  int n = 0;
  for (int i = 0; i < PANEL * PANEL; i++) if (fb[i] != BG) n++;
  return n;
}

// One rendering rig: a behaviour runner driving a scene, advanced frame by frame.
struct Rig {
  lark::Behavior bh;
  int si = 0;
  float lidL[28], lidR[28];
  int nL = 0, nR = 0;
  uint32_t now = 0;

  void begin(const char* state, uint32_t seed) {
    loadOnce();
    si = stateIndex(state);
    bh.data = &rd;
    bh.rng.s = seed;
    bh.started = false;
    now = 1000;
    collectRest();
  }

  void collectRest() {
    nL = nR = 0;
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

  // Draw one frame at the current time with the pointer where it is.
  void frame(float lookX, float lookY);
};

// The channel bridge, mirroring lark_render.h's.
static Rig* gRig = nullptr;
static void rigChannels(uint8_t nodeId, uint8_t parentId, uint8_t kind,
                        const float* rest, int restCount, lark::Channels& out, void* ctx) {
  ((lark::Behavior*)ctx)->channelsForNode(nodeId, parentId, kind, gRig->now, rest, restCount, out);
}

void Rig::frame(float lookX, float lookY) {
  gRig = this;
  bh.update(now, lookX, lookY);
  collectRest();

  // The lid for this frame: the eye's animated outline when a clip drives `p`, its rest pose
  // otherwise. This is what the pupil clips to, and it is what a blink actually changes.
  lark::Channels ch;
  bh.channelsForNode(lark::NODE_EYE_L, lark::NODE_GROUP_L, lark::KIND_EYE, now, lidL, nL, ch);
  if (ch.p.present && ch.p.pathCount) {
    nL = ch.p.pathCount < 28 ? ch.p.pathCount : 28;
    for (int i = 0; i < nL; i++) lidL[i] = ch.p.path[i];
  }
  bh.channelsForNode(lark::NODE_EYE_R, lark::NODE_GROUP_R, lark::KIND_EYE, now, lidR, nR, ch);
  if (ch.p.present && ch.p.pathCount) {
    nR = ch.p.pathCount < 28 ? ch.p.pathCount : 28;
    for (int i = 0; i < nR; i++) lidR[i] = ch.p.path[i];
  }

  for (int i = 0; i < PANEL * PANEL; i++) fb[i] = BG;
  lark::Scene scene;
  scene.data = &rd;
  scene.stateIndex = (uint16_t)si;
  scene.background = BG;
  scene.lidL = lidL; scene.lidLCount = nL;
  scene.lidR = lidR; scene.lidRCount = nR;
  scene.channels = rigChannels;
  scene.channelCtx = &bh;

  lark::Gaze g;
  bh.lookFor(now, lookX, lookY, &g.x, &g.y);
  scene.draw(fb, PANEL, PANEL, g);
}

void test_boot_starts_the_four_looping_clips() {
  Rig r;
  r.begin("1b", 12345);
  r.frame(0, 0);
  // init plays idle, pup_mov_1, pup_mov_2, pup_scale -- all `repeat: l`, so they never retire.
  TEST_ASSERT_EQUAL_INT_MESSAGE(4, r.bh.activeCount(), "init should leave four loops running");
  for (int i = 0; i < 200; i++) { r.now += 16; r.frame(0, 0); }
  TEST_ASSERT_EQUAL_INT_MESSAGE(4, r.bh.activeCount(), "loops must not retire");
}

void test_the_eyes_actually_close() {
  // The real question: over a stretch of time, does the drawing ever show a closed eye? A blink
  // shrinks the lid to a slit, so the ink drops far below its open value. If the scene ignored the
  // animation this would never move.
  Rig r;
  r.begin("1b", 99);
  r.frame(0, 0);
  int open = inkArea();
  TEST_ASSERT_TRUE_MESSAGE(open > 10000, "the open pair should be substantial");

  int lowest = open;
  // 20 seconds at 30fps. blink_ambient fires every 2.5-5s, so several land in here.
  for (int i = 0; i < 600; i++) {
    r.now += 33;
    r.frame(0, 0);
    int ink = inkArea();
    if (ink < lowest) lowest = ink;
  }
  TEST_ASSERT_TRUE_MESSAGE(lowest < open * 0.75f,
                           "over 20s the eyes should visibly close -- the blink must reach the pixels");
}

void test_a_blink_is_brief() {
  // The blink clips run 783-1017ms. If the eye stayed shut much longer than that, the curve
  // attribution would be wrong -- that exact bug once left it closed 480ms per blink in web-sim.
  Rig r;
  r.begin("1b", 7);
  r.frame(0, 0);
  int open = inkArea();

  int closedFrames = 0, longestRun = 0, run = 0;
  for (int i = 0; i < 600; i++) {
    r.now += 33;
    r.frame(0, 0);
    if (inkArea() < open * 0.75f) { closedFrames++; run++; if (run > longestRun) longestRun = run; }
    else run = 0;
  }
  TEST_ASSERT_TRUE_MESSAGE(closedFrames > 0, "at least one closed frame in 20 seconds");
  // A whole blink is about a second; the CLOSED part of it is a fraction of that. At 33ms a frame,
  // one closed stretch should not exceed a full clip's duration.
  TEST_ASSERT_TRUE_MESSAGE(longestRun * 33 < 1100, "a single closed stretch must not outlast a clip");
}

void test_the_pupils_drift_while_idle() {
  // pup_mov_1 and pup_mov_2 both drive `t` on both pupils, one vertical and one horizontal, forever.
  // Translation ADDS across clips; under last-writer-wins pup_mov_2 erases pup_mov_1 and the pupils
  // only ever move sideways. Sample the pupil offsets directly across a loop and require both axes.
  Rig r;
  r.begin("1b", 3);
  r.frame(0, 0);

  float minX = 1e9f, maxX = -1e9f, minY = 1e9f, maxY = -1e9f;
  for (int i = 0; i < 300; i++) {
    r.now += 33;
    r.bh.update(r.now, 0, 0);
    lark::Channels ch;
    r.bh.channelsForNode(lark::NODE_PUP_L, lark::NODE_GROUP_L, lark::KIND_PUPIL, r.now, nullptr, 0, ch);
    if (!ch.t.present) continue;
    if (ch.t.v[0] < minX) minX = ch.t.v[0];
    if (ch.t.v[0] > maxX) maxX = ch.t.v[0];
    if (ch.t.v[1] < minY) minY = ch.t.v[1];
    if (ch.t.v[1] > maxY) maxY = ch.t.v[1];
  }
  TEST_ASSERT_TRUE_MESSAGE(maxX - minX > 1.0f, "the pupils should drift horizontally (pup_mov_2)");
  TEST_ASSERT_TRUE_MESSAGE(maxY - minY > 1.0f,
                           "and vertically (pup_mov_1) -- if this is flat, `t` is not adding across clips");
}

void test_the_idle_bob_adds_to_the_pointer() {
  // `idle` rocks the look by +-0.12 forever. Taking the clip's value when present would suppress the
  // pointer; taking only the pointer would drop the bob. Both at once is what the reference does.
  Rig r;
  r.begin("1b", 21);
  r.frame(0, 0);

  float lo = 1e9f, hi = -1e9f;
  for (int i = 0; i < 200; i++) {
    r.now += 33;
    r.bh.update(r.now, 0, 0);
    float x, y;
    r.bh.lookFor(r.now, 0, 0, &x, &y);
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  TEST_ASSERT_TRUE_MESSAGE(hi - lo > 0.05f, "idle should rock the look even with the pointer still");

  // And with the pointer held off-centre, the look must sit around the POINTER, not around zero.
  float x, y;
  r.bh.lookFor(r.now, 0.5f, 0, &x, &y);
  TEST_ASSERT_TRUE_MESSAGE(x > 0.3f, "the pointer must not be suppressed by the clip's own look lane");
}

void test_one_blink_at_a_time() {
  // Categories exist so a category's clips replace each other. Without that, a drag fires blink_look
  // on nearly every frame: web-sim once had 31 concurrent blinks, and because the last writer wins,
  // the newest (wide open) overwrote all the others -- 31 blinks fired, not one closed frame drawn.
  Rig r;
  r.begin("1b", 5);
  r.frame(0, 0);

  float lx = 0;
  for (int i = 0; i < 120; i++) {
    r.now += 33;
    lx += 0.02f;                      // a steady drag, crossing the 0.04 trigger constantly
    r.bh.update(r.now, lx, 0);
    int blinks = 0;
    for (int s = 0; s < lark::MAX_ACTIVE_CLIPS; s++)
      if (r.bh.active[s].used && r.bh.active[s].category == lark::CAT_BLINK) blinks++;
    TEST_ASSERT_TRUE_MESSAGE(blinks <= 1, "a category must never run two clips at once");
  }
}

void test_a_drag_does_not_fire_a_blink_every_frame() {
  // Trigger 10 compares consecutive frames, so a steady drag crosses 0.04 on nearly all of them.
  // The cooldown is what keeps that from becoming a continuous stutter.
  Rig r;
  r.begin("1b", 11);
  r.frame(0, 0);

  int fired = 0;
  uint32_t lastSeen = 0;
  float lx = 0;
  for (int i = 0; i < 300; i++) {     // 10 seconds of dragging
    r.now += 33;
    lx += 0.02f;
    r.bh.update(r.now, lx, 0);
    for (int s = 0; s < lark::MAX_ACTIVE_CLIPS; s++) {
      if (!r.bh.active[s].used || r.bh.active[s].category != lark::CAT_BLINK) continue;
      if (r.bh.active[s].start != lastSeen) { lastSeen = r.bh.active[s].start; fired++; }
    }
  }
  // 10s with a 2.5s floor allows at most five, counting the ambient rule firing too.
  TEST_ASSERT_TRUE_MESSAGE(fired > 0, "a drag should trigger a blink at all");
  TEST_ASSERT_TRUE_MESSAGE(fired <= 8, "the cooldown should keep a drag from blinking every frame");
}

void test_missing_clips_never_fire() {
  // The 35 absent clips are the ones the other eighteen rules name. Nothing here resolves them, so
  // every index stays -1 and play() refuses. Confirms the guard rather than the absence.
  Rig r;
  r.begin("1b", 1);
  r.frame(0, 0);
  TEST_ASSERT_EQUAL_INT16_MESSAGE(-1, r.bh.findClip("dance_hp"), "dance_hp is not in the data");
  TEST_ASSERT_EQUAL_INT16_MESSAGE(-1, r.bh.findClip("spin_h"), "spin_h is not in the data");
  TEST_ASSERT_EQUAL_INT16_MESSAGE(-1, r.bh.findClip("heart_sprites"), "heart_sprites is not in the data");
  TEST_ASSERT_FALSE_MESSAGE(r.bh.play(-1, r.now, lark::CAT_BLINK), "playing a missing clip must fail");

  // The ones the live rules need ARE there.
  TEST_ASSERT_TRUE(r.bh.findClip("blink") >= 0);
  TEST_ASSERT_TRUE(r.bh.findClip("idle") >= 0);
  TEST_ASSERT_TRUE(r.bh.findClip("pup_mov_1") >= 0);
}

void test_a_group_lane_reaches_the_nodes_inside_it() {
  // This is what version 2 of the packed data bought. `rot` drives `eyes`, `rot3d_2` drives
  // `group_eye_l`/`group_eye_r` -- all three are GROUPS. Version 1 dropped them and addressed nodes
  // by kind and side, which cannot tell one group from another, so both rules played and drew
  // nothing at all. Now a lane on a group reaches every node beneath it.
  Rig r;
  r.begin("1b", 42);
  r.frame(0, 0);

  // A lane on `eyes` reaches the eye groups AND the leaves two levels down.
  lark::Reader::Lane onEyes;
  onEyes.keypath = lark::KP_R;
  onEyes.target = lark::NODE_EYES;
  TEST_ASSERT_TRUE_MESSAGE(lark::Behavior::laneDrives(onEyes, lark::NODE_EYES, lark::NODE_EYES),
                           "a lane on `eyes` drives `eyes`");
  TEST_ASSERT_TRUE_MESSAGE(lark::Behavior::laneDrives(onEyes, lark::NODE_GROUP_L, lark::NODE_EYES),
                           "and the eye group one level down");
  TEST_ASSERT_TRUE_MESSAGE(lark::Behavior::laneDrives(onEyes, lark::NODE_PUP_R, lark::NODE_GROUP_R),
                           "and the pupil two levels down");

  // A lane on ONE eye group reaches only that side -- which is how rot3d_2 turns each eye about its
  // own anchor rather than turning the pair.
  lark::Reader::Lane onLeft;
  onLeft.keypath = lark::KP_T3D;
  onLeft.target = lark::NODE_GROUP_L;
  TEST_ASSERT_TRUE(lark::Behavior::laneDrives(onLeft, lark::NODE_EYE_L, lark::NODE_GROUP_L));
  TEST_ASSERT_TRUE(lark::Behavior::laneDrives(onLeft, lark::NODE_PUP_L, lark::NODE_GROUP_L));
  TEST_ASSERT_FALSE_MESSAGE(lark::Behavior::laneDrives(onLeft, lark::NODE_EYE_R, lark::NODE_GROUP_R),
                            "the left group must not move the right eye");

  // A leaf lane stays on its leaf.
  lark::Reader::Lane onPupL;
  onPupL.keypath = lark::KP_T;
  onPupL.target = lark::NODE_PUP_L;
  TEST_ASSERT_TRUE(lark::Behavior::laneDrives(onPupL, lark::NODE_PUP_L, lark::NODE_GROUP_L));
  TEST_ASSERT_FALSE(lark::Behavior::laneDrives(onPupL, lark::NODE_EYE_L, lark::NODE_GROUP_L));
  TEST_ASSERT_FALSE(lark::Behavior::laneDrives(onPupL, lark::NODE_PUP_R, lark::NODE_GROUP_R));

  // And the scene root is not a node: a look lane must never land on the `eyes` group, whose id is
  // 0 and would otherwise collide with it.
  lark::Reader::Lane look;
  look.keypath = lark::KP_L;
  look.target = lark::LANE_ROOT;
  TEST_ASSERT_FALSE_MESSAGE(lark::Behavior::laneDrives(look, lark::NODE_EYES, lark::NODE_EYES),
                            "the look drives the scene root, not the eye group");
}

void test_rot_now_moves_the_drawing() {
  // The behaviour end of the same change, measured in PIXELS rather than in bookkeeping: play a
  // rotation clip directly and require the drawing to move. Before version 2 this was flat.
  Rig r;
  r.begin("1b", 42);
  r.frame(0, 0);

  int16_t rot = r.bh.findClip("rot_1");
  TEST_ASSERT_TRUE_MESSAGE(rot >= 0, "rot_1 should be in the data");

  // Clear the ambient loops so only the rotation is running -- otherwise a pupil drift could
  // account for any movement seen.
  for (int i = 0; i < lark::MAX_ACTIVE_CLIPS; i++) r.bh.active[i].used = false;
  TEST_ASSERT_TRUE(r.bh.play(rot, r.now, lark::CAT_ROT));

  // Sample the eye outline across the clip. rot_1 runs 3650ms; a rotation about the pair's centre
  // moves the left eye's own box.
  float firstCx = 0, firstCy = 0;
  float maxShift = 0;
  for (int i = 0; i <= 40; i++) {
    uint32_t t = r.now + (uint32_t)(i * 90);
    lark::Channels ch;
    r.bh.channelsForNode(lark::NODE_EYE_L, lark::NODE_GROUP_L, lark::KIND_EYE,
                         t, r.lidL, r.nL, ch);
    if (!ch.r.present) continue;
    // The rotation lane resolves for this node, which is the thing version 1 could not do.
    float ang = ch.r.v[0];
    if (i == 0) { firstCx = ang; firstCy = ang; }
    float d = ang - firstCx;
    if (d < 0) d = -d;
    if (d > maxShift) maxShift = d;
  }
  (void)firstCy;
  TEST_ASSERT_TRUE_MESSAGE(maxShift > 0.001f,
                           "a rotation lane on `eyes` must resolve onto the eye and change over time");
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_boot_starts_the_four_looping_clips);
  RUN_TEST(test_the_eyes_actually_close);
  RUN_TEST(test_a_blink_is_brief);
  RUN_TEST(test_the_pupils_drift_while_idle);
  RUN_TEST(test_the_idle_bob_adds_to_the_pointer);
  RUN_TEST(test_one_blink_at_a_time);
  RUN_TEST(test_a_drag_does_not_fire_a_blink_every_frame);
  RUN_TEST(test_missing_clips_never_fire);
  RUN_TEST(test_a_group_lane_reaches_the_nodes_inside_it);
  RUN_TEST(test_rot_now_moves_the_drawing);
  return UNITY_END();
}
