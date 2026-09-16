#pragma once
// What makes the eyes act on their own: which clip plays and when.
//
// Ported from web-sim/behavior.js, but NOT as a general rule interpreter. behavior_data.json holds
// 23 rules and this build can run at most five of them, because the other eighteen name 35 clips
// that exist in no file the site distributes (`dance_hp`, `spin_h`, `curious_3`, `heart_sprites`…)
// -- confirmed absent from the JSON, from the live site's own .bin, and from the published fork.
// Carrying a bytecode interpreter and 23 encoded rules to dispatch five of them would be more
// machinery than the thing it drives, so the live rules are written out as code here and the rest
// are documented as absent rather than encoded and skipped.
//
// The five, exactly as the data defines them:
//
//   init              at boot, loop `idle`, `pup_mov_1`, `pup_mov_2`, `pup_scale` forever
//   blink_ambient     every 2.5-5s, one of blink/blink2/blink3, then a 0.1 probability gate
//   blink_look        when the look moves > 0.04, same three clips, gate 0.2
//   rot               every 6-15s, one of rot_1..rot_4
//   rot3d             every 8-16s, rot3d_1 or rot3d_2
//
// The two blink rules are gated on sensor 15 >= 0.3. The web build feeds nothing, which is why the
// reference never blinks on its own; see LARK_SENSOR_15 below for what this build feeds and why
// that is a choice rather than a measurement.
//
// The probability gate sits AFTER the clip is picked and runs per firing, so blink_ambient's
// s = 0.1 does not mean "blink every 25 seconds" -- the clip has already started by then. It gates
// the actions that FOLLOW, which for these rules is nothing. Ported faithfully anyway: the gate is
// what the data says, and a later action added after it would depend on it.

#include <stdint.h>
#include "lark.h"
#include "lark_data.h"

namespace lark {

// Sensor 15 decides WHICH blinks play: >= 0.3 selects blink/blink2/blink3, below it selects
// blink4/blink5. On the original it is some physical reading -- battery or ambient light, the data
// does not say which -- and the web build feeds nothing at all, so all four blink rules stay inert
// there and the reference never blinks by itself.
//
// This build feeds a constant 1.0. That is a DECISION, not a measurement: it selects the healthy
// blink set, which is the one the site shows when anyone watches it. Wiring this to the real
// battery would be a guess about what sensor 15 means, and guessing wrong would make the eyes blink
// differently as the cell drains, with nothing to check it against.
static const float LARK_SENSOR_15 = 1.0f;

// Minimum gap between two firings of one category from a LOOK trigger. Trigger 10 compares
// consecutive frames, so a steady drag crosses 0.04 on nearly every one and the rule fires
// continuously -- measured in web-sim at 31 firings across a single slow drag against the
// reference's 11 closed frames out of 41. The data carries no cooldown, so this is blink_ambient's
// own minimum interval (2.5s), which is the tightest spacing the data itself ever asks for.
static const uint32_t LOOK_TRIGGER_COOLDOWN_MS = 2500;

// How many clips can run at once. `init` alone starts four loops, and a blink can land on top.
static const int MAX_ACTIVE_CLIPS = 8;

struct ClipInstance {
  uint16_t clipIndex = 0;
  uint32_t start = 0;
  uint8_t category = 0;        // 0 = none; instances in one category replace each other
  bool loops = false;
  uint16_t durationMs = 0;
  bool used = false;
};

// Categories, as small ids rather than strings: the data's own names are "init", "blink", "rot",
// "rot3d". A clip started in a category replaces whatever else that category is running -- that is
// what categories are FOR, and without it instances pile up. In web-sim a slow drag once left 31
// concurrent blinks, and because the last writer wins, the newest (still wide open) overwrote all
// the others every frame: 31 blinks fired and not one closed eye drawn.
enum : uint8_t { CAT_NONE = 0, CAT_INIT = 1, CAT_BLINK = 2, CAT_ROT = 3, CAT_ROT3D = 4 };

// A tiny deterministic PRNG. Not for security -- it picks blink variants and schedules intervals.
// Its own state so a test can pin a seed and get the same sequence every run.
struct Rng {
  uint32_t s = 0x2545F491;
  uint32_t next() {                       // xorshift32
    s ^= s << 13; s ^= s >> 17; s ^= s << 5;
    return s;
  }
  float unit() { return (float)(next() >> 8) / 16777216.0f; }   // [0,1)
  uint32_t range(uint32_t lo, uint32_t hi) { return hi <= lo ? lo : lo + (next() % (hi - lo)); }
};

struct Behavior {
  const Reader* data = nullptr;
  Rng rng;

