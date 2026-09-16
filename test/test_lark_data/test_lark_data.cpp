#include <unity.h>
#include <ArduinoJson.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../lark_data.h"

// Round-trip: read lark_data.bin back and hold every field the runtime consumes against the JSON it
// came from. A packer that silently drops or rounds something would otherwise show up much later as
// an eye that is subtly the wrong shape, and by then the cause is three layers away.
//
// Both files are read from disk rather than embedded, so this test fails loudly if the .bin is stale
// — regenerate with `python tools/lark_pack.py`.

static uint8_t* blob = nullptr;
static uint32_t blobLen = 0;
static JsonDocument doc;
static lark::Reader rd;

static uint8_t* slurp(const char* path, uint32_t* len) {
  FILE* f = fopen(path, "rb");
  if (!f) return nullptr;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  uint8_t* buf = (uint8_t*)malloc(n + 1);
  size_t got = fread(buf, 1, n, f);
  fclose(f);
  buf[got] = 0;
  *len = (uint32_t)got;
  return buf;
}

// The test runs from the project root under `pio test`; fall back to a parent-relative path so it
// also works if the working directory is the test folder.
static uint8_t* findFile(const char* rel, const char* rel2, uint32_t* len) {
  uint8_t* b = slurp(rel, len);
  return b ? b : slurp(rel2, len);
}

void setUp() {}
void tearDown() {}

static bool loaded = false;
static void loadOnce() {
  if (loaded) return;
  loaded = true;
  blob = findFile("lark_data.bin", "../../lark_data.bin", &blobLen);
  uint32_t jlen = 0;
  uint8_t* json = findFile("../lilguy-fork/public/anim_data.json",
                           "../../../lilguy-fork/public/anim_data.json", &jlen);
  if (json) {
    deserializeJson(doc, (const char*)json);
    free(json);
  }
  if (blob) rd.open(blob, blobLen);
}

void test_the_blob_opens() {
  loadOnce();
  TEST_ASSERT_NOT_NULL_MESSAGE(blob, "lark_data.bin missing — run python tools/lark_pack.py");
  TEST_ASSERT_TRUE_MESSAGE(rd.base != nullptr, "bad magic or version");
  TEST_ASSERT_FALSE_MESSAGE(doc.isNull(), "anim_data.json not found");
}

void test_counts_match_the_json() {
  loadOnce();
  JsonObject states = doc["states"];
  JsonObject clips = doc["animations"];
  TEST_ASSERT_EQUAL_UINT16(states.size(), rd.stateCount());
  TEST_ASSERT_EQUAL_UINT16(clips.size(), rd.clipCount());
}

// The packer sorts by id, so index order is alphabetical: 1a, 1b, 1c...
static const char* stateIdAt(uint16_t index) {
  static char name[16];
  return rd.stateName(index, name, sizeof name) ? name : "";
}

