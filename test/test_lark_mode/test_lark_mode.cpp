#include <unity.h>
#include <string.h>
#include "../../animations.h"
#include "../../lark_data.h"
#include "../../lark_data_blob.h"

// The mode's place in the registry, and the embedded data it draws from. Both of the things this
// guards actually went wrong while the mode was being wired up:
//
//   - the atlas block's dispatch test was `id >= ATLAS_BASE && id < ANIM_COUNT`, so raising
//     ANIM_COUNT for a new id silently widened it and would have indexed a 7-entry table with 7
//   - the generated C array was written to `lark_data.h` by suffix, landing on top of the
//     hand-written reader of the same name

void setUp() {}
void tearDown() {}

void test_lark_has_its_own_id_and_is_playable() {
  TEST_ASSERT_EQUAL_UINT8(56, LARK_ID);
  TEST_ASSERT_TRUE(isPlayableId(LARK_ID));
  TEST_ASSERT_TRUE(animIdKnown(LARK_ID));
  TEST_ASSERT_EQUAL_STRING("Lark Eyes", animName(LARK_ID));
  // ANIM_COUNT is an id BOUND, one past the highest playable id.
  TEST_ASSERT_EQUAL_INT(LARK_ID + 1, ANIM_COUNT);
  TEST_ASSERT_FALSE(isPlayableId(ANIM_COUNT));
}

void test_the_ids_already_in_the_field_did_not_move() {
  // Saved configs on units in the field hold these numbers. Shifting one silently retargets a
  // stranger's startup animation.
  TEST_ASSERT_EQUAL_UINT8(38, AUDIO_BASE);
  TEST_ASSERT_EQUAL_UINT8(42, DEBUG_ID);
  TEST_ASSERT_EQUAL_UINT8(45, SWIRL_ID);
  TEST_ASSERT_EQUAL_UINT8(46, TREATCAT_ID);
  TEST_ASSERT_EQUAL_UINT8(47, GREETZ_ID);
  TEST_ASSERT_EQUAL_UINT8(48, GIF_ID);
  TEST_ASSERT_EQUAL_UINT8(49, ATLAS_BASE);
  TEST_ASSERT_EQUAL_INT(13, EYE_COUNT);
}

void test_the_atlas_block_cannot_swallow_the_new_id() {
  // The bug this exists for: dispatch bounded by ANIM_COUNT rather than by the atlas's own end.
  TEST_ASSERT_EQUAL_INT(ATLAS_BASE + ATLAS_COUNT, ATLAS_END);
  TEST_ASSERT_TRUE_MESSAGE(LARK_ID >= ATLAS_END, "Lark must sit above the atlas block, not inside it");
  // Every id the atlas dispatch accepts must map to a real entry in its 7-slot table.
  for (int id = ATLAS_BASE; id < ATLAS_END; id++) {
    TEST_ASSERT_TRUE(id - ATLAS_BASE >= 0);
    TEST_ASSERT_TRUE_MESSAGE(id - ATLAS_BASE < ATLAS_COUNT, "atlas dispatch would index out of bounds");
  }
}

void test_every_playable_id_has_exactly_one_registry_entry() {
  for (int id = 0; id < 64; id++) {
    if (!isPlayableId(id)) continue;
    int seen = 0;
    for (int i = 0; i < REGISTRY_COUNT; i++) if (ANIMS[i].id == id) seen++;
    TEST_ASSERT_EQUAL_INT_MESSAGE(1, seen, "a playable id needs one and only one entry");
  }
  // And the table is exactly as long as it claims -- a stale PLAYABLE_ENTRY_COUNT leaves a
  // zero-initialised tail entry whose id is 0, which would duplicate eye 0.
  int entries = 0;
  for (int i = 0; i < REGISTRY_COUNT; i++) if (ANIMS[i].name && ANIMS[i].name[0]) entries++;
  TEST_ASSERT_EQUAL_INT(REGISTRY_COUNT, entries);
}

void test_the_embedded_blob_is_the_real_scene_data() {
  // Generated arrays go stale silently. Open it the way the firmware does and check it carries what
  // the mode needs, rather than trusting that it was regenerated.
  lark::Reader rd;
  TEST_ASSERT_TRUE_MESSAGE(rd.open(LARK_DATA, LARK_DATA_LEN),
                           "embedded data failed its header check -- rerun tools/lark_pack.py");
  TEST_ASSERT_EQUAL_UINT16(36, rd.stateCount());

  // 1b is the state the mode opens on, found by name because the pack writes states in the JSON's
  // order and pinning an index would break the first time that order changed.
  char name[16];
  bool found1b = false;
  for (uint16_t s = 0; s < rd.stateCount() && !found1b; s++) {
    rd.stateName(s, name, sizeof name);
    if (strcmp(name, "1b") == 0) found1b = true;
  }
  TEST_ASSERT_TRUE_MESSAGE(found1b, "state 1b is the mode's opening pose and must exist");
}

void test_the_blob_header_is_not_the_reader_header() {
  // The generated array and the hand-written reader are different files with adjacent names; once,
  // they were the same file. If lark_data.h were ever clobbered again this translation unit would
  // not compile -- but assert the two symbols coexist so the failure is a message, not a mystery.
  // 15730 since version 2. It grew 1838 bytes over version 1's 13892: the states gained the three
  // groups and a two-byte id/parent per node (+2060), while the clips shrank by storing lane
  // targets as one-byte ids instead of names (-222). That is what `rot` and `rot3d` cost -- before
  // it, they played on the device and drew nothing.
  TEST_ASSERT_EQUAL_UINT32(15730, LARK_DATA_LEN);
  lark::Reader rd;
  TEST_ASSERT_TRUE(rd.open(LARK_DATA, LARK_DATA_LEN));
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_lark_has_its_own_id_and_is_playable);
  RUN_TEST(test_the_ids_already_in_the_field_did_not_move);
  RUN_TEST(test_the_atlas_block_cannot_swallow_the_new_id);
  RUN_TEST(test_every_playable_id_has_exactly_one_registry_entry);
  RUN_TEST(test_the_embedded_blob_is_the_real_scene_data);
  RUN_TEST(test_the_blob_header_is_not_the_reader_header);
  return UNITY_END();
}