  ClipInstance active[MAX_ACTIVE_CLIPS];
  bool started = false;

  // Next scheduled firing, per interval rule.
  uint32_t nextBlink = 0, nextRot = 0, nextRot3d = 0;
  uint32_t lastBlinkFromLook = 0;
  float lastLookX = 0, lastLookY = 0;

  // Clip indices, resolved once by name at start. -1 means the clip is missing from the data, and
  // every use is guarded: a rule whose clips are all missing simply never fires, which is what the
  // absent eighteen rules do.
  int16_t iIdle = -1, iPupMov1 = -1, iPupMov2 = -1, iPupScale = -1;
  int16_t iBlink[3] = { -1, -1, -1 };
  int16_t iRot[4] = { -1, -1, -1, -1 };
  int16_t iRot3d[2] = { -1, -1 };

  int16_t findClip(const char* want) const {
    if (!data) return -1;
    char name[16];
    for (uint16_t c = 0; c < data->clipCount(); c++) {
      if (!data->clipName(c, name, sizeof name)) continue;
      if (strcmp(name, want) == 0) return (int16_t)c;
    }
    return -1;
  }

  void resolveClips() {
    iIdle = findClip("idle");
    iPupMov1 = findClip("pup_mov_1");
    iPupMov2 = findClip("pup_mov_2");
    iPupScale = findClip("pup_scale");
    iBlink[0] = findClip("blink");
    iBlink[1] = findClip("blink2");
    iBlink[2] = findClip("blink3");
    iRot[0] = findClip("rot_1");
    iRot[1] = findClip("rot_2");
    iRot[2] = findClip("rot_3");
    iRot[3] = findClip("rot_4");
    iRot3d[0] = findClip("rot3d_1");
    iRot3d[1] = findClip("rot3d_2");
  }

  // Start a clip. A clip with a category evicts whatever else that category is running.
  bool play(int16_t clipIndex, uint32_t now, uint8_t category) {
    if (clipIndex < 0 || !data) return false;
    Reader::Clip c;
    if (!data->clip((uint16_t)clipIndex, c)) return false;

    if (category != CAT_NONE)
      for (int i = 0; i < MAX_ACTIVE_CLIPS; i++)
        if (active[i].used && active[i].category == category) active[i].used = false;

    for (int i = 0; i < MAX_ACTIVE_CLIPS; i++) {
      if (active[i].used) continue;
      active[i].used = true;
      active[i].clipIndex = (uint16_t)clipIndex;
      active[i].start = now;
      active[i].category = category;
      active[i].loops = c.repeatLoop != 0;
      active[i].durationMs = c.durationMs;
      return true;
    }
    return false;   // every slot busy: drop it rather than evict something mid-play
  }

  // Pick one of `n` options by equal weight, skipping the ones this build does not ship. Every
  // weighted pick in the five live rules uses w = 1 throughout, so equal weighting IS the data.
  int16_t pickOne(const int16_t* options, int n) {
    int16_t usable[8];
    int count = 0;
    for (int i = 0; i < n && count < 8; i++) if (options[i] >= 0) usable[count++] = options[i];
    if (!count) return -1;
    return usable[rng.next() % (uint32_t)count];
  }

  void scheduleBlink(uint32_t now) { nextBlink = now + rng.range(2500, 5000); }
  void scheduleRot(uint32_t now)   { nextRot   = now + rng.range(6000, 15000); }
  void scheduleRot3d(uint32_t now) { nextRot3d = now + rng.range(8000, 16000); }

  // Rule `init`, trigger 11 (once at boot): four looping clips, no category, so they are never
  // evicted and run for as long as the mode does.
  void start(uint32_t now) {
    started = true;
    for (int i = 0; i < MAX_ACTIVE_CLIPS; i++) active[i].used = false;
    resolveClips();
    play(iIdle, now, CAT_NONE);
    play(iPupMov1, now, CAT_NONE);
    play(iPupMov2, now, CAT_NONE);
    play(iPupScale, now, CAT_NONE);
    scheduleBlink(now);
    scheduleRot(now);
    scheduleRot3d(now);
    lastBlinkFromLook = 0;
  }