void test_every_state_path_survives_the_round_trip() {
  loadOnce();
  int checkedNodes = 0, checkedNumbers = 0;
  for (uint16_t s = 0; s < rd.stateCount(); s++) {
    const char* sid = stateIdAt(s);
    JsonObject objs = doc["states"][sid]["objs"];
    TEST_ASSERT_FALSE_MESSAGE(objs.isNull(), sid);

    // Collect the JSON's drawable nodes in the same z order the packer used.
    struct Ent { const char* name; int z; };
    Ent ents[16];
    int n = 0;
    for (JsonPair kv : objs) {
      JsonObject o = kv.value().as<JsonObject>();
      if (strcmp(o["type"] | "", "group") == 0) continue;
      ents[n].name = kv.key().c_str();
      ents[n].z = o["z"] | 0;
      n++;
    }
    for (int i = 1; i < n; i++) {                      // insertion sort by z
      Ent e = ents[i];
      int j = i - 1;
      while (j >= 0 && ents[j].z > e.z) { ents[j + 1] = ents[j]; j--; }
      ents[j + 1] = e;
    }

    lark::Reader::StateIter it = rd.state(s);
    lark::Reader::Node node;
    int k = 0;
    while (it.next(node)) {
      TEST_ASSERT_LESS_THAN_INT_MESSAGE(n, k, sid);
      JsonArray p = objs[ents[k].name]["p"];
      TEST_ASSERT_EQUAL_UINT16_MESSAGE(p.size(), node.pathCount, ents[k].name);
      for (uint16_t i = 0; i < node.pathCount; i++) {
        float want = p[i].as<float>();
        TEST_ASSERT_FLOAT_WITHIN_MESSAGE(0.051f, want, node.coord(i), ents[k].name);
        checkedNumbers++;
      }
      checkedNodes++;
      k++;
    }
    TEST_ASSERT_EQUAL_INT_MESSAGE(n, k, sid);
  }
  // Exact totals, so a silently truncated section fails here rather than passing a loose bound:
  // 36 states hold 166 drawable nodes between them — 30 states of 7, one of 9, five of 11, minus
  // the three groups each — carrying 3984 path numbers.
  TEST_ASSERT_EQUAL_INT(166, checkedNodes);
  TEST_ASSERT_EQUAL_INT(3984, checkedNumbers);
}

void test_colours_and_lid_flag_survive() {
  loadOnce();
  // 1b's eye is 6FF5D0 and its pupil 106E54; in RGB565 that is 0x6FBA and 0x136A.
  // Every node carries `ul: true` in this data, so the lid flag must be set on all of them.
  for (uint16_t s = 0; s < rd.stateCount(); s++) {
    if (strcmp(stateIdAt(s), "1b") != 0) continue;
    lark::Reader::StateIter it = rd.state(s);
    lark::Reader::Node node;
    bool sawEye = false, sawPupil = false;
    while (it.next(node)) {
      TEST_ASSERT_TRUE(node.flags & lark::FLAG_USE_LID);
      if (node.kind == lark::KIND_EYE) { sawEye = true; TEST_ASSERT_EQUAL_UINT16(0x6FBA, node.colour); }
      if (node.kind == lark::KIND_PUPIL) { sawPupil = true; TEST_ASSERT_EQUAL_UINT16(0x136A, node.colour); }
    }
    TEST_ASSERT_TRUE(sawEye);
    TEST_ASSERT_TRUE(sawPupil);
    return;
  }
  TEST_FAIL_MESSAGE("state 1b not found");
}

void test_clip_durations_and_lanes_match() {
  loadOnce();
  char name[16];
  for (uint16_t c = 0; c < rd.clipCount(); c++) {
    TEST_ASSERT_TRUE(rd.clipName(c, name, sizeof name));
    JsonObject j = doc["animations"][name];
    TEST_ASSERT_FALSE_MESSAGE(j.isNull(), name);
    lark::Reader::Clip clip;
    TEST_ASSERT_TRUE(rd.clip(c, clip));
    TEST_ASSERT_EQUAL_UINT16_MESSAGE(j["durationMs"].as<uint16_t>(), clip.durationMs, name);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(strcmp(j["repeat"] | "", "l") == 0 ? 1 : 0, clip.repeatLoop, name);
    TEST_ASSERT_EQUAL_UINT8_MESSAGE(j["lanes"].size() / 2, clip.laneCount, name);
  }
}

void test_blink_opacity_lane_keyframes_survive() {
  loadOnce();
  // `blink`'s pupil opacity lane is the one the runtime reads most carefully:
  // (150, c0, v1) -> (233, c0, v0) -> (300, c24, v1). Curve ids and times must be exact.
  char name[16];
  for (uint16_t c = 0; c < rd.clipCount(); c++) {
    rd.clipName(c, name, sizeof name);
    if (strcmp(name, "blink") != 0) continue;
    lark::Reader::Clip clip;
    TEST_ASSERT_TRUE(rd.clip(c, clip));
    bool found = false;
    for (uint8_t l = 0; l < clip.laneCount; l++) {
      lark::Reader::Lane lane;
      TEST_ASSERT_TRUE(clip.lane(l, lane));
      if (lane.keypath != lark::KP_O || strcmp(lane.object, "pup_l") != 0) continue;
      found = true;
      TEST_ASSERT_EQUAL_UINT8(3, lane.keyCount);
      const uint16_t ts[] = {150, 233, 300};
      const uint8_t cs[] = {0, 0, 24};
      const float vs[] = {1.0f, 0.0f, 1.0f};
      for (uint8_t i = 0; i < 3; i++) {
        lark::Reader::Key k;
        TEST_ASSERT_TRUE(lane.key(i, k));
        TEST_ASSERT_EQUAL_UINT16(ts[i], k.t);
        TEST_ASSERT_EQUAL_UINT8(cs[i], k.curve);
        TEST_ASSERT_FALSE(k.useRest);
        TEST_ASSERT_FLOAT_WITHIN(0.002f, vs[i], k.asFloat());
      }
    }
    TEST_ASSERT_TRUE_MESSAGE(found, "blink has no opacity lane on pup_l");
    return;
  }
  TEST_FAIL_MESSAGE("clip `blink` not found");
}

void test_blink_replacement_path_survives() {
  loadOnce();
  // The 28-number closed-lid outline. Its exact numbers are what the ribbon measurements depend on.
  char name[16];
  for (uint16_t c = 0; c < rd.clipCount(); c++) {
    rd.clipName(c, name, sizeof name);
    if (strcmp(name, "blink") != 0) continue;
    lark::Reader::Clip clip;
    rd.clip(c, clip);
    for (uint8_t l = 0; l < clip.laneCount; l++) {
      lark::Reader::Lane lane;
      clip.lane(l, lane);
      if (lane.keypath != lark::KP_P || strcmp(lane.object, "eye_l") != 0) continue;
      JsonArray keys = doc["animations"]["blink"]["lanes"];
      // find the same lane in the JSON
      for (size_t i = 0; i < keys.size(); i += 2) {
        JsonObject head = keys[i];
        if (strcmp(head["keypath"] | "", "p") != 0) continue;
        if (strcmp(head["object"] | "", "eye_l") != 0) continue;
        JsonArray jk = keys[i + 1];
        for (uint8_t x = 0; x < lane.keyCount; x++) {
          lark::Reader::Key k;
          lane.key(x, k);
          JsonArray v = jk[x]["v"];
          if (v.isNull()) { TEST_ASSERT_TRUE(k.useRest); continue; }
          TEST_ASSERT_EQUAL_UINT16(v.size(), k.pathCount());
          for (uint16_t n = 0; n < k.pathCount(); n++)
            TEST_ASSERT_FLOAT_WITHIN(0.051f, v[n].as<float>(), k.coord(n));
        }
        return;
      }
    }
  }
  TEST_FAIL_MESSAGE("blink's eye_l path lane not found");
}

void test_rejects_a_corrupt_blob() {
  loadOnce();
  lark::Reader bad;
  uint8_t junk[64];
  memset(junk, 0xAB, sizeof junk);
  TEST_ASSERT_FALSE(bad.open(junk, sizeof junk));
  TEST_ASSERT_FALSE(bad.open(nullptr, 0));
  TEST_ASSERT_FALSE(bad.open(blob, 8));            // truncated
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_the_blob_opens);
  RUN_TEST(test_counts_match_the_json);
  RUN_TEST(test_every_state_path_survives_the_round_trip);
  RUN_TEST(test_colours_and_lid_flag_survive);
  RUN_TEST(test_clip_durations_and_lanes_match);
  RUN_TEST(test_blink_opacity_lane_keyframes_survive);
  RUN_TEST(test_blink_replacement_path_survives);
  RUN_TEST(test_rejects_a_corrupt_blob);
  return UNITY_END();
}