  bool blinkRulesHold() const { return LARK_SENSOR_15 >= 0.3f; }

  // Call once per frame with the current look vector.
  void update(uint32_t now, float lookX, float lookY) {
    if (!started) start(now);

    // Retire finished instances. Loops never end.
    for (int i = 0; i < MAX_ACTIVE_CLIPS; i++) {
      if (!active[i].used || active[i].loops) continue;
      if (now - active[i].start >= active[i].durationMs) active[i].used = false;
    }

    // Trigger 10: the look moved more than 0.04 -- rule blink_look, gate 0.2.
    if (blinkRulesHold()) {
      float dx = lookX - lastLookX, dy = lookY - lastLookY;
      if (sqrtf(dx * dx + dy * dy) > 0.04f) {
        bool cool = lastBlinkFromLook && (now - lastBlinkFromLook) < LOOK_TRIGGER_COOLDOWN_MS;
        if (!cool) {
          int16_t pick = pickOne(iBlink, 3);
          if (pick >= 0 && play(pick, now, CAT_BLINK)) {
            lastBlinkFromLook = now;
            scheduleBlink(now);          // an ambient blink right after a look blink reads as a stutter
          }
          if (rng.unit() > 0.2f) { /* gate 6 fails: stops the actions after it, of which there are none */ }
        }
      }
    }
    lastLookX = lookX;
    lastLookY = lookY;

    // Trigger 1: random intervals. blink_ambient 2.5-5s, rot 6-15s, rot3d 8-16s.
    if (blinkRulesHold() && now >= nextBlink) {
      scheduleBlink(now);
      int16_t pick = pickOne(iBlink, 3);
      if (pick >= 0) play(pick, now, CAT_BLINK);
      if (rng.unit() > 0.1f) { /* gate 6, as above */ }
    }
    // rot and rot3d are scheduled and started faithfully, but they currently DRAW NOTHING, and that
    // is a data limitation rather than an oversight here. Their lanes target `eyes`, `group_eye_l`
    // and `group_eye_r` -- groups -- while tools/lark_pack.py drops node names and leaves nodes
    // identified by kind and side. Kind+side resolves `eye_l/r` and `pup_l/r` exactly, which covers
    // idle, both pupil drifts, pup_scale and all three blinks; it cannot tell one group from
    // another. Making these two rules visible means teaching the packer to keep group identity and
    // the scene to apply `r`/`t3d` at the group level. They are left running so the timing and the
    // category eviction stay honest, and so that change is the only one needed.
    if (now >= nextRot) {
      scheduleRot(now);
      int16_t pick = pickOne(iRot, 4);
      if (pick >= 0) play(pick, now, CAT_ROT);
    }
    if (now >= nextRot3d) {
      scheduleRot3d(now);
      int16_t pick = pickOne(iRot3d, 2);
      if (pick >= 0) play(pick, now, CAT_ROT3D);
    }
  }

  int activeCount() const {
    int n = 0;
    for (int i = 0; i < MAX_ACTIVE_CLIPS; i++) if (active[i].used) n++;
    return n;
  }

  // Which lane object a node answers to. The packed data drops node NAMES -- it keeps kind and
  // geometry -- so a lane's object string is matched against what the node is and which side of the
  // pair it sits on, which for this data is exact: across every clip these five rules play, the
  // only named objects are `eye_l`, `eye_r`, `pup_l`, `pup_r` and the root "".
  //
  // The exception is deliberate and visible in `rot`/`rot3d`: those drive `eyes`, `group_eye_l` and
  // `group_eye_r`, which are GROUPS, and a group is not distinguishable from another group by kind
  // and side alone. Those two rules therefore play no lanes here. Fixing it means teaching the
  // packer to keep group identity -- see the note in update().
  static bool laneMatches(const char* object, uint8_t kind, float sideSign) {
    if (object[0] == '\0') return false;          // the root is resolved by lookFor, not per node
    bool wantRight = false;
    int len = 0;
    while (object[len]) len++;
    if (len >= 2 && object[len - 2] == '_') wantRight = (object[len - 1] == 'r');
    else return false;                             // no side suffix: a group, which we cannot place
    if ((sideSign > 0) != wantRight) return false;
    if (object[0] == 'e' && object[1] == 'y' && object[2] == 'e') return kind == KIND_EYE;
    if (object[0] == 'p' && object[1] == 'u' && object[2] == 'p') return kind == KIND_PUPIL;
    return false;
  }

  // Collect every lane value that applies to one node, across all running clips.
  //
  // TRANSLATION ADDS; everything else takes the last writer. pup_mov_1 nudges the pupils 5px down
  // and pup_mov_2 slides them +-3px sideways, both on `t`, on the same two nodes, both looping.
  // Under last-writer-wins pup_mov_2 erases pup_mov_1 outright and the pupils only ever drift
  // horizontally -- measured in web-sim as a near-constant 4px against the reference's 5-10px
  // vertical wander. `p` and `s` are absolute shapes rather than offsets, so summing them would add
  // two outlines together.
  //
  // The pupils' `o` lane is SKIPPED. It is not literal alpha: honouring it leaves an open eye with
  // no pupil in it, and 900 frames of the reference never show a lid over 90% open with the pupil
  // under half size. The lid clip alone removes the pupil at each closed frame.
  void channelsForNode(uint8_t kind, float sideSign, uint32_t now,
                       const float* rest, int restCount, Channels& out) const {
    out.clear();
    if (!data) return;

    for (int i = 0; i < MAX_ACTIVE_CLIPS; i++) {
      if (!active[i].used) continue;
      Reader::Clip c;
      if (!data->clip(active[i].clipIndex, c)) continue;

      uint32_t t = now - active[i].start;
      if (active[i].loops && c.durationMs) t %= c.durationMs;

      for (uint8_t li = 0; li < c.laneCount; li++) {
        Reader::Lane lane;
        if (!c.lane(li, lane)) continue;
        if (!laneMatches(lane.object, kind, sideSign)) continue;
        if (lane.keypath == KP_O && kind == KIND_PUPIL) continue;

        Channel* ch = out.byKeypath(lane.keypath);
        if (!ch) continue;

        if (lane.keypath == KP_T && ch->present) {
          Channel add;
          sampleLane(lane, t, rest, restCount, add);
          if (add.present) for (int j = 0; j < 3; j++) ch->v[j] += add.v[j];
        } else {
          sampleLane(lane, t, rest, restCount, *ch);
        }
      }
    }
  }

  // The root's own lanes (object ""), which is where every clip drives the look.
  void rootChannels(uint32_t now, Channels& out) const {
    out.clear();
    if (!data) return;
    for (int i = 0; i < MAX_ACTIVE_CLIPS; i++) {
      if (!active[i].used) continue;
      Reader::Clip c;
      if (!data->clip(active[i].clipIndex, c)) continue;
      uint32_t t = now - active[i].start;
      if (active[i].loops && c.durationMs) t %= c.durationMs;
      for (uint8_t li = 0; li < c.laneCount; li++) {
        Reader::Lane lane;
        if (!c.lane(li, lane)) continue;
        if (lane.object[0] != '\0') continue;
        Channel* ch = out.byKeypath(lane.keypath);
        if (!ch) continue;
        sampleLane(lane, t, nullptr, 0, *ch);
      }
    }
  }

  // The look reaching the nodes: the clip's ambient bob PLUS the pointer, capped at LOOK_CAP.
  //
  // They ADD rather than replace. `idle` rocks `l` by +-0.12 forever, so taking the clip's value
  // when present leaves the pointer permanently suppressed and the gaze dead, while taking only the
  // pointer drops the ambient bob. The reference does both at once.
  void lookFor(uint32_t now, float pointerX, float pointerY, float* outX, float* outY) const {
    Channels root;
    rootChannels(now, root);
    float x = pointerX + (root.l.present ? root.l.v[0] : 0.0f);
    float y = pointerY + (root.l.present ? root.l.v[1] : 0.0f);
    *outX = x < -LOOK_CAP ? -LOOK_CAP : (x > LOOK_CAP ? LOOK_CAP : x);
    *outY = y < -LOOK_CAP ? -LOOK_CAP : (y > LOOK_CAP ? LOOK_CAP : y);
  }
};

}  // namespace lark
